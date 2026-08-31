/**
 * Contrat du magasin de contenu — Volume IV, chapitres 4 et 5.
 *
 * Le magasin est la seule autorite sur les octets. Aucun plugin, aucun
 * processeur, aucune couche de presentation n'ecrit dans `objects/`.
 */
import type { ContentHash, IsoTimestamp, RunId } from "../domain/ids.js";
import type { Compression, IntegrityCheck } from "../domain/model.js";
import type { FetchExpectation } from "../domain/contract.js";
import type { DescriptorFile, ObjectDescriptor, ObjectReference } from "./descriptor.js";

/** Sources d'octets acceptees en ecriture. Le flux est privilegie. */
export type ContentInput = Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export interface StoreWriteOptions {
  /** Execution proprietaire de la zone de transit. */
  readonly runId: RunId;
  /** Type annonce par la source. Conserve tel quel, jamais presume exact. */
  readonly declaredMime?: string;
  /** Attentes declarees dans le FetchPlan et le manifeste (E3). */
  readonly expect?: FetchExpectation;
}

export interface StoredObject {
  readonly contentHash: ContentHash;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly detectedMime?: string;
  /** Relatif a la racine du magasin, separateurs POSIX. */
  readonly storagePath: string;
  readonly compression: Compression;
  readonly storedAt: IsoTimestamp;
  /**
   * Les octets etaient deja presents : aucune reecriture n'a eu lieu.
   * C'est le cas nominal d'une recollecte a contenu identique (AC-3.3).
   */
  readonly deduplicated: boolean;
}

/**
 * Etapes du protocole d'ecriture atomique — Volume IV, 5.1.
 * Nommees pour etre observables : la suite de tests injecte une panne a chaque
 * etape et verifie l'etat resultant du magasin (Vol. IX, 4.1).
 */
export type WriteStage = "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8" | "E9";

export interface WriteStageContext {
  readonly runId?: RunId;
  readonly partPath?: string;
  readonly contentHash?: ContentHash;
  readonly byteSize?: number;
}

/** Observateur d'etapes : tracage en exploitation, injection de panne en test. */
export type WriteStageObserver = (
  stage: WriteStage,
  context: WriteStageContext,
) => void | Promise<void>;

export interface ScannedObject {
  readonly descriptor: DescriptorFile;
  /** Chemin du descripteur, relatif a la racine du magasin. */
  readonly descriptorPath: string;
  /** Les octets sont-ils presents a cote du descripteur ? */
  readonly bytesPresent: boolean;
}

export interface PurgeRequest {
  readonly reason: string;
  readonly legalRef?: string;
  readonly operator?: string;
}

export interface ContentStore {
  /** Cree la disposition, verifie les contraintes de volume, nettoie `tmp/`. */
  init(): Promise<void>;

  /** Supprime les fichiers de transit orphelins. Retourne le nombre supprime. */
  cleanupTmp(): Promise<number>;

  /** Etapes E1 a E7 : les octets sont sur le disque, adresses par empreinte. */
  store(input: ContentInput, options: StoreWriteOptions): Promise<StoredObject>;

  /**
   * Ajoute une reference au descripteur auto-portant (E8, rejoue).
   * Appelee apres `store()`, une fois le numero de version decide.
   */
  attachReference(hash: ContentHash, reference: ObjectReference): Promise<ObjectDescriptor>;

  has(hash: ContentHash): Promise<boolean>;

  /** Lecture verifiee : toute divergence d'empreinte leve — Volume IV, 7.1. */
  read(hash: ContentHash): Promise<Uint8Array>;

  readDescriptor(hash: ContentHash): Promise<DescriptorFile | null>;

  /** Verification d'un objet, sans jamais le modifier ni le supprimer. */
  verify(hash: ContentHash): Promise<IntegrityCheck>;

  /** Parcours integral du magasin : base de la reindexation (invariant I-4). */
  scan(): AsyncIterable<ScannedObject>;

  /** Suppression tracee, jamais un effet de bord — Volume IV, 8.2. */
  purge(hash: ContentHash, request: PurgeRequest): Promise<void>;

  /** Racine absolue du magasin. */
  readonly root: string;
}
