/**
 * Squelette d'index pagine — Volume III, chapitre 7.2.
 *
 * Trois gardes sont integrees au squelette plutot que laissees au
 * contributeur : la deduplication intra-execution, la detection de page
 * repetee, et l'arret sur pages vides consecutives. Ce sont les trois causes
 * classiques de collecte infinie, et aucune n'est evidente a l'ecriture.
 */
import {
  SourceStructureChanged,
  type DiscoveryScope,
  type DocumentRef,
  type PluginContext,
  type SourcePlugin,
  type SourceId,
  type PluginApiVersion,
} from "@lcf/kernel";

export interface PaginatedIndexOptions {
  /** Plafond dur de pages, garde de derniere instance. */
  readonly maxPages?: number;
  /** Pages vides consecutives tolerees avant arret. */
  readonly emptyStreakLimit?: number;
}

export abstract class PaginatedIndexStrategy implements SourcePlugin {
  abstract readonly id: SourceId;
  abstract readonly apiVersion: PluginApiVersion;

  protected ctx!: PluginContext;
  readonly #maxPages: number;
  readonly #emptyStreakLimit: number;
  /**
   * Page a laquelle reprendre, quand le balayage precedent a ete tronque.
   *
   * Sans cette reprise, un balayage interrompu par le budget repartirait de la
   * premiere page a chaque execution : sur une source de trente mille
   * documents, la collecte ne depasserait jamais ce qu'une seule nuit permet.
   */
  #resumeFromPage = 0;
  /**
   * Un parcours est-il en cours, sans etre alle a son terme ?
   *
   * Distinct du numero de page : une interruption sur la page 0 doit se dire,
   * sinon « interrompu tout de suite » et « acheve » se ressemblent, et le
   * checkpoint ment sur ce qui s'est passe.
   */
  #sweepInProgress = false;

  constructor(options: PaginatedIndexOptions = {}) {
    this.#maxPages = options.maxPages ?? 1000;
    this.#emptyStreakLimit = options.emptyStreakLimit ?? 2;
  }

  /** URL de la page `page`, indexee a partir de zero. */
  protected abstract buildPageUrl(page: number): string;

  /** Extrait les descripteurs d'une page. Transformation pure et testable. */
  protected abstract parsePage(html: string, url: string): DocumentRef[];

  /** Existe-t-il une page suivante ? */
  protected abstract hasNextPage(html: string, page: number): boolean;

  /**
   * Cette page marque-t-elle la fin utile de l'enumeration ?
   *
   * Appelee AVANT toute emission : quand elle repond oui, les descripteurs de
   * la page sont abandonnes et l'enumeration s'arrete. Les emettre reviendrait
   * a faire recomparer au Kernel des documents dont on vient d'etablir qu'ils
   * sont anterieurs a la borne — c'est-a-dire a payer le cout que le mode
   * incremental existe pour eviter.
   *
   * La decision porte sur une PAGE COMPLETE, jamais sur une entree isolee : un
   * index trie « par date » l'est rarement strictement, et s'arreter au premier
   * document ancien fait manquer ses voisins. Le balayage complet periodique
   * impose par le Kernel reste le filet de securite de cette optimisation.
   */
  protected shouldStopAtPage(
    _refs: readonly DocumentRef[],
    _scope: DiscoveryScope,
    _page: number,
  ): boolean {
    return false;
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
  }

  /**
   * Curseur de pagination a conserver dans le checkpoint.
   * `undefined` quand le dernier balayage est alle a son terme : il n'y a alors
   * rien a reprendre, et repartir du debut est le comportement voulu.
   */
  protected get paginationCursor(): string | undefined {
    return this.#sweepInProgress ? `page:${this.#resumeFromPage}` : undefined;
  }

  /** Restitue un curseur rendu par `paginationCursor`. */
  protected restorePagination(cursor: string | undefined): void {
    const match = /^page:(\d+)$/.exec(cursor ?? "");
    this.#resumeFromPage = match === null ? 0 : Number(match[1]);
    this.#sweepInProgress = match !== null;
  }

  async *discover(scope: DiscoveryScope): AsyncIterable<DocumentRef> {
    const seen = new Set<string>();
    let page = this.#resumeFromPage;
    let emptyStreak = 0;
    let previousSignature = "";
    let emitted = 0;

    while (page < this.#maxPages) {
      if (this.ctx.signal.aborted) return;

      // La page en cours est memorisee AVANT d'etre traitee : si l'execution
      // est interrompue en plein milieu, la reprise la refera entierement
      // plutot que de risquer d'en sauter la moitie.
      this.#resumeFromPage = page;
      this.#sweepInProgress = true;

      const url = this.buildPageUrl(page);
      const html = await this.ctx.http.getText(url);
      const refs = this.parsePage(html, url);

      if (refs.length === 0) {
        emptyStreak++;
        if (emptyStreak >= this.#emptyStreakLimit) return this.#sweepCompleted();
      } else {
        emptyStreak = 0;
      }

      // Garde anti-boucle : deux pages identiques d'affilee signalent une
      // pagination qui ne pagine plus.
      const signature = refs.map((ref) => ref.nativeId).join("");
      if (refs.length > 0 && signature === previousSignature) return;
      previousSignature = signature;

      if (this.shouldStopAtPage(refs, scope, page)) return this.#sweepCompleted();

      let novel = 0;
      for (const ref of refs) {
        if (seen.has(ref.nativeId)) continue; // garde anti-doublon
        seen.add(ref.nativeId);
        novel++;
        emitted++;
        yield ref;
        if (scope.maxDocuments !== undefined && emitted >= scope.maxDocuments) return;
      }

      if (novel === 0 && refs.length > 0) return this.#sweepCompleted();
      if (!this.hasNextPage(html, page)) return this.#sweepCompleted();
      page++;
    }
    // Plafond de pages atteint : ce n'est pas un parcours acheve.
  }

  /**
   * Le parcours est alle a son terme : plus rien a reprendre.
   * Laisser le curseur en place ferait repartir la collecte suivante au milieu
   * de l'index, et les nouveautes du debut ne seraient jamais revues.
   */
  #sweepCompleted(): void {
    this.#resumeFromPage = 0;
    this.#sweepInProgress = false;
  }

  abstract resolve(ref: DocumentRef): Promise<import("@lcf/kernel").FetchPlan>;

  async dispose(): Promise<void> {}

  /**
   * Signale une page dont la structure ne correspond plus a ce qu'attend le
   * plugin. A preferer systematiquement au retour d'un tableau vide : une page
   * vide se lit « la source n'a rien publie », ce qui est un mensonge.
   */
  protected structureChanged(detail: string): never {
    throw new SourceStructureChanged(this.id, detail);
  }
}
