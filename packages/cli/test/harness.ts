/**
 * Harnais des tests d'acceptation — Volume VIII.
 *
 * Le systeme complet est monte de bout en bout : magasin, base, bus, plugin
 * reel charge depuis le disque. Seul le transport HTTP est substitue, parce
 * qu'une suite de tests ne touche jamais le reseau.
 */
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FixtureHttpTransport,
  ManualClock,
  SilentLogger,
  type FixturePlan,
  type FixtureResponse,
} from "@lcf/kernel";

import { LcfApp } from "../src/app.js";
import { saveConfig, type LcfConfig } from "../src/config.js";

export const PORTAL = "https://portal.example";

export function repoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (fs.existsSync(path.join(current, "migrations", "0001_initial_schema.sql"))) return current;
    current = path.dirname(current);
  }
  throw new Error("racine du depot introuvable");
}

export function pdf(nativeId: string, revision = 1): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\nacte ${nativeId} revision ${revision}\n`);
}

export function indexPage(entries: readonly string[], hasNext: boolean): string {
  const articles = entries
    .map(
      (nativeId) => `
    <article class="doc-entry">
      <a href="/documents/${nativeId}">lien</a>
      <h3>Acte n. ${nativeId}</h3>
      <time datetime="2026-03-04">4 mars 2026</time>
    </article>`,
    )
    .join("\n");
  const next = hasNext ? '<a rel="next" href="?page=1">suivant</a>' : "";
  return `<html><body>${articles}${next}</body></html>`;
}

export const EMPTY_PAGE = '<html><body><div class="no-results">aucun document</div></body></html>';

/** Plan de reponses par defaut : deux pages, trois documents. */
export function defaultFixtures(): FixturePlan {
  return {
    [`${PORTAL}/robots.txt`]: { body: "User-agent: *\nAllow: /\n" },
    [`${PORTAL}/documents?page=0`]: { body: indexPage(["2024-118", "2024-119"], true) },
    [`${PORTAL}/documents?page=1`]: { body: indexPage(["2024-120"], false) },
    [`${PORTAL}/documents/2024-118.pdf`]: {
      body: pdf("2024-118"),
      headers: { "content-type": "application/pdf", etag: '"v1-118"' },
    },
    [`${PORTAL}/documents/2024-119.pdf`]: {
      body: pdf("2024-119"),
      headers: { "content-type": "application/pdf", etag: '"v1-119"' },
    },
    [`${PORTAL}/documents/2024-120.pdf`]: {
      body: pdf("2024-120"),
      headers: { "content-type": "application/pdf", etag: '"v1-120"' },
    },
  };
}

export interface Workspace {
  readonly dir: string;
  readonly configPath: string;
  readonly clock: ManualClock;
  transport: FixtureHttpTransport;
  open(): Promise<LcfApp>;
  setFixtures(plan: FixturePlan): void;
  cleanup(): Promise<void>;
}

export interface WorkspaceOptions {
  readonly sources?: LcfConfig["sources"];
  readonly fixtures?: FixturePlan;
}

export async function createWorkspace(options: WorkspaceOptions = {}): Promise<Workspace> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lcf-e2e-"));
  const configPath = path.join(dir, "lcf.config.json");
  const root = repoRoot();
  const clock = new ManualClock(1_700_000_000_000);
  let transport = new FixtureHttpTransport(options.fixtures ?? defaultFixtures());

  await saveConfig(configPath, {
    dataDir: path.join(dir, "data"),
    migrationsDir: path.join(root, "migrations"),
    pluginPaths: [path.join(root, "plugins")],
    contact: "tests@example.org",
    sources: options.sources ?? [
      {
        sourceId: "portal",
        pluginId: "example.paginated.portal",
        config: { baseUrl: PORTAL },
        enabled: true,
      },
    ],
  });

  const workspace: Workspace = {
    dir,
    configPath,
    clock,
    get transport(): FixtureHttpTransport {
      return transport;
    },
    set transport(value: FixtureHttpTransport) {
      transport = value;
    },
    setFixtures(plan: FixturePlan): void {
      transport = new FixtureHttpTransport(plan);
    },
    async open(): Promise<LcfApp> {
      const app = await LcfApp.open({
        configPath,
        clock,
        transport: { send: (request) => transport.send(request) },
        logger: new SilentLogger(),
      });
      await app.migrate();
      return app;
    },
    async cleanup(): Promise<void> {
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
  return workspace;
}

/**
 * Fait avancer l'horloge manuelle en tache de fond.
 *
 * Les delais de politesse du manifeste (1 200 ms) sont reels : sans cette
 * pompe, la suite durerait des minutes. Le temps simule reste coherent, seule
 * son avance est acceleree.
 */
export function startClockPump(clock: ManualClock): () => void {
  // Le minuteur n'est volontairement PAS `unref` : sans lui, la boucle
  // d'evenements se viderait pendant qu'une attente d'horloge simulee est
  // encore en cours, et Node conclurait a tort a un blocage.
  const timer = setInterval(() => clock.advance(5000), 1);
  return () => clearInterval(timer);
}

/** Remplace la reponse d'un document, pour simuler une republication. */
export function withRevision(plan: FixturePlan, nativeId: string, revision: number): FixturePlan {
  const response: FixtureResponse = {
    body: pdf(nativeId, revision),
    headers: { "content-type": "application/pdf", etag: `"v${revision}-${nativeId}"` },
  };
  return { ...plan, [`${PORTAL}/documents/${nativeId}.pdf`]: response };
}
