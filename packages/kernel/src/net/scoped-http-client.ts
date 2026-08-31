/**
 * Client HTTP sous capacites — Volume III, chapitre 5.3.
 *
 * Ce n'est pas un client generique parametre : c'est un client construit POUR
 * une source, dont les limites ne sont pas modifiables depuis le plugin. Un
 * plugin ne peut donc pas contourner un quota, ignorer robots.txt, ni saturer
 * une source — non par discipline, mais par construction.
 */
import {
  CapabilityViolation,
  NetworkTimeout,
  PolicyViolation,
  RateLimited,
  SourceUnavailable,
  UnexpectedHttpStatus,
} from "../domain/errors.js";
import type { Clock, HttpClient, HttpResponse, Logger, RequestOptions } from "../domain/contract.js";
import type { SourceId } from "../domain/ids.js";
import {
  BudgetTracker,
  CircuitBreaker,
  DEFAULT_RETRY_POLICY,
  HostRateLimiter,
  backoffDelayMs,
  isRetryableStatus,
  parseRetryAfter,
  type NetworkCapability,
  type RetryPolicy,
} from "./policy.js";
import type { RobotsPolicy } from "./robots.js";
import {
  collectBody,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type HttpRawResponse,
  type HttpRequest,
  type HttpTransport,
} from "./transport.js";

/** En-tete d'identification obligatoire — Volume VI, 7.2. */
export function buildUserAgent(contact: string, version = "1.0"): string {
  return `LCF/${version} (Legal Collection Framework; +https://github.com/lcf; ${contact})`;
}

export interface ScopedHttpClientOptions {
  readonly sourceId: SourceId;
  readonly capability: NetworkCapability;
  readonly transport: HttpTransport;
  readonly limiter: HostRateLimiter;
  readonly breaker: CircuitBreaker;
  readonly clock: Clock;
  readonly userAgent: string;
  readonly budget?: BudgetTracker;
  readonly robots?: RobotsPolicy;
  readonly logger?: Logger;
  readonly retry?: RetryPolicy;
  readonly signal?: AbortSignal;
  readonly random?: () => number;
}

export class ScopedHttpClient implements HttpClient {
  readonly #options: ScopedHttpClientOptions;
  #budget: BudgetTracker | undefined;
  #bytesReceived = 0;
  #requestsMade = 0;

  constructor(options: ScopedHttpClientOptions) {
    this.#options = options;
    this.#budget = options.budget;
  }

  /**
   * Le budget est une notion d'EXECUTION, alors que le client est construit au
   * chargement du plugin. L'orchestrateur l'installe donc au demarrage de la
   * collecte et le retire a la fin — le plugin, lui, n'y a jamais acces.
   */
  useBudget(budget: BudgetTracker | undefined): void {
    this.#budget = budget;
  }

  /** Compteurs de l'execution en cours, remis a zero par l'orchestrateur. */
  resetCounters(): void {
    this.#requestsMade = 0;
    this.#bytesReceived = 0;
  }

  get requestsMade(): number {
    return this.#requestsMade;
  }

  get bytesReceived(): number {
    return this.#bytesReceived;
  }

  async get(url: string, opts?: RequestOptions): Promise<HttpResponse> {
    const response = await this.send({
      url,
      method: opts?.method ?? "GET",
      headers: { ...opts?.headers },
      ...(opts?.body === undefined ? {} : { body: opts.body }),
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    });

    const bytes = await collectBody(response.body);
    this.#bytesReceived += bytes.length;
    this.#budget?.chargeBytes(bytes.length);

    if (response.status < 200 || response.status >= 300) {
      throw new UnexpectedHttpStatus(this.#options.sourceId, response.status, url);
    }
    return { status: response.status, headers: response.headers, url: response.url, bytes };
  }

  async getText(url: string, opts?: RequestOptions): Promise<string> {
    return new TextDecoder().decode((await this.get(url, opts)).bytes);
  }

  async getJson<T = unknown>(url: string, opts?: RequestOptions): Promise<T> {
    return JSON.parse(await this.getText(url, opts)) as T;
  }

  /**
   * Envoi garde, avec repli exponentiel. Le corps est rendu en flux : le
   * Download Manager le streame vers le magasin sans jamais le materialiser.
   */
  async send(request: Omit<HttpRequest, "headers"> & { headers?: Record<string, string> }): Promise<HttpRawResponse> {
    const { capability, sourceId } = this.#options;
    const url = new URL(request.url);

    // 1. Filtre d'hotes — avant toute resolution DNS, donc avant tout paquet.
    if (!capability.allowedHosts.includes(url.host)) {
      throw new CapabilityViolation(sourceId, "network.host", url.host);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new CapabilityViolation(sourceId, "network.protocol", url.protocol);
    }

    // 2. robots.txt.
    if (capability.respectRobotsTxt && this.#options.robots !== undefined) {
      if (!(await this.#options.robots.allows(request.url))) {
        this.#options.logger?.warn("requete refusee par robots.txt", {
          url: request.url,
          rule: "robots.txt",
        });
        throw new PolicyViolation(sourceId, "robots.txt", request.url);
      }
    }

    const policy = this.#options.retry ?? DEFAULT_RETRY_POLICY;
    let lastError: unknown;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const delay = backoffDelayMs(attempt, policy, this.#options.random ?? Math.random);
      if (delay > 0) await this.#options.clock.sleep(delay, this.#options.signal);

      if (this.#options.breaker.isOpen) {
        throw new SourceUnavailable(sourceId, {
          context: { reason: "disjoncteur ouvert", url: request.url },
        });
      }

      // 3. Budget — chaque tentative est une requete reelle.
      this.#budget?.chargeRequest();
      this.#requestsMade++;

      // 4. Politesse et quota, par hote.
      await this.#options.limiter.acquire(url.host, capability);
      const sentAt = this.#options.clock.nowMillis();
      try {
        const response = await this.#options.transport.send({
          url: request.url,
          method: request.method,
          headers: {
            "user-agent": this.#options.userAgent,
            "accept-encoding": "gzip, deflate",
            ...request.headers,
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          timeoutMs: request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          ...(request.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: request.idleTimeoutMs }),
          ...(request.maxDurationMs === undefined
            ? {}
            : { maxDurationMs: request.maxDurationMs }),
          ...(request.redirects === undefined ? {} : { redirects: request.redirects }),
        });

        // La latence de REPONSE — en-tetes recus — mesure la sante de l'hote.
        // Le temps de transfert, lui, depend surtout de la taille du document.
        this.#options.limiter.observeLatency(
          url.host,
          this.#options.clock.nowMillis() - sentAt,
        );

        if (isRetryableStatus(response.status)) {
          this.#options.breaker.recordFailure();
          lastError =
            response.status === 429
              ? new RateLimited(
                  sourceId,
                  parseRetryAfter(response.headers["retry-after"], this.#options.clock.nowMillis()),
                  { context: { url: request.url } },
                )
              : new SourceUnavailable(sourceId, {
                  context: { url: request.url, status: response.status },
                });

          // `Retry-After` est toujours respecte — Volume VI, 7.2.
          const retryAfter = parseRetryAfter(
            response.headers["retry-after"],
            this.#options.clock.nowMillis(),
          );
          if (retryAfter !== undefined && attempt < policy.maxAttempts) {
            await this.#options.clock.sleep(retryAfter, this.#options.signal);
          }
          continue;
        }

        this.#options.breaker.recordSuccess();
        return response;
      } catch (error) {
        if (error instanceof CapabilityViolation || error instanceof PolicyViolation) throw error;
        if (isBudgetError(error)) throw error;
        this.#options.breaker.recordFailure();
        lastError = classifyTransport(sourceId, error, request.url);
      } finally {
        this.#options.limiter.release(url.host);
      }
    }

    throw lastError ?? new SourceUnavailable(sourceId, { context: { url: request.url } });
  }
}

function isBudgetError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { errorClass?: string }).errorClass === "BudgetExceeded"
  );
}

function classifyTransport(sourceId: SourceId, error: unknown, url: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|delai|abort/i.test(message)) {
    return new NetworkTimeout(sourceId, { cause: error, context: { url } });
  }
  return new SourceUnavailable(sourceId, { cause: error, context: { url } });
}
