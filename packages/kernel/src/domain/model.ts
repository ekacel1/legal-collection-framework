/**
 * Modele conceptuel du domaine — Volume IV, chapitres 2 et 3.
 *
 * La decision structurante du volume : Document, DocumentVersion et
 * ContentObject sont trois entites distinctes. Confondre le document et son
 * contenu rend impossible la reponse a la question la plus courante posee a un
 * corpus juridique : « ce texte a-t-il ete modifie, et quand ? »
 */
import type { ContentHash, DocumentId, IsoTimestamp, RunId, SourceId } from "./ids.js";
import type { SourceMetadata } from "./contract.js";

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export type SourceState = "ready" | "active" | "quarantined" | "disabled";

export interface Source {
  readonly sourceId: SourceId;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly apiVersion: string;
  readonly displayName: string;
  readonly configJson: string;
  readonly configHash: string;
  readonly state: SourceState;
  readonly quarantineReason?: string;
  readonly quarantinedAt?: IsoTimestamp;
  readonly firstSeenAt: IsoTimestamp;
  readonly lastRunAt?: IsoTimestamp;
  readonly lastSuccessAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Document — identite stable, quasi immuable
// ---------------------------------------------------------------------------

export type DocumentStatus = "discovered" | "stored" | "failed" | "withdrawn";

export interface DocumentEntity {
  readonly documentId: DocumentId;
  readonly sourceId: SourceId;
  readonly nativeId: string;
  readonly canonicalUrl?: string;
  readonly currentVersion: number;
  readonly versionCount: number;
  readonly status: DocumentStatus;
  readonly firstDiscoveredAt: IsoTimestamp;
  readonly lastSeenAt: IsoTimestamp;
  readonly lastChangedAt?: IsoTimestamp;
  readonly withdrawnAt?: IsoTimestamp;
  readonly discoveryRunId: RunId;
}

// ---------------------------------------------------------------------------
// ContentObject — octets adresses par empreinte, strictement immuable
// ---------------------------------------------------------------------------

export type Compression = "none" | "zstd" | "gzip";
export type VerifyStatus = "unverified" | "ok" | "corrupt" | "missing";

export interface ContentObject {
  readonly contentHash: ContentHash;
  readonly byteSize: number;
  readonly mimeType: string;
  /** Issu des magic bytes, pas de la declaration de la source. */
  readonly detectedMime?: string;
  /** Relatif a la racine du magasin. Ne depend d'aucun moteur de base. */
  readonly storagePath: string;
  readonly compression: Compression;
  readonly storedAt: IsoTimestamp;
  readonly refCount: number;
  readonly lastVerifiedAt?: IsoTimestamp;
  readonly verifyStatus: VerifyStatus;
}

// ---------------------------------------------------------------------------
// DocumentVersion — etat date du contenu, immuable
// ---------------------------------------------------------------------------

export type ChangeReason = "initial" | "content_changed" | "reingest" | "repair";

export interface DocumentVersion {
  readonly documentId: DocumentId;
  readonly versionNo: number;
  readonly contentHash: ContentHash;
  readonly fetchedAt: IsoTimestamp;
  readonly fetchedFromUrl?: string;
  readonly httpEtag?: string;
  readonly httpLastModified?: string;
  readonly runId: RunId;
  readonly changeReason: ChangeReason;
  readonly supersedesVersion?: number;
}

export interface DocumentMetadataRecord {
  readonly documentId: DocumentId;
  readonly versionNo: number;
  /** Metadonnees natives, telles que lues, jamais reecrites. */
  readonly raw: SourceMetadata["raw"];
  readonly common?: SourceMetadata["common"];
  readonly provenance: SourceMetadata["provenance"];
  readonly extractedAt: IsoTimestamp;
  readonly extractorVersion: string;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type RunMode = "full" | "incremental" | "range" | "single" | "repair";
export type RunTrigger = "schedule" | "manual" | "api" | "retry";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunCounters {
  readonly docsDiscovered: number;
  readonly docsNew: number;
  readonly docsUpdated: number;
  readonly docsUnchanged: number;
  readonly docsFailed: number;
  readonly bytesDownloaded: number;
  readonly requestsMade: number;
}

export const ZERO_COUNTERS: RunCounters = Object.freeze({
  docsDiscovered: 0,
  docsNew: 0,
  docsUpdated: 0,
  docsUnchanged: 0,
  docsFailed: 0,
  bytesDownloaded: 0,
  requestsMade: 0,
});

export interface Run extends RunCounters {
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly mode: RunMode;
  readonly trigger: RunTrigger;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly status: RunStatus;
  readonly errorSummary?: string;
  readonly checkpointJson?: string;
}

export type FetchOutcome = "success" | "transient_error" | "permanent_error" | "skipped";

export interface FetchAttempt {
  readonly documentId: DocumentId;
  readonly runId: RunId;
  readonly attemptNo: number;
  readonly url?: string;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly httpStatus?: number;
  readonly bytesReceived?: number;
  readonly outcome: FetchOutcome;
  readonly errorClass?: string;
  readonly errorDetail?: string;
}

// ---------------------------------------------------------------------------
// Journal d'integrite
// ---------------------------------------------------------------------------

export type IntegrityResult =
  | "ok"
  | "hash_mismatch"
  | "missing_file"
  | "size_mismatch"
  | "unreadable";

export interface IntegrityCheck {
  readonly contentHash: ContentHash;
  readonly checkedAt: IsoTimestamp;
  readonly result: IntegrityResult;
  readonly expectedHash?: ContentHash;
  readonly actualHash?: ContentHash;
  readonly actionTaken?: string;
}

// ---------------------------------------------------------------------------
// Vues de lecture
// ---------------------------------------------------------------------------

export interface DocumentSummary {
  readonly documentId: DocumentId;
  readonly sourceId: SourceId;
  readonly nativeId: string;
  readonly canonicalUrl?: string;
  readonly status: DocumentStatus;
  readonly versionNo: number;
  readonly fetchedAt: IsoTimestamp;
  readonly contentHash: ContentHash;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly verifyStatus: VerifyStatus;
}

export interface DocumentQuery {
  readonly sourceId?: SourceId;
  readonly status?: DocumentStatus;
  readonly changedSince?: string;
  readonly limit?: number;
  /** Curseur opaque. Aucun offset : sur un corpus qui grandit, l'offset saute. */
  readonly cursor?: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
