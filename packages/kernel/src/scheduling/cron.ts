/**
 * Expressions cron a cinq champs — Volume II, chapitre 8.
 *
 * Ecrit a la main plutot que pris sur etagere : une dependance de production
 * engage quinze ans de maintenance, et le besoin tient en cent lignes. Le
 * sous-ensemble couvert est celui que les manifestes emploient :
 *
 *   minute  heure  jour-du-mois  mois  jour-de-semaine
 *   *       listes (1,15)       plages (1-5)      pas (star/15, 1-30/2)
 *
 * Ni `@daily`, ni `L`, ni `#` : ce qui n'est pas compris est refuse a la
 * lecture, jamais interprete de travers.
 */

export interface CronExpression {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly source: string;
}

const FIELDS: readonly { name: string; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "heure", min: 0, max: 23 },
  { name: "jour du mois", min: 1, max: 31 },
  { name: "mois", min: 1, max: 12 },
  { name: "jour de la semaine", min: 0, max: 6 },
];

function parseField(spec: string, min: number, max: number, label: string): Set<number> {
  const values = new Set<number>();

  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new TypeError(`cron : pas invalide dans le champ ${label} ("${part}")`);
    }

    let from: number;
    let to: number;
    if (range === "*" || range === undefined) {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const bounds = range.split("-");
      from = Number(bounds[0]);
      to = Number(bounds[1]);
    } else {
      from = Number(range);
      to = stepText === undefined ? from : max;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new TypeError(`cron : valeur hors bornes dans le champ ${label} ("${part}")`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return values;
}

export function parseCron(expression: string): CronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new TypeError(
      `cron : cinq champs attendus (minute heure jour mois jour-semaine), recu "${expression}"`,
    );
  }

  const parsed = parts.map((part, index) => {
    const field = FIELDS[index] as (typeof FIELDS)[number];
    return parseField(part, field.min, field.max, field.name);
  });

  return {
    minutes: parsed[0] as Set<number>,
    hours: parsed[1] as Set<number>,
    daysOfMonth: parsed[2] as Set<number>,
    months: parsed[3] as Set<number>,
    daysOfWeek: parsed[4] as Set<number>,
    source: expression.trim(),
  };
}

/** La date correspond-elle a l'expression, a la minute pres ? */
export function matchesCron(cron: CronExpression, date: Date): boolean {
  if (!cron.minutes.has(date.getMinutes())) return false;
  if (!cron.hours.has(date.getHours())) return false;
  if (!cron.months.has(date.getMonth() + 1)) return false;

  // Convention cron historique : quand les deux champs de jour sont restreints,
  // l'un OU l'autre suffit. Surprenant, mais c'est ce que tout le monde attend.
  const dayOfMonthRestricted = cron.daysOfMonth.size < 31;
  const dayOfWeekRestricted = cron.daysOfWeek.size < 7;
  const matchesDayOfMonth = cron.daysOfMonth.has(date.getDate());
  const matchesDayOfWeek = cron.daysOfWeek.has(date.getDay());

  if (dayOfMonthRestricted && dayOfWeekRestricted) {
    return matchesDayOfMonth || matchesDayOfWeek;
  }
  return matchesDayOfMonth && matchesDayOfWeek;
}

/**
 * Prochaine echeance strictement posterieure a `from`.
 * La recherche est bornee a quatre ans : au-dela, l'expression ne peut pas
 * etre satisfaite (un 30 fevrier, par exemple) et il vaut mieux le dire.
 */
export function nextRunAfter(cron: CronExpression, from: Date): Date | null {
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = 4 * 366 * 24 * 60;
  for (let step = 0; step < limit; step++) {
    if (matchesCron(cron, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/** Valide une expression et retourne le motif du refus, ou `null`. */
export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
