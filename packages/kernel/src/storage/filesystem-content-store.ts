/**
 * Magasin de contenu sur systeme de fichiers — Volume IV, chapitres 4 et 5.
 *
 * Le protocole d'ecriture est le chemin critique du systeme. Toute panne, a
 * n'importe quelle etape, doit laisser le magasin dans un etat coherent :
 *
 *   E1  creer data/tmp/<run_id>/<uuid>.part
 *   E2  streamer les octets, calculer SHA-256 au fil de l'eau
 *   E3  verifier taille, type MIME, magic bytes
 *   E4  calculer le chemin cible depuis l'empreinte
 *   E5  l'objet existe deja ? oui -> E8 (deduplication)
 *   E6  fsync du fichier temporaire
 *   E7  rename atomique tmp/*.part -> objects/xx/yy/<hash>.bin
 *   E8  ecrire/mettre a jour le descripteur .json (tmp + rename)
 *   E9  fsync du repertoire parent
 *
 * L'ordre garantit qu'aucune sequence de panne ne produit une entree de base
 * pointant vers un fichier absent : le fichier est toujours ecrit et
 * synchronise AVANT la transaction. L'inverse produirait des references
 * fantomes, c'est-a-dire une corruption silencieuse.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createGunzip,
  createGzip,
  createZstdCompress,
  createZstdDecompress,
  gunzipSync,
  zstdDecompressSync,
} from "node:zlib";

import { IntegrityError, StorageError } from "../domain/errors.js";
import {
  computeContentHash,
  contentHashHex,
  formatContentHash,
  toIsoTimestamp,
  type ContentHash,
} from "../domain/ids.js";
import type { Compression, IntegrityCheck } from "../domain/model.js";
import type { Clock } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import {
  BACKUP_DIR,
  COMPRESSION_MODES,
  INDEX_DIR,
  OBJECTS_DIR,
  TMP_DIR,
  descriptorRelativePath,
  objectRelativePath,
  tmpDirRelativePath,
} from "./layout.js";
import { COMPRESSION_MIN_BYTES, SNIFF_BYTES, detectMime, isCompressible, matchesMagic } from "./mime.js";
import {
  LCF_OBJECT_VERSION,
  hasReference,
  isTombstone,
  mergeReference,
  parseDescriptor,
  serializeDescriptor,
  type DescriptorFile,
  type ObjectDescriptor,
  type ObjectReference,
  type ObjectTombstone,
} from "./descriptor.js";
import type {
  ContentInput,
  ContentStore,
  PurgeRequest,
  ScannedObject,
  StoreWriteOptions,
  StoredObject,
  WriteStage,
  WriteStageContext,
  WriteStageObserver,
} from "./content-store.js";

/** Plafond dur par defaut, aligne sur `integrity.maxDocumentBytes` du manifeste. */
export const DEFAULT_MAX_OBJECT_BYTES = 200 * 1024 * 1024;

export interface FilesystemContentStoreOptions {
  readonly root: string;
  readonly clock?: Clock;
  readonly maxObjectBytes?: number;
  /** Desactivable uniquement en test : la durabilite depend de ces appels. */
  readonly fsync?: boolean;
  readonly observer?: WriteStageObserver;
}

interface LocatedObject {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly compression: Compression;
}

export class FilesystemContentStore implements ContentStore {
  readonly root: string;
  readonly #clock: Clock;
  readonly #maxObjectBytes: number;
  readonly #fsync: boolean;
  readonly #observer: WriteStageObserver | undefined;

  constructor(options: FilesystemContentStoreOptions) {
    this.root = path.resolve(options.root);
    this.#clock = options.clock ?? new SystemClock();
    this.#maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.#fsync = options.fsync ?? true;
    this.#observer = options.observer;
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    for (const dir of [OBJECTS_DIR, TMP_DIR, INDEX_DIR, BACKUP_DIR]) {
      await fsp.mkdir(path.join(this.root, dir), { recursive: true });
    }
    await this.#assertSameVolume();
    await this.cleanupTmp();
  }

  /**
   * `rename` n'est atomique que sur un meme systeme de fichiers. C'est la seule
   * primitive d'atomicite dont depend le magasin : la contrainte est verifiee
   * au demarrage plutot que decouverte lors d'une panne.
   */
  async #assertSameVolume(): Promise<void> {
    const [objects, tmp] = await Promise.all([
      fsp.stat(path.join(this.root, OBJECTS_DIR)),
      fsp.stat(path.join(this.root, TMP_DIR)),
    ]);
    if (objects.dev !== tmp.dev) {
      throw new StorageError(
        "objects/ et tmp/ sont sur des volumes differents : le rename atomique est impossible",
        { context: { root: this.root } },
      );
    }
  }

  async cleanupTmp(): Promise<number> {
    const tmpRoot = path.join(this.root, TMP_DIR);
    let removed = 0;
    let entries: string[];
    try {
      entries = await fsp.readdir(tmpRoot);
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return 0;
      throw new StorageError("zone de transit illisible", { cause });
    }
    for (const entry of entries) {
      const target = path.join(tmpRoot, entry);
      const count = await countFiles(target);
      await fsp.rm(target, { recursive: true, force: true });
      removed += count;
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Ecriture — E1 a E7
  // -------------------------------------------------------------------------

  async store(input: ContentInput, options: StoreWriteOptions): Promise<StoredObject> {
    const tmpDir = path.join(this.root, tmpDirRelativePath(options.runId));
    await fsp.mkdir(tmpDir, { recursive: true });
    const partPath = path.join(tmpDir, `${randomUUID()}.part`);
    await this.#observe("E1", { runId: options.runId, partPath });

    let written: StreamOutcome;
    try {
      written = await this.#streamToPart(input, partPath, options);
    } catch (error) {
      await safeUnlink(partPath);
      throw error;
    }

    const { contentHash, byteSize, compression } = written;
    await this.#observe("E2", { runId: options.runId, partPath, contentHash, byteSize });

    try {
      const mimeType = this.#verifyExpectations(written, options);
      await this.#observe("E3", { runId: options.runId, partPath, contentHash, byteSize });

      const relativePath = objectRelativePath(contentHash, compression);
      const absolutePath = path.join(this.root, relativePath);
      await this.#observe("E4", { runId: options.runId, partPath, contentHash, byteSize });

      const existing = await this.#locate(contentHash);
      await this.#observe("E5", { runId: options.runId, partPath, contentHash, byteSize });

      if (existing !== null) {
        // Deduplication : les octets sont deja la, par definition identiques.
        // Aucune reecriture — c'est ce qui rend AC-3.3 vrai par construction.
        await safeUnlink(partPath);
        const deduplicated: StoredObject = {
          contentHash,
          byteSize,
          mimeType,
          ...(written.detectedMime === undefined ? {} : { detectedMime: written.detectedMime }),
          storagePath: existing.relativePath,
          compression: existing.compression,
          storedAt: await this.#storedAtOf(contentHash),
          deduplicated: true,
        };
        await this.#upsertPhysicalDescriptor(deduplicated);
        await this.#observe("E8", { runId: options.runId, contentHash, byteSize });
        await this.#observe("E9", { runId: options.runId, contentHash, byteSize });
        return deduplicated;
      }

      // E6 : la synchronisation a eu lieu a la fermeture du fichier temporaire.
      await this.#observe("E6", { runId: options.runId, partPath, contentHash, byteSize });

      await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
      await fsp.rename(partPath, absolutePath);
      await this.#observe("E7", { runId: options.runId, partPath, contentHash, byteSize });

      await this.#fsyncDir(path.dirname(absolutePath));

      const stored: StoredObject = {
        contentHash,
        byteSize,
        mimeType,
        ...(written.detectedMime === undefined ? {} : { detectedMime: written.detectedMime }),
        storagePath: relativePath,
        compression,
        storedAt: toIsoTimestamp(this.#clock.now()),
        deduplicated: false,
      };

      await this.#upsertPhysicalDescriptor(stored);
      await this.#observe("E8", { runId: options.runId, contentHash, byteSize });
      await this.#observe("E9", { runId: options.runId, contentHash, byteSize });
      return stored;
    } catch (error) {
      await safeUnlink(partPath);
      throw error;
    }
  }

  /** E2 : un seul passage — hachage sur les octets bruts, ecriture eventuellement compressee. */
  async #streamToPart(
    input: ContentInput,
    partPath: string,
    options: StoreWriteOptions,
  ): Promise<StreamOutcome> {
    const iterator = toAsyncIterator(input);
    const hash = createHash("sha256");
    let byteSize = 0;

    // Tete de fichier : necessaire a la detection de type ET a la decision de
    // compression, qui depend de savoir si le contenu depasse le seuil.
    const headChunks: Uint8Array[] = [];
    let headLength = 0;
    let pending: Uint8Array | null = null;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      const chunk = toUint8Array(next.value);
      if (headLength >= SNIFF_BYTES) {
        pending = chunk;
        break;
      }
      headChunks.push(chunk);
      headLength += chunk.length;
      if (headLength >= SNIFF_BYTES) {
        const following = await iterator.next();
        if (following.done !== true) pending = toUint8Array(following.value);
        break;
      }
    }

    const head = concat(headChunks, headLength);
    const detectedMime = detectMime(head);
    const effectiveMime = detectedMime ?? options.declaredMime ?? "application/octet-stream";
    const exceedsThreshold = headLength >= COMPRESSION_MIN_BYTES || pending !== null;
    const compression: Compression =
      exceedsThreshold && isCompressible(effectiveMime) ? "zstd" : "none";

    const maxBytes = Math.min(
      options.expect?.maxBytes ?? this.#maxObjectBytes,
      this.#maxObjectBytes,
    );

    async function* source(): AsyncGenerator<Uint8Array> {
      for (const chunk of headChunks) {
        byteSize += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
      if (pending !== null) {
        byteSize += pending.length;
        hash.update(pending);
        yield pending;
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) break;
        const chunk = toUint8Array(next.value);
        byteSize += chunk.length;
        if (byteSize > maxBytes) {
          // Fail fast : inutile de transferer 2 Gio quand la borne est a 200 Mio.
          throw new IntegrityError(`objet trop volumineux : ${byteSize} > ${maxBytes} octets`, {
            context: { maxBytes },
          });
        }
        hash.update(chunk);
        yield chunk;
      }
    }

    // Ouverture exclusive : deux executions ne peuvent pas viser le meme transit.
    const handle = await fsp.open(partPath, "wx");
    try {
      const writable = handle.createWriteStream();
      const compressor = compressorFor(compression);
      if (compressor === null) {
        await pipeline(source(), writable);
      } else {
        await pipeline(source(), compressor, writable);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }

    // E6 : la durabilite du contenu depend de cette synchronisation, pas du
    // rename. Le descripteur de fichier est rouvert car le flux a ferme le sien.
    if (this.#fsync) {
      const syncHandle = await fsp.open(partPath, "r+");
      try {
        await syncHandle.sync();
      } finally {
        await syncHandle.close();
      }
    }

    return {
      contentHash: formatContentHash(hash.digest("hex")),
      byteSize,
      head,
      detectedMime,
      compression,
      declaredMime: options.declaredMime,
    };
  }

  /**
   * E3 : les attentes sont verifiees AVANT toute promotion du fichier.
   * Un echec ne laisse aucune trace : le fichier de transit est supprime.
   */
  #verifyExpectations(outcome: StreamOutcome, options: StoreWriteOptions): string {
    const expect = options.expect;
    const mimeType = outcome.declaredMime ?? outcome.detectedMime ?? "application/octet-stream";

    if (outcome.byteSize > this.#maxObjectBytes) {
      throw new IntegrityError(
        `objet trop volumineux : ${outcome.byteSize} > ${this.#maxObjectBytes} octets`,
        { context: { contentHash: outcome.contentHash, maxObjectBytes: this.#maxObjectBytes } },
      );
    }

    if (expect?.minBytes !== undefined && outcome.byteSize < expect.minBytes) {
      throw new IntegrityError(
        `objet trop petit : ${outcome.byteSize} < ${expect.minBytes} octets attendus`,
        { context: { contentHash: outcome.contentHash } },
      );
    }
    if (expect?.maxBytes !== undefined && outcome.byteSize > expect.maxBytes) {
      throw new IntegrityError(
        `objet trop volumineux : ${outcome.byteSize} > ${expect.maxBytes} octets`,
        { context: { contentHash: outcome.contentHash } },
      );
    }
    if (expect?.magicBytes !== undefined && !matchesMagic(outcome.head, expect.magicBytes)) {
      throw new IntegrityError("signature de fichier inattendue", {
        context: {
          expected: expect.magicBytes,
          detectedMime: outcome.detectedMime ?? null,
        },
      });
    }
    if (expect?.mimeTypes !== undefined && expect.mimeTypes.length > 0) {
      const candidates = [outcome.detectedMime, outcome.declaredMime].filter(
        (value): value is string => typeof value === "string",
      );
      const accepted = candidates.some((candidate) =>
        expect.mimeTypes?.some((allowed) => candidate.split(";")[0]?.trim() === allowed),
      );
      if (!accepted) {
        throw new IntegrityError("type de contenu inattendu", {
          context: {
            expected: [...expect.mimeTypes],
            detected: outcome.detectedMime ?? null,
            declared: outcome.declaredMime ?? null,
          },
        });
      }
    }
    return mimeType;
  }

  // -------------------------------------------------------------------------
  // Descripteur — E8 et E9
  // -------------------------------------------------------------------------

  async attachReference(
    hash: ContentHash,
    reference: ObjectReference,
  ): Promise<ObjectDescriptor> {
    const existing = await this.readDescriptor(hash);
    if (existing === null) {
      throw new StorageError("reference impossible : aucun descripteur pour cette empreinte", {
        context: { contentHash: hash },
      });
    }
    if (isTombstone(existing)) {
      throw new StorageError("objet purge : aucune reference ne peut y etre ajoutee", {
        context: { contentHash: hash },
      });
    }
    if (hasReference(existing, reference.documentId, reference.versionNo)) {
      // Rejouer la meme collecte ne doit pas gonfler le descripteur (idempotence).
      return existing;
    }

    const updated = mergeReference(existing, reference);
    await this.#writeDescriptor(hash, updated);
    return updated;
  }

  /**
   * E8 : champs physiques du descripteur. Les references deja presentes sont
   * conservees — un objet partage accumule ses provenances, il n'en perd jamais.
   */
  async #upsertPhysicalDescriptor(stored: StoredObject): Promise<ObjectDescriptor> {
    const existing = await this.readDescriptor(stored.contentHash);
    if (existing !== null && isTombstone(existing)) {
      throw new StorageError("objet purge", { context: { contentHash: stored.contentHash } });
    }
    const descriptor: ObjectDescriptor = {
      lcfObjectVersion: LCF_OBJECT_VERSION,
      contentHash: stored.contentHash,
      byteSize: stored.byteSize,
      mimeType: stored.mimeType,
      ...(stored.detectedMime === undefined ? {} : { detectedMime: stored.detectedMime }),
      compression: stored.compression,
      storedAt: existing?.storedAt ?? stored.storedAt,
      references: existing?.references ?? [],
    };
    await this.#writeDescriptor(stored.contentHash, descriptor);
    return descriptor;
  }

  /** Ecriture atomique du descripteur : tmp puis rename, comme les octets. */
  async #writeDescriptor(hash: ContentHash, file: DescriptorFile): Promise<void> {
    const relative = descriptorRelativePath(hash);
    const absolute = path.join(this.root, relative);
    const temporary = `${absolute}.${randomUUID()}.tmp`;
    await fsp.mkdir(path.dirname(absolute), { recursive: true });

    const handle = await fsp.open(temporary, "wx");
    try {
      await handle.writeFile(serializeDescriptor(file), "utf8");
      if (this.#fsync) await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, absolute);
    await this.#fsyncDir(path.dirname(absolute));
  }

  async readDescriptor(hash: ContentHash): Promise<DescriptorFile | null> {
    const absolute = path.join(this.root, descriptorRelativePath(hash));
    try {
      return parseDescriptor(await fsp.readFile(absolute, "utf8"));
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return null;
      throw new StorageError("descripteur illisible", {
        cause,
        context: { contentHash: hash },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Lecture et verification
  // -------------------------------------------------------------------------

  async has(hash: ContentHash): Promise<boolean> {
    return (await this.#locate(hash)) !== null;
  }

  async read(hash: ContentHash): Promise<Uint8Array> {
    const located = await this.#locate(hash);
    if (located === null) {
      throw new IntegrityError("objet absent du magasin", { context: { contentHash: hash } });
    }
    const raw = await fsp.readFile(located.absolutePath);
    const bytes = decompress(raw, located.compression);
    const actual = computeContentHash(bytes);
    if (actual !== hash) {
      // Verification a la lecture — Volume IV, 7.1 : systematique, sans exception.
      throw new IntegrityError("empreinte divergente a la lecture", {
        context: { expected: hash, actual },
      });
    }
    return bytes;
  }

  async verify(hash: ContentHash): Promise<IntegrityCheck> {
    const checkedAt = toIsoTimestamp(this.#clock.now());
    const located = await this.#locate(hash);

    if (located === null) {
      const descriptor = await this.readDescriptor(hash);
      if (descriptor !== null && isTombstone(descriptor)) {
        // Suppression legitime et tracee : ce n'est pas une corruption.
        return {
          contentHash: hash,
          checkedAt,
          result: "ok",
          actionTaken: `tombstone:${descriptor.reason}`,
        };
      }
      return { contentHash: hash, checkedAt, result: "missing_file", expectedHash: hash };
    }

    let bytes: Uint8Array;
    try {
      bytes = decompress(await fsp.readFile(located.absolutePath), located.compression);
    } catch {
      return { contentHash: hash, checkedAt, result: "unreadable", expectedHash: hash };
    }

    const descriptor = await this.readDescriptor(hash);
    if (descriptor !== null && !isTombstone(descriptor) && descriptor.byteSize !== bytes.length) {
      return {
        contentHash: hash,
        checkedAt,
        result: "size_mismatch",
        expectedHash: hash,
      };
    }

    const actual = computeContentHash(bytes);
    if (actual !== hash) {
      return {
        contentHash: hash,
        checkedAt,
        result: "hash_mismatch",
        expectedHash: hash,
        actualHash: actual,
      };
    }
    return { contentHash: hash, checkedAt, result: "ok", expectedHash: hash };
  }

  /**
   * Parcours integral : la reindexation ne lit QUE le magasin, jamais la base.
   * C'est ce qui rend l'invariant I-4 verifiable plutot que declaratif.
   */
  async *scan(): AsyncIterable<ScannedObject> {
    const objectsRoot = path.join(this.root, OBJECTS_DIR);
    for await (const descriptorPath of walkFiles(objectsRoot, ".json")) {
      let descriptor: DescriptorFile;
      try {
        descriptor = parseDescriptor(await fsp.readFile(descriptorPath, "utf8"));
      } catch (cause) {
        throw new StorageError("descripteur illisible pendant le parcours", {
          cause,
          context: { descriptorPath },
        });
      }
      const bytesPresent = isTombstone(descriptor)
        ? false
        : (await this.#locate(descriptor.contentHash)) !== null;
      yield {
        descriptor,
        descriptorPath: path.relative(this.root, descriptorPath).split(path.sep).join("/"),
        bytesPresent,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Purge tracee — Volume IV, 8.2
  // -------------------------------------------------------------------------

  async purge(hash: ContentHash, request: PurgeRequest): Promise<void> {
    const located = await this.#locate(hash);
    const descriptor = await this.readDescriptor(hash);
    const byteSize =
      descriptor !== null && !isTombstone(descriptor)
        ? descriptor.byteSize
        : located === null
          ? 0
          : (await fsp.stat(located.absolutePath)).size;

    const tombstone: ObjectTombstone = {
      lcfObjectVersion: LCF_OBJECT_VERSION,
      tombstone: true,
      contentHash: hash,
      purgedAt: toIsoTimestamp(this.#clock.now()),
      reason: request.reason,
      ...(request.legalRef === undefined ? {} : { legalRef: request.legalRef }),
      ...(request.operator === undefined ? {} : { operator: request.operator }),
      byteSize,
    };

    // La pierre tombale est ecrite AVANT la suppression : une panne entre les
    // deux laisse un objet marque mais present, jamais un trou inexplique.
    await this.#writeDescriptor(hash, tombstone);
    if (located !== null) await fsp.rm(located.absolutePath, { force: true });
  }

  // -------------------------------------------------------------------------
  // Utilitaires internes
  // -------------------------------------------------------------------------

  async #locate(hash: ContentHash): Promise<LocatedObject | null> {
    for (const compression of COMPRESSION_MODES) {
      const relativePath = objectRelativePath(hash, compression);
      const absolutePath = path.join(this.root, relativePath);
      try {
        await fsp.access(absolutePath);
        return { absolutePath, relativePath, compression };
      } catch {
        continue;
      }
    }
    return null;
  }

  async #storedAtOf(hash: ContentHash): Promise<ReturnType<typeof toIsoTimestamp>> {
    const descriptor = await this.readDescriptor(hash);
    if (descriptor !== null && !isTombstone(descriptor)) return descriptor.storedAt;
    const located = await this.#locate(hash);
    if (located === null) return toIsoTimestamp(this.#clock.now());
    return toIsoTimestamp((await fsp.stat(located.absolutePath)).mtime);
  }

  /**
   * E9 : la synchronisation du repertoire garantit que le `rename` survit a une
   * coupure d'alimentation. NTFS ne l'autorise pas (EPERM) ; l'echec est donc
   * tolere, `rename` y restant atomique par ailleurs.
   */
  async #fsyncDir(directory: string): Promise<void> {
    if (!this.#fsync) return;
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(directory, "r");
      await handle.sync();
    } catch (cause) {
      if (!isNodeError(cause, "EPERM", "EISDIR", "EACCES", "ENOTSUP", "EINVAL")) throw cause;
    } finally {
      await handle?.close();
    }
  }

  async #observe(stage: WriteStage, context: WriteStageContext): Promise<void> {
    if (this.#observer === undefined) return;
    await this.#observer(stage, context);
  }

  /** Chemin absolu du fichier d'index, cree par le lanceur de migrations. */
  get indexPath(): string {
    return path.join(this.root, INDEX_DIR, "lcf.db");
  }
}

interface StreamOutcome {
  readonly contentHash: ContentHash;
  readonly byteSize: number;
  readonly head: Uint8Array;
  readonly detectedMime: string | undefined;
  readonly declaredMime: string | undefined;
  readonly compression: Compression;
}

/**
 * Le mode `gzip` reste lisible mais n'est plus produit : zstd le domine a
 * qualite egale. Un magasin ancien reste donc exploitable sans conversion —
 * les octets stockes ne sont jamais reecrits (invariant I-1).
 */
function compressorFor(compression: Compression): NodeJS.ReadWriteStream | null {
  switch (compression) {
    case "none":
      return null;
    case "zstd":
      return createZstdCompress();
    case "gzip":
      return createGzip();
    default:
      throw new StorageError(`mode de compression inconnu : ${String(compression)}`);
  }
}

function decompress(raw: Uint8Array, compression: Compression): Uint8Array {
  switch (compression) {
    case "none":
      // Vue Uint8Array simple : le contrat public n'expose jamais de Buffer,
      // dont l'egalite structurelle differe et fuit une specificite Node.
      return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    case "zstd":
      return new Uint8Array(zstdDecompressSync(raw));
    case "gzip":
      return new Uint8Array(gunzipSync(raw));
    default:
      throw new StorageError(`mode de compression inconnu : ${String(compression)}`);
  }
}

/** Flux de decompression, pour les lectures qui ne tiennent pas en memoire. */
export function decompressionStream(compression: Compression): NodeJS.ReadWriteStream | null {
  switch (compression) {
    case "none":
      return null;
    case "zstd":
      return createZstdDecompress();
    case "gzip":
      return createGunzip();
    default:
      throw new StorageError(`mode de compression inconnu : ${String(compression)}`);
  }
}

export function openObjectStream(absolutePath: string): NodeJS.ReadableStream {
  return createReadStream(absolutePath);
}

function toAsyncIterator(input: ContentInput): AsyncIterator<Uint8Array> {
  if (input instanceof Uint8Array) {
    let done = false;
    return {
      next(): Promise<IteratorResult<Uint8Array>> {
        if (done) return Promise.resolve({ done: true, value: undefined });
        done = true;
        return Promise.resolve({ done: false, value: input });
      },
    };
  }
  const asAsync = input as AsyncIterable<Uint8Array>;
  if (typeof asAsync[Symbol.asyncIterator] === "function") {
    return asAsync[Symbol.asyncIterator]();
  }
  const sync = (input as Iterable<Uint8Array>)[Symbol.iterator]();
  return {
    next(): Promise<IteratorResult<Uint8Array>> {
      return Promise.resolve(sync.next());
    },
  };
}

function toUint8Array(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function concat(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function safeUnlink(target: string): Promise<void> {
  await fsp.rm(target, { force: true }).catch(() => undefined);
}

async function countFiles(target: string): Promise<number> {
  try {
    const stats = await fsp.stat(target);
    if (!stats.isDirectory()) return 1;
  } catch {
    return 0;
  }
  let total = 0;
  for await (const _file of walkFiles(target)) {
    void _file;
    total++;
  }
  return total;
}

async function* walkFiles(root: string, extension?: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return;
    throw cause;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, extension);
    } else if (extension === undefined || entry.name.endsWith(extension)) {
      yield full;
    }
  }
}

function isNodeError(value: unknown, ...codes: string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    codes.includes(String((value as { code: unknown }).code))
  );
}

/** Empreinte hexadecimale nue, pour les messages destines a l'exploitation. */
export function shortHash(hash: ContentHash): string {
  return contentHashHex(hash).slice(0, 12);
}
