/**
 * Verrou de processus — une seule instance ecrit dans un magasin donne.
 *
 * Le verrou par source du Volume IV, 5.3 vit en memoire : il empeche deux
 * collectes simultanees DANS un processus. Deux processus lances cote a cote
 * l'ignoraient, chacun avec son propre limiteur de debit — et la source
 * recevait le double de la charge negociee. C'est le trou que ce verrou ferme.
 *
 * Le verrou porte sur le magasin, pas sur la source : c'est le magasin qui est
 * partage, et c'est l'hote distant qu'on protege.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { hostname } from "node:os";

import { StorageError } from "../domain/errors.js";
import { toIsoTimestamp, type IsoTimestamp } from "../domain/ids.js";
import type { Clock, Logger } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import { SilentLogger } from "../observability/logger.js";

export const LOCK_FILENAME = "lcf.lock";

export interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly acquiredAt: IsoTimestamp;
}

export interface ProcessLockOptions {
  readonly dataDir: string;
  readonly command: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Test de vitalite du detenteur. Substituable en test. */
  readonly isAlive?: (pid: number) => boolean;
}

/** Le processus qui detient ce PID existe-t-il encore ? */
export function defaultIsAlive(pid: number): boolean {
  try {
    // Le signal 0 ne fait rien : il verifie seulement l'existence et l'acces.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM : le processus existe mais appartient a quelqu'un d'autre.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ProcessLock {
  readonly #path: string;
  readonly #command: string;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #isAlive: (pid: number) => boolean;
  #held = false;

  constructor(options: ProcessLockOptions) {
    this.#path = path.join(options.dataDir, LOCK_FILENAME);
    this.#command = options.command;
    this.#clock = options.clock ?? new SystemClock();
    this.#logger = options.logger ?? new SilentLogger();
    this.#isAlive = options.isAlive ?? defaultIsAlive;
  }

  get held(): boolean {
    return this.#held;
  }

  /** Detenteur courant, ou `null` si le magasin est libre. */
  async holder(): Promise<LockHolder | null> {
    try {
      return JSON.parse(await fsp.readFile(this.#path, "utf8")) as LockHolder;
    } catch {
      return null;
    }
  }

  /**
   * Prend le verrou, ou explique qui le detient.
   *
   * Un verrou abandonne par un processus mort est repris — sans quoi un plantage
   * immobiliserait le collecteur jusqu'a une intervention humaine, ce qui est
   * exactement ce qu'un demon est cense eviter.
   */
  async acquire(): Promise<void> {
    await fsp.mkdir(path.dirname(this.#path), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const holder: LockHolder = {
          pid: process.pid,
          host: hostname(),
          command: this.#command,
          acquiredAt: toIsoTimestamp(this.#clock.now()),
        };
        // `wx` : la creation est atomique, donc la course est tranchee par le
        // systeme de fichiers et non par notre code.
        const handle = await fsp.open(this.#path, "wx");
        try {
          await handle.writeFile(JSON.stringify(holder, null, 2), "utf8");
        } finally {
          await handle.close();
        }
        this.#held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        const holder = await this.holder();
        if (holder === null) {
          // Verrou illisible : on le retire et on retente une fois.
          await fsp.rm(this.#path, { force: true });
          continue;
        }
        if (holder.host === hostname() && !this.#isAlive(holder.pid)) {
          this.#logger.warn("verrou abandonne par un processus mort, repris", {
            pid: holder.pid,
            command: holder.command,
            acquiredAt: holder.acquiredAt,
          });
          await fsp.rm(this.#path, { force: true });
          continue;
        }

        throw new StorageError(
          `magasin deja utilise par ${holder.command} (pid ${holder.pid} sur ${holder.host}, ` +
            `depuis ${holder.acquiredAt})`,
          { context: { holder: { ...holder } } },
        );
      }
    }

    throw new StorageError("verrou du magasin impossible a prendre");
  }

  /** Libere le verrou. Sans effet s'il n'est pas detenu par ce processus. */
  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    const holder = await this.holder();
    if (holder?.pid === process.pid) await fsp.rm(this.#path, { force: true });
  }
}
