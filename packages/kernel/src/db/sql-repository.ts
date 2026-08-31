/**
 * Depot relationnel — Volume IV, chapitres 5.1 (etape E10) et 11.
 *
 * Toute ecriture du corpus passe par ici, et toute ecriture du corpus est
 * transactionnelle. Le fichier est deja ecrit et synchronise quand cette
 * couche intervient : c'est ce qui garantit qu'aucune panne ne produit une
 * ligne d'index pointant vers un fichier absent.
 */
import { createHash } from "node:crypto";

import { StorageError } from "../domain/errors.js";
import { toIsoTimestamp, type ContentHash, type DocumentId, type IsoTimestamp, type RunId, type SourceId } from "../domain/ids.js";
import type { Clock } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import type {
  ContentObject,
  DocumentEntity,
  DocumentQuery,
  DocumentSummary,
  DocumentVersion,
  IntegrityCheck,
  Page,
  Run,
  Source,
  SourceState,
  VerifyStatus,
} from "../domain/model.js";
import { canonicalStringify } from "../util/canonical-json.js";
import type { SqlDriver, SqlExecutor, SqlValue } from "./sql-driver.js";
import { syntaxFor, type SqlSyntax } from "./sql-driver.js";
import type {
  AttemptRecord,
  CommitResult,
  DiscoveryRecord,
  DocumentCommit,
  DocumentRepository,
  RunClose,
  RunStart,
  SourceRegistration,
} from "./repository.js";

/** Version de l'extracteur de metadonnees natives, journalisee par version. */
export const NATIVE_EXTRACTOR_VERSION = "native/1";

export interface SqlDocumentRepositoryOptions {
  readonly clock?: Clock;
}

export class SqlDocumentRepository implements DocumentRepository {
  readonly #exec: SqlExecutor;
  /** Absent lorsque le depot est deja lie a une transaction en cours. */
  readonly #driver: SqlDriver | null;
  readonly #clock: Clock;
  readonly #sql: SqlSyntax;

  constructor(
    driver: SqlDriver,
    options: SqlDocumentRepositoryOptions = {},
    executor?: SqlExecutor,
  ) {
    this.#driver = executor === undefined ? driver : null;
    this.#exec = executor ?? driver;
    this.#clock = options.clock ?? new SystemClock();
    this.#sql = syntaxFor(driver.dialect);
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  async registerSource(registration: SourceRegistration): Promise<Source> {
    const now = toIsoTimestamp(this.#clock.now());
    const configJson = canonicalStringify(registration.config);
    const configHash = `sha256:${createHash("sha256").update(configJson, "utf8").digest("hex")}`;
    const existing = await this.getSource(registration.sourceId);

    if (existing === null) {
      await this.#exec.run(
        `INSERT INTO sources (source_id, plugin_id, plugin_version, api_version, display_name,
                              config_json, config_hash, state, first_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
        [
          registration.sourceId,
          registration.pluginId,
          registration.pluginVersion,
          registration.apiVersion,
          registration.displayName,
          configJson,
          configHash,
          now,
          now,
          now,
        ],
      );
    } else {
      // Une reconfiguration ne remet jamais une source en quarantaine ni ne
      // l'en sort : la levee de quarantaine reste une action d'exploitation
      // explicite (Vol. III, 6.2).
      await this.#exec.run(
        `UPDATE sources
            SET plugin_id = ?, plugin_version = ?, api_version = ?, display_name = ?,
                config_json = ?, config_hash = ?, updated_at = ?
          WHERE source_id = ?`,
        [
          registration.pluginId,
          registration.pluginVersion,
          registration.apiVersion,
          registration.displayName,
          configJson,
          configHash,
          now,
          registration.sourceId,
        ],
      );
    }

    const source = await this.getSource(registration.sourceId);
    if (source === null) throw new StorageError("source introuvable apres enregistrement");
    return source;
  }

  async getSource(sourceId: SourceId): Promise<Source | null> {
    const row = await this.#exec.get("SELECT * FROM sources WHERE source_id = ?", [sourceId]);
    return row === undefined ? null : mapSource(row);
  }

  async listSources(): Promise<Source[]> {
    const rows = await this.#exec.all("SELECT * FROM sources ORDER BY source_id");
    return rows.map(mapSource);
  }

  async setSourceState(sourceId: SourceId, state: SourceState, reason?: string): Promise<void> {
    const now = toIsoTimestamp(this.#clock.now());
    await this.#exec.run(
      `UPDATE sources
          SET state = ?, quarantine_reason = ?, quarantined_at = ?, updated_at = ?
        WHERE source_id = ?`,
      [
        state,
        state === "quarantined" ? (reason ?? "non precise") : null,
        state === "quarantined" ? now : null,
        now,
        sourceId,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Executions
  // -------------------------------------------------------------------------

  async startRun(start: RunStart): Promise<Run> {
    await this.#exec.run(
      `INSERT INTO runs (run_id, source_id, mode, trigger, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
      [start.runId, start.sourceId, start.mode, start.trigger, start.startedAt],
    );
    await this.#exec.run("UPDATE sources SET last_run_at = ?, updated_at = ? WHERE source_id = ?", [
      start.startedAt,
      start.startedAt,
      start.sourceId,
    ]);
    const run = await this.getRun(start.runId);
    if (run === null) throw new StorageError("execution introuvable apres creation");
    return run;
  }

  async closeRun(close: RunClose): Promise<void> {
    await this.#exec.run(
      `UPDATE runs
          SET status = ?, ended_at = ?, docs_discovered = ?, docs_new = ?, docs_updated = ?,
              docs_unchanged = ?, docs_failed = ?, bytes_downloaded = ?, requests_made = ?,
              error_summary = ?, checkpoint_json = ?
        WHERE run_id = ?`,
      [
        close.status,
        close.endedAt,
        close.counters.docsDiscovered,
        close.counters.docsNew,
        close.counters.docsUpdated,
        close.counters.docsUnchanged,
        close.counters.docsFailed,
        close.counters.bytesDownloaded,
        close.counters.requestsMade,
        close.errorSummary ?? null,
        close.checkpointJson ?? null,
        close.runId,
      ],
    );
    if (close.status === "completed") {
      await this.#exec.run(
        `UPDATE sources SET last_success_at = ?, updated_at = ?
          WHERE source_id = (SELECT source_id FROM runs WHERE run_id = ?)`,
        [close.endedAt, close.endedAt, close.runId],
      );
    }
  }

  async getRun(runId: RunId): Promise<Run | null> {
    const row = await this.#exec.get("SELECT * FROM runs WHERE run_id = ?", [runId]);
    return row === undefined ? null : mapRun(row);
  }

  async failStaleRuns(startedBefore: IsoTimestamp, endedAt: IsoTimestamp): Promise<number> {
    const result = await this.#exec.run(
      `UPDATE runs
          SET status = 'failed', ended_at = ?, error_summary = 'execution interrompue'
        WHERE status = 'running' AND started_at < ?`,
      [endedAt, startedBefore],
    );
    return result.changes;
  }

  async listRuns(sourceId: SourceId, limit = 20): Promise<Run[]> {
    const rows = await this.#exec.all(
      "SELECT * FROM runs WHERE source_id = ? ORDER BY started_at DESC LIMIT ?",
      [sourceId, limit],
    );
    return rows.map(mapRun);
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  async recordDiscovery(record: DiscoveryRecord): Promise<{ isNewDocument: boolean }> {
    const existing = await this.getDocument(record.documentId);
    if (existing === null) {
      await this.#exec.run(
        `INSERT INTO documents (document_id, source_id, native_id, canonical_url, status,
                                first_discovered_at, last_seen_at, discovery_run_id)
         VALUES (?, ?, ?, ?, 'discovered', ?, ?, ?)`,
        [
          record.documentId,
          record.sourceId,
          record.nativeId,
          record.canonicalUrl ?? null,
          record.seenAt,
          record.seenAt,
          record.runId,
        ],
      );
      return { isNewDocument: true };
    }

    // Un document reapparu apres retrait redevient simplement visible : le
    // statut `withdrawn` decrit un constat, pas une decision definitive.
    await this.#exec.run(
      `UPDATE documents
          SET last_seen_at = ?,
              canonical_url = COALESCE(?, canonical_url),
              status = CASE WHEN status = 'withdrawn' THEN 'stored' ELSE status END,
              withdrawn_at = CASE WHEN status = 'withdrawn' THEN NULL ELSE withdrawn_at END
        WHERE document_id = ?`,
      [record.seenAt, record.canonicalUrl ?? null, record.documentId],
    );
    return { isNewDocument: false };
  }

  async findByNativeId(sourceId: SourceId, nativeId: string): Promise<DocumentEntity | null> {
    const row = await this.#exec.get(
      "SELECT * FROM documents WHERE source_id = ? AND native_id = ?",
      [sourceId, nativeId],
    );
    return row === undefined ? null : mapDocument(row);
  }

  async getDocument(documentId: DocumentId): Promise<DocumentEntity | null> {
    const row = await this.#exec.get("SELECT * FROM documents WHERE document_id = ?", [documentId]);
    return row === undefined ? null : mapDocument(row);
  }

  async currentVersion(documentId: DocumentId): Promise<DocumentVersion | null> {
    const row = await this.#exec.get(
      `SELECT v.* FROM document_versions v
         JOIN documents d ON d.document_id = v.document_id
                         AND d.current_version = v.version_no
        WHERE v.document_id = ?`,
      [documentId],
    );
    return row === undefined ? null : mapVersion(row);
  }

  async listVersions(documentId: DocumentId): Promise<DocumentVersion[]> {
    const rows = await this.#exec.all(
      "SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_no",
      [documentId],
    );
    return rows.map(mapVersion);
  }

  /**
   * Pagination par curseur opaque exclusivement — ADR-304.
   * L'ordre est celui de l'identifiant : stable pendant que le corpus grandit,
   * ce qu'aucun tri par date ne garantit.
   */
  async query(q: DocumentQuery): Promise<Page<DocumentSummary>> {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (q.sourceId !== undefined) {
      where.push("source_id = ?");
      params.push(q.sourceId);
    }
    if (q.status !== undefined) {
      where.push("status = ?");
      params.push(q.status);
    }
    if (q.changedSince !== undefined) {
      where.push("fetched_at > ?");
      params.push(q.changedSince);
    }
    if (q.cursor !== undefined && q.cursor !== null) {
      where.push("document_id > ?");
      params.push(decodeCursor(q.cursor));
    }

    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const rows = await this.#exec.all(
      `SELECT * FROM v_current_documents ${clause} ORDER BY document_id LIMIT ?`,
      [...params, limit + 1],
    );

    const page = rows.slice(0, limit).map(mapSummary);
    const nextCursor =
      rows.length > limit && page.length > 0
        ? encodeCursor(String(page[page.length - 1]?.documentId))
        : null;
    return { items: page, nextCursor };
  }

  /**
   * Etape E10 du protocole d'ecriture — Volume IV, 5.1.
   * Sept ecritures, une transaction, aucun etat intermediaire observable.
   */
  async commitDocument(commit: DocumentCommit): Promise<CommitResult> {
    if (this.#driver !== null) {
      return this.#driver.transaction(async (tx) =>
        new SqlDocumentRepository(this.#driver as SqlDriver, { clock: this.#clock }, tx)
          .commitDocument(commit),
      );
    }
    return this.#commitInTransaction(commit);
  }

  async #commitInTransaction(commit: DocumentCommit): Promise<CommitResult> {
    const { stored } = commit;

    // Rejouer exactement la meme version ne doit rien creer (idempotence).
    const already = await this.#exec.get(
      "SELECT content_hash FROM document_versions WHERE document_id = ? AND version_no = ?",
      [commit.documentId, commit.versionNo],
    );
    if (already !== undefined) {
      if (already["content_hash"] !== stored.contentHash) {
        throw new StorageError(
          "conflit de version : une empreinte differente est deja enregistree",
          {
            context: {
              documentId: commit.documentId,
              versionNo: commit.versionNo,
              existing: String(already["content_hash"]),
              incoming: stored.contentHash,
            },
          },
        );
      }
      return {
        documentId: commit.documentId,
        versionNo: commit.versionNo,
        isNewDocument: false,
        isNewVersion: false,
      };
    }

    // Le document peut ne pas exister si la decouverte et la collecte sont
    // dissociees : on le cree ici plutot que d'echouer sur une cle etrangere.
    const existingDocument = await this.getDocument(commit.documentId);
    const isNewDocument = existingDocument === null;
    if (isNewDocument) {
      await this.#exec.run(
        `INSERT INTO documents (document_id, source_id, native_id, canonical_url, status,
                                first_discovered_at, last_seen_at, discovery_run_id)
         VALUES (?, ?, ?, ?, 'discovered', ?, ?, ?)`,
        [
          commit.documentId,
          commit.sourceId,
          commit.nativeId,
          commit.canonicalUrl ?? null,
          commit.fetchedAt,
          commit.fetchedAt,
          commit.runId,
        ],
      );
    }

    // 1. INSERT OR IGNORE content_objects — les octets sont deja sur disque.
    await this.#exec.run(
      this.#sql.insertIgnore("content_objects", [
        "content_hash",
        "byte_size",
        "mime_type",
        "detected_mime",
        "storage_path",
        "compression",
        "stored_at",
        "verify_status",
      ]),
      [
        stored.contentHash,
        stored.byteSize,
        stored.mimeType,
        stored.detectedMime ?? null,
        stored.storagePath,
        stored.compression,
        stored.storedAt,
        "ok",
      ],
    );

    // 2. INSERT document_versions
    await this.#exec.run(
      `INSERT INTO document_versions (document_id, version_no, content_hash, fetched_at,
                                      fetched_from_url, http_etag, http_last_modified,
                                      run_id, change_reason, supersedes_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        commit.documentId,
        commit.versionNo,
        stored.contentHash,
        commit.fetchedAt,
        commit.fetchedFromUrl ?? null,
        commit.httpEtag ?? null,
        commit.httpLastModified ?? null,
        commit.runId,
        commit.changeReason,
        commit.supersedesVersion ?? null,
      ],
    );

    // 3. INSERT document_metadata — par version, jamais ecrasees.
    if (commit.metadata !== undefined) {
      await this.#exec.run(
        `INSERT INTO document_metadata (document_id, version_no, raw_json, common_json,
                                        provenance_json, extracted_at, extractor_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          commit.documentId,
          commit.versionNo,
          canonicalStringify(commit.metadata.raw),
          commit.metadata.common === undefined ? null : canonicalStringify(commit.metadata.common),
          canonicalStringify(commit.metadata.provenance),
          commit.fetchedAt,
          commit.extractorVersion ?? NATIVE_EXTRACTOR_VERSION,
        ],
      );
    }

    // 4. UPDATE documents — version courante, comptage, dates.
    await this.#exec.run(
      `UPDATE documents
          SET current_version = ?, version_count = version_count + 1, status = 'stored',
              last_seen_at = ?, last_changed_at = ?, withdrawn_at = NULL,
              canonical_url = COALESCE(?, canonical_url)
        WHERE document_id = ?`,
      [
        commit.versionNo,
        commit.fetchedAt,
        commit.fetchedAt,
        commit.canonicalUrl ?? null,
        commit.documentId,
      ],
    );

    // 5. UPDATE content_objects.ref_count — recompte reel, jamais increment.
    await this.recountReferences(stored.contentHash);

    // 6. INSERT fetch_attempts
    if (commit.attempt !== undefined) {
      await this.recordAttempt(commit.runId, commit.documentId, commit.attempt);
    }

    // 7. UPDATE runs — compteurs de l'execution.
    await this.#exec.run(
      `UPDATE runs
          SET docs_new = docs_new + ?, docs_updated = docs_updated + ?,
              bytes_downloaded = bytes_downloaded + ?
        WHERE run_id = ?`,
      [
        commit.versionNo === 1 ? 1 : 0,
        commit.versionNo === 1 ? 0 : 1,
        stored.deduplicated ? 0 : stored.byteSize,
        commit.runId,
      ],
    );

    return {
      documentId: commit.documentId,
      versionNo: commit.versionNo,
      isNewDocument,
      isNewVersion: true,
    };
  }

  async touchDocument(documentId: DocumentId, seenAt: IsoTimestamp): Promise<void> {
    await this.#exec.run("UPDATE documents SET last_seen_at = ? WHERE document_id = ?", [
      seenAt,
      documentId,
    ]);
  }

  async markDocumentFailed(documentId: DocumentId, seenAt: IsoTimestamp): Promise<void> {
    // Un document deja stocke ne redevient jamais `failed` : son contenu reste
    // valide, seule la derniere tentative a echoue.
    await this.#exec.run(
      `UPDATE documents
          SET status = CASE WHEN status = 'stored' THEN 'stored' ELSE 'failed' END,
              last_seen_at = ?
        WHERE document_id = ?`,
      [seenAt, documentId],
    );
  }

  async markDocumentWithdrawn(documentId: DocumentId, withdrawnAt: IsoTimestamp): Promise<void> {
    await this.#exec.run(
      "UPDATE documents SET status = 'withdrawn', withdrawn_at = ? WHERE document_id = ?",
      [withdrawnAt, documentId],
    );
  }

  /**
   * Le seuil compte les balayages COMPLETS termines depuis la derniere vue du
   * document. Trois balayages consecutifs eliminent la quasi-totalite des faux
   * positifs dus a une panne temporaire ou a une refonte de site.
   */
  async withdrawUnseen(
    sourceId: SourceId,
    missedSweeps: number,
    at: IsoTimestamp,
  ): Promise<DocumentId[]> {
    const rows = await this.#exec.all<{ document_id: string }>(
      `SELECT d.document_id FROM documents d
        WHERE d.source_id = ?
          AND d.status <> 'withdrawn'
          AND (SELECT COUNT(*) FROM runs r
                WHERE r.source_id = d.source_id
                  AND r.mode = 'full'
                  AND r.status = 'completed'
                  -- Seul un balayage MENE A SON TERME peut constater une
                  -- absence. Un balayage tronque n'a pas vu le document : il
                  -- ne peut pas temoigner de sa disparition.
                  AND r.error_summary IS NULL
                  AND r.started_at > d.last_seen_at) >= ?`,
      [sourceId, missedSweeps],
    );

    const withdrawn: DocumentId[] = [];
    for (const row of rows) {
      const documentId = row.document_id as DocumentId;
      await this.markDocumentWithdrawn(documentId, at);
      withdrawn.push(documentId);
    }
    return withdrawn;
  }

  /**
   * Une source qui ne renvoie plus rien est le mode de panne le plus frequent
   * d'un collecteur : une refonte de site ne produit aucune erreur HTTP, elle
   * produit zero resultat (Vol. III, 6.3).
   */
  async emptyFullRunStreak(sourceId: SourceId): Promise<number> {
    const rows = await this.#exec.all<{ docs_discovered: number }>(
      `SELECT docs_discovered FROM runs
        WHERE source_id = ? AND mode = 'full' AND status = 'completed'
        ORDER BY started_at DESC LIMIT 10`,
      [sourceId],
    );
    let streak = 0;
    for (const row of rows) {
      if (Number(row.docs_discovered) > 0) break;
      streak++;
    }
    return streak;
  }

  async lastCheckpoint(sourceId: SourceId): Promise<string | null> {
    const row = await this.#exec.get<{ checkpoint_json: string | null }>(
      `SELECT checkpoint_json FROM runs
        WHERE source_id = ? AND status = 'completed' AND checkpoint_json IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
      [sourceId],
    );
    return row?.checkpoint_json ?? null;
  }

  /**
   * Dernier balayage complet mene JUSQU'AU BOUT.
   *
   * `error_summary IS NULL` n'est pas un detail : une execution arretee par le
   * budget, par une fenetre d'exclusion ou par `--max` est enregistree
   * `completed` — elle s'est bien terminee — mais elle n'a pas parcouru la
   * source. La compter reviendrait a croire la source entierement revue apres
   * en avoir vu le premier dixieme.
   */
  async lastFullSweepAt(sourceId: SourceId): Promise<IsoTimestamp | null> {
    const row = await this.#exec.get<{ ended_at: string | null }>(
      `SELECT ended_at FROM runs
        WHERE source_id = ? AND mode = 'full' AND status = 'completed'
          AND error_summary IS NULL
        ORDER BY started_at DESC LIMIT 1`,
      [sourceId],
    );
    return (row?.ended_at as IsoTimestamp | undefined) ?? null;
  }

  async countDocuments(sourceId: SourceId): Promise<number> {
    const row = await this.#exec.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM documents WHERE source_id = ?",
      [sourceId],
    );
    return Number(row?.n ?? 0);
  }

  async recordAttempt(
    runId: RunId,
    documentId: DocumentId,
    attempt: AttemptRecord,
  ): Promise<void> {
    const row = await this.#exec.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM fetch_attempts WHERE document_id = ? AND run_id = ?",
      [documentId, runId],
    );
    await this.#exec.run(
      `INSERT INTO fetch_attempts (document_id, run_id, attempt_no, url, started_at, ended_at,
                                   http_status, bytes_received, outcome, error_class, error_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        documentId,
        runId,
        Number(row?.n ?? 0) + 1,
        attempt.url ?? null,
        attempt.startedAt,
        attempt.endedAt ?? null,
        attempt.httpStatus ?? null,
        attempt.bytesReceived ?? null,
        attempt.outcome,
        attempt.errorClass ?? null,
        attempt.errorDetail ?? null,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Objets de contenu et integrite
  // -------------------------------------------------------------------------

  async getContentObject(hash: ContentHash): Promise<ContentObject | null> {
    const row = await this.#exec.get("SELECT * FROM content_objects WHERE content_hash = ?", [
      hash,
    ]);
    return row === undefined ? null : mapContentObject(row);
  }

  async recordIntegrityCheck(check: IntegrityCheck): Promise<void> {
    await this.#exec.run(
      `INSERT INTO integrity_log (content_hash, checked_at, result, expected_hash,
                                  actual_hash, action_taken)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        check.contentHash,
        check.checkedAt,
        check.result,
        check.expectedHash ?? null,
        check.actualHash ?? null,
        check.actionTaken ?? null,
      ],
    );
  }

  async setVerifyStatus(
    hash: ContentHash,
    status: VerifyStatus,
    verifiedAt: IsoTimestamp,
  ): Promise<void> {
    await this.#exec.run(
      "UPDATE content_objects SET verify_status = ?, last_verified_at = ? WHERE content_hash = ?",
      [status, verifiedAt, hash],
    );
  }

  /** Les objets les plus anciennement verifies d'abord — Volume IV, 7.2. */
  async oldestUnverified(limit: number): Promise<ContentObject[]> {
    const rows = await this.#exec.all(
      `SELECT * FROM content_objects
        ORDER BY (last_verified_at IS NOT NULL), last_verified_at ASC, stored_at ASC
        LIMIT ?`,
      [limit],
    );
    return rows.map(mapContentObject);
  }

  async listContentObjects(afterHash: ContentHash | null, limit: number): Promise<ContentObject[]> {
    const rows =
      afterHash === null
        ? await this.#exec.all("SELECT * FROM content_objects ORDER BY content_hash LIMIT ?", [
            limit,
          ])
        : await this.#exec.all(
            "SELECT * FROM content_objects WHERE content_hash > ? ORDER BY content_hash LIMIT ?",
            [afterHash, limit],
          );
    return rows.map(mapContentObject);
  }

  async countContentObjects(): Promise<{ objects: number; bytes: number }> {
    const row = await this.#exec.get<{ n: number; s: number }>(
      "SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS s FROM content_objects",
    );
    return { objects: Number(row?.n ?? 0), bytes: Number(row?.s ?? 0) };
  }

  async listFailedDocuments(sourceId: SourceId, limit: number): Promise<DocumentEntity[]> {
    const rows = await this.#exec.all(
      `SELECT * FROM documents
        WHERE source_id = ? AND status = 'failed'
        ORDER BY last_seen_at ASC LIMIT ?`,
      [sourceId, limit],
    );
    return rows.map(mapDocument);
  }

  async documentsFor(hash: ContentHash): Promise<DocumentId[]> {
    const rows = await this.#exec.all<{ document_id: string }>(
      "SELECT DISTINCT document_id FROM document_versions WHERE content_hash = ?",
      [hash],
    );
    return rows.map((row) => row.document_id as DocumentId);
  }

  /**
   * Recompte depuis `document_versions`. Sur un chemin qui peut mener a une
   * suppression, on ne fait jamais confiance a une donnee derivee : un
   * compteur qui a derive provoquerait la perte d'un objet encore reference.
   */
  async recountReferences(hash: ContentHash): Promise<number> {
    await this.#exec.run(
      `UPDATE content_objects
          SET ref_count = (SELECT COUNT(*) FROM document_versions WHERE content_hash = ?)
        WHERE content_hash = ?`,
      [hash, hash],
    );
    const row = await this.#exec.get<{ ref_count: number }>(
      "SELECT ref_count FROM content_objects WHERE content_hash = ?",
      [hash],
    );
    return Number(row?.ref_count ?? 0);
  }

  async withTransaction<T>(fn: (repo: DocumentRepository) => Promise<T>): Promise<T> {
    if (this.#driver === null) {
      // Deja dans une transaction : on y participe plutot que d'en imbriquer
      // une seconde, que SQLite ne connait pas.
      return fn(this);
    }
    const driver = this.#driver;
    return driver.transaction(async (tx) =>
      fn(new SqlDocumentRepository(driver, { clock: this.#clock }, tx)),
    );
  }
}

// ---------------------------------------------------------------------------
// Projection des lignes
// ---------------------------------------------------------------------------

function text(row: Record<string, unknown>, column: string): string {
  return String(row[column]);
}

function optionalText(row: Record<string, unknown>, column: string): string | undefined {
  const value = row[column];
  return value === null || value === undefined ? undefined : String(value);
}

function num(row: Record<string, unknown>, column: string): number {
  return Number(row[column] ?? 0);
}

/** Ajoute la propriete seulement si elle a une valeur (exactOptionalPropertyTypes). */
function opt<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function mapSource(row: Record<string, unknown>): Source {
  return {
    sourceId: text(row, "source_id") as SourceId,
    pluginId: text(row, "plugin_id"),
    pluginVersion: text(row, "plugin_version"),
    apiVersion: text(row, "api_version"),
    displayName: text(row, "display_name"),
    configJson: text(row, "config_json"),
    configHash: text(row, "config_hash"),
    state: text(row, "state") as SourceState,
    ...opt("quarantineReason", optionalText(row, "quarantine_reason")),
    ...opt("quarantinedAt", optionalText(row, "quarantined_at")),
    firstSeenAt: text(row, "first_seen_at") as IsoTimestamp,
    ...opt("lastRunAt", optionalText(row, "last_run_at")),
    ...opt("lastSuccessAt", optionalText(row, "last_success_at")),
    createdAt: text(row, "created_at") as IsoTimestamp,
    updatedAt: text(row, "updated_at") as IsoTimestamp,
  } as Source;
}

function mapRun(row: Record<string, unknown>): Run {
  return {
    runId: text(row, "run_id") as RunId,
    sourceId: text(row, "source_id") as SourceId,
    mode: text(row, "mode"),
    trigger: text(row, "trigger"),
    startedAt: text(row, "started_at") as IsoTimestamp,
    ...opt("endedAt", optionalText(row, "ended_at")),
    status: text(row, "status"),
    docsDiscovered: num(row, "docs_discovered"),
    docsNew: num(row, "docs_new"),
    docsUpdated: num(row, "docs_updated"),
    docsUnchanged: num(row, "docs_unchanged"),
    docsFailed: num(row, "docs_failed"),
    bytesDownloaded: num(row, "bytes_downloaded"),
    requestsMade: num(row, "requests_made"),
    ...opt("errorSummary", optionalText(row, "error_summary")),
    ...opt("checkpointJson", optionalText(row, "checkpoint_json")),
  } as Run;
}

function mapDocument(row: Record<string, unknown>): DocumentEntity {
  return {
    documentId: text(row, "document_id") as DocumentId,
    sourceId: text(row, "source_id") as SourceId,
    nativeId: text(row, "native_id"),
    ...opt("canonicalUrl", optionalText(row, "canonical_url")),
    currentVersion: num(row, "current_version"),
    versionCount: num(row, "version_count"),
    status: text(row, "status"),
    firstDiscoveredAt: text(row, "first_discovered_at") as IsoTimestamp,
    lastSeenAt: text(row, "last_seen_at") as IsoTimestamp,
    ...opt("lastChangedAt", optionalText(row, "last_changed_at")),
    ...opt("withdrawnAt", optionalText(row, "withdrawn_at")),
    discoveryRunId: text(row, "discovery_run_id") as RunId,
  } as DocumentEntity;
}

function mapVersion(row: Record<string, unknown>): DocumentVersion {
  return {
    documentId: text(row, "document_id") as DocumentId,
    versionNo: num(row, "version_no"),
    contentHash: text(row, "content_hash") as ContentHash,
    fetchedAt: text(row, "fetched_at") as IsoTimestamp,
    ...opt("fetchedFromUrl", optionalText(row, "fetched_from_url")),
    ...opt("httpEtag", optionalText(row, "http_etag")),
    ...opt("httpLastModified", optionalText(row, "http_last_modified")),
    runId: text(row, "run_id") as RunId,
    changeReason: text(row, "change_reason"),
    ...(row["supersedes_version"] === null || row["supersedes_version"] === undefined
      ? {}
      : { supersedesVersion: num(row, "supersedes_version") }),
  } as DocumentVersion;
}

function mapContentObject(row: Record<string, unknown>): ContentObject {
  return {
    contentHash: text(row, "content_hash") as ContentHash,
    byteSize: num(row, "byte_size"),
    mimeType: text(row, "mime_type"),
    ...opt("detectedMime", optionalText(row, "detected_mime")),
    storagePath: text(row, "storage_path"),
    compression: text(row, "compression"),
    storedAt: text(row, "stored_at") as IsoTimestamp,
    refCount: num(row, "ref_count"),
    ...opt("lastVerifiedAt", optionalText(row, "last_verified_at")),
    verifyStatus: text(row, "verify_status"),
  } as ContentObject;
}

function mapSummary(row: Record<string, unknown>): DocumentSummary {
  return {
    documentId: text(row, "document_id") as DocumentId,
    sourceId: text(row, "source_id") as SourceId,
    nativeId: text(row, "native_id"),
    ...opt("canonicalUrl", optionalText(row, "canonical_url")),
    status: text(row, "status"),
    versionNo: num(row, "version_no"),
    fetchedAt: text(row, "fetched_at") as IsoTimestamp,
    contentHash: text(row, "content_hash") as ContentHash,
    byteSize: num(row, "byte_size"),
    mimeType: text(row, "mime_type"),
    verifyStatus: text(row, "verify_status"),
  } as DocumentSummary;
}

/** Le curseur est opaque par construction : le client ne doit pas l'interpreter. */
function encodeCursor(documentId: string): string {
  return Buffer.from(`v1:${documentId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (!decoded.startsWith("v1:")) {
    throw new StorageError("curseur de pagination invalide");
  }
  return decoded.slice(3);
}
