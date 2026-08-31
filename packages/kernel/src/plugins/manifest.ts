/**
 * Manifeste de plugin — Volume III, chapitre 4.
 *
 * Le manifeste est lu AVANT tout chargement de code : il permet de refuser un
 * plugin sans jamais l'executer. Le maximum de verifications est deplace ici,
 * parce que la validation statique est toujours moins chere que la validation
 * dynamique — et qu'un manifeste malveillant ne doit jamais atteindre
 * l'evaluation.
 */
import { PluginRejected } from "../domain/errors.js";
import type { PluginApiVersion } from "../domain/contract.js";
import { formatIssues, validateSchemaShape, type JsonSchema } from "../util/json-schema.js";

export const MANIFEST_FILENAME = "lcf-plugin.json";
export const SUPPORTED_MANIFEST_VERSION = 1;

export interface ManifestNetwork {
  readonly allowedHosts: readonly string[];
  readonly maxRequestsPerMinute?: number;
  readonly politenessDelayMs?: number;
  readonly respectRobotsTxt?: boolean;
  readonly maxConcurrentPerHost?: number;
}

export interface ManifestCapabilities {
  readonly network: ManifestNetwork;
  readonly browser?: boolean;
  readonly archives?: readonly string[];
  readonly inlineContent?: boolean;
}

export interface ManifestIntegrity {
  readonly expectedMimeTypes?: readonly string[];
  readonly minDocumentBytes?: number;
  readonly maxDocumentBytes: number;
}

export interface ManifestSecret {
  readonly name: string;
  readonly required?: boolean;
  readonly description?: string;
}

export interface PluginManifest {
  readonly manifestVersion: number;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly entry: string;
  readonly license?: string;
  readonly maintainers?: readonly string[];
  readonly source?: {
    readonly displayName?: string;
    readonly homepage?: string;
    readonly jurisdictionHint?: string;
    readonly languages?: readonly string[];
  };
  readonly capabilities: ManifestCapabilities;
  readonly schedule?: {
    readonly defaultCron?: string;
    readonly timezone?: string;
    readonly maxConcurrentDownloads?: number;
  };
  readonly configSchema: JsonSchema;
  readonly secrets?: readonly ManifestSecret[];
  readonly integrity: ManifestIntegrity;
  readonly conformance?: {
    readonly kitVersion?: string;
    readonly fixturesPath?: string;
    readonly lastCertifiedAt?: string;
  };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const API_RANGE = /^\^?(\d+)\.(\d+)$/;
const SOURCE_ID = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i;

/**
 * Valide un manifeste. Retourne la liste des motifs de refus ; une liste vide
 * signifie que le plugin peut passer a l'etape suivante du chargement.
 */
export function validateManifest(candidate: unknown): string[] {
  const problems: string[] = [];
  if (typeof candidate !== "object" || candidate === null) {
    return ["le manifeste n'est pas un objet JSON"];
  }
  const manifest = candidate as Partial<PluginManifest>;

  if (manifest.manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    problems.push(
      `manifestVersion non supportee : ${String(manifest.manifestVersion)} (attendu ${SUPPORTED_MANIFEST_VERSION})`,
    );
  }
  if (typeof manifest.id !== "string" || !SOURCE_ID.test(manifest.id)) {
    problems.push(`id absent ou invalide : ${String(manifest.id)}`);
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    problems.push("name absent");
  }
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    problems.push(`version non conforme a SemVer : ${String(manifest.version)}`);
  }
  if (typeof manifest.apiVersion !== "string" || !API_RANGE.test(manifest.apiVersion)) {
    problems.push(`apiVersion invalide : ${String(manifest.apiVersion)}`);
  }

  // Chemin d'entree : relatif, dans le paquet, sans remontee.
  if (typeof manifest.entry !== "string" || manifest.entry.length === 0) {
    problems.push("entry absent");
  } else if (
    manifest.entry.includes("..") ||
    manifest.entry.startsWith("/") ||
    /^[a-zA-Z]:/.test(manifest.entry)
  ) {
    problems.push(`entry doit rester relatif au paquet : ${manifest.entry}`);
  }

  const network = manifest.capabilities?.network;
  if (network === undefined) {
    problems.push("capabilities.network absent");
  } else if (!Array.isArray(network.allowedHosts) || network.allowedHosts.length === 0) {
    // Une liste d'hotes vide autoriserait tout : c'est l'inverse du modele.
    problems.push("capabilities.network.allowedHosts doit etre une liste non vide");
  } else {
    for (const host of network.allowedHosts) {
      if (typeof host !== "string" || !HOSTNAME.test(host)) {
        problems.push(`hote invalide dans allowedHosts : ${String(host)}`);
      }
    }
  }

  if (manifest.configSchema === undefined) {
    problems.push("configSchema absent");
  } else {
    if (manifest.configSchema.type !== "object") {
      problems.push("configSchema.type doit valoir 'object'");
    }
    if (manifest.configSchema.additionalProperties !== false) {
      // Sans cette contrainte, une faute de frappe dans une configuration
      // reste silencieuse jusqu'a produire un comportement inexplicable.
      problems.push("configSchema doit declarer additionalProperties: false");
    }
    const shape = validateSchemaShape(manifest.configSchema, "configSchema");
    if (shape.length > 0) problems.push(formatIssues(shape));
  }

  if (manifest.integrity === undefined) {
    problems.push("integrity absent");
  } else if (
    typeof manifest.integrity.maxDocumentBytes !== "number" ||
    manifest.integrity.maxDocumentBytes <= 0
  ) {
    problems.push("integrity.maxDocumentBytes doit etre un nombre positif");
  }

  for (const secret of manifest.secrets ?? []) {
    if (typeof secret.name !== "string" || secret.name.length === 0) {
      problems.push("secrets[].name absent");
    }
    if ("value" in (secret as unknown as Record<string, unknown>)) {
      // Une valeur de secret dans un manifeste finit dans un depot public.
      problems.push(`un secret ne porte jamais de valeur dans le manifeste : ${secret.name}`);
    }
  }

  return problems;
}

export function parseManifest(json: string, reference: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new PluginRejected(reference, "manifeste illisible", { cause });
  }
  const problems = validateManifest(parsed);
  if (problems.length > 0) {
    throw new PluginRejected(reference, problems.join(" ; "), { context: { problems } });
  }
  return parsed as PluginManifest;
}

/**
 * Compatibilite de version d'API — Volume III, 9.4.
 * `^1.0` accepte toute version 1.x ; une majeure differente est refusee.
 */
export function isApiVersionSupported(
  requested: string,
  supported: PluginApiVersion = "1.0",
): boolean {
  const match = API_RANGE.exec(requested);
  if (match === null) return false;
  const [, major, minor] = match;
  const [supportedMajor, supportedMinor] = supported.split(".");

  if (major !== supportedMajor) return false;
  if (requested.startsWith("^")) {
    return Number(minor) <= Number(supportedMinor);
  }
  return minor === supportedMinor;
}
