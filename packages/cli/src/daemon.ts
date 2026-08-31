/**
 * Demon de collecte — Volume II chapitre 8, Volume VII chapitre 6.
 *
 * C'est lui qui transforme un outil en service : il tient l'horloge, respecte
 * les fenetres d'exclusion, verifie l'integrite en tache de fond, crie quand
 * une source se tait, et s'arrete proprement quand on le lui demande.
 *
 * Il detient le verrou exclusif du magasin pendant toute sa vie : c'est ce qui
 * garantit qu'aucune commande manuelle ne viendra doubler la charge negociee
 * avec la source.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  Scheduler,
  defaultIsAlive,
  describeUnknown,
  isInBlackout,
  nextRunAfter,
  parseCron,
  toIsoTimestamp,
  validateCron,
  validateWindows,
  type ScheduledSource,
} from "@lcf/kernel";

import { LcfApp } from "./app.js";
import { isPlaceholderContact } from "./config.js";

export const HEARTBEAT_FILENAME = "daemon.json";

export interface Heartbeat {
  readonly pid: number;
  readonly startedAt: string;
  readonly lastTickAt: string;
  readonly sources: number;
  readonly rssMb: number;
}

export interface DaemonOptions {
  readonly configPath: string;
  /** Un seul tour, puis sortie. Sert aux tests et a la mise au point. */
  readonly once?: boolean;
  readonly out?: (line: string) => void;
}

export interface DaemonResult {
  readonly exitCode: number;
}

/**
 * Verifications prealables. Un demon qui demarre mal doit refuser de demarrer,
 * pas decouvrir le probleme a trois heures du matin.
 */
export function preflight(app: LcfApp): string[] {
  const problems: string[] = [];

  if (isPlaceholderContact(app.config.contact)) {
    problems.push(
      `contact invalide (${app.config.contact}) : renseignez une adresse reellement relevee, ` +
        "elle part dans le User-Agent de chaque requete",
    );
  }
  problems.push(...validateWindows(app.config.blackoutWindows ?? []));

  const enabled = app.config.sources.filter((entry) => entry.enabled !== false);
  if (enabled.length === 0) problems.push("aucune source active dans la configuration");

  for (const entry of enabled) {
    const cron = entry.cron ?? app.config.defaultCron;
    if (cron === undefined) continue;

    const problem = validateCron(cron);
    if (problem !== null) {
      problems.push(`${entry.sourceId} : ${problem}`);
      continue;
    }

    // Le cron est evalue en heure LOCALE du serveur, les fenetres d'exclusion
    // dans leur propre fuseau. Une source dont toutes les echeances tombent
    // dans une fenetre ne collecterait jamais — et le silence ne se remarque
    // qu'au bout de plusieurs jours. Autant le dire au demarrage.
    const windows = app.config.blackoutWindows ?? [];
    if (windows.length === 0) continue;

    const parsed = parseCron(cron);
    let from = app.clock.now();
    let bloquees = 0;
    for (let index = 0; index < 5; index++) {
      const next = nextRunAfter(parsed, from);
      if (next === null) break;
      if (isInBlackout(windows, next)) bloquees++;
      from = next;
    }
    if (bloquees === 5) {
      problems.push(
        `${entry.sourceId} : la cadence "${cron}" tombe systematiquement dans une ` +
          "fenetre d'exclusion — cette source ne collecterait jamais. " +
          `Heure locale du serveur : ${app.clock.now().toString()}. ` +
          "Reglez le serveur en UTC, ou decalez le cron.",
      );
    }
  }
  return problems;
}

export async function runDaemon(options: DaemonOptions): Promise<DaemonResult> {
  const out = options.out ?? console.log;
  const app = await LcfApp.open({
    configPath: options.configPath,
    exclusive: "daemon",
    persistLogs: true,
  });

  try {
    await app.migrate();

    const problems = preflight(app);
    if (problems.length > 0) {
      out("Le demon refuse de demarrer :");
      for (const problem of problems) out(`  - ${problem}`);
      return { exitCode: 2 };
    }

    const scheduler = new Scheduler({
      runner: app.runner,
      repository: app.repository,
      scanner: app.scanner,
      clock: app.clock,
      logger: app.logger,
      ...(app.config.blackoutWindows === undefined
        ? {}
        : { blackout: app.config.blackoutWindows }),
      ...(app.config.silentAfterHours === undefined
        ? {}
        : { silentAfterMs: app.config.silentAfterHours * 3_600_000 }),
    });

    // Le chargement est paresseux : un plugin n'est instancie qu'a l'echeance,
    // et une source cassee n'empeche pas les autres de tourner.
    for (const entry of app.config.sources.filter((source) => source.enabled !== false)) {
      const discovered = (await app.discoverPlugins()).find(
        (candidate) => candidate.manifest.id === entry.pluginId,
      );
      const cron =
        entry.cron ?? app.config.defaultCron ?? discovered?.manifest.schedule?.defaultCron ?? "0 2 * * *";

      const source: ScheduledSource = {
        sourceId: app.asSourceId(entry.sourceId),
        cron,
        load: () => app.loadSource(entry.sourceId),
      };
      scheduler.register(source);
      out(`  ${entry.sourceId.padEnd(24)} ${cron}`);
    }

    const startedAt = toIsoTimestamp(app.clock.now());
    const heartbeatPath = path.join(app.config.dataDir, HEARTBEAT_FILENAME);
    const writeHeartbeat = async (): Promise<void> => {
      const beat: Heartbeat = {
        pid: process.pid,
        startedAt,
        lastTickAt: toIsoTimestamp(app.clock.now()),
        sources: scheduler.sources.length,
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
      };
      await fsp.writeFile(heartbeatPath, JSON.stringify(beat, null, 2), "utf8").catch(() => undefined);
    };

    app.logger.info("demon demarre", {
      pid: process.pid,
      sources: scheduler.sources.length,
      blackout: (app.config.blackoutWindows ?? []).length,
      enFenetreDExclusion: isInBlackout(app.config.blackoutWindows ?? [], app.clock.now()),
    });

    if (options.once === true) {
      await scheduler.tick();
      // Pas de battement laisse derriere soi : un seul tour n'est pas un
      // service, et un battement orphelin ferait croire a un demon vivant.
      await fsp.rm(heartbeatPath, { force: true }).catch(() => undefined);
      return { exitCode: 0 };
    }

    // Arret propre : la collecte en cours va a son terme, puis on sort. Tuer
    // un telechargement en vol laisserait un fichier de transit orphelin — ce
    // n'est pas grave, mais c'est evitable.
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) {
        out("Arret force.");
        process.exit(130);
      }
      stopping = true;
      out(`Signal ${signal} : arret apres le tour en cours...`);
      app.logger.info("arret demande", { signal });
      scheduler.stop();
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));

    const heartbeat = setInterval(() => void writeHeartbeat(), 60_000);
    try {
      await writeHeartbeat();
      await scheduler.start();
    } finally {
      clearInterval(heartbeat);
      await fsp.rm(heartbeatPath, { force: true }).catch(() => undefined);
    }

    return { exitCode: 0 };
  } catch (error) {
    out(`echec du demon : ${describeUnknown(error)}`);
    return { exitCode: 1 };
  } finally {
    await app.close();
  }
}

/**
 * Battement de cœur courant, ou `null` si aucun demon ne tourne.
 *
 * Le fichier ne suffit pas : un demon tue en laisse un derriere lui. Seule la
 * vitalite du processus fait foi — un tableau de bord qui affiche « actif »
 * pour un service mort est pire qu'un tableau de bord vide.
 */
export async function readHeartbeat(
  dataDir: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Promise<Heartbeat | null> {
  try {
    const beat = JSON.parse(
      await fsp.readFile(path.join(dataDir, HEARTBEAT_FILENAME), "utf8"),
    ) as Heartbeat;
    return isAlive(beat.pid) ? beat : null;
  } catch {
    return null;
  }
}
