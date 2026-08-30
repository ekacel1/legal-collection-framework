# Legal Collection Framework (LCF)

Framework de collecte documentaire extensible par plugins. Découvre, télécharge, vérifie,
versionne et conserve des documents provenant de sources officielles — sans jamais les modifier.

> Le noyau ne connaît aucune source. Toute source est un plugin.
> *Open for extension. Closed for modification.*

## État du projet

Phase de spécification terminée. Développement à démarrer au **Palier 0 — Socle**
(voir Volume IX, chapitre 4).

## Documentation d'architecture

La spécification complète — 9 volumes — est dans [`docs/architecture/`](docs/architecture/).
C'est la source de vérité du projet : toute décision d'implémentation doit s'y rattacher.

| Vol. | Titre |
|---|---|
| I | Vision, Product Definition, Core Architecture |
| II | Kernel Architecture |
| III | Plugin Contracts & Public API |
| IV | Data Model, Storage & Versioning |
| V | Processing Pipeline & Extraction Layer |
| VI | Security, Compliance & Trust Chain |
| VII | Observability, Operations & Deployment |
| VIII | Testing Strategy & Quality Assurance |
| IX | Governance, Roadmap & Decision Records |

Transversal : **53 critères d'acceptation** (AC-3.1 → AC-9.6), **36 ADR** (301 → 904),
**11 invariants** nommés. Index et glossaire en annexes du Volume IX.

## Structure du dépôt

```
docs/
  architecture/     Les 9 volumes (.docx) + sources markdown regenerables
  adr/              ADR individuels, un fichier par decision
  migration/        Guides de migration (obligatoires avant toute rupture)
packages/
  kernel/           Noyau : domaine, event bus, scheduler, storage, integrity
  plugin-toolkit/   Squelettes de strategies de decouverte, pour auteurs de plugins
  plugin-testkit/   Harnais de test fourni aux auteurs de plugins
  conformance/      Plugin Conformance Kit (8 familles de tests)
  cli/              Commande lcf
plugins/            Plugins de source (jamais dans le noyau)
migrations/         Migrations SQL numerotees et immuables
test/fixtures/      Echanges HTTP enregistres, avec date de peremption
testdata/           Corpus de reference pour la non-regression
data/               Runtime local : objects/, index/, derived/  (non versionne)
```

## Premières étapes de développement

Palier 0, critères de sortie en Volume IX, section 4.1 :

1. Couche domaine et interfaces (Vol. II)
2. Content Store + protocole d'écriture atomique (Vol. IV, ch. 4–5)
3. Schéma de base initial et lanceur de migrations (Vol. IV, ch. 3 et 10)
4. Chargement de plugin, contrat minimal à 4 méthodes (Vol. III, ch. 2)
5. Download Manager avec quotas, politesse et retry (Vol. II)
6. CLI : `init`, `source add`, `run`, `status`
7. Un plugin de référence, archétype A (Vol. III, 12.1)

Portes de sortie : AC-4.1, AC-4.2, AC-4.4 verts ; les six points de panne du protocole
d'écriture testés ; réindexation depuis le magasin sans réseau vérifiée ; couverture
domaine > 90 %.

## Règles non négociables

Extraites des Volumes I, IV et V — toute proposition qui les affaiblit est refusée en revue :

- Le document original n'est jamais modifié.
- Aucune opération courante ne supprime de contenu.
- Le noyau ne contient aucune URL, aucun format juridique, aucune source.
- Le fichier est écrit et synchronisé **avant** toute écriture en base.
- Un plugin ne télécharge pas, n'écrit pas sur disque, n'accède pas à la base.
- Le pipeline lit le Content Store, ne l'écrit jamais.
- Le Framework n'interprète jamais le sens juridique d'un document.

## Régénérer la spécification

```
pip install python-docx
python docs/architecture/src/build_docx.py docs/architecture/src/vol4.md \
       "docs/architecture/LCF_Volume_IV_Data_Model_Storage_and_Versioning.docx"
```

Détails du format source dans [`docs/architecture/README.md`](docs/architecture/README.md).
