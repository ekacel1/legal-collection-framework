/**
 * Disposition physique du magasin — Volume IV, chapitre 4.1.
 *
 * Le magasin est adresse par contenu : le chemin d'un fichier est derive de son
 * empreinte. Le partitionnement a deux niveaux sur les quatre premiers
 * caracteres hexadecimaux produit 65 536 repertoires terminaux ; a 100 millions
 * de documents cela reste ~1 500 fichiers par repertoire, en deca du seuil ou
 * les systemes de fichiers classiques se degradent.
 *
 *   data/
 *     objects/6b/1d/6b1d...f31.bin     octets originaux, jamais modifies
 *     objects/6b/1d/6b1d...f31.json    descripteur auto-portant (invariant I-4)
 *     tmp/run_01J9X3S9/<uuid>.part     zone de transit, nettoyee au demarrage
 *     index/lcf.db                     base de donnees (reconstructible)
 *     backup/
 */
import { contentHashHex, type ContentHash } from "../domain/ids.js";
import type { Compression } from "../domain/model.js";

export const OBJECTS_DIR = "objects";
export const TMP_DIR = "tmp";
export const INDEX_DIR = "index";
export const BACKUP_DIR = "backup";
export const DERIVED_DIR = "derived";

/** Nom du fichier de base d'index, sous `index/`. */
export const INDEX_DB_FILE = "lcf.db";

/** Extension portee par le fichier d'octets, selon le mode de stockage. */
const COMPRESSION_SUFFIX: Record<Compression, string> = {
  none: ".bin",
  zstd: ".bin.zst",
  gzip: ".bin.gz",
};

export function compressionSuffix(compression: Compression): string {
  return COMPRESSION_SUFFIX[compression];
}

/** Segments de partitionnement : les quatre premiers caracteres hexadecimaux. */
export function shardOf(hash: ContentHash): readonly [string, string] {
  const hex = contentHashHex(hash);
  if (hex.length < 4) {
    throw new TypeError(`empreinte trop courte pour le partitionnement : ${hash}`);
  }
  return [hex.slice(0, 2), hex.slice(2, 4)];
}

/**
 * Chemin du fichier d'octets, relatif a la racine du magasin.
 * Toujours en separateurs POSIX : ce chemin est persiste en base et doit
 * rester identique d'un systeme d'exploitation a l'autre (invariant I-7).
 */
export function objectRelativePath(hash: ContentHash, compression: Compression): string {
  const [a, b] = shardOf(hash);
  return `${OBJECTS_DIR}/${a}/${b}/${contentHashHex(hash)}${compressionSuffix(compression)}`;
}

/** Chemin du descripteur auto-portant, relatif a la racine du magasin. */
export function descriptorRelativePath(hash: ContentHash): string {
  const [a, b] = shardOf(hash);
  return `${OBJECTS_DIR}/${a}/${b}/${contentHashHex(hash)}.json`;
}

/** Repertoire terminal contenant l'objet et son descripteur. */
export function objectDirRelativePath(hash: ContentHash): string {
  const [a, b] = shardOf(hash);
  return `${OBJECTS_DIR}/${a}/${b}`;
}

/** Zone de transit propre a une execution, nettoyee au demarrage suivant. */
export function tmpDirRelativePath(runId: string): string {
  return `${TMP_DIR}/${runId}`;
}

/** Les trois modes de stockage possibles, dans l'ordre de recherche a la lecture. */
export const COMPRESSION_MODES: readonly Compression[] = Object.freeze([
  "none",
  "zstd",
  "gzip",
]);
