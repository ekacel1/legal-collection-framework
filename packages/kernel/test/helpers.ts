/** Utilitaires partages par la suite de tests du noyau. */
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Racine du depot, trouvee en remontant jusqu'au repertoire `migrations/`. */
export function repoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (fs.existsSync(path.join(current, "migrations", "0001_initial_schema.sql"))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error("racine du depot introuvable depuis " + import.meta.url);
}

export function migrationsDir(): string {
  return path.join(repoRoot(), "migrations");
}

export async function tempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `lcf-${prefix}-`));
}

/** Copie les migrations reelles dans un repertoire jetable, pour les alterer. */
export async function copyMigrations(target: string): Promise<void> {
  await fsp.mkdir(target, { recursive: true });
  const source = migrationsDir();
  for (const name of await fsp.readdir(source)) {
    await fsp.copyFile(path.join(source, name), path.join(target, name));
  }
}
