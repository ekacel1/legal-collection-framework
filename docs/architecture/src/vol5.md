@TITLE: Legal Collection Framework
@SUBTITLE: Software Architecture Specification
@VOLUME: VOLUME V — Processing Pipeline & Extraction Layer
@VERSION: 0.5 (Draft)

# Préambule du Volume V

Les Volumes I à IV décrivent un système qui acquiert des octets et les conserve intacts. Le Volume V décrit ce qui se construit **au-dessus** de ces octets : l'extraction du texte, sa normalisation, sa structuration, et sa mise à disposition pour un usage en aval — recherche, indexation, entraînement de modèles.

Ce volume introduit une distinction que le reste de la spécification défendra sans exception :

| | Collecte (Vol. I–IV) | Traitement (Vol. V) |
|---|---|---|
| Produit | Des octets originaux | Des artefacts dérivés |
| Réversibilité | Irremplaçable si perdu | Toujours reconstructible |
| Fidélité | Absolue, aucune altération | Interprétée, imparfaite par nature |
| Confiance | Fait établi | Estimation, assortie d'un score |
| En cas de panne | Perte définitive | Simple retraitement |

> Le Volume I posait que « le document original est sacré ». Le Volume V en tire la conséquence pratique : tout ce que produit le pipeline est jetable. Aucun artefact dérivé n'a jamais le droit de remplacer, masquer ou modifier l'original dont il provient.

## Portée

- L'architecture du pipeline et son modèle d'exécution.
- Le contrat `Processor` et sa composition.
- Les étapes standard, de la détection de type à l'export.
- L'extraction de texte selon le format et la qualité de la source.
- La normalisation Unicode et typographique.
- La segmentation destinée aux usages d'intelligence artificielle.
- Le stockage, le versionnement et le retraitement des artefacts dérivés.
- L'observabilité et les objectifs de performance.

## Hors portée

- L'interprétation juridique du contenu, explicitement exclue par le Volume I.
- Le moteur de recherche, consommateur du pipeline et non composant du Framework.
- L'entraînement de modèles, en aval de l'export.

---

# Chapitre 1 — La frontière

## 1.1 Deux systèmes dans un seul dépôt

```
   +------------------------------------------------------+
   |                  COLLECTE  (Vol. I-IV)               |
   |   Plugins -> Download -> Integrity -> Content Store  |
   +------------------------------------------------------+
                            |
                    lcf.document.stored
                            |
                            v
   +------------------------------------------------------+
   |                 TRAITEMENT  (Vol. V)                 |
   |   Pipeline -> Processeurs -> Artefacts derives       |
   +------------------------------------------------------+
                            |
                            v
                  Consommateurs (recherche, IA, export)
```

Le couplage entre les deux moitiés se réduit à un point unique : l'événement `lcf.document.stored`. Cela signifie que le pipeline peut être arrêté, redéployé, entièrement réécrit ou remplacé sans qu'une seule collecte en soit affectée.

## 1.2 Les quatre règles de la frontière

| # | Règle | Conséquence architecturale |
|---|---|---|
| R-1 | Le pipeline lit le Content Store, ne l'écrit jamais | Accès en lecture seule imposé au niveau du système de fichiers |
| R-2 | Tout artefact dérivé est reconstructible depuis l'original | Aucune sauvegarde nécessaire pour les dérivés |
| R-3 | Un échec de traitement n'affecte jamais la collecte | Files, processus et échéanciers séparés |
| R-4 | Le pipeline n'interprète jamais le sens juridique | Extraction structurelle uniquement, jamais sémantique |

La règle R-4 est une limite de responsabilité autant qu'une limite technique. Le Framework peut affirmer « ce document contient ce texte, à cet endroit ». Il ne peut jamais affirmer « ce texte abroge celui-là ». La première affirmation est vérifiable ; la seconde relève d'une interprétation qui n'appartient pas à un collecteur.

---

# Chapitre 2 — Architecture du pipeline

## 2.1 Vue d'ensemble

```
 lcf.document.stored
        |
        v
  +-----------+     +---------------+     +--------------+
  | Ingestor  |---->|  Work Queue   |---->|   Workers    |
  +-----------+     | (persistante) |     |  (pool N)    |
                    +---------------+     +--------------+
                            ^                     |
                            |                     v
                    +---------------+     +----------------+
                    | Retry / DLQ   |<----|  Stage Runner  |
                    +---------------+     +----------------+
                                                  |
                          +-----------------------+
                          |
                          v
                   +--------------+
                   | Derived Store|
                   +--------------+
```

## 2.2 Le pipeline est un graphe, pas une chaîne

Une chaîne linéaire impose de tout exécuter séquentiellement, même ce qui est indépendant. Le pipeline est donc un graphe acyclique orienté (DAG) déclaré, dont l'ordonnanceur déduit les parallélismes possibles.

```
                    detect-type
                         |
                 +-------+-------+
                 |               |
          extract-text      extract-embedded
                 |          (pieces jointes)
        +--------+--------+
        |                 |
   normalize        detect-language
        |                 |
        +--------+--------+
                 |
          detect-structure
                 |
        +--------+--------+
        |                 |
     segment           checksum-text
        |
      index
```

```
export interface PipelineDefinition {
  readonly id: string;
  readonly version: string;
  readonly stages: ReadonlyArray<StageDefinition>;
}

export interface StageDefinition {
  readonly name: string;
  readonly processor: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly optional: boolean;      // un echec n'arrete pas le DAG
  readonly timeoutMs: number;
  readonly appliesTo?: MimeMatcher; // ex: "application/pdf"
}
```

## 2.3 Étapes optionnelles et dégradation

Le drapeau `optional` matérialise une distinction essentielle : certaines étapes sont indispensables, d'autres sont des améliorations.

| Étape | Optionnelle | Si elle échoue |
|---|---|---|
| `detect-type` | Non | Le document est marqué `unprocessable` |
| `extract-text` | Non | Idem |
| `normalize` | Non | Idem |
| `detect-language` | Oui | La langue reste inconnue, le reste continue |
| `detect-structure` | Oui | Le texte reste plat, exploitable |
| `segment` | Oui | Pas de segments, texte intégral disponible |

Un document dont seules les étapes optionnelles ont échoué reste pleinement utilisable. C'est ce qui évite le comportement du tout ou rien, où un détecteur de langue défaillant priverait le corpus entier de son texte.

---

# Chapitre 3 — Modèle d'exécution

## 3.1 File de travail persistante

La file est persistée en base, pas en mémoire. Un redémarrage ne perd aucun travail en cours.

```
CREATE TABLE pipeline_tasks (
  task_id           TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL,
  version_no        INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  pipeline_id       TEXT NOT NULL,
  pipeline_version  TEXT NOT NULL,
  state             TEXT NOT NULL
                    CHECK (state IN ('pending','leased','done','failed','dead')),
  priority          INTEGER NOT NULL DEFAULT 100,
  attempts          INTEGER NOT NULL DEFAULT 0,
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  enqueued_at       TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  last_error        TEXT,
  UNIQUE (document_id, version_no, pipeline_id, pipeline_version)
);

CREATE INDEX idx_tasks_ready ON pipeline_tasks(state, priority, enqueued_at);
CREATE INDEX idx_tasks_lease ON pipeline_tasks(state, lease_expires_at);
```

La contrainte d'unicité sur `(document_id, version_no, pipeline_id, pipeline_version)` est ce qui rend la mise en file idempotente : réémettre dix fois le même événement produit une seule tâche.

## 3.2 Baux plutôt que verrous

Un verrou détenu par un processus qui meurt reste détenu. Un bail expire.

```
-- Prise de tache : atomique, sans verrou global
UPDATE pipeline_tasks
   SET state = 'leased',
       lease_owner = :worker_id,
       lease_expires_at = :now_plus_ttl,
       attempts = attempts + 1,
       started_at = COALESCE(started_at, :now)
 WHERE task_id = (
   SELECT task_id FROM pipeline_tasks
    WHERE state = 'pending'
       OR (state = 'leased' AND lease_expires_at < :now)   -- bail expire
    ORDER BY priority ASC, enqueued_at ASC
    LIMIT 1
 )
RETURNING *;
```

Un travailleur qui disparaît brutalement libère donc sa tâche automatiquement à l'expiration du bail (défaut : 15 minutes, renouvelé toutes les 5 minutes par le travailleur actif).

## 3.3 Contre-pression

Le pipeline ne doit jamais faire tomber la collecte, ni saturer la machine.

| Mécanisme | Seuil par défaut | Effet |
|---|---|---|
| Profondeur de file maximale | 100 000 tâches | L'ingestion marque les documents `deferred` plutôt que d'enfiler |
| Travailleurs simultanés | `min(cpuCount - 1, 8)` | Laisse toujours un cœur à la collecte |
| Plafond mémoire par tâche | 512 Mio | Dépassement = échec propre, pas éviction système |
| Priorité E/S | Basse | La collecte reste prioritaire sur le disque |

> Le choix de `cpuCount - 1` n'est pas de la prudence excessive. Un pipeline d'extraction saturant tous les cœurs rend le système inobservable au moment précis où l'on a besoin de l'observer.

## 3.4 Réessai et file de lettres mortes

```
   pending --> leased --> done
      ^          |
      |          v
      +------ failed (transitoire, backoff exponentiel)
                 |
                 | attempts >= maxAttempts
                 v
               dead (DLQ)  -> aucune suppression, inspection manuelle
```

| Classe d'échec | Réessai | Exemple |
|---|---|---|
| Transitoire | Oui, 5 fois, backoff exponentiel | Mémoire insuffisante, verrou temporaire |
| Déterministe | Non | PDF chiffré, format non supporté |
| Panne de processeur | Oui, après correctif et remise en file | Anomalie de code |

Une tâche en file de lettres mortes n'est jamais supprimée. Elle documente une limite réelle du pipeline, et la liste des tâches mortes est le meilleur indicateur des formats qu'il reste à traiter.

---

# Chapitre 4 — Le contrat Processor

## 4.1 Interface

```
export interface Processor<TIn = unknown, TOut = unknown> {
  readonly name: string;
  readonly version: string;          // SemVer : gouverne le retraitement

  /** Ce processeur peut-il traiter cette entree ? */
  supports(ctx: ProcessingContext): boolean;

  /** Traitement pur : entree -> sortie, aucun effet de bord. */
  process(input: TIn, ctx: ProcessingContext): Promise<ProcessorResult<TOut>>;
}

export interface ProcessorResult<T> {
  readonly output: T;
  readonly confidence: number;             // 0..1, obligatoire
  readonly warnings: ReadonlyArray<string>;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface ProcessingContext {
  readonly documentId: DocumentId;
  readonly versionNo: number;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteSize: number;

  /** Lecture seule. Toute tentative d'ecriture leve. */
  openContent(): Promise<ReadableStream>;

  /** Sorties des etapes precedentes du DAG. */
  artifact<T>(stageName: string): Promise<T>;

  readonly log: Logger;
  readonly signal: AbortSignal;
  readonly tmpDir: string;         // efface a la fin de la tache
}
```

## 4.2 Le score de confiance est obligatoire

Aucun processeur ne retourne un résultat nu. Il retourne toujours un résultat **et** une estimation de sa fiabilité.

| Plage | Interprétation | Traitement en aval |
|---|---|---|
| 0.95 – 1.00 | Certain | Utilisable sans réserve |
| 0.70 – 0.94 | Probable | Utilisable, à signaler dans les exports |
| 0.40 – 0.69 | Douteux | Marqué `needs_review` |
| 0.00 – 0.39 | Non fiable | Conservé, mais exclu des exports par défaut |

Sans score, tout consommateur en aval est contraint de traiter une extraction OCR médiocre et une extraction PDF native parfaite comme équivalentes. C'est un excellent moyen de contaminer silencieusement un jeu de données d'entraînement.

## 4.3 Un processeur est une fonction pure

Contraintes vérifiées par la suite de conformité du pipeline :

- pas d'accès réseau ;
- pas d'écriture hors de `ctx.tmpDir` ;
- pas de lecture de la base ;
- pas d'état entre deux appels ;
- déterminisme : mêmes entrées, même sortie, mêmes métriques.

Le déterminisme est la propriété qui rend le retraitement sûr. S'il n'est pas garanti, retraiter un corpus produit un corpus différent, et l'on perd toute possibilité de comparer deux versions du pipeline.

---

# Chapitre 5 — Étapes standard

## 5.1 detect-type

Ne jamais faire confiance au type déclaré. Le type effectif est déterminé par inspection des octets.

```
export class TypeDetector implements Processor<void, TypeInfo> {
  async process(_: void, ctx: ProcessingContext) {
    const head = await readFirstBytes(await ctx.openContent(), 8192);

    const magic = matchMagicBytes(head);          // signature binaire
    const declared = ctx.mimeType;                 // annonce par la source

    if (magic && declared && magic !== declared) {
      return {
        output: { mimeType: magic, declaredMime: declared, mismatch: true },
        confidence: 0.9,
        warnings: [`type declare ${declared} != detecte ${magic}`],
        metrics: { headBytes: head.length },
      };
    }
    return { output: { mimeType: magic ?? declared ?? "application/octet-stream" },
             confidence: magic ? 1.0 : 0.5, warnings: [], metrics: {} };
  }
}
```

Une divergence entre type déclaré et type réel n'est pas une erreur : c'est une information. Elle est enregistrée, jamais tue.

## 5.2 extract-text

L'étape la plus lourde du pipeline. Stratégie choisie selon le type détecté.

| Type détecté | Extracteur | Confiance typique |
|---|---|---|
| PDF avec couche texte | Extraction native, ordre de lecture reconstruit | 0.90 – 0.99 |
| PDF image seule | OCR | 0.40 – 0.85 |
| PDF mixte | Natif + OCR sur les pages sans texte | Variable, par page |
| HTML | Analyse DOM, suppression du chrome | 0.85 – 0.95 |
| DOCX / ODT | Analyse XML native | 0.95 – 1.00 |
| Texte brut | Décodage direct | 1.00 |
| Image | OCR | 0.30 – 0.80 |

```
export interface ExtractedText {
  readonly text: string;
  readonly pages: ReadonlyArray<PageText>;
  readonly method: "native" | "ocr" | "hybrid" | "plain";
  readonly charCount: number;
  readonly pageCount: number;
  readonly hasTextLayer: boolean;
  readonly ocrPages: ReadonlyArray<number>;
}

export interface PageText {
  readonly pageNo: number;
  readonly text: string;
  readonly method: "native" | "ocr";
  readonly confidence: number;
  readonly blocks?: ReadonlyArray<TextBlock>;  // avec coordonnees
}
```

Le découpage par page n'est pas un détail d'implémentation : c'est ce qui permettra plus tard de citer une source à la page près, exigence courante en matière juridique.

## 5.3 Le cas du PDF

Le PDF est le format dominant du corpus visé, et le plus traître.

```
Ouvrir le PDF
  |
  +-- Chiffre et non ouvrable ?  -> echec deterministe, DLQ
  |
  +-- Pour chaque page :
        |
        +-- caracteres extraits > seuil (defaut 50) ?
        |     OUI -> extraction native, confiance 0.95
        |     NON -> page probablement image
        |             |
        |             +-- OCR autorise ?  OUI -> OCR, confiance selon moteur
        |                                 NON -> page vide, avertissement
        |
        +-- Reconstruire l'ordre de lecture (colonnes, encadres)
```

Pièges connus et traités explicitement :

| Piège | Symptôme | Traitement |
|---|---|---|
| Deux colonnes | Lignes entrelacées | Analyse de disposition avant concaténation |
| Filigrane | Texte parasite répété | Détection des motifs répétés inter-pages |
| En-têtes et pieds de page | Bruit sur chaque page | Détection par répétition, marqués mais conservés |
| Ligatures (`ﬁ`, `ﬂ`) | Mots cassés en recherche | Normalisation Unicode NFKC (5.4) |
| Césures de fin de ligne | « juri-\ndique » | Recollage conditionnel, avec journalisation |
| Polices sans table de correspondance | Texte illisible extrait | Détection du taux de caractères de remplacement, bascule OCR |

## 5.4 normalize

La normalisation est irréversible : elle est donc appliquée à une **copie**, jamais au texte brut extrait, qui est conservé séparément.

```
Ordre d'application, strictement fixe :

1. Decodage et validation UTF-8, remplacement des sequences invalides
2. Normalisation Unicode NFC (defaut) ou NFKC (mode recherche)
3. Uniformisation des fins de ligne -> \n
4. Suppression des caracteres de controle, hors \n et \t
5. Reduction des espaces multiples, hors indentation en debut de ligne
6. Recollage des cesures de fin de ligne, si le mot recolle est plausible
7. Uniformisation des guillemets et tirets  (mode recherche uniquement)
```

Deux profils de normalisation coexistent, et c'est délibéré :

| Profil | Usage | Perte |
|---|---|---|
| `fidelity` | Citation, affichage, archivage | Minimale : NFC seulement |
| `search` | Indexation, recherche plein texte | NFKC, ligatures éclatées, ponctuation unifiée |

Le profil `fidelity` sert à montrer le texte à un humain. Le profil `search` sert à le retrouver. Confondre les deux conduit soit à un texte affiché altéré, soit à un texte introuvable.

## 5.5 detect-language

```
export interface LanguageInfo {
  readonly primary: string;          // BCP-47
  readonly confidence: number;
  readonly candidates: ReadonlyArray<{ lang: string; score: number }>;
  readonly perSegment?: ReadonlyArray<{ range: [number, number]; lang: string }>;
}
```

La détection est effectuée sur le texte normalisé, par fenêtres, ce qui permet de repérer les documents multilingues — cas fréquent des textes officiels bilingues, où une détection globale renverrait un résultat faux avec une confiance élevée.

## 5.6 detect-structure

Structure, jamais sémantique. Le processeur identifie des formes, pas des significations.

```
export interface DocumentStructure {
  readonly headings: ReadonlyArray<{
    level: number; text: string; charOffset: number; pageNo?: number;
  }>;
  readonly paragraphs: ReadonlyArray<{ start: number; end: number }>;
  readonly lists:      ReadonlyArray<{ start: number; end: number; ordered: boolean }>;
  readonly tables:     ReadonlyArray<{ start: number; end: number; rows: number }>;
  readonly footnotes:  ReadonlyArray<{ marker: string; charOffset: number }>;
  readonly confidence: number;
}
```

Ce que ce processeur ne fait **pas**, et ne fera jamais : identifier un article, un considérant, une disposition abrogatoire, une entrée en vigueur. Ces notions sont juridiques. Les reconnaître exigerait une interprétation que le Volume I interdit au Framework.

## 5.7 segment

Segmentation destinée aux usages en aval, notamment vectoriels.

```
export interface SegmentationResult {
  readonly segments: ReadonlyArray<{
    readonly index: number;
    readonly text: string;
    readonly charStart: number;
    readonly charEnd: number;
    readonly pageStart?: number;
    readonly pageEnd?: number;
    readonly headingPath: ReadonlyArray<string>;  // contexte hierarchique
    readonly tokenEstimate: number;
  }>;
  readonly strategy: "structural" | "fixed" | "hybrid";
}
```

Politique par défaut : segmentation **structurelle** guidée par les titres détectés, avec repli sur une taille fixe avec recouvrement quand aucune structure n'est détectée. Chaque segment porte son `headingPath` et ses décalages de caractères, ce qui permet de remonter du segment au passage exact du document original.

> Un segment sans possibilité de retour à sa position dans le document source est inutilisable dans un contexte juridique : il produit une citation invérifiable. Les décalages ne sont donc pas optionnels.

---

# Chapitre 6 — Artefacts dérivés

## 6.1 Stockage

Les artefacts vivent dans un magasin séparé, jamais dans le Content Store.

```
data/
  objects/        <- COLLECTE, lecture seule pour le pipeline
  derived/
    <document_id[0:2]>/<document_id[2:4]>/<document_id>/
      v3/                            <- version du document
        pipeline@2.1.0/              <- version du pipeline
          text.raw.txt
          text.normalized.txt
          pages.json
          language.json
          structure.json
          segments.jsonl
          manifest.json
```

La séparation est physique, pas seulement logique. Elle permet :

- de monter `objects/` en lecture seule au niveau du système d'exploitation ;
- de supprimer `derived/` intégralement sans le moindre risque ;
- de sauvegarder les deux avec des politiques différentes — `derived/` n'a pas besoin d'être sauvegardé du tout.

## 6.2 Le manifeste d'artefacts

```
{
  "documentId": "9f2c...ab71",
  "versionNo": 3,
  "contentHash": "sha256:6b1d...f31",
  "pipelineId": "default",
  "pipelineVersion": "2.1.0",
  "processedAt": "2026-08-30T04:02:11.418Z",
  "durationMs": 8421,
  "stages": [
    { "name": "detect-type",      "processor": "type-detector@1.2.0",
      "status": "ok",      "confidence": 1.00, "durationMs": 12 },
    { "name": "extract-text",     "processor": "pdf-extractor@3.0.1",
      "status": "ok",      "confidence": 0.94, "durationMs": 6120,
      "metrics": { "pages": 42, "ocrPages": 3, "chars": 118422 } },
    { "name": "normalize",        "processor": "text-normalizer@1.1.0",
      "status": "ok",      "confidence": 1.00, "durationMs": 88 },
    { "name": "detect-language",  "processor": "lang-detector@2.0.0",
      "status": "ok",      "confidence": 0.98, "durationMs": 41 },
    { "name": "detect-structure", "processor": "structure@1.0.3",
      "status": "partial", "confidence": 0.61, "durationMs": 1902,
      "warnings": ["hierarchie de titres incoherente aux pages 18-21"] },
    { "name": "segment",          "processor": "segmenter@1.4.0",
      "status": "ok",      "confidence": 0.90, "durationMs": 258 }
  ],
  "overallConfidence": 0.61,
  "artifacts": {
    "text.raw.txt":        { "bytes": 121004, "sha256": "..." },
    "text.normalized.txt": { "bytes": 118422, "sha256": "..." },
    "segments.jsonl":      { "bytes": 134901, "sha256": "...", "count": 96 }
  }
}
```

La confiance globale est le **minimum** des confiances des étapes non optionnelles, jamais leur moyenne. Une moyenne dissimule le maillon faible ; c'est précisément le maillon faible qui détermine si l'on peut faire confiance au résultat.

## 6.3 Coexistence des versions de pipeline

Le chemin inclut la version du pipeline, ce qui permet à plusieurs générations de coexister :

```
derived/9f/2c/9f2c...ab71/v3/
    pipeline@2.0.0/     <- ancienne, encore servie
    pipeline@2.1.0/     <- nouvelle, en cours de validation
```

Bénéfices : comparaison A/B de deux versions d'extraction sur un même corpus, retour arrière instantané, retraitement progressif sans interruption de service.

---

# Chapitre 7 — Retraitement

## 7.1 Déclencheurs

| Déclencheur | Portée | Priorité |
|---|---|---|
| Nouvelle version d'un document | Ce document | Normale |
| Version majeure d'un processeur | Tous les documents concernés | Basse |
| Version mineure d'un processeur | Documents de confiance < 0.9 | Basse |
| Correctif d'anomalie | Documents en file de lettres mortes | Élevée |
| Demande manuelle | Sélection explicite | Selon la demande |

## 7.2 Retraitement progressif

Un retraitement complet ne doit jamais bloquer le traitement des documents nouvellement collectés.

```
lcf reprocess --pipeline default --to-version 2.2.0 \
              --filter "confidence < 0.7" \
              --rate 500/hour --priority low

  -> enfile progressivement
  -> les nouveaux documents restent prioritaires
  -> les artefacts existants restent servis jusqu'a remplacement
  -> interruptible et reprenable a tout moment
```

## 7.3 Politique de version des processeurs

| Changement | Incrément | Retraitement |
|---|---|---|
| Correction sans effet sur la sortie | Patch | Aucun |
| Amélioration de qualité, sortie compatible | Mineur | Optionnel, ciblé |
| Changement de format ou de sémantique de sortie | Majeur | Complet |

Cette discipline n'a de valeur que si le déterminisme est réel : si un processeur produit des sorties variables à version constante, la version cesse de dire quoi que ce soit sur le contenu des artefacts.

---

# Chapitre 8 — Observabilité du pipeline

## 8.1 Métriques

| Métrique | Type | Usage |
|---|---|---|
| `pipeline_tasks_pending` | Jauge | Détection de saturation |
| `pipeline_task_duration_seconds` | Histogramme | Répartition par étape |
| `pipeline_stage_failures_total` | Compteur | Par étape et classe d'erreur |
| `pipeline_confidence` | Histogramme | Qualité globale du corpus |
| `pipeline_ocr_pages_total` | Compteur | Coût de l'OCR |
| `pipeline_dlq_size` | Jauge | Limites non traitées |
| `pipeline_throughput_docs` | Compteur | Débit effectif |

## 8.2 La métrique qui compte vraiment

La répartition des scores de confiance est le meilleur indicateur de santé du pipeline — bien meilleur que le taux d'erreur.

```
lcf pipeline stats --histogram confidence

  0.95-1.00  ################################  62.1%   797 218
  0.90-0.95  ############                      24.8%   318 477
  0.70-0.90  #####                              9.4%   120 789
  0.40-0.70  #                                  2.9%    37 264
  0.00-0.40                                     0.8%    10 271

  Documents needs_review : 47 535
  Principale cause       : PDF sans couche texte (28 901)
```

Un pipeline sans erreur mais dont 30 % des documents ont une confiance inférieure à 0,7 est un pipeline défaillant. Le taux d'erreur ne l'aurait jamais montré.

## 8.3 Traçabilité d'une extraction

Toute affirmation du pipeline doit pouvoir être remontée jusqu'à son origine :

```
lcf explain --document 9f2c...ab71 --stage extract-text

Document      : 9f2c...ab71  version 3
Content hash  : sha256:6b1d...f31
Fichier       : objects/6b/1d/6b1d...f31.bin  (482 911 octets, PDF)

extract-text  : pdf-extractor@3.0.1
  methode     : hybrid
  pages       : 42  (39 natives, 3 OCR)
  confiance   : 0.94  (minimum sur les pages : 0.71, page 18)
  duree       : 6 120 ms
  avertissements :
    - page 18 : couche texte absente, OCR applique
    - page 19 : idem
    - page 20 : idem
  sortie      : derived/9f/2c/.../v3/pipeline@2.1.0/text.raw.txt
```

---

# Chapitre 9 — Performance

## 9.1 Objectifs

| Opération | Cible | Remarque |
|---|---|---|
| PDF natif, 50 pages | < 3 s | Monofil |
| PDF OCR, 50 pages | < 90 s | Dominé par l'OCR |
| HTML, 100 Kio | < 200 ms | |
| Normalisation, 1 Mio de texte | < 150 ms | |
| Détection de langue | < 50 ms | Échantillonnage, texte non intégral |
| Segmentation, 1 Mio | < 300 ms | |
| Débit global, 8 travailleurs | > 2 000 doc/h | Corpus mixte sans OCR |

## 9.2 Coût comparé

L'OCR domine tout le reste d'un ordre de grandeur.

```
Repartition typique du temps CPU sur un corpus mixte :

  OCR                  ###################################  71%
  Extraction PDF       ##########                           19%
  Structure             ###                                  6%
  Segmentation          #                                    2%
  Normalisation                                              1%
  Detection langue                                           1%
```

Trois conséquences opérationnelles : l'OCR est désactivable par configuration ; il est plafonné par un quota horaire ; ses résultats sont mis en cache par empreinte de page et non par document, ce qui évite de re-océriser une page d'en-tête identique répétée dans des milliers de documents.

---

# Chapitre 10 — Critères d'acceptation du Volume V

## AC-5.1 — Étanchéité en écriture

```
ETANT DONNE le pipeline en cours d'execution
QUAND un processeur tente d'ecrire dans data/objects/
ALORS l'operation echoue immediatement
  ET aucun octet du Content Store n'est modifie
  ET l'incident est journalise comme violation de contrat
```

## AC-5.2 — Reconstructibilité

```
ETANT DONNE un corpus entierement traite
QUAND le repertoire data/derived/ est integralement supprime
ALORS aucun document original n'est affecte
  ET `lcf reprocess --all` reconstruit tous les artefacts
  ET les artefacts reconstruits sont identiques aux precedents
```

## AC-5.3 — Déterminisme

```
ETANT DONNE un document et une version de pipeline fixee
QUAND il est traite deux fois
ALORS les empreintes de tous les artefacts sont identiques
  ET les scores de confiance sont identiques
  ET les metriques rapportees sont identiques
```

## AC-5.4 — Dégradation gracieuse

```
ETANT DONNE un document dont detect-structure echoue
QUAND le pipeline se termine
ALORS text.normalized.txt existe et est valide
  ET structure.json est absent
  ET le statut de l'etape est 'failed', le statut du document 'partial'
  ET le document reste exportable
```

## AC-5.5 — Isolement des pannes

```
ETANT DONNE un processeur qui provoque une erreur fatale du travailleur
QUAND il traite un document
ALORS le bail expire et la tache est reprise par un autre travailleur
  ET apres N tentatives elle passe en file de lettres mortes
  ET les autres documents continuent d'etre traites
  ET aucune collecte n'est affectee
```

## AC-5.6 — Idempotence de la mise en file

```
ETANT DONNE le meme evenement lcf.document.stored emis dix fois
QUAND l'ingestor les traite
ALORS une seule tache existe pour ce (document, version, pipeline)
  ET le document n'est traite qu'une fois
```

## AC-5.7 — Traçabilité des segments

```
ETANT DONNE un segment issu de segments.jsonl
QUAND on applique charStart et charEnd au texte normalise
ALORS on obtient exactement le texte du segment
  ET pageStart identifie la page correcte du PDF original
```

## AC-5.8 — Priorité de la collecte

```
ETANT DONNE un pipeline sature a 100 000 taches en attente
QUAND une collecte demarre
ALORS elle s'execute sans degradation mesurable
  ET les nouveaux documents sont enfiles sans blocage
  ET la charge CPU du pipeline reste bornee a cpuCount - 1
```

---

# Chapitre 11 — Décisions d'architecture du Volume V

## ADR-501 — Séparation physique collecte / traitement

**Statut** : Accepté · **Contexte** : Le traitement est expérimental par nature et évoluera constamment ; la collecte doit être stable pendant quinze ans.
**Décision** : Deux magasins, deux files, deux cycles de vie, couplés par un unique événement.
**Conséquences** : + Le pipeline est remplaçable sans risque pour le corpus. − Duplication apparente d'infrastructure, jugée acceptable.

## ADR-502 — Le DAG plutôt que la chaîne

**Statut** : Accepté · **Contexte** : Certaines étapes sont indépendantes ; les enchaîner séquentiellement gaspille du temps.
**Décision** : Pipeline déclaré comme graphe acyclique, avec étapes optionnelles.
**Conséquences** : + Parallélisme, dégradation gracieuse, extensibilité. − Ordonnanceur plus complexe qu'une simple boucle.

## ADR-503 — Score de confiance obligatoire

**Statut** : Accepté · **Contexte** : Une extraction est une estimation, jamais un fait.
**Décision** : Tout `ProcessorResult` porte une confiance dans `[0,1]` ; la confiance globale est le minimum des étapes requises.
**Conséquences** : + Les consommateurs peuvent filtrer, la qualité devient mesurable. − Chaque processeur doit produire une estimation défendable, ce qui est un travail de conception réel.

## ADR-504 — Deux profils de normalisation

**Statut** : Accepté · **Contexte** : Fidélité d'affichage et efficacité de recherche sont des objectifs contradictoires.
**Décision** : Produire `text.raw`, `fidelity` et `search` comme artefacts distincts.
**Conséquences** : + Chaque usage dispose du texte adapté. − Espace disque supplémentaire, sur des artefacts jetables.

## ADR-505 — Version du pipeline dans le chemin d'artefact

**Statut** : Accepté · **Contexte** : Le retraitement doit pouvoir être progressif et réversible.
**Décision** : Les artefacts sont rangés sous `pipeline@<version>/`.
**Conséquences** : + Coexistence, comparaison A/B, retour arrière instantané. − Occupation temporaire doublée pendant une transition.

## ADR-506 — Baux plutôt que verrous

**Statut** : Accepté · **Contexte** : Un travailleur peut mourir à tout moment.
**Décision** : Les tâches sont prises sous bail expirant, renouvelé par le travailleur actif.
**Conséquences** : + Aucun blocage permanent, reprise automatique. − Une tâche peut être exécutée deux fois si un bail expire à tort, sans conséquence car les processeurs sont purs.

---

# Synthèse du Volume V

Le Volume V a construit la moitié faillible du système, et l'a construite pour qu'elle puisse échouer sans dommage.

Le pipeline lit sans jamais écrire dans le corpus. Il produit des artefacts explicitement jetables, rangés sous la version du pipeline qui les a produits, et donc remplaçables sans perte. Il attache à chaque résultat un score de confiance qui rend la qualité mesurable au lieu de la laisser supposée. Il se dégrade par étapes plutôt que de tomber d'un bloc. Il cède toujours la priorité à la collecte, parce qu'un document non extrait se rattrape et qu'un document non collecté est perdu.

Et il s'arrête là où commence l'interprétation. Le Framework dit ce qu'un document contient et où il le contient. Il ne dira jamais ce qu'un document signifie — cette frontière, posée au Volume I, est la seule qui ne fera jamais l'objet d'une révision.

**Volume VI — Security, Compliance & Legal Constraints** traitera de la surface d'attaque, du modèle de menaces, de la gestion des secrets, de la conduite responsable de la collecte, des aspects juridiques de la constitution d'un corpus documentaire, et de la chaîne de confiance de bout en bout.
