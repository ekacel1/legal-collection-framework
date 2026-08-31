/**
 * Detection de type par signature — Volume IV, 4.3 (`detectedMime`).
 *
 * Le type declare par une source n'engage qu'elle. Le type detecte est lu dans
 * les octets. Les deux sont conserves : leur divergence est en soi une
 * information, et une source qui annonce du PDF en servant du HTML d'erreur est
 * un mode de panne courant qu'aucune verification de taille ne detecte.
 */

/** Nombre d'octets suffisant pour toutes les signatures reconnues. */
export const SNIFF_BYTES = 4096;

interface Signature {
  readonly mime: string;
  /** Signature en hexadecimal, comparee a l'offset indique. */
  readonly magic: string;
  readonly offset?: number;
}

const SIGNATURES: readonly Signature[] = [
  { mime: "application/pdf", magic: "25504446" }, // %PDF
  { mime: "application/zip", magic: "504b0304" }, // PK..  (inclut docx, xlsx, odt)
  { mime: "application/zip", magic: "504b0506" }, // archive vide
  { mime: "image/png", magic: "89504e470d0a1a0a" },
  { mime: "image/jpeg", magic: "ffd8ff" },
  { mime: "image/gif", magic: "474946383761" },
  { mime: "image/gif", magic: "474946383961" },
  { mime: "image/tiff", magic: "49492a00" },
  { mime: "application/gzip", magic: "1f8b" },
  { mime: "application/zstd", magic: "28b52ffd" },
  { mime: "application/x-7z-compressed", magic: "377abcaf271c" },
  { mime: "application/x-rar-compressed", magic: "526172211a07" },
  { mime: "application/msword", magic: "d0cf11e0a1b11ae1" }, // OLE2 : doc, xls, ppt
  { mime: "application/rtf", magic: "7b5c727466" }, // {\rtf
  { mime: "application/postscript", magic: "25215053" }, // %!PS
  { mime: "application/x-tar", magic: "7573746172", offset: 257 }, // "ustar"
];

function toHex(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

/** La tete de fichier porte-t-elle la signature hexadecimale attendue ? */
export function matchesMagic(head: Uint8Array, magicHex: string, offset = 0): boolean {
  const normalized = magicHex.toLowerCase().replace(/\s+/g, "");
  if (normalized.length === 0) return true;
  return toHex(head, offset, normalized.length / 2) === normalized;
}

function looksLikeUtf8Text(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - 3));
  } catch {
    return false;
  }
  // Aucun octet de controle hors tabulation, saut de ligne, retour chariot.
  for (const byte of head) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

/**
 * Type detecte a partir des octets, ou `undefined` si indeterminable.
 * En cas de doute, le magasin ne transforme rien et ne conclut rien.
 */
export function detectMime(head: Uint8Array): string | undefined {
  for (const signature of SIGNATURES) {
    if (matchesMagic(head, signature.magic, signature.offset ?? 0)) {
      return signature.mime;
    }
  }
  if (!looksLikeUtf8Text(head)) return undefined;

  const text = new TextDecoder("utf-8").decode(head.subarray(0, 512)).trimStart();
  const lower = text.toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) return "text/html";
  if (lower.startsWith("<?xml")) return "application/xml";
  if (text.startsWith("{") || text.startsWith("[")) return "application/json";
  return "text/plain";
}

// ---------------------------------------------------------------------------
// Politique de compression — Volume IV, 4.4
// ---------------------------------------------------------------------------

/** En deca de ce seuil, la compression coute plus qu'elle ne rapporte. */
export const COMPRESSION_MIN_BYTES = 4096;

const COMPRESSIBLE = [
  /^text\//,
  /^application\/(json|xml|xhtml\+xml|javascript|x-ndjson|csv)$/,
  /\+json$/,
  /\+xml$/,
];

/**
 * PDF, images et archives sont deja compresses : les recomprimer coute du CPU
 * pour un gain nul. Le texte gagne typiquement 70 a 85 % en zstd.
 *
 * Point capital : l'empreinte porte toujours sur les octets DECOMPRESSES.
 * Changer de politique de compression n'invalide donc aucune empreinte, ne
 * casse aucune reference, et n'exige aucune migration.
 */
export function isCompressible(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return COMPRESSIBLE.some((pattern) => pattern.test(normalized));
}
