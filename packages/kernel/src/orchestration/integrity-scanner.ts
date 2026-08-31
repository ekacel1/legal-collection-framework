/**
 * Verificateur d'integrite de fond — Volume IV, chapitre 7.
 *
 * Il verifie par lots, sans jamais saturer les E/S, en priorisant les objets
 * les plus anciennement verifies. Un objet corrompu n'est JAMAIS supprime : il
 * est marque. Un fichier corrompu contient encore de l'information ; sa
 * suppression n'en contient aucune.
 */
import { toIsoTimestamp } from "../domain/ids.js";
import type { Clock, Logger } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import { SilentLogger } from "../observability/logger.js";
import type { ContentHash } from "../domain/ids.js";
import type {
  ContentObject,
  IntegrityCheck,
  IntegrityResult,
  VerifyStatus,
} from "../domain/model.js";
import { createEvent, type EventBus } from "../events/event-bus.js";
import type { DocumentRepository } from "../db/repository.js";
import type { ContentStore } from "../storage/content-store.js";

export interface ScanOptions {
  readonly batchSize?: number;
  /** Pause entre deux lots : la verification ne concurrence jamais la collecte. */
  readonly throttleMs?: number;
}

export interface ScanReport {
  readonly checked: number;
  readonly ok: number;
  readonly anomalies: readonly IntegrityCheck[];
  readonly durationMs: number;
}

export interface FullScanOptions {
  /** Taille des lots. La verification ne doit jamais saturer les E/S. */
  readonly batchSize?: number;
  readonly throttleMs?: number;
  /** Signale les objets presents sur disque mais absents de l'index. */
  readonly detectOrphans?: boolean;
}

export interface FullScanReport {
  readonly objects: number;
  readonly bytes: number;
  readonly checked: number;
  readonly counts: Readonly<Record<IntegrityResult, number>>;
  readonly anomalies: readonly IntegrityCheck[];
  /**
   * Objets trouves dans le magasin mais inconnus de l'index.
   * Ce ne sont pas des erreurs : ce sont les traces d'une ecriture interrompue
   * entre E7 et E10, ou d'une base perdue. Ils sont signales, jamais supprimes,
   * et `lcf reindex` les reintegre.
   */
  readonly unindexed: readonly ContentHash[];
  readonly durationMs: number;
}

export interface IntegrityScannerOptions {
  readonly repository: DocumentRepository;
  readonly store: ContentStore;
  readonly bus: EventBus;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

const STATUS_OF: Record<IntegrityResult, VerifyStatus> = {
  ok: "ok",
  hash_mismatch: "corrupt",
  size_mismatch: "corrupt",
  unreadable: "corrupt",
  missing_file: "missing",
};

export class IntegrityScanner {
  readonly #repo: DocumentRepository;
  readonly #store: ContentStore;
  readonly #bus: EventBus;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(options: IntegrityScannerOptions) {
    this.#repo = options.repository;
    this.#store = options.store;
    this.#bus = options.bus;
    this.#clock = options.clock ?? new SystemClock();
    this.#logger = options.logger ?? new SilentLogger();
  }

  async scan(options: ScanOptions = {}): Promise<ScanReport> {
    const startedAt = this.#clock.nowMillis();
    const batch = await this.#repo.oldestUnverified(options.batchSize ?? 100);
    const anomalies: IntegrityCheck[] = [];
    let ok = 0;

    for (const object of batch) {
      const check = await this.#verifyAndRecord(object.contentHash);
      if (check.result === "ok") ok++;
      else anomalies.push(check);
      if (options.throttleMs !== undefined) await this.#clock.sleep(options.throttleMs);
    }

    return {
      checked: batch.length,
      ok,
      anomalies,
      durationMs: this.#clock.nowMillis() - startedAt,
    };
  }

  /**
   * Verification integrale du magasin — Volume IV, 7.4.
   *
   * Parcourt tous les objets de l'index, par lots, en respectant une pause
   * entre chaque lot. Aucun fichier n'est jamais supprime : un objet corrompu
   * contient encore de l'information, sa suppression n'en contiendrait aucune.
   */
  async scanAll(options: FullScanOptions = {}): Promise<FullScanReport> {
    const startedAt = this.#clock.nowMillis();
    const batchSize = options.batchSize ?? 500;
    const { objects, bytes } = await this.#repo.countContentObjects();

    const counts: Record<IntegrityResult, number> = {
      ok: 0,
      hash_mismatch: 0,
      missing_file: 0,
      size_mismatch: 0,
      unreadable: 0,
    };
    const anomalies: IntegrityCheck[] = [];
    const indexed = new Set<string>();

    let cursor: ContentHash | null = null;
    let checked = 0;

    for (;;) {
      const batch: ContentObject[] = await this.#repo.listContentObjects(cursor, batchSize);
      if (batch.length === 0) break;

      for (const object of batch) {
        indexed.add(object.contentHash);
        const check = await this.#verifyAndRecord(object.contentHash);
        counts[check.result]++;
        checked++;
        if (check.result !== "ok") anomalies.push(check);
      }

      cursor = batch[batch.length - 1]?.contentHash ?? null;
      if (options.throttleMs !== undefined) await this.#clock.sleep(options.throttleMs);
    }

    const unindexed = options.detectOrphans === false ? [] : await this.#findUnindexed(indexed);

    const report: FullScanReport = {
      objects,
      bytes,
      checked,
      counts,
      anomalies,
      unindexed,
      durationMs: this.#clock.nowMillis() - startedAt,
    };
    this.#logger.info("verification integrale terminee", {
      checked,
      anomalies: anomalies.length,
      unindexed: unindexed.length,
    });
    return report;
  }

  /**
   * Objets du magasin absents de l'index. Le magasin fait foi : c'est lui qui
   * porte les octets, la base n'est qu'un cache reconstructible (invariant I-4).
   */
  async #findUnindexed(indexed: ReadonlySet<string>): Promise<ContentHash[]> {
    const orphans: ContentHash[] = [];
    for await (const scanned of this.#store.scan()) {
      const hash = scanned.descriptor.contentHash;
      if (!indexed.has(hash) && scanned.bytesPresent) orphans.push(hash);
    }
    return orphans;
  }

  async #verifyAndRecord(contentHash: ContentHash): Promise<IntegrityCheck> {
    const check = await this.#store.verify(contentHash);
    await this.#repo.recordIntegrityCheck(check);
    await this.#repo.setVerifyStatus(contentHash, STATUS_OF[check.result], check.checkedAt);

    if (check.result !== "ok") {
      const affected = await this.#repo.documentsFor(contentHash);
      await this.#bus.publish(
        createEvent(
          "lcf.integrity.violation",
          { contentHash, result: check.result, affectedDocuments: affected },
          { at: this.#clock.nowMillis() },
        ),
      );
      this.#logger.error("anomalie d'integrite", {
        contentHash,
        result: check.result,
        affectedDocuments: affected.length,
      });
    }
    return check;
  }

  /** Verification d'un objet precis, a la demande. */
  async verifyOne(contentHash: IntegrityCheck["contentHash"]): Promise<IntegrityCheck> {
    const check = await this.#store.verify(contentHash);
    await this.#repo.recordIntegrityCheck(check);
    await this.#repo.setVerifyStatus(contentHash, STATUS_OF[check.result], check.checkedAt);
    return check;
  }

  /** Horodatage courant, expose pour les rapports d'exploitation. */
  now(): string {
    return toIsoTimestamp(this.#clock.now());
  }
}
