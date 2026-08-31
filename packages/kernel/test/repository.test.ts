import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { SqliteDriver } from "../src/db/sqlite-driver.js";
import { MigrationRunner } from "../src/db/migrations.js";
import { SqlDocumentRepository } from "../src/db/sql-repository.js";
import { FilesystemContentStore } from "../src/storage/filesystem-content-store.js";
import { StorageError } from "../src/domain/errors.js";
import { ManualClock } from "../src/domain/clock.js";
import { ZERO_COUNTERS } from "../src/domain/model.js";
import {
  asSourceId,
  computeDocumentId,
  newRunId,
  toIsoTimestamp,
  type DocumentId,
} from "../src/domain/ids.js";
import type { DocumentCommit } from "../src/db/repository.js";
import type { StoredObject } from "../src/storage/content-store.js";
import { migrationsDir, tempDir } from "./helpers.js";

const SOURCE = asSourceId("example.gazette");
const RUN = newRunId(1_700_000_000_000);
const AT = toIsoTimestamp(1_700_000_000_000);

let workspace: string;
let driver: SqliteDriver;
let store: FilesystemContentStore;
let repo: SqlDocumentRepository;

async function storeBytes(text: string): Promise<StoredObject> {
  return store.store(new TextEncoder().encode(text), {
    runId: RUN,
    declaredMime: "application/pdf",
  });
}

function commitOf(
  nativeId: string,
  versionNo: number,
  stored: StoredObject,
  overrides: Partial<DocumentCommit> = {},
): DocumentCommit {
  return {
    runId: RUN,
    sourceId: SOURCE,
    documentId: computeDocumentId(SOURCE, nativeId),
    nativeId,
    canonicalUrl: `https://gazette.example/acts/${nativeId}`,
    stored,
    versionNo,
    changeReason: versionNo === 1 ? "initial" : "content_changed",
    fetchedAt: AT,
    fetchedFromUrl: `https://gazette.example/acts/${nativeId}.pdf`,
    ...overrides,
  };
}

beforeEach(async () => {
  workspace = await tempDir("repo");
  store = new FilesystemContentStore({
    root: workspace,
    clock: new ManualClock(1_700_000_000_000),
    fsync: false,
  });
  await store.init();

  driver = new SqliteDriver({ path: path.join(workspace, "index", "lcf.db") });
  await new MigrationRunner(driver, { directory: migrationsDir() }).migrate();
  repo = new SqlDocumentRepository(driver, { clock: new ManualClock(1_700_000_000_000) });

  await repo.registerSource({
    sourceId: SOURCE,
    pluginId: "example.gazette",
    pluginVersion: "1.0.0",
    apiVersion: "1.0",
    displayName: "Gazette",
    config: { startYear: 2020 },
  });
  await repo.startRun({
    runId: RUN,
    sourceId: SOURCE,
    mode: "full",
    trigger: "manual",
    startedAt: AT,
  });
});

afterEach(async () => {
  await driver.close();
  await fsp.rm(workspace, { recursive: true, force: true });
});

describe("enregistrement des sources", () => {
  test("la configuration est hachee de maniere stable", async () => {
    const first = await repo.getSource(SOURCE);
    const again = await repo.registerSource({
      sourceId: SOURCE,
      pluginId: "example.gazette",
      pluginVersion: "1.0.0",
      apiVersion: "1.0",
      displayName: "Gazette",
      config: { startYear: 2020 },
    });
    assert.equal(again.configHash, first?.configHash);
    assert.match(again.configHash, /^sha256:[0-9a-f]{64}$/);
  });

  test("l'ordre des cles de configuration ne change pas l'empreinte", async () => {
    const a = await repo.registerSource({
      sourceId: asSourceId("a.source"),
      pluginId: "p",
      pluginVersion: "1.0.0",
      apiVersion: "1.0",
      displayName: "A",
      config: { alpha: 1, beta: 2 },
    });
    const b = await repo.registerSource({
      sourceId: asSourceId("b.source"),
      pluginId: "p",
      pluginVersion: "1.0.0",
      apiVersion: "1.0",
      displayName: "B",
      config: { beta: 2, alpha: 1 },
    });
    assert.equal(a.configHash, b.configHash);
  });

  test("la mise en quarantaine conserve le motif et la date", async () => {
    await repo.setSourceState(SOURCE, "quarantined", "SourceStructureChanged");
    const source = await repo.getSource(SOURCE);
    assert.equal(source?.state, "quarantined");
    assert.equal(source?.quarantineReason, "SourceStructureChanged");
    assert.equal(source?.quarantinedAt, AT);
  });
});

describe("etape E10 — ecriture transactionnelle (Vol. IV, 5.1)", () => {
  test("un commit ecrit document, version, objet et compteurs en une fois", async () => {
    const stored = await storeBytes("%PDF-1.7 acte 118");
    const result = await repo.commitDocument(commitOf("2024/118", 1, stored));

    assert.equal(result.isNewDocument, true);
    assert.equal(result.isNewVersion, true);

    const document = await repo.getDocument(result.documentId);
    assert.equal(document?.status, "stored");
    assert.equal(document?.currentVersion, 1);
    assert.equal(document?.versionCount, 1);

    const version = await repo.currentVersion(result.documentId);
    assert.equal(version?.contentHash, stored.contentHash);
    assert.equal(version?.changeReason, "initial");

    const object = await repo.getContentObject(stored.contentHash);
    assert.equal(object?.byteSize, stored.byteSize);
    assert.equal(object?.refCount, 1);
    assert.equal(object?.storagePath, stored.storagePath);

    const run = await repo.getRun(RUN);
    assert.equal(run?.docsNew, 1);
    assert.equal(run?.bytesDownloaded, stored.byteSize);
  });

  test("un contenu modifie cree une version 2 et conserve la version 1 (AC-3.4)", async () => {
    const v1 = await storeBytes("%PDF-1.7 version une");
    await repo.commitDocument(commitOf("2024/118", 1, v1));

    const v2 = await storeBytes("%PDF-1.7 version deux");
    const result = await repo.commitDocument(
      commitOf("2024/118", 2, v2, { supersedesVersion: 1 }),
    );

    assert.equal(result.isNewVersion, true);
    const document = await repo.getDocument(result.documentId);
    assert.equal(document?.currentVersion, 2);
    assert.equal(document?.versionCount, 2);

    const versions = await repo.listVersions(result.documentId);
    assert.deepEqual(
      versions.map((v) => v.versionNo),
      [1, 2],
    );
    // La version 1 reste integralement accessible, octets compris.
    assert.equal(versions[0]?.contentHash, v1.contentHash);
    assert.deepEqual(
      await store.read(v1.contentHash),
      new TextEncoder().encode("%PDF-1.7 version une"),
    );
  });

  test("rejouer le meme commit ne cree pas de doublon (AC-3.3)", async () => {
    const stored = await storeBytes("%PDF-1.7 identique");
    await repo.commitDocument(commitOf("2024/118", 1, stored));
    const replay = await repo.commitDocument(commitOf("2024/118", 1, stored));

    assert.equal(replay.isNewVersion, false);
    const documentId = computeDocumentId(SOURCE, "2024/118");
    assert.equal((await repo.listVersions(documentId)).length, 1);
    assert.equal((await repo.getDocument(documentId))?.versionCount, 1);
  });

  test("une meme version avec une empreinte differente est refusee", async () => {
    const first = await storeBytes("%PDF-1.7 un");
    const second = await storeBytes("%PDF-1.7 deux");
    await repo.commitDocument(commitOf("2024/118", 1, first));

    await assert.rejects(
      repo.commitDocument(commitOf("2024/118", 1, second)),
      /conflit de version/,
    );
  });

  test("deux documents partageant les memes octets ne stockent qu'un objet", async () => {
    const stored = await storeBytes("%PDF-1.7 circulaire commune");
    await repo.commitDocument(commitOf("2024/118", 1, stored));
    await repo.commitDocument(commitOf("2024/119", 1, stored));

    const object = await repo.getContentObject(stored.contentHash);
    assert.equal(object?.refCount, 2);
    assert.equal((await repo.documentsFor(stored.contentHash)).length, 2);
  });

  test("les metadonnees natives et leur provenance sont conservees par version", async () => {
    const stored = await storeBytes("%PDF-1.7 avec metadonnees");
    await repo.commitDocument(
      commitOf("2024/118", 1, stored, {
        metadata: {
          raw: { titre: "Acte n. 2024-118", rubrique: "Actes" },
          common: { reference: "2024-118" },
          provenance: [
            {
              field: "titre",
              locator: "h1.doc-title",
              at: "https://gazette.example/acts/2024-118",
            },
          ],
        },
      }),
    );

    const row = await driver.get<{ raw_json: string; provenance_json: string; extractor_version: string }>(
      "SELECT raw_json, provenance_json, extractor_version FROM document_metadata WHERE document_id = ?",
      [computeDocumentId(SOURCE, "2024/118")],
    );
    assert.match(String(row?.raw_json), /Acte n. 2024-118/);
    assert.match(String(row?.provenance_json), /h1.doc-title/);
    assert.equal(row?.extractor_version, "native/1");
  });

  test("les tentatives sont numerotees par document et par execution", async () => {
    const stored = await storeBytes("%PDF-1.7 tentatives");
    const documentId = computeDocumentId(SOURCE, "2024/118");
    await repo.recordAttempt(RUN, documentId, {
      startedAt: AT,
      outcome: "transient_error",
      errorClass: "SourceUnavailable",
    });
    await repo.commitDocument(
      commitOf("2024/118", 1, stored, {
        attempt: { startedAt: AT, endedAt: AT, outcome: "success", httpStatus: 200 },
      }),
    );

    const rows = await driver.all<{ attempt_no: number; outcome: string }>(
      "SELECT attempt_no, outcome FROM fetch_attempts WHERE document_id = ? ORDER BY attempt_no",
      [documentId],
    );
    assert.deepEqual(
      rows.map((r) => [Number(r.attempt_no), r.outcome]),
      [
        [1, "transient_error"],
        [2, "success"],
      ],
    );
  });
});

describe("points de panne E10 et E11 (Vol. IV, 5.2)", () => {
  test("panne avant COMMIT : objet present sur disque, base inchangee", async () => {
    const stored = await storeBytes("%PDF-1.7 panne avant commit");

    await assert.rejects(
      repo.withTransaction(async (tx) => {
        await tx.commitDocument(commitOf("2024/118", 1, stored));
        throw new Error("panne simulee avant COMMIT");
      }),
      /panne simulee/,
    );

    // Aucune perte : les octets sont la, la base ne les connait pas encore.
    assert.equal(await store.has(stored.contentHash), true);
    assert.equal(await repo.getDocument(computeDocumentId(SOURCE, "2024/118")), null);
    assert.equal(await repo.getContentObject(stored.contentHash), null);

    // Le passage suivant rattrape sans dupliquer d'octets.
    const retried = await repo.commitDocument(commitOf("2024/118", 1, stored));
    assert.equal(retried.isNewVersion, true);
  });

  test("panne apres COMMIT : etat coherent, evenement seul manquant", async () => {
    const stored = await storeBytes("%PDF-1.7 panne apres commit");
    await repo.commitDocument(commitOf("2024/118", 1, stored));

    // E11 non emis : la base et le magasin sont deja coherents, et l'evenement
    // est rejouable depuis le journal d'execution.
    const documentId = computeDocumentId(SOURCE, "2024/118");
    assert.equal((await repo.getDocument(documentId))?.currentVersion, 1);
    assert.equal((await repo.getContentObject(stored.contentHash))?.refCount, 1);
    assert.equal((await store.verify(stored.contentHash)).result, "ok");
  });
});

describe("cycle de vie d'un document", () => {
  test("un contenu inchange ne cree aucune version", async () => {
    const stored = await storeBytes("%PDF-1.7 stable");
    const { documentId } = await repo.commitDocument(commitOf("2024/118", 1, stored));

    await repo.touchDocument(documentId, toIsoTimestamp(1_700_000_100_000));
    const document = await repo.getDocument(documentId);
    assert.equal(document?.versionCount, 1);
    assert.equal(document?.lastSeenAt, "2023-11-14T22:15:00.000Z");
  });

  test("un retrait conserve versions et octets", async () => {
    const stored = await storeBytes("%PDF-1.7 retire");
    const { documentId } = await repo.commitDocument(commitOf("2024/118", 1, stored));

    await repo.markDocumentWithdrawn(documentId, toIsoTimestamp(1_700_000_100_000));
    const withdrawn = await repo.getDocument(documentId);
    assert.equal(withdrawn?.status, "withdrawn");
    assert.equal(withdrawn?.withdrawnAt, "2023-11-14T22:15:00.000Z");
    assert.equal((await repo.listVersions(documentId)).length, 1);
    assert.equal(await store.has(stored.contentHash), true);
  });

  test("un document republie redevient visible sans perdre son historique", async () => {
    const stored = await storeBytes("%PDF-1.7 republie");
    const { documentId } = await repo.commitDocument(commitOf("2024/118", 1, stored));
    await repo.markDocumentWithdrawn(documentId, AT);

    await repo.recordDiscovery({
      runId: RUN,
      sourceId: SOURCE,
      documentId,
      nativeId: "2024/118",
      seenAt: toIsoTimestamp(1_700_000_200_000),
    });

    const document = await repo.getDocument(documentId);
    assert.equal(document?.status, "stored");
    assert.equal(document?.withdrawnAt, undefined);
    assert.equal(document?.versionCount, 1);
  });

  test("un echec ne degrade pas un document deja stocke", async () => {
    const stored = await storeBytes("%PDF-1.7 deja stocke");
    const { documentId } = await repo.commitDocument(commitOf("2024/118", 1, stored));
    await repo.markDocumentFailed(documentId, AT);
    assert.equal((await repo.getDocument(documentId))?.status, "stored");
  });

  test("un document jamais collecte peut etre marque en echec", async () => {
    const documentId = computeDocumentId(SOURCE, "2024/999") as DocumentId;
    await repo.recordDiscovery({
      runId: RUN,
      sourceId: SOURCE,
      documentId,
      nativeId: "2024/999",
      seenAt: AT,
    });
    await repo.markDocumentFailed(documentId, AT);
    assert.equal((await repo.getDocument(documentId))?.status, "failed");
  });
});

describe("interrogation du corpus", () => {
  test("la pagination par curseur ne saute ni ne duplique de ligne", async () => {
    for (let index = 0; index < 5; index++) {
      const stored = await storeBytes(`%PDF-1.7 document ${index}`);
      await repo.commitDocument(commitOf(`2024/${index}`, 1, stored));
    }

    const first = await repo.query({ sourceId: SOURCE, limit: 2 });
    assert.equal(first.items.length, 2);
    assert.notEqual(first.nextCursor, null);

    const second = await repo.query({ sourceId: SOURCE, limit: 2, cursor: first.nextCursor });
    const third = await repo.query({ sourceId: SOURCE, limit: 2, cursor: second.nextCursor });

    const all = [...first.items, ...second.items, ...third.items].map((d) => d.documentId);
    assert.equal(new Set(all).size, 5);
    assert.equal(third.nextCursor, null);
  });

  test("un curseur falsifie est refuse", async () => {
    await assert.rejects(
      repo.query({ sourceId: SOURCE, cursor: "bidon" }),
      StorageError,
    );
  });

  test("la vue courante expose taille, type et etat de verification", async () => {
    const stored = await storeBytes("%PDF-1.7 vue courante");
    await repo.commitDocument(commitOf("2024/118", 1, stored));
    const page = await repo.query({ sourceId: SOURCE });

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.byteSize, stored.byteSize);
    assert.equal(page.items[0]?.mimeType, "application/pdf");
    assert.equal(page.items[0]?.verifyStatus, "ok");
  });
});

describe("journal d'integrite", () => {
  test("chaque verification est journalisee et met a jour l'etat de l'objet", async () => {
    const stored = await storeBytes("%PDF-1.7 integrite");
    await repo.commitDocument(commitOf("2024/118", 1, stored));

    const check = await store.verify(stored.contentHash);
    await repo.recordIntegrityCheck(check);
    await repo.setVerifyStatus(stored.contentHash, "ok", check.checkedAt);

    const object = await repo.getContentObject(stored.contentHash);
    assert.equal(object?.verifyStatus, "ok");
    assert.equal(object?.lastVerifiedAt, check.checkedAt);

    const rows = await driver.all("SELECT * FROM integrity_log WHERE content_hash = ?", [
      stored.contentHash,
    ]);
    assert.equal(rows.length, 1);
  });

  test("les objets jamais verifies passent en tete de file", async () => {
    const a = await storeBytes("%PDF-1.7 objet a");
    const b = await storeBytes("%PDF-1.7 objet b");
    await repo.commitDocument(commitOf("2024/118", 1, a));
    await repo.commitDocument(commitOf("2024/119", 1, b));
    await repo.setVerifyStatus(a.contentHash, "ok", AT);

    const batch = await repo.oldestUnverified(10);
    assert.equal(batch[0]?.contentHash, b.contentHash);
  });
});

describe("cloture d'execution", () => {
  test("les compteurs et le statut sont enregistres a la cloture", async () => {
    await repo.closeRun({
      runId: RUN,
      status: "completed",
      endedAt: toIsoTimestamp(1_700_000_300_000),
      counters: { ...ZERO_COUNTERS, docsDiscovered: 12, docsNew: 3, requestsMade: 15 },
    });

    const run = await repo.getRun(RUN);
    assert.equal(run?.status, "completed");
    assert.equal(run?.docsDiscovered, 12);
    assert.equal((await repo.getSource(SOURCE))?.lastSuccessAt, "2023-11-14T22:18:20.000Z");
  });

  test("une execution abandonnee par un processus tue est cloturee", async () => {
    // Le processus meurt sans jamais appeler closeRun : la ligne resterait
    // `running` pour toujours et fausserait tous les rapports.
    const closed = await repo.failStaleRuns(
      toIsoTimestamp(1_700_000_000_001),
      toIsoTimestamp(1_700_000_500_000),
    );
    assert.equal(closed, 1);

    const run = await repo.getRun(RUN);
    assert.equal(run?.status, "failed");
    assert.equal(run?.errorSummary, "execution interrompue");
  });

  test("une execution recente n'est jamais prise pour une execution morte", async () => {
    // Un demon peut legitimement avoir une collecte en cours : le seuil large
    // est ce qui empeche une commande manuelle de la declarer morte.
    const closed = await repo.failStaleRuns(
      toIsoTimestamp(1_699_999_999_999),
      toIsoTimestamp(1_700_000_500_000),
    );
    assert.equal(closed, 0);
    assert.equal((await repo.getRun(RUN))?.status, "running");
  });

  test("une execution echouee ne met pas a jour la date de dernier succes", async () => {
    await repo.closeRun({
      runId: RUN,
      status: "failed",
      endedAt: AT,
      counters: ZERO_COUNTERS,
      errorSummary: "SourceStructureChanged",
    });
    assert.equal((await repo.getSource(SOURCE))?.lastSuccessAt, undefined);
    assert.equal((await repo.getRun(RUN))?.errorSummary, "SourceStructureChanged");
  });
});
