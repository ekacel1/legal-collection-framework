/**
 * Contrat de depot — Volume IV, chapitre 11.1.
 *
 * Le contrat n'expose jamais de SQL. C'est ce qui rend l'exigence du Volume I
 * verifiable : remplacer SQLite par PostgreSQL ne touche aucune ligne du
 * domaine, seulement une implementation de cette interface.
 */
import type { ContentHash, DocumentId, IsoTimestamp, RunId, SourceId } from "../domain/ids.js";
import type { SourceMetadata } from "../domain/contract.js";
import type {
  ChangeReason,
  ContentObject,
  DocumentEntity,
  DocumentQuery,
  DocumentSummary,
  DocumentVersion,
  FetchAttempt,
  IntegrityCheck,
  Page,
  Run,
  RunCounters,
  RunMode,
  RunStatus,
  RunTrigger,
  Source,
  SourceState,
  VerifyStatus,
} from "../domain/model.js";
import type { StoredObject } from "../storage/content-store.js";

/**
 * Unite de travail de l'etape E10 — Volume IV, 5.1.
 *
 * Tout ce que contient cette structure est ecrit dans une seule transaction,
 * ou rien ne l'est. Le fichier, lui, est deja sur le disque et synchronise :
 * c'est l'ordre qui garantit qu'aucune ligne ne pointe vers un fichier absent.
 */
export interface DocumentCommit {
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly documentId: DocumentId;
  readonly nativeId: string;
  readonly canonicalUrl?: string;

  /** Objet de contenu tel que le magasin l'a effectivement ecrit. */
  readonly stored: StoredObject;

  readonly versionNo: number;
  readonly changeReason: ChangeReason;
  readonly supersedesVersion?: number;

  readonly fetchedAt: IsoTimestamp;
  readonly fetchedFromUrl?: string;
  readonly httpEtag?: string;
  readonly httpLastModified?: string;

  readonly metadata?: SourceMetadata;
  readonly extractorVersion?: string;

  /** Tentative de recuperation ayant abouti a cette version. */
  readonly attempt?: AttemptRecord;
}

export interface AttemptRecord {
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly url?: string;
  readonly httpStatus?: number;
  readonly bytesReceived?: number;
  readonly outcome: FetchAttempt["outcome"];
  readonly errorClass?: string;
  readonly errorDetail?: string;
}

export interface CommitResult {
  readonly documentId: DocumentId;
  readonly versionNo: number;
  readonly isNewDocument: boolean;
  readonly isNewVersion: boolean;
}

export interface DiscoveryRecord {
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly documentId: DocumentId;
  readonly nativeId: string;
  readonly canonicalUrl?: string;
  readonly seenAt: IsoTimestamp;
}

export interface SourceRegistration {
  readonly sourceId: SourceId;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly apiVersion: string;
  readonly displayName: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RunStart {
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly mode: RunMode;
  readonly trigger: RunTrigger;
  readonly startedAt: IsoTimestamp;
}

export interface RunClose {
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly endedAt: IsoTimestamp;
  readonly counters: RunCounters;
  readonly errorSummary?: string;
  readonly checkpointJson?: string;
}

/** Lecture et ecriture du corpus. Aucune methode n'expose de SQL. */
export interface DocumentRepository {
  // --- Sources ---
  registerSource(registration: SourceRegistration): Promise<Source>;
  getSource(sourceId: SourceId): Promise<Source | null>;
  listSources(): Promise<Source[]>;
  setSourceState(sourceId: SourceId, state: SourceState, reason?: string): Promise<void>;

  // --- Executions ---
  startRun(start: RunStart): Promise<Run>;
  closeRun(close: RunClose): Promise<void>;
  getRun(runId: RunId): Promise<Run | null>;

  /**
   * Clot les executions restees `running` alors que leur processus a disparu.
   *
   * Le seuil est volontairement large : un autre processus — le demon, par
   * exemple — peut legitimement avoir une collecte en cours. Seule une
   * execution plus vieille que tout budget imaginable est declaree interrompue.
   */
  failStaleRuns(startedBefore: IsoTimestamp, endedAt: IsoTimestamp): Promise<number>;
  listRuns(sourceId: SourceId, limit?: number): Promise<Run[]>;

  // --- Documents ---
  recordDiscovery(record: DiscoveryRecord): Promise<{ isNewDocument: boolean }>;
  findByNativeId(sourceId: SourceId, nativeId: string): Promise<DocumentEntity | null>;
  getDocument(documentId: DocumentId): Promise<DocumentEntity | null>;
  currentVersion(documentId: DocumentId): Promise<DocumentVersion | null>;
  listVersions(documentId: DocumentId): Promise<DocumentVersion[]>;
  query(q: DocumentQuery): Promise<Page<DocumentSummary>>;

  /** Ecriture transactionnelle de l'etape E10 : tout ou rien. */
  commitDocument(commit: DocumentCommit): Promise<CommitResult>;

  /** Contenu inchange : seule la date de derniere vue bouge, aucune version. */
  touchDocument(documentId: DocumentId, seenAt: IsoTimestamp): Promise<void>;

  /** Echec de collecte : le document est marque, rien n'est supprime. */
  markDocumentFailed(documentId: DocumentId, seenAt: IsoTimestamp): Promise<void>;

  /** Retrait constate : statut `withdrawn`, versions et octets intacts. */
  markDocumentWithdrawn(documentId: DocumentId, withdrawnAt: IsoTimestamp): Promise<void>;

  /**
   * Documents absents de N balayages complets consecutifs — Volume IV, 6.4.
   * Retourne les documents effectivement passes en `withdrawn`. Aucun octet
   * n'est touche : le retrait est un constat date, pas une suppression.
   */
  withdrawUnseen(
    sourceId: SourceId,
    missedSweeps: number,
    at: IsoTimestamp,
  ): Promise<DocumentId[]>;

  /**
   * Documents en echec, du plus anciennement vu au plus recent.
   * Ils attendent une reprise ciblee : sans elle, un document qui echoue en
   * mode incremental n'est retente qu'au balayage complet suivant, soit
   * jusqu'a trente jours plus tard.
   */
  listFailedDocuments(sourceId: SourceId, limit: number): Promise<DocumentEntity[]>;

  /** Nombre d'executions completes recentes n'ayant rien decouvert. */
  emptyFullRunStreak(sourceId: SourceId): Promise<number>;

  /**
   * Dernier etat de reprise enregistre pour cette source, ou `null`.
   * C'est ce qui permet a une collecte incrementale de reprendre la ou la
   * precedente s'est arretee, au lieu de tout refaire.
   */
  lastCheckpoint(sourceId: SourceId): Promise<string | null>;

  /**
   * Instant du dernier balayage COMPLET mene a son terme.
   * Le mode incremental n'est qu'une optimisation : sans balayage complet
   * periodique, il finit toujours par diverger de la realite (Vol. III, 7.3).
   */
  lastFullSweepAt(sourceId: SourceId): Promise<IsoTimestamp | null>;

  countDocuments(sourceId: SourceId): Promise<number>;

  recordAttempt(runId: RunId, documentId: DocumentId, attempt: AttemptRecord): Promise<void>;

  // --- Objets de contenu et integrite ---
  getContentObject(hash: ContentHash): Promise<ContentObject | null>;
  recordIntegrityCheck(check: IntegrityCheck): Promise<void>;
  setVerifyStatus(
    hash: ContentHash,
    status: VerifyStatus,
    verifiedAt: IsoTimestamp,
  ): Promise<void>;
  oldestUnverified(limit: number): Promise<ContentObject[]>;

  /**
   * Parcours integral des objets, par empreinte croissante.
   * Le curseur evite de charger un magasin d'un million d'objets en memoire.
   */
  listContentObjects(afterHash: ContentHash | null, limit: number): Promise<ContentObject[]>;

  countContentObjects(): Promise<{ objects: number; bytes: number }>;
  documentsFor(hash: ContentHash): Promise<DocumentId[]>;

  /** Recompte reel depuis document_versions — jamais depuis le compteur. */
  recountReferences(hash: ContentHash): Promise<number>;

  /** Unite de travail explicite, portable entre moteurs. */
  withTransaction<T>(fn: (repo: DocumentRepository) => Promise<T>): Promise<T>;
}
