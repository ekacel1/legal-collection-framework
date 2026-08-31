/**
 * Descripteur auto-portant — Volume IV, 4.3 (invariant I-4).
 *
 * Si la base de donnees est integralement perdue, le corpus doit rester
 * exploitable : chaque fichier stocke est accompagne d'un descripteur JSON qui
 * contient tout ce qu'il faut pour reconstruire l'index. La base devient un
 * cache reconstructible, jamais une source de verite unique.
 *
 * Le cout est reel — une ecriture supplementaire, environ 1 Kio par document.
 * Le benefice est asymetrique : il transforme une catastrophe (perte de corpus)
 * en incident (reconstruction de quelques heures).
 */
import type { ContentHash, DocumentId, IsoTimestamp, RunId, SourceId } from "../domain/ids.js";
import type { ChangeReason, Compression } from "../domain/model.js";
import type { SourceMetadata } from "../domain/contract.js";
import { canonicalStringifyPretty } from "../util/canonical-json.js";

/** Version du format de descripteur. Rupture jamais visee (Vol. IX, 3.1). */
export const LCF_OBJECT_VERSION = 1;

/** Une reference : quel document, quelle version, quelle execution. */
export interface ObjectReference {
  readonly documentId: DocumentId;
  readonly sourceId: SourceId;
  readonly nativeId: string;
  readonly versionNo: number;
  readonly fetchedFromUrl?: string;
  readonly fetchedAt: IsoTimestamp;
  readonly runId: RunId;
  readonly httpEtag?: string;
  readonly httpLastModified?: string;
  readonly changeReason: ChangeReason;
  readonly metadata?: {
    readonly raw: SourceMetadata["raw"];
    readonly common?: SourceMetadata["common"];
    readonly provenance: SourceMetadata["provenance"];
  };
}

/**
 * Le descripteur porte une LISTE de references, pas une reference unique :
 * un objet partage par plusieurs documents accumule ses provenances.
 */
export interface ObjectDescriptor {
  readonly lcfObjectVersion: number;
  readonly contentHash: ContentHash;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly detectedMime?: string;
  /** Mode de stockage : detail physique, sans effet sur l'empreinte. */
  readonly compression: Compression;
  readonly storedAt: IsoTimestamp;
  readonly references: readonly ObjectReference[];
}

/**
 * Pierre tombale — Volume IV, 8.2.
 *
 * Sans elle, une verification d'integrite ulterieure signalerait un fichier
 * manquant, et l'on ne saurait pas distinguer une suppression legitime d'une
 * corruption.
 */
export interface ObjectTombstone {
  readonly lcfObjectVersion: number;
  readonly tombstone: true;
  readonly contentHash: ContentHash;
  readonly purgedAt: IsoTimestamp;
  readonly reason: string;
  readonly legalRef?: string;
  readonly operator?: string;
  readonly byteSize: number;
}

export type DescriptorFile = ObjectDescriptor | ObjectTombstone;

export function isTombstone(file: DescriptorFile): file is ObjectTombstone {
  return (file as ObjectTombstone).tombstone === true;
}

export function serializeDescriptor(file: DescriptorFile): string {
  return canonicalStringifyPretty(file) + "\n";
}

export function parseDescriptor(text: string): DescriptorFile {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("descripteur illisible : racine non objet");
  }
  const candidate = parsed as Partial<ObjectDescriptor & ObjectTombstone>;
  if (typeof candidate.contentHash !== "string") {
    throw new TypeError("descripteur illisible : contentHash absent");
  }
  if (candidate.tombstone === true) return parsed as ObjectTombstone;
  if (!Array.isArray(candidate.references)) {
    throw new TypeError("descripteur illisible : references absentes");
  }
  return parsed as ObjectDescriptor;
}

/**
 * Ajoute une reference sans jamais en perdre une.
 *
 * L'unicite porte sur (documentId, versionNo) : rejouer la meme collecte ne
 * doit pas gonfler le descripteur, mais deux documents distincts partageant les
 * memes octets doivent tous deux y figurer.
 */
export function mergeReference(
  descriptor: ObjectDescriptor,
  reference: ObjectReference,
): ObjectDescriptor {
  const kept = descriptor.references.filter(
    (existing) =>
      existing.documentId !== reference.documentId || existing.versionNo !== reference.versionNo,
  );
  return { ...descriptor, references: [...kept, reference] };
}

/** Le descripteur contient-il deja exactement cette reference ? */
export function hasReference(
  descriptor: ObjectDescriptor,
  documentId: DocumentId,
  versionNo: number,
): boolean {
  return descriptor.references.some(
    (reference) => reference.documentId === documentId && reference.versionNo === versionNo,
  );
}
