/**
 * Plugin Manager — Volume III, chapitres 5, 6 et 10.
 *
 * Sequence de chargement (10.2), appliquee sans raccourci :
 *   a. lire lcf-plugin.json          -> echec : ignorer, journaliser
 *   b. valider contre le meta-schema -> echec : PluginRejected
 *   c. verifier apiVersion           -> echec : PluginRejected
 *   e. verifier l'unicite de l'id    -> conflit : PluginRejected (les deux)
 *   f. calculer les capacites effectives
 *   g. charger le module (entry)
 *   h. verifier structurellement le contrat
 *   i. construire le PluginContext
 *   j. appeler init() avec timeout
 *
 * L'etape (b) precede toute evaluation de code : un manifeste corrompu ou
 * malveillant n'atteint jamais l'execution.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ConfigurationInvalid,
  KernelError,
  PluginRejected,
  classify,
  describeUnknown,
} from "../domain/errors.js";
import { asSourceId, type SourceId } from "../domain/ids.js";
import {
  CURRENT_API_VERSION,
  detectCapabilities,
  type Clock,
  type DetectedCapabilities,
  type EphemeralCache,
  type Logger,
  type PluginContext,
  type SecretAccessor,
  type SourcePlugin,
} from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import { SilentLogger } from "../observability/logger.js";
import {
  CircuitBreaker,
  HostRateLimiter,
  type BudgetTracker,
} from "../net/policy.js";
import { ScopedHttpClient } from "../net/scoped-http-client.js";
import { RobotsPolicy } from "../net/robots.js";
import { FetchHttpTransport, type HttpTransport } from "../net/transport.js";
import { formatIssues, validate } from "../util/json-schema.js";
import { effectiveCapabilities, type CapabilityGrant, type EffectiveCapabilities } from "./capabilities.js";
import { MANIFEST_FILENAME, isApiVersionSupported, parseManifest, type PluginManifest } from "./manifest.js";

/** Machine a etats du Volume III, 6.1. */
export type PluginState =
  | "discovered"
  | "validated"
  | "loaded"
  | "ready"
  | "active"
  | "quarantined"
  | "disposed";

/** `init()` est plafonne a 30 s — Volume III, 6.2. */
export const INIT_TIMEOUT_MS = 30_000;

export interface DiscoveredPlugin {
  readonly directory: string;
  readonly manifest: PluginManifest;
}

export interface SourceBinding {
  /** Identifiant de source ; par defaut, celui du manifeste. */
  readonly sourceId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly grant?: CapabilityGrant;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly budget?: BudgetTracker;
  readonly signal?: AbortSignal;
}

export interface LoadedPlugin {
  readonly sourceId: SourceId;
  readonly manifest: PluginManifest;
  readonly plugin: SourcePlugin;
  readonly context: PluginContext;
  readonly http: ScopedHttpClient;
  readonly capabilities: EffectiveCapabilities;
  readonly detected: DetectedCapabilities;
  state: PluginState;
  quarantineReason?: string;
}

export interface PluginManagerOptions {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly transport?: HttpTransport;
  readonly userAgent: string;
  readonly apiVersion?: typeof CURRENT_API_VERSION;
  readonly initTimeoutMs?: number;
  /** Fabrique de module, substituable en test pour eviter l'ecriture disque. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
}

export class PluginManager {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #transport: HttpTransport;
  readonly #userAgent: string;
  readonly #apiVersion: typeof CURRENT_API_VERSION;
  readonly #initTimeoutMs: number;
  readonly #importModule: (specifier: string) => Promise<unknown>;
  readonly #limiter: HostRateLimiter;
  readonly #loaded = new Map<SourceId, LoadedPlugin>();

  constructor(options: PluginManagerOptions) {
    this.#clock = options.clock ?? new SystemClock();
    this.#logger = options.logger ?? new SilentLogger();
    this.#transport = options.transport ?? new FetchHttpTransport();
    this.#userAgent = options.userAgent;
    this.#apiVersion = options.apiVersion ?? CURRENT_API_VERSION;
    this.#initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.#importModule =
      options.importModule ?? ((specifier: string) => import(specifier) as Promise<unknown>);
    this.#limiter = new HostRateLimiter(this.#clock);
  }

  get plugins(): readonly LoadedPlugin[] {
    return [...this.#loaded.values()];
  }

  get(sourceId: SourceId): LoadedPlugin | undefined {
    return this.#loaded.get(sourceId);
  }

  /**
   * Etapes (a), (b), (c) et (e) : lecture, validation, compatibilite, unicite.
   * Aucun code de plugin n'est evalue par cette methode.
   */
  async discover(searchPaths: readonly string[]): Promise<DiscoveredPlugin[]> {
    const candidates: DiscoveredPlugin[] = [];
    const byId = new Map<string, string[]>();

    for (const searchPath of searchPaths) {
      for (const directory of await this.#candidateDirectories(searchPath)) {
        const manifestPath = path.join(directory, MANIFEST_FILENAME);
        let raw: string;
        try {
          raw = await fsp.readFile(manifestPath, "utf8");
        } catch {
          // (a) Un repertoire sans manifeste n'est pas un plugin : on ignore,
          // mais on le dit, sinon un plugin mal deploye reste invisible.
          this.#logger.debug("repertoire sans manifeste, ignore", { directory });
          continue;
        }

        const manifest = parseManifest(raw, directory); // (b)
        if (!isApiVersionSupported(manifest.apiVersion, this.#apiVersion)) {
          // (c) Message actionnable : ce que le plugin demande, ce que le
          // Kernel supporte, et ou trouver le guide de migration.
          throw new PluginRejected(
            manifest.id,
            `apiVersion incompatible : demande ${manifest.apiVersion}, supporte ^${this.#apiVersion} — migrer selon docs/migration/`,
          );
        }

        candidates.push({ directory, manifest });
        byId.set(manifest.id, [...(byId.get(manifest.id) ?? []), directory]);
      }
    }

    // (e) Un conflit d'identifiant rejette LES DEUX plugins : choisir un
    // gagnant rendrait le comportement dependant de l'ordre de parcours du
    // systeme de fichiers.
    for (const [id, directories] of byId) {
      if (directories.length > 1) {
        throw new PluginRejected(id, `identifiant en conflit : ${directories.join(", ")}`);
      }
    }

    return candidates;
  }

  async #candidateDirectories(searchPath: string): Promise<string[]> {
    const resolved = path.resolve(searchPath);
    try {
      const stats = await fsp.stat(resolved);
      if (!stats.isDirectory()) return [];
    } catch {
      return [];
    }
    // Le chemin peut designer un plugin unique ou un repertoire de plugins.
    try {
      await fsp.access(path.join(resolved, MANIFEST_FILENAME));
      return [resolved];
    } catch {
      const entries = await fsp.readdir(resolved, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(resolved, entry.name));
    }
  }

  /** Etapes (f) a (j) : capacites, chargement, contrat, contexte, init. */
  async load(discovered: DiscoveredPlugin, binding: SourceBinding = {}): Promise<LoadedPlugin> {
    const { manifest, directory } = discovered;
    const sourceId = asSourceId(binding.sourceId ?? manifest.id);

    if (this.#loaded.has(sourceId)) {
      throw new PluginRejected(String(sourceId), "source deja chargee");
    }

    // (f) Capacites effectives = manifeste ∩ configuration.
    const capabilities = effectiveCapabilities(
      manifest.capabilities,
      binding.grant,
      (manifest.secrets ?? []).map((secret) => secret.name),
    );
    if (capabilities.network.allowedHosts.length === 0) {
      throw new PluginRejected(
        String(sourceId),
        "aucun hote autorise apres intersection manifeste/configuration",
      );
    }

    // Configuration validee contre le schema declare par le manifeste.
    const config = binding.config ?? {};
    const issues = validate(config, manifest.configSchema, "config");
    if (issues.length > 0) {
      throw new ConfigurationInvalid(sourceId, formatIssues(issues));
    }
    for (const secret of manifest.secrets ?? []) {
      if (secret.required === true && binding.secrets?.[secret.name] === undefined) {
        throw new ConfigurationInvalid(sourceId, `secret obligatoire absent : ${secret.name}`);
      }
    }

    // (g) Chargement du module.
    const entryPath = path.resolve(directory, manifest.entry);
    if (!entryPath.startsWith(path.resolve(directory))) {
      throw new PluginRejected(String(sourceId), "entry sort du paquet");
    }
    let module: unknown;
    try {
      module = await this.#importModule(pathToFileURL(entryPath).href);
    } catch (cause) {
      throw new PluginRejected(String(sourceId), `module illisible : ${describeUnknown(cause)}`, {
        cause,
      });
    }

    // (h) Verification structurelle du contrat.
    const plugin = await instantiate(module, String(sourceId));
    assertContract(plugin, String(sourceId));

    // (i) Construction du contexte, propre a ce plugin et revocable.
    const logger = this.#logger.child({ sourceId });
    const http = new ScopedHttpClient({
      sourceId,
      capability: capabilities.network,
      transport: this.#transport,
      limiter: this.#limiter,
      breaker: new CircuitBreaker(this.#clock),
      clock: this.#clock,
      userAgent: this.#userAgent,
      logger,
      ...(capabilities.network.respectRobotsTxt
        ? { robots: new RobotsPolicy(this.#transport, { userAgent: this.#userAgent }) }
        : {}),
      ...(binding.budget === undefined ? {} : { budget: binding.budget }),
      ...(binding.signal === undefined ? {} : { signal: binding.signal }),
    });

    const context: PluginContext = {
      sourceId,
      http,
      log: logger,
      config: Object.freeze({ ...config }),
      secrets: buildSecretAccessor(sourceId, capabilities.secrets, binding.secrets ?? {}),
      cache: new BoundedCache(),
      clock: this.#clock,
      signal: binding.signal ?? binding.budget?.signal ?? new AbortController().signal,
      // La capacite navigateur est absente tant qu'elle n'est pas accordee :
      // le plugin doit se degrader proprement, pas tester un drapeau.
    };

    const entry: LoadedPlugin = {
      sourceId,
      manifest,
      plugin,
      context,
      http,
      capabilities,
      detected: detectCapabilities(plugin),
      state: "loaded",
    };

    // (j) init() sous delai plafond.
    try {
      await withTimeout(
        plugin.init(context),
        this.#initTimeoutMs,
        () => new PluginRejected(String(sourceId), `init() depasse ${this.#initTimeoutMs} ms`),
      );
    } catch (cause) {
      await plugin.dispose().catch(() => undefined);
      throw cause instanceof KernelError ? cause : classify(sourceId, cause);
    }

    entry.state = "ready";
    this.#loaded.set(sourceId, entry);
    this.#logger.info("plugin charge", {
      sourceId,
      version: manifest.version,
      capabilities: entry.detected,
      allowedHosts: capabilities.network.allowedHosts,
    });
    return entry;
  }

  /**
   * La quarantaine suspend, elle ne detruit rien : tout ce qui a deja ete
   * collecte reste intact et consultable (Vol. III, 6.3).
   */
  quarantine(sourceId: SourceId, reason: string): void {
    const entry = this.#loaded.get(sourceId);
    if (entry === undefined) return;
    entry.state = "quarantined";
    entry.quarantineReason = reason;
    this.#logger.warn("source mise en quarantaine", { sourceId, reason });
  }

  /** Reactivation strictement manuelle — jamais automatique (Vol. III, 6.2). */
  reactivate(sourceId: SourceId): void {
    const entry = this.#loaded.get(sourceId);
    if (entry === undefined || entry.state !== "quarantined") return;
    entry.state = "ready";
    delete entry.quarantineReason;
  }

  markActive(sourceId: SourceId): void {
    const entry = this.#loaded.get(sourceId);
    if (entry !== undefined && entry.state === "ready") entry.state = "active";
  }

  markIdle(sourceId: SourceId): void {
    const entry = this.#loaded.get(sourceId);
    if (entry !== undefined && entry.state === "active") entry.state = "ready";
  }

  /** `dispose()` est toujours appele, meme apres panne. */
  async dispose(sourceId: SourceId): Promise<void> {
    const entry = this.#loaded.get(sourceId);
    if (entry === undefined) return;
    try {
      await entry.plugin.dispose();
    } catch (error) {
      this.#logger.warn("dispose() en echec", { sourceId, error: describeUnknown(error) });
    } finally {
      entry.state = "disposed";
      this.#loaded.delete(sourceId);
    }
  }

  async disposeAll(): Promise<void> {
    for (const sourceId of [...this.#loaded.keys()]) {
      await this.dispose(sourceId);
    }
  }
}

// ---------------------------------------------------------------------------
// Instanciation et verification structurelle
// ---------------------------------------------------------------------------

async function instantiate(module: unknown, reference: string): Promise<SourcePlugin> {
  const candidate = (module as { default?: unknown }).default ?? module;

  if (typeof candidate === "function") {
    // Classe ou fabrique : les deux formes sont acceptees, aucune imposee.
    try {
      const constructed = new (candidate as new () => SourcePlugin)();
      return constructed;
    } catch {
      return (await (candidate as () => SourcePlugin | Promise<SourcePlugin>)()) as SourcePlugin;
    }
  }
  if (typeof candidate === "object" && candidate !== null) return candidate as SourcePlugin;
  throw new PluginRejected(reference, "le module n'exporte pas de plugin");
}

const REQUIRED_METHODS: readonly (keyof SourcePlugin)[] = ["init", "discover", "resolve", "dispose"];

function assertContract(plugin: SourcePlugin, reference: string): void {
  for (const method of REQUIRED_METHODS) {
    if (typeof plugin[method] !== "function") {
      throw new PluginRejected(reference, `methode obligatoire absente : ${String(method)}()`);
    }
  }
  if (typeof plugin.id !== "string" || plugin.id.length === 0) {
    throw new PluginRejected(reference, "le plugin n'expose pas d'identifiant");
  }
  if (typeof plugin.apiVersion !== "string") {
    throw new PluginRejected(reference, "le plugin n'expose pas d'apiVersion");
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Secrets et cache
// ---------------------------------------------------------------------------

function buildSecretAccessor(
  sourceId: SourceId,
  granted: readonly string[],
  values: Readonly<Record<string, string>>,
): SecretAccessor {
  return {
    async get(name: string): Promise<string | undefined> {
      if (!granted.includes(name)) {
        // Un secret non accorde n'existe pas du point de vue du plugin.
        throw new PluginRejected(String(sourceId), `secret non accorde : ${name}`);
      }
      return values[name];
    },
    has(name: string): boolean {
      return granted.includes(name) && values[name] !== undefined;
    },
  };
}

/** Cache borne, propre a la source, non durable — Volume III, 2.5. */
export class BoundedCache implements EphemeralCache {
  readonly #entries = new Map<string, unknown>();
  readonly #capacity: number;

  constructor(capacity = 1000) {
    this.#capacity = capacity;
  }

  get<T>(key: string): T | undefined {
    return this.#entries.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    if (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, value);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}
