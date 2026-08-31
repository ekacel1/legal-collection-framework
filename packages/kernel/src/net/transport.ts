/**
 * Transport HTTP — Volume II, chapitre 6.
 *
 * Le transport est la seule couche qui touche reellement le reseau. Tout ce qui
 * releve de la politique (quotas, politesse, robots, budget, retry) est au
 * dessus. Cette separation est ce qui rend le systeme testable hors ligne :
 * une suite de tests substitue le transport, jamais la politique.
 */
import type { Clock } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";

export interface HttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "HEAD";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** Delai d'obtention de la REPONSE, en-tetes compris — Volume II, 6.3. */
  readonly timeoutMs?: number;
  /** Delai maximal sans qu'un seul octet n'arrive, pendant le transfert. */
  readonly idleTimeoutMs?: number;
  /** Plafond absolu du transfert, garde-fou de dernier ressort. */
  readonly maxDurationMs?: number;
  readonly redirects?: { readonly follow: boolean; readonly maxHops: number };
}

export interface HttpRawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** URL finale, apres redirections. */
  readonly url: string;
  /** Corps en flux : un document de 200 Mio ne doit jamais tenir en memoire. */
  readonly body: AsyncIterable<Uint8Array>;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpRawResponse>;
}

/** Delai plafond par tentative — Volume II, 6.3. Porte sur la REPONSE seule. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Delai d'inactivite du transfert.
 *
 * Un delai TOTAL est un mauvais outil : il tue un telechargement qui progresse
 * normalement mais lentement, et il faudrait le relever a chaque fois qu'un
 * document plus gros apparait. Un delai d'inactivite mesure la seule chose qui
 * signale reellement une panne — l'absence d'octets — et laisse passer les
 * transferts lents, qui sont la norme sur une liaison lointaine.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** Plafond absolu : protege d'une source qui distille un octet par minute. */
export const DEFAULT_MAX_TRANSFER_MS = 30 * 60_000;

export interface IdleGuardOptions {
  readonly idleMs: number;
  readonly maxMs: number;
  readonly clock: Clock;
  /** Appele avant de lever, pour liberer la ressource sous-jacente. */
  readonly onGiveUp?: () => void;
}

/** `unique symbol` : c'est ce qui permet a TypeScript de discriminer la course. */
const IDLE: unique symbol = Symbol("idle");

/**
 * Enveloppe un flux d'octets d'une double garde : inactivite et duree totale.
 *
 * Chaque lecture est mise en course avec une attente. Si l'attente gagne, aucun
 * octet n'est arrive depuis `idleMs` et le transfert est abandonne. Sinon le
 * compteur repart de zero — c'est ce qui distingue « lent » de « mort ».
 *
 * Les messages contiennent « delai » a dessein : c'est ce que
 * `classifyBodyFailure` reconnait pour en faire un `NetworkTimeout`,
 * c'est-a-dire une erreur transitoire de portee document.
 */
export async function* withIdleGuard(
  source: AsyncIterable<Uint8Array>,
  options: IdleGuardOptions,
): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const startedAt = options.clock.nowMillis();
  let done = false;

  try {
    for (;;) {
      const waiter = new AbortController();
      const idle = options.clock
        .sleep(options.idleMs, waiter.signal)
        .then((): typeof IDLE => IDLE);
      // L'attente perdante est annulee : sans ce filet, une promesse rejetee
      // sans consommateur ferait tomber le processus.
      idle.catch(() => undefined);

      const pending = iterator.next();
      pending.catch(() => undefined);

      const winner = await Promise.race([pending, idle]);
      waiter.abort(new Error("lecture arrivee avant l'echeance"));

      if (winner === IDLE) {
        options.onGiveUp?.();
        throw new Error(`delai d'inactivite depasse : ${options.idleMs} ms sans octet recu`);
      }

      if (winner.done === true) {
        done = true;
        return;
      }
      if (winner.value !== undefined) yield winner.value;

      if (options.clock.nowMillis() - startedAt > options.maxMs) {
        options.onGiveUp?.();
        throw new Error(`delai maximal de transfert depasse : ${options.maxMs} ms`);
      }
    }
  } finally {
    // Fermeture SANS attendre : `return()` sur un generateur suspendu dans un
    // `await` ne prend effet qu'une fois cet await resolu. L'attendre ici
    // bloquerait donc pour toujours dans le seul cas qui compte — une source
    // figee, celle-la meme que la garde existe pour traiter. La liberation
    // reelle vient de `onGiveUp`, qui annule la requete sous-jacente.
    if (!done) void iterator.return?.()?.catch(() => undefined);
  }
}

/**
 * Transport reposant sur `fetch`, integre a Node depuis la version 18.
 * Aucune dependance externe : c'est une contrainte du Volume I (« sans API
 * Cloud, sans Docker obligatoire »), pas une preference.
 */
export class FetchHttpTransport implements HttpTransport {
  readonly #clock: Clock;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? new SystemClock();
  }

  async send(request: HttpRequest): Promise<HttpRawResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(
      () => controller.abort(new Error("delai de requete depasse")),
      timeoutMs,
    );

    const onExternalAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: request.redirects?.follow === false ? "manual" : "follow",
        signal: controller.signal,
      });

      // Les en-tetes sont arrives : le delai de REPONSE a joue son role et
      // s'efface. Le transfert qui suit releve de la garde d'inactivite.
      clearTimeout(timer);

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      return {
        status: response.status,
        headers,
        url: response.url,
        body: withIdleGuard(readBody(response), {
          idleMs: request.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
          maxMs: request.maxDurationMs ?? DEFAULT_MAX_TRANSFER_MS,
          clock: this.#clock,
          onGiveUp: () => controller.abort(new Error("transfert abandonne")),
        }),
      };
    } catch (error) {
      clearTimeout(timer);
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

async function* readBody(response: Response): AsyncGenerator<Uint8Array> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value !== undefined) yield chunk.value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Concatene un corps en flux. Reserve aux reponses courtes (pages, API). */
export async function collectBody(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
