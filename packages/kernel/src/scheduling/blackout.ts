/**
 * Fenetres d'exclusion — Volume VI, chapitre 7.3.
 *
 * Une collecte de soixante heures traverse forcement des heures ouvrables.
 * C'est precisement le moment ou la charge sur les serveurs d'une
 * administration compte le plus : ses propres agents et ses usagers s'en
 * servent. Collecter la nuit ne coute rien au collecteur et epargne la source.
 */
import type { Clock } from "../domain/contract.js";

export interface BlackoutWindow {
  /** `mon-fri`, `sat,sun`, `mon`, ou `*`. */
  readonly days: string;
  /** `HH:MM` inclus. */
  readonly from: string;
  /** `HH:MM` exclus. Anterieur a `from` : la fenetre traverse minuit. */
  readonly to: string;
  /** `local` (defaut) ou `utc`. */
  readonly tz?: "local" | "utc";
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function parseDays(spec: string): Set<number> {
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === "*" || trimmed === "all") return new Set([0, 1, 2, 3, 4, 5, 6]);

  const days = new Set<number>();
  for (const part of trimmed.split(",")) {
    const range = part.trim().split("-");
    const start = DAY_NAMES.indexOf((range[0] ?? "").trim() as (typeof DAY_NAMES)[number]);
    if (start === -1) continue;

    if (range.length === 1) {
      days.add(start);
      continue;
    }
    const end = DAY_NAMES.indexOf((range[1] ?? "").trim() as (typeof DAY_NAMES)[number]);
    if (end === -1) continue;
    // La plage peut enjamber la fin de semaine : `fri-mon` est licite.
    for (let index = start; ; index = (index + 1) % 7) {
      days.add(index);
      if (index === end) break;
    }
  }
  return days;
}

function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** La date tombe-t-elle dans l'une des fenetres d'exclusion ? */
export function isInBlackout(windows: readonly BlackoutWindow[], date: Date): boolean {
  return matchingWindow(windows, date) !== null;
}

/** La fenetre qui exclut cette date, ou `null`. Utile pour l'expliquer. */
export function matchingWindow(
  windows: readonly BlackoutWindow[],
  date: Date,
): BlackoutWindow | null {
  for (const window of windows) {
    const utc = window.tz === "utc";
    const day = utc ? date.getUTCDay() : date.getDay();
    const minutes = utc
      ? date.getUTCHours() * 60 + date.getUTCMinutes()
      : date.getHours() * 60 + date.getMinutes();

    const from = parseMinutes(window.from);
    const to = parseMinutes(window.to);
    // Une fenetre illisible n'exclut rien : une configuration fautive ne doit
    // pas arreter silencieusement la collecte. Elle est signalee ailleurs.
    if (from === null || to === null) continue;

    const days = parseDays(window.days);

    if (from <= to) {
      if (days.has(day) && minutes >= from && minutes < to) return window;
      continue;
    }

    // Fenetre a cheval sur minuit : 22:00 -> 06:00.
    if (days.has(day) && minutes >= from) return window;
    const previousDay = (day + 6) % 7;
    if (days.has(previousDay) && minutes < to) return window;
  }
  return null;
}

/** Description lisible, pour les journaux et la CLI. */
export function describeWindow(window: BlackoutWindow): string {
  return `${window.days} ${window.from}-${window.to} (${window.tz ?? "local"})`;
}

/** Valide une liste de fenetres et retourne les erreurs trouvees. */
export function validateWindows(windows: readonly BlackoutWindow[]): string[] {
  const problems: string[] = [];
  windows.forEach((window, index) => {
    if (parseMinutes(window.from) === null) {
      problems.push(`fenetre ${index} : heure de debut invalide (${window.from})`);
    }
    if (parseMinutes(window.to) === null) {
      problems.push(`fenetre ${index} : heure de fin invalide (${window.to})`);
    }
    if (parseDays(window.days).size === 0) {
      problems.push(`fenetre ${index} : aucun jour reconnu dans "${window.days}"`);
    }
  });
  return problems;
}

/** Instant courant selon l'horloge injectee : rend les tests reproductibles. */
export function isBlackoutNow(windows: readonly BlackoutWindow[], clock: Clock): boolean {
  return isInBlackout(windows, clock.now());
}
