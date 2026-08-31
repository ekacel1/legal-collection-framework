/**
 * JSON canonique — Volume IV, 3.2.
 *
 * Deux representations differentes du meme objet produiraient deux empreintes
 * differentes. Partout ou du JSON est hache ou compare (config_hash,
 * descripteurs, sommes de controle de migration), il doit etre canonique :
 * cles triees, aucun espace superflu, aucune valeur `undefined`.
 */

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("JSON canonique : nombre non fini");
      }
      return value;
    case "bigint":
      return value.toString();
    default:
      break;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item) ?? null);
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    throw new TypeError("JSON canonique : les octets bruts ne sont pas serialisables");
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      const normalized = normalize(source[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }

  return undefined;
}

/** Serialisation stable : memes donnees, memes octets, quel que soit l'ordre d'insertion. */
export function canonicalStringify(value: unknown): string {
  const normalized = normalize(value);
  return JSON.stringify(normalized === undefined ? null : normalized);
}

/** Version indentee, pour les fichiers destines a la lecture humaine. */
export function canonicalStringifyPretty(value: unknown): string {
  const normalized = normalize(value);
  return JSON.stringify(normalized === undefined ? null : normalized, null, 2);
}
