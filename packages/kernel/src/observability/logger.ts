/**
 * Journalisation structuree — Volume II, chapitre 10 ; Volume VI, chapitre 4.
 *
 * Une ligne de journal est un objet JSON, jamais une phrase. Une phrase se lit,
 * un objet se filtre, s'agrege et s'alerte — et sur quinze ans, c'est la
 * seconde propriete qui compte.
 *
 * Aucun secret ne doit pouvoir transiter par le journal, quelle que soit la
 * discipline de l'appelant : la redaction est appliquee par le journal, pas
 * demandee aux composants.
 */
import { toIsoTimestamp } from "../domain/ids.js";
import type { Clock, Logger, LogLevel } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Cles dont la valeur est systematiquement masquee, quel que soit le contexte. */
const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|cookie|credential)/i;

export const REDACTED = "[REDACTED]";

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly [field: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface JsonLoggerOptions {
  readonly level?: LogLevel;
  readonly clock?: Clock;
  readonly sink?: LogSink;
  readonly bindings?: Readonly<Record<string, unknown>>;
}

export class JsonLogger implements Logger {
  readonly #level: LogLevel;
  readonly #clock: Clock;
  readonly #sink: LogSink;
  readonly #bindings: Readonly<Record<string, unknown>>;

  constructor(options: JsonLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#clock = options.clock ?? new SystemClock();
    this.#sink = options.sink ?? stdoutSink;
    this.#bindings = options.bindings ?? {};
  }

  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#write("debug", message, fields);
  }

  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#write("info", message, fields);
  }

  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#write("warn", message, fields);
  }

  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#write("error", message, fields);
  }

  /** Journal derive, prefixe par des champs constants (source, execution...). */
  child(bindings: Readonly<Record<string, unknown>>): Logger {
    return new JsonLogger({
      level: this.#level,
      clock: this.#clock,
      sink: this.#sink,
      bindings: { ...this.#bindings, ...bindings },
    });
  }

  #write(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;
    this.#sink({
      time: toIsoTimestamp(this.#clock.now()),
      level,
      message,
      ...(redact({ ...this.#bindings, ...fields }) as Record<string, unknown>),
    });
  }
}

function stdoutSink(record: LogRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** Journal silencieux : par defaut dans les tests, ou le bruit masque les signaux. */
export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

/** Journal de collecte, pour verifier ce qui a ete journalise dans un test. */
export class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];
  readonly #bindings: Readonly<Record<string, unknown>>;

  constructor(bindings: Readonly<Record<string, unknown>> = {}) {
    this.#bindings = bindings;
  }

  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#push("debug", message, fields);
  }
  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#push("info", message, fields);
  }
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#push("warn", message, fields);
  }
  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#push("error", message, fields);
  }
  child(bindings: Readonly<Record<string, unknown>>): Logger {
    const child = new RecordingLogger({ ...this.#bindings, ...bindings });
    // Les enfants ecrivent dans le meme tableau : un test observe l'ensemble.
    Object.defineProperty(child, "records", { value: this.records });
    return child;
  }

  #push(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.records.push({
      time: "",
      level,
      message,
      ...(redact({ ...this.#bindings, ...fields }) as Record<string, unknown>),
    });
  }
}

/**
 * Masque les valeurs sensibles, en profondeur.
 * La redaction porte sur le nom du champ, jamais sur sa valeur : chercher des
 * motifs de secrets dans les valeurs produit des faux negatifs silencieux.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}
