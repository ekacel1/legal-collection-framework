/**
 * Pilote SQLite — Volume IV, chapitre 11.3.
 *
 * SQLite reste le moteur par defaut : il satisfait la contrainte du Volume I
 * (« sans Docker obligatoire, sans API Cloud ») et couvre la grande majorite
 * des deploiements reels sans aucune administration.
 *
 * Le module `node:sqlite` est utilise plutot qu'une extension native : il
 * n'exige aucune compilation, donc aucune chaine de build C sur le poste de
 * l'exploitant. Il reste marque experimental en Node 22 et requiert
 * `--experimental-sqlite` au lancement.
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

import { StorageError } from "../domain/errors.js";
import type {
  SqlDialect,
  SqlDriver,
  SqlExecutor,
  SqlParams,
  SqlRow,
  SqlRunResult,
  SqlValue,
} from "./sql-driver.js";

export interface SqliteDriverOptions {
  /** Chemin du fichier, ou ":memory:" pour une base ephemere de test. */
  readonly path: string;
  /** Journalisation WAL : lectures concurrentes pendant l'ecriture. */
  readonly wal?: boolean;
  /** Attente maximale sur verrou avant erreur, en millisecondes. */
  readonly busyTimeoutMs?: number;
  /** Contraintes de cle etrangere : actives par defaut, jamais desactivees en production. */
  readonly foreignKeys?: boolean;
}

type SqliteInput = null | number | bigint | string | Uint8Array;

export class SqliteDriver implements SqlDriver {
  readonly dialect: SqlDialect = "sqlite";
  readonly #db: DatabaseSync;
  /** File d'attente : une seule transaction a la fois, un seul ecrivain. */
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: SqliteDriverOptions) {
    if (options.path !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(options.path)), { recursive: true });
    }
    this.#db = new DatabaseSync(options.path);
    this.#db.exec(`PRAGMA foreign_keys = ${options.foreignKeys === false ? "OFF" : "ON"}`);
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    if (options.wal !== false && options.path !== ":memory:") {
      this.#db.exec("PRAGMA journal_mode = WAL");
      // NORMAL suffit en WAL : la durabilite du contenu repose sur le fsync du
      // Content Store, pas sur celui de l'index, qui est reconstructible (I-4).
      this.#db.exec("PRAGMA synchronous = NORMAL");
    }
  }

  async exec(sql: string): Promise<void> {
    this.#assertOpen();
    this.#db.exec(sql);
  }

  async run(sql: string, params: SqlParams = []): Promise<SqlRunResult> {
    this.#assertOpen();
    const statement = this.#db.prepare(sql);
    const result = statement.run(...toSqliteInputs(params));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  async all<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = []): Promise<T[]> {
    this.#assertOpen();
    return this.#db.prepare(sql).all(...toSqliteInputs(params)) as T[];
  }

  async get<T extends SqlRow = SqlRow>(
    sql: string,
    params: SqlParams = [],
  ): Promise<T | undefined> {
    this.#assertOpen();
    return this.#db.prepare(sql).get(...toSqliteInputs(params)) as T | undefined;
  }

  /**
   * Tout ou rien. Une erreur, quelle qu'elle soit, provoque le ROLLBACK :
   * un commit partiel produirait exactement ce que le Volume IV interdit,
   * une entree d'index sans contrepartie dans le magasin.
   */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.#assertOpen();
    const run = async (): Promise<T> => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this);
        this.#db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // Le ROLLBACK echoue si la transaction a deja ete annulee par le
          // moteur : l'erreur d'origine reste la seule interessante.
        }
        throw error;
      }
    };

    const queued = this.#queue.then(run, run);
    this.#queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new StorageError("pilote SQLite deja ferme");
  }
}

function toSqliteInputs(params: SqlParams): SqliteInput[] {
  return params.map(toSqliteInput);
}

function toSqliteInput(value: SqlValue): SqliteInput {
  // SQLite n'a pas de type booleen natif — Volume IV, 3.2.
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
