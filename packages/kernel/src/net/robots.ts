/**
 * robots.txt — Volume VI, chapitre 7.2 et AC-6.6.
 *
 * Le respect de robots.txt est actif par defaut. Il est applique par le client
 * injecte, donc inaccessible au plugin : un contournement exigerait de modifier
 * le Kernel, ce qui laisse une trace en revue.
 */
import { collectBody, type HttpTransport } from "./transport.js";

interface Group {
  readonly agents: string[];
  readonly allow: string[];
  readonly disallow: string[];
}

export interface RobotsRuleset {
  readonly groups: readonly Group[];
  /** Aucune regle applicable : tout est autorise. */
  readonly allowAll: boolean;
  /** robots.txt inaccessible pour cause de panne serveur : tout est interdit. */
  readonly denyAll: boolean;
}

export const ALLOW_ALL: RobotsRuleset = Object.freeze({
  groups: [],
  allowAll: true,
  denyAll: false,
});

export const DENY_ALL: RobotsRuleset = Object.freeze({
  groups: [],
  allowAll: false,
  denyAll: true,
});

export function parseRobots(text: string): RobotsRuleset {
  const groups: Group[] = [];
  let current: Group | null = null;
  let previousWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (current === null || !previousWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }

    previousWasAgent = false;
    if (current === null) continue;
    if (field === "allow") current.allow.push(value);
    else if (field === "disallow") current.disallow.push(value);
  }

  return { groups, allowAll: groups.length === 0, denyAll: false };
}

/**
 * Regle applicable : la plus longue correspondance l'emporte, `Allow` gagnant a
 * longueur egale. C'est la regle de la RFC 9309, et elle evite qu'un `Allow`
 * precis soit annule par un `Disallow` general.
 */
export function isAllowed(ruleset: RobotsRuleset, userAgent: string, urlPath: string): boolean {
  if (ruleset.denyAll) return false;
  if (ruleset.allowAll) return true;

  const agent = userAgent.toLowerCase();
  const specific = ruleset.groups.find((group) =>
    group.agents.some((candidate) => candidate !== "*" && agent.includes(candidate)),
  );
  const wildcard = ruleset.groups.find((group) => group.agents.includes("*"));
  const group = specific ?? wildcard;
  if (group === undefined) return true;

  const longest = (patterns: readonly string[]): number =>
    patterns
      .filter((pattern) => pattern.length > 0 && matchesPath(pattern, urlPath))
      .reduce((max, pattern) => Math.max(max, pattern.length), -1);

  const allow = longest(group.allow);
  const disallow = longest(group.disallow);
  if (group.disallow.includes("")) return true;
  if (disallow === -1) return true;
  return allow >= disallow;
}

function matchesPath(pattern: string, urlPath: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");

  let index = 0;
  for (const [position, segment] of segments.entries()) {
    if (segment.length === 0) continue;
    const found = position === 0 ? (urlPath.startsWith(segment) ? 0 : -1) : urlPath.indexOf(segment, index);
    if (found === -1) return false;
    index = found + segment.length;
  }
  return anchored ? index === urlPath.length : true;
}

export interface RobotsCacheOptions {
  readonly userAgent: string;
  readonly ttlMs?: number;
}

/** Cache par hote : un robots.txt par collecte, pas un par requete. */
export class RobotsPolicy {
  readonly #transport: HttpTransport;
  readonly #userAgent: string;
  readonly #cache = new Map<string, RobotsRuleset>();

  constructor(transport: HttpTransport, options: RobotsCacheOptions) {
    this.#transport = transport;
    this.#userAgent = options.userAgent;
  }

  async allows(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const ruleset = await this.#rulesetFor(parsed.origin);
    return isAllowed(ruleset, this.#userAgent, parsed.pathname + parsed.search);
  }

  async #rulesetFor(origin: string): Promise<RobotsRuleset> {
    const cached = this.#cache.get(origin);
    if (cached !== undefined) return cached;

    let ruleset: RobotsRuleset;
    try {
      const response = await this.#transport.send({
        url: `${origin}/robots.txt`,
        method: "GET",
        headers: { "user-agent": this.#userAgent },
      });
      if (response.status === 200) {
        ruleset = parseRobots(new TextDecoder().decode(await collectBody(response.body)));
      } else if (response.status >= 500) {
        // Panne serveur : la RFC 9309 impose de considerer tout interdit.
        // C'est le seul choix qui ne risque pas de marteler une source en panne.
        ruleset = DENY_ALL;
      } else {
        ruleset = ALLOW_ALL;
      }
    } catch {
      // robots.txt injoignable : on n'invente pas d'autorisation.
      ruleset = DENY_ALL;
    }

    this.#cache.set(origin, ruleset);
    return ruleset;
  }
}
