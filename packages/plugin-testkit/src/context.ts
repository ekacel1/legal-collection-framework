/**
 * Fabrique de contexte de plugin — Volume VIII, chapitre 3.
 *
 * Un auteur de plugin doit pouvoir instancier son plugin en trois lignes, hors
 * ligne, avec une horloge fixe. Sans cela, les tests de plugin ne sont pas
 * ecrits, et le contrat n'est verifie qu'en production.
 */
import {
  CircuitBreaker,
  HostRateLimiter,
  ManualClock,
  ScopedHttpClient,
  SilentLogger,
  asSourceId,
  buildUserAgent,
  normalizeNetworkCapability,
  type Clock,
  type EphemeralCache,
  type HttpTransport,
  type Logger,
  type PluginContext,
  type SecretAccessor,
  type SourceId,
  FixtureHttpTransport,
  type FixturePlan,
} from "@lcf/kernel";


export interface TestContextOptions {
  readonly sourceId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly fixtures?: FixturePlan;
  readonly transport?: HttpTransport;
  readonly allowedHosts?: readonly string[];
  readonly secrets?: Readonly<Record<string, string>>;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /** Politesse desactivee par defaut : un test ne doit pas durer une minute. */
  readonly politenessDelayMs?: number;
}

export interface TestContext {
  readonly ctx: PluginContext;
  readonly transport: HttpTransport;
  readonly http: ScopedHttpClient;
  readonly clock: ManualClock;
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const sourceId = asSourceId(options.sourceId ?? "example.test.source") as SourceId;
  // autoAdvance : la politesse reseau et le repli exponentiel attendent
  // d'eux-memes ; sans cette option, un test de plugin se figerait.
  const clock =
    (options.clock as ManualClock) ??
    new ManualClock(1_700_000_000_000, { autoAdvance: true });
  const transport = options.transport ?? new FixtureHttpTransport(options.fixtures ?? {});
  const logger = options.logger ?? new SilentLogger();

  const capability = normalizeNetworkCapability({
    allowedHosts: options.allowedHosts ?? ["example.test"],
    politenessDelayMs: options.politenessDelayMs ?? 100,
    respectRobotsTxt: false,
  });

  const http = new ScopedHttpClient({
    sourceId,
    capability,
    transport,
    limiter: new HostRateLimiter(clock),
    breaker: new CircuitBreaker(clock),
    clock,
    userAgent: buildUserAgent("tests@example.org"),
    logger,
    // Sans jitter, les durees d'attente sont exactes et les tests lisibles.
    random: () => 0.5,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const secrets: SecretAccessor = {
    async get(name: string): Promise<string | undefined> {
      return options.secrets?.[name];
    },
    has(name: string): boolean {
      return options.secrets?.[name] !== undefined;
    },
  };

  const store = new Map<string, unknown>();
  const cache: EphemeralCache = {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      store.set(key, value);
    },
    delete(key: string): void {
      store.delete(key);
    },
    get size(): number {
      return store.size;
    },
  };

  const ctx: PluginContext = {
    sourceId,
    http,
    log: logger,
    config: options.config ?? {},
    secrets,
    cache,
    clock,
    signal: options.signal ?? new AbortController().signal,
  };

  return { ctx, transport, http, clock };
}

/** Consomme un flux asynchrone en tableau : pratique pour tester `discover`. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
