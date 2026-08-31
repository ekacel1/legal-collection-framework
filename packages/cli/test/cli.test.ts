/**
 * Tests de la ligne de commande — Volume IX, 4.1 (« CLI : init, source add,
 * run, status »).
 *
 * La CLI est un adaptateur : ces tests verifient le cablage, les codes de
 * sortie et les messages, pas la logique metier, qui est testee en amont.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { main, parseArgv } from "../src/bin.js";
import { expandEnv, loadConfig } from "../src/config.js";
import { repoRoot } from "./harness.js";

let workspace: string;
let lines: string[];

const out = (line: string): void => {
  lines.push(line);
};

const text = (): string => lines.join("\n");

async function run(...argv: string[]): Promise<number> {
  return main(argv, out, workspace);
}

beforeEach(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "lcf-cli-"));
  lines = [];
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

describe("analyse des arguments", () => {
  test("les commandes a deux mots sont reconnues", () => {
    const parsed = parseArgv(["source", "add", "example.portal", "--id", "portal"]);
    assert.deepEqual(parsed.command, ["source", "add"]);
    assert.deepEqual(parsed.positionals, ["example.portal"]);
    assert.equal(parsed.flags["id"], "portal");
  });

  test("un drapeau sans valeur vaut vrai", () => {
    assert.equal(parseArgv(["verify", "--all"]).flags["all"], true);
  });

  test("les variables d'environnement sont substituees dans la configuration", () => {
    assert.equal(expandEnv("${LCF_TEST_HOST}/a", { LCF_TEST_HOST: "https://x.example" }), "https://x.example/a");
    assert.equal(expandEnv("${ABSENTE}/a", {}), "/a");
  });
});

describe("lcf help", () => {
  test("l'aide est affichee sans argument", async () => {
    assert.equal(await run(), 0);
    assert.match(text(), /Usage : lcf <commande>/);
    assert.match(text(), /Le document original n'est jamais modifie/);
  });

  test("une commande inconnue sort en code 2 avec l'aide", async () => {
    assert.equal(await run("collecter-tout"), 2);
    assert.match(text(), /commande inconnue/);
  });
});

describe("lcf init", () => {
  test("cree la configuration, le magasin et le schema", async () => {
    assert.equal(await run("init", "--contact", "ops@example.org"), 0);

    const configPath = path.join(workspace, "lcf.config.json");
    const config = await loadConfig(configPath);
    assert.equal(config.contact, "ops@example.org");

    for (const dir of ["objects", "tmp", "index", "backup"]) {
      await fsp.access(path.join(workspace, "data", dir));
    }
    await fsp.access(path.join(workspace, "data", "index", "lcf.db"));
    assert.match(text(), /Schema migre : 0 -> 2/);
  });

  test("relancer init ne detruit ni la configuration ni les donnees", async () => {
    await run("init", "--contact", "ops@example.org");
    lines = [];
    assert.equal(await run("init"), 0);
    assert.match(text(), /Configuration existante conservee/);
    assert.match(text(), /Schema deja a jour \(version 2\)/);
  });

  test("les plugins presents sont detectes et nommes", async () => {
    await fsp.writeFile(
      path.join(workspace, "lcf.config.json"),
      JSON.stringify({
        dataDir: "./data",
        migrationsDir: path.join(repoRoot(), "migrations"),
        pluginPaths: [path.join(repoRoot(), "plugins")],
        contact: "ops@example.org",
        sources: [],
      }),
    );
    assert.equal(await run("init"), 0);
    assert.match(text(), /example\.paginated\.portal@0\.1\.0/);
  });
});

describe("lcf source add / list", () => {
  async function initWithPlugins(): Promise<void> {
    await fsp.writeFile(
      path.join(workspace, "lcf.config.json"),
      JSON.stringify({
        dataDir: "./data",
        migrationsDir: path.join(repoRoot(), "migrations"),
        pluginPaths: [path.join(repoRoot(), "plugins")],
        contact: "ops@example.org",
        sources: [],
      }),
    );
    await run("init");
    lines = [];
  }

  test("une source est declaree, chargee et enregistree", async () => {
    await initWithPlugins();
    const code = await run(
      "source",
      "add",
      "example.paginated.portal",
      "--id",
      "portal",
      "--config",
      '{"baseUrl":"https://portal.example"}',
    );

    assert.equal(code, 0);
    assert.match(text(), /Source ajoutee : portal/);
    assert.match(text(), /hotes autorises : portal\.example/);
    // Les capacites optionnelles sont detectees dans le code du plugin.
    assert.match(text(), /describable/);
    assert.match(text(), /incremental/);

    lines = [];
    assert.equal(await run("source", "list"), 0);
    assert.match(text(), /portal\s+ready\s+0 document/);
  });

  test("une configuration invalide est refusee au moment de l'ajout", async () => {
    await initWithPlugins();
    // `baseUrl` est obligatoire dans le schema declare par le manifeste : la
    // faute est signalee a l'ajout, pas a trois heures du matin.
    const code = await run("source", "add", "example.paginated.portal", "--id", "casse", "--config", "{}");
    assert.equal(code, 1);
    assert.match(text(), /champ obligatoire manquant/);
  });

  test("un champ de configuration inconnu est refuse", async () => {
    await initWithPlugins();
    const code = await run(
      "source",
      "add",
      "example.paginated.portal",
      "--id",
      "typo",
      "--config",
      '{"baseUrl":"https://portal.example","baseURL":"https://portal.example"}',
    );
    assert.equal(code, 1);
    assert.match(text(), /champ inconnu/);
  });

  test("declarer deux fois la meme source est refuse", async () => {
    await initWithPlugins();
    await run("source", "add", "example.paginated.portal", "--id", "portal", "--config", '{"baseUrl":"https://portal.example"}');
    lines = [];
    const code = await run("source", "add", "example.paginated.portal", "--id", "portal", "--config", '{"baseUrl":"https://portal.example"}');
    assert.equal(code, 1);
    assert.match(text(), /deja declaree/);
  });

  test("un plugin absent produit un message actionnable", async () => {
    await run("init", "--contact", "ops@example.org");
    lines = [];
    const code = await run("source", "add", "inexistant.plugin", "--id", "x");
    assert.equal(code, 1);
    assert.match(text(), /plugin introuvable : inexistant\.plugin/);
  });
});

describe("lcf status / reindex / verify", () => {
  test("le statut d'un magasin vide est lisible", async () => {
    await run("init", "--contact", "ops@example.org");
    lines = [];
    assert.equal(await run("status"), 0);
    assert.match(text(), /Sources {2}: 0/);
  });

  test("la reindexation d'un magasin vide reussit sans reseau", async () => {
    await run("init", "--contact", "ops@example.org");
    lines = [];
    assert.equal(await run("reindex"), 0);
    assert.match(text(), /aucun acces reseau/);
    assert.match(text(), /objets {5}: 0/);
  });

  test("la verification d'un magasin vide ne signale aucune anomalie", async () => {
    await run("init", "--contact", "ops@example.org");
    lines = [];
    assert.equal(await run("verify"), 0);
    assert.match(text(), /VERDICT : aucune anomalie/);
  });

  test("run sans source nommee explique l'usage", async () => {
    await run("init", "--contact", "ops@example.org");
    lines = [];
    assert.equal(await run("run"), 2);
    assert.match(text(), /usage : lcf run <sourceId>/);
  });

  test("run sur une source inconnue echoue proprement", async () => {
    await run("init", "--contact", "ops@example.org");
    lines = [];
    assert.equal(await run("run", "fantome"), 1);
    assert.match(text(), /source inconnue dans la configuration/);
  });
});
