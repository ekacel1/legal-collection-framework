/**
 * Reindexation depuis le magasin — Volume IV, 1.1 et 9.2 (scenario A).
 *
 * C'est ce service qui rend l'invariant I-4 verifiable plutot que declaratif :
 * si la base d'index disparait entierement, le corpus reste exploitable, car
 * chaque objet porte son descripteur. La base redevient ce qu'elle n'aurait
 * jamais du cesser d'etre — un cache reconstructible.
 *
 * Aucun octet n'est relu depuis le reseau : la reindexation ne connait meme pas
 * l'existence du reseau.
 */
import { toIsoTimestamp, type ContentHash, type DocumentId, type IsoTimestamp } from "../domain/ids.js";
import type { Clock, Logger } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import { SilentLogger } from "../observability/logger.js";
import type { SqlDriver } from "../db/sql-driver.js";
import type { ContentStore } from "../storage/content-store.js";
import { isTombstone, type ObjectDescriptor, type ObjectReference } from "../storage/descriptor.js";
import { canonicalStringify } from "../util/canonical-json.js";

export interface ReindexReport {
  readonly objects: number;
  readonly documents: number;
  readonly versions: number;
  readonly tombstones: number;
  readonly missingBytes: readonly ContentHash[];
  readonly durationMs: number;
}

export interface ReindexOptions {
  readonly driver: SqlDriver;
  readonly store: ContentStore;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Plugin declare pour les sources reconstruites depuis le magasin seul. */
  readonly placeholderPluginId?: string;
}

/**
 * Reconstruit l'index a partir des seuls descripteurs.
 *
 * Les entites absentes du magasin — sources, executions — sont recreees sous
 * forme de traces minimales : leur absence casserait les cles etrangeres, et
 * inventer une source complete serait mentir. Une source reconstruite porte
 * donc un plugin explicitement nomme `reindex:unknown`.
 */
export async function reindexFromStore(options: ReindexOptions): Promise<ReindexReport> {
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? new SilentLogger();
  const startedAt = clock.nowMillis();
  const placeholder = options.placeholderPluginId ?? "reindex:unknown";

  const knownSources = new Set<string>();
  const knownRuns = new Set<string>();
  const documents = new Map<DocumentId, DocumentAccumulator>();
  const missingBytes: ContentHash[] = [];
  let objects = 0;
  let versions = 0;
  let tombstones = 0;

  for await (const scanned of options.store.scan()) {
    if (isTombstone(scanned.descriptor)) {
      tombstones++;
      continue;
    }
    const descriptor: ObjectDescriptor = scanned.descriptor;
    objects++;
    if (!scanned.bytesPresent) missingBytes.push(descriptor.contentHash);

    await options.driver.run(
      `INSERT OR IGNORE INTO content_objects
         (content_hash, byte_size, mime_type, detected_mime, storage_path, compression,
          stored_at, verify_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        descriptor.contentHash,
        descriptor.byteSize,
        descriptor.mimeType,
        descriptor.detectedMime ?? null,
        scanned.descriptorPath.replace(/\.json$/, suffixFor(descriptor)),
        descriptor.compression,
        descriptor.storedAt,
        scanned.bytesPresent ? "unverified" : "missing",
      ],
    );

    for (const reference of descriptor.references) {
      versions++;
      await ensureSource(options.driver, knownSources, reference, placeholder, clock);
      await ensureRun(options.driver, knownRuns, reference);
      accumulate(documents, reference);
      // Ligne provisoire : une version ne peut referencer un document absent.
      // Les agregats (version courante, comptage, dates) sont corriges plus bas,
      // une fois toutes les versions connues.
      await ensureDocument(options.driver, reference);

      await options.driver.run(
        `INSERT OR IGNORE INTO document_versions
           (document_id, version_no, content_hash, fetched_at, fetched_from_url,
            http_etag, http_last_modified, run_id, change_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reference.documentId,
          reference.versionNo,
          descriptor.contentHash,
          reference.fetchedAt,
          reference.fetchedFromUrl ?? null,
          reference.httpEtag ?? null,
          reference.httpLastModified ?? null,
          reference.runId,
          reference.changeReason,
        ],
      );

      if (reference.metadata !== undefined) {
        await options.driver.run(
          `INSERT OR IGNORE INTO document_metadata
             (document_id, version_no, raw_json, common_json, provenance_json,
              extracted_at, extractor_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            reference.documentId,
            reference.versionNo,
            canonicalStringify(reference.metadata.raw),
            reference.metadata.common === undefined
              ? null
              : canonicalStringify(reference.metadata.common),
            canonicalStringify(reference.metadata.provenance),
            reference.fetchedAt,
            "reindex/1",
          ],
        );
      }
    }
  }

  // Correction des agregats : `current_version` doit valoir le maximum reel,
  // pas la derniere version lue — l'ordre de parcours du magasin est arbitraire.
  for (const [documentId, accumulator] of documents) {
    await options.driver.run(
      `UPDATE documents
          SET canonical_url = ?, current_version = ?, version_count = ?, status = 'stored',
              first_discovered_at = ?, last_seen_at = ?, last_changed_at = ?
        WHERE document_id = ?`,
      [
        accumulator.canonicalUrl ?? null,
        accumulator.currentVersion,
        accumulator.versionCount,
        accumulator.firstSeen,
        accumulator.lastSeen,
        accumulator.lastSeen,
        documentId,
      ],
    );
  }

  // ref_count est recompte, jamais deduit du nombre de references lues.
  await options.driver.run(
    `UPDATE content_objects
        SET ref_count = (SELECT COUNT(*) FROM document_versions v
                          WHERE v.content_hash = content_objects.content_hash)`,
  );

  const report: ReindexReport = {
    objects,
    documents: documents.size,
    versions,
    tombstones,
    missingBytes,
    durationMs: clock.nowMillis() - startedAt,
  };
  logger.info("reindexation terminee", { ...report, missingBytes: missingBytes.length });
  return report;
}

interface DocumentAccumulator {
  sourceId: string;
  nativeId: string;
  canonicalUrl?: string;
  currentVersion: number;
  versionCount: number;
  firstSeen: IsoTimestamp;
  lastSeen: IsoTimestamp;
  discoveryRunId: string;
}

function accumulate(
  documents: Map<DocumentId, DocumentAccumulator>,
  reference: ObjectReference,
): void {
  const existing = documents.get(reference.documentId);
  if (existing === undefined) {
    documents.set(reference.documentId, {
      sourceId: reference.sourceId,
      nativeId: reference.nativeId,
      ...(reference.fetchedFromUrl === undefined
        ? {}
        : { canonicalUrl: reference.fetchedFromUrl }),
      currentVersion: reference.versionNo,
      versionCount: 1,
      firstSeen: reference.fetchedAt,
      lastSeen: reference.fetchedAt,
      discoveryRunId: reference.runId,
    });
    return;
  }
  existing.versionCount++;
  if (reference.versionNo > existing.currentVersion) {
    existing.currentVersion = reference.versionNo;
    if (reference.fetchedFromUrl !== undefined) existing.canonicalUrl = reference.fetchedFromUrl;
  }
  if (reference.fetchedAt < existing.firstSeen) existing.firstSeen = reference.fetchedAt;
  if (reference.fetchedAt > existing.lastSeen) existing.lastSeen = reference.fetchedAt;
}

async function ensureSource(
  driver: SqlDriver,
  known: Set<string>,
  reference: ObjectReference,
  placeholder: string,
  clock: Clock,
): Promise<void> {
  if (known.has(reference.sourceId)) return;
  known.add(reference.sourceId);
  const now = toIsoTimestamp(clock.now());
  await driver.run(
    `INSERT OR IGNORE INTO sources
       (source_id, plugin_id, plugin_version, api_version, display_name, config_json,
        config_hash, state, first_seen_at, created_at, updated_at)
     VALUES (?, ?, '0.0.0', '1.0', ?, '{}', 'sha256:reindexed', 'ready', ?, ?, ?)`,
    [reference.sourceId, placeholder, reference.sourceId, reference.fetchedAt, now, now],
  );
}

async function ensureRun(
  driver: SqlDriver,
  known: Set<string>,
  reference: ObjectReference,
): Promise<void> {
  if (known.has(reference.runId)) return;
  known.add(reference.runId);
  await driver.run(
    `INSERT OR IGNORE INTO runs (run_id, source_id, mode, trigger, started_at, ended_at, status)
     VALUES (?, ?, 'repair', 'manual', ?, ?, 'completed')`,
    [reference.runId, reference.sourceId, reference.fetchedAt, reference.fetchedAt],
  );
}

async function ensureDocument(driver: SqlDriver, reference: ObjectReference): Promise<void> {
  await driver.run(
    `INSERT OR IGNORE INTO documents
       (document_id, source_id, native_id, canonical_url, current_version, version_count,
        status, first_discovered_at, last_seen_at, discovery_run_id)
     VALUES (?, ?, ?, ?, 0, 0, 'discovered', ?, ?, ?)`,
    [
      reference.documentId,
      reference.sourceId,
      reference.nativeId,
      reference.fetchedFromUrl ?? null,
      reference.fetchedAt,
      reference.fetchedAt,
      reference.runId,
    ],
  );
}

function suffixFor(descriptor: ObjectDescriptor): string {
  switch (descriptor.compression) {
    case "zstd":
      return ".bin.zst";
    case "gzip":
      return ".bin.gz";
    default:
      return ".bin";
  }
}
