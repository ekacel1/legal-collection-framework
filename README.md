# Legal Collection Framework (LCF)

Framework de collecte documentaire extensible par plugins. Découvre, télécharge, vérifie,
versionne et conserve des documents provenant de sources officielles — sans jamais les modifier.

> Le noyau ne connaît aucune source. Toute source est un plugin.
> *Open for extension. Closed for modification.*

**306 tests, 0 échec. Zéro dépendance de production.**

---

## État du projet

| | |
|---|---|
| **Palier 0 — Socle** | terminé, critères de sortie du Vol. IX 4.1 tous verts |
| **Palier 1 — Robustesse** | en cours : démon, journaux durables, politesse adaptative faits ; conformité et isolement à venir |
| **Corpus réel** | 25 documents, 158 Mo collectés depuis `sgg.gouv.bj`, aucun échec |
| **Cible** | 35 008 documents, 25–33 Go, ~60 h de première collecte |

Suivi détaillé : [docs/checklist-mise-en-service.md](docs/checklist-mise-en-service.md).

---

## Démarrage

Prérequis : **Node.js ≥ 22.5** (24 recommandé). Ni Docker, ni base externe, ni service cloud.

```bash
npm install
npm run build
npm test

npm run lcf -- init --contact vous@votre-domaine.org
npm run lcf -- run bj.sgg.lois --max 5      # essai borné
npm run lcf -- status
```

Déploiement en service : [deploy/INSTALL-linux.md](deploy/INSTALL-linux.md).

---

## Commandes

### Collecte

| Commande | Rôle |
|---|---|
| `lcf run <sourceId>` | Collecte une source |
| `lcf run --all` | Toutes les sources actives, **en séquence** |
| `lcf daemon` | Service : cadence cron, fenêtres d'exclusion, intégrité, alertes |
| `lcf daemon --once` | Un seul tour — valide la configuration puis sort |

Options de `run` : `--mode full|incremental` · `--max <n>` · `--since <ISO-8601>` ·
`--recheck` (force la comparaison d'empreinte en incrémental).

### Sources

| Commande | Rôle |
|---|---|
| `lcf source add <pluginId> --id <sourceId> --config '<json>'` | Déclare une source |
| `lcf source list` | Sources, états, volumétrie |
| `lcf source resume <sourceId>` | Lève une quarantaine — **jamais automatique** |

### Corpus

| Commande | Rôle |
|---|---|
| `lcf status [sourceId]` | État des sources, du démon, du verrou |
| `lcf verify` | Vérifie un lot d'objets (mode de fond) |
| `lcf verify --all` | Vérifie **tout** le magasin, détecte les objets non indexés |
| `lcf reindex` | Reconstruit l'index depuis le magasin seul, **sans réseau** |
| `lcf serve [--port <n>]` | Tableau de bord web, sur 127.0.0.1 |

### Options globales

`--config-file <chemin>` (défaut `./lcf.config.json`) · `--log-level debug\|info\|warn\|error` · `--help`

> Aucune commande de ce menu ne supprime de contenu. La purge (`lcf purge`) n'est
> pas encore livrée et n'existera **qu'en ligne de commande** : une opération
> irréversible ne doit pas être accessible derrière un jeton qui peut fuir.

---

## Tableau de bord

`lcf serve` expose une page unique — sans framework, sans CDN, sans fichier
statique — qui montre l'évolution du corpus, l'état des sources, les dernières
exécutions, et permet de **lancer** ou d'**arrêter** une collecte.

Il écoute sur **127.0.0.1 uniquement**. Pour y accéder à distance :

```bash
ssh -N -L 7331:127.0.0.1:7331 lcf@votre-serveur
```

| Route | Rôle |
|---|---|
| `GET /` | La page |
| `GET /api/state` | Totaux, sources, exécutions, évolution quotidienne |
| `GET /api/documents` | Corpus, pagination par curseur |
| `POST /api/run` | Déclenche une collecte |
| `POST /api/stop` | Arrêt **coopératif** — entre deux documents, jamais en plein transfert |

Le corpus est en lecture seule : aucune route ne modifie un document.

---

## Spécifications

### Garanties sur les données

| Invariant | Ce qu'il signifie |
|---|---|
| **I-1 Immuabilité** | Un fichier écrit n'est jamais modifié ni écrasé |
| **I-2 Atomicité** | Un document est entièrement présent et indexé, ou totalement absent |
| **I-3 Vérifiabilité** | Tout octet est ré-adressable par son empreinte, à tout moment |
| **I-4 Auto-description** | Le magasin reste interprétable **sans la base** |
| **I-5 Traçabilité** | Toute écriture est rattachée à une exécution, une source, un instant |
| **I-6 Non-destruction** | Aucune opération courante ne supprime de contenu |
| **I-7 Portabilité** | La disposition physique ne dépend d'aucun moteur de base |

Le protocole d'écriture E1→E9 est testé **à chacun de ses six points de panne**.
La base est un cache reconstructible : `lcf reindex` rebâtit tout depuis le
magasin, sans réseau, et c'est vérifié par un test.

### Protection des sources

Le Framework est conçu pour que le comportement respectueux soit plus simple
que le comportement agressif.

| Mesure | Valeur (SGG) |
|---|---|
| Délai de politesse par hôte | 1 500 ms, plancher noyau 100 ms |
| Quota glissant | 20 requêtes/min |
| Connexions simultanées | 1, plafond noyau 10 |
| Fenêtres d'exclusion | heures ouvrables, vérifiées à chaque document |
| Verrou exclusif du magasin | un seul processus collecte à la fois |
| Ralentissement adaptatif | ×8 max si la latence de la source se dégrade |
| Disjoncteur | ouvre après 5 échecs, 60 s de repos |
| Repli exponentiel | 1 s, 4 s, 16 s, avec jitter |
| `Retry-After` | toujours respecté |
| `robots.txt` | respecté ; désactivation impossible d'un seul côté |
| `User-Agent` | identifiant + adresse de contact, obligatoires |

Ces limites ne dépendent pas de la discipline de l'auteur du plugin : **un plugin
ne télécharge jamais lui-même**. Il retourne un plan, le Kernel l'exécute.

### Transferts

Trois délais distincts, parce qu'un seul ne peut pas tout faire :

| Délai | Valeur | Ce qu'il borne |
|---|---|---|
| Réponse | 30 s | Obtention des en-têtes |
| **Inactivité** | 60 s | Absence d'octets **pendant** le transfert |
| Absolu | 30 min | Garde-fou de dernier ressort |

Un transfert **lent mais qui progresse** n'est jamais interrompu : c'est ce qui
permet de collecter un document de 37 Mo depuis une liaison à 200 Ko/s.

### Détection de changement (Vol. IV, 6.2)

| Niveau | Test | Quand |
|---|---|---|
| N1 | `ETag` identique | incrémental |
| N2 | `Last-Modified` identique | incrémental |
| N3 | Comparaison d'empreinte | **obligatoire au balayage complet** |

Sans indice comparable, l'incrémental passe son chemin — le balayage complet,
imposé tous les 30 jours, fait autorité. Sur le SGG, qui ne sert aucun
validateur HTTP, cela a fait passer une passe incrémentale de 20 téléchargements
à **3 requêtes**.

### Contrat de plugin

Quatre méthodes obligatoires : `init`, `discover`, `resolve`, `dispose`.
Les cinq interdits — écrire sur disque, ouvrir la base, émettre un événement,
instancier un client HTTP, dépendre d'un autre plugin — sont vérifiés au
chargement et rendus impossibles par construction.

Un plugin ne peut parler qu'aux hôtes déclarés dans son manifeste, et la capacité
effective est **l'intersection** de ce qu'il demande et de ce que l'exploitation
accorde. La valeur la plus prudente l'emporte toujours.

---

## Structure du dépôt

```
docs/architecture/     Les 9 volumes de la spécification (.docx + sources)
docs/adr/              Décisions d'architecture, une par fichier
docs/                  checklist de mise en service, sources documentaires
deploy/                Unité systemd, guide d'installation, configuration VPS
packages/kernel/       Noyau : domaine, magasin, base, réseau, plugins, orchestration
packages/plugin-toolkit/   Squelettes de stratégies pour auteurs de plugins
packages/plugin-testkit/   Harnais de test hors ligne
packages/conformance/  Plugin Conformance Kit (squelette, Palier 1)
packages/cli/          Commande lcf, démon, tableau de bord
plugins/sgg-benin/     Connecteur du SGG (Bénin) — 6 catégories
plugins/example-…/     Archétype A de référence
migrations/            Migrations SQL numérotées et immuables
data/                  Runtime local — jamais versionné
```

---

## Sources connectées

| Source | État | Documents |
|---|---|---|
| [SGG Bénin](https://sgg.gouv.bj) — 6 catégories | actif | 35 008 annoncés |
| Journal Officiel, LEGIS/CDIJ, juridictions | à venir | voir [docs/sources-benin.md](docs/sources-benin.md) |

---

## Règles non négociables

Extraites des Volumes I, IV et V — toute proposition qui les affaiblit est refusée en revue :

- Le document original n'est jamais modifié.
- Aucune opération courante ne supprime de contenu.
- Le noyau ne contient aucune URL, aucun format juridique, aucune source.
- Le fichier est écrit et synchronisé **avant** toute écriture en base.
- Un plugin ne télécharge pas, n'écrit pas sur disque, n'accède pas à la base.
- Le pipeline lit le Content Store, ne l'écrit jamais.
- Le Framework n'interprète jamais le sens juridique d'un document.

---

## Documentation

| Document | Contenu |
|---|---|
| [docs/architecture/](docs/architecture/) | La spécification, 9 volumes — source de vérité |
| [docs/checklist-mise-en-service.md](docs/checklist-mise-en-service.md) | 53 points de mise en production, cochés au fur et à mesure |
| [docs/sources-benin.md](docs/sources-benin.md) | Sources documentaires, structures vérifiées |
| [docs/adr/](docs/adr/) | Décisions d'architecture consignées |
| [deploy/INSTALL-linux.md](deploy/INSTALL-linux.md) | Mise en service sur serveur |

## Tests

```bash
npm test          # 306 tests
npm run coverage  # couverture par fichier
```

Les tests d'acceptation montent le système entier — magasin, base, bus, plugin
réel chargé depuis le disque — et portent le numéro du critère qu'ils vérifient.
Seul le transport HTTP est substitué : **aucun test ne touche le réseau**.
#   l e g a l - c o l l e c t i o n - f r a m e w o r k  
 