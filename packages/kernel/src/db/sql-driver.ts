/**
 * Contrat de pilote SQL — Volume IV, chapitre 11.
 *
 * Le Volume I exige que SQLite puisse etre remplace par PostgreSQL sans
 * toucher au coeur. Cette exigence se materialise ici : au-dessus de ce
 * contrat, plus aucune couche ne connait le moteur. En dessous, un pilote par
 * moteur encapsule les differences (upsert, JSON, recherche plein texte).
 *
 * Le contrat est asynchrone alors que SQLite est synchrone. C'est delibere :
 * un contrat synchrone interdirait toute implementation reseau, et la
 * portabilite serait perdue le jour ou elle compte.
 */

export type SqlDialect = "sqlite" | "postgres";

/** Valeurs admises en parametre. Les booleens sont projetes en 0/1 par le pilote. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/**
 * Parametres positionnels uniquement, notes `?`.
 *
 * Les parametres nommes sont ecartes : leur syntaxe differe d'un moteur a
 * l'autre, et un pilote PostgreSQL peut reecrire `?` en `$n` de maniere
 * purement mecanique, ce qui n'est pas vrai des formes nommees.
 */
export type SqlParams = readonly SqlValue[];

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export type SqlRow = Record<string, unknown>;

/** Surface d'execution, disponible aussi bien hors que dans une transaction. */
export interface SqlExecutor {
  /** Instructions multiples, sans parametre. Reserve au DDL et aux migrations. */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>;
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<T[]>;
  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<T | undefined>;
}

export interface SqlDriver extends SqlExecutor {
  readonly dialect: SqlDialect;

  /**
   * Unite de travail explicite : tout ou rien.
   * Les transactions sont serialisees par le pilote — SQLite n'admet qu'un
   * ecrivain, et le Scheduler serialise deja par source dans les deux moteurs.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * Differences de dialecte encapsulees — Volume IV, 11.2.
 * Toute divergence de syntaxe passe par ici, jamais par un `if` dans le domaine.
 */
export interface SqlSyntax {
  /** `INSERT OR IGNORE` (SQLite) contre `ON CONFLICT DO NOTHING` (PostgreSQL). */
  insertIgnore(table: string, columns: readonly string[]): string;
  /** Extraction d'un champ JSON. */
  jsonExtract(column: string, jsonPath: string): string;
}

export const SQLITE_SYNTAX: SqlSyntax = {
  insertIgnore(table, columns) {
    const placeholders = columns.map(() => "?").join(", ");
    return `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
  },
  jsonExtract(column, jsonPath) {
    return `json_extract(${column}, '${jsonPath}')`;
  },
};

export const POSTGRES_SYNTAX: SqlSyntax = {
  insertIgnore(table, columns) {
    const placeholders = columns.map(() => "?").join(", ");
    return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  },
  jsonExtract(column, jsonPath) {
    return `${column} #>> '{${jsonPath.replace(/^\$\./, "").split(".").join(",")}}'`;
  },
};

export function syntaxFor(dialect: SqlDialect): SqlSyntax {
  return dialect === "sqlite" ? SQLITE_SYNTAX : POSTGRES_SYNTAX;
}
