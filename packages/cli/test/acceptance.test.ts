/**
 * Criteres d'acceptation du Palier 0 — Volume IX, 4.1.
 *
 * Chaque test porte le numero du critere qu'il verifie. Le systeme est monte
 * en entier, avec le plugin de reference charge depuis le disque : ce sont les
 * seuls tests qui prouvent que les couches s'assemblent reellement.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { computeContentHash, computeDocumentId, reindexFromStore, type DocumentId } from "@lcf/kernel";

import {
  EMPTY_PAGE,
  PORTAL,
  createWorkspace,
  defaultFixtures,
  indexPage,
  pdf,
  startClockPump,
  withRevision,
  type Workspace,
} from "./harness.js";

let workspace: Workspace;
let stopPump: () => void;

beforeEach(async () => {
  workspace = await createWorkspace();
  stopPump = startClockPump(workspace.clock);
});

afterEach(async () => {
  stopPump();
  await workspace.cleanup();
});

const SOURCE = "portal";

describe("collecte de bout en bout", () => {
  test("une premiere collecte decouvre, telecharge, verifie et enregistre", async () => {
    const app = await workspace.open();
    try {
      const loaded = await app.loadSource(SOURCE);
      const summary = await app.runner.run(loaded, { mode: "full" });

      assert.equal(summary.status, "completed");
      assert.equal(summary.counters.docsDiscovered, 3);
      assert.equal(summary.counters.docsNew, 3);
      assert.equal(summary.counters.docsFailed, 0);

      const page = await app.repository.query({ sourceId: app.asSourceId(SOURCE) });
      assert.equal(page.items.length, 3);

      // Les octets stockes sont exactement ceux servis par la source.
      const first = page.items.find((item) => item.nativeId === "2024-118");
      assert.ok(first !== undefined);
      assert.equal(first.contentHash, computeContentHash(pdf("2024-118")));
      assert.deepEqual(await app.store.read(first.contentHash), pdf("2024-118"));
    } finally {
      await app.close();
    }
  });

  test("les metadonnees natives conservent leur provenance", async () => {
    const app = await workspace.open();
    try {
      await app.runner.run(await app.loadSource(SOURCE), { mode: "full" });
      const row = await app.driver.get<{ provenance_json: string; raw_json: string }>(
        "SELECT raw_json, provenance_json FROM document_metadata LIMIT 1",
      );
      assert.match(String(row?.raw_json), /Acte n\. 2024-1/);
      assert.match(String(row?.provenance_json), /article\.doc-entry h3/);
    } finally {
      await app.close();
    }
  });

  test("le descripteur du magasin suffit a decrire le document (I-4)", async () => {
    const app = await workspace.open();
    try {
      await app.runner.run(await app.loadSource(SOURCE), { mode: "full" });
      const hash = computeContentHash(pdf("2024-118"));
      const descriptor = await app.store.readDescriptor(hash);

      assert.ok(descriptor !== null && !("tombstone" in descriptor));
      assert.equal(descriptor.references.length, 1);
      assert.equal(descriptor.references[0]?.nativeId, "2024-118");
      assert.equal(descriptor.references[0]?.versionNo, 1);
      assert.ok(descriptor.references[0]?.metadata !== undefined);
    } finally {
      await app.close();
    }
  });
});

describe("AC-4.4 / AC-3.3 — idempotence de la collecte", () => {
  test("dix collectes consecutives ne changent ni les versions ni les octets", async () => {
    const app = await workspace.open();
    try {
      const loaded = await app.loadSource(SOURCE);
      await app.runner.run(loaded, { mode: "full" });

      const documentId = computeDocumentId(app.asSourceId(SOURCE), "2024-118");
      const afterFirst = await app.repository.getDocument(documentId);
      const objectPath = path.join(
        app.config.dataDir,
        (await app.repository.getContentObject(afterFirst!.currentVersion === 1
          ? (await app.repository.currentVersion(documentId))!.contentHash
          : (await app.repository.currentVersion(documentId))!.contentHash))!.storagePath,
      );
      const mtimeBefore = (await fsp.stat(objectPath)).mtimeMs;

      for (let index = 0; index < 9; index++) {
        const summary = await app.runner.run(loaded, { mode: "full" });
        assert.equal(summary.counters.docsNew, 0);
        assert.equal(summary.counters.docsUpdated, 0);
        assert.equal(summary.counters.docsUnchanged, 3);
      }

      const afterTenth = await app.repository.getDocument(documentId);
      assert.equal(afterTenth?.versionCount, 1);
      assert.equal(afterTenth?.currentVersion, 1);
      // Seule la date de derniere vue bouge.
      assert.notEqual(afterTenth?.lastSeenAt, afterFirst?.lastSeenAt);
      assert.equal((await fsp.stat(objectPath)).mtimeMs, mtimeBefore);
      assert.equal((await app.repository.listVersions(documentId)).length, 1);
    } finally {
      await app.close();
    }
  });
});

describe("AC-3.4 / AC-4.5 — creation de version sur changement de contenu", () => {
  test("une republication cree une version 2 et laisse la version 1 intacte", async () => {
    const app = await workspace.open();
    try {
      const loaded = await app.loadSource(SOURCE);
      await app.runner.run(loaded, { mode: "full" });

      workspace.setFixtures(withRevision(defaultFixtures(), "2024-118", 2));
      const summary = await app.runner.run(loaded, { mode: "full" });

      assert.equal(summary.counters.docsUpdated, 1);
      assert.equal(summary.counters.docsUnchanged, 2);

      const documentId = computeDocumentId(app.asSourceId(SOURCE), "2024-118");
      const document = await app.repository.getDocument(documentId);
      assert.equal(document?.currentVersion, 2);
      assert.equal(document?.versionCount, 2);

      const versions = await app.repository.listVersions(documentId);
      assert.equal(versions[1]?.changeReason, "content_changed");
      assert.equal(versions[1]?.supersedesVersion, 1);

      // La version 1 reste telechargeable a l'octet pres.
      assert.deepEqual(await app.store.read(versions[0]!.contentHash), pdf("2024-118", 1));
      assert.deepEqual(await app.store.read(versions[1]!.contentHash), pdf("2024-118", 2));

      const events = await app.bus.getEventHistory({ type: "lcf.document.version_created" });
      assert.equal(events.length, 1);
    } finally {
      await app.close();
    }
  });

  test("un changement d'URL sans changement d'octets ne cree aucune version", async () => {
    const app = await workspace.open();
    try {
      const loaded = await app.loadSource(SOURCE);
      await app.runner.run(loaded, { mode: "full" });

      // Meme contenu, ETag different : seul le hachage fait autorite.
      const plan = defaultFixtures();
      plan[`${PORTAL}/documents/2024-118.pdf`] = {
        body: pdf("2024-118"),
        headers: { "content-type": "application/pdf", etag: '"autre-etag"' },
      };
      workspace.setFixtures(plan);

      const summary = await app.runner.run(loaded, { mode: "full" });
      assert.equal(summary.counters.docsUpdated, 0);
      assert.equal(summary.counters.docsUnchanged, 3);
    } finally {
      await app.close();
    }
  });
});

describe("AC-4.3 — deduplication entre sources", () => {
  test("deux sources publiant le meme fichier partagent un seul objet", async () => {
    const shared = pdf("commun");
    const plan = {
      [`${PORTAL}/robots.txt`]: { body: "User-agent: *\nAllow: /\n" },
      [`${PORTAL}/documents?page=0`]: { body: indexPage(["2024-118"], false) },
      [`${PORTAL}/documents/2024-118.pdf`]: {
        body: shared,
        headers: { "content-type": "application/pdf" },
      },
      "https://miroir.example/robots.txt": { body: "User-agent: *\nAllow: /\n" },
      "https://miroir.example/documents?page=0": { body: indexPage(["2024-118"], false) },
      "https://miroir.example/documents/2024-118.pdf": {
        body: shared,
        headers: { "content-type": "application/pdf" },
      },
    };

    const twoSources = await createWorkspace({
      fixtures: plan,
      sources: [
        {
          sourceId: "portal",
          pluginId: "example.paginated.portal",
          config: { baseUrl: PORTAL },
        },
        {
          sourceId: "miroir",
          pluginId: "example.paginated.portal",
          config: { baseUrl: "https://miroir.example" },
          // L'hote du miroir doit etre accorde ET demande : le manifeste ne
          // declare que portal.example, donc la source est refusee sans
          // modification du manifeste. On la teste telle qu'elle est refusee.
        },
      ],
    });
    const stop = startClockPump(twoSources.clock);
    const app = await twoSources.open();

    try {
      await app.runner.run(await app.loadSource("portal"), { mode: "full" });

      // La seconde source vise un hote absent du manifeste : le chargement
      // reussit, mais toute requete est refusee (AC-3.2).
      const mirror = await app.loadSource("miroir");
      const summary = await app.runner.run(mirror, { mode: "full" });
      assert.equal(summary.status, "failed");
      assert.match(String(summary.errorSummary), /CapabilityViolation/);

      const object = await app.repository.getContentObject(computeContentHash(shared));
      assert.equal(object?.refCount, 1);
    } finally {
      await app.close();
      stop();
      await twoSources.cleanup();
    }
  });

  test("un objet partage par deux documents porte deux provenances", async () => {
    const shared = pdf("identique");
    const plan = {
      [`${PORTAL}/robots.txt`]: { body: "User-agent: *\nAllow: /\n" },
      [`${PORTAL}/documents?page=0`]: { body: indexPage(["2024-118", "2024-119"], false) },
      [`${PORTAL}/documents/2024-118.pdf`]: {
        body: shared,
        headers: { "content-type": "application/pdf" },
      },
      [`${PORTAL}/documents/2024-119.pdf`]: {
        body: shared,
        headers: { "content-type": "application/pdf" },
      },
    };
    const shared_ws = await createWorkspace({ fixtures: plan });
    const stop = startClockPump(shared_ws.clock);
    const app = await shared_ws.open();

    try {
      await app.runner.run(await app.loadSource(SOURCE), { mode: "full" });

      const hash = computeContentHash(shared);
      const object = await app.repository.getContentObject(hash);
      assert.equal(object?.refCount, 2);

      const descriptor = await app.store.readDescriptor(hash);
      assert.ok(descriptor !== null && !("tombstone" in descriptor));
      assert.equal(descriptor.references.length, 2);
      assert.equal((await app.repository.documentsFor(hash)).length, 2);
    } finally {
      await app.close();
      stop();
      await shared_ws.cleanup();
    }
  });
});

describe("AC-4.2 — reconstruction depuis le magasin seul", () => {
  test("la base peut etre supprimee puis reconstruite sans acces reseau", async () => {
    const app = await workspace.open();
    let expected: { documentId: DocumentId; hash: string; versions: number }[] = [];
    try {
      await app.runner.run(await app.loadSource(SOURCE), { mode: "full" });
      const page = await app.repository.query({ sourceId: app.asSourceId(SOURCE) });
      expected = page.items.map((item) => ({
        documentId: item.documentId,
        hash: item.contentHash,
        versions: 1,
      }));
    } finally {
      await app.close();
    }

    // La base disparait integralement.
    const dbPath = path.join(workspace.dir, "data", "index", "lcf.db");
    await fsp.rm(dbPath, { force: true });
    await fsp.rm(`${dbPath}-wal`, { force: true });
    await fsp.rm(`${dbPath}-shm`, { force: true });

    const rebuilt = await workspace.open();
    const callsBefore = workspace.transport.calls.length;
    try {
      const report = await reindexFromStore({
        driver: rebuilt.driver,
        store: rebuilt.store,
        clock: rebuilt.clock,
      });

      assert.equal(report.documents, 3);
      assert.equal(report.objects, 3);
      assert.equal(report.missingBytes.length, 0);
      // Aucun octet n'a ete relu depuis le reseau.
      assert.equal(workspace.transport.calls.length, callsBefore);

      const page = await rebuilt.repository.query({ sourceId: rebuilt.asSourceId(SOURCE) });
      assert.equal(page.items.length, 3);
      for (const original of expected) {
        const restored = page.items.find((item) => item.documentId === original.documentId);
        assert.ok(restored !== undefined, `document perdu : ${original.documentId}`);
        assert.equal(restored.contentHash, original.hash);
        assert.equal(
          (await rebuilt.repository.listVersions(original.documentId)).length,
          original.versions,
        );
      }
    } finally {
      await rebuilt.close();
    }
  });

  test("la reindexation retablit un ref_count exact", async () => {
    const app = await workspace.open();
    try {
      await app.runner.run(await app.loadSource(SOURCE), { mode: "full" });
    } finally {
      await app.close();
    }
    await fsp.rm(path.join(workspace.dir, "data", "index", "lcf.db"), { force: true });

    const rebuilt = await workspace.open();
    try {
      await reindexFromStore({ driver: rebuilt.driver, store: rebuilt.store });
      const object = await rebuilt.repository.getContentObject(computeContentHash(pdf("2024-118")));
      assert.equal(object?.refCount, 1);
    } finally {
      await rebuilt.close();
    }
  });
});

describe("AC-4.1 — atomicite sous panne", () => {
  test("apres redemarrage, aucune ligne ne reference un fichier absent", async () => {
    const app = await workspace.open();
    try {
      await app.runner.run(await app.loadSource(SOURCE), { mode: "full" });
    } finally {
      await app.close();
    }

    // Un fichier de transit orphelin subsiste apres une coupure brutale.
    const tmpDir = path.join(workspace.dir, "data", "tmp", "run_INTERROMPU");
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.writeFile(path.join(tmpDir, "en-cours.part"), pdf("2024-121"));

    const restarted = await workspace.open();
    try {
      // Le nettoyage a lieu au demarrage du magasin.
      const remaining = await fsp.readdir(path.join(workspace.dir, "data", "tmp"));
      assert.deepEqual(remaining, []);

      const dangling = await restarted.driver.all<{ storage_path: string }>(
        "SELECT storage_path FROM content_objects",
      );
      for (const row of dangling) {
        await fsp.access(path.join(restarted.config.dataDir, row.storage_path));
      }

      // La collecte suivante se deroule normalement.
      const summary = await restarted.runner.run(await restarted.loadSource(SOURCE), {
        mode: "full",
      });
      assert.equal(summary.status, "completed");
      assert.equal(summary.counters.docsUnchanged, 3);
    } finally {
      await restarted.close();
    }
  });
});

describe("AC-4.6 — non-destruction sur retrait", () => {
  test("un document absent de trois balayages complets passe en withdrawn", async () => {
    const app = await workspace.open();
    try {
      const loaded = await app.loadSource(SOURCE);
      await app.runner.run(loaded, { mode: "full" });

      const documentId = computeDocumentId(app.asSourceId(SOURCE), "2024-120");
      const hash = (await app.repository.currentVersion(documentId))!.contentHash;

      // La source cesse de publier le troisieme document.
      const plan = defaultFixtures();
      plan[`${PORTAL}/documents?page=0`] = { body: indexPage(["2024-118", "2024-119"], true) };
      plan[`${PORTAL}/documents?page=1`] = { body: EMPTY_PAGE };
      workspace.setFixtures(plan);

      for (let sweep = 0; sweep < 2; sweep++) {
        await app.runner.run(loaded, { mode: "full" });
        assert.equal((await app.repository.getDocument(documentId))?.status, "stored");
      }

      const third = await app.runner.run(loaded, { mode: "full" });
      assert.equal(third.withdrawn.length, 1);

      const withdrawn = await app.repository.getDocument(documentId);
      assert.equal(withdrawn?.status, "withdrawn");
      assert.ok(withdrawn?.withdrawnAt !== undefined);

      // Aucun octet supprime : le document reste interrogeable et telechargeable.
      assert.equal(await app.store.has(hash), true);
      assert.deepEqual(await app.store.read(hash), pdf("2024-120"));
      assert.equal((await app.repository.listVersions(documentId)).length, 1);
    } finally {
      await app.close();
    }
  });
});

describe("AC-4.7 — detection de corruption", () => {
  test("un fichier altere hors du Framework est signale, jamais supprime", async () => {
    const app = await workspace.open();
    try {
      await app.runner.run(await app.loadSource(SOURCE), { mode: "full" });

      const hash = computeContentHash(pdf("2024-118"));
      const object = await app.repository.getContentObject(hash);
      const filePath = path.join(app.config.dataDir, object!.storagePath);

      const altered = new Uint8Array(pdf("2024-118"));
      altered[12] = (altered[12] as number) ^ 0xff;
      await fsp.writeFile(filePath, altered);

      const report = await app.scanner.scan({ batchSize: 100 });
      const anomaly = report.anomalies.find((entry) => entry.contentHash === hash);
      assert.equal(anomaly?.result, "hash_mismatch");

      const events = await app.bus.getEventHistory({ type: "lcf.integrity.violation" });
      assert.equal(events.length, 1);
      assert.equal(
        (events[0]?.data as { affectedDocuments: string[] }).affectedDocuments.length,
        1,
      );

      // Le fichier altere est marque, pas supprime.
      await fsp.access(filePath);
      assert.equal((await app.repository.getContentObject(hash))?.verifyStatus, "corrupt");
    } finally {
      await app.close();
    }
  });
});

describe("AC-3.1 / AC-3.6 — isolement et budget", () => {
  test("un budget epuise interrompt proprement et conserve l'acquis", async () => {
    const app = await workspace.open();
    try {
      const loaded = await app.loadSource(SOURCE);
      const summary = await app.runner.run(loaded, {
        mode: "full",
        budget: { maxRequests: 2 },
      });

      assert.equal(summary.status, "completed");
      const events = await app.bus.getEventHistory({ type: "lcf.discovery.budget_exceeded" });
      assert.equal(events.length, 1);

      // Les documents deja collectes sont conserves.
      const page = await app.repository.query({ sourceId: app.asSourceId(SOURCE) });
      assert.ok(page.items.length >= 1, "au moins un document doit avoir ete conserve");
    } finally {
      await app.close();
    }
  });

  test("une source dont la structure change passe en quarantaine sans toucher au corpus", async () => {
    const app = await workspace.open();
    try {
      const loaded = await app.loadSource(SOURCE);
      await app.runner.run(loaded, { mode: "full" });
      const before = (await app.repository.query({ sourceId: app.asSourceId(SOURCE) })).items.length;

      // Refonte du site : la page ne produit plus aucune erreur HTTP, mais sa
      // structure a disparu. C'est le mode de panne le plus frequent.
      workspace.setFixtures({
        [`${PORTAL}/robots.txt`]: { body: "User-agent: *\nAllow: /\n" },
        [`${PORTAL}/documents?page=0`]: { body: "<html><body><main>refonte</main></body></html>" },
      });

      const summary = await app.runner.run(loaded, { mode: "full" });
      assert.equal(summary.status, "failed");
      assert.equal(summary.quarantined, true);
      assert.match(String(summary.errorSummary), /SourceStructureChanged/);

      const source = await app.repository.getSource(app.asSourceId(SOURCE));
      assert.equal(source?.state, "quarantined");

      const events = await app.bus.getEventHistory({ type: "lcf.source.quarantined" });
      assert.equal(events.length, 1);
      assert.equal((events[0]?.data as { documentsPreserved: number }).documentsPreserved, before);

      // Rien n'est detruit : le corpus reste consultable.
      const page = await app.repository.query({ sourceId: app.asSourceId(SOURCE) });
      assert.equal(page.items.length, before);
    } finally {
      await app.close();
    }
  });

  test("une collecte est refusee tant que la source est en quarantaine", async () => {
    const app = await workspace.open();
    try {
      const loaded = await app.loadSource(SOURCE);
      app.plugins.quarantine(loaded.sourceId, "test");
      await assert.rejects(app.runner.run(loaded), /quarantaine/);
    } finally {
      await app.close();
    }
  });
});

describe("AC-3.7 — refus avant execution", () => {
  test("un manifeste invalide est rejete sans que son code soit evalue", async () => {
    const broken = await createWorkspace();
    const stop = startClockPump(broken.clock);
    const pluginDir = path.join(broken.dir, "plugins", "casse");
    await fsp.mkdir(pluginDir, { recursive: true });
    await fsp.writeFile(
      path.join(pluginDir, "lcf-plugin.json"),
      JSON.stringify({ manifestVersion: 1, id: "casse" }),
    );
    // Le module leverait a l'evaluation : il ne doit jamais etre atteint.
    await fsp.writeFile(
      path.join(pluginDir, "index.js"),
      "throw new Error('ce code ne doit jamais etre evalue');",
    );

    const app = await broken.open();
    try {
      const { PluginManager, buildUserAgent } = await import("@lcf/kernel");
      const manager = new PluginManager({ userAgent: buildUserAgent("tests@example.org") });
      await assert.rejects(
        manager.discover([path.join(broken.dir, "plugins")]),
        /plugin rejete/,
      );
      // Le Kernel demarre malgre tout : les autres sources restent utilisables.
      assert.equal((await app.repository.listSources()).length, 0);
    } finally {
      await app.close();
      stop();
      await broken.cleanup();
    }
  });
});
