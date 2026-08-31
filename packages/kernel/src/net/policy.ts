/**
 * Politiques reseau — Volume II 6.3, Volume III 5.3, Volume VI chapitre 7.
 *
 * « Sa conception doit rendre le comportement respectueux plus simple que le
 * comportement agressif. » Ces classes sont l'application de cette phrase :
 * un plugin ne peut pas saturer une source, non par discipline, mais parce que
 * le client qu'on lui donne ne sait pas le faire.
 */
import { BudgetExceeded } from "../domain/errors.js";
import type { Clock } from "../domain/contract.js";
import type { DiscoveryBudget } from "../domain/contract.js";

// ---------------------------------------------------------------------------
// Capacite reseau, telle que le manifeste la demande
// ---------------------------------------------------------------------------

export interface NetworkCapability {
  readonly allowedHosts: readonly string[];
  readonly maxRequestsPerMinute: number;
  readonly politenessDelayMs: number;
  readonly respectRobotsTxt: boolean;
  readonly maxConcurrentPerHost?: number;
}

/** Defauts imposes — Volume VI, 7.2. Le plancher de politesse est de 100 ms. */
export const NETWORK_DEFAULTS = Object.freeze({
  politenessDelayMs: 1000,
  minPolitenessDelayMs: 100,
  maxRequestsPerMinute: 60,
  maxConcurrentPerHost: 2,
  maxConcurrentPerHostCeiling: 10,
  respectRobotsTxt: true,
});

export function normalizeNetworkCapability(
  requested: Partial<NetworkCapability> & { allowedHosts: readonly string[] },
): NetworkCapability {
  const concurrency = Math.min(
    requested.maxConcurrentPerHost ?? NETWORK_DEFAULTS.maxConcurrentPerHost,
    NETWORK_DEFAULTS.maxConcurrentPerHostCeiling,
  );
  return {
    allowedHosts: [...requested.allowedHosts],
    maxRequestsPerMinute:
      requested.maxRequestsPerMinute ?? NETWORK_DEFAULTS.maxRequestsPerMinute,
    politenessDelayMs: Math.max(
      requested.politenessDelayMs ?? NETWORK_DEFAULTS.politenessDelayMs,
      NETWORK_DEFAULTS.minPolitenessDelayMs,
    ),
    respectRobotsTxt: requested.respectRobotsTxt ?? NETWORK_DEFAULTS.respectRobotsTxt,
    maxConcurrentPerHost: Math.max(1, concurrency),
  };
}

// ---------------------------------------------------------------------------
// Limiteur de debit par hote
// ---------------------------------------------------------------------------

interface HostState {
  /**
   * `null` tant qu'aucune requete n'a ete emise.
   *
   * Un zero servait auparavant de sentinelle — jusqu'a ce qu'une horloge
   * demarrant a zero rende la premiere requete indiscernable de l'absence de
   * requete, et desactive silencieusement toute politesse.
   */
  lastRequestAt: number | null;
  timestamps: number[];
  inFlight: number;
  queue: (() => void)[];
  /** Moyenne mobile rapide de la latence : l'etat present de l'hote. */
  fastLatency: number;
  /** Moyenne mobile lente : ce que l'hote sait faire quand il va bien. */
  baseline: number;
  samples: number;
}

/**
 * Ralentissement adaptatif — reagir a une source qui SOUFFRE, pas seulement a
 * une source qui echoue.
 *
 * Un serveur surcharge ne renvoie pas d'erreur : il repond de plus en plus
 * lentement. Le disjoncteur et le repli exponentiel ne se declenchent qu'apres
 * une panne franche, donc trop tard. Comparer la latence courante a la latence
 * de reference permet de lever le pied avant que la panne n'arrive.
 */
export const ADAPTIVE = Object.freeze({
  /** Nombre de mesures avant de se fier a la reference. */
  warmupSamples: 5,
  /** Ratio a partir duquel on considere que l'hote se degrade. */
  slowdownRatio: 2,
  /** Multiplicateur maximal applique au delai de politesse. */
  maxMultiplier: 8,
  /** Poids de la mesure nouvelle dans la moyenne rapide. */
  fastAlpha: 0.3,
  /**
   * Poids d'une mesure PLUS LENTE dans la reference — volontairement minuscule.
   *
   * Avec une valeur plus forte, la reference rattrapait la degradation en
   * quelques dizaines de mesures et le ralentissement se dissipait tout seul,
   * juste au moment ou il servait. La reference doit reagir vite a une
   * amelioration et n'accepter qu'avec lenteur qu'un hote soit devenu durablement
   * plus lent : il faut environ deux cents mesures pour qu'elle s'y resigne.
   */
  baselineAlpha: 0.01,
});

/**
 * Politesse et quota, par hote et non par source : deux sources visant le meme
 * hote doivent se partager la charge qu'elles lui imposent, sinon la politesse
 * n'est qu'une declaration.
 */
export class HostRateLimiter {
  readonly #hosts = new Map<string, HostState>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Enregistre la latence observee pour un hote.
   *
   * La reference ne monte que lentement et ne descend jamais brutalement : une
   * seule reponse rapide ne doit pas effacer le constat d'une degradation.
   */
  observeLatency(host: string, latencyMs: number): void {
    const state = this.#stateOf(host);
    state.samples++;

    if (state.samples === 1) {
      state.fastLatency = latencyMs;
      state.baseline = latencyMs;
      return;
    }
    state.fastLatency =
      ADAPTIVE.fastAlpha * latencyMs + (1 - ADAPTIVE.fastAlpha) * state.fastLatency;
    // La reference suit surtout les temps courts : elle represente l'hote en
    // bonne sante, pas sa moyenne toutes conditions confondues.
    const alpha = latencyMs < state.baseline ? ADAPTIVE.fastAlpha : ADAPTIVE.baselineAlpha;
    state.baseline = alpha * latencyMs + (1 - alpha) * state.baseline;
  }

  /** Multiplicateur de politesse courant pour un hote. 1 = rien a signaler. */
  slowdownFactor(host: string): number {
    const state = this.#stateOf(host);
    if (state.samples < ADAPTIVE.warmupSamples || state.baseline <= 0) return 1;

    const ratio = state.fastLatency / state.baseline;
    if (ratio <= ADAPTIVE.slowdownRatio) return 1;
    return Math.min(ratio, ADAPTIVE.maxMultiplier);
  }

  async acquire(host: string, capability: NetworkCapability): Promise<void> {
    const state = this.#stateOf(host);
    const maxConcurrent = capability.maxConcurrentPerHost ?? 1;

    while (state.inFlight >= maxConcurrent) {
      await new Promise<void>((resolve) => state.queue.push(resolve));
    }
    state.inFlight++;

    const now = this.#clock.nowMillis();
    // Le delai negocie est un plancher, jamais un plafond : si l'hote ralentit,
    // on s'ecarte davantage.
    const politeness = capability.politenessDelayMs * this.slowdownFactor(host);
    const politenessWait =
      state.lastRequestAt === null
        ? 0
        : Math.max(0, politeness - (now - state.lastRequestAt));

    // Quota glissant sur une minute.
    state.timestamps = state.timestamps.filter((at) => now - at < 60_000);
    const quotaWait =
      state.timestamps.length >= capability.maxRequestsPerMinute
        ? Math.max(0, 60_000 - (now - (state.timestamps[0] as number)))
        : 0;

    const wait = Math.max(politenessWait, quotaWait);
    if (wait > 0) await this.#clock.sleep(wait);

    const acquiredAt = this.#clock.nowMillis();
    state.lastRequestAt = acquiredAt;
    state.timestamps.push(acquiredAt);
  }

  release(host: string): void {
    const state = this.#stateOf(host);
    state.inFlight = Math.max(0, state.inFlight - 1);
    const next = state.queue.shift();
    next?.();
  }

  #stateOf(host: string): HostState {
    let state = this.#hosts.get(host);
    if (state === undefined) {
      state = {
        lastRequestAt: null,
        timestamps: [],
        inFlight: 0,
        queue: [],
        fastLatency: 0,
        baseline: 0,
        samples: 0,
      };
      this.#hosts.set(host, state);
    }
    return state;
  }
}

// ---------------------------------------------------------------------------
// Disjoncteur
// ---------------------------------------------------------------------------

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
}

/**
 * Un disjoncteur protege la source autant que le collecteur : marteler un
 * serveur deja en difficulte transforme une panne passagere en incident.
 */
export class CircuitBreaker {
  #failures = 0;
  #openedAt = 0;
  #state: BreakerState = "closed";
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #clock: Clock;

  constructor(clock: Clock, options: CircuitBreakerOptions = {}) {
    this.#clock = clock;
    this.#threshold = options.failureThreshold ?? 5;
    this.#cooldownMs = options.cooldownMs ?? 60_000;
  }

  get state(): BreakerState {
    if (this.#state === "open" && this.#clock.nowMillis() - this.#openedAt >= this.#cooldownMs) {
      this.#state = "half-open";
    }
    return this.#state;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#state = "closed";
  }

  recordFailure(): void {
    this.#failures++;
    if (this.#failures >= this.#threshold) {
      this.#state = "open";
      this.#openedAt = this.#clock.nowMillis();
    }
  }
}

// ---------------------------------------------------------------------------
// Budget d'execution
// ---------------------------------------------------------------------------

export interface BudgetSnapshot {
  readonly requests: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}

/**
 * Le budget n'est pas indicatif — Volume III, 3.4. Son epuisement declenche
 * l'AbortSignal : l'enumeration s'interrompt proprement et les documents deja
 * decouverts sont conserves.
 */
export class BudgetTracker {
  #requests = 0;
  #bytes = 0;
  readonly #startedAt: number;
  readonly #budget: DiscoveryBudget;
  readonly #clock: Clock;
  readonly #controller = new AbortController();

  constructor(budget: DiscoveryBudget, clock: Clock) {
    this.#budget = budget;
    this.#clock = clock;
    this.#startedAt = clock.nowMillis();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get snapshot(): BudgetSnapshot {
    return {
      requests: this.#requests,
      bytes: this.#bytes,
      elapsedMs: this.#clock.nowMillis() - this.#startedAt,
    };
  }

  chargeRequest(): void {
    this.#requests++;
    if (this.#requests > this.#budget.maxRequests) {
      this.#exceed("requests", this.#budget.maxRequests);
    }
    this.checkDuration();
  }

  chargeBytes(count: number): void {
    this.#bytes += count;
    if (this.#bytes > this.#budget.maxBytes) {
      this.#exceed("bytes", this.#budget.maxBytes);
    }
  }

  checkDuration(): void {
    if (this.#clock.nowMillis() - this.#startedAt > this.#budget.maxDurationMs) {
      this.#exceed("duration", this.#budget.maxDurationMs);
    }
  }

  #exceed(dimension: "requests" | "bytes" | "duration", limit: number): never {
    const error = new BudgetExceeded(dimension, limit);
    this.#controller.abort(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Repli exponentiel
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly jitterRatio: number;
}

/** Volume II, 6.3 : immediat, 1 s, 4 s, 16 s, cinq tentatives au maximum. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 1000,
  factor: 4,
  jitterRatio: 0.2,
});

/**
 * Le jitter n'est pas un raffinement : sans lui, mille documents en echec
 * reessaient exactement au meme instant et reproduisent la panne qu'ils
 * attendaient de voir disparaitre.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  if (attempt <= 1) return 0;
  const base = policy.baseDelayMs * policy.factor ** (attempt - 2);
  const jitter = base * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** `Retry-After` est toujours respecte — Volume VI, 7.2. */
export function parseRetryAfter(value: string | undefined, nowMillis: number): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMillis);
}
