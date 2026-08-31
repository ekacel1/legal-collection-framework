/**
 * Orchestrateur de collecte — reprise incrémentale et balayage complet imposé.
 *
 * Volume III, 7.3 : le mode incrémental est une optimisation, jamais une source
 * de vérité. Ces tests vérifient les deux moitiés de cette phrase — que la
 * reprise fonctionne, et qu'elle ne peut pas dériver indéfiniment.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { CollectionRunner } from "../src/orchestration/collection-runner.js";
import { DownloadManager } from "../src/download/download-manager.js";
import { FilesystemContentStore } from "../src/storage/filesystem-content-store.js";
import { SqliteDriver } from "../src/db/sqlite-driver.js";
import { MigrationRunner } from "../src/db/migrations.js";
import { SqlDocumentRepository } from "../src/db/sql-repository.js";
import { InMemoryEventBus } from "../src/events/in-memory-event-bus.js";
import { PluginManager } from "../src/plugins/plugin-manager.js";
import type {
  HttpRawResponse,
  HttpRequest,
  HttpTransport,
} from "../src/net/transport.js";
import { ScopedHttpClient, buildUserAgent } from "../src/net/scoped-http-client.js";
import { CircuitBreaker, HostRateLimiter, normalizeNetworkCapability } from "../src/net/policy.js";
import { ManualClock } from "../src/domain/clock.js";
import { RecordingLogger } from "../src/observability/logger.js";
import { asSourceId, computeContentHash, computeDocumentId, type SourceId } from "../src/domain/ids.js";
import { UnresolvableDocument } from "../src/domain/errors.js";
import type {
  CheckpointState,
  DiscoveryScope,
  DocumentRef,
  FetchPlan,
  PluginContext,
  SourcePlugin,
} from "../src/domain/contract.js";
import type { LoadedPlugin } from "../src/plugins/plugin-manager.js";
import type { PluginManifest } from "../src/plugins/manifest.js";
import { migrationsDir, tempDir } from "./helpers.js";

const SOURCE = asSourceId("example.portal");
const HOST = "portal.example";
const PDF = (id: string): Uint8Array => new TextEncoder().encode(`%PDF-1.7\nacte ${id}\n`);

const MANIFEST: PluginManifest = {
  manifestVersion: 1,
  id: "example.portal",
  name: "Portal",
  version: "1.0.0",
  apiVersion: "^1.0",
  entry: "./index.js",
  capabilities: { network: { allowedHosts: [HOST] } },
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  integrity: { maxDocumentBytes: 10 * 1024 * 1024 },
};

/** Plugin de test : journalise ce que l'orchestrateur lui demande. */
class SpyPlugin implements SourcePlugin {
  readonly id: SourceId = SOURCE;
  readonly apiVersion = "1.0" as const;

  readonly restored: CheckpointState[] = [];
  readonly scopes: DiscoveryScope[] = [];
  documents: string[] = ["a", "b"];
  /** Indices de fraicheur annonces par l'index, par document. */
  etags = new Map<string, string>();
  highWaterMark = "2026-01-01";
  /** Documents que `resolve` refuse de resoudre, pour simuler un echec. */
  unresolvable = new Set<string>();
  /** Documents dont la resolution exige la charge utile `extra`. */
  requiresExtra = new Set<string>();
  readonly resolved: string[] = [];

  async init(_ctx: PluginContext): Promise<void> {}

  async *discover(scope: DiscoveryScope): AsyncIterable<DocumentRef> {
    this.scopes.push(scope);
    for (const id of this.documents) {
      const etag = this.etags.get(id);
      yield {
        nativeId: id,
        url: `https://${HOST}/doc/${id}`,
        declaredMime: "application/pdf",
        extra: { page: 0 },
        ...(etag === undefined ? {} : { etag }),
      };
    }
  }

  async resolve(ref: DocumentRef): Promise<FetchPlan> {
    this.resolved.push(ref.nativeId);
    if (this.unresolvable.has(ref.nativeId)) {
      throw new UnresolvableDocument(SOURCE, ref.nativeId);
    }
    if (this.requiresExtra.has(ref.nativeId) && ref.extra === undefined) {
      throw new UnresolvableDocument(SOURCE, ref.nativeId);
    }
    return { kind: "http", url: `https://${HOST}/doc/${ref.nativeId}.pdf` };
  }

  async checkpoint(): Promise<CheckpointState> {
    return { version: 1, highWaterMark: this.highWaterMark, cursor: "c-42" };
  }

  async restore(state: CheckpointState): Promise<void> {
    this.restored.push(state);
  }

  async dispose(): Promise<void> {}
}

interface Harness {
  readonly runner: CollectionRunner;
  readonly repository: SqlDocumentRepository;
  readonly bus: InMemoryEventBus;
  /** Reecrit le contenu servi pour un document, sans changer le moindre indice. */
  rewrite(id: string, content: string): void;
  readonly loaded: LoadedPlugin;
  readonly plugin: SpyPlugin;
  readonly logger: RecordingLogger;
  readonly clock: ManualClock;
  close(): Promise<void>;
}

let workspace: string;
let harness: Harness;

/**
 * Transport servant des corps modifiables en cours de test : c'est ce qui
 * permet de simuler une source qui republie un contenu sans toucher a ses
 * indices de fraicheur — le cas que N3 seul peut detecter.
 */
class MutableTransport implements HttpTransport {
  readonly bodies = new Map<string, Uint8Array>();

  constructor() {
    for (const id of ["a", "b", "c"]) this.bodies.set(id, PDF(id));
  }

  async send(request: HttpRequest): Promise<HttpRawResponse> {
    const id = /\/doc\/([^/.]+)\.pdf$/.exec(request.url)?.[1];
    const body = id === undefined ? undefined : this.bodies.get(id);
    const chunks = body === undefined ? [] : [body];

    return {
      status: body === undefined ? 404 : 200,
      headers: { "content-type": "application/pdf" },
      url: request.url,
      body: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    };
  }
}

interface HarnessOptions {
  readonly fullSweepEveryMs?: number;
  readonly maxRetriesPerRun?: number;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new ManualClock(1_700_000_000_000, { autoAdvance: true });
  const logger = new RecordingLogger();

  const store = new FilesystemContentStore({ root: workspace, clock, fsync: false });
  await store.init();

  const driver = new SqliteDriver({ path: path.join(workspace, "index", "lcf.db") });
  await new MigrationRunner(driver, { directory: migrationsDir(), clock }).migrate();
  const repository = new SqlDocumentRepository(driver, { clock });

  await repository.registerSource({
    sourceId: SOURCE,
    pluginId: "example.portal",
    pluginVersion: "1.0.0",
    apiVersion: "1.0",
    displayName: "Portal",
    config: {},
  });

  const plugin = new SpyPlugin();
  const transport = new MutableTransport();
  const bus = new InMemoryEventBus();
  const http = new ScopedHttpClient({
    sourceId: SOURCE,
    capability: normalizeNetworkCapability({
      allowedHosts: [HOST],
      politenessDelayMs: 100,
      respectRobotsTxt: false,
    }),
    transport,
    limiter: new HostRateLimiter(clock),
    breaker: new CircuitBreaker(clock),
    clock,
    userAgent: buildUserAgent("tests@example.org"),
    random: () => 0.5,
  });

  const loaded: LoadedPlugin = {
    sourceId: SOURCE,
    manifest: MANIFEST,
    plugin,
    context: {} as PluginContext,
    http,
    capabilities: {
      network: normalizeNetworkCapability({ allowedHosts: [HOST] }),
      browser: false,
      archives: [],
      inlineContent: false,
      secrets: [],
    },
    detected: {
      describable: false,
      paged: false,
      incremental: true,
      healthReporting: false,
      browserAssisted: false,
    },
    state: "ready",
  };

  const runner = new CollectionRunner({
    repository,
    store,
    downloads: new DownloadManager({ store, clock, random: () => 0.5 }),
    plugins: new PluginManager({ clock, userAgent: buildUserAgent("tests@example.org") }),
    bus,
    clock,
    logger,
    ...(options.fullSweepEveryMs === undefined
      ? {}
      : { fullSweepEveryMs: options.fullSweepEveryMs }),
    ...(options.maxRetriesPerRun === undefined
      ? {}
      : { maxRetriesPerRun: options.maxRetriesPerRun }),
  });

  return {
    runner,
    repository,
    bus,
    loaded,
    plugin,
    logger,
    clock,
    rewrite: (id: string, content: string): void => {
      transport.bodies.set(id, new TextEncoder().encode(content));
    },
    close: async () => driver.close(),
  };
}

beforeEach(async () => {
  workspace = await tempDir("runner");
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
  await fsp.rm(workspace, { recursive: true, force: true });
});

describe("enregistrement du checkpoint", () => {
  test("l'etat de reprise du plugin est conserve a la cloture", async () => {
    const summary = await harness.runner.run(harness.loaded, { mode: "full" });
    const run = await harness.repository.getRun(summary.runId);

    assert.equal(summary.status, "completed");
    assert.match(String(run?.checkpointJson), /"highWaterMark":"2026-01-01"/);
    assert.match(String(run?.checkpointJson), /"cursor":"c-42"/);
  });

  test("le dernier checkpoint est retrouvable par la source", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    const stored = await harness.repository.lastCheckpoint(SOURCE);
    assert.ok(stored !== null);
    assert.equal((JSON.parse(stored) as CheckpointState).highWaterMark, "2026-01-01");
  });
});

describe("reprise incrementale (Vol. III, 7.3)", () => {
  test("une collecte incrementale restaure le checkpoint precedent", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    assert.equal(harness.plugin.restored.length, 0, "aucun etat a restaurer au premier passage");

    harness.plugin.highWaterMark = "2026-02-01";
    await harness.runner.run(harness.loaded, { mode: "incremental" });

    // Le defaut corrige : le checkpoint etait enregistre puis jamais relu, et
    // chaque collecte incrementale refaisait le travail complet.
    assert.equal(harness.plugin.restored.length, 1);
    assert.equal(harness.plugin.restored[0]?.highWaterMark, "2026-01-01");
    assert.equal(harness.plugin.restored[0]?.cursor, "c-42");
  });

  test("la borne temporelle du checkpoint est transmise a la decouverte", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    await harness.runner.run(harness.loaded, { mode: "incremental" });

    const incremental = harness.plugin.scopes[1];
    assert.equal(incremental?.mode, "incremental");
    assert.equal(incremental?.since, "2026-01-01");
  });

  test("une borne explicite prime sur celle du checkpoint", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    await harness.runner.run(harness.loaded, { mode: "incremental", since: "2026-06-30" });
    assert.equal(harness.plugin.scopes[1]?.since, "2026-06-30");
  });

  test("un checkpoint illisible n'interrompt pas la collecte", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    const runs = await harness.repository.listRuns(SOURCE, 1);
    await harness.repository.closeRun({
      runId: runs[0]!.runId,
      status: "completed",
      endedAt: runs[0]!.endedAt!,
      counters: runs[0]!,
      checkpointJson: "{ ceci n'est pas du JSON",
    });

    const summary = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal(summary.status, "completed");
    assert.equal(harness.plugin.restored.length, 0);
    assert.ok(
      harness.logger.records.some((record) => /checkpoint illisible/.test(record.message)),
      "l'anomalie doit etre signalee, pas tue",
    );
  });

  test("un checkpoint d'une autre version est ignore plutot qu'interprete", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    const runs = await harness.repository.listRuns(SOURCE, 1);
    await harness.repository.closeRun({
      runId: runs[0]!.runId,
      status: "completed",
      endedAt: runs[0]!.endedAt!,
      counters: runs[0]!,
      checkpointJson: JSON.stringify({ version: 2, cursor: "inconnu" }),
    });

    await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal(harness.plugin.restored.length, 0);
    assert.ok(harness.logger.records.some((r) => /autre version/.test(r.message)));
  });
});

describe("un balayage tronque n'est pas un balayage complet", () => {
  test("une collecte plafonnee ne fait pas croire la source entierement revue", async () => {
    harness.plugin.documents = ["a", "b", "c"];
    const summary = await harness.runner.run(harness.loaded, { mode: "full", maxDocuments: 1 });

    const run = await harness.repository.getRun(summary.runId);
    assert.equal(run?.status, "completed");
    // Elle s'est bien terminee, mais elle n'a pas parcouru la source.
    assert.match(String(run?.errorSummary), /tronquee/);
    assert.equal(await harness.repository.lastFullSweepAt(SOURCE), null);
  });

  test("apres un balayage tronque, l'incremental reste promu en complet", async () => {
    harness.plugin.documents = ["a", "b", "c"];
    await harness.runner.run(harness.loaded, { mode: "full", maxDocuments: 1 });

    // Le defaut corrige : la nuit suivante se croyait a jour et ne reprenait
    // jamais les 30 000 documents restants.
    const second = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal((await harness.repository.getRun(second.runId))?.mode, "full");
  });

  test("un balayage tronque ne peut pas declarer un document retire", async () => {
    harness.plugin.documents = ["a", "b"];
    await harness.runner.run(harness.loaded, { mode: "full" });

    // Trois balayages qui ne voient jamais « b » — mais tous tronques.
    harness.plugin.documents = ["a"];
    for (let index = 0; index < 3; index++) {
      await harness.runner.run(harness.loaded, { mode: "full", maxDocuments: 1 });
    }

    // Un balayage qui n'a pas vu le document ne peut pas temoigner de sa
    // disparition : le declarer retire serait un faux fait juridique.
    const documentId = computeDocumentId(SOURCE, "b");
    assert.equal((await harness.repository.getDocument(documentId))?.status, "stored");
  });

  test("un balayage mene a son terme compte, lui", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    assert.notEqual(await harness.repository.lastFullSweepAt(SOURCE), null);

    const second = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal((await harness.repository.getRun(second.runId))?.mode, "incremental");
  });
});

describe("balayage complet impose (Vol. III, 7.3)", () => {
  test("une source jamais parcourue entierement ignore le mode incremental", async () => {
    const summary = await harness.runner.run(harness.loaded, { mode: "incremental" });

    // Il n'existe aucun etat auquel se raccrocher : la collecte est complete.
    assert.equal((await harness.repository.getRun(summary.runId))?.mode, "full");
    assert.equal(harness.plugin.scopes[0]?.mode, "full");
    assert.ok(harness.logger.records.some((r) => /aucun precedent/.test(r.message)));
  });

  test("un balayage complet trop ancien reprend le dessus sur l'incremental", async () => {
    await harness.close();
    await fsp.rm(workspace, { recursive: true, force: true });
    workspace = await tempDir("runner");
    // Fenetre d'une heure, pour n'avoir pas a simuler trente jours.
    harness = await createHarness({ fullSweepEveryMs: 3_600_000 });

    await harness.runner.run(harness.loaded, { mode: "full" });
    harness.clock.advance(2 * 3_600_000);

    const summary = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal((await harness.repository.getRun(summary.runId))?.mode, "full");
    assert.ok(harness.logger.records.some((r) => /trop ancien/.test(r.message)));
  });

  test("un balayage complet recent laisse l'incremental s'appliquer", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    const summary = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal((await harness.repository.getRun(summary.runId))?.mode, "incremental");
  });
});

describe("echelle de decision N1/N2/N3 (Vol. IV, 6.2)", () => {
  test("un balayage complet compare toujours l'empreinte", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    const before = harness.plugin.resolved.length;

    await harness.runner.run(harness.loaded, { mode: "full" });
    // Deux documents redecouverts, deux resolutions : N3 est obligatoire.
    assert.equal(harness.plugin.resolved.length, before + 2);
  });

  test("sans indice de fraicheur, l'incremental ne retelecharge pas un document connu", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    const before = harness.plugin.resolved.length;

    const summary = await harness.runner.run(harness.loaded, { mode: "incremental" });

    // Le defaut corrige : sur une source sans ETag — le SGG du Benin n'en sert
    // aucun — chaque passe incrementale retelechargeait tout le corpus.
    assert.equal(harness.plugin.resolved.length, before, "aucune resolution attendue");
    assert.equal(summary.counters.docsUnchanged, 2);
    assert.equal(summary.counters.bytesDownloaded, 0);
  });

  test("le motif de l'evenement dit pourquoi le document a ete passe", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    await harness.runner.run(harness.loaded, { mode: "incremental" });

    const events = await harness.bus.getEventHistory({ type: "lcf.document.unchanged" });
    const reasons = events.map((event) => (event.data as { reason: string }).reason);
    assert.ok(reasons.includes("incremental_skip"), reasons.join(", "));
  });

  test("un ETag identique suffit a passer (N1)", async () => {
    harness.plugin.etags.set("a", '"v1"');
    harness.plugin.etags.set("b", '"v1"');
    await harness.runner.run(harness.loaded, { mode: "full" });
    const before = harness.plugin.resolved.length;

    const summary = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal(harness.plugin.resolved.length, before);
    assert.equal(summary.counters.docsUnchanged, 2);

    const reasons = (await harness.bus.getEventHistory({ type: "lcf.document.unchanged" })).map(
      (event) => (event.data as { reason: string }).reason,
    );
    assert.ok(reasons.includes("etag_match"));
  });

  test("un ETag different declenche la comparaison d'empreinte", async () => {
    harness.plugin.etags.set("a", '"v1"');
    harness.plugin.etags.set("b", '"v1"');
    await harness.runner.run(harness.loaded, { mode: "full" });
    const before = harness.plugin.resolved.length;

    harness.plugin.etags.set("a", '"v2"');
    await harness.runner.run(harness.loaded, { mode: "incremental" });

    // Seul « a » a change d'indice : lui seul est retelecharge.
    assert.equal(harness.plugin.resolved.length, before + 1);
    assert.equal(harness.plugin.resolved[before], "a");
  });

  test("--recheck force la comparaison d'empreinte en incremental", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    const before = harness.plugin.resolved.length;

    const summary = await harness.runner.run(harness.loaded, {
      mode: "incremental",
      recheck: true,
    });
    assert.equal(harness.plugin.resolved.length, before + 2);
    assert.equal(summary.counters.docsUnchanged, 2);
  });

  test("un contenu modifie reste detecte au balayage complet suivant", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    // La source republie « a » sans changer le moindre indice.
    harness.rewrite("a", "%PDF-1.7\nacte a revise\n");

    const incremental = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal(incremental.counters.docsUpdated, 0, "l'incremental ne peut pas le voir");

    const full = await harness.runner.run(harness.loaded, { mode: "full" });
    assert.equal(full.counters.docsUpdated, 1, "le balayage complet le rattrape");
  });
});

describe("reprise des documents en echec", () => {
  test("un document en echec est retente a la collecte incrementale suivante", async () => {
    harness.plugin.unresolvable.add("b");
    const first = await harness.runner.run(harness.loaded, { mode: "full" });
    assert.equal(first.counters.docsFailed, 1);

    const documentId = computeDocumentId(SOURCE, "b");
    assert.equal((await harness.repository.getDocument(documentId))?.status, "failed");

    // La source se retablit.
    harness.plugin.unresolvable.clear();
    // Le document n'est plus dans le flux de decouverte : seule la reprise
    // ciblee peut le rattraper.
    harness.plugin.documents = ["a"];

    const second = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal(second.retried, 1);
    assert.equal((await harness.repository.getDocument(documentId))?.status, "stored");
  });

  test("un balayage complet ne declenche pas de reprise : il redecouvre deja tout", async () => {
    harness.plugin.unresolvable.add("b");
    await harness.runner.run(harness.loaded, { mode: "full" });

    harness.plugin.unresolvable.clear();
    const second = await harness.runner.run(harness.loaded, { mode: "full" });

    assert.equal(second.retried, 0);
    // Le document est tout de meme rattrape, par la decouverte cette fois.
    assert.equal(
      (await harness.repository.getDocument(computeDocumentId(SOURCE, "b")))?.status,
      "stored",
    );
  });

  test("un echec persistant laisse le document en echec sans faire echouer la collecte", async () => {
    harness.plugin.unresolvable.add("b");
    await harness.runner.run(harness.loaded, { mode: "full" });
    harness.plugin.documents = ["a"];

    const second = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal(second.status, "completed");
    assert.equal(second.retried, 0);
    assert.equal(
      (await harness.repository.getDocument(computeDocumentId(SOURCE, "b")))?.status,
      "failed",
    );
  });

  test("un plugin exigeant sa charge utile laisse le document au balayage complet", async () => {
    // Le descripteur reconstruit ne porte pas `extra` : la limite est assumee
    // et documentee, elle ne doit surtout pas etre masquee.
    harness.plugin.unresolvable.add("b");
    await harness.runner.run(harness.loaded, { mode: "full" });

    harness.plugin.unresolvable.clear();
    harness.plugin.requiresExtra.add("b");
    harness.plugin.documents = ["a"];

    const second = await harness.runner.run(harness.loaded, { mode: "incremental" });
    assert.equal(second.retried, 0);
    assert.equal(second.status, "completed");
  });

  test("le nombre de reprises par execution est borne", async () => {
    harness.plugin.documents = ["a", "b", "c"];
    harness.plugin.unresolvable = new Set(["a", "b", "c"]);
    await harness.runner.run(harness.loaded, { mode: "full" });

    await harness.close();
    const bounded = await createHarness({ maxRetriesPerRun: 2 });
    try {
      bounded.plugin.documents = [];
      const summary = await bounded.runner.run(bounded.loaded, { mode: "incremental" });
      // Trois documents en echec, deux reprises autorisees.
      assert.equal(bounded.plugin.resolved.length, 2);
      assert.equal(summary.status, "completed");
    } finally {
      harness = bounded;
    }
  });
});

describe("collecte de bout en bout par l'orchestrateur", () => {
  test("les documents sont stockes, comptes et relisibles", async () => {
    const summary = await harness.runner.run(harness.loaded, { mode: "full" });

    assert.equal(summary.counters.docsDiscovered, 2);
    assert.equal(summary.counters.docsNew, 2);
    const page = await harness.repository.query({ sourceId: SOURCE });
    assert.equal(page.items.length, 2);
    assert.equal(
      page.items.find((item) => item.nativeId === "a")?.contentHash,
      computeContentHash(PDF("a")),
    );
  });

  test("un document apparu entre deux collectes est ajoute sans toucher aux autres", async () => {
    await harness.runner.run(harness.loaded, { mode: "full" });
    harness.plugin.documents = ["a", "b", "c"];

    const second = await harness.runner.run(harness.loaded, { mode: "full" });
    assert.equal(second.counters.docsNew, 1);
    assert.equal(second.counters.docsUnchanged, 2);
  });

  test("deux collectes simultanees sur une meme source sont interdites", async () => {
    const first = harness.runner.run(harness.loaded, { mode: "full" });
    await assert.rejects(harness.runner.run(harness.loaded, { mode: "full" }), /deja en cours/);
    await first;
  });
});
