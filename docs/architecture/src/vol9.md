@TITLE: Legal Collection Framework
@SUBTITLE: Software Architecture Specification
@VOLUME: VOLUME IX — Governance, Roadmap & Decision Records
@VERSION: 0.9 (Draft)

# Préambule du Volume IX

Les huit volumes précédents décrivent un système. Le Volume IX décrit **les conditions dans lesquelles ce système peut vivre quinze ans**.

C'est une question distincte. Un logiciel de longue durée ne meurt presque jamais d'un défaut technique : il meurt d'une érosion de gouvernance. Le mainteneur principal part. Les décisions ne sont plus documentées. Les exceptions s'accumulent jusqu'à ce que les règles n'aient plus de sens. Une rupture de compatibilité mal conduite fait fuir les contributeurs. La spécification et le code divergent lentement, puis brutalement.

Le Volume IX traite ces risques comme ce qu'ils sont : des risques d'architecture, au même titre qu'une contention de verrou ou une fuite mémoire.

> Principe du Volume IX : ce qui n'est pas écrit disparaît avec la personne qui le savait. La gouvernance est le mécanisme par lequel un projet cesse de dépendre de la mémoire de quelqu'un.

## Portée

- Les principes de gouvernance et la répartition des décisions.
- Le processus de contribution et de revue.
- La politique de version, de dépréciation et de retrait.
- La feuille de route par paliers, avec critères de sortie.
- Le registre consolidé des décisions d'architecture des neuf volumes.
- Les conditions de révision de la présente spécification.
- La stratégie de continuité, y compris en cas de fin de projet.

---

# Chapitre 1 — Gouvernance

## 1.1 Trois cercles de décision

```
   +-----------------------------------------------------+
   |  NOYAU — modification exceptionnelle                 |
   |  Contrats, invariants, modele de stockage            |
   |  Decision : consensus des mainteneurs + ADR          |
   +-----------------------------------------------------+
   |  PERIPHERIE — evolution reguliere                    |
   |  Processeurs, adaptateurs, CLI, outils               |
   |  Decision : revue par un mainteneur                  |
   +-----------------------------------------------------+
   |  EXTENSIONS — libre                                  |
   |  Plugins, integrations, consommateurs                |
   |  Decision : leurs auteurs                            |
   +-----------------------------------------------------+
```

## 1.2 Ce qui appartient au noyau

Toute modification de ces éléments exige un ADR accepté et le consensus des mainteneurs :

| Élément | Volume |
|---|---|
| Le contrat `SourcePlugin` et `apiVersion` | III |
| Les formules de `document_id` et `content_hash` | IV |
| Les sept invariants de stockage | IV |
| Le protocole d'écriture atomique | IV |
| Le format des événements publics | III |
| La frontière collecte / traitement | V |
| Le modèle de capacités | III, VI |
| Le format du journal d'audit | VI |

## 1.3 Rôles

| Rôle | Attributions | Nombre visé |
|---|---|---|
| Mainteneur | Fusionne, publie, tranche sur le noyau | 3 à 5 |
| Réviseur | Revue de la périphérie | 5 à 15 |
| Contributeur | Propose des modifications | Illimité |
| Auteur de plugin | Publie des extensions | Illimité |

Le nombre minimal de trois mainteneurs n'est pas indicatif. En dessous, le projet est un point de défaillance unique. La règle en découle : **un projet à un seul mainteneur actif est en état d'alerte**, et la recherche de renfort devient prioritaire sur toute autre tâche.

## 1.4 Résolution des désaccords

```
1. Discussion technique publique, dans l'issue ou la proposition
2. Recherche de consensus  (defaut : le statu quo l'emporte)
3. Si le desaccord persiste : redaction d'un ADR presentant les options
4. Vote des mainteneurs, majorite simple
5. L'ADR consigne la decision ET les objections
```

L'étape 5 mérite d'être soulignée. Un ADR qui ne consigne que la décision retenue perd l'information la plus utile : ce que les opposants craignaient. Trois ans plus tard, quand la crainte se réalise, le registre doit permettre de retrouver qui l'avait anticipée et pourquoi.

---

# Chapitre 2 — Contribution

## 2.1 Cheminement d'une modification

```
Idee
  |
  +-- Touche le noyau ?
  |     OUI -> Issue de discussion -> ADR propose -> consensus -> code
  |     NON -> continuer
  |
  +-- Ecrire le code + les tests
  |
  +-- Portes locales : lint, types, tests unitaires
  |
  +-- Proposition de fusion
  |     -> integration continue complete (Volume VIII, 11.1)
  |     -> revue humaine
  |
  +-- Fusion
```

## 2.2 Grille de revue

Toute revue examine ces sept points, dans cet ordre :

| # | Question | Volume de référence |
|---|---|---|
| 1 | Un invariant est-il affaibli ? | I, IV |
| 2 | Une donnée peut-elle être perdue par ce changement ? | IV |
| 3 | Un contrat public est-il modifié ? | III |
| 4 | Les erreurs sont-elles honnêtes ? | III, 8.3 |
| 5 | Les tests couvrent-ils les cas de panne, pas seulement le cas nominal ? | VIII |
| 6 | Le noyau reste-t-il ignorant des sources ? | I, 9 |
| 7 | La modification est-elle réversible ? | IX, 3 |

Les questions 1, 2 et 6 sont bloquantes. Une réponse défavorable interrompt la revue : la discussion se déplace vers un ADR, elle ne se poursuit pas dans les commentaires de la proposition.

## 2.3 Conventions de validation

```
feat(storage): ajout de la compression zstd pour le contenu texte
fix(plugin): correction de la stabilite du nativeId sur les index pagines
docs(vol4): precision du protocole d'ecriture atomique
refactor(kernel): extraction du RateLimiter hors du HttpClient
test(integrity): couverture des six points de panne
perf(pipeline): mise en cache OCR par empreinte de page
break(api): retrait de l'apiVersion 1.x du contrat de plugin
```

Le préfixe `break` déclenche automatiquement le processus du chapitre 3. Il ne peut être employé que dans une proposition accompagnée d'un ADR accepté.

---

# Chapitre 3 — Version, dépréciation, retrait

## 3.1 Ce qui est versionné

| Élément | Schéma | Cadence de rupture |
|---|---|---|
| Kernel | SemVer | Rare |
| Contrat de plugin (`apiVersion`) | SemVer, majeure uniquement | Très rare |
| API HTTP | Version dans le chemin (`/api/v1`) | Très rare |
| Schéma de base | Entier croissant | Continue, sans rupture |
| Format d'événement | `specVersion` | Très rare |
| Format du magasin | `lcfObjectVersion` | Jamais visé |

## 3.2 Cycle de dépréciation

Aucun retrait n'est jamais immédiat.

```
T+0     Annonce  : la fonction est marquee depreciee, la date de retrait est fixee
        - documentation mise a jour
        - avertissement a l'execution, une fois par demarrage
        - guide de migration publie en meme temps que l'annonce
T+6m    Rappel   : avertissement a chaque usage
T+12m   Insistance : avertissement + mention dans le rapport de sante
T+24m   Retrait  : uniquement dans une version majeure
```

Durées minimales imposées :

| Élément retiré | Préavis minimal |
|---|---|
| Contrat de plugin (majeure) | 24 mois |
| API HTTP (majeure) | 24 mois |
| Option de configuration | 12 mois |
| Commande CLI | 12 mois |
| Champ d'événement | 12 mois |
| Détail interne | Aucun |

## 3.3 La règle du guide de migration

Une dépréciation sans guide de migration publié **le jour de l'annonce** est refusée. Sans guide, l'annonce ne transmet pas une information mais un problème, et l'écosystème l'ignore jusqu'au retrait — moment auquel il est trop tard.

```
docs/migration/v1-to-v2.md

  1. Ce qui change et pourquoi
  2. Ce qui casse, precisement
  3. Avant / apres, sur du code reel
  4. Outil de migration automatique, quand il est possible
  5. Comment verifier que la migration est reussie
  6. Comment revenir en arriere
```

## 3.4 Support des versions

| Version | Statut | Support |
|---|---|---|
| Majeure courante | Active | Correctifs, fonctions, sécurité |
| Majeure précédente | Maintenance | Correctifs et sécurité, 24 mois |
| Antérieures | Fin de vie | Aucun |

---

# Chapitre 4 — Feuille de route

La feuille de route est organisée en paliers, chacun avec des critères de sortie vérifiables. Aucun palier ne commence avant que le précédent ne soit clos.

## 4.1 Palier 0 — Socle

```
Objectif : le squelette execute de bout en bout, sur une seule source.

Contenu
  - Couche domaine et interfaces (Vol. II)
  - Content Store, protocole d'ecriture atomique (Vol. IV, 4-5)
  - Schema de base initial et migrations (Vol. IV, 3, 10)
  - Chargement de plugin, contrat minimal (Vol. III, 2)
  - Download Manager avec quotas et retry (Vol. II)
  - CLI : init, source add, run, status
  - Un plugin de reference, archetype A

Criteres de sortie
  [ ] AC-4.1, AC-4.2, AC-4.4 passent
  [ ] Les six points de panne du protocole d'ecriture sont testes
  [ ] Reindexation depuis le magasin, sans reseau, verifiee
  [ ] Couverture domaine > 90 %
```

## 4.2 Palier 1 — Robustesse

```
Objectif : le systeme survit a une exploitation reelle.

Contenu
  - Modele de capacites et bac a sable L1/L2 (Vol. III, 5)
  - Quarantaine et machine a etats des plugins (Vol. III, 6)
  - Verification d'integrite de fond et reparation (Vol. IV, 7)
  - Sauvegarde, restauration, exercice de restauration (Vol. IV, 9)
  - Journalisation structuree, metriques (Vol. VII, 2-3)
  - Modele d'attentes et alertes d'absence (Vol. VII, 1.2, 5.3)
  - lcf doctor (Vol. VII, 6.2)
  - Plugin Conformance Kit (Vol. III, 13)

Criteres de sortie
  [ ] AC-3.1, AC-3.2, AC-3.6, AC-4.7, AC-7.1, AC-7.3 passent
  [ ] La suite de plugins hostiles est integralement confinee
  [ ] 30 jours d'execution continue sans fuite ni derive
  [ ] Trois sources reelles collectees en continu pendant 30 jours
```

## 4.3 Palier 2 — Traitement

```
Objectif : le corpus devient exploitable.

Contenu
  - Pipeline en DAG, file persistante, baux (Vol. V, 2-3)
  - Extraction PDF native, HTML, formats bureautiques (Vol. V, 5.2-5.3)
  - Normalisation, deux profils (Vol. V, 5.4)
  - Detection de langue et de structure (Vol. V, 5.5-5.6)
  - Segmentation avec decalages (Vol. V, 5.7)
  - Corpus de reference et non-regression (Vol. VIII, 7)
  - Export JSONL

Criteres de sortie
  [ ] AC-5.1 a AC-5.8 passent
  [ ] Corpus de reference : 200 documents, confiance moyenne > 0.85
  [ ] Retraitement complet demontre, sans interruption de collecte
  [ ] Determinisme du pipeline verifie sur dix executions
```

## 4.4 Palier 3 — Échelle

```
Objectif : le systeme tient sur un grand corpus.

Contenu
  - Adaptateur PostgreSQL (Vol. IV, 11)
  - Magasin objet compatible S3 (Vol. VII, 7.4)
  - OCR avec quota et cache par page (Vol. V, 9.2)
  - API HTTP complete et webhooks (Vol. III, 11)
  - Isolement L3 par processus (Vol. III, 5.4)
  - Traces distribuees (Vol. VII, 4)

Criteres de sortie
  [ ] AC-4.9 passe : migration SQLite -> PostgreSQL sans perte
  [ ] 5 M documents, requetes dans les seuils du Vol. IV, 13.2
  [ ] 500 sources actives, echeancier stable
  [ ] Deploiement P4 documente et eprouve
```

## 4.5 Palier 4 — Confiance

```
Objectif : le corpus devient opposable.

Contenu
  - Journal d'audit chaine (Vol. VI, 8.3)
  - Ancrage externe RFC 3161 (Vol. VI, 8.4)
  - Attestation de document (Vol. VI, 8.5)
  - Signature de paquet de plugin (Vol. VI, 5.3)
  - Export BagIt (Vol. IV, 12.3)
  - Purge tracee avec pierres tombales (Vol. IV, 8.2)

Criteres de sortie
  [ ] AC-6.1 a AC-6.8 passent
  [ ] Audit de securite externe realise, conclusions traitees
  [ ] Chaine d'audit verifiee sur plus de 10 M d'entrees
  [ ] Exercice de sinistre complet reussi, chronometre
```

## 4.6 Au-delà

Ces sujets ne sont pas planifiés. Ils sont listés pour éviter qu'ils ne soient traités implicitement dans un palier antérieur.

| Sujet | Condition d'ouverture |
|---|---|
| Collecte fédérée entre instances | Plusieurs déploiements en production le demandent |
| Détection de similarité inter-documents | Palier 2 clos et stable |
| Interface web d'administration | Demande d'exploitation avérée |
| Extension du contrat au-delà des documents | Jamais sans ADR de rupture |

---

# Chapitre 5 — Registre consolidé des décisions

## 5.1 Format

Chaque ADR suit la même structure : contexte, décision, conséquences, statut. Les ADR sont immuables ; une décision révisée fait l'objet d'un nouvel ADR qui supersède l'ancien, lequel est conservé.

## 5.2 Registre

| ADR | Titre | Volume | Statut |
|---|---|---|---|
| 301 | Le plugin ne télécharge pas | III | Accepté |
| 302 | Interfaces optionnelles détectées structurellement | III | Accepté |
| 303 | `nativeId` au plugin, `document_id` au Kernel | III | Accepté |
| 304 | Pagination par curseur exclusivement | III | Accepté |
| 305 | Livraison des événements au moins une fois | III | Accepté |
| 401 | Magasin adressé par contenu | IV | Accepté |
| 402 | Descripteur auto-portant par objet | IV | Accepté |
| 403 | Séparation Document / Version / ContentObject | IV | Accepté |
| 404 | Fichier avant base | IV | Accepté |
| 405 | SQLite par défaut | IV | Accepté |
| 406 | Empreinte sur les octets décompressés | IV | Accepté |
| 501 | Séparation physique collecte / traitement | V | Accepté |
| 502 | DAG plutôt que chaîne | V | Accepté |
| 503 | Score de confiance obligatoire | V | Accepté |
| 504 | Deux profils de normalisation | V | Accepté |
| 505 | Version du pipeline dans le chemin d'artefact | V | Accepté |
| 506 | Baux plutôt que verrous | V | Accepté |
| 601 | Refus par défaut sur toutes les frontières | VI | Accepté |
| 602 | Secrets typés plutôt que chaînes | VI | Accepté |
| 603 | Journal d'audit chaîné | VI | Accepté |
| 604 | Absence de capacités de contournement | VI | Accepté |
| 605 | API locale, opérations destructives hors réseau | VI | Accepté |
| 701 | Attentes déclarées par source | VII | Accepté |
| 702 | Journaux structurés exclusivement | VII | Accepté |
| 703 | Observabilité sans dépendance externe | VII | Accepté |
| 704 | Pipeline subordonné à la collecte | VII | Accepté |
| 705 | Aucune sortie automatique de quarantaine | VII | Accepté |
| 801 | Fixtures enregistrées avec péremption | VIII | Accepté |
| 802 | Tests de propriétés pour les invariants | VIII | Accepté |
| 803 | Injection de fautes de premier plan | VIII | Accepté |
| 804 | Non-régression par seuils | VIII | Accepté |
| 805 | Table de couverture des invariants | VIII | Accepté |
| 901 | Gouvernance en trois cercles | IX | Accepté |
| 902 | Préavis de 24 mois sur les contrats publics | IX | Accepté |
| 903 | Spécification versionnée avec le code | IX | Accepté |
| 904 | Plan de fin de vie écrit dès le départ | IX | Accepté |

## 5.3 ADR du Volume IX

### ADR-901 — Gouvernance en trois cercles

**Contexte** : Une gouvernance uniforme impose soit une lourdeur excessive sur les changements triviaux, soit une légèreté dangereuse sur les changements structurants.
**Décision** : Trois cercles — noyau, périphérie, extensions — avec des exigences décroissantes.
**Conséquences** : + Les contrats sont protégés, les contributions courantes restent fluides. − Il faut arbitrer à quel cercle appartient un changement, arbitrage tranché par les mainteneurs en cas de doute.

### ADR-902 — Préavis de 24 mois sur les contrats publics

**Contexte** : Les plugins sont écrits par des tiers, souvent dans des institutions dont les cycles de mise à jour se comptent en années.
**Décision** : Toute rupture d'un contrat public suppose 24 mois de préavis, un adaptateur de compatibilité et un guide de migration.
**Conséquences** : + L'écosystème reste viable, le Framework reste adoptable par des organisations lentes. − Le rythme d'évolution du contrat est bridé, ce qui est le but recherché.

### ADR-903 — Spécification versionnée avec le code

**Contexte** : Une spécification maintenue à part diverge du code, et cesse d'être consultée dès lors qu'on ne peut plus lui faire confiance.
**Décision** : Les neuf volumes vivent dans le dépôt, sont modifiés dans les mêmes propositions de fusion que le code, et les critères d'acceptation sont reliés aux tests (Volume VIII, 11.3).
**Conséquences** : + La spécification reste vraie. − Toute modification de comportement impose de modifier la spécification, ce qui ralentit et discipline.

### ADR-904 — Plan de fin de vie écrit dès le départ

**Contexte** : La plupart des projets meurent sans plan, laissant leurs utilisateurs devant des données qu'ils ne savent plus lire.
**Décision** : Le chapitre 7 du présent volume définit ce qui se passe si le projet s'arrête, et il est écrit avant la première version publiée.
**Conséquences** : + Les adoptants savent quel risque ils prennent ; les formats sont conçus pour survivre au logiciel. − Exercice inconfortable, mais qui contraint utilement les choix de format.

---

# Chapitre 6 — Évolution de la spécification

## 6.1 Quand un volume doit être révisé

| Déclencheur | Action |
|---|---|
| Le code diverge de la spécification | Corriger l'un ou l'autre, jamais tolérer l'écart |
| Une décision est infirmée par l'expérience | Nouvel ADR superseding, volume mis à jour |
| Une contrainte externe change | Réviser le volume concerné |
| Un critère d'acceptation devient invérifiable | Le réécrire ou le retirer, avec justification |
| Une exception se répète trois fois | La règle est probablement fausse : la réviser |

Le dernier déclencheur est important. Une règle contournée systématiquement n'est pas une règle respectée avec des exceptions : c'est une règle fausse que l'on n'a pas encore osé réécrire.

## 6.2 Statut des volumes

| Volume | Titre | Statut |
|---|---|---|
| I | Vision, Product Definition, Core Architecture | Stable |
| II | Kernel Architecture | Stable |
| III | Plugin Contracts & Public API | Stable — gelé après le palier 1 |
| IV | Data Model, Storage & Versioning | Stable — gelé après le palier 0 |
| V | Processing Pipeline & Extraction Layer | Évolutif |
| VI | Security, Compliance & Trust Chain | Évolutif — révision annuelle |
| VII | Observability, Operations & Deployment | Évolutif |
| VIII | Testing Strategy & Quality Assurance | Évolutif |
| IX | Governance, Roadmap & Decision Records | Vivant |

« Gelé » signifie que toute modification exige un ADR de rupture et le cycle de dépréciation complet du chapitre 3. Les volumes III et IV sont les seuls dans ce cas, parce qu'ils portent les contrats sur lesquels reposent le corpus et l'écosystème.

## 6.3 Révision de sécurité annuelle

Le Volume VI fait l'objet d'une révision programmée chaque année, indépendamment de toute évolution du code :

```
1. Reexaminer le modele de menaces (Vol. VI, 1) a la lumiere de l'annee ecoulee
2. Verifier que les analyses automatisees couvrent les vecteurs connus
3. Reevaluer les hypotheses hors perimetre (Vol. VI, 1.3)
4. Verifier la validite des cles de signature et la rotation des secrets
5. Confirmer que les tests de securite couvrent les nouveaux formats supportes
```

---

# Chapitre 7 — Continuité et fin de vie

## 7.1 Risques de continuité

| Risque | Atténuation |
|---|---|
| Départ du mainteneur principal | Minimum de trois mainteneurs, décisions documentées en ADR |
| Perte de la connaissance implicite | Spécification versionnée avec le code (ADR-903) |
| Abandon d'une dépendance critique | Budget de dépendances du noyau (Vol. VI, 5.4) |
| Disparition du financement | Aucune infrastructure payante requise (Vol. I, 5) |
| Arrêt du projet | Chapitre 7.3 |

## 7.2 Ce qui protège l'utilisateur par conception

Ces propriétés, décidées pour d'autres raisons, constituent ensemble une assurance de continuité :

| Propriété | Volume | Effet en cas d'abandon |
|---|---|---|
| Magasin auto-descriptif | IV, 1.1 | Le corpus reste lisible sans le logiciel |
| Aucun format propriétaire | IV, 12 | Les données restent exploitables |
| Aucune dépendance à un service externe | I, 5 | Rien ne cesse de fonctionner à distance |
| Export BagIt | IV, 12.3 | Archivage patrimonial normalisé |
| Documentation en langage naturel dans l'archive | IV, 12.3 | Interprétable sans documentation technique |

Un utilisateur qui adopte le Framework n'engage donc pas son corpus sur la survie du projet. C'est la garantie la plus importante que ce volume puisse offrir.

## 7.3 Procédure d'arrêt

Si le projet devait cesser, la procédure suivante s'applique, dans cet ordre :

```
1. Annoncer publiquement, avec une date d'arret effective, au moins 12 mois avant
2. Publier une derniere version de maintenance, avec correctifs de securite
3. Publier un guide d'export vers des formats neutres
4. Verifier que la commande d'export BagIt fonctionne sur les corpus existants
5. Archiver le depot en lecture seule, avec la specification complete
6. Publier la liste des instances connues, si leurs operateurs y consentent
7. Transferer, si possible, a une organisation d'accueil
```

Les points 3 et 4 sont les seuls qui comptent réellement pour les utilisateurs. Tout le reste est de la courtoisie.

## 7.4 Conditions de reprise

Le projet est publié sous licence permissive, la spécification est intégrale et versionnée, les formats sont documentés, et le corpus reste lisible sans le logiciel. Ces quatre conditions suffisent à ce qu'un tiers puisse reprendre le projet, ou en écrire un nouveau capable de lire les corpus existants.

C'est la seule définition défendable de la pérennité pour un logiciel libre : non pas la promesse qu'il durera, mais la garantie que sa disparition ne détruit rien.

---

# Chapitre 8 — Critères d'acceptation du Volume IX

## AC-9.1 — Traçabilité des décisions

```
ETANT DONNE une modification touchant un element du noyau (Vol. IX, 1.2)
QUAND elle est proposee a la fusion
ALORS l'integration continue exige un ADR accepte la referencant
  ET la fusion est bloquee en son absence
```

## AC-9.2 — Cohérence spécification / code

```
ETANT DONNE un critere d'acceptation d'un volume quelconque
QUAND on execute lcf test --invariant-coverage
ALORS il est associe a au moins un test nomme
  ET l'integration continue echoue si un critere devient orphelin
```

## AC-9.3 — Respect du cycle de dépréciation

```
ETANT DONNE une fonction depreciee il y a moins de 24 mois
QUAND une proposition tente de la retirer
ALORS l'integration continue rejette la modification
  ET indique la date de retrait autorisee
```

## AC-9.4 — Guide de migration obligatoire

```
ETANT DONNE une proposition marquee break(...)
QUAND elle est soumise
ALORS un fichier docs/migration/*.md doit l'accompagner
  ET la fusion est bloquee en son absence
```

## AC-9.5 — Survie du corpus au logiciel

```
ETANT DONNE un corpus produit par la version courante
QUAND on ne dispose que du repertoire data/ et de la specification
ALORS le corpus est interpretable sans aucun binaire du projet
  ET les descripteurs suffisent a reconstruire l'integralite de l'index
```

## AC-9.6 — Critères de sortie de palier

```
ETANT DONNE un palier de la feuille de route
QUAND il est declare clos
ALORS tous ses criteres de sortie sont verifies automatiquement
  ET le rapport correspondant est archive dans le depot
```

---

# Chapitre 9 — Épilogue de la spécification

## 9.1 Ce que couvrent les neuf volumes

| Volume | Objet | Question traitée |
|---|---|---|
| I | Vision et charte | Pourquoi, et selon quels principes |
| II | Kernel | Comment le noyau est bâti |
| III | Contrats et API | Où se situent les frontières |
| IV | Données et stockage | Ce qui doit survivre |
| V | Traitement | Ce qui peut être refait |
| VI | Sécurité et confiance | Ce qui doit être prouvé |
| VII | Exploitation | Comment on conduit le système |
| VIII | Tests | Comment on vérifie les affirmations |
| IX | Gouvernance | Comment tout cela dure |

## 9.2 Les cinq décisions qui structurent tout le reste

Si l'on ne devait retenir que cinq choix de cette spécification :

1. **Le noyau ignore les sources.** Aucune URL, aucun format juridique, aucun pays dans le cœur. Toute source est un plugin. C'est ce qui permet au Framework de servir n'importe quelle juridiction sans être réécrit.
2. **Le plugin ne télécharge pas.** Il décrit ce qu'il faut chercher ; le Kernel le fait. Quotas, réessais, intégrité et politesse sont ainsi garantis par construction, et non par la discipline de centaines de contributeurs.
3. **Le magasin est adressé par contenu et auto-descriptif.** Déduplication, immuabilité, vérifiabilité et reconstructibilité découlent d'un seul choix. La base de données devient un cache, jamais un point de défaillance unique.
4. **La collecte et le traitement sont deux systèmes.** L'un produit de l'irremplaçable, l'autre du reconstructible. Les séparer physiquement permet de faire évoluer le second sans jamais risquer le premier.
5. **Le mode de panne dominant est l'absence.** Un collecteur cassé ne produit pas d'erreurs : il ne produit rien. Le modèle d'attentes existe pour détecter ce qui n'arrive pas, et c'est la seule protection réelle contre l'arrêt silencieux d'un corpus.

## 9.3 Ce que le Framework ne fera jamais

Cette liste a autant de valeur normative que les fonctions spécifiées :

- interpréter le sens juridique d'un document ;
- modifier un document original ;
- contourner une protection technique — CAPTCHA, authentification, limitation de débit ;
- supprimer des données comme effet de bord d'une opération courante ;
- émettre la moindre donnée vers l'extérieur sans configuration explicite de son opérateur ;
- dépendre d'un service en ligne pour fonctionner.

## 9.4 Mot de la fin

Cette spécification décrit un système conçu pour être ennuyeux au bon endroit.

Le noyau est petit, contraint et difficile à modifier, précisément pour que les plugins puissent être nombreux, variés et faciles à écrire. Le stockage est conservateur jusqu'à l'excès, précisément pour que le traitement puisse être audacieux et jetable. La gouvernance est lente sur les contrats, précisément pour que les contributions courantes restent rapides.

Chacun de ces déséquilibres est délibéré. Ils reposent tous sur la même observation : dans un système de collecte documentaire, ce qui est perdu ne se retrouve pas, et ce qui est mal collecté ne se corrige qu'en le recollectant — parfois auprès d'une source qui n'existe plus.

Un document officiel publié aujourd'hui, correctement collecté, correctement daté, correctement vérifié, sera encore lisible dans trente ans. C'est le seul objectif de ces neuf volumes.

---

# Annexe A — Index des critères d'acceptation

| Référence | Objet | Volume |
|---|---|---|
| AC-3.1 à AC-3.8 | Contrats de plugin, capacités, compatibilité | III |
| AC-4.1 à AC-4.9 | Atomicité, reconstruction, versions, migrations | IV |
| AC-5.1 à AC-5.8 | Pipeline, déterminisme, isolement, traçabilité | V |
| AC-6.1 à AC-6.8 | SSRF, contenu hostile, secrets, audit | VI |
| AC-7.1 à AC-7.7 | Détection d'absence, diagnostic, reprise | VII |
| AC-8.1 à AC-8.7 | Couverture, déterminisme, fixtures, non-régression | VIII |
| AC-9.1 à AC-9.6 | Gouvernance, dépréciation, survie du corpus | IX |

Total : **53 critères d'acceptation**, tous reliés à des tests nommés par la table de couverture du Volume VIII, section 11.3.

# Annexe B — Index des invariants

| Réf. | Invariant | Volume |
|---|---|---|
| I-1 | Immuabilité du contenu stocké | IV |
| I-2 | Atomicité de l'écriture | IV |
| I-3 | Vérifiabilité par empreinte | IV |
| I-4 | Auto-description du magasin | IV |
| I-5 | Traçabilité de toute écriture | IV |
| I-6 | Non-destruction par les opérations courantes | IV |
| I-7 | Portabilité de la disposition physique | IV |
| R-1 | Le pipeline n'écrit jamais dans le Content Store | V |
| R-2 | Tout artefact dérivé est reconstructible | V |
| R-3 | Un échec de traitement n'affecte pas la collecte | V |
| R-4 | Le pipeline n'interprète jamais le sens juridique | V |

# Annexe C — Glossaire

| Terme | Définition |
|---|---|
| ADR | Architecture Decision Record — décision consignée, immuable |
| Artefact dérivé | Produit du pipeline, toujours reconstructible |
| Attente | Comportement déclaré d'une source, servant de référence d'alerte |
| CAS | Content-Addressable Store — magasin adressé par empreinte |
| Content Store | Magasin des octets originaux, immuable |
| ContentObject | Suite d'octets identifiée par son empreinte |
| DocumentRef | Descripteur produit par un plugin lors de la découverte |
| FetchPlan | Instruction déclarative de récupération, exécutée par le Kernel |
| Kernel | Noyau du Framework, ignorant de toute source |
| nativeId | Identifiant stable d'un document dans sa source |
| Palier | Étape de la feuille de route, avec critères de sortie |
| Pierre tombale | Trace d'une suppression, conservée à la place du contenu |
| Quarantaine | Suspension d'une source après panne, sans perte de données |
| Version (document) | État daté du contenu d'un document |
