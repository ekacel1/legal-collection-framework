import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  asSourceId,
  computeContentHash,
  computeDocumentId,
  contentHashAlgorithm,
  contentHashHex,
  newRunId,
  parseContentHash,
  toIsoTimestamp,
  ulid,
} from "../src/domain/ids.js";

describe("identites du domaine (Vol. IV, 2.3)", () => {
  test("document_id est deterministe et independant du contenu", () => {
    const source = asSourceId("example.gazette");
    const a = computeDocumentId(source, "2024/118");
    const b = computeDocumentId(source, "2024/118");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test("le separateur 0x1F empeche la collision d'identite entre sources", () => {
    // Sans separateur non ambigu, ("ab","c") et ("a","bc") produiraient le meme id.
    const first = computeDocumentId(asSourceId("ab"), "c");
    const second = computeDocumentId(asSourceId("a"), "bc");
    assert.notEqual(first, second);
  });

  test("un nativeId contenant le separateur est refuse", () => {
    assert.throws(() => computeDocumentId(asSourceId("s"), "ab"), /separateur/);
  });

  test("un nativeId vide est refuse : l'identite serait indeterminable", () => {
    assert.throws(() => computeDocumentId(asSourceId("s"), ""), /vide/);
  });

  test("content_hash porte le prefixe d'algorithme", () => {
    const hash = computeContentHash(new TextEncoder().encode("bonjour"));
    assert.equal(contentHashAlgorithm(hash), "sha256");
    assert.match(contentHashHex(hash), /^[0-9a-f]{64}$/);
    assert.equal(hash, parseContentHash(hash));
  });

  test("deux contenus identiques produisent la meme empreinte (dedup structurelle)", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    assert.equal(computeContentHash(bytes), computeContentHash(Uint8Array.from(bytes)));
  });

  test("une empreinte mal formee est refusee", () => {
    assert.throws(() => parseContentHash("deadbeef"), /invalide/);
  });

  test("un source_id non conforme est refuse a la construction", () => {
    assert.throws(() => asSourceId("mauvais id!"), /invalide/);
  });
});

describe("ULID (Vol. IV, 2.3)", () => {
  test("les identifiants d'une meme milliseconde restent ordonnes", () => {
    const ids = Array.from({ length: 50 }, () => ulid(1_700_000_000_000));
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("l'ordre lexicographique suit l'ordre temporel", () => {
    const older = ulid(1_700_000_000_000);
    const newer = ulid(1_700_000_001_000);
    assert.ok(older < newer);
  });

  test("run_id est prefixe et de longueur stable", () => {
    const runId = newRunId(1_700_000_000_000);
    assert.match(runId, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("horodatages (Vol. IV, 3.2)", () => {
  test("ISO-8601 UTC, millisecondes, suffixe Z, triable lexicographiquement", () => {
    const earlier = toIsoTimestamp(1_700_000_000_000);
    const later = toIsoTimestamp(1_700_000_001_000);
    assert.match(earlier, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(earlier < later);
  });
});
