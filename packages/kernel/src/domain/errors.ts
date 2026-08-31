/**
 * Taxonomie d'erreurs — Volume III, chapitre 8.
 *
 * La classe d'une erreur n'est pas documentaire : elle determine mecaniquement
 * la reaction du Kernel (retry, abandon du document, quarantaine de la source).
 * Une erreur mal classee produit soit une tempete de reessais, soit une
 * corruption silencieuse du corpus.
 */
import type { SourceId } from "./ids.js";

/** Portee de l'impact d'une erreur, appliquee par l'orchestrateur. */
export type ErrorScope = "document" | "source" | "kernel";

export interface LcfErrorOptions {
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Racine de toute erreur du Framework. */
export abstract class LcfError extends Error {
  /** Nom de classe stable, journalise dans fetch_attempts.error_class. */
  public readonly errorClass: string;
  public readonly context: Readonly<Record<string, unknown>>;

  /** Le Kernel doit-il reessayer ? Jamais decide au cas par cas ailleurs. */
  public abstract readonly retryable: boolean;

  /** Quelle portee est affectee : le document seul, la source, ou le systeme. */
  public abstract readonly scope: ErrorScope;

  protected constructor(message: string, options: LcfErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.errorClass = new.target.name;
    this.context = Object.freeze({ ...options.context });
  }

  /** Representation journalisable, sans secret ni pile d'appel. */
  toJSON(): Record<string, unknown> {
    return {
      errorClass: this.errorClass,
      message: this.message,
      retryable: this.retryable,
      scope: this.scope,
      context: this.context,
    };
  }
}

// ---------------------------------------------------------------------------
// Erreurs imputables au plugin
// ---------------------------------------------------------------------------

export abstract class PluginError extends LcfError {
  public readonly sourceId: SourceId;

  protected constructor(sourceId: SourceId, message: string, options: LcfErrorOptions = {}) {
    super(message, options);
    this.sourceId = sourceId;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), sourceId: this.sourceId };
  }
}

/** Panne passagere : reessai avec backoff exponentiel et jitter, 5 tentatives. */
export abstract class TransientPluginError extends PluginError {
  public override readonly retryable = true;
  public override readonly scope: ErrorScope = "document";
}

export class SourceUnavailable extends TransientPluginError {
  constructor(sourceId: SourceId, options?: LcfErrorOptions) {
    super(sourceId, `source indisponible : ${sourceId}`, options);
  }
}

export class RateLimited extends TransientPluginError {
  /** Delai conseille par la source (Retry-After), en millisecondes. */
  public readonly retryAfterMs: number | undefined;

  constructor(sourceId: SourceId, retryAfterMs?: number, options?: LcfErrorOptions) {
    super(sourceId, `source limitee en debit : ${sourceId}`, options);
    this.retryAfterMs = retryAfterMs;
  }
}

export class NetworkTimeout extends TransientPluginError {
  constructor(sourceId: SourceId, options?: LcfErrorOptions) {
    super(sourceId, `delai reseau depasse : ${sourceId}`, options);
  }
}

/** Le document est ignore, la source reste vivante. Aucun reessai. */
export abstract class ContractPluginError extends PluginError {
  public override readonly retryable = false;
  public override readonly scope: ErrorScope = "document";
}

export class InvalidDocumentRef extends ContractPluginError {
  constructor(sourceId: SourceId, reason: string, options?: LcfErrorOptions) {
    super(sourceId, `DocumentRef invalide : ${reason}`, options);
  }
}

export class UnresolvableDocument extends ContractPluginError {
  constructor(sourceId: SourceId, nativeId: string, options?: LcfErrorOptions) {
    super(sourceId, `document non resolvable : ${nativeId}`, {
      ...options,
      context: { ...options?.context, nativeId },
    });
  }
}

export class MetadataExtractionFailed extends ContractPluginError {
  constructor(sourceId: SourceId, nativeId: string, options?: LcfErrorOptions) {
    super(sourceId, `extraction de metadonnees echouee : ${nativeId}`, {
      ...options,
      context: { ...options?.context, nativeId },
    });
  }
}

/**
 * Une regle d'exploitation a refuse la requete (robots.txt, par exemple).
 *
 * Le document est abandonne ; la source n'est pas mise en quarantaine, car un
 * refus de politesse est un fonctionnement nominal, pas une panne.
 */
export class PolicyViolation extends ContractPluginError {
  constructor(sourceId: SourceId, policy: string, subject: string, options?: LcfErrorOptions) {
    super(sourceId, `regle "${policy}" refuse : ${subject}`, {
      ...options,
      context: { ...options?.context, policy, subject },
    });
  }
}

/**
 * Reponse HTTP inattendue apres epuisement des reessais.
 *
 * Le document est abandonne, la source reste vivante : un 404 isole est un
 * accident de publication frequent, pas la preuve que la source a change de
 * structure. La bascule en quarantaine reste declenchee par le taux d'echec
 * global (Vol. III, 6.3), jamais par un document seul.
 */
export class UnexpectedHttpStatus extends ContractPluginError {
  public readonly status: number;

  constructor(sourceId: SourceId, status: number, url: string, options?: LcfErrorOptions) {
    super(sourceId, `statut HTTP inattendu ${status} : ${url}`, {
      ...options,
      context: { ...options?.context, status, url },
    });
    this.status = status;
  }
}

/** Quarantaine immediate de la source. Les autres sources continuent. */
export abstract class FatalPluginError extends PluginError {
  public override readonly retryable = false;
  public override readonly scope: ErrorScope = "source";
}

/** Tentative d'usage d'une capacite non accordee — Volume III, 5.3. */
export class CapabilityViolation extends FatalPluginError {
  constructor(sourceId: SourceId, capability: string, subject: string, options?: LcfErrorOptions) {
    super(sourceId, `capacite non accordee "${capability}" : ${subject}`, {
      ...options,
      context: { ...options?.context, capability, subject },
    });
  }
}

/**
 * La structure de la source a change — Volume III, 6.3.
 *
 * C'est le mode de panne le plus frequent d'un collecteur : une refonte de site
 * ne produit aucune erreur HTTP, elle produit zero resultat.
 */
export class SourceStructureChanged extends FatalPluginError {
  constructor(sourceId: SourceId, detail: string, options?: LcfErrorOptions) {
    super(sourceId, `structure de source modifiee : ${detail}`, options);
  }
}

export class ConfigurationInvalid extends FatalPluginError {
  constructor(sourceId: SourceId, detail: string, options?: LcfErrorOptions) {
    super(sourceId, `configuration invalide : ${detail}`, options);
  }
}

/**
 * Toute erreur non reconnue est traitee comme fatale — Volume III, 8.2.
 *
 * Le choix par defaut est deliberement severe : une erreur inattendue signale
 * une hypothese fausse, et poursuivre sur une hypothese fausse produit des
 * donnees douteuses. Le Framework prefere toujours une panne bruyante.
 */
export class UnexpectedPluginError extends FatalPluginError {
  constructor(sourceId: SourceId, cause: unknown) {
    super(sourceId, `erreur inattendue du plugin : ${describeUnknown(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------------------
// Erreurs du Kernel — hors responsabilite du plugin
// ---------------------------------------------------------------------------

export class KernelError extends LcfError {
  public override readonly retryable: boolean;
  public override readonly scope: ErrorScope;

  constructor(
    message: string,
    options: LcfErrorOptions & { retryable?: boolean; scope?: ErrorScope } = {},
  ) {
    super(message, options);
    this.retryable = options.retryable ?? false;
    this.scope = options.scope ?? "kernel";
  }
}

/** Panne du magasin de contenu ou de l'index. Aucune ecriture partielle admise. */
export class StorageError extends KernelError {}

/** Divergence d'empreinte, fichier absent ou illisible — Volume IV, chapitre 7. */
export class IntegrityError extends KernelError {
  constructor(message: string, options?: LcfErrorOptions) {
    super(message, { ...options, scope: "document" });
  }
}

export class MigrationError extends KernelError {}

/**
 * Budget de decouverte epuise — Volume III, 3.4.
 *
 * Ce n'est pas une panne : c'est une borne appliquee. L'enumeration s'interrompt
 * proprement et les documents deja decouverts sont conserves.
 */
export class BudgetExceeded extends KernelError {
  constructor(
    dimension: "requests" | "bytes" | "duration",
    limit: number,
    options?: LcfErrorOptions,
  ) {
    super(`budget de decouverte epuise (${dimension} > ${limit})`, {
      ...options,
      scope: "source",
      context: { ...options?.context, dimension, limit },
    });
  }
}

/** Le plugin a ete rejete avant toute evaluation de son code — Volume III, 4.4. */
export class PluginRejected extends KernelError {
  constructor(pluginRef: string, reason: string, options?: LcfErrorOptions) {
    super(`plugin rejete : ${pluginRef} — ${reason}`, {
      ...options,
      context: { ...options?.context, pluginRef, reason },
    });
  }
}

// ---------------------------------------------------------------------------
// Classement d'une valeur levee
// ---------------------------------------------------------------------------

export function describeUnknown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Normalise une valeur levee en erreur du domaine, sans jamais l'avaler. */
export function classify(sourceId: SourceId, thrown: unknown): LcfError {
  if (thrown instanceof LcfError) return thrown;
  return new UnexpectedPluginError(sourceId, thrown);
}
