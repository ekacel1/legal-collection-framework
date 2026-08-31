/**
 * Configuration — Volume II, chapitre 10.
 *
 * Un fichier JSON, des variables d'environnement, aucune valeur secrete.
 * Le format JSON est prefere a YAML pour une raison unique mais suffisante :
 * il ne coute aucune dependance, et le Volume I interdit d'en ajouter sans
 * necessite.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlackoutWindow, CapabilityGrant } from "@lcf/kernel";
import { canonicalStringifyPretty } from "@lcf/kernel";

export const CONFIG_FILENAME = "lcf.config.json";

export interface SourceConfigEntry {
  readonly sourceId: string;
  readonly pluginId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly grant?: CapabilityGrant;
  readonly enabled?: boolean;
  /** Cadence propre a cette source ; a defaut, celle du manifeste. */
  readonly cron?: string;
  /** Noms des variables d'environnement portant les secrets declares. */
  readonly secretsFromEnv?: Readonly<Record<string, string>>;
}

export interface LcfConfig {
  readonly dataDir: string;
  readonly migrationsDir: string;
  readonly pluginPaths: readonly string[];
  /** Adresse de contact, obligatoire — Volume VI, 7.2. */
  readonly contact: string;
  readonly sources: readonly SourceConfigEntry[];
  /** Heures pendant lesquelles aucune source ne doit etre sollicitee. */
  readonly blackoutWindows?: readonly BlackoutWindow[];
  /** Cadence par defaut du demon, si le manifeste n'en propose pas. */
  readonly defaultCron?: string;
  /** Alerte quand une source n'a plus rien collecte depuis N heures. */
  readonly silentAfterHours?: number;
  /** Repertoire des sauvegardes, requis par la garde de migration. */
  readonly backupDir?: string;
  /** Journaux durables ; par defaut `<dataDir>/logs`. */
  readonly logDir?: string;
  /** Adresse d'ecoute du tableau de bord. Local par defaut, a dessein. */
  readonly dashboard?: { readonly host?: string; readonly port?: number };
}

/**
 * Repertoire des migrations livre avec l'installation.
 *
 * Les migrations sont du code, pas de la configuration : elles voyagent avec le
 * Framework, jamais avec les donnees. Le chemin est donc resolu depuis le
 * module lui-meme, et seulement ensuite ecrit dans la configuration generee,
 * pour qu'un exploitant voie ou il pointe.
 */
export function bundledMigrationsDir(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (fs.existsSync(path.join(current, "migrations", "0001_initial_schema.sql"))) {
      return path.join(current, "migrations");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "./migrations";
}

export const DEFAULT_CONFIG: LcfConfig = Object.freeze({
  dataDir: "./data",
  migrationsDir: bundledMigrationsDir(),
  pluginPaths: ["./plugins"],
  contact: "ops@example.org",
  sources: [],
});

/**
 * Motifs d'adresses qui ne joignent personne.
 *
 * L'adresse de contact part dans l'en-tete `User-Agent` de chaque requete
 * (Vol. VI, 7.2). Son role est de transformer un blocage en conversation :
 * l'administrateur d'une source qui voit passer des dizaines de milliers de
 * requetes n'a que deux leviers, ecrire ou bannir. Une adresse qui ne joint
 * personne est pire qu'une absence d'adresse — elle promet un interlocuteur
 * qui n'existe pas.
 */
const PLACEHOLDER_CONTACT = /^(a-remplacer|todo|xxx|no-?reply)|@(example|exemple|test|localhost)\./i;

export function isPlaceholderContact(contact: string): boolean {
  const trimmed = contact.trim();
  if (trimmed.length === 0) return true;
  // Une adresse doit au minimum ressembler a une adresse.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
  return PLACEHOLDER_CONTACT.test(trimmed);
}

/** Remplace `${VAR}` par la variable d'environnement correspondante. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => env[name] ?? "");
}

function expandDeep<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === "string") return expandEnv(value, env) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, env)) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandDeep(item, env);
    }
    return out as T;
  }
  return value;
}

export async function loadConfig(configPath: string): Promise<LcfConfig> {
  const raw = await fsp.readFile(configPath, "utf8");
  const parsed = expandDeep(JSON.parse(raw) as Partial<LcfConfig>, process.env);
  const config: LcfConfig = { ...DEFAULT_CONFIG, ...parsed };

  if (config.contact.trim().length === 0) {
    // Un collecteur anonyme finit toujours par etre bloque : l'adresse de
    // contact permet a l'administrateur d'une source de signaler un probleme
    // plutot que de bannir une plage d'adresses (Vol. VI, 7.2).
    throw new Error("configuration : `contact` est obligatoire");
  }
  return config;
}

export async function saveConfig(configPath: string, config: LcfConfig): Promise<void> {
  await fsp.mkdir(path.dirname(path.resolve(configPath)), { recursive: true });
  await fsp.writeFile(configPath, `${canonicalStringifyPretty(config)}\n`, "utf8");
}

export function resolvePaths(configPath: string, config: LcfConfig): LcfConfig {
  const base = path.dirname(path.resolve(configPath));
  return {
    ...config,
    dataDir: path.resolve(base, config.dataDir),
    migrationsDir: path.resolve(base, config.migrationsDir),
    pluginPaths: config.pluginPaths.map((candidate) => path.resolve(base, candidate)),
  };
}
