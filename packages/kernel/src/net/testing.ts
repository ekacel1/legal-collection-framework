/**
 * Transport de test sur fixtures — Volume VIII, chapitre 3.
 *
 * Ce double vit dans le noyau parce qu'il double un port du noyau : le placer
 * ailleurs obligerait le paquet de test a dependre du noyau, et le noyau du
 * paquet de test pour ses propres tests — un cycle.
 *
 * Une suite de tests ne touche jamais le reseau. Les echanges HTTP sont
 * enregistres, versionnes, et rejoues : c'est ce qui rend un test de plugin
 * reproductible cinq ans apres son ecriture, quand la source aura change.
 */
import type { HttpRawResponse, HttpRequest, HttpTransport } from "./transport.js";

export interface FixtureResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** Leve au lieu de repondre : simule une panne reseau. */
  readonly error?: Error;
  /** Corps rendu en plusieurs morceaux, pour verifier le streaming. */
  readonly chunks?: readonly (string | Uint8Array)[];
  /**
   * Interrompt le flux APRES les morceaux deja emis.
   * Reproduit la panne la plus courante et la plus mal geree : la coupure en
   * cours de transfert, une fois la reponse acceptee.
   */
  readonly bodyError?: Error;
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly at: number;
}

export interface FixtureTransportOptions {
  /** Reponse rendue pour une URL absente du plan. Defaut : 404. */
  readonly fallback?: FixtureResponse;
  readonly now?: () => number;
}

/**
 * Plan de reponses par URL. Une valeur unique est rendue a chaque appel ; un
 * tableau est consomme dans l'ordre, ce qui permet de scenariser une panne
 * suivie d'une reussite (test de repli exponentiel).
 */
export type FixturePlan = Record<string, FixtureResponse | FixtureResponse[]>;

export class FixtureHttpTransport implements HttpTransport {
  readonly calls: RecordedCall[] = [];
  readonly #plan: Map<string, FixtureResponse[]>;
  readonly #single: Map<string, FixtureResponse>;
  readonly #fallback: FixtureResponse;
  readonly #now: () => number;

  constructor(plan: FixturePlan = {}, options: FixtureTransportOptions = {}) {
    this.#plan = new Map();
    this.#single = new Map();
    for (const [url, response] of Object.entries(plan)) {
      if (Array.isArray(response)) this.#plan.set(url, [...response]);
      else this.#single.set(url, response);
    }
    this.#fallback = options.fallback ?? { status: 404, body: "not found" };
    this.#now = options.now ?? Date.now;
  }

  /** Nombre d'appels effectues vers une URL donnee. */
  callsTo(url: string): number {
    return this.calls.filter((call) => call.url === url).length;
  }

  async send(request: HttpRequest): Promise<HttpRawResponse> {
    this.calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      at: this.#now(),
    });

    const queued = this.#plan.get(request.url);
    const fixture =
      queued !== undefined && queued.length > 0
        ? (queued.shift() as FixtureResponse)
        : (this.#single.get(request.url) ?? this.#fallback);

    if (fixture.error !== undefined) throw fixture.error;

    const chunks = fixture.chunks ?? (fixture.body === undefined ? [] : [fixture.body]);
    const encoded = chunks.map((chunk) =>
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
    );

    return {
      status: fixture.status ?? 200,
      headers: lowercase(fixture.headers ?? {}),
      url: request.url,
      body: (async function* () {
        for (const chunk of encoded) yield chunk;
        if (fixture.bodyError !== undefined) throw fixture.bodyError;
      })(),
    };
  }
}

function lowercase(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}
