/**
 * Capacites effectives — Volume III, chapitre 5.
 *
 * Un plugin n'a par defaut aucun droit. Chaque capacite est demandee dans le
 * manifeste et accordee par la configuration d'exploitation. La capacite
 * effective est l'intersection des deux : ni le mainteneur du plugin ni
 * l'exploitant ne peut elargir seul le pouvoir accorde.
 *
 * Une capacite non accordee n'est pas signalee par un drapeau a tester : le
 * champ correspondant du contexte est simplement absent. Un plugin qui tente
 * d'y acceder echoue immediatement et bruyamment, plutot que de degrader
 * silencieusement sa couverture.
 */
import { normalizeNetworkCapability, type NetworkCapability } from "../net/policy.js";
import type { ManifestCapabilities } from "./manifest.js";

export interface CapabilityGrant {
  readonly network?: {
    readonly allowedHosts?: readonly string[];
    readonly maxRequestsPerMinute?: number;
    readonly politenessDelayMs?: number;
    readonly respectRobotsTxt?: boolean;
  };
  readonly browser?: boolean;
  readonly archives?: boolean;
  readonly inlineContent?: boolean;
  readonly secrets?: readonly string[];
}

export interface EffectiveCapabilities {
  readonly network: NetworkCapability;
  readonly browser: boolean;
  readonly archives: readonly string[];
  readonly inlineContent: boolean;
  readonly secrets: readonly string[];
}

export function effectiveCapabilities(
  requested: ManifestCapabilities,
  granted: CapabilityGrant = {},
  declaredSecrets: readonly string[] = [],
): EffectiveCapabilities {
  const grantedHosts = granted.network?.allowedHosts;
  const allowedHosts =
    grantedHosts === undefined
      ? [...requested.network.allowedHosts]
      : requested.network.allowedHosts.filter((host) => grantedHosts.includes(host));

  // Le quota le plus bas gagne, le delai de politesse le plus long gagne :
  // dans les deux cas, la valeur la plus prudente l'emporte.
  const maxRequestsPerMinute = minDefined(
    requested.network.maxRequestsPerMinute,
    granted.network?.maxRequestsPerMinute,
  );
  const politenessDelayMs = maxDefined(
    requested.network.politenessDelayMs,
    granted.network?.politenessDelayMs,
  );

  const network = normalizeNetworkCapability({
    allowedHosts,
    ...(maxRequestsPerMinute === undefined ? {} : { maxRequestsPerMinute }),
    ...(politenessDelayMs === undefined ? {} : { politenessDelayMs }),
    // Desactiver robots.txt exige un accord explicite des deux cotes.
    respectRobotsTxt: !(
      requested.network.respectRobotsTxt === false && granted.network?.respectRobotsTxt === false
    ),
    ...(requested.network.maxConcurrentPerHost === undefined
      ? {}
      : { maxConcurrentPerHost: requested.network.maxConcurrentPerHost }),
  });

  return {
    network,
    browser: requested.browser === true && granted.browser === true,
    archives:
      granted.archives === true && requested.archives !== undefined ? [...requested.archives] : [],
    inlineContent: requested.inlineContent === true && granted.inlineContent === true,
    secrets: declaredSecrets.filter((name) => granted.secrets?.includes(name) === true),
  };
}

function minDefined(a?: number, b?: number): number | undefined {
  const values = [a, b].filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : Math.min(...values);
}

function maxDefined(a?: number, b?: number): number | undefined {
  const values = [a, b].filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}
