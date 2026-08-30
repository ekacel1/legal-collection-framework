@TITLE: Legal Collection Framework
@SUBTITLE: Software Architecture Specification
@VOLUME: VOLUME III — Plugin Contracts & Public API
@VERSION: 0.3 (Draft)

# Préambule du Volume III

Le Volume I a défini la charte architecturale. Le Volume II a défini le Kernel : les composants internes, leurs responsabilités et leurs interactions.

Le Volume III définit **la frontière du système** : ce que le monde extérieur voit du Framework, et ce que le Framework exige du monde extérieur.

Cette frontière comporte deux faces :

1. **La face descendante** — le contrat de plugin. C'est le point d'extension par lequel une nouvelle source documentaire entre dans le système. C'est le contrat le plus important du projet : il est destiné à être implémenté des centaines de fois, par des développeurs que nous ne rencontrerons jamais, sur des sources que nous ne connaîtrons jamais.
2. **La face ascendante** — l'API publique du Kernel. C'est le contrat par lequel un pipeline de traitement, un système d'indexation, une interface d'administration ou une chaîne d'entraînement d'IA consomme le corpus collecté.

> Règle structurante du Volume III : un contrat public est une dette permanente. Tout ce qui est publié dans ce volume devra être supporté pendant toute la durée de vie majeure du Framework. Ce qui n'est pas indispensable ne doit pas être publié.

## Portée

Ce volume spécifie :

- le contrat `SourcePlugin` et ses sous-contrats ;
- le manifeste de plugin et son schéma de validation ;
- le modèle d'objets échangés entre Kernel et plugin ;
- le modèle de capacités et de permissions ;
- la stratégie de versionnement et de compatibilité ;
- le packaging, la découverte et le chargement des plugins ;
- l'API publique du Kernel (SDK, CLI, HTTP, événements sortants) ;
- le kit de conformité (Plugin Conformance Kit) ;
- les critères d'acceptation du Volume III.

## Hors portée

Ce volume ne spécifie pas :

- l'implémentation interne des composants du Kernel (Volume II) ;
- le modèle de stockage physique et le versionnement documentaire (Volume IV) ;
- le pipeline de traitement en aval, extraction et normalisation (Volume V) ;
- la sécurité opérationnelle et la conformité juridique (Volume VI).

---

# Chapitre 1 — Principes de conception du contrat

## 1.1 Le plugin est un fournisseur, pas un acteur

Un plugin ne pilote jamais le système. Il ne décide pas quand collecter, ne décide pas où écrire, ne décide pas quoi conserver, et n'écrit jamais sur disque.

Un plugin répond à des questions posées par le Kernel :

- « Quels documents existent sur ta source ? »
- « Comment obtiens-tu le contenu binaire de ce document ? »
- « Quelles métadonnées natives peux-tu associer à ce document ? »

Cette inversion est ce qui rend le système testable, observable et sûr. Le plugin est une fonction de la source vers des descripteurs ; le Kernel est le moteur qui exécute, planifie, réessaie, persiste et trace.

## 1.2 Les cinq interdits du plugin

| # | Interdit | Raison |
|---|---|---|
| 1 | Écrire dans le système de fichiers | Le Storage Manager est seul responsable de la persistance et de l'atomicité |
| 2 | Ouvrir une connexion base de données | Aucun plugin ne doit pouvoir corrompre l'index |
| 3 | Émettre un événement sur l'Event Bus | Les événements sont un fait du Kernel, pas une déclaration du plugin |
| 4 | Instancier son propre client HTTP | Quotas, politesse, retry, proxy et traçabilité sont centralisés |
| 5 | Dépendre d'un autre plugin | L'isolement garantit qu'une panne reste locale |

Ces interdits ne sont pas seulement documentaires : ils sont vérifiés statiquement par le Plugin Conformance Kit (chapitre 13) et, en exécution, par le bac à sable de capacités (chapitre 5).

## 1.3 Contrat minimal, extensions optionnelles

Le contrat suit le principe de ségrégation des interfaces (ISP). Une interface obligatoire minimale, complétée par des interfaces facultatives que le Kernel détecte à l'exécution.

```
                 SourcePlugin (obligatoire)
                          |
     +--------------------+--------------------+
     |          |            |          |      |
 Discoverable  Fetchable  Describable  Paged  Incremental
 (obligatoire) (oblig.)   (option.)   (opt.)  (option.)
                                       |
                              BrowserAssisted (option.)
```

Un plugin qui n'implémente que le minimum fonctionne. Chaque interface supplémentaire n'ajoute pas de contrainte : elle débloque une optimisation du Kernel.

> Corollaire opérationnel : un plugin écrit en 2026 contre la version 1 du contrat doit continuer de fonctionner en 2036 sans modification, même si le Kernel a entre-temps ajouté dix interfaces optionnelles.

## 1.4 Le plugin est pur autant que possible

Le contrat encourage la conception suivante : la découverte est une transformation d'un flux d'octets (une page, une réponse d'API) vers une liste de descripteurs. Cette transformation doit être déterministe et testable hors ligne, à partir de fixtures enregistrées.

Toute logique qui n'est pas de l'extraction (retry, throttling, cache, journalisation, hachage) est fournie par le Kernel et ne doit jamais être réimplémentée dans un plugin.

---

# Chapitre 2 — Le contrat SourcePlugin

## 2.1 Interface obligatoire

```
/**
 * Contrat racine. Toute source de documents est un SourcePlugin.
 * Le Kernel n'a aucune autre porte d'entree vers le monde exterieur.
 */
export interface SourcePlugin {
  /** Identite stable. Doit correspondre au manifeste. */
  readonly id: SourceId;                 // ex: "xx.gazette.official"
  readonly apiVersion: PluginApiVersion; // ex: "1.0"

  /**
   * Appele une seule fois apres chargement, avant tout autre appel.
   * Le plugin recoit ici toutes ses dependances. Il ne doit rien
   * construire lui-meme qui touche au reseau ou au disque.
   */
  init(ctx: PluginContext): Promise<void>;

  /**
   * Enumere les documents disponibles sur la source.
   * Flux asynchrone : le plugin peut emettre au fil de l'eau,
   * le Kernel consomme sans attendre la fin de l'enumeration.
   */
  discover(scope: DiscoveryScope): AsyncIterable<DocumentRef>;

  /**
   * Decrit comment obtenir le contenu binaire d'un document.
   * Le plugin NE telecharge PAS : il retourne une instruction.
   */
  resolve(ref: DocumentRef): Promise<FetchPlan>;

  /**
   * Libere les ressources. Toujours appele, meme apres erreur.
   */
  dispose(): Promise<void>;
}
```

Quatre méthodes. C'est tout ce qu'un plugin doit implémenter pour être opérationnel.

## 2.2 La séparation `resolve` / téléchargement

C'est la décision de conception la plus importante du contrat.

Le plugin ne télécharge pas. Il retourne un **plan de récupération** (`FetchPlan`) : une description déclarative de la requête à effectuer. Le Download Manager exécute ce plan.

```
  Plugin                    Kernel (Download Manager)
    |                                  |
    |  resolve(ref) -> FetchPlan       |
    |--------------------------------->|
    |                                  |-- applique le quota de la source
    |                                  |-- applique le delai de politesse
    |                                  |-- applique le retry exponentiel
    |                                  |-- applique le circuit breaker
    |                                  |-- streame vers un fichier temporaire
    |                                  |-- calcule SHA-256 au fil de l'eau
    |                                  |-- verifie taille / type / signature
    |                                  |-- remet au Storage Manager
    |                                  v
    |                            DocumentDownloaded
```

Bénéfices directs :

- un plugin ne peut pas contourner les quotas ni saturer une source ;
- la politique de retry est uniforme sur tout le système, et modifiable sans toucher aucun plugin ;
- le hachage et la vérification d'intégrité sont garantis par construction, pas par discipline du contributeur ;
- un `FetchPlan` est un objet sérialisable : il est journalisable, rejouable et testable.

## 2.3 Structure du FetchPlan

```
export type FetchPlan =
  | HttpFetchPlan
  | BrowserFetchPlan
  | ArchiveMemberFetchPlan
  | InlineFetchPlan;

export interface HttpFetchPlan {
  kind: "http";
  url: string;                       // absolue, http(s) uniquement
  method?: "GET" | "POST";           // defaut GET
  headers?: Record<string, string>;  // en-tetes additionnels
  body?: string;                     // si method = POST
  expect?: {
    mimeTypes?: string[];            // ex: ["application/pdf"]
    minBytes?: number;
    maxBytes?: number;
    magicBytes?: string;             // ex: "25504446" pour %PDF
  };
  follow?: { redirects: boolean; maxHops: number };
}

export interface BrowserFetchPlan {
  kind: "browser";
  url: string;
  waitFor?: { selector?: string; networkIdleMs?: number };
  action?: BrowserAction[];          // clics/formulaires strictement declaratifs
  capture: "download" | "pdf" | "html";
  requiresCapability: "browser";     // refuse si non accordee
}

export interface ArchiveMemberFetchPlan {
  kind: "archive-member";
  archive: HttpFetchPlan;            // l'archive elle-meme
  member: string;                    // chemin interne, sans ".."
}

export interface InlineFetchPlan {
  kind: "inline";
  bytes: Uint8Array;                 // contenu deja detenu par le plugin
  reason: string;                    // justification obligatoire (audit)
}
```

> `InlineFetchPlan` est une échappatoire volontairement inconfortable : elle exige une justification écrite, elle est plafonnée à 8 Mio, et son usage est signalé dans le rapport de conformité. Elle existe pour les sources qui exposent le contenu directement dans une réponse d'API, pas pour contourner le Download Manager.

## 2.4 Interfaces optionnelles

```
/** Metadonnees natives de la source (rubrique, numero, date officielle...). */
export interface Describable {
  describe(ref: DocumentRef): Promise<SourceMetadata>;
}

/** Le plugin sait enumerer par pages et reprendre a un curseur. */
export interface Paged {
  pageSize?: number;
  discoverPage(cursor: Cursor | null): Promise<PageResult>;
}

/** Le plugin sait limiter la decouverte a ce qui a change. */
export interface Incremental {
  /** Etat opaque rendu au Kernel et restitue a la collecte suivante. */
  checkpoint(): Promise<CheckpointState>;
  restore(state: CheckpointState): Promise<void>;
}

/** Le plugin sait verifier la sante de la source sans rien collecter. */
export interface HealthReporting {
  health(): Promise<HealthReport>;
}

/** Le plugin exige un navigateur pour au moins une operation. */
export interface BrowserAssisted {
  readonly browserProfile: BrowserProfile;
}
```

Le Kernel détecte ces capacités par test structurel au chargement :

```
const paged   = typeof (plugin as any).discoverPage === "function";
const increm  = typeof (plugin as any).checkpoint   === "function";
const health  = typeof (plugin as any).health       === "function";
```

Aucune configuration à déclarer, aucune duplication entre code et manifeste pour ces capacités-là.

## 2.5 Le PluginContext

Le `PluginContext` est le seul canal par lequel un plugin accède au monde. Il est construit par le Kernel, propre à chaque plugin, et révocable.

```
export interface PluginContext {
  readonly sourceId: SourceId;

  /** Client HTTP instrumente : quotas, retry, politesse, cache, tracing. */
  readonly http: HttpClient;

  /** Journal structure, prefixe par la source. Aucun acces au logger racine. */
  readonly log: Logger;

  /** Configuration validee du plugin (schema issu du manifeste). */
  readonly config: Readonly<Record<string, unknown>>;

  /** Secrets resolus, jamais journalises, jamais serialises. */
  readonly secrets: SecretAccessor;

  /** Cache clef/valeur, borne, propre a la source, non durable. */
  readonly cache: EphemeralCache;

  /** Horloge injectee : rend les plugins testables et deterministes. */
  readonly clock: Clock;

  /** Signal d'annulation cooperative (arret, timeout, budget epuise). */
  readonly signal: AbortSignal;

  /** Navigateur, uniquement si la capacite a ete accordee. */
  readonly browser?: BrowserSession;
}
```

> L'injection de `clock` n'est pas un détail : sans elle, aucun plugin manipulant des dates n'est testable de manière reproductible, et toute suite de tests devient dépendante du jour où on l'exécute.

---

# Chapitre 3 — Modèle d'objets du contrat

## 3.1 DocumentRef

`DocumentRef` est la monnaie d'échange du système. C'est ce qu'un plugin produit, ce que le Kernel déduplique, planifie et persiste.

```
export interface DocumentRef {
  /** Identifiant stable DANS la source. Doit survivre a un changement d'URL. */
  readonly nativeId: string;

  /** URL canonique de la ressource, si elle existe. */
  readonly url?: string;

  /** Titre brut tel qu'affiche par la source. Aucune normalisation. */
  readonly title?: string;

  /** Date affichee par la source, ISO-8601, telle que lue. */
  readonly publishedAt?: string;

  /** Type declare par la source, non verifie a ce stade. */
  readonly declaredMime?: string;

  /** Taille annoncee, si disponible. */
  readonly declaredBytes?: number;

  /** Indices de fraicheur fournis par la source (HTTP ou page). */
  readonly etag?: string;
  readonly lastModified?: string;

  /** Charge utile libre, propre au plugin, conservee telle quelle. */
  readonly extra?: Readonly<Record<string, unknown>>;
}
```

### Règle du nativeId

`nativeId` doit être **stable dans le temps** et **unique dans la source**. Il est la clé de déduplication et de suivi de version.

Ordre de préférence pour le construire :

1. un identifiant explicite exposé par la source (numéro d'acte, identifiant d'API, référence officielle) ;
2. un chemin d'URL structurellement stable, débarrassé des paramètres de session ;
3. en dernier recours, un hachage SHA-256 d'un tuple de champs invariants, préfixé par `derived:`.

Ce qui est interdit dans un `nativeId` : un numéro de page, un horodatage de collecte, un index de boucle, un jeton de session, un ordre de tri.

> Un `nativeId` instable transforme silencieusement chaque collecte en création de doublons. C'est la panne la plus coûteuse et la plus difficile à détecter du système, parce qu'elle ne produit aucune erreur : elle produit du volume.

## 3.2 Identité globale

Le Kernel construit l'identité globale. Le plugin ne la voit jamais.

```
DocumentId = sha256( sourceId + " " + nativeId )
```

Cette identité est déterministe, ne dépend pas du contenu, et reste stable si le document est révisé. Le contenu est identifié séparément :

```
ContentHash = sha256( octets telecharges )
```

Deux axes distincts, jamais confondus :

| Axe | Identifie | Change quand |
|---|---|---|
| `DocumentId` | l'entité documentaire | jamais |
| `ContentHash` | une version d'octets | à chaque modification du fichier |

Cette séparation est ce qui permet, au Volume IV, de bâtir un historique de versions sans jamais perdre le lien avec le document d'origine.

## 3.3 SourceMetadata

```
export interface SourceMetadata {
  /** Champs bruts extraits de la source, sans interpretation. */
  readonly raw: Readonly<Record<string, string | number | boolean | null>>;

  /** Champs projetes sur un vocabulaire commun, tous facultatifs. */
  readonly common?: {
    documentKind?: string;   // libelle de la source, non normalise
    reference?: string;      // numero/reference tel qu'affiche
    issuedAt?: string;       // ISO-8601
    language?: string;       // BCP-47 si la source le declare
    authority?: string;      // emetteur tel qu'affiche
  };

  /** Provenance : ou chaque champ a-t-il ete lu. Obligatoire pour l'audit. */
  readonly provenance: ReadonlyArray<{
    field: string;
    locator: string;   // selecteur CSS, chemin JSON, nom d'en-tete
    at: string;        // URL ou l'extraction a eu lieu
  }>;
}
```

L'obligation de `provenance` est délibérée. Elle a un coût d'écriture pour le contributeur, et une valeur décisive : quand un champ est faux dix ans plus tard, on sait exactement quelle ligne de quel sélecteur sur quelle page l'a produit.

## 3.4 DiscoveryScope

```
export interface DiscoveryScope {
  readonly mode: "full" | "incremental" | "range" | "single";
  readonly since?: string;            // ISO-8601, mode incremental
  readonly from?: string;             // mode range
  readonly to?: string;               // mode range
  readonly nativeId?: string;         // mode single
  readonly maxDocuments?: number;     // plafond dur impose par le Kernel
  readonly budget: DiscoveryBudget;   // requetes, octets, duree
}

export interface DiscoveryBudget {
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
}
```

Le budget n'est pas indicatif. Le Kernel l'applique côté `HttpClient` : dépassement = `AbortSignal` déclenché, énumération interrompue proprement, événement `DiscoveryBudgetExceeded` émis. Un plugin en boucle infinie ne peut donc pas immobiliser le système.

---

# Chapitre 4 — Le manifeste de plugin

## 4.1 Rôle

Le manifeste est la carte d'identité déclarative du plugin. Il est lu **avant** tout chargement de code : il permet au Kernel de refuser un plugin sans jamais l'exécuter.

Fichier : `lcf-plugin.json`, à la racine du paquet.

## 4.2 Exemple complet

```
{
  "manifestVersion": 1,
  "id": "xx.gazette.official",
  "name": "Official Gazette Collector",
  "version": "2.3.0",
  "apiVersion": "^1.0",
  "entry": "./dist/index.js",
  "license": "Apache-2.0",
  "maintainers": ["ops@example.org"],

  "source": {
    "displayName": "Official Gazette",
    "homepage": "https://gazette.example",
    "jurisdictionHint": "opaque-to-kernel",
    "languages": ["fr", "en"]
  },

  "capabilities": {
    "network": {
      "allowedHosts": ["gazette.example", "cdn.gazette.example"],
      "maxRequestsPerMinute": 30,
      "politenessDelayMs": 1200,
      "respectRobotsTxt": true
    },
    "browser": false,
    "archives": ["zip"],
    "inlineContent": false
  },

  "schedule": {
    "defaultCron": "0 3 * * *",
    "timezone": "UTC",
    "maxConcurrentDownloads": 3
  },

  "configSchema": {
    "type": "object",
    "properties": {
      "startYear": { "type": "integer", "minimum": 1900 },
      "categories": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["startYear"],
    "additionalProperties": false
  },

  "secrets": [
    { "name": "API_TOKEN", "required": false,
      "description": "Jeton d'acces si la source expose une API privee" }
  ],

  "integrity": {
    "expectedMimeTypes": ["application/pdf"],
    "minDocumentBytes": 1024,
    "maxDocumentBytes": 209715200
  },

  "conformance": {
    "kitVersion": "1.0",
    "fixturesPath": "./test/fixtures",
    "lastCertifiedAt": "2026-08-01"
  }
}
```

## 4.3 Champs et invariants

| Champ | Obligatoire | Invariant vérifié au chargement |
|---|---|---|
| `id` | oui | Unique dans le registre ; identique à `plugin.id` ; immuable sur toute la vie du plugin |
| `version` | oui | SemVer strict |
| `apiVersion` | oui | Plage SemVer compatible avec le Kernel courant |
| `entry` | oui | Chemin relatif, dans le paquet, sans `..` |
| `capabilities.network.allowedHosts` | oui | Liste non vide ; toute requête hors liste est rejetée par le `HttpClient` |
| `configSchema` | oui | JSON Schema valide ; `additionalProperties: false` exigé |
| `integrity.maxDocumentBytes` | oui | Borne dure appliquée par le Download Manager |
| `secrets` | non | Déclaration seule ; les valeurs ne figurent jamais dans le manifeste |

## 4.4 Deux échecs, deux traitements

| Type d'échec | Moment | Conséquence |
|---|---|---|
| Manifeste invalide | Avant chargement du code | Plugin rejeté, jamais exécuté, `PluginRejected` émis |
| Contrat non respecté à l'exécution | Pendant la collecte | Plugin mis en quarantaine, collecte de cette source suspendue, autres sources intactes |

> Le premier échec ne coûte rien. Le second coûte une collecte. C'est pourquoi le maximum de vérifications est déplacé vers le manifeste : la validation statique est toujours moins chère que la validation dynamique.

---

# Chapitre 5 — Capacités, permissions et bac à sable

## 5.1 Le modèle

Un plugin n'a par défaut **aucun** droit. Chaque capacité est demandée dans le manifeste et accordée par la configuration d'exploitation. La capacité effective est l'intersection des deux.

```
   Manifeste (demande)          Configuration (autorisation)
          |                                |
          +-------------- ∩ ---------------+
                          |
                 Capacite effective
                          |
                 injectee dans PluginContext
```

Une capacité non accordée n'est pas signalée par un drapeau à tester : le champ correspondant du contexte est simplement absent. Un plugin qui tente d'y accéder échoue immédiatement et bruyamment, plutôt que de dégrader silencieusement.

## 5.2 Capacités disponibles

| Capacité | Accorde | Contrôle appliqué |
|---|---|---|
| `network` | `ctx.http` | Filtre d'hôtes, quota par minute, délai de politesse, `robots.txt` |
| `browser` | `ctx.browser` | Session isolée, sans persistance, timeout dur, profil restreint |
| `archives` | `ArchiveMemberFetchPlan` | Anti zip-slip, ratio de décompression plafonné, profondeur maximale 1 |
| `inlineContent` | `InlineFetchPlan` | Plafond 8 Mio, justification obligatoire, signalé en audit |
| `secrets:<NAME>` | `ctx.secrets.get(NAME)` | Résolution paresseuse, valeur masquée dans tous les journaux |

## 5.3 Application côté réseau

Le `HttpClient` injecté n'est pas un client générique paramétré : c'est un client construit **pour ce plugin**, dont les limites ne sont pas modifiables depuis le plugin.

```
class ScopedHttpClient implements HttpClient {
  constructor(
    private readonly caps: NetworkCapability,
    private readonly limiter: RateLimiter,   // partage par hote
    private readonly breaker: CircuitBreaker,
    private readonly budget: BudgetTracker,
    private readonly trace: Tracer,
  ) {}

  async get(url: string, opts?: RequestOptions): Promise<Response> {
    const host = new URL(url).host;
    if (!this.caps.allowedHosts.includes(host)) {
      throw new CapabilityViolation("network.host", host);
    }
    if (this.caps.respectRobotsTxt && !(await this.robots.allows(url))) {
      throw new PolicyViolation("robots.txt", url);
    }
    this.budget.chargeRequest();          // leve BudgetExceeded si epuise
    await this.limiter.acquire(host);     // politesse + quota
    return this.breaker.run(() => this.doRequest(url, opts));
  }
}
```

## 5.4 Isolation d'exécution

Trois niveaux, choisis par configuration de déploiement :

| Niveau | Mécanisme | Coût | Usage |
|---|---|---|---|
| L1 — logique | Contexte restreint, gel des objets, aucun accès disque/DB | négligeable | Défaut ; plugins de confiance |
| L2 — worker | Thread de travail dédié, mémoire et CPU plafonnés, message passing | faible | Plugins tiers |
| L3 — processus | Processus séparé, IPC, système de fichiers en lecture seule | modéré | Plugins non audités |

Le contrat est identique aux trois niveaux : passer de L1 à L3 est une décision d'exploitation, jamais une réécriture de plugin. C'est la vérification concrète du Principe 6 du Volume I (« tout est remplaçable »).

---

# Chapitre 6 — Cycle de vie du plugin

## 6.1 Machine à états

```
   DISCOVERED
       | manifeste lu et valide
       v
   VALIDATED
       | code charge, contrat verifie structurellement
       v
   LOADED
       | init(ctx) reussi
       v
    READY  <-------------------------+
       | run demarre                 | run termine
       v                             |
    ACTIVE ------------------------->+
       |                             |
       | erreur fatale / seuil       | erreur transitoire
       v                             |
  QUARANTINED                        |
       |  reactivation manuelle      |
       +-----------------------------+
       |
       | dispose()
       v
   DISPOSED
```

## 6.2 Transitions et garanties

| Transition | Déclencheur | Garantie |
|---|---|---|
| `DISCOVERED → VALIDATED` | Manifeste conforme au schéma | Aucun code du plugin n'a encore été évalué |
| `VALIDATED → LOADED` | Module chargé, 4 méthodes présentes | Échec = `PluginRejected`, Kernel intact |
| `LOADED → READY` | `init()` résolu avant timeout | `init()` est plafonné à 30 s |
| `READY → ACTIVE` | Le Scheduler acquiert le verrou de source | Une seule exécution simultanée par source |
| `ACTIVE → QUARANTINED` | Erreur fatale, ou N erreurs consécutives | Les autres sources continuent |
| `QUARANTINED → READY` | Action d'exploitation explicite | Jamais automatique |
| `* → DISPOSED` | Arrêt du système | `dispose()` toujours appelé, même après panne |

## 6.3 Règles de quarantaine

Un plugin est mis en quarantaine si l'une des conditions est remplie :

- une `FatalPluginError` est levée ;
- le taux d'échec de téléchargement dépasse 50 % sur une fenêtre de 100 documents ;
- trois exécutions consécutives se terminent sans découvrir un seul document alors que l'historique en montrait ;
- le plugin viole une capacité (`CapabilityViolation`) ;
- `init()` dépasse son délai plafond.

La quarantaine ne détruit rien. Elle suspend. Tout ce qui a déjà été collecté reste intact et consultable — application directe du Principe 3 du Volume I (« aucune perte de données »).

> Le troisième critère mérite attention : une source qui ne renvoie plus rien est le mode de panne le plus fréquent d'un collecteur. Une refonte du site cible ne produit pas d'erreur HTTP — elle produit zéro résultat. Sans ce critère, le système signalerait « tout va bien » pendant des mois.

---

# Chapitre 7 — Stratégies de découverte

Le Kernel ne fournit pas d'implémentations de sources, mais il fournit des **squelettes de stratégie** que les plugins peuvent composer. Ces squelettes vivent dans le paquet `@lcf/plugin-toolkit`, distinct du noyau.

## 7.1 Les cinq topologies de source

| Topologie | Signe distinctif | Squelette | Pièges connus |
|---|---|---|---|
| Index paginé HTML | `?page=N` ou pagination visible | `PaginatedIndexStrategy` | Dernière page instable, doublons entre pages |
| Sitemap / flux | `sitemap.xml`, RSS, Atom | `SitemapStrategy` | Sitemaps partiels, `lastmod` menteur |
| API structurée | JSON/XML documenté | `ApiCursorStrategy` | Limites de débit, pagination par curseur opaque |
| Arborescence | Répertoires imbriqués | `TreeWalkStrategy` | Profondeur non bornée, cycles de liens |
| Rendu JavaScript | Contenu absent du HTML brut | `BrowserStrategy` | Coût élevé, fragilité maximale |

## 7.2 Squelette d'index paginé

```
export abstract class PaginatedIndexStrategy implements Paged {
  protected abstract buildPageUrl(page: number): string;
  protected abstract parsePage(html: string, url: string): DocumentRef[];
  protected abstract hasNextPage(html: string, page: number): boolean;

  async *discover(scope: DiscoveryScope): AsyncIterable<DocumentRef> {
    const seen = new Set<string>();
    let page = 0;
    let emptyStreak = 0;

    while (page < this.maxPages) {
      const url  = this.buildPageUrl(page);
      const html = await this.ctx.http.getText(url);
      const refs = this.parsePage(html, url);

      if (refs.length === 0 && ++emptyStreak >= 2) break;
      if (refs.length > 0) emptyStreak = 0;

      let novel = 0;
      for (const ref of refs) {
        if (seen.has(ref.nativeId)) continue;   // garde anti-doublon
        seen.add(ref.nativeId);
        novel++;
        yield ref;
      }

      // Garde anti-boucle : page identique a la precedente
      if (novel === 0 && refs.length > 0) break;
      if (!this.hasNextPage(html, page)) break;
      page++;
    }
  }
}
```

Trois gardes sont intégrées au squelette et non laissées au contributeur : la déduplication intra-exécution, la détection de page répétée, et l'arrêt sur pages vides consécutives. Ce sont les trois causes classiques de collecte infinie.

## 7.3 Découverte incrémentale

```
export interface CheckpointState {
  readonly version: 1;
  readonly cursor?: string;        // opaque, propre au plugin
  readonly highWaterMark?: string; // ISO-8601 du plus recent document vu
  readonly seenTail?: string[];    // derniers nativeId, anti-recouvrement
}
```

Règle de sûreté : le mode incrémental est une **optimisation**, jamais une source de vérité. Le Scheduler impose une collecte complète périodique (`fullSweepEvery`, défaut : 30 jours) afin de rattraper tout document qu'un incrément aurait manqué — rétro-publication, correction silencieuse, panne de curseur.

> Toute architecture incrémentale qui ne prévoit pas de balayage complet finit par diverger de la réalité. La seule question est de savoir combien de temps il faudra pour s'en apercevoir.

## 7.4 Recours au navigateur

Le recours au navigateur est autorisé mais encadré, conformément à la contrainte du Volume I (« sans navigateur, sauf si un plugin l'exige »).

Conditions cumulatives :

1. la capacité `browser` est demandée dans le manifeste **et** accordée en configuration ;
2. le plugin documente pourquoi le HTML brut est insuffisant ;
3. les actions sont déclaratives (`BrowserAction[]`), jamais du code arbitraire ;
4. la session est éphémère : ni cookie persistant, ni profil, ni cache conservé ;
5. un délai plafond dur s'applique par page (défaut : 45 s).

Si la capacité n'est pas accordée, le plugin doit se dégrader proprement : découvrir ce qu'il peut sans navigateur, et signaler la limitation via `HealthReport` — pas échouer.

---

# Chapitre 8 — Taxonomie des erreurs de plugin

## 8.1 Hiérarchie

```
LcfError
 ├── PluginError
 │    ├── TransientPluginError      -> retry automatique
 │    │     ├── SourceUnavailable
 │    │     ├── RateLimited
 │    │     └── NetworkTimeout
 │    ├── ContractPluginError       -> document ignore, source vivante
 │    │     ├── InvalidDocumentRef
 │    │     ├── UnresolvableDocument
 │    │     └── MetadataExtractionFailed
 │    └── FatalPluginError          -> quarantaine immediate
 │          ├── CapabilityViolation
 │          ├── SourceStructureChanged
 │          └── ConfigurationInvalid
 └── KernelError                    -> hors responsabilite plugin
```

## 8.2 Politique par classe

| Classe | Réessai | Portée de l'impact | Événement émis |
|---|---|---|---|
| `TransientPluginError` | Oui, backoff exponentiel + jitter, 5 tentatives | Le document seul | `DocumentRetryScheduled` |
| `ContractPluginError` | Non | Le document seul, marqué `failed` | `DocumentFailed` |
| `FatalPluginError` | Non | La source entière | `PluginQuarantined` |
| Erreur inattendue | Non | Traitée comme fatale | `PluginCrashed` |

## 8.3 Règle de l'erreur honnête

Un plugin ne doit **jamais** :

- retourner un tableau vide pour masquer une erreur ;
- retourner un `DocumentRef` incomplet plutôt que d'échouer ;
- réessayer lui-même ;
- avaler une exception pour « ne pas casser la collecte ».

Chacun de ces comportements transforme une panne visible en corruption silencieuse du corpus. Le Framework préfère toujours une erreur bruyante à une donnée douteuse — c'est l'application directe du principe *Fail Fast* du Volume I, chapitre 7.

```
// INTERDIT
async discover() {
  try { return await this.scrape(); }
  catch { return []; }              // la source parait vide : personne ne le saura
}

// CORRECT
async *discover(scope) {
  try {
    yield* this.scrape(scope);
  } catch (e) {
    if (isNetworkError(e)) throw new SourceUnavailable(this.id, { cause: e });
    if (isSelectorMiss(e)) throw new SourceStructureChanged(this.id, { cause: e });
    throw e;
  }
}
```

---

# Chapitre 9 — Versionnement et compatibilité

## 9.1 Trois versions indépendantes

| Version | Porte sur | Cadence | Politique de rupture |
|---|---|---|---|
| Version du Kernel | Le noyau | Continue | SemVer ; majeure rare |
| `apiVersion` du contrat | La frontière plugin | Très lente | Majeure = migration coordonnée |
| Version du plugin | Un plugin donné | Libre | À la main du mainteneur |

## 9.2 Compatibilité de l'API de plugin

Le contrat suit SemVer avec une contrainte plus stricte que d'ordinaire :

- **Patch (1.0.x)** — clarification de documentation uniquement, aucun changement de signature ;
- **Mineure (1.x)** — ajout d'interfaces optionnelles, ajout de champs optionnels ; tout plugin existant reste valide sans recompilation ;
- **Majeure (x.0)** — rupture ; exige une période de double support d'au moins 24 mois.

## 9.3 Support de deux majeures

Lors d'une transition `1.x → 2.x`, le Kernel charge simultanément les deux générations via un adaptateur :

```
   Kernel v2
       |
   PluginHost
       |
   +---+-------------------+
   |                       |
 v2 natif           LegacyV1Adapter
                           |
                      plugin v1
```

L'adaptateur est du code jetable, versionné avec une date de retrait explicite inscrite dans le code même :

```
/** @deprecated Retrait planifie : 2029-01-01. Ne pas etendre. */
export class LegacyV1Adapter implements SourcePluginV2 { /* ... */ }
```

> Sans date de retrait écrite dans le code, un adaptateur de compatibilité devient permanent. Dix ans plus tard, il constitue la moitié de la dette technique du projet.

## 9.4 Matrice de compatibilité

| Kernel | apiVersion supportées | Statut |
|---|---|---|
| 1.x | `^1.0` | Support complet |
| 2.x | `^2.0`, `^1.0` via adaptateur | v1 déprécié, retrait annoncé |
| 3.x | `^3.0`, `^2.0` via adaptateur | v1 refusé au chargement |

Un plugin refusé pour incompatibilité produit un message actionnable, jamais une panne obscure :

```
PluginRejected: xx.gazette.official
  raison        : apiVersion incompatible
  demande       : ^1.0
  supporte      : ^2.0, ^3.0
  action        : migrer selon docs/migration/v1-to-v2.md
  documents     : 12 480 conserves, intacts, consultables
```

---

# Chapitre 10 — Packaging, découverte et chargement

## 10.1 Formes de distribution

| Forme | Description | Usage |
|---|---|---|
| Répertoire local | Dossier avec `lcf-plugin.json` | Développement |
| Archive signée | `.lcfp` = tar + gzip + signature | Déploiement contrôlé |
| Paquet de registre | Publié sur un registre npm ou privé | Distribution large |

## 10.2 Séquence de chargement

```
1. Analyser les chemins de recherche configures
2. Pour chaque candidat :
   a. lire lcf-plugin.json          -> echec : ignorer, journaliser
   b. valider contre le meta-schema -> echec : PluginRejected
   c. verifier apiVersion           -> echec : PluginRejected
   d. verifier la signature (si exigee)
   e. verifier l'unicite de l'id    -> conflit : PluginRejected (les deux)
   f. calculer les capacites effectives
   g. charger le module (entry)
   h. verifier structurellement le contrat
   i. construire le PluginContext
   j. appeler init() avec timeout
3. Enregistrer dans le registre -> etat READY
4. Emettre PluginLoaded
```

Deux points de conception :

- l'étape (e) rejette **les deux** plugins en conflit d'identifiant. Choisir arbitrairement un gagnant rendrait le comportement du système dépendant de l'ordre de parcours du système de fichiers ;
- l'étape (b) précède toute évaluation de code. Un manifeste malveillant ou corrompu n'atteint jamais l'exécution.

## 10.3 Rechargement à chaud

Le rechargement à chaud est supporté en développement et **désactivé par défaut en production**. Un rechargement pendant une exécution active n'interrompt jamais celle-ci : le nouveau code prend effet à la collecte suivante.

---

# Chapitre 11 — API publique du Kernel

## 11.1 Trois surfaces, un noyau

```
   +-----------+   +-----------+   +--------------+
   |    CLI    |   | HTTP API  |   | SDK (in-proc)|
   +-----------+   +-----------+   +--------------+
         |               |                |
         +-------+-------+----------------+
                 |
          Application Layer
                 |
             Kernel
```

Aucune logique métier n'existe dans les adaptateurs. Toute capacité offerte par le HTTP l'est identiquement par le SDK et par la CLI, parce que les trois appellent les mêmes cas d'usage applicatifs.

## 11.2 Interface SDK

```
export interface LcfKernel {
  // --- Sources ---
  listSources(): Promise<SourceSummary[]>;
  getSource(id: SourceId): Promise<SourceDetail>;
  healthCheck(id: SourceId): Promise<HealthReport>;

  // --- Collecte ---
  run(id: SourceId, scope?: Partial<DiscoveryScope>): Promise<RunHandle>;
  getRun(runId: RunId): Promise<RunStatus>;
  cancelRun(runId: RunId): Promise<void>;

  // --- Corpus ---
  queryDocuments(q: DocumentQuery): Promise<Page<DocumentSummary>>;
  getDocument(id: DocumentId): Promise<DocumentDetail>;
  getVersions(id: DocumentId): Promise<DocumentVersion[]>;
  openContent(id: DocumentId, version?: number): Promise<ReadableStream>;

  // --- Integrite ---
  verify(id: DocumentId): Promise<IntegrityReport>;
  verifyAll(opts?: VerifyOptions): Promise<AsyncIterable<IntegrityReport>>;

  // --- Evenements ---
  subscribe(filter: EventFilter, handler: EventHandler): Subscription;
}
```

## 11.3 API HTTP

Projection directe du SDK, en lecture seule pour le corpus.

| Méthode | Chemin | Rôle |
|---|---|---|
| `GET` | `/api/v1/sources` | Lister les sources |
| `GET` | `/api/v1/sources/{id}` | Détail et état d'une source |
| `GET` | `/api/v1/sources/{id}/health` | Diagnostic sans collecte |
| `POST` | `/api/v1/sources/{id}/runs` | Déclencher une collecte |
| `GET` | `/api/v1/runs/{runId}` | État d'une exécution |
| `DELETE` | `/api/v1/runs/{runId}` | Annuler une exécution |
| `GET` | `/api/v1/documents` | Rechercher dans le corpus |
| `GET` | `/api/v1/documents/{id}` | Métadonnées d'un document |
| `GET` | `/api/v1/documents/{id}/versions` | Historique des versions |
| `GET` | `/api/v1/documents/{id}/content` | Octets originaux |
| `GET` | `/api/v1/documents/{id}/integrity` | Rapport d'intégrité |
| `GET` | `/api/v1/events` | Flux d'événements (SSE) |

### Conventions transversales

- Pagination par curseur opaque uniquement. Aucun `offset` : sur un corpus qui grandit pendant la pagination, l'offset saute et duplique des lignes.
- Erreurs au format `application/problem+json` (RFC 7807).
- `GET /content` répond `ETag: "<contentHash>"` et honore `If-None-Match`.
- Aucune écriture sur le corpus par HTTP. Le corpus n'est modifiable que par une collecte.

```
{
  "type": "https://lcf.dev/errors/source-quarantined",
  "title": "Source en quarantaine",
  "status": 409,
  "detail": "La source xx.gazette.official est en quarantaine depuis 2026-08-14T03:12:09Z.",
  "instance": "/api/v1/sources/xx.gazette.official/runs",
  "quarantineReason": "SourceStructureChanged",
  "documentsPreserved": 12480
}
```

## 11.4 Événements sortants et webhooks

Le Kernel expose un sous-ensemble stable de son bus interne. Les événements publics sont un contrat, au même titre que les signatures de méthodes.

```
{
  "specVersion": "1.0",
  "id": "01J9X3T2K8M4QF6ZP1B7YHN0AC",
  "type": "lcf.document.stored",
  "source": "lcf://kernel/xx.gazette.official",
  "time": "2026-08-30T03:14:07.221Z",
  "runId": "run_01J9X3S9",
  "data": {
    "documentId": "9f2c...ab71",
    "sourceId": "xx.gazette.official",
    "contentHash": "sha256:6b1d...4e0f",
    "version": 3,
    "bytes": 482911,
    "mimeType": "application/pdf",
    "isNewVersion": true
  }
}
```

Événements publics de la version 1 :

| Type | Signification |
|---|---|
| `lcf.document.discovered` | Un descripteur nouveau a été produit |
| `lcf.document.stored` | Des octets ont été persistés et vérifiés |
| `lcf.document.version_created` | Le contenu d'un document connu a changé |
| `lcf.document.failed` | Un document n'a pas pu être collecté |
| `lcf.run.started` / `lcf.run.completed` | Cycle de vie d'une exécution |
| `lcf.source.quarantined` | Une source a été suspendue |
| `lcf.integrity.violation` | Une divergence de hachage a été détectée |

Livraison des webhooks : au moins une fois, signature HMAC-SHA256 dans l'en-tête `X-LCF-Signature`, réessais avec backoff exponentiel pendant 24 h, puis file de lettres mortes.

> « Au moins une fois » est un choix, pas une limitation. Garantir « exactement une fois » à travers un réseau exigerait une coordination distribuée dont le coût et la fragilité dépassent le bénéfice. Les consommateurs sont donc tenus d'être idempotents — ce que l'identifiant d'événement stable rend trivial.

---

# Chapitre 12 — Modèles de plugins de référence

Ces modèles sont des **archétypes**, publiés hors du noyau. Aucun n'est nommé d'après une institution réelle, conformément à la règle absolue du Volume I, chapitre 9.

## 12.1 Archétype A — Portail d'index paginé

```
export class PaginatedPortalPlugin
  extends PaginatedIndexStrategy
  implements SourcePlugin, Describable, Incremental {

  readonly id = "example.paginated.portal";
  readonly apiVersion = "1.0";

  protected buildPageUrl(page: number): string {
    return `${this.cfg.baseUrl}/documents?page=${page}`;
  }

  protected parsePage(html: string, url: string): DocumentRef[] {
    return this.dom(html).select("article.doc-entry").map(node => ({
      nativeId:      this.stableId(node.attr("href")),
      url:           this.absolute(node.attr("href"), url),
      title:         node.select("h3").text().trim(),
      publishedAt:   this.parseDate(node.select("time").attr("datetime")),
      declaredMime:  "application/pdf",
    }));
  }

  async resolve(ref: DocumentRef): Promise<FetchPlan> {
    if (!ref.url) throw new UnresolvableDocument(ref.nativeId);
    return {
      kind: "http",
      url: ref.url,
      expect: { mimeTypes: ["application/pdf"], minBytes: 1024,
                magicBytes: "25504446" },
    };
  }
}
```

## 12.2 Archétype B — API structurée avec curseur

```
export class CursorApiPlugin implements SourcePlugin, Incremental {
  async *discover(scope: DiscoveryScope): AsyncIterable<DocumentRef> {
    let cursor: string | null = scope.mode === "incremental"
      ? this.state.cursor ?? null
      : null;

    do {
      const res: ApiPage = await this.ctx.http.getJson(
        this.endpoint({ cursor, limit: 100 })
      );
      for (const item of res.items) {
        yield {
          nativeId:    String(item.id),          // identifiant natif : ideal
          url:         item.file_url,
          title:       item.title,
          publishedAt: item.published_at,
          declaredMime: item.mime,
          declaredBytes: item.size,
          extra:       { category: item.category },
        };
      }
      cursor = res.next_cursor;
      this.state = { version: 1, cursor: cursor ?? this.state.cursor };
    } while (cursor && !this.ctx.signal.aborted);
  }
}
```

## 12.3 Archétype C — Archive périodique

Source publiant des lots compressés. Le plugin énumère les membres de l'archive **sans la décompresser lui-même** : le Kernel applique les gardes anti zip-slip et le plafond de ratio de décompression.

```
async resolve(ref: DocumentRef): Promise<FetchPlan> {
  return {
    kind: "archive-member",
    archive: { kind: "http", url: ref.extra!.archiveUrl as string },
    member:  ref.extra!.memberPath as string,
  };
}
```

## 12.4 Archétype D — Portail à rendu JavaScript

Dernier recours. Le plugin déclare `browser: true`, documente la justification, et se dégrade proprement si la capacité n'est pas accordée :

```
async *discover(scope: DiscoveryScope): AsyncIterable<DocumentRef> {
  if (!this.ctx.browser) {
    this.ctx.log.warn("capacite browser non accordee : couverture partielle");
    yield* this.discoverFromStaticFallback(scope);
    return;
  }
  yield* this.discoverWithBrowser(scope);
}
```

## 12.5 Comparaison

| Archétype | Coût par document | Fragilité | Incrémental | Recommandation |
|---|---|---|---|---|
| B — API à curseur | Très faible | Faible | Natif | Toujours préférer si disponible |
| C — Archive | Faible | Faible | Par lot | Excellent pour l'historique |
| A — Index paginé | Moyen | Moyenne | Par date | Cas le plus fréquent |
| D — Navigateur | Élevé | Élevée | Difficile | Uniquement si A à C impossibles |

---

# Chapitre 13 — Plugin Conformance Kit

## 13.1 Objectif

Un contrat qui n'est pas vérifié mécaniquement n'est pas un contrat : c'est une recommandation. Le Conformance Kit est une suite exécutable que tout plugin doit passer avant publication.

```
npx @lcf/conformance ./mon-plugin
```

## 13.2 Les huit familles de tests

| # | Famille | Vérifie |
|---|---|---|
| 1 | Manifeste | Schéma valide, cohérence `id`/`version`/`apiVersion` |
| 2 | Structure | Les quatre méthodes existent et ont la bonne arité |
| 3 | Cycle de vie | `init` → `discover` → `resolve` → `dispose` sans fuite |
| 4 | Déterminisme | Deux `discover` sur les mêmes fixtures produisent la même sortie |
| 5 | Stabilité du `nativeId` | Aucun `nativeId` ne contient page, horodatage ou index |
| 6 | Étanchéité | Aucun accès disque, DB ou réseau hors `ctx.http` |
| 7 | Erreurs | Les pannes simulées lèvent la bonne classe d'erreur |
| 8 | Budget | `discover` s'arrête proprement sur `AbortSignal` |

## 13.3 Test de déterminisme

```
test("discover est deterministe sur fixtures", async () => {
  const a = await collect(plugin.discover(SCOPE));
  const b = await collect(plugin.discover(SCOPE));

  expect(a.map(r => r.nativeId)).toEqual(b.map(r => r.nativeId));
  expect(new Set(a.map(r => r.nativeId)).size).toBe(a.length); // aucun doublon
});
```

## 13.4 Test d'étanchéité

Le harnais remplace le contexte par une version piégée : toute tentative d'accès hors contrat lève immédiatement.

```
const trap = new Proxy({}, {
  get(_t, prop) { throw new SandboxViolation(`acces interdit : ${String(prop)}`); }
});

const plugin = await load(pluginPath, {
  fs: trap, net: trap, childProcess: trap, db: trap,
  http: recordingHttpClient(fixtures),
});
```

## 13.5 Test de stabilité du nativeId

```
const FORBIDDEN = [
  /page[=_-]?\d+/i,        // numero de page
  /\d{13}/,                // horodatage epoch en millisecondes
  /session|token|jsessionid/i,
  /^\d+$/,                 // index de boucle nu
];

for (const ref of refs) {
  for (const rx of FORBIDDEN) {
    expect(ref.nativeId).not.toMatch(rx);
  }
}
```

## 13.6 Résultat

Le kit produit un rapport signé, joint au paquet et vérifié au chargement quand la conformité est exigée en configuration :

```
LCF Conformance Report v1.0
plugin  : example.paginated.portal@2.3.0
apiVer  : 1.0
date    : 2026-08-30T09:41:02Z

[ok]   manifeste            12/12
[ok]   structure             8/8
[ok]   cycle de vie          9/9
[ok]   determinisme          6/6
[ok]   stabilite nativeId    5/5
[ok]   etanchoite           11/11
[warn] erreurs               7/8  (RateLimited non couvert par fixture)
[ok]   budget                4/4

VERDICT : CONFORME (1 avertissement)
```

---

# Chapitre 14 — Critères d'acceptation du Volume III

Format Given / When / Then, directement traduisibles en tests.

## AC-3.1 — Isolement du plugin

```
ETANT DONNE un plugin qui leve une exception a chaque appel de discover()
QUAND le Scheduler declenche une collecte sur les trois sources configurees
ALORS ce plugin passe en QUARANTINED
  ET les deux autres sources terminent normalement
  ET aucun document deja stocke n'est modifie
  ET l'evenement lcf.source.quarantined est emis exactement une fois
```

## AC-3.2 — Application des capacités

```
ETANT DONNE un plugin dont allowedHosts = ["a.example"]
QUAND il appelle ctx.http.get("https://b.example/doc.pdf")
ALORS une CapabilityViolation est levee avant toute resolution DNS
  ET aucun paquet reseau n'est emis vers b.example
  ET l'incident est journalise avec l'hote refuse
```

## AC-3.3 — Idempotence de la collecte

```
ETANT DONNE une source dont le contenu n'a pas change
QUAND une collecte complete est executee deux fois de suite
ALORS le nombre de documents est identique apres les deux executions
  ET aucune nouvelle version n'est creee
  ET aucun octet n'est reecrit sur disque
```

## AC-3.4 — Nouvelle version sur changement de contenu

```
ETANT DONNE un document deja collecte avec contentHash H1
QUAND la source publie un fichier different sous le meme nativeId
ALORS une version 2 est creee avec contentHash H2
  ET la version 1 reste integralement accessible
  ET lcf.document.version_created est emis
```

## AC-3.5 — Compatibilité ascendante du contrat

```
ETANT DONNE un plugin ecrit contre apiVersion 1.0
QUAND le Kernel est mis a jour vers une version mineure ulterieure
ALORS le plugin se charge sans modification ni recompilation
  ET tous ses tests de conformite passent a l'identique
```

## AC-3.6 — Respect du budget

```
ETANT DONNE un budget de decouverte de 50 requetes
QUAND un plugin tente d'en effectuer 200
ALORS l'enumeration est interrompue apres la 50e
  ET dispose() est appele
  ET les documents deja decouverts sont conserves
  ET lcf.discovery.budget_exceeded est emis
```

## AC-3.7 — Refus avant exécution

```
ETANT DONNE un paquet dont le manifeste est invalide
QUAND le Kernel demarre
ALORS le plugin est rejete
  ET aucune ligne de son code n'a ete evaluee
  ET le demarrage du Kernel aboutit malgre tout
```

## AC-3.8 — Stabilité de l'API HTTP

```
ETANT DONNE un client ecrit contre /api/v1
QUAND le Kernel ajoute de nouveaux champs de reponse
ALORS le client existant continue de fonctionner
  ET aucun champ existant n'a change de type ni de signification
```

---

# Chapitre 15 — Décisions d'architecture du Volume III

## ADR-301 — Le plugin ne télécharge pas

**Statut** : Accepté · **Contexte** : Le téléchargement concentre les risques (quotas, retry, intégrité, sécurité). Le laisser aux plugins revient à les dupliquer N fois, avec N qualités différentes.
**Décision** : `resolve()` retourne un `FetchPlan` déclaratif ; seul le Download Manager exécute.
**Conséquences** : + Politique uniforme, plugins triviaux à tester, intégrité garantie par construction. − Une indirection supplémentaire ; certains cas exotiques exigent un nouveau type de `FetchPlan` plutôt qu'un contournement local.

## ADR-302 — Interfaces optionnelles détectées structurellement

**Statut** : Accepté · **Contexte** : Déclarer les capacités dans le manifeste crée une double source de vérité qui dérive.
**Décision** : Les capacités de contrat sont détectées par présence de méthode ; le manifeste ne déclare que les capacités de **sécurité** (réseau, navigateur, archives, secrets).
**Conséquences** : + Aucune dérive possible entre code et déclaration. − Détection moins explicite à la lecture du manifeste, compensée par le rapport de chargement.

## ADR-303 — `nativeId` fourni par le plugin, `DocumentId` calculé par le Kernel

**Statut** : Accepté · **Contexte** : Seul le plugin connaît la notion d'identité de sa source ; seul le Kernel peut garantir l'unicité globale.
**Décision** : Le plugin fournit `nativeId` ; le Kernel dérive `DocumentId = sha256(sourceId ‖ nativeId)`.
**Conséquences** : + Identité globale déterministe et reproductible. − La qualité de la déduplication dépend de la discipline du plugin, d'où le test de conformité dédié (13.5).

## ADR-304 — Pagination par curseur exclusivement

**Statut** : Accepté · **Contexte** : Le corpus grandit pendant qu'un client pagine.
**Décision** : Aucune API publique n'expose `offset`/`page`.
**Conséquences** : + Aucun saut ni doublon de ligne. − Impossible de sauter directement à la page N, limitation assumée.

## ADR-305 — Livraison des événements « au moins une fois »

**Statut** : Accepté · **Contexte** : « Exactement une fois » exige une coordination distribuée coûteuse et fragile.
**Décision** : Au moins une fois, avec identifiants d'événement stables.
**Conséquences** : + Simplicité, robustesse aux pannes réseau. − Les consommateurs doivent être idempotents, ce qui est explicitement documenté dans le contrat.

---

# Synthèse du Volume III

Le Volume III a fixé la frontière du système.

Vers le bas, un contrat de quatre méthodes obligatoires, volontairement pauvre, entouré d'un modèle de capacités qui rend l'abus structurellement impossible plutôt que contractuellement déconseillé. Un plugin ne peut pas saturer une source, ne peut pas écrire sur disque, ne peut pas contourner le hachage, et ne peut pas faire tomber les autres sources — non par discipline, mais par construction.

Vers le haut, trois surfaces (SDK, CLI, HTTP) projetant un unique noyau applicatif, un corpus strictement en lecture, et un flux d'événements dont la stabilité engage autant que celle des signatures de méthodes.

Entre les deux, un kit de conformité exécutable qui transforme les règles de ce volume en tests, parce qu'une règle non vérifiée mécaniquement finit toujours par être violée.

**Volume IV — Data Model, Storage & Versioning** spécifiera ce qui se passe une fois les octets acquis : le modèle relationnel complet, la disposition physique du magasin de contenu, l'écriture atomique, le modèle de versions, la stratégie de sauvegarde et de restauration, la vérification d'intégrité périodique, et la stratégie de migration de schéma sur quinze ans.
