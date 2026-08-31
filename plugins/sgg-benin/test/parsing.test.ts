/**
 * Tests du connecteur SGG sur fixtures enregistrées — Volume VIII, ch. 3.
 *
 * Aucun accès réseau : tout est rejoué depuis `test/fixtures/`. C'est ce qui
 * rend ces tests exécutables dans cinq ans, quand le site aura changé — et ce
 * qui fera apparaître le changement comme un échec de test plutôt que comme un
 * corpus qui cesse silencieusement de grandir.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestContext, collect } from "@lcf/plugin-testkit";
import type { DocumentRef } from "@lcf/kernel";

import SggBeninPlugin, {
  CATEGORIES,
  decodeEntities,
  extractDescription,
  parsePublishedDate,
  parseSize,
} from "../src/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const BASE = "https://sgg.gouv.bj";

let page1 = "";
let page2 = "";

before(async () => {
  page1 = await fsp.readFile(path.join(FIXTURES, "lois-page-1.html"), "utf8");
  page2 = await fsp.readFile(path.join(FIXTURES, "lois-page-2.html"), "utf8");
});

async function pluginWith(html: Record<string, string>): Promise<{
  plugin: SggBeninPlugin;
  refs: () => Promise<DocumentRef[]>;
}> {
  const fixtures = Object.fromEntries(
    Object.entries(html).map(([url, body]) => [url, { body, headers: { "content-type": "text/html" } }]),
  );
  const { ctx } = createTestContext({
    sourceId: "bj.sgg",
    config: { category: "lois", baseUrl: BASE },
    allowedHosts: ["sgg.gouv.bj"],
    fixtures,
  });
  const plugin = new SggBeninPlugin();
  await plugin.init(ctx);
  return {
    plugin,
    refs: async () =>
      collect(
        plugin.discover({
          mode: "full",
          budget: { maxRequests: 100, maxBytes: 10_000_000, maxDurationMs: 60_000 },
        }),
      ),
  };
}

describe("extraction de la page d'index (structure réelle du 30/08/2026)", () => {
  test("les vingt entrées de la première page sont extraites", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: "<html><body>1 - 0 sur 0</body></html>",
    });
    const found = await refs();
    assert.equal(found.length, 20);
  });

  test("le premier document porte ses champs attendus", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: "<html><body>1 - 0 sur 0</body></html>",
    });
    const first = (await refs())[0];

    assert.equal(first?.nativeId, "loi-2026-14");
    assert.equal(first?.url, `${BASE}/doc/loi-2026-14/`);
    assert.equal(first?.title, "Loi N° 2026-14 du 14 juil. 2026");
    assert.equal(first?.publishedAt, "2026-07-27");
    assert.equal(first?.declaredMime, "application/pdf");
    assert.ok((first?.declaredBytes ?? 0) > 400_000);

    const extra = first?.extra as Record<string, string>;
    assert.equal(extra["number"], "2026-14");
    assert.equal(extra["categoryLabel"], "loi");
    assert.match(String(extra["description"]), /code électoral/);
  });

  test("les accents de la source sont préservés", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: "<html><body>1 - 0 sur 0</body></html>",
    });
    const titles = (await refs()).map((ref) => ref.title ?? "");
    assert.ok(
      titles.some((title) => /[éèàôûç°]/.test(title)),
      "au moins un titre doit contenir un caractère accentué correctement décodé",
    );
    assert.ok(
      !titles.some((title) => title.includes("�") || title.includes("Ã©")),
      "aucun titre ne doit porter de trace de mauvais décodage",
    );
  });

  test("la pagination est suivie puis s'arrête", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: page2,
      // Page 3 sans lien « Page suivante » : l'énumération doit s'arrêter là.
      [`${BASE}/documentheque/lois/3/`]: page2.replace(
        /<a\s+href="[^"]+"[^>]*title="Page suivante"[\s\S]*?<\/a>/,
        "",
      ),
    });
    const found = await refs();
    // 20 + 20 entrees, mais `loi-2025-07` figure en fin de page 1 ET en tete de
    // page 2 : la pagination du SGG se recouvre d'une entree. La garde
    // anti-doublon du squelette l'absorbe, et le corpus compte 39 documents.
    assert.equal(found.length, 39);
  });

  test("le recouvrement de pagination du SGG ne produit pas de doublon", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: page2,
      [`${BASE}/documentheque/lois/3/`]: "<html><body>1 - 0 sur 0</body></html>",
    });
    const ids = (await refs()).map((ref) => ref.nativeId);

    // Constat du 30/08/2026 : la derniere entree de la page 1 est aussi la
    // premiere de la page 2. Un collecteur naif la telechargerait deux fois.
    assert.equal(ids.filter((id) => id === "loi-2025-07").length, 1);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("aucun doublon d'identifiant à travers les pages", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: page2,
      [`${BASE}/documentheque/lois/3/`]: page2.replace(
        /<a\s+href="[^"]+"[^>]*title="Page suivante"[\s\S]*?<\/a>/,
        "",
      ),
    });
    const ids = (await refs()).map((ref) => ref.nativeId);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("la découverte est déterministe : deux passages, même résultat", async () => {
    const html = {
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: "<html><body>1 - 0 sur 0</body></html>",
    };
    const a = await (await pluginWith(html)).refs();
    const b = await (await pluginWith(html)).refs();
    assert.deepEqual(
      a.map((ref) => ref.nativeId),
      b.map((ref) => ref.nativeId),
    );
  });
});

describe("collecte incrémentale (Vol. III, 7.3)", () => {
  async function discoverSince(since: string | undefined): Promise<DocumentRef[]> {
    const { ctx } = createTestContext({
      sourceId: "bj.sgg",
      config: { category: "lois", baseUrl: BASE },
      allowedHosts: ["sgg.gouv.bj"],
      fixtures: {
        [`${BASE}/documentheque/lois/`]: { body: page1 },
        [`${BASE}/documentheque/lois/2/`]: { body: page2 },
        [`${BASE}/documentheque/lois/3/`]: { body: "<html><body>1 - 0 sur 0</body></html>" },
      },
    });
    const plugin = new SggBeninPlugin();
    await plugin.init(ctx);
    return collect(
      plugin.discover({
        mode: "incremental",
        budget: { maxRequests: 100, maxBytes: 10_000_000, maxDurationMs: 60_000 },
        ...(since === undefined ? {} : { since }),
      }),
    );
  }

  test("une borne recente arrete la remontee des la premiere page", async () => {
    // La page 1 contient des documents publies jusqu'au 27.07.2026 ; la page 2
    // s'arrete en avril 2025. Une borne au 01.07.2026 rend la page 2 inutile.
    const refs = await discoverSince("2026-07-01");
    assert.equal(refs.length, 20);
  });

  test("une borne ancienne fait remonter l'index entier", async () => {
    const refs = await discoverSince("2020-01-01");
    assert.equal(refs.length, 39);
  });

  test("sans borne, le mode incremental ne coupe rien", async () => {
    const refs = await discoverSince(undefined);
    assert.equal(refs.length, 39);
  });

  test("la marge de sept jours protege des index mal tries", async () => {
    // Le SGG n'est pas strictement trie : la page 1 melange le 13 et le 17
    // fevrier 2026. Une borne posee entre les deux ne doit pas couper la page.
    const refs = await discoverSince("2026-02-16");
    assert.equal(refs.length, 20, "la page 1 reste entierement collectee");
  });

  test("la borne de reprise retenue est la publication la plus recente vue", async () => {
    const { ctx } = createTestContext({
      sourceId: "bj.sgg",
      config: { category: "lois", baseUrl: BASE },
      allowedHosts: ["sgg.gouv.bj"],
      fixtures: {
        [`${BASE}/documentheque/lois/`]: { body: page1 },
        [`${BASE}/documentheque/lois/2/`]: { body: "<html><body>1 - 0 sur 0</body></html>" },
      },
    });
    const plugin = new SggBeninPlugin();
    await plugin.init(ctx);
    await collect(
      plugin.discover({
        mode: "full",
        budget: { maxRequests: 100, maxBytes: 10_000_000, maxDurationMs: 60_000 },
      }),
    );

    const state = await plugin.checkpoint();
    assert.equal(state.version, 1);
    assert.equal(state.highWaterMark, "2026-07-27");
  });

  test("l'etat restaure est bien celui qui sera rendu ensuite", async () => {
    const { ctx } = createTestContext({
      sourceId: "bj.sgg",
      config: { category: "lois", baseUrl: BASE },
      allowedHosts: ["sgg.gouv.bj"],
    });
    const plugin = new SggBeninPlugin();
    await plugin.init(ctx);
    await plugin.restore({ version: 1, highWaterMark: "2026-05-05" });
    assert.equal((await plugin.checkpoint()).highWaterMark, "2026-05-05");
  });
});

describe("stabilité des nativeId (Vol. III, 13.5)", () => {
  const FORBIDDEN = [
    { rule: /page[=_-]?\d+/i, label: "numéro de page" },
    { rule: /\d{13}/, label: "horodatage epoch" },
    { rule: /session|token|jsessionid/i, label: "jeton de session" },
    { rule: /^\d+$/, label: "index de boucle nu" },
  ];

  test("aucun identifiant ne contient de forme instable", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: page2,
      [`${BASE}/documentheque/lois/3/`]: "<html><body>1 - 0 sur 0</body></html>",
    });
    for (const ref of await refs()) {
      for (const { rule, label } of FORBIDDEN) {
        assert.ok(!rule.test(ref.nativeId), `${ref.nativeId} contient : ${label}`);
      }
    }
  });

  test("l'identifiant est le slug de la page de détail, lisible et durable", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: "<html><body>1 - 0 sur 0</body></html>",
    });
    for (const ref of await refs()) {
      assert.match(ref.nativeId, /^[a-z]+-\d{4}-[\w-]+$/i, ref.nativeId);
    }
  });
});

describe("plan de récupération", () => {
  test("resolve pointe vers le téléchargement et exige la signature PDF", async () => {
    const { plugin } = await pluginWith({});
    const plan = await plugin.resolve({ nativeId: "loi-2026-14" });

    assert.equal(plan.kind, "http");
    if (plan.kind !== "http") return;
    assert.equal(plan.url, `${BASE}/doc/loi-2026-14/download`);
    assert.equal(plan.expect?.magicBytes, "25504446");
    assert.deepEqual(plan.expect?.mimeTypes, ["application/pdf"]);
  });

  test("le plan correspond au fichier réellement servi par la source", async () => {
    const pdf = await fsp.readFile(path.join(FIXTURES, "loi-2026-14.pdf"));
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(pdf.length > 1024);
  });
});

describe("métadonnées et provenance", () => {
  test("chaque champ extrait déclare son sélecteur d'origine", async () => {
    const { plugin, refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: page1,
      [`${BASE}/documentheque/lois/2/`]: "<html><body>1 - 0 sur 0</body></html>",
    });
    const metadata = await plugin.describe((await refs())[0] as DocumentRef);

    assert.equal(metadata.common?.authority, "Secrétariat Général du Gouvernement");
    assert.equal(metadata.common?.language, "fr");
    assert.equal(metadata.common?.reference, "2026-14");

    const fields = metadata.provenance.map((entry) => entry.field);
    for (const expected of ["titre", "numero", "categorie", "publieLe"]) {
      assert.ok(fields.includes(expected), `provenance manquante : ${expected}`);
    }
    for (const entry of metadata.provenance) {
      assert.ok(entry.locator.length > 0);
      assert.match(entry.at, /^https:\/\/sgg\.gouv\.bj\/doc\//);
    }
  });
});

describe("erreur honnête sur changement de structure", () => {
  test("une page sans le marqueur attendu lève au lieu de rendre une liste vide", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: "<html><body><main>Site en refonte</main></body></html>",
    });
    await assert.rejects(refs(), /structure de source modifiee/);
  });

  test("une page vide légitime est distinguée d'une refonte", async () => {
    const { refs } = await pluginWith({
      [`${BASE}/documentheque/lois/`]: "<html><body><p>1 - 0 sur 0</p></body></html>",
    });
    assert.deepEqual(await refs(), []);
  });
});

describe("fonctions d'extraction", () => {
  test("la date de publication est convertie en ISO", () => {
    assert.equal(parsePublishedDate("Publié le 27.07.2026"), "2026-07-27");
    assert.equal(parsePublishedDate("aucune date"), undefined);
  });

  test("la taille annoncée est convertie en octets", () => {
    assert.equal(parseSize("<b class='semibold'>430 Ko</b>"), 440_320);
    assert.equal(parseSize("<b class='semibold'>1,5 Mo</b>"), 1_572_864);
    assert.equal(parseSize("aucune taille"), undefined);
  });

  test("les entités HTML sont décodées", () => {
    assert.equal(decodeEntities("l&#039;acte &amp; le d&eacute;cret"), "l'acte & le d&eacute;cret");
    assert.equal(decodeEntities("a &lt; b"), "a < b");
  });

  test("la description est nettoyée de son balisage", () => {
    const block = "<p class='doc-desc '>portant <b>abrogation</b>  des dispositions</p>";
    assert.equal(extractDescription(block), "portant abrogation des dispositions");
  });

  test("les six catégories de la documenthèque sont déclarées", () => {
    assert.deepEqual(
      [...CATEGORIES],
      ["lois", "decrets", "ordonnances", "arretes", "accords", "decisions"],
    );
  });
});
