/**
 * Connecteur SGG — Secrétariat Général du Gouvernement du Bénin.
 *
 * Archétype A (Vol. III, 12.1) : index paginé HTML, page de détail, fichier
 * binaire séparé. Une source LCF par catégorie de documents : chaque catégorie
 * a sa propre cadence, ses propres compteurs et sa propre quarantaine.
 *
 * Structure observée le 30 août 2026, enregistrée dans `test/fixtures/` :
 *
 *   /documentheque/lois/            page 1        (20 entrées)
 *   /documentheque/lois/2/          page 2, ...
 *     <aside class='doc'>
 *       <i class='cat'>loi</i>            catégorie
 *       <i class='num'>2026-14</i>        numéro
 *       <span>Publié le 27.07.2026</span> date de publication
 *       <b class='semibold'>430 Ko</b>    taille annoncée
 *       <a href='/doc/loi-2026-14/' class='doc-title'>Loi N° 2026-14 …</a>
 *       <p class='doc-desc'>portant abrogation …</p>
 *     <a href='…/lois/2/' title="Page suivante">   lien de pagination
 *
 *   /doc/loi-2026-14/download       application/pdf, signature %PDF
 */
import {
  SourceStructureChanged,
  type DiscoveryScope,
  UnresolvableDocument,
  asSourceId,
  type CheckpointState,
  type Describable,
  type DocumentRef,
  type FetchPlan,
  type HealthReport,
  type Incremental,
  type PluginApiVersion,
  type SourceId,
  type SourceMetadata,
} from "@lcf/kernel";
import { PaginatedIndexStrategy } from "@lcf/plugin-toolkit";

/** Catégories exposées par la documenthèque du SGG. */
export const CATEGORIES = [
  "lois",
  "decrets",
  "ordonnances",
  "arretes",
  "accords",
  "decisions",
] as const;

export type Category = (typeof CATEGORIES)[number];

interface SggConfig {
  readonly category: Category;
  readonly baseUrl?: string;
  readonly maxPages?: number;
}

const DEFAULT_BASE_URL = "https://sgg.gouv.bj";

/** Tolerance de la borne incrementale : sept jours. */
const INCREMENTAL_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

// Découpage des entrées : chaque document est un <aside class='doc …'>.
const ENTRY_SPLIT = /<aside class='doc[^']*'>/;
const TITLE_LINK = /href='\/doc\/([^']+?)\/?'\s+class='doc-title/;
const TITLE_TEXT = /class='doc-title[^>]*>([^<]*)</;
const DESCRIPTION = /class='[^']*doc-desc[^']*'[^>]*>([\s\S]*?)<\/p>/;
const NUMBER = /class='num[^']*'>([^<]+)</;
const CATEGORY_LABEL = /class='cat[^']*'>([^<]+)</;
const PUBLISHED = /Publié le\s*([0-9]{2})\.([0-9]{2})\.([0-9]{4})/;
const SIZE = /<b class='semibold'>([0-9]+(?:[.,][0-9]+)?)\s*(Ko|Mo|o)<\/b>/;
const NEXT_PAGE = /<a\s+href="([^"]+)"[^>]*title="Page suivante"/;

/** Marqueur de structure : sa disparition signale une refonte du site. */
const STRUCTURE_MARKER = "doc-title";

export default class SggBeninPlugin
  extends PaginatedIndexStrategy
  implements Describable, Incremental
{
  readonly id: SourceId = asSourceId("bj.sgg");
  readonly apiVersion: PluginApiVersion = "1.0";

  #highWaterMark: string | undefined;

  get #config(): SggConfig {
    return this.ctx.config as unknown as SggConfig;
  }

  get #baseUrl(): string {
    return (this.#config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /**
   * La page 1 n'a pas de suffixe numérique, les suivantes en ont un.
   * `/documentheque/lois/` puis `/documentheque/lois/2/`.
   */
  protected buildPageUrl(page: number): string {
    const root = `${this.#baseUrl}/documentheque/${this.#config.category}/`;
    return page === 0 ? root : `${root}${page + 1}/`;
  }

  /**
   * Transformation pure : HTML vers descripteurs. Aucune requête, aucun effet
   * de bord — testée intégralement sur les fixtures enregistrées.
   */
  protected parsePage(html: string, url: string): DocumentRef[] {
    if (!html.includes(STRUCTURE_MARKER)) {
      // Une refonte du site ne produit aucune erreur HTTP : elle produit zéro
      // résultat. Le dire ici est la seule façon de ne pas croire, des mois
      // durant, que la source n'a plus rien publié.
      if (/1\s*-\s*0\s+sur\s+0|aucun r[ée]sultat/i.test(html)) return [];
      this.structureChanged(`marqueur '${STRUCTURE_MARKER}' absent de ${url}`);
    }

    const refs: DocumentRef[] = [];
    for (const block of html.split(ENTRY_SPLIT).slice(1)) {
      const slug = TITLE_LINK.exec(block)?.[1];
      if (slug === undefined) continue;

      const title = decodeEntities(TITLE_TEXT.exec(block)?.[1] ?? "").trim();
      const publishedAt = parsePublishedDate(block);
      const declaredBytes = parseSize(block);

      refs.push({
        // Le slug de la page de détail est l'identifiant naturel de la source :
        // stable dans le temps, unique sur tout le site, lisible par un humain.
        // Il ne contient ni numéro de page, ni horodatage, ni jeton de session.
        nativeId: slug,
        url: `${this.#baseUrl}/doc/${slug}/`,
        ...(title.length === 0 ? {} : { title }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        ...(declaredBytes === undefined ? {} : { declaredBytes }),
        declaredMime: "application/pdf",
        extra: {
          category: this.#config.category,
          ...(NUMBER.exec(block)?.[1] === undefined
            ? {}
            : { number: (NUMBER.exec(block) as RegExpExecArray)[1] }),
          ...(CATEGORY_LABEL.exec(block)?.[1] === undefined
            ? {}
            : { categoryLabel: (CATEGORY_LABEL.exec(block) as RegExpExecArray)[1] }),
          ...(extractDescription(block) === undefined
            ? {}
            : { description: extractDescription(block) }),
        },
      });
    }
    return refs;
  }

  /**
   * Arret incremental : l'enumeration s'arrete des qu'une page entiere ne
   * contient plus rien de posterieur a la borne, marge comprise. Cette page
   * n'est pas emise — tout y est deja connu.
   *
   * La marge n'est pas de la prudence excessive : l'index du SGG est
   * globalement decroissant mais pas strictement — on y observe des ecarts de
   * quelques jours entre entrees voisines. S'arreter au premier document
   * ancien ferait manquer ses voisins publies le lendemain.
   */
  protected override shouldStopAtPage(
    refs: readonly DocumentRef[],
    scope: DiscoveryScope,
  ): boolean {
    this.#rememberNewest(refs);
    if (scope.mode !== "incremental" || scope.since === undefined) return false;

    const cutoff = new Date(Date.parse(scope.since) - INCREMENTAL_MARGIN_MS)
      .toISOString()
      .slice(0, 10);
    const hasRecent = refs.some((ref) => (ref.publishedAt ?? "") >= cutoff);
    if (hasRecent) return false;

    this.ctx.log.info("collecte incrementale : page entierement anterieure a la borne", {
      since: scope.since,
      cutoff,
    });
    return true;
  }

  /** La borne de reprise est la date de publication la plus recente vue. */
  #rememberNewest(refs: readonly DocumentRef[]): void {
    for (const ref of refs) {
      const published = ref.publishedAt;
      if (published !== undefined && published > (this.#highWaterMark ?? "")) {
        this.#highWaterMark = published;
      }
    }
  }

  /** Le lien « Page suivante » n'a d'`href` que s'il existe une page suivante. */
  protected hasNextPage(html: string): boolean {
    return NEXT_PAGE.test(html);
  }

  async resolve(ref: DocumentRef): Promise<FetchPlan> {
    if (ref.nativeId.length === 0) throw new UnresolvableDocument(this.id, ref.nativeId);
    return {
      kind: "http",
      url: `${this.#baseUrl}/doc/${ref.nativeId}/download`,
      expect: {
        mimeTypes: ["application/pdf"],
        minBytes: 1024,
        magicBytes: "25504446", // %PDF
      },
      follow: { redirects: true, maxHops: 3 },
    };
  }

  /**
   * Provenance obligatoire (Vol. III, 3.3) : pour chaque champ, quel sélecteur
   * sur quelle page. Quand un champ se révélera faux dans dix ans, on saura
   * exactement d'où il venait.
   */
  async describe(ref: DocumentRef): Promise<SourceMetadata> {
    const at = ref.url ?? this.#baseUrl;
    const extra = (ref.extra ?? {}) as Record<string, string | undefined>;
    const raw: Record<string, string | number | boolean | null> = {};
    const provenance: { field: string; locator: string; at: string }[] = [];

    const add = (field: string, value: string | number | undefined, locator: string): void => {
      if (value === undefined || value === "") return;
      raw[field] = value;
      provenance.push({ field, locator, at });
    };

    add("titre", ref.title, "aside.doc a.doc-title");
    add("numero", extra["number"], "aside.doc i.num");
    add("categorie", extra["categoryLabel"], "aside.doc i.cat");
    add("description", extra["description"], "aside.doc p.doc-desc");
    add("publieLe", ref.publishedAt, "aside.doc span:contains('Publié le')");
    add("tailleAnnoncee", ref.declaredBytes, "aside.doc b.semibold");

    return {
      raw,
      common: {
        documentKind: extra["categoryLabel"] ?? this.#config.category,
        ...(extra["number"] === undefined ? {} : { reference: extra["number"] }),
        ...(ref.publishedAt === undefined ? {} : { issuedAt: ref.publishedAt }),
        language: "fr",
        authority: "Secrétariat Général du Gouvernement",
      },
      provenance,
    };
  }

  async checkpoint(): Promise<CheckpointState> {
    return {
      version: 1,
      ...(this.#highWaterMark === undefined ? {} : { highWaterMark: this.#highWaterMark }),
    };
  }

  async restore(state: CheckpointState): Promise<void> {
    this.#highWaterMark = state.highWaterMark;
  }

  /** Diagnostic sans collecte : la source répond-elle, et dans la forme attendue ? */
  async health(): Promise<HealthReport> {
    const checkedAt = this.ctx.clock.now().toISOString();
    try {
      const html = await this.ctx.http.getText(this.buildPageUrl(0));
      const entries = html.split(ENTRY_SPLIT).length - 1;
      if (entries === 0) {
        return { status: "degraded", checkedAt, detail: "index vide ou structure modifiée" };
      }
      return { status: "ok", checkedAt, detail: `${entries} entrées sur la première page` };
    } catch (error) {
      if (error instanceof SourceStructureChanged) {
        return { status: "degraded", checkedAt, detail: error.message };
      }
      return { status: "down", checkedAt, detail: String(error) };
    }
  }
}

// ---------------------------------------------------------------------------
// Extraction — fonctions pures, testées isolément
// ---------------------------------------------------------------------------

/** « Publié le 27.07.2026 » → « 2026-07-27 ». */
export function parsePublishedDate(block: string): string | undefined {
  const match = PUBLISHED.exec(block);
  if (match === null) return undefined;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

/** « 430 Ko » → 440320. Valeur annoncée par la source, jamais tenue pour vraie. */
export function parseSize(block: string): number | undefined {
  const match = SIZE.exec(block);
  if (match === null) return undefined;
  const value = Number((match[1] as string).replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  const unit = match[2] as string;
  const factor = unit === "Mo" ? 1024 * 1024 : unit === "Ko" ? 1024 : 1;
  return Math.round(value * factor);
}

export function extractDescription(block: string): string | undefined {
  const match = DESCRIPTION.exec(block);
  if (match === null) return undefined;
  const text = decodeEntities((match[1] as string).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text.length === 0 ? undefined : text;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#039;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#039);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}
