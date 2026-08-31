/**
 * Scheduler — Volume II, chapitre 8.
 *
 * Il orchestre les collectes dans le temps et ne fait rien d'autre : il ne
 * sait ni decouvrir, ni telecharger, ni ecrire. Sa seule question est
 * « qu'est-ce qui doit tourner maintenant, et qu'est-ce qui doit attendre ? »
 *
 * La promotion periodique en balayage complet n'est pas de son ressort :
 * l'orchestrateur l'impose deja (Vol. III, 7.3). Le scheduler demande toujours
 * une collecte incrementale et laisse le Kernel decider.
 */
import { describeUnknown } from "../domain/errors.js";
import { toIsoTimestamp, type SourceId } from "../domain/ids.js";
import type { Clock, Logger } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import { SilentLogger } from "../observability/logger.js";
import type { LoadedPlugin } from "../plugins/plugin-manager.js";
import type { CollectionRunner, RunSummary } from "../orchestration/collection-runner.js";
import type { IntegrityScanner } from "../orchestration/integrity-scanner.js";
import type { DocumentRepository } from "../db/repository.js";
import { matchesCron, nextRunAfter, parseCron, type CronExpression } from "./cron.js";
import { describeWindow, matchingWindow, type BlackoutWindow } from "./blackout.js";

export interface ScheduledSource {
  readonly sourceId: SourceId;
  readonly cron: string;
  /** Chargement paresseux : un plugin n'est instancie qu'a l'echeance. */
  load(): Promise<LoadedPlugin>;
}

export interface SchedulerOptions {
  readonly runner: CollectionRunner;
  readonly repository: DocumentRepository;
  readonly scanner?: IntegrityScanner;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly blackout?: readonly BlackoutWindow[];
  /** Heures sans collecte reussie avant de crier — Volume VII, 5.3. */
  readonly silentAfterMs?: number;
  /** Objets verifies a chaque tour de fond. */
  readonly verifyBatchSize?: number;
}

export interface SchedulerState {
  readonly sourceId: SourceId;
  readonly cron: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
}

/** Une heure entre deux tours de verification d'integrite. */
const VERIFY_EVERY_MS = 60 * 60 * 1000;
/** Un controle de silence par jour suffit : c'est une alerte, pas une mesure. */
const SILENCE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SILENT_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

interface Entry {
  readonly source: ScheduledSource;
  readonly cron: CronExpression;
  lastTriggeredMinute: number | null;
  lastRunAt: string | null;
  lastStatus: string | null;
}

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #entries: Entry[] = [];
  #lastVerifyAt = 0;
  #lastSilenceCheckAt = 0;
  #running = false;
  #stopping = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? new SystemClock();
    this.#logger = options.logger ?? new SilentLogger();
  }

  /** Inscrit une source. Une expression illisible est refusee immediatement. */
  register(source: ScheduledSource): void {
    this.#entries.push({
      source,
      cron: parseCron(source.cron),
      lastTriggeredMinute: null,
      lastRunAt: null,
      lastStatus: null,
    });
  }

  get sources(): readonly SchedulerState[] {
    const now = this.#clock.now();
    return this.#entries.map((entry) => ({
      sourceId: entry.source.sourceId,
      cron: entry.cron.source,
      nextRunAt: nextRunAfter(entry.cron, now)?.toISOString() ?? null,
      lastRunAt: entry.lastRunAt,
      lastStatus: entry.lastStatus,
    }));
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /**
   * Un tour d'horloge. Rend la liste de ce qui a effectivement tourne.
   *
   * Les collectes sont lancees en SEQUENCE : deux sources visant le meme hote
   * doivent se partager la charge, pas l'additionner.
   */
  async tick(): Promise<RunSummary[]> {
    const now = this.#clock.now();
    const summaries: RunSummary[] = [];

    const window = matchingWindow(this.#options.blackout ?? [], now);
    if (window !== null) {
      this.#logger.debug("fenetre d'exclusion : aucun declenchement", {
        window: describeWindow(window),
      });
      return summaries;
    }

    const minute = Math.floor(now.getTime() / 60_000);
    for (const entry of this.#entries) {
      if (this.#stopping) break;
      // Une echeance ne declenche qu'une fois, meme si le tour se repete.
      if (entry.lastTriggeredMinute === minute) continue;
      if (!matchesCron(entry.cron, now)) continue;
      entry.lastTriggeredMinute = minute;

      const summary = await this.#collect(entry);
      if (summary !== null) summaries.push(summary);
    }

    await this.#backgroundWork(now);
    return summaries;
  }

  async #collect(entry: Entry): Promise<RunSummary | null> {
    const sourceId = entry.source.sourceId;
    try {
      const loaded = await entry.source.load();
      if (loaded.state === "quarantined") {
        // Une source suspendue le reste jusqu'a une action d'exploitation :
        // la reactivation n'est jamais automatique (Vol. III, 6.2).
        this.#logger.warn("source en quarantaine, collecte non declenchee", { sourceId });
        entry.lastStatus = "quarantined";
        return null;
      }

      const summary = await this.#options.runner.run(loaded, {
        mode: "incremental",
        trigger: "schedule",
      });
      entry.lastRunAt = toIsoTimestamp(this.#clock.now());
      entry.lastStatus = summary.status;
      return summary;
    } catch (error) {
      // Une source qui echoue ne doit jamais emporter les autres ni le demon.
      entry.lastRunAt = toIsoTimestamp(this.#clock.now());
      entry.lastStatus = "error";
      this.#logger.error("collecte planifiee en echec", {
        sourceId,
        error: describeUnknown(error),
      });
      return null;
    }
  }

  /** Verification d'integrite etalee et alerte d'absence. */
  async #backgroundWork(now: Date): Promise<void> {
    const millis = now.getTime();

    if (this.#options.scanner !== undefined && millis - this.#lastVerifyAt >= VERIFY_EVERY_MS) {
      this.#lastVerifyAt = millis;
      try {
        // Le magasin entier est couvert sur une fenetre glissante de 30 jours
        // (Vol. IV, 7.2), en priorisant les objets les plus anciens.
        const report = await this.#options.scanner.scan({
          batchSize: this.#options.verifyBatchSize ?? 100,
        });
        if (report.anomalies.length > 0) {
          this.#logger.error("verification de fond : anomalies", {
            checked: report.checked,
            anomalies: report.anomalies.length,
          });
        }
      } catch (error) {
        this.#logger.error("verification de fond en echec", { error: describeUnknown(error) });
      }
    }

    if (millis - this.#lastSilenceCheckAt >= SILENCE_CHECK_EVERY_MS) {
      this.#lastSilenceCheckAt = millis;
      await this.#checkSilence(millis);
    }
  }

  /**
   * Alerte d'absence — Volume VII, 5.3.
   *
   * Le mode de panne le plus couteux n'est pas l'erreur : c'est le silence.
   * Une source qui ne renvoie plus rien ne declenche aucune alarme naturelle.
   */
  async #checkSilence(millis: number): Promise<void> {
    const threshold = this.#options.silentAfterMs ?? DEFAULT_SILENT_AFTER_MS;
    for (const entry of this.#entries) {
      const source = await this.#options.repository.getSource(entry.source.sourceId);
      if (source === null || source.state === "disabled") continue;

      const last = source.lastSuccessAt;
      const silentFor = last === undefined ? Infinity : millis - Date.parse(last);
      if (silentFor > threshold) {
        this.#logger.error("source silencieuse", {
          sourceId: entry.source.sourceId,
          lastSuccessAt: last ?? null,
          silentHours: Number.isFinite(silentFor) ? Math.round(silentFor / 3_600_000) : null,
        });
      }
    }
  }

  /** Boucle jusqu'a `stop()`. Un tour par minute. */
  async start(): Promise<void> {
    this.#running = true;
    this.#stopping = false;
    this.#logger.info("scheduler demarre", {
      sources: this.#entries.map((entry) => entry.source.sourceId),
    });

    while (!this.#stopping) {
      try {
        await this.tick();
      } catch (error) {
        // Le demon survit a tout : une exception ici l'arreterait pour de bon.
        this.#logger.error("tour de scheduler en echec", { error: describeUnknown(error) });
      }
      if (this.#stopping) break;
      await this.#sleepUntilNextMinute();
    }

    this.#running = false;
    this.#logger.info("scheduler arrete");
  }

  /** Demande l'arret. Le tour en cours va a son terme. */
  stop(): void {
    this.#stopping = true;
  }

  async #sleepUntilNextMinute(): Promise<void> {
    const now = this.#clock.nowMillis();
    const remaining = 60_000 - (now % 60_000);
    await this.#clock.sleep(remaining);
  }
}
