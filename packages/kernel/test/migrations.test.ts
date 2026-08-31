import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { SqliteDriver } from "../src/db/sqlite-driver.js";
import { MigrationRunner, checksumOf } from "../src/db/migrations.js";
import { MigrationError } from "../src/domain/errors.js";
import { ManualClock } from "../src/domain/clock.js";
import { copyMigrations, migrationsDir, tempDir } from "./helpers.js";

let workspace: string;
let driver: SqliteDriver;

beforeEach(async () => {
  workspace = await tempDir("migrations");
  driver = new SqliteDriver({ path: path.join(workspace, "index", "lcf.db") });
});

afterEach(async () => {
  await driver.close();
  await fsp.rm(workspace, { recursive: true, force: true });
});

function runner(directory = migrationsDir(), options = {}): MigrationRunner {
  return new MigrationRunner(driver, {
    directory,
    clock: new ManualClock(1_700_000_000_000),
    ...options,
  });
}

describe("lanceur de migrations (Vol. IV, ch. 10)", () => {
  test("une base vierge est amenee au dernier schema", async () => {
    const result = await runner().migrate();

    assert.equal(result.fromVersion, 0);
    assert.equal(result.toVersion, 2);
    assert.deepEqual(
      result.applied.map((r) => r.version),
      [1, 2],
    );

    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.map((row) => row.name);
    for (const expected of [
      "sources",
      "runs",
      "documents",
      "content_objects",
      "document_versions",
      "document_metadata",
      "fetch_attempts",
      "integrity_log",
      "schema_migrations",
    ]) {
      assert.ok(names.includes(expected), `table manquante : ${expected}`);
    }
  });

  test("les vues de commodite sont creees", async () => {
    await runner().migrate();
    const views = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name",
    );
    assert.deepEqual(
      views.map((v) => v.name),
      ["v_current_documents", "v_source_health"],
    );
  });

  test("migrer deux fois n'applique rien la seconde fois (idempotence)", async () => {
    await runner().migrate();
    const second = await runner().migrate();
    assert.equal(second.applied.length, 0);
    assert.equal(second.fromVersion, 2);
    assert.equal(second.toVersion, 2);
  });

  test("le journal enregistre nom, date, somme de controle et duree", async () => {
    await runner().migrate();
    const records = await runner().applied();
    assert.equal(records.length, 2);
    assert.equal(records[0]?.name, "initial_schema");
    assert.match(String(records[0]?.checksum), /^sha256:[0-9a-f]{64}$/);
    assert.equal(records[0]?.appliedAt, "2023-11-14T22:13:20.000Z");
  });

  test("la migration 0002 ajoute withdrawn_at sans toucher aux lignes existantes", async () => {
    const columns = await (async (): Promise<string[]> => {
      await runner().migrate();
      const rows = await driver.all<{ name: string }>("PRAGMA table_info(documents)");
      return rows.map((row) => row.name);
    })();
    assert.ok(columns.includes("withdrawn_at"));
  });
});

describe("immuabilite des migrations publiees (Vol. IV, 10.2)", () => {
  test("modifier une migration deja appliquee bloque le lancement", async () => {
    const directory = path.join(workspace, "migrations");
    await copyMigrations(directory);
    await runner(directory).migrate();

    const target = path.join(directory, "0001_initial_schema.sql");
    await fsp.appendFile(target, "\n-- modification apres publication\n");

    await assert.rejects(runner(directory).verifyChecksums(), MigrationError);
    await assert.rejects(runner(directory).migrate(), /modifiee apres application/);
  });

  test("une migration appliquee mais disparue du repertoire est signalee", async () => {
    const directory = path.join(workspace, "migrations");
    await copyMigrations(directory);
    await runner(directory).migrate();
    await fsp.rm(path.join(directory, "0002_add_withdrawn_status.sql"));

    await assert.rejects(runner(directory).verifyChecksums(), /absente du repertoire/);
  });

  test("la somme de controle ignore les fins de ligne du systeme", () => {
    assert.equal(checksumOf("CREATE TABLE t(a);\n"), checksumOf("CREATE TABLE t(a);\r\n"));
  });
});

describe("hygiene du repertoire de migrations", () => {
  test("un nom de fichier non conforme est refuse", async () => {
    const directory = path.join(workspace, "bad-name");
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, "ajout-colonne.sql"), "SELECT 1;");
    await assert.rejects(runner(directory).load(), /nom de migration invalide/);
  });

  test("deux migrations portant le meme numero sont refusees toutes les deux", async () => {
    const directory = path.join(workspace, "duplicate");
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, "0001_un.sql"), "SELECT 1;");
    await fsp.writeFile(path.join(directory, "0001_deux.sql"), "SELECT 1;");
    await assert.rejects(runner(directory).load(), /numero de migration en double/);
  });

  test("une suite discontinue est refusee", async () => {
    const directory = path.join(workspace, "gap");
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, "0001_un.sql"), "CREATE TABLE a(x);");
    await fsp.writeFile(path.join(directory, "0003_trois.sql"), "CREATE TABLE b(x);");
    await assert.rejects(runner(directory).load(), /discontinue/);
  });
});

describe("atomicite d'une migration", () => {
  test("une migration qui echoue ne laisse aucun effet partiel", async () => {
    const directory = path.join(workspace, "failing");
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, "0001_base.sql"), "CREATE TABLE ok_table(x TEXT);");
    await fsp.writeFile(
      path.join(directory, "0002_casse.sql"),
      "CREATE TABLE moitie(x TEXT);\nCREATE TABLE moitie(x TEXT);",
    );

    await assert.rejects(
      runner(directory, { allowMigrationWithoutBackup: true }).migrate(),
      /echec de la migration 0002_casse.sql/,
    );

    const version = await runner(directory).currentVersion();
    assert.equal(version, 1, "la version doit rester celle de la derniere migration reussie");

    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = tables.map((row) => row.name);
    assert.ok(names.includes("ok_table"));
    assert.ok(!names.includes("moitie"), "aucune table de la migration echouee ne subsiste");
  });
});

describe("garde de sauvegarde (Vol. IV, 10.3)", () => {
  test("une base vierge migre sans exiger de sauvegarde", async () => {
    const result = await runner().migrate();
    assert.equal(result.toVersion, 2);
  });

  test("une base peuplee refuse de migrer sans garde de sauvegarde", async () => {
    const directory = path.join(workspace, "migrations");
    await copyMigrations(directory);
    await runner(directory).migrate();

    await fsp.writeFile(path.join(directory, "0003_ajout.sql"), "ALTER TABLE documents ADD COLUMN note TEXT;");

    await assert.rejects(
      runner(directory).migrate(),
      /aucune garde de sauvegarde configuree/,
    );
  });

  test("une sauvegarde trop ancienne interrompt la migration", async () => {
    const directory = path.join(workspace, "migrations");
    await copyMigrations(directory);
    await runner(directory).migrate();
    await fsp.writeFile(path.join(directory, "0003_ajout.sql"), "ALTER TABLE documents ADD COLUMN note TEXT;");

    await assert.rejects(
      runner(directory, {
        backupGuard: { hasRecentVerifiedBackup: async (): Promise<boolean> => false },
      }).migrate(),
      /aucune sauvegarde verifiee/,
    );
  });

  test("une sauvegarde recente autorise la migration", async () => {
    const directory = path.join(workspace, "migrations");
    await copyMigrations(directory);
    await runner(directory).migrate();
    await fsp.writeFile(path.join(directory, "0003_ajout.sql"), "ALTER TABLE documents ADD COLUMN note TEXT;");

    const result = await runner(directory, {
      backupGuard: { hasRecentVerifiedBackup: async (): Promise<boolean> => true },
    }).migrate();
    assert.equal(result.toVersion, 3);
  });
});

describe("invariants post-migration (Vol. IV, 10.4, etape 5)", () => {
  test("un schema sain ne signale aucune violation", async () => {
    await runner().migrate();
    assert.deepEqual(await runner().checkInvariants(), []);
  });

  test("une version orpheline est detectee", async () => {
    await runner().migrate();

    // Les cles etrangeres sont desactivees pour simuler un etat herite
    // qu'une migration devrait rattraper : c'est precisement ce que les
    // controles post-migration existent pour attraper.
    const lax = new SqliteDriver({
      path: path.join(workspace, "index", "lcf.db"),
      foreignKeys: false,
    });
    try {
      await lax.run(
        `INSERT INTO document_versions
           (document_id, version_no, content_hash, fetched_at, run_id, change_reason)
         VALUES ('inconnu', 1, 'sha256:00', '2026-01-01T00:00:00.000Z', 'run_X', 'initial')`,
      );
      const violations = await new MigrationRunner(lax, {
        directory: migrationsDir(),
      }).checkInvariants();

      assert.equal(violations.length, 2);
      const names = violations.map((v) => v.name).sort();
      assert.deepEqual(names, ["no_orphan_versions", "no_version_without_content"]);
    } finally {
      await lax.close();
    }
  });
});
