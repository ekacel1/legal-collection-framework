import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  isApiVersionSupported,
  parseManifest,
  validateManifest,
  type PluginManifest,
} from "../src/plugins/manifest.js";
import { effectiveCapabilities } from "../src/plugins/capabilities.js";
import { PluginManager } from "../src/plugins/plugin-manager.js";
import { FixtureHttpTransport } from "../src/net/testing.js";
import { buildUserAgent } from "../src/net/scoped-http-client.js";
import { ManualClock, SystemClock } from "../src/domain/clock.js";
import { ConfigurationInvalid, PluginRejected } from "../src/domain/errors.js";
import { tempDir } from "./helpers.js";

const VALID_MANIFEST: PluginManifest = {
  manifestVersion: 1,
  id: "example.portal",
  name: "Example Portal",
  version: "1.2.3",
  apiVersion: "^1.0",
  entry: "./index.js",
  capabilities: {
    network: {
      allowedHosts: ["portal.example"],
      maxRequestsPerMinute: 30,
      politenessDelayMs: 1200,
      respectRobotsTxt: true,
    },
  },
  configSchema: {
    type: "object",
    properties: { baseUrl: { type: "string" }, annee: { type: "integer", minimum: 1900 } },
    required: ["baseUrl"],
    additionalProperties: false,
  },
  integrity: { maxDocumentBytes: 1024 * 1024 },
};

const PLUGIN_SOURCE = `
export default class Plugin {
  id = "example.portal";
  apiVersion = "1.0";
  async init(ctx) { this.ctx = ctx; }
  async *discover() { yield { nativeId: "a" }; }
  async resolve(ref) { return { kind: "http", url: "https://portal.example/a.pdf" }; }
  async dispose() { globalThis.__lcfDisposed = true; }
}
`;

let workspace: string;

beforeEach(async () => {
  workspace = await tempDir("plugins");
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

async function writePlugin(
  name: string,
  overrides: Partial<PluginManifest> = {},
  source = PLUGIN_SOURCE,
): Promise<string> {
  const dir = path.join(workspace, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "lcf-plugin.json"),
    JSON.stringify({ ...VALID_MANIFEST, ...overrides }),
  );
  await fsp.writeFile(path.join(dir, "index.js"), source);
  return dir;
}

function manager(): PluginManager {
  return new PluginManager({
    clock: new ManualClock(1_700_000_000_000),
    transport: new FixtureHttpTransport({}),
    userAgent: buildUserAgent("tests@example.org"),
    initTimeoutMs: 200,
  });
}

describe("validation du manifeste (Vol. III, ch. 4)", () => {
  test("un manifeste conforme ne produit aucun probleme", () => {
    assert.deepEqual(validateManifest(VALID_MANIFEST), []);
  });

  test("une liste d'hotes vide est refusee : elle autoriserait tout", () => {
    const problems = validateManifest({
      ...VALID_MANIFEST,
      capabilities: { network: { allowedHosts: [] } },
    });
    assert.ok(problems.some((problem) => /allowedHosts/.test(problem)));
  });

  test("additionalProperties: false est exige", () => {
    const problems = validateManifest({
      ...VALID_MANIFEST,
      configSchema: { type: "object", properties: {} },
    });
    assert.ok(problems.some((problem) => /additionalProperties/.test(problem)));
  });

  test("un chemin d'entree qui sort du paquet est refuse", () => {
    for (const entry of ["../ailleurs.js", "/etc/passwd", "C:\\ailleurs.js"]) {
      const problems = validateManifest({ ...VALID_MANIFEST, entry });
      assert.ok(problems.some((problem) => /entry/.test(problem)), entry);
    }
  });

  test("une version non SemVer est refusee", () => {
    assert.ok(
      validateManifest({ ...VALID_MANIFEST, version: "1.2" }).some((p) => /SemVer/.test(p)),
    );
  });

  test("un secret porteur de valeur est refuse", () => {
    const problems = validateManifest({
      ...VALID_MANIFEST,
      secrets: [{ name: "API_TOKEN", value: "s3cr3t" } as never],
    });
    assert.ok(problems.some((problem) => /ne porte jamais de valeur/.test(problem)));
  });

  test("un mot-clef de schema non supporte est signale, jamais ignore", () => {
    const problems = validateManifest({
      ...VALID_MANIFEST,
      configSchema: {
        type: "object",
        properties: { x: { type: "string", format: "uri" } as never },
        additionalProperties: false,
      },
    });
    assert.ok(problems.some((problem) => /non supporte/.test(problem)));
  });

  test("un manifeste illisible est rejete sans evaluer de code", () => {
    assert.throws(() => parseManifest("{ pas du json", "paquet"), PluginRejected);
  });
});

describe("compatibilite d'apiVersion (Vol. III, 9.4)", () => {
  test("une plage majeure identique est acceptee", () => {
    assert.equal(isApiVersionSupported("^1.0", "1.0"), true);
    assert.equal(isApiVersionSupported("1.0", "1.0"), true);
  });

  test("une majeure differente est refusee", () => {
    assert.equal(isApiVersionSupported("^2.0", "1.0"), false);
  });

  test("une mineure posterieure au Kernel est refusee", () => {
    assert.equal(isApiVersionSupported("^1.4", "1.0"), false);
  });
});

describe("capacites effectives (Vol. III, ch. 5)", () => {
  test("les hotes accordes sont l'intersection des deux listes", () => {
    const capabilities = effectiveCapabilities(
      { network: { allowedHosts: ["a.example", "b.example"] } },
      { network: { allowedHosts: ["b.example", "c.example"] } },
    );
    assert.deepEqual(capabilities.network.allowedHosts, ["b.example"]);
  });

  test("la valeur la plus prudente l'emporte sur les quotas", () => {
    const capabilities = effectiveCapabilities(
      {
        network: {
          allowedHosts: ["a.example"],
          maxRequestsPerMinute: 60,
          politenessDelayMs: 500,
        },
      },
      { network: { maxRequestsPerMinute: 10, politenessDelayMs: 2000 } },
    );
    assert.equal(capabilities.network.maxRequestsPerMinute, 10);
    assert.equal(capabilities.network.politenessDelayMs, 2000);
  });

  test("desactiver robots.txt exige l'accord des deux cotes", () => {
    const base = { allowedHosts: ["a.example"] };
    assert.equal(
      effectiveCapabilities({ network: { ...base, respectRobotsTxt: false } }, {}).network
        .respectRobotsTxt,
      true,
    );
    assert.equal(
      effectiveCapabilities(
        { network: { ...base, respectRobotsTxt: false } },
        { network: { respectRobotsTxt: false } },
      ).network.respectRobotsTxt,
      false,
    );
  });

  test("une capacite non demandee ne peut pas etre accordee", () => {
    const capabilities = effectiveCapabilities(
      { network: { allowedHosts: ["a.example"] }, browser: false },
      { browser: true, inlineContent: true },
    );
    assert.equal(capabilities.browser, false);
    assert.equal(capabilities.inlineContent, false);
  });

  test("un secret non accorde n'est pas expose", () => {
    const capabilities = effectiveCapabilities(
      { network: { allowedHosts: ["a.example"] } },
      { secrets: ["AUTRE"] },
      ["API_TOKEN", "AUTRE"],
    );
    assert.deepEqual(capabilities.secrets, ["AUTRE"]);
  });
});

describe("chargement des plugins (Vol. III, ch. 10)", () => {
  test("un plugin conforme est decouvert puis charge", async () => {
    await writePlugin("portal");
    const pluginManager = manager();
    const discovered = await pluginManager.discover([workspace]);
    assert.equal(discovered.length, 1);

    const loaded = await pluginManager.load(discovered[0]!, {
      config: { baseUrl: "https://portal.example" },
    });
    assert.equal(loaded.state, "ready");
    assert.equal(loaded.sourceId, "example.portal");
    assert.deepEqual(loaded.capabilities.network.allowedHosts, ["portal.example"]);
    await pluginManager.disposeAll();
  });

  test("deux plugins de meme identifiant sont rejetes tous les deux", async () => {
    await writePlugin("un");
    await writePlugin("deux");
    await assert.rejects(manager().discover([workspace]), /identifiant en conflit/);
  });

  test("un repertoire sans manifeste est ignore sans bruit", async () => {
    await fsp.mkdir(path.join(workspace, "vide"), { recursive: true });
    await writePlugin("portal");
    assert.equal((await manager().discover([workspace])).length, 1);
  });

  test("une apiVersion incompatible produit un message actionnable", async () => {
    await writePlugin("ancien", { apiVersion: "^2.0" });
    await assert.rejects(manager().discover([workspace]), /migrer selon docs\/migration/);
  });

  test("une methode obligatoire absente fait rejeter le plugin", async () => {
    await writePlugin(
      "incomplet",
      {},
      `export default class Plugin {
         id = "example.portal";
         apiVersion = "1.0";
         async init() {}
         async *discover() {}
       }`,
    );
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    await assert.rejects(
      pluginManager.load(discovered!, { config: { baseUrl: "https://portal.example" } }),
      /methode obligatoire absente : resolve/,
    );
  });

  test("une configuration invalide est refusee avant tout appel reseau", async () => {
    await writePlugin("portal");
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    await assert.rejects(
      pluginManager.load(discovered!, { config: { annee: 1800 } }),
      ConfigurationInvalid,
    );
  });

  test("un init() interminable est interrompu par le delai plafond", async () => {
    await writePlugin(
      "lent",
      {},
      `export default class Plugin {
         id = "example.portal";
         apiVersion = "1.0";
         async init() { await new Promise(() => {}); }
         async *discover() {}
         async resolve() { return { kind: "http", url: "https://portal.example/a" }; }
         async dispose() {}
       }`,
    );
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    await assert.rejects(
      pluginManager.load(discovered!, { config: { baseUrl: "https://portal.example" } }),
      /init\(\) depasse/,
    );
  });

  test("un secret non accorde leve plutot que de rendre undefined", async () => {
    await writePlugin("portal", { secrets: [{ name: "API_TOKEN" }] });
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    const loaded = await pluginManager.load(discovered!, {
      config: { baseUrl: "https://portal.example" },
      secrets: { API_TOKEN: "valeur" },
    });

    await assert.rejects(loaded.context.secrets.get("API_TOKEN"), /secret non accorde/);
    assert.equal(loaded.context.secrets.has("API_TOKEN"), false);
    await pluginManager.disposeAll();
  });

  test("un secret obligatoire absent empeche le chargement", async () => {
    await writePlugin("portal", { secrets: [{ name: "API_TOKEN", required: true }] });
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    await assert.rejects(
      pluginManager.load(discovered!, { config: { baseUrl: "https://portal.example" } }),
      /secret obligatoire absent/,
    );
  });

  test("la quarantaine suspend, la reactivation reste manuelle", async () => {
    await writePlugin("portal");
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    const loaded = await pluginManager.load(discovered!, {
      config: { baseUrl: "https://portal.example" },
    });

    pluginManager.quarantine(loaded.sourceId, "SourceStructureChanged");
    assert.equal(pluginManager.get(loaded.sourceId)?.state, "quarantined");
    assert.equal(pluginManager.get(loaded.sourceId)?.quarantineReason, "SourceStructureChanged");

    pluginManager.reactivate(loaded.sourceId);
    assert.equal(pluginManager.get(loaded.sourceId)?.state, "ready");
    await pluginManager.disposeAll();
  });

  test("dispose() est toujours appele a l'arret", async () => {
    await writePlugin("portal");
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    const loaded = await pluginManager.load(discovered!, {
      config: { baseUrl: "https://portal.example" },
    });

    (globalThis as { __lcfDisposed?: boolean }).__lcfDisposed = false;
    await pluginManager.dispose(loaded.sourceId);
    assert.equal((globalThis as { __lcfDisposed?: boolean }).__lcfDisposed, true);
    assert.equal(pluginManager.get(loaded.sourceId), undefined);
  });

  test("charger deux fois la meme source est refuse", async () => {
    await writePlugin("portal");
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    await pluginManager.load(discovered!, { config: { baseUrl: "https://portal.example" } });
    await assert.rejects(
      pluginManager.load(discovered!, { config: { baseUrl: "https://portal.example" } }),
      /deja chargee/,
    );
    await pluginManager.disposeAll();
  });

  test("une intersection d'hotes vide empeche le chargement", async () => {
    await writePlugin("portal");
    const pluginManager = manager();
    const [discovered] = await pluginManager.discover([workspace]);
    await assert.rejects(
      pluginManager.load(discovered!, {
        config: { baseUrl: "https://portal.example" },
        grant: { network: { allowedHosts: ["autre.example"] } },
      }),
      /aucun hote autorise/,
    );
  });
});

describe("horloge systeme", () => {
  test("l'attente reelle se termine et respecte l'annulation", async () => {
    const clock = new SystemClock();
    const before = clock.nowMillis();
    await clock.sleep(5);
    assert.ok(clock.nowMillis() >= before);
    assert.ok(clock.now() instanceof Date);

    const controller = new AbortController();
    const waiting = clock.sleep(5000, controller.signal);
    controller.abort(new Error("arret"));
    await assert.rejects(waiting, /arret/);

    await clock.sleep(0);
  });
});
