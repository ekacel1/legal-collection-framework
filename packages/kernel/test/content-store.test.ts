import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FilesystemContentStore } from "../src/storage/filesystem-content-store.js";
import { isTombstone, type ObjectReference } from "../src/storage/descriptor.js";
import { objectRelativePath } from "../src/storage/layout.js";
import { IntegrityError } from "../src/domain/errors.js";
import {
  asSourceId,
  computeContentHash,
  computeDocumentId,
  newRunId,
  toIsoTimestamp,
  type ContentHash,
} from "../src/domain/ids.js";
import { ManualClock } from "../src/domain/clock.js";

const SOURCE = asSourceId("example.gazette");
const RUN = newRunId(1_700_000_000_000);
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

let root: string;
let store: FilesystemContentStore;

function reference(nativeId: string, versionNo: number): ObjectReference {
  return {
    documentId: computeDocumentId(SOURCE, nativeId),
    sourceId: SOURCE,
    nativeId,
    versionNo,
    fetchedAt: toIsoTimestamp(1_700_000_000_000),
    runId: RUN,
    changeReason: versionNo === 1 ? "initial" : "content_changed",
  };
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "lcf-store-"));
  store = new FilesystemContentStore({
    root,
    clock: new ManualClock(1_700_000_000_000),
    fsync: false,
  });
  await store.init();
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function countObjectFiles(): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.name.endsWith(".json")) total++;
    }
  };
  await walk(path.join(root, "objects"));
  return total;
}

async function remainingPartFiles(): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".part")) total++;
    }
  };
  await walk(path.join(root, "tmp"));
  return total;
}

describe("Content Store — adressage par contenu (Vol. IV, 4.1)", () => {
  test("le chemin d'un objet est derive de son empreinte", async () => {
    const stored = await store.store(PDF, { runId: RUN, declaredMime: "application/pdf" });
    assert.equal(stored.contentHash, computeContentHash(PDF));
    assert.equal(stored.storagePath, objectRelativePath(stored.contentHash, "none"));
    assert.match(stored.storagePath, /^objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.bin$/);
    assert.equal(stored.deduplicated, false);
  });

  test("les octets relus sont identiques aux octets ecrits (I-1)", async () => {
    const stored = await store.store(PDF, { runId: RUN, declaredMime: "application/pdf" });
    assert.deepEqual(await store.read(stored.contentHash), PDF);
  });

  test("le type est detecte dans les octets, pas dans la declaration", async () => {
    const stored = await store.store(PDF, { runId: RUN, declaredMime: "application/pdf" });
    assert.equal(stored.detectedMime, "application/pdf");
    const menteur = await store.store(new TextEncoder().encode("<html>erreur 404</html>"), {
      runId: RUN,
      declaredMime: "application/pdf",
    });
    assert.equal(menteur.mimeType, "application/pdf"); // declare par la source
    assert.equal(menteur.detectedMime, "text/html"); // lu dans les octets
  });

  test("deux contenus identiques n'occupent qu'un fichier (dedup structurelle)", async () => {
    const first = await store.store(PDF, { runId: RUN, declaredMime: "application/pdf" });
    const before = await fsp.stat(path.join(root, first.storagePath));

    const second = await store.store(Uint8Array.from(PDF), {
      runId: RUN,
      declaredMime: "application/pdf",
    });
    const after = await fsp.stat(path.join(root, second.storagePath));

    assert.equal(second.deduplicated, true);
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(await countObjectFiles(), 1);
    // AC-3.3 : aucun octet n'est reecrit sur disque lors d'une recollecte.
    assert.equal(after.mtimeMs, before.mtimeMs);
  });

  test("aucun fichier de transit ne subsiste apres une ecriture reussie", async () => {
    await store.store(PDF, { runId: RUN });
    assert.equal(await remainingPartFiles(), 0);
  });
});

describe("Content Store — compression (Vol. IV, 4.4)", () => {
  test("le texte volumineux est compresse, l'empreinte porte sur les octets bruts", async () => {
    const html = new TextEncoder().encode(`<html>${"contenu juridique ".repeat(500)}</html>`);
    const stored = await store.store(html, { runId: RUN, declaredMime: "text/html" });

    assert.equal(stored.compression, "zstd");
    assert.match(stored.storagePath, /\.bin\.zst$/);
    assert.equal(stored.contentHash, computeContentHash(html));
    assert.equal(stored.byteSize, html.length);

    const onDisk = await fsp.stat(path.join(root, stored.storagePath));
    assert.ok(onDisk.size < html.length, "le fichier stocke doit etre plus petit");
    assert.deepEqual(await store.read(stored.contentHash), html);
  });

  test("un PDF n'est jamais recompresse", async () => {
    const big = new Uint8Array(20_000);
    big.set(PDF, 0);
    const stored = await store.store(big, { runId: RUN, declaredMime: "application/pdf" });
    assert.equal(stored.compression, "none");
  });

  test("un petit texte n'est pas compresse : le gain serait nul", async () => {
    const stored = await store.store(new TextEncoder().encode("bonjour"), {
      runId: RUN,
      declaredMime: "text/plain",
    });
    assert.equal(stored.compression, "none");
  });
});

describe("Content Store — verification des attentes (E3)", () => {
  test("une signature inattendue est refusee et ne laisse aucune trace", async () => {
    await assert.rejects(
      store.store(new TextEncoder().encode("<html>404</html>"), {
        runId: RUN,
        declaredMime: "application/pdf",
        expect: { magicBytes: "25504446" },
      }),
      IntegrityError,
    );
    assert.equal(await countObjectFiles(), 0);
    assert.equal(await remainingPartFiles(), 0);
  });

  test("un objet trop petit est refuse", async () => {
    await assert.rejects(
      store.store(new TextEncoder().encode("x"), { runId: RUN, expect: { minBytes: 1024 } }),
      /trop petit/,
    );
    assert.equal(await countObjectFiles(), 0);
  });

  test("un objet trop volumineux est refuse", async () => {
    await assert.rejects(
      store.store(PDF, { runId: RUN, expect: { maxBytes: 8 } }),
      /trop volumineux/,
    );
    assert.equal(await countObjectFiles(), 0);
  });

  test("un type inattendu est refuse", async () => {
    await assert.rejects(
      store.store(PDF, {
        runId: RUN,
        declaredMime: "application/pdf",
        expect: { mimeTypes: ["application/zip"] },
      }),
      /type de contenu inattendu/,
    );
  });
});

describe("Content Store — descripteur auto-portant (I-4)", () => {
  test("le descripteur decrit l'objet sans recours a la base", async () => {
    const stored = await store.store(PDF, { runId: RUN, declaredMime: "application/pdf" });
    const descriptor = await store.readDescriptor(stored.contentHash);

    assert.ok(descriptor !== null && !isTombstone(descriptor));
    assert.equal(descriptor.contentHash, stored.contentHash);
    assert.equal(descriptor.byteSize, PDF.length);
    assert.equal(descriptor.mimeType, "application/pdf");
    assert.equal(descriptor.compression, "none");
    assert.deepEqual(descriptor.references, []);
  });

  test("un objet partage accumule ses provenances", async () => {
    const stored = await store.store(PDF, { runId: RUN, declaredMime: "application/pdf" });
    await store.attachReference(stored.contentHash, reference("2024/118", 1));
    const descriptor = await store.attachReference(stored.contentHash, reference("2024/119", 1));

    assert.equal(descriptor.references.length, 2);
    assert.deepEqual(
      descriptor.references.map((r) => r.nativeId),
      ["2024/118", "2024/119"],
    );
  });

  test("rejouer la meme reference ne gonfle pas le descripteur (idempotence)", async () => {
    const stored = await store.store(PDF, { runId: RUN });
    await store.attachReference(stored.contentHash, reference("2024/118", 1));
    const again = await store.attachReference(stored.contentHash, reference("2024/118", 1));
    assert.equal(again.references.length, 1);
  });

  test("une reference sur des octets absents est refusee", async () => {
    const absent = computeContentHash(new TextEncoder().encode("jamais stocke"));
    await assert.rejects(
      store.attachReference(absent, reference("2024/120", 1)),
      /aucun descripteur/,
    );
  });

  test("le parcours du magasin reconstruit l'inventaire sans la base (reindex)", async () => {
    const a = await store.store(PDF, { runId: RUN, declaredMime: "application/pdf" });
    await store.attachReference(a.contentHash, reference("2024/118", 1));
    const b = await store.store(new TextEncoder().encode("%PDF-1.7 autre"), { runId: RUN });
    await store.attachReference(b.contentHash, reference("2024/119", 1));

    const scanned = [];
    for await (const entry of store.scan()) scanned.push(entry);

    assert.equal(scanned.length, 2);
    assert.ok(scanned.every((entry) => entry.bytesPresent));
    const hashes = scanned.map((entry) => entry.descriptor.contentHash).sort();
    assert.deepEqual(hashes, [a.contentHash, b.contentHash].sort());
  });
});

describe("Content Store — integrite (Vol. IV, ch. 7)", () => {
  test("un objet intact est verifie ok", async () => {
    const stored = await store.store(PDF, { runId: RUN });
    const check = await store.verify(stored.contentHash);
    assert.equal(check.result, "ok");
  });

  test("une alteration des octets est detectee a la verification", async () => {
    const stored = await store.store(PDF, { runId: RUN });
    const corrupted = new Uint8Array(PDF);
    corrupted[10] = (corrupted[10] as number) ^ 0xff;
    await fsp.writeFile(path.join(root, stored.storagePath), corrupted);

    const check = await store.verify(stored.contentHash);
    assert.equal(check.result, "hash_mismatch");
    assert.equal(check.expectedHash, stored.contentHash);
    assert.notEqual(check.actualHash, stored.contentHash);
  });

  test("une alteration est detectee aussi a la lecture, systematiquement", async () => {
    const stored = await store.store(PDF, { runId: RUN });
    await fsp.writeFile(path.join(root, stored.storagePath), new Uint8Array(PDF.length));
    await assert.rejects(store.read(stored.contentHash), IntegrityError);
  });

  test("une taille divergente est signalee avant meme le hachage", async () => {
    const stored = await store.store(PDF, { runId: RUN });
    await fsp.writeFile(path.join(root, stored.storagePath), new Uint8Array(3));
    const check = await store.verify(stored.contentHash);
    assert.equal(check.result, "size_mismatch");
  });

  test("un fichier absent est signale manquant, jamais silencieusement ignore", async () => {
    const stored = await store.store(PDF, { runId: RUN });
    await fsp.rm(path.join(root, stored.storagePath));
    const check = await store.verify(stored.contentHash);
    assert.equal(check.result, "missing_file");
  });

  test("une purge tracee se distingue d'une corruption (pierre tombale)", async () => {
    const stored = await store.store(PDF, { runId: RUN });
    await store.purge(stored.contentHash, {
      reason: "legal",
      legalRef: "decision 2026-XXX",
      operator: "ops@example.org",
    });

    const check = await store.verify(stored.contentHash);
    assert.equal(check.result, "ok");
    assert.match(String(check.actionTaken), /^tombstone:legal$/);

    const descriptor = await store.readDescriptor(stored.contentHash);
    assert.ok(descriptor !== null && isTombstone(descriptor));
    assert.equal(descriptor.legalRef, "decision 2026-XXX");
    assert.equal(descriptor.byteSize, PDF.length);
    assert.equal(await store.has(stored.contentHash), false);
  });

  test("aucune reference ne peut etre ajoutee a un objet purge", async () => {
    const stored = await store.store(PDF, { runId: RUN });
    await store.purge(stored.contentHash, { reason: "legal" });
    await assert.rejects(
      store.attachReference(stored.contentHash, reference("2024/118", 1)),
      /purge/,
    );
  });
});

describe("Content Store — points de panne du protocole d'ecriture (Vol. IV, 5.2)", () => {
  const stages = ["E1", "E2", "E3", "E4", "E5", "E6"] as const;

  for (const stage of stages) {
    test(`panne apres ${stage} : au pire un .part orphelin, aucun objet publie`, async () => {
      const failing = new FilesystemContentStore({
        root,
        fsync: false,
        observer: (observed) => {
          if (observed === stage) throw new Error(`panne simulee apres ${stage}`);
        },
      });
      await assert.rejects(failing.store(PDF, { runId: RUN }), /panne simulee/);

      assert.equal(await countObjectFiles(), 0);
      // Le nettoyage au demarrage suivant efface la zone de transit.
      await store.cleanupTmp();
      assert.equal(await remainingPartFiles(), 0);
    });
  }

  test("panne apres E7 : objet present, absent de la base, aucune perte", async () => {
    const failing = new FilesystemContentStore({
      root,
      fsync: false,
      observer: (observed) => {
        if (observed === "E7") throw new Error("panne simulee apres E7");
      },
    });
    await assert.rejects(failing.store(PDF, { runId: RUN }), /panne simulee/);

    const hash = computeContentHash(PDF);
    assert.equal(await store.has(hash), true);
    assert.equal(await store.readDescriptor(hash), null);

    // Le prochain passage redecouvre l'objet : rename sur un objet existant
    // est un no-op, et l'ecriture se termine normalement.
    const retried = await store.store(PDF, { runId: RUN });
    assert.equal(retried.deduplicated, true);
    assert.equal(retried.contentHash, hash);
    assert.notEqual(await store.readDescriptor(hash), null);
  });

  test("panne apres E8 : objet et descripteur presents, base a rattraper", async () => {
    const failing = new FilesystemContentStore({
      root,
      fsync: false,
      observer: (observed) => {
        if (observed === "E8") throw new Error("panne simulee apres E8");
      },
    });
    await assert.rejects(failing.store(PDF, { runId: RUN }), /panne simulee/);

    const hash = computeContentHash(PDF);
    assert.equal(await store.has(hash), true);
    const descriptor = await store.readDescriptor(hash);
    assert.ok(descriptor !== null && !isTombstone(descriptor));
    assert.equal((await store.verify(hash)).result, "ok");
  });

  test("la zone de transit est nettoyee au demarrage", async () => {
    const tmpRun = path.join(root, "tmp", "run_ORPHELIN");
    await fsp.mkdir(tmpRun, { recursive: true });
    await fsp.writeFile(path.join(tmpRun, "abandonne.part"), PDF);

    const removed = await store.cleanupTmp();
    assert.equal(removed, 1);
    assert.equal(await remainingPartFiles(), 0);
  });
});

describe("Content Store — contraintes de disposition", () => {
  test("l'ecriture refuse un contenu depassant le plafond dur du magasin", async () => {
    const limited = new FilesystemContentStore({ root, fsync: false, maxObjectBytes: 16 });
    await assert.rejects(limited.store(new Uint8Array(64), { runId: RUN }), IntegrityError);
  });

  test("un flux asynchrone est accepte sans charger le contenu en memoire", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield PDF.subarray(0, 10);
      yield PDF.subarray(10);
    }
    const stored = await store.store(chunks(), { runId: RUN, declaredMime: "application/pdf" });
    assert.equal(stored.contentHash, computeContentHash(PDF));
    assert.deepEqual(await store.read(stored.contentHash), PDF);
  });

  test("les empreintes trop courtes sont refusees avant tout acces disque", async () => {
    await assert.rejects(async () => store.has("sha256:ab" as ContentHash), /trop courte/);
  });
});
