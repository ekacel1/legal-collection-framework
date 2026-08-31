/**
 * Contrat de plugin — Volume III, chapitres 2 et 3.
 *
 * C'est la frontiere descendante du systeme : le point d'extension par lequel
 * une nouvelle source documentaire entre. Un contrat public est une dette
 * permanente ; rien n'est publie ici qui ne soit indispensable.
 *
 * Regle structurante : le plugin est un fournisseur, pas un acteur. Il ne
 * telecharge pas, n'ecrit pas, n'emet aucun evenement, n'ouvre aucune connexion.
 */
import type { SourceId } from "./ids.js";

/** Version du contrat, distincte de la version du Kernel et de celle du plugin. */
export type PluginApiVersion = `${number}.${number}`;

/** Version courante du contrat supportee par ce Kernel. */
export const CURRENT_API_VERSION: PluginApiVersion = "1.0";

// ---------------------------------------------------------------------------
// Monnaie d'echange
// ---------------------------------------------------------------------------

/**
 * Descripteur produit par un plugin — Volume III, 3.1.
 *
 * `nativeId` doit etre stable dans le temps et unique dans la source. Un
 * nativeId instable ne produit aucune erreur : il produit du volume. C'est la
 * panne la plus couteuse et la plus difficile a detecter du systeme.
 */
export interface DocumentRef {
  /** Identifiant stable DANS la source. Doit survivre a un changement d'URL. */
  readonly nativeId: string;

  /** URL canonique de la ressource, si elle existe. */
  readonly url?: string;

  /** Titre brut tel qu'affiche par la source. Aucune normalisation. */
  readonly title?: string;

  /** Date affichee par la source, ISO-8601, telle que lue. */
  readonly publishedAt?: string;

  /** Type declare par la source, non verifie a ce stade. */
  readonly declaredMime?: string;

  /** Taille annoncee, si disponible. */
  readonly declaredBytes?: number;

  /** Indices de fraicheur fournis par la source (HTTP ou page). */
  readonly etag?: string;
  readonly lastModified?: string;

  /** Charge utile libre, propre au plugin, conservee telle quelle. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Metadonnees natives de la source — Volume III, 3.3. */
export interface SourceMetadata {
  /** Champs bruts extraits de la source, sans interpretation. */
  readonly raw: Readonly<Record<string, string | number | boolean | null>>;

  /** Champs projetes sur un vocabulaire commun, tous facultatifs. */
  readonly common?: {
    readonly documentKind?: string;
    readonly reference?: string;
    readonly issuedAt?: string;
    readonly language?: string;
    readonly authority?: string;
  };

  /**
   * Provenance : ou chaque champ a-t-il ete lu. Obligatoire pour l'audit.
   * Quand un champ est faux dix ans plus tard, on doit savoir quelle ligne de
   * quel selecteur sur quelle page l'a produit.
   */
  readonly provenance: ReadonlyArray<{
    readonly field: string;
    /** Selecteur CSS, chemin JSON, nom d'en-tete. */
    readonly locator: string;
    /** URL ou l'extraction a eu lieu. */
    readonly at: string;
  }>;
}

// ---------------------------------------------------------------------------
// Plan de recuperation — le plugin decrit, le Kernel execute
// ---------------------------------------------------------------------------

export type FetchPlan =
  | HttpFetchPlan
  | BrowserFetchPlan
  | ArchiveMemberFetchPlan
  | InlineFetchPlan;

export interface FetchExpectation {
  readonly mimeTypes?: readonly string[];
  readonly minBytes?: number;
  readonly maxBytes?: number;
  /** Signature hexadecimale attendue en tete de fichier, ex. "25504446" (%PDF). */
  readonly magicBytes?: string;
}

export interface HttpFetchPlan {
  readonly kind: "http";
  /** Absolue, http(s) uniquement. */
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly expect?: FetchExpectation;
  readonly follow?: { readonly redirects: boolean; readonly maxHops: number };
}

export type BrowserAction =
  | { readonly kind: "click"; readonly selector: string }
  | { readonly kind: "fill"; readonly selector: string; readonly value: string }
  | { readonly kind: "waitFor"; readonly selector: string };

export interface BrowserFetchPlan {
  readonly kind: "browser";
  readonly url: string;
  readonly waitFor?: { readonly selector?: string; readonly networkIdleMs?: number };
  /** Actions strictement declaratives, jamais du code arbitraire. */
  readonly action?: readonly BrowserAction[];
  readonly capture: "download" | "pdf" | "html";
  readonly requiresCapability: "browser";
}

export interface ArchiveMemberFetchPlan {
  readonly kind: "archive-member";
  readonly archive: HttpFetchPlan;
  /** Chemin interne, sans "..". Anti zip-slip applique par le Kernel. */
  readonly member: string;
}

/**
 * Echappatoire volontairement inconfortable — Volume III, 2.3.
 * Plafonnee, justification obligatoire, signalee dans le rapport de conformite.
 */
export interface InlineFetchPlan {
  readonly kind: "inline";
  readonly bytes: Uint8Array;
  /** Justification obligatoire, conservee pour l'audit. */
  readonly reason: string;
}

/** Plafond dur de l'echappatoire inline : 8 Mio — Volume III, 2.3. */
export const INLINE_FETCH_MAX_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Portee et budget de decouverte
// ---------------------------------------------------------------------------

export type DiscoveryMode = "full" | "incremental" | "range" | "single";

export interface DiscoveryBudget {
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
}

/**
 * Le budget n'est pas indicatif — Volume III, 3.4.
 * Un plugin en boucle infinie ne peut pas immobiliser le systeme : le
 * depassement declenche l'AbortSignal et interrompt proprement l'enumeration.
 */
export interface DiscoveryScope {
  readonly mode: DiscoveryMode;
  readonly since?: string;
  readonly from?: string;
  readonly to?: string;
  readonly nativeId?: string;
  /** Plafond dur impose par le Kernel. */
  readonly maxDocuments?: number;
  readonly budget: DiscoveryBudget;
}

// ---------------------------------------------------------------------------
// Le contexte : seul canal du plugin vers le monde
// ---------------------------------------------------------------------------

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
  readonly bytes: Uint8Array;
}

export interface RequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/**
 * Client HTTP instrumente. Ce n'est pas un client generique parametre : c'est
 * un client construit POUR ce plugin, dont les limites ne sont pas modifiables
 * depuis le plugin — Volume III, 5.3.
 */
export interface HttpClient {
  get(url: string, opts?: RequestOptions): Promise<HttpResponse>;
  getText(url: string, opts?: RequestOptions): Promise<string>;
  getJson<T = unknown>(url: string, opts?: RequestOptions): Promise<T>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  child(bindings: Readonly<Record<string, unknown>>): Logger;
}

export interface SecretAccessor {
  /** Resolution paresseuse ; la valeur n'est jamais journalisee ni serialisee. */
  get(name: string): Promise<string | undefined>;
  has(name: string): boolean;
}

export interface EphemeralCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  readonly size: number;
}

/**
 * Horloge injectee — Volume III, 2.5.
 * Sans elle, aucun plugin manipulant des dates n'est testable de maniere
 * reproductible, et la suite de tests depend du jour ou on l'execute.
 */
export interface Clock {
  now(): Date;
  nowMillis(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface BrowserSession {
  open(url: string): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
}

export interface PluginContext {
  readonly sourceId: SourceId;
  readonly http: HttpClient;
  readonly log: Logger;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: SecretAccessor;
  readonly cache: EphemeralCache;
  readonly clock: Clock;
  readonly signal: AbortSignal;
  /** Present uniquement si la capacite "browser" a ete accordee. */
  readonly browser?: BrowserSession;
}

// ---------------------------------------------------------------------------
// Le contrat lui-meme
// ---------------------------------------------------------------------------

/**
 * Contrat racine. Toute source de documents est un SourcePlugin.
 * Quatre methodes : c'est tout ce qu'un plugin doit implementer.
 */
export interface SourcePlugin {
  readonly id: SourceId;
  readonly apiVersion: PluginApiVersion;

  /** Appele une seule fois apres chargement, avant tout autre appel. */
  init(ctx: PluginContext): Promise<void>;

  /** Enumere les documents disponibles. Flux asynchrone, consomme au fil de l'eau. */
  discover(scope: DiscoveryScope): AsyncIterable<DocumentRef>;

  /** Decrit comment obtenir le contenu binaire. Le plugin NE telecharge PAS. */
  resolve(ref: DocumentRef): Promise<FetchPlan>;

  /** Libere les ressources. Toujours appele, meme apres erreur. */
  dispose(): Promise<void>;
}

/** Metadonnees natives de la source, par document. */
export interface Describable {
  describe(ref: DocumentRef): Promise<SourceMetadata>;
}

export type Cursor = string;

export interface PageResult {
  readonly refs: readonly DocumentRef[];
  readonly nextCursor: Cursor | null;
}

/** Le plugin sait enumerer par pages et reprendre a un curseur. */
export interface Paged {
  readonly pageSize?: number;
  discoverPage(cursor: Cursor | null): Promise<PageResult>;
}

/** Etat opaque rendu au Kernel et restitue a la collecte suivante. */
export interface CheckpointState {
  readonly version: 1;
  readonly cursor?: string;
  readonly highWaterMark?: string;
  /** Derniers nativeId vus, garde anti-recouvrement. */
  readonly seenTail?: readonly string[];
}

/** Le plugin sait limiter la decouverte a ce qui a change. */
export interface Incremental {
  checkpoint(): Promise<CheckpointState>;
  restore(state: CheckpointState): Promise<void>;
}

export interface HealthReport {
  readonly status: "ok" | "degraded" | "down";
  readonly checkedAt: string;
  readonly detail?: string;
  readonly limitations?: readonly string[];
}

/** Le plugin sait verifier la sante de la source sans rien collecter. */
export interface HealthReporting {
  health(): Promise<HealthReport>;
}

export interface BrowserProfile {
  readonly reason: string;
  readonly maxPageDurationMs?: number;
}

/** Le plugin exige un navigateur pour au moins une operation. */
export interface BrowserAssisted {
  readonly browserProfile: BrowserProfile;
}

// ---------------------------------------------------------------------------
// Detection structurelle des capacites de contrat — ADR-302
// ---------------------------------------------------------------------------

/**
 * Les capacites de contrat sont detectees par presence de methode, jamais
 * declarees dans le manifeste : une double source de verite derive toujours.
 * Le manifeste ne declare que les capacites de SECURITE (reseau, navigateur,
 * archives, secrets).
 */
export interface DetectedCapabilities {
  readonly describable: boolean;
  readonly paged: boolean;
  readonly incremental: boolean;
  readonly healthReporting: boolean;
  readonly browserAssisted: boolean;
}

export function detectCapabilities(plugin: SourcePlugin): DetectedCapabilities {
  const candidate = plugin as Partial<
    Describable & Paged & Incremental & HealthReporting & BrowserAssisted
  >;
  return {
    describable: typeof candidate.describe === "function",
    paged: typeof candidate.discoverPage === "function",
    incremental:
      typeof candidate.checkpoint === "function" && typeof candidate.restore === "function",
    healthReporting: typeof candidate.health === "function",
    browserAssisted: typeof candidate.browserProfile === "object",
  };
}

export function isDescribable(plugin: SourcePlugin): plugin is SourcePlugin & Describable {
  return typeof (plugin as Partial<Describable>).describe === "function";
}

export function isIncremental(plugin: SourcePlugin): plugin is SourcePlugin & Incremental {
  const candidate = plugin as Partial<Incremental>;
  return typeof candidate.checkpoint === "function" && typeof candidate.restore === "function";
}

export function isHealthReporting(
  plugin: SourcePlugin,
): plugin is SourcePlugin & HealthReporting {
  return typeof (plugin as Partial<HealthReporting>).health === "function";
}
