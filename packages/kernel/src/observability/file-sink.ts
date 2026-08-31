/**
 * Journaux durables sur disque — Volume VII, chapitres 2 et 3.
 *
 * Un demon qui tourne des semaines ecrit dans le vide si personne ne conserve
 * sa parole. Trois exigences, et pas une de plus :
 *   - une ligne = un objet JSON, pour rester filtrable ;
 *   - un fichier par jour, pour rester consultable ;
 *   - une retention bornee, pour ne pas remplir le disque qui porte le corpus.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { Clock } from "../domain/contract.js";
import { SystemClock } from "../domain/clock.js";
import type { DomainEvent } from "../domain/events.js";
import type { EventFilter, EventJournal } from "../events/event-bus.js";
import { matchesFilter } from "../events/event-bus.js";
import type { LogRecord, LogSink } from "./logger.js";

export interface FileSinkOptions {
  readonly directory: string;
  readonly prefix?: string;
  readonly retentionDays?: number;
  readonly clock?: Clock;
  /** Ecriture aussi sur la sortie standard : utile sous systemd. */
  readonly alsoStdout?: boolean;
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Ecrivain de fichiers journaliers, en ajout seul.
 *
 * L'ecriture est SYNCHRONE : un journal qui perd ses dernieres lignes au moment
 * d'un plantage perd precisement celles qui expliquent le plantage.
 */
export class DailyFileWriter {
  readonly #directory: string;
  readonly #prefix: string;
  readonly #retentionDays: number;
  readonly #clock: Clock;
  #currentDay: string | null = null;
  #stream: fs.WriteStream | null = null;

  constructor(options: FileSinkOptions) {
    this.#directory = path.resolve(options.directory);
    this.#prefix = options.prefix ?? "lcf";
    this.#retentionDays = options.retentionDays ?? 90;
    this.#clock = options.clock ?? new SystemClock();
    fs.mkdirSync(this.#directory, { recursive: true });
  }

  write(line: string): void {
    const day = dayOf(this.#clock.now());
    if (day !== this.#currentDay) this.#rotate(day);
    this.#stream?.write(`${line}\n`);
  }

  #rotate(day: string): void {
    this.#stream?.end();
    this.#currentDay = day;
    this.#stream = fs.createWriteStream(
      path.join(this.#directory, `${this.#prefix}-${day}.jsonl`),
      { flags: "a" },
    );
    // La purge accompagne la rotation : aucune tache de menage a planifier,
    // donc aucune tache de menage a oublier.
    void this.purge();
  }

  /** Supprime les fichiers plus vieux que la retention. */
  async purge(): Promise<number> {
    const cutoff = this.#clock.nowMillis() - this.#retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      for (const name of await fsp.readdir(this.#directory)) {
        if (!name.startsWith(`${this.#prefix}-`) || !name.endsWith(".jsonl")) continue;
        const day = name.slice(this.#prefix.length + 1, -6);
        const stamp = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`);
        if (Number.isNaN(stamp) || stamp >= cutoff) continue;
        await fsp.rm(path.join(this.#directory, name), { force: true });
        removed++;
      }
    } catch {
      // Une purge impossible ne doit jamais empecher d'ecrire un journal.
    }
    return removed;
  }

  close(): void {
    this.#stream?.end();
    this.#stream = null;
    this.#currentDay = null;
  }

  get directory(): string {
    return this.#directory;
  }
}

/** Sortie de journalisation vers des fichiers journaliers. */
export function createFileSink(options: FileSinkOptions): LogSink & { close(): void } {
  const writer = new DailyFileWriter(options);
  const sink = (record: LogRecord): void => {
    const line = JSON.stringify(record);
    writer.write(line);
    if (options.alsoStdout === true) process.stdout.write(`${line}\n`);
  };
  return Object.assign(sink, { close: (): void => writer.close() });
}

/**
 * Journal d'evenements durable — comble le point B5.
 *
 * Le journal en memoire suffisait a rejouer une fin d'execution ; il ne
 * survivait pas au processus. Le format retenu est le meme que les journaux :
 * du JSONL en ajout seul, lisible avec les memes outils, et coherent avec la
 * philosophie du magasin — un fichier qu'on n'a pas besoin de la base pour lire.
 */
export class FileEventJournal implements EventJournal {
  readonly #writer: DailyFileWriter;
  readonly #directory: string;
  readonly #memory: DomainEvent[] = [];
  readonly #memoryCapacity: number;

  constructor(options: FileSinkOptions & { readonly memoryCapacity?: number }) {
    this.#writer = new DailyFileWriter({ ...options, prefix: options.prefix ?? "events" });
    this.#directory = this.#writer.directory;
    this.#memoryCapacity = options.memoryCapacity ?? 1000;
  }

  async append(event: DomainEvent): Promise<void> {
    this.#writer.write(JSON.stringify(event));
    this.#memory.push(event);
    if (this.#memory.length > this.#memoryCapacity) this.#memory.shift();
  }

  /**
   * Les evenements recents viennent de la memoire ; au-dela, on relit les
   * fichiers. La lecture est bornee aux derniers jours : un journal d'evenements
   * n'est pas une base de donnees, et pretendre le contraire serait un piege.
   */
  async list(filter?: EventFilter): Promise<DomainEvent[]> {
    const limit = filter?.limit ?? 500;
    const fromMemory = this.#memory.filter((event) => matchesFilter(event, filter));
    if (fromMemory.length >= limit) return fromMemory.slice(-limit);

    const collected: DomainEvent[] = [];
    try {
      const files = (await fsp.readdir(this.#directory))
        .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
        .sort()
        .slice(-7);

      for (const name of files) {
        const content = await fsp.readFile(path.join(this.#directory, name), "utf8");
        for (const line of content.split("\n")) {
          if (line.trim().length === 0) continue;
          try {
            const event = JSON.parse(line) as DomainEvent;
            if (matchesFilter(event, filter)) collected.push(event);
          } catch {
            // Une ligne tronquee par un plantage ne doit pas rendre tout le
            // journal illisible : on l'ignore et on poursuit.
          }
        }
      }
    } catch {
      return fromMemory.slice(-limit);
    }
    return collected.slice(-limit);
  }

  close(): void {
    this.#writer.close();
  }
}
