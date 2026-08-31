/**
 * Evenements du domaine — Volume II chapitre 4, Volume III chapitre 11.4.
 *
 * Les evenements publics sont un contrat, au meme titre que les signatures de
 * methodes. Leur format engage autant, et leur retrait suit le meme preavis.
 *
 * Livraison « au moins une fois » (ADR-305) : les consommateurs doivent etre
 * idempotents, ce que l'identifiant stable rend trivial.
 */
import type { ContentHash, DocumentId, IsoTimestamp, RunId, SourceId } from "./ids.js";

export const EVENT_SPEC_VERSION = "1.0";

/** Enveloppe commune a tout evenement, interne comme public. */
export interface DomainEvent<TType extends string = string, TData = unknown> {
  readonly specVersion: string;
  /** ULID : stable, trie par le temps, base de l'idempotence des consommateurs. */
  readonly id: string;
  readonly type: TType;
  /** "lcf://kernel/<sourceId>" ou "lcf://kernel". */
  readonly source: string;
  readonly time: IsoTimestamp;
  readonly runId?: RunId;
  readonly data: TData;
}

// ---------------------------------------------------------------------------
// Charges utiles
// ---------------------------------------------------------------------------

export interface RunStartedData {
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly mode: string;
  readonly trigger: string;
}

export interface RunCompletedData {
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly status: "completed" | "failed" | "cancelled";
  readonly docsDiscovered: number;
  readonly docsNew: number;
  readonly docsUpdated: number;
  readonly docsUnchanged: number;
  readonly docsFailed: number;
  readonly bytesDownloaded: number;
  readonly durationMs: number;
}

export interface DocumentDiscoveredData {
  readonly documentId: DocumentId;
  readonly sourceId: SourceId;
  readonly nativeId: string;
  readonly url?: string;
}

export interface DocumentStoredData {
  readonly documentId: DocumentId;
  readonly sourceId: SourceId;
  readonly contentHash: ContentHash;
  readonly version: number;
  readonly bytes: number;
  readonly mimeType: string;
  readonly isNewVersion: boolean;
}

export interface DocumentVersionCreatedData {
  readonly documentId: DocumentId;
  readonly sourceId: SourceId;
  readonly versionNo: number;
  readonly previousHash: ContentHash;
  readonly contentHash: ContentHash;
}

export interface DocumentFailedData {
  readonly documentId: DocumentId;
  readonly sourceId: SourceId;
  readonly errorClass: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface DocumentUnchangedData {
  readonly documentId: DocumentId;
  readonly sourceId: SourceId;
  readonly reason:
    | "etag_match"
    | "identical_content"
    | "not_modified"
    /**
     * Document deja connu, aucun indice de fraicheur ne signale de changement :
     * la collecte incrementale passe son chemin. La comparaison d'empreinte
     * reste obligatoire, mais au balayage complet (Vol. IV, 6.2).
     */
    | "incremental_skip";
}

export interface SourceQuarantinedData {
  readonly sourceId: SourceId;
  readonly reason: string;
  readonly errorClass: string;
  /** Rappele dans l'evenement : la quarantaine ne detruit rien, elle suspend. */
  readonly documentsPreserved: number;
}

export interface IntegrityViolationData {
  readonly contentHash: ContentHash;
  readonly result: string;
  readonly affectedDocuments: readonly DocumentId[];
}

export interface DiscoveryBudgetExceededData {
  readonly sourceId: SourceId;
  readonly runId: RunId;
  readonly dimension: "requests" | "bytes" | "duration";
  readonly limit: number;
  readonly discoveredBeforeStop: number;
}

export interface PluginLifecycleData {
  readonly pluginRef: string;
  readonly sourceId?: SourceId;
  readonly detail?: string;
}

export interface SchemaMigratedData {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly appliedCount: number;
}

// ---------------------------------------------------------------------------
// Table des types
// ---------------------------------------------------------------------------

/**
 * Contrat public de la version 1 — Volume III, 11.4.
 * Toute addition est mineure ; tout retrait exige 12 mois de preavis.
 */
export interface PublicEventMap {
  "lcf.run.started": RunStartedData;
  "lcf.run.completed": RunCompletedData;
  "lcf.document.discovered": DocumentDiscoveredData;
  "lcf.document.stored": DocumentStoredData;
  "lcf.document.version_created": DocumentVersionCreatedData;
  "lcf.document.failed": DocumentFailedData;
  "lcf.source.quarantined": SourceQuarantinedData;
  "lcf.integrity.violation": IntegrityViolationData;
}

/** Evenements internes : observables, mais hors contrat public. */
export interface InternalEventMap {
  "lcf.document.unchanged": DocumentUnchangedData;
  "lcf.discovery.budget_exceeded": DiscoveryBudgetExceededData;
  "lcf.plugin.loaded": PluginLifecycleData;
  "lcf.plugin.rejected": PluginLifecycleData;
  "lcf.plugin.disposed": PluginLifecycleData;
  "lcf.schema.migrated": SchemaMigratedData;
}

export type EventMap = PublicEventMap & InternalEventMap;
export type EventType = keyof EventMap & string;

export type TypedEvent<T extends EventType = EventType> = DomainEvent<T, EventMap[T]>;

export const PUBLIC_EVENT_TYPES: readonly (keyof PublicEventMap & string)[] = Object.freeze([
  "lcf.run.started",
  "lcf.run.completed",
  "lcf.document.discovered",
  "lcf.document.stored",
  "lcf.document.version_created",
  "lcf.document.failed",
  "lcf.source.quarantined",
  "lcf.integrity.violation",
]);

export function isPublicEventType(type: string): type is keyof PublicEventMap & string {
  return (PUBLIC_EVENT_TYPES as readonly string[]).includes(type);
}
