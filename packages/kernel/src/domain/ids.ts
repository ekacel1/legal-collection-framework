/**
 * Identites du domaine — Volume IV, chapitre 2.3.
 *
 * Deux axes strictement distincts, jamais confondus :
 *   DocumentId  identifie l'entite documentaire ....... ne change jamais
 *   ContentHash identifie une version d'octets ........ change a chaque modification
 */
import { createHash, randomFillSync } from "node:crypto";

/** Identifiant d'une source configuree. Fourni par la configuration, jamais derive. */
export type SourceId = string & { readonly __brand: "SourceId" };

/** Identite globale d'un document. Derivee par le Kernel, jamais par un plugin. */
export type DocumentId = string & { readonly __brand: "DocumentId" };

/** Empreinte de contenu, prefixee de l'algorithme : "sha256:<hex>". */
export type ContentHash = string & { readonly __brand: "ContentHash" };

/** Identifiant d'execution : "run_" + ULID, trie par le temps. */
export type RunId = string & { readonly __brand: "RunId" };

/** Horodatage ISO-8601 UTC, millisecondes, suffixe Z. */
export type IsoTimestamp = string & { readonly __brand: "IsoTimestamp" };

/**
 * Separateur d'identite (Unit Separator, 0x1F) — Volume IV, 2.3.
 *
 * Sans separateur non ambigu, ("ab", "c") et ("a", "bc") produiraient le meme
 * identifiant. Une collision d'identite entre deux sources est indetectable
 * une fois survenue : elle ne leve aucune erreur, elle fusionne deux documents.
 */
export const IDENTITY_SEPARATOR = "\u001F";

/** Algorithme d'empreinte courant. Le prefixe permet d'en changer sans migration. */
export const HASH_ALGORITHM = "sha256";

export function asSourceId(value: string): SourceId {
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(value)) {
    throw new TypeError(`source_id invalide : ${JSON.stringify(value)}`);
  }
  return value as SourceId;
}

/**
 * DocumentId = sha256( sourceId || 0x1F || nativeId )
 *
 * Deterministe, independant du contenu, stable si le document est revise.
 */
export function computeDocumentId(sourceId: SourceId, nativeId: string): DocumentId {
  if (nativeId.length === 0) {
    throw new TypeError("nativeId vide : identite indeterminable");
  }
  if (nativeId.includes(IDENTITY_SEPARATOR)) {
    throw new TypeError("nativeId contient le separateur d'identite 0x1F");
  }
  return createHash(HASH_ALGORITHM)
    .update(sourceId, "utf8")
    .update(IDENTITY_SEPARATOR, "utf8")
    .update(nativeId, "utf8")
    .digest("hex") as DocumentId;
}

/** ContentHash = sha256( octets ), prefixe de l'algorithme. */
export function computeContentHash(bytes: Uint8Array): ContentHash {
  return formatContentHash(createHash(HASH_ALGORITHM).update(bytes).digest("hex"));
}

export function formatContentHash(hexDigest: string): ContentHash {
  return `${HASH_ALGORITHM}:${hexDigest}` as ContentHash;
}

/** Retourne la partie hexadecimale d'une empreinte, sans son prefixe d'algorithme. */
export function contentHashHex(hash: ContentHash): string {
  const separator = hash.indexOf(":");
  return separator === -1 ? hash : hash.slice(separator + 1);
}

export function contentHashAlgorithm(hash: ContentHash): string {
  const separator = hash.indexOf(":");
  return separator === -1 ? HASH_ALGORITHM : hash.slice(0, separator);
}

export function parseContentHash(value: string): ContentHash {
  if (!/^[a-z0-9-]+:[0-9a-f]{32,128}$/.test(value)) {
    throw new TypeError(`empreinte invalide : ${JSON.stringify(value)}`);
  }
  return value as ContentHash;
}

// ---------------------------------------------------------------------------
// ULID — Volume IV, 2.3 : identifiant d'execution trie par le temps
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

let lastUlidTime = -1;
let lastUlidRandom: number[] = [];

function encodeTime(millis: number): string {
  let time = millis;
  let out = "";
  for (let i = 0; i < TIME_LENGTH; i++) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  randomFillSync(bytes);
  return Array.from(bytes, (b) => b % 32);
}

/**
 * ULID monotone : deux appels dans la meme milliseconde restent ordonnes.
 * Sans cette garantie, l'ordre des executions d'une meme milliseconde serait
 * arbitraire, et la reprise sur incident deviendrait non deterministe.
 */
export function ulid(nowMillis: number = Date.now()): string {
  if (nowMillis === lastUlidTime) {
    for (let i = RANDOM_LENGTH - 1; i >= 0; i--) {
      const value = lastUlidRandom[i] ?? 0;
      if (value < 31) {
        lastUlidRandom[i] = value + 1;
        break;
      }
      lastUlidRandom[i] = 0;
    }
  } else {
    lastUlidTime = nowMillis;
    lastUlidRandom = randomChars();
  }
  return encodeTime(nowMillis) + lastUlidRandom.map((v) => CROCKFORD[v]).join("");
}

export function newRunId(nowMillis: number = Date.now()): RunId {
  return `run_${ulid(nowMillis)}` as RunId;
}

// ---------------------------------------------------------------------------
// Horodatages — Volume IV, 3.2
// ---------------------------------------------------------------------------

/** ISO-8601 UTC, millisecondes, suffixe Z : lisible, triable lexicographiquement. */
export function toIsoTimestamp(date: Date | number): IsoTimestamp {
  const d = typeof date === "number" ? new Date(date) : date;
  return d.toISOString() as IsoTimestamp;
}

export function parseIsoTimestamp(value: string): IsoTimestamp {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`horodatage invalide : ${JSON.stringify(value)}`);
  }
  return toIsoTimestamp(parsed);
}
