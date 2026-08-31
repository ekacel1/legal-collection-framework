/**
 * Lanceur de migrations — Volume IV, chapitre 10.
 *
 * Sur quinze ans, le schema evoluera des dizaines de fois. Trois exigences en
 * decoulent : toute migration doit etre rejouable et verifiable, aucune ne doit
 * pouvoir detruire de donnees, et il doit rester possible de revenir en arriere
 * d'au moins une version.
 *
 * Une migration deja appliquee est immuable. La modifier est detecte au
 * demarrage et bloque le lancement — sans quoi deux installations pretendant la
 * meme version de schema pourraient avoir des schemas differents.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { MigrationError } from "../domain/errors.js";
import { toIsoTimestamp, type IsoTimestamp } from "../domain/ids.js";
import type { Clock, Logger } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import type { SqlDriver, SqlExecutor } from "./sql-driver.js";

/** La table du journal appartient au lanceur, pas aux migrations qu'il applique. */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version              INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL,
  applied_at           TEXT NOT NULL,
  checksum             TEXT NOT NULL,
  execution_ms         INTEGER
)`;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
  readonly filename: string;
}

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: IsoTimestamp;
  readonly checksum: string;
  readonly executionMs: number;
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly MigrationRecord[];
}

export interface InvariantCheck {
  readonly name: string;
  readonly description: string;
  readonly sql: string;
}

export interface InvariantViolation {
  readonly name: string;
  readonly description: string;
  readonly count: number;
}

/**
 * Garde de sauvegarde — Volume IV, 10.3.
 * Le lanceur refuse de migrer une base peuplee sans sauvegarde verifiee
 * recente. Implemente au Palier 1 avec le sous-systeme de sauvegarde.
 */
export interface BackupGuard {
  hasRecentVerifiedBackup(maxAgeMs: number): Promise<boolean>;
}

export interface MigrationRunnerOptions {
  /** Repertoire contenant les fichiers `NNNN_nom.sql`. */
  readonly directory: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly backupGuard?: BackupGuard;
  /** Age maximal accepte pour une sauvegarde, defaut 24 h. */
  readonly backupMaxAgeMs?: number;
  /**
   * Autorise la migration d'une base deja peuplee sans garde de sauvegarde.
   * A n'utiliser qu'en developpement : une migration sans filet est le seul
   * scenario ou une erreur de schema devient une perte de donnees.
   */
  readonly allowMigrationWithoutBackup?: boolean;
}

/** Verifications post-migration — Volume IV, 10.4, etape 5. Non decoratives. */
export const POST_MIGRATION_INVARIANTS: readonly InvariantCheck[] = Object.freeze([
  {
    name: "no_orphan_versions",
    description: "aucune version ne reference un document inexistant",
    sql: `SELECT COUNT(*) AS n FROM document_versions v
            LEFT JOIN documents d ON d.document_id = v.document_id
           WHERE d.document_id IS NULL`,
  },
  {
    name: "no_version_without_content",
    description: "aucune version ne reference un objet de contenu inexistant",
    sql: `SELECT COUNT(*) AS n FROM document_versions v
            LEFT JOIN content_objects c ON c.content_hash = v.content_hash
           WHERE c.content_hash IS NULL`,
  },
  {
    name: "current_version_consistent",
    description: "current_version coincide avec le maximum reel des versions",
    sql: `SELECT COUNT(*) AS n FROM documents d
           WHERE d.version_count > 0
             AND d.current_version <> (SELECT MAX(v.version_no)
                                         FROM document_versions v
                                        WHERE v.document_id = d.document_id)`,
  },
]);

export class MigrationRunner {
  readonly #driver: SqlDriver;
  readonly #directory: string;
  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  readonly #backupGuard: BackupGuard | undefined;
  readonly #backupMaxAgeMs: number;
  readonly #allowWithoutBackup: boolean;

  constructor(driver: SqlDriver, options: MigrationRunnerOptions) {
    this.#driver = driver;
    this.#directory = path.resolve(options.directory);
    this.#clock = options.clock ?? new SystemClock();
    this.#logger = options.logger;
    this.#backupGuard = options.backupGuard;
    this.#backupMaxAgeMs = options.backupMaxAgeMs ?? 24 * 60 * 60 * 1000;
    this.#allowWithoutBackup = options.allowMigrationWithoutBackup ?? false;
  }

  /** Lit et ordonne les migrations disponibles, en verifiant leur nommage. */
  async load(): Promise<MigrationFile[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.#directory);
    } catch (cause) {
      throw new MigrationError(`repertoire de migrations introuvable : ${this.#directory}`, {
        cause,
      });
    }

    const files: MigrationFile[] = [];
    const seen = new Map<number, string>();

    for (const filename of entries.filter((name) => name.endsWith(".sql")).sort()) {
      const match = FILENAME_PATTERN.exec(filename);
      if (match === null) {
        throw new MigrationError(
          `nom de migration invalide : ${filename} (attendu NNNN_nom_en_minuscules.sql)`,
        );
      }
      const version = Number.parseInt(match[1] as string, 10);
      const previous = seen.get(version);
      if (previous !== undefined) {
        // Choisir un gagnant rendrait le schema dependant de l'ordre de lecture
        // du systeme de fichiers : les deux sont refuses.
        throw new MigrationError(
          `numero de migration en double : ${version} (${previous} et ${filename})`,
        );
      }
      seen.set(version, filename);

      const sql = await fsp.readFile(path.join(this.#directory, filename), "utf8");
      files.push({
        version,
        name: match[2] as string,
        sql,
        checksum: checksumOf(sql),
        filename,
      });
    }

    files.sort((a, b) => a.version - b.version);
    this.#assertDenseSequence(files);
    return files;
  }

  /** Les numeros doivent former une suite dense a partir de 1, sans trou. */
  #assertDenseSequence(files: readonly MigrationFile[]): void {
    files.forEach((file, index) => {
      if (file.version !== index + 1) {
        throw new MigrationError(
          `suite de migrations discontinue : ${file.filename} attendu en position ${index + 1}`,
        );
      }
    });
  }

  async currentVersion(): Promise<number> {
    await this.#driver.exec(SCHEMA_MIGRATIONS_DDL);
    const row = await this.#driver.get<{ version: number | null }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    return Number(row?.version ?? 0);
  }

  async applied(): Promise<MigrationRecord[]> {
    await this.#driver.exec(SCHEMA_MIGRATIONS_DDL);
    const rows = await this.#driver.all<{
      version: number;
      name: string;
      applied_at: string;
      checksum: string;
      execution_ms: number | null;
    }>("SELECT version, name, applied_at, checksum, execution_ms FROM schema_migrations ORDER BY version");
    return rows.map((row) => ({
      version: Number(row.version),
      name: row.name,
      appliedAt: row.applied_at as IsoTimestamp,
      checksum: row.checksum,
      executionMs: Number(row.execution_ms ?? 0),
    }));
  }

  async pending(): Promise<MigrationFile[]> {
    const version = await this.currentVersion();
    return (await this.load()).filter((file) => file.version > version);
  }

  /**
   * Verifie que les migrations deja appliquees n'ont pas ete modifiees.
   * Une divergence bloque le lancement : deux installations declarant la meme
   * version de schema doivent avoir exactement le meme schema.
   */
  async verifyChecksums(): Promise<void> {
    const files = new Map((await this.load()).map((file) => [file.version, file]));
    for (const record of await this.applied()) {
      const file = files.get(record.version);
      if (file === undefined) {
        throw new MigrationError(
          `migration ${record.version} appliquee mais absente du repertoire (${record.name})`,
        );
      }
      if (file.checksum !== record.checksum) {
        throw new MigrationError(
          `migration ${record.version} modifiee apres application : ${file.filename}`,
          { context: { expected: record.checksum, actual: file.checksum } },
        );
      }
    }
  }

  /**
   * Deroulement complet — Volume IV, 10.4.
   *
   * Deux amenagements par rapport a l'ordre litteral du volume, tous deux dans
   * le sens de la surete :
   *   - les sommes de controle sont verifiees AVANT la garde de sauvegarde,
   *     afin qu'une migration alteree soit signalee comme telle plutot que
   *     masquee par une demande de sauvegarde ;
   *   - la garde de sauvegarde n'est exigee que s'il y a effectivement quelque
   *     chose a appliquer : un demarrage ordinaire ne doit pas echouer parce
   *     qu'aucune migration n'est en attente.
   */
  async migrate(): Promise<MigrationResult> {
    const fromVersion = await this.currentVersion();

    // 1. Les migrations deja appliquees sont-elles restees identiques ?
    await this.verifyChecksums();

    // 2. Migrations en attente.
    const pending = (await this.load()).filter((file) => file.version > fromVersion);
    if (pending.length === 0) {
      return { fromVersion, toVersion: fromVersion, applied: [] };
    }

    // 3. Sauvegarde. Une base vierge n'a rien a perdre : le controle ne
    //    s'applique qu'a une base deja peuplee.
    if (fromVersion > 0) await this.#assertBackup();

    const applied: MigrationRecord[] = [];

    // 4. Application, une transaction par migration, arret immediat sur erreur.
    for (const file of pending) {
      const startedAt = this.#clock.nowMillis();
      try {
        await this.#driver.transaction(async (tx: SqlExecutor) => {
          await tx.exec(file.sql);
          await tx.run(
            `INSERT INTO schema_migrations (version, name, applied_at, checksum, execution_ms)
             VALUES (?, ?, ?, ?, ?)`,
            [
              file.version,
              file.name,
              toIsoTimestamp(this.#clock.now()),
              file.checksum,
              this.#clock.nowMillis() - startedAt,
            ],
          );
        });
      } catch (cause) {
        throw new MigrationError(`echec de la migration ${file.filename}`, {
          cause,
          context: { version: file.version, applied: applied.map((r) => r.version) },
        });
      }

      const record: MigrationRecord = {
        version: file.version,
        name: file.name,
        appliedAt: toIsoTimestamp(this.#clock.now()),
        checksum: file.checksum,
        executionMs: this.#clock.nowMillis() - startedAt,
      };
      applied.push(record);
      this.#logger?.info("migration appliquee", {
        version: record.version,
        name: record.name,
        executionMs: record.executionMs,
      });
    }

    // 5. Verifications d'invariants post-migration.
    const violations = await this.checkInvariants();
    if (violations.length > 0) {
      throw new MigrationError("invariants violes apres migration", {
        context: { violations: violations.map((v) => `${v.name}=${v.count}`) },
      });
    }

    return { fromVersion, toVersion: await this.currentVersion(), applied };
  }

  /** Les trois controles du Volume IV, 10.4 — attendu : zero partout. */
  async checkInvariants(): Promise<InvariantViolation[]> {
    const violations: InvariantViolation[] = [];
    for (const invariant of POST_MIGRATION_INVARIANTS) {
      const row = await this.#driver.get<{ n: number }>(invariant.sql);
      const count = Number(row?.n ?? 0);
      if (count > 0) {
        violations.push({ name: invariant.name, description: invariant.description, count });
      }
    }
    return violations;
  }

  async #assertBackup(): Promise<void> {
    if (this.#backupGuard === undefined) {
      if (this.#allowWithoutBackup) {
        this.#logger?.warn(
          "migration sans garde de sauvegarde : mode developpement uniquement",
        );
        return;
      }
      throw new MigrationError(
        "migration refusee : aucune garde de sauvegarde configuree sur une base peuplee",
      );
    }
    if (!(await this.#backupGuard.hasRecentVerifiedBackup(this.#backupMaxAgeMs))) {
      throw new MigrationError(
        `migration refusee : aucune sauvegarde verifiee de moins de ${Math.round(
          this.#backupMaxAgeMs / 3_600_000,
        )} h`,
      );
    }
  }
}

/**
 * Somme de controle d'une migration.
 * Les fins de ligne sont normalisees : un depot clone sous Windows ne doit pas
 * produire une divergence avec le meme depot clone sous Linux.
 */
export function checksumOf(sql: string): string {
  return `sha256:${createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex")}`;
}
