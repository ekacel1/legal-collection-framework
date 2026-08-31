import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";

import { DownloadManager, mergeExpectations } from "../src/download/download-manager.js";
import { FilesystemContentStore } from "../src/storage/filesystem-content-store.js";
import { FixtureHttpTransport, type FixturePlan } from "../src/net/testing.js";
import { ScopedHttpClient, buildUserAgent } from "../src/net/scoped-http-client.js";
import {
  CircuitBreaker,
  HostRateLimiter,
  normalizeNetworkCapability,
} from "../src/net/policy.js";
import { ManualClock } from "../src/domain/clock.js";
import { IntegrityError, KernelError, NetworkTimeout } from "../src/domain/errors.js";
import { asSourceId, computeContentHash, computeDocumentId, newRunId } from "../src/domain/ids.js";
import { tempDir } from "./helpers.js";

const SOURCE = asSourceId("example.gazette");
const RUN = newRunId(1_700_000_000_000);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\ncontenu de l'acte\n");

let workspace: string;
let store: FilesystemContentStore;
let clock: ManualClock;
let manager: DownloadManager;

function clientFor(fixtures: FixturePlan): ScopedHttpClient {
  return new ScopedHttpClient({
    sourceId: SOURCE,
    capability: normalizeNetworkCapability({
      allowedHosts: ["gazette.example"],
      politenessDelayMs: 100,
      respectRobotsTxt: false,
    }),
    transport: new FixtureHttpTransport(fixtures),
    limiter: new HostRateLimiter(clock),
    breaker: new CircuitBreaker(clock),
    clock,
    userAgent: buildUserAgent("ops@example.org"),
    random: () => 0.5,
  });
}

function request(overrides: Record<string, unknown> = {}): never {
  return {
    runId: RUN,
    sourceId: SOURCE,
    documentId: computeDocumentId(SOURCE, "2024/118"),
    nativeId: "2024/118",
    plan: { kind: "http", url: "https://gazette.example/acts/2024-118.pdf" },
    ...overrides,
  } as never;
}

beforeEach(async () => {
  workspace = await tempDir("download");
  clock = new ManualClock(1_700_000_000_000, { autoAdvance: true });
  store = new FilesystemContentStore({ root: workspace, clock, fsync: false });
  await store.init();
  manager = new DownloadManager({ store, clock, random: () => 0.5 });
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

describe("Download Manager — execution du FetchPlan (Vol. III, 2.2)", () => {
  test("le plan HTTP est execute et les octets sont haches puis stockes", async () => {
    const http = clientFor({
      "https://gazette.example/acts/2024-118.pdf": {
        body: PDF_BYTES,
        headers: { "content-type": "application/pdf", etag: '"a1b2c3"' },
      },
    });

    const outcome = await manager.execute(http, request());
    assert.equal(outcome.status, "stored");
    if (outcome.status !== "stored") return;

    assert.equal(outcome.stored.contentHash, computeContentHash(PDF_BYTES));
    assert.equal(outcome.stored.detectedMime, "application/pdf");
    assert.equal(outcome.etag, '"a1b2c3"');
    assert.equal(outcome.attempt.outcome, "success");
    assert.equal(outcome.attempt.bytesReceived, PDF_BYTES.length);
    assert.deepEqual(await store.read(outcome.stored.contentHash), PDF_BYTES);
  });

  test("le type declare provient de l'en-tete quand le plugin n'en fournit pas", async () => {
    const http = clientFor({
      "https://gazette.example/acts/2024-118.pdf": {
        body: PDF_BYTES,
        headers: { "content-type": "application/pdf; charset=binary" },
      },
    });
    const outcome = await manager.execute(http, request());
    assert.equal(outcome.status === "stored" && outcome.stored.mimeType, "application/pdf");
  });

  test("un corps en plusieurs morceaux est streame sans etre materialise", async () => {
    const http = clientFor({
      "https://gazette.example/acts/2024-118.pdf": {
        chunks: ["%PDF-1.7\n", "contenu de l'acte\n"],
      },
    });
    const outcome = await manager.execute(http, request());
    assert.equal(outcome.status === "stored" && outcome.stored.contentHash, computeContentHash(PDF_BYTES));
  });

  test("une signature de fichier inattendue fait echouer la collecte du document", async () => {
    const http = clientFor({
      "https://gazette.example/acts/2024-118.pdf": { body: "<html>erreur 500</html>" },
    });

    await assert.rejects(
      manager.execute(
        http,
        request({
          plan: {
            kind: "http",
            url: "https://gazette.example/acts/2024-118.pdf",
            expect: { magicBytes: "25504446", mimeTypes: ["application/pdf"] },
          },
        }),
      ),
      IntegrityError,
    );
  });

  test("un 304 ne transfere aucun octet et ne cree aucune version", async () => {
    const http = clientFor({
      "https://gazette.example/acts/2024-118.pdf": { status: 304 },
    });

    const outcome = await manager.execute(
      http,
      request({ conditional: { etag: '"a1b2c3"' } }),
    );
    assert.equal(outcome.status, "not_modified");
    assert.equal(outcome.attempt.outcome, "skipped");
    assert.equal(outcome.attempt.bytesReceived, 0);
  });

  test("les en-tetes conditionnels sont emis quand la fraicheur est connue", async () => {
    const transport = new FixtureHttpTransport({
      "https://gazette.example/acts/2024-118.pdf": { status: 304 },
    });
    const http = new ScopedHttpClient({
      sourceId: SOURCE,
      capability: normalizeNetworkCapability({
        allowedHosts: ["gazette.example"],
        respectRobotsTxt: false,
      }),
      transport,
      limiter: new HostRateLimiter(clock),
      breaker: new CircuitBreaker(clock),
      clock,
      userAgent: buildUserAgent("ops@example.org"),
    });

    await manager.execute(
      http,
      request({ conditional: { etag: '"a1b2c3"', lastModified: "Tue, 14 Nov 2023 22:13:20 GMT" } }),
    );

    assert.equal(transport.calls[0]?.headers["if-none-match"], '"a1b2c3"');
    assert.equal(
      transport.calls[0]?.headers["if-modified-since"],
      "Tue, 14 Nov 2023 22:13:20 GMT",
    );
  });
});

describe("coupure pendant le transfert du corps", () => {
  test("une coupure en cours de transfert est une erreur reseau, pas une panne de source", async () => {
    const http = clientFor({
      "https://gazette.example/acts/2024-118.pdf": {
        chunks: ["%PDF-1.7\n"],
        bodyError: new Error("delai de requete depasse"),
      },
    });

    await assert.rejects(manager.execute(http, request()), (error: unknown) => {
      // Le defaut corrige : cette erreur remontait brute, devenait fatale, et
      // mettait en quarantaine une source parfaitement saine.
      assert.ok(error instanceof NetworkTimeout, `classe obtenue : ${String(error)}`);
      assert.equal(error.retryable, true);
      assert.equal(error.scope, "document");
      assert.equal(error.context["phase"], "body");
      return true;
    });
  });

  test("le transfert est reessaye et peut aboutir", async () => {
    const http = clientFor({
      "https://gazette.example/acts/2024-118.pdf": [
        { chunks: ["%PDF-1.7\n"], bodyError: new Error("connexion reinitialisee") },
        { body: PDF_BYTES, headers: { "content-type": "application/pdf" } },
      ],
    });

    const outcome = await manager.execute(http, request());
    assert.equal(outcome.status, "stored");
    assert.equal(outcome.status === "stored" && outcome.stored.contentHash, computeContentHash(PDF_BYTES));
  });

  test("une attente decue sur le contenu n'est jamais reessayee", async () => {
    const transport = new FixtureHttpTransport({
      "https://gazette.example/acts/2024-118.pdf": { body: "<html>404</html>" },
    });
    const http = new ScopedHttpClient({
      sourceId: SOURCE,
      capability: normalizeNetworkCapability({
        allowedHosts: ["gazette.example"],
        respectRobotsTxt: false,
      }),
      transport,
      limiter: new HostRateLimiter(clock),
      breaker: new CircuitBreaker(clock),
      clock,
      userAgent: buildUserAgent("ops@example.org"),
    });

    await assert.rejects(
      manager.execute(
        http,
        request({
          plan: {
            kind: "http",
            url: "https://gazette.example/acts/2024-118.pdf",
            expect: { magicBytes: "25504446" },
          },
        }),
      ),
      IntegrityError,
    );
    // Un document qui n'est pas le bon ne le deviendra pas en le redemandant.
    assert.equal(transport.callsTo("https://gazette.example/acts/2024-118.pdf"), 1);
  });

  test("aucun octet ne subsiste apres l'echec definitif d'un transfert", async () => {
    const http = clientFor({
      "https://gazette.example/acts/2024-118.pdf": {
        chunks: ["%PDF-1.7\n"],
        bodyError: new Error("delai de requete depasse"),
      },
    });
    await assert.rejects(manager.execute(http, request()));

    let objects = 0;
    for await (const _entry of store.scan()) {
      void _entry;
      objects++;
    }
    assert.equal(objects, 0);
  });
});

describe("Download Manager — echappatoire inline (Vol. III, 2.3)", () => {
  test("un contenu inline justifie est accepte", async () => {
    const http = clientFor({});
    const outcome = await manager.execute(
      http,
      request({
        plan: { kind: "inline", bytes: PDF_BYTES, reason: "l'API rend le contenu en base64" },
      }),
    );
    assert.equal(outcome.status === "stored" && outcome.stored.byteSize, PDF_BYTES.length);
  });

  test("un contenu inline sans justification est refuse", async () => {
    const http = clientFor({});
    await assert.rejects(
      manager.execute(
        http,
        request({ plan: { kind: "inline", bytes: PDF_BYTES, reason: "   " } }),
      ),
      /justification/,
    );
  });

  test("le plafond de 8 Mio est applique", async () => {
    const http = clientFor({});
    await assert.rejects(
      manager.execute(
        http,
        request({
          plan: {
            kind: "inline",
            bytes: new Uint8Array(9 * 1024 * 1024),
            reason: "trop gros",
          },
        }),
      ),
      IntegrityError,
    );
  });
});

describe("Download Manager — plans non supportes au Palier 0", () => {
  test("un plan navigateur est refuse avec un message actionnable", async () => {
    const http = clientFor({});
    await assert.rejects(
      manager.execute(
        http,
        request({
          plan: {
            kind: "browser",
            url: "https://gazette.example/app",
            capture: "pdf",
            requiresCapability: "browser",
          },
        }),
      ),
      (error: unknown) => error instanceof KernelError && /Palier 1/.test((error as Error).message),
    );
  });
});

describe("intersection des attentes", () => {
  test("la borne la plus stricte l'emporte toujours", () => {
    const merged = mergeExpectations(
      { minBytes: 100, maxBytes: 10_000_000, mimeTypes: ["application/pdf", "text/html"] },
      { minBytes: 1024, maxBytes: 209_715_200, mimeTypes: ["application/pdf"] },
    );
    assert.equal(merged?.minBytes, 1024);
    assert.equal(merged?.maxBytes, 10_000_000);
    assert.deepEqual(merged?.mimeTypes, ["application/pdf"]);
  });

  test("l'absence d'attente d'un cote conserve l'autre", () => {
    assert.deepEqual(mergeExpectations(undefined, { minBytes: 10 }), { minBytes: 10 });
    assert.deepEqual(mergeExpectations({ minBytes: 10 }, undefined), { minBytes: 10 });
    assert.equal(mergeExpectations(undefined, undefined), undefined);
  });
});
