@TITLE: Legal Collection Framework
@SUBTITLE: Software Architecture Specification
@VOLUME: VOLUME VII — Observability, Operations & Deployment
@VERSION: 0.7 (Draft)

# Préambule du Volume VII

Les six premiers volumes décrivent un système qui fonctionne. Le Volume VII décrit un système que l'on peut **conduire** — c'est-à-dire dont on sait, à tout instant, s'il fait ce qu'il doit faire, et pourquoi il ne le fait pas quand il échoue.

Cette distinction est décisive pour un collecteur documentaire, à cause d'une propriété particulière : **il échoue silencieusement**.

Un serveur web qui tombe génère des erreurs immédiates et visibles. Un collecteur qui cesse de trouver des documents ne génère rien du tout. Il continue de s'exécuter, se termine avec succès, rapporte zéro nouveau document, et attend le lendemain. Après six mois, on découvre que le corpus s'est arrêté en mars.

> Axiome du Volume VII : le mode de panne dominant de ce système n'est pas l'erreur, c'est l'absence. L'observabilité doit donc être conçue pour détecter ce qui **ne se produit pas**, et non seulement ce qui échoue.

## Portée

- Journalisation structurée et corrélation.
- Métriques, et la distinction entre métriques d'activité et métriques d'absence.
- Traces d'exécution.
- Alertes, et la discipline nécessaire pour qu'elles restent crédibles.
- Contrôles de santé et diagnostic.
- Profils de déploiement, du poste isolé au serveur mutualisé.
- Configuration et sa validation.
- Procédures d'exploitation et manuel d'astreinte.
- Mise à niveau, retour arrière et reprise après sinistre.

---

# Chapitre 1 — Les trois piliers, et le quatrième

## 1.1 Ce que couvre chaque pilier

| Pilier | Répond à | Granularité | Rétention |
|---|---|---|---|
| Journaux | Que s'est-il passé exactement ? | Événement | 90 jours |
| Métriques | Dans quel état est le système ? | Agrégat | 13 mois |
| Traces | Où le temps a-t-il été passé ? | Requête | 7 jours |
| **Attentes** | Ce qui devait arriver est-il arrivé ? | Contrat | Permanent |

Le quatrième pilier est propre à ce système. Il ne s'agit pas d'observer ce qui se passe, mais de comparer ce qui se passe à ce qui **devrait** se passer.

## 1.2 Le modèle d'attentes

Chaque source déclare son comportement attendu. Le système compare en continu, et alerte sur l'écart.

```
sources:
  - id: xx.gazette.official
    expectations:
      runsAtLeastEvery: 26h            # une collecte quotidienne + marge
      discoversAtLeast: 1              # par semaine ouvree
      typicalDocsPerRun: { min: 0, max: 200 }
      failureRateBelow: 0.05
      medianDocumentBytes: { min: 20000, max: 5000000 }
```

Les alertes qui en découlent sont d'une nature différente des alertes classiques :

| Attente violée | Signification probable |
|---|---|
| Aucune exécution depuis 26 h | L'échéancier est arrêté |
| Aucune découverte depuis 7 jours | Le site a changé de structure |
| 3 000 documents au lieu de 50 | Le `nativeId` est devenu instable, doublons massifs |
| Taille médiane divisée par 10 | La source sert des pages d'erreur à la place des PDF |
| Taux d'échec à 40 % | La source limite le débit, ou exige désormais une authentification |

Aucune de ces situations ne produit d'erreur applicative. Toutes sont des pannes graves. C'est exactement ce que le modèle d'attentes est conçu pour attraper.

---

# Chapitre 2 — Journalisation structurée

## 2.1 Format

JSON en ligne, un objet par événement, jamais de message en texte libre destiné à être analysé par une expression régulière.

```
{
  "ts": "2026-08-30T03:14:07.221Z",
  "level": "info",
  "msg": "document stored",
  "logger": "storage.manager",
  "runId": "run_01J9X3S9",
  "sourceId": "xx.gazette.official",
  "documentId": "9f2c...ab71",
  "contentHash": "sha256:6b1d...f31",
  "versionNo": 3,
  "bytes": 482911,
  "durationMs": 41,
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

## 2.2 Discipline des niveaux

Le choix des niveaux détermine si les journaux restent lisibles à l'échelle de millions de documents.

| Niveau | Emploi | Volume attendu |
|---|---|---|
| `error` | Intervention humaine nécessaire | Quelques unités par jour |
| `warn` | Anomalie tolérée, à surveiller | Quelques dizaines par jour |
| `info` | Faits significatifs du domaine | 1 à 3 par document |
| `debug` | Diagnostic, désactivé par défaut | Élevé |
| `trace` | Développement uniquement | Très élevé |

Règle stricte : **une entrée `error` doit correspondre à une action possible**. Une erreur que l'on ne peut que constater est un `warn`. Sans cette discipline, le niveau `error` se remplit de bruit, et devient inutilisable au moment précis où l'on en a besoin.

## 2.3 Champs de corrélation obligatoires

| Champ | Présent quand | Rôle |
|---|---|---|
| `runId` | Toute opération de collecte | Reconstituer une exécution complète |
| `sourceId` | Toute opération liée à une source | Isoler une source |
| `documentId` | Toute opération documentaire | Suivre un document de bout en bout |
| `traceId` | Toute requête d'API | Relier journaux et traces |
| `taskId` | Toute opération du pipeline | Suivre un traitement |

```
lcf logs --run run_01J9X3S9 --level warn
lcf logs --document 9f2c...ab71 --all-time
lcf logs --source xx.gazette.official --since 24h --grep "structure"
```

## 2.4 Ce qui ne va jamais dans un journal

- La valeur d'un secret, quel que soit le niveau (Volume VI, chapitre 4).
- Le contenu d'un document.
- Un extrait de contenu susceptible de contenir des données personnelles.
- Une URL contenant des identifiants d'authentification.

---

# Chapitre 3 — Métriques

## 3.1 Métriques d'activité

```
# Collecte
lcf_runs_total{source,mode,status}                      counter
lcf_run_duration_seconds{source,mode}                   histogram
lcf_documents_discovered_total{source}                  counter
lcf_documents_stored_total{source,outcome}              counter
lcf_document_versions_created_total{source,reason}      counter
lcf_bytes_downloaded_total{source}                      counter
lcf_http_requests_total{source,status_class}            counter
lcf_http_request_duration_seconds{source}               histogram

# Stockage
lcf_content_objects_total                               gauge
lcf_store_bytes_total                                   gauge
lcf_store_dedup_ratio                                   gauge
lcf_integrity_checks_total{result}                      counter

# Pipeline
lcf_pipeline_tasks{state}                               gauge
lcf_pipeline_stage_duration_seconds{stage}              histogram
lcf_pipeline_confidence                                 histogram
lcf_pipeline_dlq_size                                   gauge

# Plugins
lcf_plugins_loaded{trust_level}                         gauge
lcf_plugin_quarantined_total{source,reason}             counter
```

## 3.2 Métriques d'absence

Ce sont celles qui détectent le mode de panne dominant.

```
lcf_seconds_since_last_run{source}                      gauge
lcf_seconds_since_last_success{source}                  gauge
lcf_seconds_since_last_new_document{source}             gauge
lcf_expectation_violations{source,expectation}          gauge
lcf_sources_never_succeeded                             gauge
```

`lcf_seconds_since_last_new_document` est la métrique la plus importante du système. Une valeur qui croît indéfiniment sur une source active signifie que la collecte s'exécute correctement et ne trouve plus rien — c'est-à-dire qu'elle est cassée.

## 3.3 Métriques de qualité

```
lcf_documents_by_confidence{bucket}                     gauge
lcf_documents_needs_review                              gauge
lcf_documents_unprocessable                             gauge
lcf_metadata_completeness{source,field}                 gauge
```

La complétude des métadonnées par champ et par source est un excellent détecteur de régression de plugin : un champ dont le taux de renseignement chute de 98 % à 12 % signale un sélecteur cassé bien avant qu'aucune erreur ne soit levée.

## 3.4 Exposition

```
GET /metrics        -> format texte OpenMetrics
lcf metrics --json  -> instantane, sans dependance a un collecteur
```

L'accès en ligne de commande évite d'imposer une infrastructure de supervision : sur un déploiement de poste, la commande suffit, ce qui respecte la contrainte du Volume I (« sans API Cloud, sans Docker obligatoire »).

---

# Chapitre 4 — Traces

## 4.1 Portée

Le traçage distribué est **optionnel**. Il apporte une valeur réelle sur les déploiements multi-processus, et une complexité inutile sur un poste isolé.

```
Trace : run_01J9X3S9
  |
  +- source.run                                   [====================] 184 s
     |
     +- plugin.discover                           [=====]                 41 s
     |   +- http.get /documents?page=0            [=]                    1.2 s
     |   +- http.get /documents?page=1            [=]                    1.1 s
     |   +- ...
     |
     +- download.batch                            [============]        128 s
     |   +- download.document 9f2c...ab71         [==]                   6.1 s
     |   |   +- http.get .../2024-118.pdf         [==]                   5.9 s
     |   |   +- hash.compute                      []                     0.1 s
     |   |   +- integrity.verify                  []                     0.1 s
     |   +- ...
     |
     +- storage.commit                            [=]                    14 s
```

## 4.2 Attributs de portée

Les attributs suivent les conventions sémantiques usuelles, complétés d'attributs propres au domaine :

```
lcf.source.id           lcf.document.id
lcf.run.id              lcf.content.hash
lcf.plugin.version      lcf.version.no
lcf.stage.name          lcf.confidence
```

## 4.3 Échantillonnage

| Cas | Taux |
|---|---|
| Exécutions en échec | 100 % |
| Exécutions anormalement lentes (> p95) | 100 % |
| Exécutions nominales | 1 % |
| Requêtes d'API | 5 % |

Tout tracer coûte plus que cela ne rapporte. Ne rien tracer des échecs rend le traçage inutile.

---

# Chapitre 5 — Alertes

## 5.1 Principe

Une alerte qui ne conduit à aucune action est une nuisance. Après trois alertes ignorées, toutes les alertes sont ignorées, y compris celles qui comptent.

Chaque alerte de ce chapitre satisfait quatre conditions : elle est actionnable, elle a un destinataire identifié, elle a une procédure associée, et elle a un seuil justifié.

## 5.2 Alertes critiques

| Alerte | Condition | Action |
|---|---|---|
| Corruption d'intégrité | `integrity_checks{result!="ok"} > 0` | Procédure S1, Volume VI |
| Rupture de chaîne d'audit | `audit verify` échoue | Procédure S1, enquête immédiate |
| Magasin non accessible en écriture | Échec d'écriture sur `objects/` | Vérifier le disque, arrêter la collecte |
| Espace disque sous 5 % | Seuil | Étendre ou archiver |
| Échec de sauvegarde | Deux cycles consécutifs | Vérifier la cible et les droits |

## 5.3 Alertes d'absence

| Alerte | Condition | Interprétation |
|---|---|---|
| Source silencieuse | `seconds_since_last_run > runsAtLeastEvery` | Échéancier arrêté ou source désactivée |
| Source stérile | `seconds_since_last_new_document > 7 j` sur source active | Structure du site probablement modifiée |
| Aucune source ne réussit | `sources_with_recent_success == 0` | Panne globale : réseau, DNS, configuration |
| Pipeline arrêté | `pipeline_tasks{state="pending"} > 0` et débit nul depuis 1 h | Travailleurs morts ou bloqués |

## 5.4 Alertes de dégradation

| Alerte | Condition |
|---|---|
| Quarantaine de source | Toute transition vers `quarantined` |
| Taux d'échec élevé | > 20 % sur une exécution |
| Volume anormal | Découvertes hors de `typicalDocsPerRun` d'un facteur 5 |
| Effondrement de la qualité | Part des documents à confiance > 0,9 en baisse de plus de 20 points |
| File de lettres mortes en croissance | `dlq_size` croissant sur 24 h |

## 5.5 Ce qui ne déclenche pas d'alerte

Explicitement, et pour préserver la crédibilité des alertes qui restent :

- l'échec d'un document isolé (le réessai s'en charge) ;
- une erreur HTTP transitoire ;
- un pic de latence sans effet sur le résultat ;
- une confiance faible sur un document, prise isolément ;
- une exécution plus lente que d'habitude mais aboutie.

---

# Chapitre 6 — Contrôles de santé et diagnostic

## 6.1 Points de contrôle

```
GET /health/live     -> le processus repond
GET /health/ready    -> le systeme peut travailler
GET /health/deep     -> diagnostic complet (couteux, non periodique)
```

```
{
  "status": "degraded",
  "checkedAt": "2026-08-30T09:14:02Z",
  "checks": {
    "database":     { "status": "ok", "latencyMs": 2 },
    "contentStore": { "status": "ok", "writable": true, "freeBytes": 412000000000 },
    "plugins":      { "status": "degraded", "loaded": 47, "quarantined": 2 },
    "scheduler":    { "status": "ok", "nextRunAt": "2026-08-31T03:00:00Z" },
    "pipeline":     { "status": "ok", "pending": 1204, "workers": 7 },
    "backup":       { "status": "warn", "lastSuccessAt": "2026-08-28T02:00:00Z" }
  },
  "degradedReasons": [
    "2 sources en quarantaine : xx.a.official, xx.b.official",
    "sauvegarde datant de plus de 48 h"
  ]
}
```

Le champ `degradedReasons` en langage naturel est délibéré : il transforme un tableau de bord rouge en une phrase que l'astreinte peut lire à trois heures du matin.

## 6.2 Diagnostic d'une source

```
lcf doctor --source xx.gazette.official

Source        : xx.gazette.official
Plugin        : gazette-collector@2.3.0  (apiVersion 1.0, confiance T1)
Etat          : ready
Documents     : 12 480   (derniere nouveaute il y a 14 jours)

[ok]   configuration valide selon configSchema
[ok]   hotes autorises resolvables
[ok]   TLS valide, certificat expire dans 87 jours
[ok]   robots.txt accessible, /documents autorise
[warn] page d'index : 0 element correspond au selecteur "article.doc-entry"
       -> la structure du site a probablement change
[ok]   dernier document telecharge : empreinte verifiee
[warn] attente violee : discoversAtLeast=1/semaine, observe 0 depuis 14 j

DIAGNOSTIC : selecteur de decouverte probablement obsolete.
ACTION     : inspecter la page d'index et mettre a jour le plugin.
```

Cette commande est le principal outil d'exploitation du système. Elle exécute une découverte réelle en mode restreint et compare le résultat aux attentes déclarées — ce qui transforme un « rien ne remonte » en un diagnostic précis.

## 6.3 Diagnostic d'un document

```
lcf explain --document 9f2c...ab71

Document      : 9f2c...ab71
Source        : xx.gazette.official   nativeId 2024/118
Statut        : stored      versions : 3

Historique
  v1  2024-03-04T02:11:07Z  sha256:a1b2...  412 887 o  initial
  v2  2024-06-19T02:09:41Z  sha256:c3d4...  418 002 o  content_changed
  v3  2026-08-30T03:14:05Z  sha256:6b1d...  482 911 o  content_changed

Fichier       : objects/6b/1d/6b1d...f31.bin       present, verifie 2026-08-29
Traitement    : pipeline@2.1.0  confiance 0.61  (structure partielle)
Audit         : 9 entrees, chaine intacte
```

---

# Chapitre 7 — Profils de déploiement

## 7.1 Les quatre profils

| Profil | Cible | Base | Pipeline | Isolement |
|---|---|---|---|---|
| P1 — Poste | Un chercheur, un poste | SQLite | En processus | L1 |
| P2 — Serveur unique | Une équipe, un serveur | SQLite WAL | Travailleurs séparés | L2 |
| P3 — Serveur mutualisé | Institution, corpus important | PostgreSQL | Processus dédiés | L2 |
| P4 — Distribué | Très grand corpus | PostgreSQL + magasin objet | Nœuds séparés | L3 |

## 7.2 P1 — Poste de travail

```
lcf init ./mon-corpus
lcf source add ./plugins/gazette --config config.yaml
lcf run --source xx.gazette.official
lcf serve --port 7700          # interface locale
```

Aucun service, aucun conteneur, aucune administration. C'est le profil de référence et il satisfait littéralement les contraintes du Volume I, chapitre 5.

## 7.3 P2 — Serveur unique

```
                +--------------------------+
                |     lcf serve            |
                |  API + Scheduler         |
                +--------------------------+
                     |             |
              +------+---+     +---+--------+
              | collector|     | pipeline   |
              | workers  |     | workers    |
              +----------+     +------------+
                     |             |
                +----+-------------+----+
                |   data/  (volume)     |
                |   objects/ + index/   |
                +-----------------------+
```

Séparation des processus de collecte et de traitement : un extracteur qui tombe n'emporte jamais l'échéancier.

## 7.4 P4 — Distribué

```
   +-----------+   +-----------+   +-----------+
   | collector |   | collector |   | pipeline  |
   |  node A   |   |  node B   |   |  node C   |
   +-----------+   +-----------+   +-----------+
         \              |               /
          \             |              /
        +--------------------------------+
        |         PostgreSQL             |
        |  index + files + verrous       |
        +--------------------------------+
                       |
        +--------------------------------+
        |   Magasin objet (S3-compatible)|
        |   meme disposition CAS         |
        +--------------------------------+
```

Point notable : la disposition du Content Store est **identique** en magasin objet et sur système de fichiers. Le passage de P2 à P4 est une migration de données, pas une refonte : c'est le bénéfice concret de l'invariant I-7 du Volume IV.

## 7.5 Ce que le Framework n'impose jamais

| Non-exigence | Motif |
|---|---|
| Docker | Volume I, chapitre 5 |
| Kubernetes | Complexité disproportionnée pour la majorité des cas |
| Service cloud | Souveraineté, Volume VI, section 10.3 |
| GPU | L'OCR fonctionne sur processeur |
| Connexion Internet permanente | Fonctionnement hors ligne sur le corpus déjà collecté |

---

# Chapitre 8 — Configuration

## 8.1 Précédence

```
1. Valeurs par defaut du code
2. Fichier de configuration       (lcf.config.yaml)
3. Fichiers d'environnement       (lcf.<env>.yaml)
4. Variables d'environnement      (LCF_*)
5. Options de ligne de commande
   -> la derniere source l'emporte
```

## 8.2 Structure

```
version: 1

storage:
  root: ./data
  engine: sqlite            # sqlite | postgres
  compression: auto

network:
  userAgent: "LCF/1.0 (+https://exemple.org/lcf; contact@exemple.org)"
  defaultPolitenessDelayMs: 1000
  maxConcurrentPerHost: 2
  respectRobotsTxt: true

scheduler:
  enabled: true
  maxConcurrentSources: 3
  fullSweepEvery: 30d
  blackoutWindows: []

plugins:
  searchPaths: ["./plugins"]
  minimumTrustLevel: T1
  requireSignature: true
  isolation: worker

pipeline:
  enabled: true
  workers: auto             # min(cpu-1, 8)
  ocr:
    enabled: true
    maxPagesPerHour: 5000

observability:
  logLevel: info
  logFormat: json
  metrics: { enabled: true, bind: "127.0.0.1:7701" }
  tracing: { enabled: false }

backup:
  enabled: true
  target: "./backup"
  schedule: "0 2 * * *"
  drillSchedule: "0 4 1 * *"

api:
  bind: "127.0.0.1:7700"    # jamais 0.0.0.0 par defaut
  auth: { enabled: true, tokenFile: "./tokens.json" }
```

## 8.3 Validation

La configuration est validée intégralement **au démarrage**, avant toute activité. Une configuration invalide empêche le démarrage ; elle ne provoque jamais une panne trois heures plus tard.

```
lcf config validate

[ok]   schema valide
[ok]   storage.root accessible en ecriture
[ok]   47 plugins trouves, 47 manifestes valides
[warn] api.bind = 0.0.0.0:7700 : API exposee sur toutes les interfaces
[err]  backup.target inaccessible : ./backup (droits insuffisants)

INVALIDE : 1 erreur, 1 avertissement
```

L'avertissement sur `0.0.0.0` illustre une règle générale : le système ne refuse pas une configuration risquée mais légitime — il rend impossible de l'adopter sans le savoir.

---

# Chapitre 9 — Procédures d'exploitation

## 9.1 Journée type

```
lcf status                       # vue d'ensemble
lcf status --expectations        # attentes violees uniquement
lcf sources list --state quarantined
lcf pipeline stats
```

```
lcf status

LCF 1.4.2   profil P2   demarre il y a 14 j

Sources        47   (44 ready, 2 quarantined, 1 disabled)
Documents      1 284 991      (+ 412 sur 24 h)
Stockage       4.21 Tio       (dedup 1.31x)   disque libre 38 %
Derniere sauvegarde  il y a 7 h            [ok]
Integrite      100 % verifie sur 30 j      [ok]
Pipeline       1 204 en attente, 7 travailleurs, DLQ 38

Attentes violees : 3
  xx.a.official   aucune nouveaute depuis 14 j   (attendu : 1/semaine)
  xx.b.official   quarantaine depuis 3 j
  xx.c.official   taux d'echec 31 %             (attendu : < 5 %)
```

## 9.2 Ajouter une source

```
1. lcf plugin verify ./plugins/nouvelle-source      # manifeste + signature + conformite
2. lcf source add ./plugins/nouvelle-source --config source.yaml
3. lcf doctor --source <id>                          # diagnostic avant collecte
4. lcf run --source <id> --limit 10 --dry-run        # essai borne
5. lcf run --source <id> --limit 100                 # collecte reelle bornee
6. Verifier les documents obtenus, controler les metadonnees
7. lcf source enable <id>                            # activer l'echeancier
8. Declarer les attentes dans la configuration
```

L'étape 8 est celle qu'on oublie, et c'est celle qui détermine si la panne future de cette source sera détectée ou non.

## 9.3 Traiter une quarantaine

```
1. lcf doctor --source <id>                # diagnostic automatique
2. lcf logs --source <id> --level error --since 7d
3. Identifier la cause :
     - structure du site modifiee   -> corriger le plugin
     - source indisponible          -> attendre, verifier manuellement
     - configuration invalide       -> corriger, relancer doctor
     - limitation de debit          -> reduire les quotas dans le manifeste
4. Corriger
5. lcf run --source <id> --limit 10        # verifier avant reactivation
6. lcf source resume <id>
```

Aucune sortie de quarantaine n'est automatique. La réactivation est toujours une décision humaine consécutive à un diagnostic (Volume III, section 6.3).

## 9.4 Mise à niveau

```
1. lcf backup --verify                   # sauvegarde fraiche et testee
2. Lire les notes de version, en particulier les migrations
3. lcf stop --graceful                   # laisse finir les executions en cours
4. Installer la nouvelle version
5. lcf migrate --dry-run                 # verifier les migrations en attente
6. lcf migrate
7. lcf config validate
8. lcf start
9. lcf status ; lcf doctor --all
```

## 9.5 Retour arrière

```
1. lcf stop
2. Reinstaller la version precedente
3. lcf migrate --down --to <version>     # si des migrations ont ete appliquees
   -> si une migration est irreversible : restaurer la base depuis la sauvegarde
4. lcf start
5. lcf verify --sample 1000
```

Le Content Store n'est jamais concerné par un retour arrière : il est immuable et indépendant de la version du logiciel. C'est ce qui rend un retour arrière peu risqué — la seule chose réversible est la base d'index, et elle est reconstructible.

---

# Chapitre 10 — Manuel d'astreinte

## 10.1 « Aucun document collecté depuis N jours »

```
Gravite : elevee, silencieuse

Diagnostic
  lcf status --expectations
  lcf doctor --source <id>

Causes par frequence
  1. Structure du site modifiee     -> doctor signale 0 element pour le selecteur
  2. Echeancier arrete              -> lcf status montre scheduler inactif
  3. Source reellement inactive     -> verifier manuellement dans un navigateur
  4. Blocage par la source          -> 403/429 dans les journaux
  5. Panne DNS ou reseau            -> toutes les sources touchees

Resolution
  1 -> corriger le plugin, republier, retester
  2 -> lcf scheduler resume
  3 -> aucune action, ajuster les attentes
  4 -> reduire les quotas, contacter l'administrateur de la source
  5 -> incident d'infrastructure
```

## 10.2 « Anomalie d'intégrité détectée »

```
Gravite : critique

  lcf verify --all --report                 # etendue exacte
  lcf audit query --subject <content_hash>  # historique de l'objet

  Un seul objet, cause materielle probable
    -> lcf restore --object <hash> --from <backup>
    -> verifier l'etat du disque (SMART)

  Plusieurs objets
    -> S1 : arreter la collecte, passer en lecture seule
    -> suspecter le materiel ou une modification externe
    -> restaurer depuis sauvegarde, verifier integralement
```

## 10.3 « Espace disque saturé »

```
Gravite : critique

  lcf status --storage
  lcf gc --min-age 30d --dry-run         # objets orphelins
  du -sh data/derived                    # artefacts derives : supprimables

Ordre des actions
  1. Supprimer data/derived (reconstructible, Volume V)
  2. Executer le ramasse-miettes apres verification
  3. Archiver les sources anciennes vers un stockage froid
  4. Etendre le volume

JAMAIS : supprimer manuellement dans data/objects/
```

## 10.4 « Le pipeline n'avance plus »

```
Gravite : moyenne (la collecte n'est pas affectee)

  lcf pipeline stats
  lcf pipeline tasks --state leased --expired

  Baux expires en masse   -> travailleurs morts : redemarrer
  DLQ en forte croissance -> nouveau format non gere : inspecter un echantillon
  Une tache bloquee       -> lcf pipeline kill <task_id>, elle repartira
  Debit nul, file pleine  -> verifier CPU, memoire, plafond de travailleurs

Rappel : un retard de pipeline n'a aucune consequence sur le corpus.
Les originaux sont collectes et intacts ; seul le traitement attend.
```

## 10.5 « Plugin en quarantaine après mise à jour »

```
Gravite : moyenne

  lcf plugin info <id>            # version chargee, rapport de conformite
  lcf logs --source <id> --level error --since 1h

  CapabilityViolation      -> le plugin depasse ses capacites declarees
                              corriger le manifeste ou le code
  SourceStructureChanged   -> le plugin a raison, le site a change
  ConfigurationInvalid     -> configSchema modifie, mettre a jour la configuration

Retour arriere possible a tout moment :
  lcf plugin rollback <id> --to <version>
```

---

# Chapitre 11 — Reprise après sinistre

## 11.1 Objectifs

| Métrique | Cible | Justification |
|---|---|---|
| RPO — Content Store | 24 h | Sauvegarde quotidienne ; documents perdus recollectables |
| RPO — Index | 1 h | Instantanés horaires ; reconstructible de toute façon |
| RTO — Base perdue | 4 h | Réindexation depuis le magasin |
| RTO — Perte totale | 24 h | Restauration complète depuis sauvegarde externe |

## 11.2 Scénarios

```
S-A  Base corrompue, magasin intact
     lcf reindex --from-store
     Perte : aucune              Duree : ~2 h / million de documents

S-B  Magasin partiellement perdu
     lcf restore --from <backup> --objects-only
     lcf verify --all --repair
     Perte : objets absents des deux cotes, listes nominativement

S-C  Perte totale du site
     Provisionner un hote, installer LCF
     lcf restore --from <backup externe> --full
     lcf verify --all
     Perte : bornee par le RPO (24 h)

S-D  Perte des sauvegardes, magasin intact
     Constituer immediatement une nouvelle sauvegarde
     Perte : aucune, mais le systeme etait sans filet
```

## 11.3 Exercice périodique

Une procédure de reprise jamais exécutée n'est pas une procédure : c'est un document.

```
Mensuel     lcf backup-drill --sample 1000
Trimestriel restauration complete sur un hote de test, verification integrale
Annuel      exercice de sinistre complet, chronometre, rapport ecrit
```

---

# Chapitre 12 — Critères d'acceptation du Volume VII

## AC-7.1 — Détection de source stérile

```
ETANT DONNE une source dont l'attente est discoversAtLeast 1/semaine
QUAND aucun nouveau document n'est decouvert pendant 8 jours
ALORS lcf_expectation_violations passe a 1 pour cette source
  ET une alerte "source sterile" est declenchee
  ET lcf status l'affiche dans les attentes violees
```

## AC-7.2 — Corrélation complète

```
ETANT DONNE un runId
QUAND on execute lcf logs --run <runId>
ALORS toutes les entrees de cette execution sont retournees
  ET chacune porte sourceId et, le cas echeant, documentId
  ET l'ordre chronologique est preserve
```

## AC-7.3 — Diagnostic actionnable

```
ETANT DONNE une source dont le selecteur de decouverte est obsolete
QUAND on execute lcf doctor --source <id>
ALORS la sortie identifie le selecteur ne correspondant a aucun element
  ET propose une action concrete
  ET le code de sortie est non nul
```

## AC-7.4 — Validation bloquante de la configuration

```
ETANT DONNE une configuration dont storage.root est inaccessible en ecriture
QUAND le Kernel demarre
ALORS le demarrage echoue immediatement
  ET le message nomme le champ fautif et la raison
  ET aucune collecte n'a ete tentee
```

## AC-7.5 — Arrêt gracieux

```
ETANT DONNE une collecte en cours sur 40 documents
QUAND lcf stop --graceful est invoque
ALORS les telechargements en cours s'achevent
  ET aucune ecriture partielle ne subsiste
  ET les documents restants sont replanifies
  ET le processus se termine avec le code 0
```

## AC-7.6 — Reconstruction dans le RTO

```
ETANT DONNE un corpus d'un million de documents
QUAND la base d'index est supprimee
ALORS lcf reindex --from-store se termine en moins de 4 h
  ET le nombre de documents et de versions est identique
  ET aucune requete reseau n'a ete emise
```

## AC-7.7 — Indépendance du pipeline

```
ETANT DONNE tous les travailleurs du pipeline arretes
QUAND une collecte s'execute
ALORS elle se termine normalement
  ET les documents sont stockes et verifies
  ET les taches de traitement s'accumulent sans erreur
  ET le traitement reprend au redemarrage des travailleurs
```

---

# Chapitre 13 — Décisions d'architecture du Volume VII

## ADR-701 — Attentes déclarées par source

**Statut** : Accepté · **Contexte** : Le mode de panne dominant est l'absence de résultat, qui ne produit aucune erreur.
**Décision** : Chaque source déclare son comportement attendu ; le système alerte sur l'écart.
**Conséquences** : + Détection des pannes silencieuses, seule protection réelle contre l'arrêt invisible d'un corpus. − Un travail de calibrage par source, et des faux positifs tant que les seuils ne sont pas ajustés.

## ADR-702 — Journaux structurés exclusivement

**Statut** : Accepté · **Contexte** : Les journaux en texte libre deviennent inexploitables à l'échelle du million de documents.
**Décision** : JSON en ligne, champs de corrélation obligatoires, aucune analyse par expression régulière.
**Conséquences** : + Requêtes fiables, corrélation exacte. − Moins agréables à lire brut, compensé par `lcf logs`.

## ADR-703 — Observabilité sans dépendance externe

**Statut** : Accepté · **Contexte** : Le Volume I interdit d'imposer une infrastructure ; beaucoup de déploiements seront isolés.
**Décision** : Toutes les métriques et diagnostics sont accessibles en ligne de commande ; l'export vers un collecteur est optionnel.
**Conséquences** : + Le profil poste reste pleinement observable. − Duplication entre sortie CLI et exposition de métriques.

## ADR-704 — Pipeline strictement subordonné à la collecte

**Statut** : Accepté · **Contexte** : Un document non collecté est perdu ; un document non traité attend.
**Décision** : Processus séparés, priorité CPU et E/S inférieure, plafond `cpuCount - 1`.
**Conséquences** : + La collecte n'est jamais compromise par le traitement. − Débit de traitement inférieur au maximum théorique de la machine.

## ADR-705 — Aucune sortie automatique de quarantaine

**Statut** : Accepté · **Contexte** : Une réactivation automatique masque la cause et produit des cycles d'échec silencieux.
**Décision** : La sortie de quarantaine est toujours une action humaine explicite.
**Conséquences** : + Toute panne de source est vue et comprise. − Nécessite une exploitation attentive, ce qui est le comportement recherché.

---

# Synthèse du Volume VII

Le Volume VII a doté le système d'un sens qui lui manquait : la capacité de constater ce qui n'arrive pas.

Les journaux structurés et les traces répondent aux questions classiques. Les métriques d'absence et le modèle d'attentes répondent à la seule question qui compte vraiment pour un collecteur : « ce corpus est-il encore vivant ? » Une source qui s'exécute sans erreur et ne trouve plus rien est en panne, et rien dans une supervision classique ne le dirait.

Le volume a également posé les conditions d'une exploitation sobre : des alertes rares et actionnables, un diagnostic qui produit une action plutôt qu'un constat, une configuration validée au démarrage plutôt que découverte défaillante en production, quatre profils de déploiement allant du poste isolé au cluster sans jamais imposer d'infrastructure, et un ensemble de procédures écrites pour être lues en situation d'urgence.

**Volume VIII — Testing Strategy & Quality Assurance** spécifiera comment tout ce qui a été affirmé dans les sept premiers volumes est vérifié : la pyramide de tests, les fixtures et l'enregistrement de sources réelles, les tests de propriétés sur les invariants, l'injection de fautes, les tests de non-régression sur corpus, et les portes de qualité de l'intégration continue.
