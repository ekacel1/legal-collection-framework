/**
 * Commandes de la CLI — Volume III, chapitre 11.1.
 *
 * Aucune logique metier ici : la CLI est un adaptateur. Toute capacite offerte
 * par la ligne de commande l'est identiquement par le SDK, parce que les deux
 * appellent les memes cas d'usage.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  describeUnknown,
  ProcessLock,
  reindexFromStore,
  type RunMode,
  type RunOptions,
} from "@lcf/kernel";

import { LcfApp } from "./app.js";
import { readHeartbeat, runDaemon } from "./daemon.js";
import { Dashboard } from "./dashboard.js";
import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  isPlaceholderContact,
  loadConfig,
  saveConfig,
  type LcfConfig,
  type SourceConfigEntry,
} from "./config.js";

export interface CommandContext {
  readonly cwd: string;
  readonly configPath: string;
  readonly args: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly out: (line: string) => void;
}

export type CommandResult = { readonly exitCode: number };

const OK: CommandResult = { exitCode: 0 };

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export async function commandInit(ctx: CommandContext): Promise<CommandResult> {
  const configPath = ctx.configPath;
  let config: LcfConfig;
  try {
    config = await loadConfig(configPath);
    ctx.out(`Configuration existante conservee : ${configPath}`);
  } catch {
    config = {
      ...DEFAULT_CONFIG,
      ...(typeof ctx.flags["contact"] === "string" ? { contact: ctx.flags["contact"] } : {}),
    };
    await saveConfig(configPath, config);
    ctx.out(`Configuration ecrite : ${configPath}`);
  }

  const app = await LcfApp.open({ configPath });
  try {
    const migration = await app.migrate();
    ctx.out(`Magasin initialise : ${app.config.dataDir}`);
    ctx.out(
      migration.applied.length === 0
        ? `Schema deja a jour (version ${migration.toVersion})`
        : `Schema migre : ${migration.fromVersion} -> ${migration.toVersion} (${migration.applied.length} migration(s))`,
    );
    if (isPlaceholderContact(app.config.contact)) {
      ctx.out("");
      ctx.out(`ATTENTION : contact = ${app.config.contact}`);
      ctx.out("  Renseignez une adresse reellement relevee avant toute collecte soutenue.");
      ctx.out("  Elle part dans le User-Agent de chaque requete : c'est ce qui permet a");
      ctx.out("  l'administrateur d'une source de vous ecrire plutot que de vous bloquer.");
    }

    const plugins = await app.discoverPlugins();
    ctx.out(
      plugins.length === 0
        ? "Aucun plugin detecte."
        : `Plugins detectes : ${plugins.map((p) => `${p.manifest.id}@${p.manifest.version}`).join(", ")}`,
    );
  } finally {
    await app.close();
  }
  return OK;
}

// ---------------------------------------------------------------------------
// source add / list
// ---------------------------------------------------------------------------

export async function commandSourceAdd(ctx: CommandContext): Promise<CommandResult> {
  const pluginId = ctx.args[0];
  if (pluginId === undefined) {
    ctx.out("usage : lcf source add <pluginId> [--id <sourceId>] [--config '<json>']");
    return { exitCode: 2 };
  }

  const config = await loadConfig(ctx.configPath);
  const sourceId = typeof ctx.flags["id"] === "string" ? ctx.flags["id"] : pluginId;
  if (config.sources.some((entry) => entry.sourceId === sourceId)) {
    ctx.out(`source deja declaree : ${sourceId}`);
    return { exitCode: 1 };
  }

  const rawConfig = typeof ctx.flags["config"] === "string" ? ctx.flags["config"] : "{}";
  let sourceConfig: Record<string, unknown>;
  try {
    sourceConfig = JSON.parse(rawConfig) as Record<string, unknown>;
  } catch {
    ctx.out("--config doit etre un objet JSON valide");
    return { exitCode: 2 };
  }

  const entry: SourceConfigEntry = { sourceId, pluginId, config: sourceConfig, enabled: true };
  await saveConfig(ctx.configPath, { ...config, sources: [...config.sources, entry] });

  // La source est chargee immediatement : une configuration qui ne charge pas
  // doit echouer maintenant, pas a trois heures du matin.
  const app = await LcfApp.open({ configPath: ctx.configPath });
  try {
    await app.migrate();
    const loaded = await app.loadSource(sourceId);
    ctx.out(`Source ajoutee : ${sourceId} (plugin ${loaded.manifest.id}@${loaded.manifest.version})`);
    ctx.out(`  hotes autorises : ${loaded.capabilities.network.allowedHosts.join(", ")}`);
    ctx.out(
      `  capacites detectees : ${Object.entries(loaded.detected)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .join(", ") || "aucune"}`,
    );
  } finally {
    await app.close();
  }
  return OK;
}

export async function commandSourceList(ctx: CommandContext): Promise<CommandResult> {
  const app = await LcfApp.open({ configPath: ctx.configPath });
  try {
    await app.migrate();
    const sources = await app.repository.listSources();
    if (sources.length === 0) {
      ctx.out("Aucune source enregistree.");
      return OK;
    }
    for (const source of sources) {
      const documents = await app.repository.countDocuments(source.sourceId);
      ctx.out(
        `${source.sourceId.padEnd(32)} ${source.state.padEnd(12)} ${String(documents).padStart(7)} document(s)` +
          (source.quarantineReason === undefined ? "" : `  — ${source.quarantineReason}`),
      );
    }
  } finally {
    await app.close();
  }
  return OK;
}

/**
 * Leve une quarantaine — Volume III, 6.2.
 *
 * La reactivation est strictement manuelle : jamais automatique, jamais un
 * effet de bord d'un redemarrage. Une source suspendue l'a ete pour une raison,
 * et c'est a un exploitant de dire qu'elle a ete traitee.
 */
export async function commandSourceResume(ctx: CommandContext): Promise<CommandResult> {
  const sourceId = ctx.args[0];
  if (sourceId === undefined) {
    ctx.out("usage : lcf source resume <sourceId>");
    return { exitCode: 2 };
  }

  const app = await LcfApp.open({ configPath: ctx.configPath });
  try {
    await app.migrate();
    const source = await app.repository.getSource(app.asSourceId(sourceId));
    if (source === null) {
      ctx.out(`source inconnue : ${sourceId}`);
      return { exitCode: 1 };
    }
    if (source.state !== "quarantined") {
      ctx.out(`source ${sourceId} : etat ${source.state}, rien a lever`);
      return OK;
    }

    await app.repository.setSourceState(app.asSourceId(sourceId), "ready");
    ctx.out(`Quarantaine levee : ${sourceId}`);
    ctx.out(`  motif precedent : ${source.quarantineReason ?? "non precise"}`);
    ctx.out("  aucun document n'avait ete supprime pendant la suspension.");
  } finally {
    await app.close();
  }
  return OK;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function commandRun(ctx: CommandContext): Promise<CommandResult> {
  const all = ctx.flags["all"] === true;
  const sourceId = ctx.args[0];

  if (!all && sourceId === undefined) {
    ctx.out(
      "usage : lcf run <sourceId> | --all  [--mode full|incremental] [--max <n>] " +
        "[--since <ISO-8601>] [--recheck]",
    );
    return { exitCode: 2 };
  }

  const mode = (typeof ctx.flags["mode"] === "string" ? ctx.flags["mode"] : "full") as RunMode;
  const max = typeof ctx.flags["max"] === "string" ? Number(ctx.flags["max"]) : undefined;

  // Une borne mal formee doit echouer ici, pas produire une collecte
  // silencieusement incomplete.
  const since = ctx.flags["since"];
  if (typeof since === "string" && Number.isNaN(Date.parse(since))) {
    ctx.out(`--since : date ISO-8601 attendue, recu ${since}`);
    return { exitCode: 2 };
  }

  const app = await LcfApp.open({
    configPath: ctx.configPath,
    exclusive: `run ${all ? "--all" : (sourceId as string)}`,
  });
  try {
    await app.migrate();

    const targets = all
      ? app.config.sources.filter((entry) => entry.enabled !== false).map((e) => e.sourceId)
      : [sourceId as string];

    if (targets.length === 0) {
      ctx.out("Aucune source active dans la configuration.");
      return OK;
    }

    let failures = 0;
    for (const [index, target] of targets.entries()) {
      if (targets.length > 1) {
        ctx.out(`${index > 0 ? "\n" : ""}=== ${target} (${index + 1}/${targets.length}) ===`);
      }

      // Les sources sont traitees en SEQUENCE : le delai de politesse est
      // applique par hote, et rien ne justifie de solliciter la meme
      // administration depuis deux collectes simultanees.
      const outcome = await runOneSource(app, target, {
        mode,
        ...(max === undefined || Number.isNaN(max) ? {} : { maxDocuments: max }),
        ...(typeof since === "string" ? { since } : {}),
        ...(ctx.flags["recheck"] === true ? { recheck: true } : {}),
      }, ctx);
      if (outcome !== 0) failures++;
    }

    return { exitCode: failures === 0 ? 0 : 1 };
  } finally {
    await app.close();
  }
}

async function runOneSource(
  app: LcfApp,
  sourceId: string,
  options: RunOptions,
  ctx: CommandContext,
): Promise<number> {
  let loaded;
  try {
    loaded = await app.loadSource(sourceId);
  } catch (error) {
    // Une source qui refuse de se charger ne doit pas emporter les autres.
    ctx.out(`  echec de chargement : ${describeUnknown(error)}`);
    return 1;
  }

  const summary = await app.runner.run(loaded, { ...options, trigger: "manual" });

  ctx.out(`Execution ${summary.runId} — ${summary.status}`);
  ctx.out(`  decouverts : ${summary.counters.docsDiscovered}`);
  ctx.out(`  nouveaux   : ${summary.counters.docsNew}`);
  ctx.out(`  mis a jour : ${summary.counters.docsUpdated}`);
  ctx.out(`  inchanges  : ${summary.counters.docsUnchanged}`);
  ctx.out(`  echecs     : ${summary.counters.docsFailed}`);
  ctx.out(`  octets     : ${summary.counters.bytesDownloaded}`);
  if (summary.retried > 0) ctx.out(`  rattrapes  : ${summary.retried}`);
  if (summary.withdrawn.length > 0) {
    ctx.out(`  retires    : ${summary.withdrawn.length} (aucun octet supprime)`);
  }
  if (summary.quarantined) {
    ctx.out(`  QUARANTAINE : ${summary.errorSummary ?? "motif inconnu"}`);
  }
  return summary.status === "completed" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

export async function commandDaemon(ctx: CommandContext): Promise<CommandResult> {
  ctx.out("Demarrage du demon de collecte.");
  ctx.out("Sources planifiees :");
  return runDaemon({
    configPath: ctx.configPath,
    ...(ctx.flags["once"] === true ? { once: true } : {}),
    out: ctx.out,
  });
}

// ---------------------------------------------------------------------------
// serve — tableau de bord
// ---------------------------------------------------------------------------

export async function commandServe(ctx: CommandContext): Promise<CommandResult> {
  // Pas de verrou exclusif : le tableau de bord observe, et ne declenche une
  // collecte que sur demande explicite. Exiger le verrou empecherait de
  // regarder ce que fait le demon, ce qui serait exactement l'inverse du but.
  const app = await LcfApp.open({ configPath: ctx.configPath });
  try {
    await app.migrate();

    const dashboard = new Dashboard({
      app,
      ...(typeof ctx.flags["host"] === "string"
        ? { host: ctx.flags["host"] }
        : app.config.dashboard?.host === undefined
          ? {}
          : { host: app.config.dashboard.host }),
      ...(typeof ctx.flags["port"] === "string"
        ? { port: Number(ctx.flags["port"]) }
        : app.config.dashboard?.port === undefined
          ? {}
          : { port: app.config.dashboard.port }),
      out: ctx.out,
    });

    const { host, port } = await dashboard.listen();
    ctx.out(`Tableau de bord : http://${host}:${port}`);
    if (host !== "127.0.0.1" && host !== "localhost") {
      ctx.out("");
      ctx.out("ATTENTION : ecoute hors de la machine locale.");
      ctx.out("  Ce service permet de declencher des collectes. Placez-le derriere");
      ctx.out("  un tunnel SSH ou un proxy authentifie, jamais nu sur l'Internet.");
    }
    ctx.out("Ctrl+C pour arreter.");

    await new Promise<void>((resolve) => {
      const stop = (): void => {
        ctx.out("\nArret du tableau de bord.");
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });

    await dashboard.close();
    return OK;
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function commandStatus(ctx: CommandContext): Promise<CommandResult> {
  const app = await LcfApp.open({ configPath: ctx.configPath });
  try {
    await app.migrate();
    const sources = await app.repository.listSources();
    ctx.out(`Magasin  : ${app.config.dataDir}`);
    ctx.out(`Sources  : ${sources.length}`);

    const beat = await readHeartbeat(app.config.dataDir);
    ctx.out(
      beat === null
        ? "Demon    : arrete"
        : `Demon    : actif (pid ${beat.pid}, depuis ${beat.startedAt}, ${beat.rssMb} Mo)`,
    );
    const holder = await new ProcessLock({
      dataDir: app.config.dataDir,
      command: "status",
    }).holder();
    if (holder !== null) ctx.out(`Verrou   : ${holder.command} (pid ${holder.pid})`);

    for (const source of sources) {
      if (ctx.args[0] !== undefined && ctx.args[0] !== source.sourceId) continue;
      const documents = await app.repository.countDocuments(source.sourceId);
      const runs = await app.repository.listRuns(source.sourceId, 1);
      const last = runs[0];
      ctx.out("");
      ctx.out(`${source.sourceId}  [${source.state}]`);
      ctx.out(`  documents        : ${documents}`);
      ctx.out(`  derniere reussite: ${source.lastSuccessAt ?? "jamais"}`);
      if (last !== undefined) {
        ctx.out(
          `  derniere execution: ${last.runId} ${last.status} ` +
            `(${last.docsNew} nouveaux, ${last.docsUpdated} mis a jour, ${last.docsFailed} echecs)`,
        );
      }
      if (source.quarantineReason !== undefined) {
        ctx.out(`  quarantaine      : ${source.quarantineReason} depuis ${source.quarantinedAt}`);
      }
    }
  } finally {
    await app.close();
  }
  return OK;
}

// ---------------------------------------------------------------------------
// reindex
// ---------------------------------------------------------------------------

export async function commandReindex(ctx: CommandContext): Promise<CommandResult> {
  const app = await LcfApp.open({ configPath: ctx.configPath, exclusive: "reindex" });
  try {
    await app.migrate();
    ctx.out(`Reindexation depuis ${path.join(app.config.dataDir, "objects")} — aucun acces reseau.`);
    const report = await reindexFromStore({
      driver: app.driver,
      store: app.store,
      clock: app.clock,
      logger: app.logger,
    });
    ctx.out(`  objets     : ${report.objects}`);
    ctx.out(`  documents  : ${report.documents}`);
    ctx.out(`  versions   : ${report.versions}`);
    ctx.out(`  tombstones : ${report.tombstones}`);
    if (report.missingBytes.length > 0) {
      ctx.out(`  ATTENTION : ${report.missingBytes.length} objet(s) sans octets sur disque`);
    }
    ctx.out(`  duree      : ${report.durationMs} ms`);
    return { exitCode: report.missingBytes.length === 0 ? 0 : 1 };
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export async function commandVerify(ctx: CommandContext): Promise<CommandResult> {
  const app = await LcfApp.open({ configPath: ctx.configPath });
  try {
    await app.migrate();
    const full = ctx.flags["all"] === true;
    const batchSize = typeof ctx.flags["batch"] === "string" ? Number(ctx.flags["batch"]) : undefined;

    ctx.out(`Magasin       : ${path.join(app.config.dataDir, "objects")}`);

    if (!full) {
      // Verification par lot : c'est le mode de fond, celui qui tourne sans
      // deranger la collecte. `--all` est le mode d'audit.
      const report = await app.scanner.scan({ batchSize: batchSize ?? 1000 });
      ctx.out(`Verifies      : ${report.checked} (lot ; utiliser --all pour tout le magasin)`);
      ctx.out(`  ok             ${report.ok}`);
      for (const anomaly of report.anomalies) {
        ctx.out(`  ${anomaly.result.padEnd(14)} ${anomaly.contentHash}`);
      }
      ctx.out(
        report.anomalies.length === 0
          ? "VERDICT : aucune anomalie"
          : `VERDICT : ${report.anomalies.length} anomalie(s), aucun fichier supprime`,
      );
      return { exitCode: report.anomalies.length === 0 ? 0 : 1 };
    }

    const report = await app.scanner.scanAll({
      ...(batchSize === undefined || Number.isNaN(batchSize) ? {} : { batchSize }),
    });

    ctx.out(`Objets        : ${report.objects}`);
    ctx.out(`Verifies      : ${report.checked}`);
    ctx.out(`Octets        : ${formatBytes(report.bytes)}`);
    ctx.out(`Duree         : ${formatDuration(report.durationMs)}`);
    ctx.out("");
    for (const [result, count] of Object.entries(report.counts)) {
      if (count > 0) ctx.out(`  ${result.padEnd(14)} ${String(count).padStart(9)}`);
    }
    for (const anomaly of report.anomalies) {
      ctx.out(`     -> ${anomaly.result} : ${anomaly.contentHash}`);
    }
    if (report.unindexed.length > 0) {
      ctx.out("");
      ctx.out(`  ${report.unindexed.length} objet(s) present(s) dans le magasin mais absent(s)`);
      ctx.out("  de l'index. Ce ne sont pas des erreurs : `lcf reindex` les reintegre.");
      for (const hash of report.unindexed.slice(0, 10)) ctx.out(`     -> ${hash}`);
    }

    ctx.out("");
    const anomalies = report.anomalies.length;
    ctx.out(
      anomalies === 0
        ? `VERDICT : ${report.checked} objet(s) verifie(s), aucune anomalie`
        : `VERDICT : ${anomalies} anomalie(s) signalee(s), aucun fichier supprime`,
    );
    return { exitCode: anomalies === 0 ? 0 : 1 };
  } finally {
    await app.close();
  }
}

function formatBytes(bytes: number): string {
  const units = ["o", "Kio", "Mio", "Gio", "Tio"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60_000) % 60;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
  return `${seconds} s`;
}

// ---------------------------------------------------------------------------
// aide
// ---------------------------------------------------------------------------

export function commandHelp(ctx: CommandContext): CommandResult {
  ctx.out(`lcf — Legal Collection Framework

Usage : lcf <commande> [options]

Commandes
  init                        Cree la configuration, le magasin et le schema
  source add <pluginId>       Declare une source  (--id, --config '<json>')
  source list                 Liste les sources et leur etat
  source resume <sourceId>    Leve une quarantaine, apres correction
  run <sourceId> | --all      Lance une collecte  (--mode full|incremental, --max <n>,
                              --since <ISO-8601>, --recheck)
  daemon [--once]             Service de collecte planifiee (fenetres, integrite, alertes)
  serve [--port <n>]          Tableau de bord web (127.0.0.1 par defaut)
  status [sourceId]           Etat des sources, du demon et du verrou
  reindex                     Reconstruit l'index depuis le magasin, sans reseau
  verify [--all]              Verifie l'integrite du magasin (--all, --batch <n>)

Options globales
  --config-file <chemin>      Fichier de configuration (defaut : ./${CONFIG_FILENAME})
  --log-level <niveau>        debug | info | warn | error
  --help                      Affiche cette aide

Le document original n'est jamais modifie. Aucune commande de ce menu ne
supprime de contenu.`);
  return OK;
}

export async function ensureConfigExists(configPath: string): Promise<boolean> {
  try {
    await fsp.access(configPath);
    return true;
  } catch {
    return false;
  }
}
