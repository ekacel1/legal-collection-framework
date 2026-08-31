/**
 * Archetype A — portail d'index pagine (Volume III, 12.1).
 *
 * Ce plugin est un MODELE. Il ne vise aucune institution reelle : le domaine
 * `portal.example` n'existe pas, conformement a la regle absolue du Volume I,
 * chapitre 9 (« le coeur ne contient aucune URL, aucune source »). Il sert de
 * reference d'implementation et de sujet aux tests d'acceptation.
 *
 * Il montre les quatre obligations d'un plugin :
 *   - produire des `nativeId` stables ;
 *   - ne rien telecharger lui-meme (`resolve` retourne un plan) ;
 *   - documenter la provenance de chaque metadonnee ;
 *   - echouer bruyamment quand la structure de la source change.
 */
import {
  SourceStructureChanged,
  UnresolvableDocument,
  asSourceId,
  type Describable,
  type DocumentRef,
  type FetchPlan,
  type Incremental,
  type CheckpointState,
  type SourceMetadata,
  type PluginApiVersion,
  type SourceId,
} from "@lcf/kernel";
import { PaginatedIndexStrategy } from "@lcf/plugin-toolkit";

interface PortalConfig {
  readonly baseUrl: string;
  readonly startYear?: number;
  readonly categories?: readonly string[];
}

/** Une entree de l'index, telle que la page la presente. */
const ENTRY = /<article class="doc-entry"[^>]*>([\s\S]*?)<\/article>/g;
const HREF = /<a[^>]+href="([^"]+)"/;
const TITLE = /<h3[^>]*>([\s\S]*?)<\/h3>/;
const TIME = /<time[^>]+datetime="([^"]+)"/;
const NEXT_PAGE = /rel="next"/;

export default class PaginatedPortalPlugin
  extends PaginatedIndexStrategy
  implements Describable, Incremental
{
  readonly id: SourceId = asSourceId("example.paginated.portal");
  readonly apiVersion: PluginApiVersion = "1.0";

  #highWaterMark: string | undefined;

  get #config(): PortalConfig {
    return this.ctx.config as unknown as PortalConfig;
  }

  protected buildPageUrl(page: number): string {
    return `${this.#config.baseUrl}/documents?page=${page}`;
  }

  /**
   * Transformation pure : octets d'une page vers descripteurs. Aucune requete,
   * aucun effet de bord, donc entierement testable sur fixtures.
   */
  protected parsePage(html: string, url: string): DocumentRef[] {
    if (!html.includes("doc-entry") && !html.includes("no-results")) {
      // La page ne ressemble plus a ce qui etait attendu : le dire, plutot que
      // de rendre une liste vide qui se lirait « la source n'a rien publie ».
      this.structureChanged(`aucun marqueur doc-entry sur ${url}`);
    }

    const refs: DocumentRef[] = [];
    for (const match of html.matchAll(ENTRY)) {
      const block = match[1] ?? "";
      const href = HREF.exec(block)?.[1];
      if (href === undefined) continue;

      const title = TITLE.exec(block)?.[1]?.replace(/<[^>]+>/g, "").trim();
      const publishedAt = TIME.exec(block)?.[1];

      refs.push({
        // Le nativeId derive du chemin structurel, jamais du numero de page ni
        // d'un parametre de session : il doit survivre a un changement d'URL.
        nativeId: stableId(href),
        url: absolute(href, url),
        ...(title === undefined ? {} : { title }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        declaredMime: "application/pdf",
      });
    }
    return refs;
  }

  protected hasNextPage(html: string): boolean {
    return NEXT_PAGE.test(html);
  }

  async resolve(ref: DocumentRef): Promise<FetchPlan> {
    if (ref.url === undefined) throw new UnresolvableDocument(this.id, ref.nativeId);
    return {
      kind: "http",
      url: `${ref.url}.pdf`,
      expect: {
        mimeTypes: ["application/pdf"],
        minBytes: 8,
        magicBytes: "25504446",
      },
    };
  }

  /** Provenance obligatoire : quel selecteur, sur quelle page. */
  async describe(ref: DocumentRef): Promise<SourceMetadata> {
    const at = ref.url ?? this.#config.baseUrl;
    const provenance: { field: string; locator: string; at: string }[] = [];
    const raw: Record<string, string | number | boolean | null> = {};

    if (ref.title !== undefined) {
      raw["titre"] = ref.title;
      provenance.push({ field: "titre", locator: "article.doc-entry h3", at });
    }
    if (ref.publishedAt !== undefined) {
      raw["date"] = ref.publishedAt;
      provenance.push({ field: "date", locator: "article.doc-entry time[datetime]", at });
    }

    return {
      raw,
      common: {
        ...(ref.publishedAt === undefined ? {} : { issuedAt: ref.publishedAt }),
        reference: ref.nativeId,
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

  /** Verifie que la source repond, sans rien collecter. */
  async health(): Promise<{ status: "ok" | "degraded" | "down"; checkedAt: string }> {
    try {
      await this.ctx.http.getText(`${this.#config.baseUrl}/documents?page=0`);
      return { status: "ok", checkedAt: this.ctx.clock.now().toISOString() };
    } catch (error) {
      if (error instanceof SourceStructureChanged) {
        return { status: "degraded", checkedAt: this.ctx.clock.now().toISOString() };
      }
      return { status: "down", checkedAt: this.ctx.clock.now().toISOString() };
    }
  }
}

/**
 * Identifiant stable derive du chemin : ni page, ni horodatage, ni index de
 * boucle, ni jeton de session — les quatre formes que le kit de conformite
 * refuse (Volume III, 13.5).
 */
function stableId(href: string): string {
  const path = href.split("?")[0] ?? href;
  return path.replace(/^.*\/documents\//, "").replace(/^\/+|\/+$/g, "");
}

function absolute(href: string, pageUrl: string): string {
  return new URL(href, pageUrl).toString();
}
