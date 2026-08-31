/**
 * Orchestrateur de collecte — Volume II chapitre 2.3, Volume IV chapitre 6.
 *
 * C'est le seul composant qui connaisse le flux complet. Il repond a une unique
 * question : « existe-t-il un nouveau document officiel ? » — et, si oui,
 * decouvre, valide, telecharge, hache, extrait, enregistre et notifie.
 *
 * Il ne connait aucune source : il ne manipule que des plugins, des
 * descripteurs et des evenements.
 */
import {
  BudgetExceeded,
  LcfError,
  classify,
  describeUnknown,
  type ErrorScope,
} from "../domain/errors.js";
import {
  computeDocumentId,
  newRunId,
  toIsoTimestamp,
  type DocumentId,
  type RunId,
  type SourceId,
} from "../domain/ids.js";
import {
  isDescribable,
  isIncremental,
  type CheckpointState,
  type Clock,
  type DiscoveryBudget,
  type DiscoveryScope,
  type DocumentRef,
  type Logger,
  type SourceMetadata,
} from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import { SilentLogger } from "../observability/logger.js";
import type { DocumentVersion, RunCounters, RunMode, RunTrigger } from "../domain/model.js";
import { ZERO_COUNTERS } from "../domain/model.js";
import { createEvent, type EventBus } from "../events/event-bus.js";
import type { DocumentUnchangedData } from "../domain/events.js";
import type { DocumentRepository } from "../db/repository.js";
import type { ContentStore } from "../storage/content-store.js";
import type { ObjectReference } from "../storage/descriptor.js";
import type { DownloadManager } from "../download/download-manager.js";
import type { LoadedPlugin, PluginManager } from "../plugins/plugin-manager.js";
import { BudgetTracker } from "../net/policy.js";
import { describeWindow, matchingWindow, type BlackoutWindow } from "../scheduling/blackout.js";

/** Budget par defaut d'une collecte complete. Genereux, mais borne. */
export const DEFAULT_BUDGET: DiscoveryBudget = Object.freeze({
  maxRequests: 10_000,
  maxBytes: 10 * 1024 * 1024 * 1024,
  maxDurationMs: 6 * 60 * 60 * 1000,
});

/** Seuil de retrait : trois balayages complets consecutifs — Volume IV, 6.4. */
export const DEFAULT_WITHDRAWAL_SWEEPS = 3;

/** Fenetre et seuil de mise en quarantaine sur echecs — Volume III, 6.3. */
export const FAILURE_WINDOW = 100;
export const FAILURE_RATIO = 0.5;

/** Executions consecutives sans decouverte avant quarantaine. */
export const EMPTY_RUN_STREAK = 3;

/**
 * Periodicite du balayage complet impose — Volume III, 7.3.
 *
 * Le mode incremental est une optimisation, jamais une source de verite. Toute
 * architecture incrementale qui ne prevoit pas de balayage complet finit par
 * diverger de la realite ; la seule question est de savoir combien de temps il
 * faudra pour s'en apercevoir. Passe ce delai, une collecte incrementale est
 * silencieusement promue en collecte complete.
 */
export const DEFAULT_FULL_SWEEP_EVERY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Documents en echec repris a chaque collecte non complete.
 *
 * Un balayage complet redecouvre tout, echecs compris. Une collecte
 * incrementale, elle, ne revoit que les nouveautes : sans reprise ciblee, un
 * document ayant echoue une fois attendrait le balayage complet suivant, soit
 * jusqu'a trente jours. La borne evite qu'une source durablement cassee ne
 * consacre chaque nuit a retenter mille documents perdus.
 */
export const DEFAULT_MAX_RETRIES_PER_RUN = 50;

export interface RunOptions {
  readonly mode?: RunMode;
  readonly trigger?: RunTrigger;
  readonly budget?: Partial<DiscoveryBudget>;
  readonly maxDocuments?: number;
  readonly since?: string;
  readonly nativeId?: string;
  /**
   * Force la comparaison d'empreinte meme en mode incremental.
   * Filet de l'exploitant : quand on soupconne qu'une source a modifie des
   * contenus sans changer le moindre indice de fraicheur.
   */
  readonly recheck?: boolean;
}

export interface RunSummary {
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly status: "completed" | "failed" | "cancelled";
  readonly counters: RunCounters;
  readonly withdrawn: readonly DocumentId[];
  /** Documents en echec repris pendant cette execution, et rattrapes. */
  readonly retried: number;
  readonly quarantined: boolean;
  readonly errorSummary?: string;
  readonly durationMs: number;
}

export interface CollectionRunnerOptions {
  readonly repository: DocumentRepository;
  readonly store: ContentStore;
  readonly downloads: DownloadManager;
  readonly plugins: PluginManager;
  readonly bus: EventBus;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly withdrawalSweeps?: number;
  readonly fullSweepEveryMs?: number;
  readonly maxRetriesPerRun?: number;
  /**
   * Fenetres pendant lesquelles aucune collecte ne doit solliciter la source.
   *
   * Une collecte de plusieurs heures traverse forcement des heures ouvrables :
   * la verification a lieu a chaque document, pas seulement au demarrage.
   */
  readonly blackout?: readonly BlackoutWindow[];
}

/**
 * Verrou par source — Volume IV, 5.3.
 * Deux executions simultanees sur la meme source sont interdites : SQLite
 * n'admet qu'un ecrivain, et deux collectes concurrentes produiraient des
 * numeros de version en conflit.
 */
export class SourceLock {
  readonly #held = new Set<string>();

  tryAcquire(sourceId: SourceId): boolean {
    if (this.#held.has(sourceId)) return false;
    this.#held.add(sourceId);
    return true;
  }

  release(sourceId: SourceId): void {
    this.#held.delete(sourceId);
  }

  isHeld(sourceId: SourceId): boolean {
    return this.#held.has(sourceId);
  }

  /** Sources dont une collecte est en cours dans ce processus. */
  heldSources(): string[] {
    return [...this.#held];
  }
}

export class CollectionRunner {
  readonly #repo: DocumentRepository;
  readonly #store: ContentStore;
  readonly #downloads: DownloadManager;
  readonly #plugins: PluginManager;
  readonly #bus: EventBus;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #withdrawalSweeps: number;
  readonly #fullSweepEveryMs: number;
  readonly #maxRetriesPerRun: number;
  readonly #blackout: readonly BlackoutWindow[];
  readonly #locks = new SourceLock();
  /** Sources dont l'arret a ete demande. Vide en fonctionnement normal. */
  readonly #stopRequested = new Set<string>();

  constructor(options: CollectionRunnerOptions) {
    this.#repo = options.repository;
    this.#store = options.store;
    this.#downloads = options.downloads;
    this.#plugins = options.plugins;
    this.#bus = options.bus;
    this.#clock = options.clock ?? new SystemClock();
    this.#logger = options.logger ?? new SilentLogger();
    this.#withdrawalSweeps = options.withdrawalSweeps ?? DEFAULT_WITHDRAWAL_SWEEPS;
    this.#fullSweepEveryMs = options.fullSweepEveryMs ?? DEFAULT_FULL_SWEEP_EVERY_MS;
    this.#maxRetriesPerRun = options.maxRetriesPerRun ?? DEFAULT_MAX_RETRIES_PER_RUN;
    this.#blackout = options.blackout ?? [];
  }

  /**
   * Demande l'arret cooperatif des collectes en cours.
   *
   * L'arret n'est jamais brutal : la collecte s'interrompt entre deux
   * documents. Couper en plein transfert ne gagnerait que quelques secondes et
   * laisserait un fichier de transit de plus derriere soi.
   */
  requestStopAll(): string[] {
    const stopping = this.#locks.heldSources();
    for (const sourceId of stopping) this.#stopRequested.add(sourceId);
    return stopping;
  }

  requestStop(sourceId: SourceId): void {
    this.#stopRequested.add(sourceId);
  }

  async run(loaded: LoadedPlugin, options: RunOptions = {}): Promise<RunSummary> {
    const sourceId = loaded.sourceId;
    if (loaded.state === "quarantined") {
      throw new LcfErrorLike(
        `source en quarantaine depuis ${loaded.quarantineReason ?? "motif inconnu"}`,
      );
    }
    if (!this.#locks.tryAcquire(sourceId)) {
      throw new LcfErrorLike(`une collecte est deja en cours sur ${sourceId}`);
    }

    const startedAtMs = this.#clock.nowMillis();
    const runId = newRunId(startedAtMs);
    const startedAt = toIsoTimestamp(startedAtMs);
    const logger = this.#logger.child({ sourceId, runId });

    // Le mode demande n'est pas toujours le mode applique : un incremental
    // trop ancien est promu en balayage complet.
    const mode = await this.#resolveMode(sourceId, options.mode ?? "full", logger);

    // Restauration de l'etat de reprise AVANT toute decouverte, QUEL QUE SOIT
    // le mode : un balayage complet interrompu par le budget doit reprendre ou
    // il s'est arrete, sinon il refait eternellement ses premieres pages. La
    // borne temporelle, elle, ne sert qu'en incremental.
    const restored = await this.#restoreCheckpoint(loaded, logger);
    const restoredSince = mode === "incremental" ? restored : undefined;

    // Le budget est installe sur le client du plugin pour la duree de la
    // collecte : son epuisement interrompt l'enumeration la ou elle en est.
    const budget = new BudgetTracker({ ...DEFAULT_BUDGET, ...options.budget }, this.#clock);
    loaded.http.useBudget(budget);
    loaded.http.resetCounters();
    const counters = { ...ZERO_COUNTERS };
    const recentOutcomes: boolean[] = [];
    let blackoutStop: string | undefined;
    let truncatedBy: string | undefined;
    let quarantined = false;
    let errorSummary: string | undefined;
    let status: RunSummary["status"] = "completed";

    await this.#repo.startRun({ runId, sourceId, mode, trigger: options.trigger ?? "manual", startedAt });
    this.#plugins.markActive(sourceId);
    await this.#bus.publish(
      createEvent("lcf.run.started", { runId, sourceId, mode, trigger: options.trigger ?? "manual" }, { sourceId, runId, at: startedAtMs }),
    );

    // La borne temporelle demandee prime sur celle du checkpoint : un
    // exploitant qui precise `--since` sait ce qu'il fait.
    const since = options.since ?? restoredSince;

    const scope: DiscoveryScope = {
      mode: mode === "repair" ? "full" : mode,
      budget: { ...DEFAULT_BUDGET, ...options.budget },
      ...(since === undefined ? {} : { since }),
      ...(options.nativeId === undefined ? {} : { nativeId: options.nativeId }),
      ...(options.maxDocuments === undefined ? {} : { maxDocuments: options.maxDocuments }),
    };

    try {
      for await (const ref of loaded.plugin.discover(scope)) {
        if (this.#stopRequested.has(sourceId)) {
          blackoutStop = "arret demande";
          logger.info("collecte interrompue a la demande", {
            docsDiscovered: counters.docsDiscovered,
          });
          break;
        }

        // Entree dans une fenetre d'exclusion : on s'arrete la, proprement.
        // Tout ce qui est deja collecte est conserve, et la collecte suivante
        // reprendra ou celle-ci s'est arretee.
        const window = matchingWindow(this.#blackout, this.#clock.now());
        if (window !== null) {
          blackoutStop = describeWindow(window);
          logger.info("collecte interrompue par une fenetre d'exclusion", {
            window: blackoutStop,
            docsDiscovered: counters.docsDiscovered,
          });
          break;
        }

        counters.docsDiscovered++;

        const documentId = computeDocumentId(sourceId, ref.nativeId);
        const seenAt = toIsoTimestamp(this.#clock.now());
        await this.#repo.recordDiscovery({
          runId,
          sourceId,
          documentId,
          nativeId: ref.nativeId,
          ...(ref.url === undefined ? {} : { canonicalUrl: ref.url }),
          seenAt,
        });
        await this.#bus.publish(
          createEvent(
            "lcf.document.discovered",
            {
              documentId,
              sourceId,
              nativeId: ref.nativeId,
              ...(ref.url === undefined ? {} : { url: ref.url }),
            },
            { sourceId, runId, at: this.#clock.nowMillis() },
          ),
        );

        try {
          await this.#collectOne(
            loaded,
            runId,
            ref,
            documentId,
            counters,
            mode,
            options.recheck === true,
          );
          recentOutcomes.push(true);
        } catch (thrown) {
          const error = classify(sourceId, thrown);
          if (error instanceof BudgetExceeded) throw error;

          counters.docsFailed++;
          recentOutcomes.push(false);
          await this.#repo.markDocumentFailed(documentId, toIsoTimestamp(this.#clock.now()));
          await this.#repo.recordAttempt(runId, documentId, {
            startedAt: seenAt,
            endedAt: toIsoTimestamp(this.#clock.now()),
            ...(ref.url === undefined ? {} : { url: ref.url }),
            outcome: error.retryable ? "transient_error" : "permanent_error",
            errorClass: error.errorClass,
            errorDetail: error.message,
          });
          await this.#bus.publish(
            createEvent(
              "lcf.document.failed",
              {
                documentId,
                sourceId,
                errorClass: error.errorClass,
                message: error.message,
                retryable: error.retryable,
              },
              { sourceId, runId, at: this.#clock.nowMillis() },
            ),
          );
          logger.warn("document non collecte", {
            nativeId: ref.nativeId,
            errorClass: error.errorClass,
          });

          // Une erreur de portee `source` arrete tout de suite : poursuivre
          // reviendrait a marteler une source dont on sait qu'elle est cassee.
          if (scopeOf(error) === "source") throw error;
          if (exceedsFailureRatio(recentOutcomes)) {
            throw new LcfErrorLike(
              `taux d'echec superieur a ${FAILURE_RATIO * 100} % sur ${FAILURE_WINDOW} documents`,
            );
          }
        }

        if (options.maxDocuments !== undefined && counters.docsDiscovered >= options.maxDocuments) {
          // Une collecte plafonnee a vu ce qu'on lui a demande de voir, pas la
          // source : elle ne vaut pas balayage complet.
          truncatedBy = `plafond de ${options.maxDocuments} documents`;
          break;
        }
      }
    } catch (thrown) {
      const error = classify(sourceId, thrown);
      errorSummary = `${error.errorClass}: ${error.message}`;
      status = error instanceof BudgetExceeded ? "completed" : "failed";

      if (error instanceof BudgetExceeded) {
        // Le budget n'est pas une panne : les documents deja collectes sont
        // conserves, et l'evenement dit ou l'enumeration s'est arretee.
        await this.#bus.publish(
          createEvent(
            "lcf.discovery.budget_exceeded",
            {
              sourceId,
              runId,
              dimension: error.context["dimension"] as "requests" | "bytes" | "duration",
              limit: Number(error.context["limit"]),
              discoveredBeforeStop: counters.docsDiscovered,
            },
            { sourceId, runId, at: this.#clock.nowMillis() },
          ),
        );
      } else if (scopeOf(error) === "source") {
        quarantined = true;
      }
    } finally {
      counters.requestsMade = loaded.http.requestsMade;
      loaded.http.useBudget(undefined);
      this.#stopRequested.delete(sourceId);
      this.#plugins.markIdle(sourceId);
      this.#locks.release(sourceId);
    }

    // Le motif d'interruption doit etre pose AVANT la cloture : c'est lui qui
    // distingue, en base, un balayage mene a son terme d'un balayage tronque.
    // Toute la logique de promotion et de retrait s'y adosse.
    if (blackoutStop !== undefined) errorSummary = `interrompue : ${blackoutStop}`;
    else if (truncatedBy !== undefined) errorSummary = `tronquee : ${truncatedBy}`;

    // Reprise ciblee : inutile apres un balayage complet, qui vient deja de
    // redecouvrir — et donc de retenter — tous les documents en echec. Inutile
    // aussi si l'on vient de s'arreter pour cause de fenetre d'exclusion.
    const retried =
      status === "completed" && blackoutStop === undefined && mode !== "full"
        ? await this.#retryFailed(loaded, runId, counters, logger)
        : 0;

    const endedAtMs = this.#clock.nowMillis();
    await this.#repo.closeRun({
      runId,
      status,
      endedAt: toIsoTimestamp(endedAtMs),
      counters,
      ...(errorSummary === undefined ? {} : { errorSummary }),
      ...(await this.#checkpointOf(loaded)),
    });

    // Retrait : uniquement apres un balayage complet mene a son terme.
    const withdrawn =
      status === "completed" && mode === "full"
        ? await this.#repo.withdrawUnseen(
            sourceId,
            this.#withdrawalSweeps,
            toIsoTimestamp(endedAtMs),
          )
        : [];

    if (!quarantined && status === "completed" && mode === "full") {
      quarantined = await this.#shouldQuarantineOnSilence(sourceId);
      if (quarantined) errorSummary = "aucun document decouvert sur plusieurs balayages complets";
    }

    if (quarantined) {
      await this.#quarantine(sourceId, errorSummary ?? "erreur fatale", runId);
    }

    await this.#bus.publish(
      createEvent(
        "lcf.run.completed",
        {
          runId,
          sourceId,
          status,
          docsDiscovered: counters.docsDiscovered,
          docsNew: counters.docsNew,
          docsUpdated: counters.docsUpdated,
          docsUnchanged: counters.docsUnchanged,
          docsFailed: counters.docsFailed,
          bytesDownloaded: counters.bytesDownloaded,
          durationMs: endedAtMs - startedAtMs,
        },
        { sourceId, runId, at: endedAtMs },
      ),
    );

    logger.info("collecte terminee", {
      status,
      ...counters,
      withdrawn: withdrawn.length,
      retried,
    });
    return {
      runId,
      sourceId,
      status,
      counters,
      withdrawn,
      retried,
      quarantined,
      ...(errorSummary === undefined ? {} : { errorSummary }),
      durationMs: endedAtMs - startedAtMs,
    };
  }

  /**
   * Decision de version — Volume IV, 6.1 et 6.2.
   *
   * Les niveaux N1 (ETag) et N2 (Last-Modified) sont des accelerateurs
   * opportunistes ; seul N3, la comparaison d'empreinte, fait autorite. Un
   * balayage complet ne se fie jamais aux deux premiers.
   */
  async #collectOne(
    loaded: LoadedPlugin,
    runId: RunId,
    ref: DocumentRef,
    documentId: DocumentId,
    counters: RunCounters & { docsNew: number },
    mode: RunMode,
    forceRecheck = false,
  ): Promise<void> {
    const sourceId = loaded.sourceId;
    const known = await this.#repo.currentVersion(documentId);
    const mutable = counters as {
      docsNew: number;
      docsUpdated: number;
      docsUnchanged: number;
      bytesDownloaded: number;
    };

    // Echelle de decision — Volume IV, 6.2. Le volume est explicite : N1 et N2
    // sont des accelerateurs opportunistes, et N3 — la comparaison d'empreinte —
    // est obligatoire « lors du balayage complet periodique ». Pas a chaque
    // passe : sur une source qui ne sert aucun validateur HTTP, l'appliquer
    // partout revient a retelecharger le corpus entier chaque nuit.
    if (mode !== "full" && mode !== "repair" && known !== null && !forceRecheck) {
      const decision = compareFreshness(ref, known);
      if (decision !== "changed") {
        await this.#repo.touchDocument(documentId, toIsoTimestamp(this.#clock.now()));
        mutable.docsUnchanged++;
        await this.#publishUnchanged(sourceId, runId, documentId, decision);
        return;
      }
    }

    const plan = await loaded.plugin.resolve(ref);
    const outcome = await this.#downloads.execute(loaded.http, {
      plan,
      runId,
      sourceId,
      documentId,
      nativeId: ref.nativeId,
      ...(ref.declaredMime === undefined ? {} : { declaredMime: ref.declaredMime }),
      expect: {
        ...(loaded.manifest.integrity.expectedMimeTypes === undefined
          ? {}
          : { mimeTypes: loaded.manifest.integrity.expectedMimeTypes }),
        ...(loaded.manifest.integrity.minDocumentBytes === undefined
          ? {}
          : { minBytes: loaded.manifest.integrity.minDocumentBytes }),
        maxBytes: loaded.manifest.integrity.maxDocumentBytes,
      },
      ...(mode === "full" || known === null
        ? {}
        : {
            conditional: {
              ...(known.httpEtag === undefined ? {} : { etag: known.httpEtag }),
              ...(known.httpLastModified === undefined
                ? {}
                : { lastModified: known.httpLastModified }),
            },
          }),
    });

    if (outcome.status === "not_modified") {
      await this.#repo.touchDocument(documentId, toIsoTimestamp(this.#clock.now()));
      mutable.docsUnchanged++;
      await this.#publishUnchanged(sourceId, runId, documentId, "not_modified");
      return;
    }

    // N3 : l'empreinte fait autorite. Un contenu identique ne cree jamais de
    // version, meme si les metadonnees ou l'URL ont change.
    if (known !== null && known.contentHash === outcome.stored.contentHash) {
      await this.#repo.touchDocument(documentId, toIsoTimestamp(this.#clock.now()));
      mutable.docsUnchanged++;
      await this.#publishUnchanged(sourceId, runId, documentId, "identical_content");
      return;
    }

    const versionNo = known === null ? 1 : known.versionNo + 1;
    const metadata = await this.#describe(loaded, ref);
    const fetchedAt = toIsoTimestamp(this.#clock.now());

    // L'indice de fraicheur retenu est celui de la reponse, a defaut celui
    // annonce par l'index. Sans ce repli, une source qui publie ses ETags dans
    // sa liste mais pas dans ses reponses n'aurait jamais rien de comparable,
    // et N1 resterait lettre morte pour elle.
    const etag = outcome.etag ?? ref.etag;
    const lastModified = outcome.lastModified ?? ref.lastModified;

    await this.#repo.commitDocument({
      runId,
      sourceId,
      documentId,
      nativeId: ref.nativeId,
      ...(ref.url === undefined ? {} : { canonicalUrl: ref.url }),
      stored: outcome.stored,
      versionNo,
      changeReason: known === null ? "initial" : "content_changed",
      ...(known === null ? {} : { supersedesVersion: known.versionNo }),
      fetchedAt,
      ...(outcome.finalUrl === undefined ? {} : { fetchedFromUrl: outcome.finalUrl }),
      ...(etag === undefined ? {} : { httpEtag: etag }),
      ...(lastModified === undefined ? {} : { httpLastModified: lastModified }),
      ...(metadata === undefined ? {} : { metadata }),
      attempt: outcome.attempt,
    });

    // E8 rejoue : le descripteur accueille la reference, une fois le numero de
    // version connu. Le magasin reste ainsi auto-suffisant (invariant I-4).
    const reference: ObjectReference = {
      documentId,
      sourceId,
      nativeId: ref.nativeId,
      versionNo,
      ...(outcome.finalUrl === undefined ? {} : { fetchedFromUrl: outcome.finalUrl }),
      fetchedAt,
      runId,
      ...(etag === undefined ? {} : { httpEtag: etag }),
      ...(lastModified === undefined ? {} : { httpLastModified: lastModified }),
      changeReason: known === null ? "initial" : "content_changed",
      ...(metadata === undefined
        ? {}
        : {
            metadata: {
              raw: metadata.raw,
              ...(metadata.common === undefined ? {} : { common: metadata.common }),
              provenance: metadata.provenance,
            },
          }),
    };
    await this.#store.attachReference(outcome.stored.contentHash, reference);

    if (known === null) mutable.docsNew++;
    else mutable.docsUpdated++;
    if (!outcome.stored.deduplicated) mutable.bytesDownloaded += outcome.stored.byteSize;

    await this.#bus.publish(
      createEvent(
        "lcf.document.stored",
        {
          documentId,
          sourceId,
          contentHash: outcome.stored.contentHash,
          version: versionNo,
          bytes: outcome.stored.byteSize,
          mimeType: outcome.stored.mimeType,
          isNewVersion: true,
        },
        { sourceId, runId, at: this.#clock.nowMillis() },
      ),
    );

    if (known !== null) {
      await this.#bus.publish(
        createEvent(
          "lcf.document.version_created",
          {
            documentId,
            sourceId,
            versionNo,
            previousHash: known.contentHash,
            contentHash: outcome.stored.contentHash,
          },
          { sourceId, runId, at: this.#clock.nowMillis() },
        ),
      );
    }
  }

  /**
   * Un balayage complet est impose si le dernier remonte a plus de
   * `fullSweepEveryMs`, ou s'il n'y en a jamais eu. Une source jamais
   * entierement parcourue ne peut pas etre collectee de maniere incrementale :
   * il n'existe aucun etat auquel se raccrocher.
   */
  async #resolveMode(sourceId: SourceId, requested: RunMode, logger: Logger): Promise<RunMode> {
    if (requested !== "incremental") return requested;

    const lastSweep = await this.#repo.lastFullSweepAt(sourceId);
    if (lastSweep === null) {
      logger.info("balayage complet impose : aucun precedent", { requested });
      return "full";
    }

    const age = this.#clock.nowMillis() - Date.parse(lastSweep);
    if (age > this.#fullSweepEveryMs) {
      logger.info("balayage complet impose : le precedent est trop ancien", {
        lastSweep,
        ageDays: Math.round(age / 86_400_000),
      });
      return "full";
    }
    return "incremental";
  }

  /**
   * Restaure l'etat de reprise du plugin. Un checkpoint illisible — format
   * modifie, plugin remplace — n'interrompt jamais la collecte : il est
   * signale, ignore, et la collecte repart d'un etat vide.
   */
  async #restoreCheckpoint(loaded: LoadedPlugin, logger: Logger): Promise<string | undefined> {
    if (!isIncremental(loaded.plugin)) return undefined;

    const stored = await this.#repo.lastCheckpoint(loaded.sourceId);
    if (stored === null) return undefined;

    try {
      const state = JSON.parse(stored) as CheckpointState;
      if (state.version !== 1) {
        logger.warn("checkpoint d'une autre version, ignore", { version: state.version });
        return undefined;
      }
      await loaded.plugin.restore(state);
      logger.info("reprise depuis le checkpoint precedent", {
        highWaterMark: state.highWaterMark ?? null,
        cursor: state.cursor ?? null,
      });
      return state.highWaterMark;
    } catch (error) {
      logger.warn("checkpoint illisible, collecte repartie d'un etat vide", {
        error: describeUnknown(error),
      });
      return undefined;
    }
  }

  /**
   * Retente les documents laisses en echec par les collectes precedentes.
   *
   * Le descripteur est reconstruit depuis l'index : identifiant natif et URL
   * canonique, rien de plus. Un plugin dont `resolve()` s'appuie sur la charge
   * utile `extra` ne pourra donc pas resoudre le document ici — il levera
   * `UnresolvableDocument`, le document restera en echec, et le prochain
   * balayage complet le rattrapera avec un descripteur complet. C'est une
   * limite assumee : reconstruire une charge utile propre au plugin reviendrait
   * a l'inventer.
   */
  async #retryFailed(
    loaded: LoadedPlugin,
    runId: RunId,
    counters: RunCounters,
    logger: Logger,
  ): Promise<number> {
    const failed = await this.#repo.listFailedDocuments(loaded.sourceId, this.#maxRetriesPerRun);
    if (failed.length === 0) return 0;

    logger.info("reprise des documents en echec", { candidats: failed.length });
    let recovered = 0;

    for (const document of failed) {
      const ref: DocumentRef = {
        nativeId: document.nativeId,
        ...(document.canonicalUrl === undefined ? {} : { url: document.canonicalUrl }),
      };
      const startedAt = toIsoTimestamp(this.#clock.now());

      try {
        // Reprise : on force la comparaison d'empreinte. Un document en echec
        // n'a pas de version connue a laquelle se fier.
        await this.#collectOne(
          loaded,
          runId,
          ref,
          document.documentId,
          counters,
          "incremental",
          true,
        );
        recovered++;
        logger.info("document rattrape", { nativeId: document.nativeId });
      } catch (thrown) {
        const error = classify(loaded.sourceId, thrown);
        await this.#repo.markDocumentFailed(
          document.documentId,
          toIsoTimestamp(this.#clock.now()),
        );
        await this.#repo.recordAttempt(runId, document.documentId, {
          startedAt,
          endedAt: toIsoTimestamp(this.#clock.now()),
          ...(document.canonicalUrl === undefined ? {} : { url: document.canonicalUrl }),
          outcome: error.retryable ? "transient_error" : "permanent_error",
          errorClass: error.errorClass,
          errorDetail: error.message,
        });

        // Une panne de portee source interrompt la reprise, sans faire echouer
        // la collecte qui, elle, s'est bien terminee.
        if (error.scope === "source") {
          logger.warn("reprise interrompue", { errorClass: error.errorClass });
          break;
        }
      }
    }

    return recovered;
  }

  async #describe(loaded: LoadedPlugin, ref: DocumentRef): Promise<SourceMetadata | undefined> {
    if (!isDescribable(loaded.plugin)) return undefined;
    return loaded.plugin.describe(ref);
  }

  async #checkpointOf(loaded: LoadedPlugin): Promise<{ checkpointJson?: string }> {
    if (!isIncremental(loaded.plugin)) return {};
    try {
      return { checkpointJson: JSON.stringify(await loaded.plugin.checkpoint()) };
    } catch (error) {
      this.#logger.warn("checkpoint indisponible", { error: describeUnknown(error) });
      return {};
    }
  }

  async #publishUnchanged(
    sourceId: SourceId,
    runId: RunId,
    documentId: DocumentId,
    reason: DocumentUnchangedData["reason"],
  ): Promise<void> {
    await this.#bus.publish(
      createEvent(
        "lcf.document.unchanged",
        { documentId, sourceId, reason },
        { sourceId, runId, at: this.#clock.nowMillis() },
      ),
    );
  }

  async #shouldQuarantineOnSilence(sourceId: SourceId): Promise<boolean> {
    const documents = await this.#repo.countDocuments(sourceId);
    if (documents === 0) return false;
    return (await this.#repo.emptyFullRunStreak(sourceId)) >= EMPTY_RUN_STREAK;
  }

  async #quarantine(sourceId: SourceId, reason: string, runId: RunId): Promise<void> {
    this.#plugins.quarantine(sourceId, reason);
    await this.#repo.setSourceState(sourceId, "quarantined", reason);
    await this.#bus.publish(
      createEvent(
        "lcf.source.quarantined",
        {
          sourceId,
          reason,
          errorClass: reason.split(":")[0] ?? "inconnu",
          // La quarantaine suspend, elle ne detruit rien : le nombre de
          // documents conserves figure dans l'evenement pour le rappeler.
          documentsPreserved: await this.#repo.countDocuments(sourceId),
        },
        { sourceId, runId, at: this.#clock.nowMillis() },
      ),
    );
  }
}

/**
 * Les indices de fraicheur signalent-ils un changement ?
 *
 * Un indice present et DIFFERENT est le seul signal positif de changement. Un
 * indice absent des deux cotes ne dit rien — et « rien » ne justifie pas de
 * retelecharger : c'est le balayage complet qui tranchera. La taille annoncee
 * par la source n'est deliberement pas comparee : elle est souvent arrondie, et
 * produirait des faux positifs a chaque passe.
 */
function compareFreshness(
  ref: DocumentRef,
  known: DocumentVersion,
): "changed" | "etag_match" | "not_modified" | "incremental_skip" {
  if (ref.etag !== undefined && known.httpEtag !== undefined) {
    return ref.etag === known.httpEtag ? "etag_match" : "changed";
  }
  if (ref.lastModified !== undefined && known.httpLastModified !== undefined) {
    return ref.lastModified === known.httpLastModified ? "not_modified" : "changed";
  }
  // Aucun indice comparable : la source ne dit rien, on ne suppose rien.
  return "incremental_skip";
}

function scopeOf(error: LcfError): ErrorScope {
  return error.scope;
}

function exceedsFailureRatio(outcomes: readonly boolean[]): boolean {
  if (outcomes.length < FAILURE_WINDOW) return false;
  const window = outcomes.slice(-FAILURE_WINDOW);
  const failures = window.filter((success) => !success).length;
  return failures / window.length > FAILURE_RATIO;
}

/** Erreur d'orchestration : porte sur la source, sans imputation au plugin. */
class LcfErrorLike extends LcfError {
  public override readonly retryable = false;
  public override readonly scope: ErrorScope = "source";

  constructor(message: string) {
    super(message);
  }
}

export { LcfErrorLike as OrchestrationError };
