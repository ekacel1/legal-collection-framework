/**
 * Tableau de bord local — Volume III chapitre 11.3, Volume VI chapitre 6.
 *
 * Une projection du SDK sur HTTP, sans aucune logique metier propre. Trois
 * regles de securite le gouvernent, et elles ne sont pas negociables :
 *
 *   1. Ecoute sur 127.0.0.1 par defaut. Un tableau de bord expose a l'Internet
 *      donnerait a n'importe qui le pouvoir de declencher des collectes.
 *   2. Le corpus est en LECTURE SEULE : aucune route ne modifie un document.
 *   3. Aucune operation destructive. La purge n'existe qu'en ligne de commande
 *      (AC-6.7) : une operation irreversible ne doit pas etre accessible
 *      derriere un jeton qui peut fuir.
 *
 * Il peut en revanche declencher et arreter une collecte : c'est explicitement
 * prevu par le Volume III, 11.3.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { describeUnknown, type RunSummary } from "@lcf/kernel";

import type { LcfApp } from "./app.js";
import { readHeartbeat } from "./daemon.js";
import { renderDashboardHtml } from "./dashboard-page.js";

export interface DashboardOptions {
  readonly app: LcfApp;
  readonly host?: string;
  readonly port?: number;
  readonly out?: (line: string) => void;
}

export interface RunningCollection {
  readonly sourceId: string;
  readonly startedAt: string;
}

/** Etat complet, tel que la page et l'API le consomment. */
export interface DashboardState {
  readonly store: string;
  readonly daemon: { readonly active: boolean; readonly pid?: number; readonly startedAt?: string };
  readonly totals: {
    readonly documents: number;
    readonly objects: number;
    readonly bytes: number;
    readonly failed: number;
  };
  readonly sources: readonly {
    readonly sourceId: string;
    readonly state: string;
    readonly documents: number;
    readonly lastSuccessAt: string | null;
    readonly quarantineReason: string | null;
    readonly running: boolean;
  }[];
  readonly runs: readonly {
    readonly runId: string;
    readonly sourceId: string;
    readonly mode: string;
    readonly status: string;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly docsNew: number;
    readonly docsUpdated: number;
    readonly docsUnchanged: number;
    readonly docsFailed: number;
    readonly bytes: number;
  }[];
  readonly daily: readonly { readonly day: string; readonly documents: number; readonly bytes: number }[];
}

export class Dashboard {
  readonly #app: LcfApp;
  readonly #host: string;
  readonly #port: number;
  readonly #out: (line: string) => void;
  readonly #running = new Map<string, RunningCollection>();
  #server: Server | null = null;

  constructor(options: DashboardOptions) {
    this.#app = options.app;
    // Local par defaut : exposer ce service revient a donner le declenchement
    // de collectes a qui passe par la.
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 7331;
    this.#out = options.out ?? console.log;
  }

  async listen(): Promise<{ host: string; port: number }> {
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        this.#send(response, 500, { error: describeUnknown(error) });
      });
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, this.#host, resolve);
    });
    return { host: this.#host, port: this.#port };
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.#host}:${this.#port}`);
    const route = `${request.method ?? "GET"} ${url.pathname}`;

    switch (route) {
      case "GET /":
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderDashboardHtml());
        return;

      case "GET /api/state":
        this.#send(response, 200, await this.state());
        return;

      case "GET /api/documents": {
        const page = await this.#app.repository.query({
          ...(url.searchParams.get("source") === null
            ? {}
            : { sourceId: this.#app.asSourceId(url.searchParams.get("source") as string) }),
          limit: Number(url.searchParams.get("limit") ?? 50),
          ...(url.searchParams.get("cursor") === null
            ? {}
            : { cursor: url.searchParams.get("cursor") }),
        });
        this.#send(response, 200, page);
        return;
      }

      case "POST /api/run": {
        const body = await readJson(request);
        const sourceId = String(body["sourceId"] ?? "");
        this.#send(response, 202, await this.startRun(sourceId, body["mode"] === "full"));
        return;
      }

      case "POST /api/stop": {
        // L'arret est cooperatif : la collecte en cours se termine sur le
        // document courant. Interrompre en plein transfert ne ferait qu'un
        // fichier de transit orphelin de plus.
        const stopped = this.#app.runner.requestStopAll();
        this.#send(response, 200, { stopping: stopped });
        return;
      }

      default:
        this.#send(response, 404, { error: `route inconnue : ${route}` });
    }
  }

  /** Declenche une collecte en tache de fond et rend la main aussitot. */
  async startRun(sourceId: string, full: boolean): Promise<{ started: boolean; reason?: string }> {
    if (sourceId.length === 0) return { started: false, reason: "sourceId manquant" };
    if (this.#running.has(sourceId)) return { started: false, reason: "collecte deja en cours" };

    let loaded;
    try {
      loaded = await this.#app.loadSource(sourceId);
    } catch (error) {
      return { started: false, reason: describeUnknown(error) };
    }

    this.#running.set(sourceId, {
      sourceId,
      startedAt: new Date().toISOString(),
    });

    void this.#app.runner
      .run(loaded, { mode: full ? "full" : "incremental", trigger: "api" })
      .then((summary: RunSummary) => {
        this.#out(`collecte ${summary.sourceId} : ${summary.status}`);
      })
      .catch((error: unknown) => {
        this.#app.logger.error("collecte declenchee depuis le tableau de bord en echec", {
          sourceId,
          error: describeUnknown(error),
        });
      })
      .finally(() => {
        this.#running.delete(sourceId);
      });

    return { started: true };
  }

  async state(): Promise<DashboardState> {
    const app = this.#app;
    const sources = await app.repository.listSources();
    const beat = await readHeartbeat(app.config.dataDir);
    const objects = await app.repository.countContentObjects();

    let documents = 0;
    let failed = 0;
    const perSource: DashboardState["sources"][number][] = [];

    for (const source of sources) {
      const count = await app.repository.countDocuments(source.sourceId);
      documents += count;
      const failedPage = await app.repository.query({
        sourceId: source.sourceId,
        status: "failed",
        limit: 1000,
      });
      failed += failedPage.items.length;

      perSource.push({
        sourceId: source.sourceId,
        state: source.state,
        documents: count,
        lastSuccessAt: source.lastSuccessAt ?? null,
        quarantineReason: source.quarantineReason ?? null,
        running: this.#running.has(source.sourceId),
      });
    }

    const runs = await app.driver.all<{
      run_id: string;
      source_id: string;
      mode: string;
      status: string;
      started_at: string;
      ended_at: string | null;
      docs_new: number;
      docs_updated: number;
      docs_unchanged: number;
      docs_failed: number;
      bytes_downloaded: number;
    }>(
      `SELECT run_id, source_id, mode, status, started_at, ended_at,
              docs_new, docs_updated, docs_unchanged, docs_failed, bytes_downloaded
         FROM runs ORDER BY started_at DESC LIMIT 25`,
    );

    // Evolution du corpus : ce que le tableau de bord sert a voir d'un coup.
    const daily = await app.driver.all<{ day: string; documents: number; bytes: number }>(
      `SELECT substr(v.fetched_at, 1, 10) AS day,
              COUNT(*) AS documents,
              COALESCE(SUM(c.byte_size), 0) AS bytes
         FROM document_versions v
         JOIN content_objects c ON c.content_hash = v.content_hash
        GROUP BY day ORDER BY day`,
    );

    return {
      store: app.config.dataDir,
      daemon:
        beat === null
          ? { active: false }
          : { active: true, pid: beat.pid, startedAt: beat.startedAt },
      totals: { documents, objects: objects.objects, bytes: objects.bytes, failed },
      sources: perSource,
      runs: runs.map((row) => ({
        runId: row.run_id,
        sourceId: row.source_id,
        mode: row.mode,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        docsNew: Number(row.docs_new),
        docsUpdated: Number(row.docs_updated),
        docsUnchanged: Number(row.docs_unchanged),
        docsFailed: Number(row.docs_failed),
        bytes: Number(row.bytes_downloaded),
      })),
      daily: daily.map((row) => ({
        day: String(row.day),
        documents: Number(row.documents),
        bytes: Number(row.bytes),
      })),
    };
  }

  #send(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
