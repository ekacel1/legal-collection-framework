/**
 * Download Manager — Volume II chapitre 6, Volume III chapitre 2.2.
 *
 * Le plugin ne telecharge pas : il retourne un plan. Le Download Manager
 * l'execute, et c'est la que se concentrent quotas, politesse, reessais,
 * verification et hachage. Un contributeur ne peut donc pas ecrire un
 * collecteur impoli, ni oublier de verifier une signature de fichier : ces
 * garanties ne dependent pas de lui.
 */
import {
  IntegrityError,
  KernelError,
  LcfError,
  NetworkTimeout,
  SourceUnavailable,
  UnresolvableDocument,
  describeUnknown,
} from "../domain/errors.js";
import type { DocumentId, IsoTimestamp, RunId, SourceId } from "../domain/ids.js";
import { toIsoTimestamp } from "../domain/ids.js";
import type { Clock, FetchExpectation, FetchPlan } from "../domain/contract.js";
import { INLINE_FETCH_MAX_BYTES } from "../domain/contract.js";
import type { Logger } from "../domain/contract.js";
import type { AttemptRecord } from "../db/repository.js";
import type { ContentStore, StoredObject } from "../storage/content-store.js";
import type { ScopedHttpClient } from "../net/scoped-http-client.js";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, type RetryPolicy } from "../net/policy.js";

/**
 * Delais du TRANSFERT, distincts des 30 s de reponse du Volume II, 6.3.
 *
 * Les 30 s du volume bornent l'obtention d'une reponse ; elles ne peuvent pas
 * borner le transfert d'un document de 200 Mio sur une liaison lente. Les
 * confondre revient a declarer en panne une source qui repond parfaitement,
 * simplement parce qu'elle est loin.
 *
 * Le transfert est donc borne par l'INACTIVITE — l'absence d'octets pendant
 * `DOWNLOAD_IDLE_TIMEOUT_MS` — et non par sa duree totale. Un plafond absolu
 * reste en dernier ressort, pour la source qui distille un octet par minute.
 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
export const DOWNLOAD_MAX_TRANSFER_MS = 30 * 60_000;

/** Tentatives supplementaires portant sur le CORPS de la reponse. */
export const BODY_RETRY_POLICY: RetryPolicy = Object.freeze({
  ...DEFAULT_RETRY_POLICY,
  maxAttempts: 3,
});

export interface DownloadRequest {
  readonly plan: FetchPlan;
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly documentId: DocumentId;
  readonly nativeId: string;
  /** Bornes du manifeste, intersectees avec celles du plan. */
  readonly expect?: FetchExpectation;
  readonly declaredMime?: string;
  /** Indices de fraicheur connus — niveaux N1 et N2 du Volume IV, 6.2. */
  readonly conditional?: { readonly etag?: string; readonly lastModified?: string };
}

export type DownloadOutcome =
  | {
      readonly status: "stored";
      readonly stored: StoredObject;
      readonly httpStatus?: number;
      readonly etag?: string;
      readonly lastModified?: string;
      readonly finalUrl?: string;
      readonly attempt: AttemptRecord;
    }
  | {
      /** La source affirme que rien n'a change : aucun octet n'a ete transfere. */
      readonly status: "not_modified";
      readonly httpStatus: number;
      readonly attempt: AttemptRecord;
    };

export interface DownloadManagerOptions {
  readonly store: ContentStore;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly bodyRetry?: RetryPolicy;
  readonly idleTimeoutMs?: number;
  readonly maxTransferMs?: number;
  readonly random?: () => number;
}

export class DownloadManager {
  readonly #store: ContentStore;
  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  readonly #bodyRetry: RetryPolicy;
  readonly #idleTimeoutMs: number;
  readonly #maxTransferMs: number;
  readonly #random: () => number;

  constructor(options: DownloadManagerOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#bodyRetry = options.bodyRetry ?? BODY_RETRY_POLICY;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
    this.#maxTransferMs = options.maxTransferMs ?? DOWNLOAD_MAX_TRANSFER_MS;
    this.#random = options.random ?? Math.random;
  }

  async execute(http: ScopedHttpClient, request: DownloadRequest): Promise<DownloadOutcome> {
    const startedAt = toIsoTimestamp(this.#clock.now());
    switch (request.plan.kind) {
      case "http":
        return this.#executeHttp(http, request, request.plan, startedAt);
      case "inline":
        return this.#executeInline(request, request.plan, startedAt);
      case "browser":
        throw new KernelError(
          "plan de type browser : la capacite navigateur releve du Palier 1 (Vol. IX, 4.2)",
          { context: { sourceId: request.sourceId, nativeId: request.nativeId } },
        );
      case "archive-member":
        throw new KernelError(
          "plan de type archive-member : la capacite archives releve du Palier 1 (Vol. IX, 4.2)",
          { context: { sourceId: request.sourceId, nativeId: request.nativeId } },
        );
      default:
        throw new UnresolvableDocument(request.sourceId, request.nativeId);
    }
  }

  /**
   * Le transfert du corps est reessaye separement de la requete.
   *
   * `send()` a deja son propre repli exponentiel, mais il ne couvre que
   * l'obtention de la reponse. Une coupure survenant PENDANT le transfert
   * echappait a toute classification : elle remontait brute, etait traitee
   * comme une erreur inattendue, donc fatale, et mettait en quarantaine une
   * source parfaitement saine. Un telechargement lent n'est pas une panne de
   * source — c'est le cas nominal d'une liaison lente.
   */
  async #executeHttp(
    http: ScopedHttpClient,
    request: DownloadRequest,
    plan: Extract<FetchPlan, { kind: "http" }>,
    startedAt: IsoTimestamp,
  ): Promise<DownloadOutcome> {
    const headers: Record<string, string> = { ...plan.headers };

    // N1 puis N2 : accelerateurs opportunistes. Seul le hachage fait autorite.
    if (request.conditional?.etag !== undefined) {
      headers["if-none-match"] = request.conditional.etag;
    }
    if (request.conditional?.lastModified !== undefined) {
      headers["if-modified-since"] = request.conditional.lastModified;
    }

    let lastError: LcfError | undefined;

    for (let attempt = 1; attempt <= this.#bodyRetry.maxAttempts; attempt++) {
      const delay = backoffDelayMs(attempt, this.#bodyRetry, this.#random);
      if (delay > 0) await this.#clock.sleep(delay);

      const response = await http.send({
        url: plan.url,
        method: plan.method ?? "GET",
        headers,
        idleTimeoutMs: this.#idleTimeoutMs,
        maxDurationMs: this.#maxTransferMs,
        ...(plan.body === undefined ? {} : { body: plan.body }),
        ...(plan.follow === undefined
          ? {}
          : { redirects: { follow: plan.follow.redirects, maxHops: plan.follow.maxHops } }),
      });

      if (response.status === 304) {
        // Le corps doit tout de meme etre draine : une connexion laissee
        // ouverte fuit aussi surement qu'un descripteur de fichier.
        for await (const _chunk of response.body) void _chunk;
        return {
          status: "not_modified",
          httpStatus: 304,
          attempt: {
            startedAt,
            endedAt: toIsoTimestamp(this.#clock.now()),
            url: plan.url,
            httpStatus: 304,
            bytesReceived: 0,
            outcome: "skipped",
          },
        };
      }

      const expect = mergeExpectations(plan.expect, request.expect);
      let stored: StoredObject;
      try {
        stored = await this.#store.store(response.body, {
          runId: request.runId,
          ...(request.declaredMime === undefined
            ? contentTypeOf(response.headers)
            : { declaredMime: request.declaredMime }),
          ...(expect === undefined ? {} : { expect }),
        });
      } catch (error) {
        // Une attente decue sur le contenu n'est pas un incident reseau : le
        // document est mauvais, le reessayer ne le rendra pas bon.
        if (error instanceof IntegrityError) throw error;

        lastError = classifyBodyFailure(request.sourceId, error, plan.url);
        this.#logger?.warn("transfert interrompu", {
          nativeId: request.nativeId,
          attempt,
          errorClass: lastError.errorClass,
        });
        continue;
      }

      this.#logger?.debug("document telecharge", {
        nativeId: request.nativeId,
        bytes: stored.byteSize,
        deduplicated: stored.deduplicated,
        attempt,
      });

      return {
        status: "stored",
        stored,
        httpStatus: response.status,
        ...(response.headers["etag"] === undefined ? {} : { etag: response.headers["etag"] }),
        ...(response.headers["last-modified"] === undefined
          ? {}
          : { lastModified: response.headers["last-modified"] }),
        finalUrl: response.url,
        attempt: {
          startedAt,
          endedAt: toIsoTimestamp(this.#clock.now()),
          url: plan.url,
          httpStatus: response.status,
          bytesReceived: stored.byteSize,
          outcome: "success",
        },
      };
    }

    throw lastError ?? new SourceUnavailable(request.sourceId, { context: { url: plan.url } });
  }

  /**
   * Echappatoire inline — Volume III, 2.3. Plafonnee et journalisee : elle
   * existe pour les API qui rendent le contenu dans leur reponse, pas pour
   * contourner le Download Manager.
   */
  async #executeInline(
    request: DownloadRequest,
    plan: Extract<FetchPlan, { kind: "inline" }>,
    startedAt: IsoTimestamp,
  ): Promise<DownloadOutcome> {
    if (plan.bytes.length > INLINE_FETCH_MAX_BYTES) {
      throw new IntegrityError(
        `contenu inline trop volumineux : ${plan.bytes.length} > ${INLINE_FETCH_MAX_BYTES}`,
        { context: { sourceId: request.sourceId, nativeId: request.nativeId } },
      );
    }
    if (plan.reason.trim().length === 0) {
      throw new KernelError("contenu inline sans justification : refuse pour l'audit", {
        context: { sourceId: request.sourceId, nativeId: request.nativeId },
      });
    }
    this.#logger?.info("contenu inline accepte", {
      nativeId: request.nativeId,
      bytes: plan.bytes.length,
      reason: plan.reason,
    });

    const stored = await this.#store.store(plan.bytes, {
      runId: request.runId,
      ...(request.declaredMime === undefined ? {} : { declaredMime: request.declaredMime }),
      ...(request.expect === undefined ? {} : { expect: request.expect }),
    });

    return {
      status: "stored",
      stored,
      attempt: {
        startedAt,
        endedAt: toIsoTimestamp(this.#clock.now()),
        bytesReceived: stored.byteSize,
        outcome: "success",
      },
    };
  }
}

/**
 * Une panne survenue pendant le transfert reste une panne RESEAU : elle porte
 * sur le document, elle est reessayable, et elle ne dit rien de la sante de la
 * source. La classer autrement revient a suspendre une source entiere sur une
 * connexion coupee.
 */
function classifyBodyFailure(sourceId: SourceId, error: unknown, url: string): LcfError {
  if (error instanceof LcfError) return error;
  const message = describeUnknown(error);
  if (/timeout|delai|abort|annul/i.test(message)) {
    return new NetworkTimeout(sourceId, { cause: error, context: { url, phase: "body" } });
  }
  return new SourceUnavailable(sourceId, { cause: error, context: { url, phase: "body" } });
}

function contentTypeOf(headers: Readonly<Record<string, string>>): { declaredMime?: string } {
  const value = headers["content-type"];
  if (value === undefined) return {};
  const mime = value.split(";")[0]?.trim();
  return mime === undefined || mime.length === 0 ? {} : { declaredMime: mime };
}

/**
 * Intersection des attentes du plan et de celles du manifeste.
 * La borne la plus stricte l'emporte toujours : un plugin ne peut pas elargir
 * une limite fixee par l'exploitation.
 */
export function mergeExpectations(
  fromPlan: FetchExpectation | undefined,
  fromManifest: FetchExpectation | undefined,
): FetchExpectation | undefined {
  if (fromPlan === undefined) return fromManifest;
  if (fromManifest === undefined) return fromPlan;

  const mimeTypes =
    fromPlan.mimeTypes === undefined
      ? fromManifest.mimeTypes
      : fromManifest.mimeTypes === undefined
        ? fromPlan.mimeTypes
        : fromPlan.mimeTypes.filter((mime) => fromManifest.mimeTypes?.includes(mime));

  return {
    ...(mimeTypes === undefined ? {} : { mimeTypes }),
    ...maxOf("minBytes", fromPlan.minBytes, fromManifest.minBytes),
    ...minOf("maxBytes", fromPlan.maxBytes, fromManifest.maxBytes),
    ...(fromPlan.magicBytes === undefined
      ? fromManifest.magicBytes === undefined
        ? {}
        : { magicBytes: fromManifest.magicBytes }
      : { magicBytes: fromPlan.magicBytes }),
  };
}

function maxOf(key: "minBytes", a?: number, b?: number): Record<string, number> {
  const values = [a, b].filter((value): value is number => value !== undefined);
  return values.length === 0 ? {} : { [key]: Math.max(...values) };
}

function minOf(key: "maxBytes", a?: number, b?: number): Record<string, number> {
  const values = [a, b].filter((value): value is number => value !== undefined);
  return values.length === 0 ? {} : { [key]: Math.min(...values) };
}
