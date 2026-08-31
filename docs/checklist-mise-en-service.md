# Checklist de mise en service

Suivi des points à résoudre pour passer d'un framework testé à un collecteur
déployé et autonome. On coche au fur et à mesure ; chaque point coché doit
l'être **par un test ou une vérification**, pas par une impression.

Convention : `[ ]` à faire · `[~]` en cours · `[x]` fait et vérifié.

---

## A. Bloquants — sans eux, rien n'est collecté

| # | Point | État | Vérifié par |
|---|---|---|---|
| A1 | Choisir la source principale | `[x]` | SGG — `sgg.gouv.bj` (voir [sources-benin.md](sources-benin.md)) |
| A2 | Enregistrer les fixtures HTTP réelles de la source | `[x]` | 2 pages d'index + 1 PDF, péremption 2027-02-28 |
| A3 | Écrire le plugin de la source principale | `[x]` | `plugins/sgg-benin/`, 19 tests hors ligne |
| A4 | Vérifier la stabilité des `nativeId` sur 3 pages réelles | `[x]` | slugs `loi-2026-14` ; aucune forme interdite |
| A5 | Première collecte réelle contre le site (petit `--max`) | `[x]` | 8 documents, 30 Mo, intégrité vérifiée ok |
| A6 | Collecte complète de la source principale | `[~]` | `lcf run --all` en place ; les 6 catégories déclarées ; collecte à lancer |
| A7 | Deuxième collecte : idempotence en conditions réelles | `[x]` | 8 inchangés, 0 octet, empreinte du magasin identique |
| A8 | Adresse de contact réelle dans `lcf.config.json` | `[x]` | boîte dédiée relevée ; `isPlaceholderContact` refuse les marqueurs |
| A9 | Connecter les 5 autres catégories du SGG | `[x]` | 6 sources déclarées ; `bj.sgg.decrets` collecte déjà (1er document vérifié) |

## B. Défauts connus du framework à corriger

| # | Point | État | Vérifié par |
|---|---|---|---|
| B0 | Coupure pendant le transfert : erreur non classée → quarantaine à tort | `[x]` | corrigé + 4 tests de régression |
| B1 | Mode incrémental : `restore()` n'est jamais appelé | `[x]` | 13 tests d'orchestrateur + arrêt anticipé vérifié sur fixtures réelles |
| B2 | `lcf verify` ne traite qu'un lot, pas tout le magasin | `[x]` | `--all` : parcours complet + détection des objets non indexés |
| B3 | Documents en échec non replanifiés hors balayage complet | `[x]` | reprise ciblée bornée, 5 tests |
| B4 | Node 22 exige `--experimental-sqlite` | `[ ]` | testé aussi sous Node 24 sans drapeau |
| B5 | Aucune limite de taille sur le journal d'événements en mémoire | `[x]` | `FileEventJournal` JSONL journalier + cache mémoire borné |
| B6 | Délai de transfert **total** au lieu d'un délai d'**inactivité** | `[x]` | garde d'inactivité 60 s + plafond 30 min, 6 tests ; `loi-2025-14` (37 Mo) ne meurt plus à 120 s |
| B7 | En mode incrémental, un document connu est re-téléchargé intégralement | `[x]` | échelle N1/N2/N3, motif `incremental_skip`, `--recheck` pour forcer ; 7 tests |
| B8 | Un processus tué laisse son exécution en `running` pour toujours | `[x]` | clôture au démarrage au-delà de 24 h, 2 tests |
| B9 | Aucun ralentissement quand la source se dégrade sans échouer | `[x]` | moyennes mobiles de latence, ×8 max, 6 tests |
| B10 | Deux processus concurrents doublaient la charge négociée | `[x]` | verrou exclusif du magasin, reprise si le détenteur est mort |

## C. Exploitation continue

| # | Point | État | Vérifié par |
|---|---|---|---|
| C0 | Balayage complet imposé si le dernier date de plus de 30 jours | `[x]` | Vol. III 7.3 — 3 tests |
| C1 | Planificateur : collecte quotidienne automatique | `[x]` | `lcf daemon` : cron maison, arrêt propre, battement de cœur |
| C2 | Fenêtres d'exclusion (ne pas collecter aux heures ouvrables) | `[x]` | vérifiées à chaque document, 7 tests |
| C3 | `lcf backup` incrémental du magasin + instantané de l'index | `[ ]` | AC-4.x, sauvegarde restaurable |
| C4 | `lcf restore` + exercice de restauration | `[ ]` | restauration d'un échantillon vérifiée |
| C5 | Réactiver la garde de sauvegarde avant migration | `[ ]` | `allowMigrationWithoutBackup` retiré |
| C6 | Vérification d'intégrité périodique automatique | `[x]` | tour horaire du démon, fenêtre glissante de 30 jours |
| C7 | Alerte d'absence : source silencieuse depuis N jours | `[x]` | contrôle quotidien, seuil configurable ; déjà déclenché en réel |
| C8 | Service système (démarrage automatique, redémarrage après panne) | `[~]` | unité systemd + guide livrés ; à éprouver sur le VPS |
| C9 | Intégration continue : build + tests à chaque modification | `[ ]` | pipeline vert |
| C10 | Journal d'exploitation consultable (rotation, rétention) | `[x]` | JSONL journalier, rotation, rétention 90 j |

## D. Sources suivantes

| # | Point | État |
|---|---|---|
| D1 | Deuxième source connectée | `[ ]` |
| D2 | Troisième source connectée | `[ ]` |
| D3 | Trois sources collectées en continu pendant 30 jours (sortie du Palier 1) | `[ ]` |

## E. Qualité et conformité (Palier 1, Vol. IX 4.2)

| # | Point | État |
|---|---|---|
| E1 | Plugin Conformance Kit exécutable (`npx @lcf/conformance`) | `[ ]` |
| E2 | Suite de plugins hostiles intégralement confinée | `[ ]` |
| E3 | Isolement L2 (worker) pour les plugins tiers | `[ ]` |
| E4 | 30 jours d'exécution continue sans fuite ni dérive | `[ ]` |

## F. Outillage manquant, constaté à l'usage

> `lcf serve` — le tableau de bord — a été ajouté hors liste initiale :
> évolution du corpus, état des sources, lancement et arrêt des collectes.

| # | Point | État |
|---|---|---|
| F1 | `lcf purge` — le magasin sait poser une pierre tombale, aucune commande ne l'expose | `[ ]` |
| F2 | `lcf doctor` — diagnostic d'installation (Vol. VII, 6.2) | `[ ]` |
| F3 | `lcf health <sourceId>` — le plugin implémente `health()`, rien ne l'appelle | `[ ]` |
| F4 | `lcf run --since <date>` — l'orchestrateur l'accepte, la CLI ne l'expose pas | `[x]` | `--since` validé + `--recheck` + `--all` |
| F5 | `lcf source disable` / `remove` — on ne peut qu'ajouter et reprendre | `[ ]` |
| F6 | `lcf export` — JSONL, BagIt, `lcf-bundle` (Vol. IV, ch. 12) | `[ ]` |
| F7 | Secrets : variables d'environnement uniquement, aucun coffre | `[ ]` |

## G. Limites assumées — hors Palier 0

Ce ne sont pas des défauts : ce sont des chantiers datés par la feuille de route
du Volume IX. Ils sont listés pour qu'on ne les redécouvre pas par surprise.

| # | Limite | Palier |
|---|---|---|
| G1 | Plans `browser` et `archive-member` refusés avec un message nommant le palier | 1 |
| G2 | Isolement L2/L3 des plugins non implémenté | 1 et 3 |
| G3 | Journal d'événements non durable | 1 |
| G4 | Pipeline de traitement : extraction de texte, OCR, segmentation | 2 |
| G5 | API HTTP, webhooks, flux d'événements | 3 |
| G6 | Adaptateur PostgreSQL, magasin objet S3 | 3 |
| G7 | Journal d'audit chaîné, ancrage RFC 3161 | 4 |

## H. Dettes ouvertes hors code

| # | Point | État |
|---|---|---|
| H1 | Corriger le Volume III, 3.2 : formule de `document_id` contradictoire avec le Vol. IV | `[ ]` |
| H2 | `loi-2025-14` (37 Mo) reste en échec dans le corpus réel | `[x]` collecté, 36,6 Mo, corpus sans aucun échec |
| H3 | Un seul mainteneur : le Vol. IX 1.3 qualifie cet état d'« alerte » | `[ ]` |
| H4 | Fixtures du SGG à re-enregistrer avant le 2027-02-28 | `[ ]` |

---

## Journal des décisions prises en cours de route

| Date | Décision | Où c'est consigné |
|---|---|---|
| 2026-08-30 | `document_id` utilise le séparateur `0x1F` (Vol. IV), le Vol. III doit être corrigé | [ADR-0001](adr/0001-formule-document-id.md) |
| 2026-08-30 | Moteur SQLite via `node:sqlite`, zéro dépendance native | [ADR-0002](adr/0002-moteur-sqlite.md) |
| 2026-08-30 | Délai de transfert porté à 120 s, distinct des 30 s de réponse du Vol. II 6.3 | `DOWNLOAD_TIMEOUT_MS`, commentaire dans `download-manager.ts` |
| 2026-08-30 | Une coupure de transfert est une erreur réseau réessayable, jamais une panne de source | `classifyBodyFailure()` + tests |
| 2026-08-30 | La pagination du SGG se recouvre d'une entrée entre deux pages | test « recouvrement de pagination » |
| 2026-08-30 | `lcf source resume` ajouté : la levée de quarantaine reste manuelle (Vol. III 6.2) | `packages/cli/src/commands.ts` |
| 2026-08-30 | Le checkpoint est restauré au démarrage ; un checkpoint illisible n'interrompt jamais la collecte | `collection-runner.ts`, `#restoreCheckpoint` |
| 2026-08-30 | Un incrémental sans balayage complet récent est promu en complet | `#resolveMode`, `DEFAULT_FULL_SWEEP_EVERY_MS` |
| 2026-08-30 | L'arrêt anticipé porte sur une page entière, avec 7 jours de marge : l'index du SGG n'est pas strictement trié | `shouldStopAtPage` |
| 2026-08-31 | Le transfert est borné par l'inactivité (60 s), pas par sa durée ; plafond absolu 30 min | `withIdleGuard`, `transport.ts` |
| 2026-08-31 | N3 n'est obligatoire qu'au balayage complet ; sans indice comparable, l'incrémental passe | `compareFreshness`, `collection-runner.ts` |
| 2026-08-31 | L'indice de fraîcheur annoncé par l'index est conservé à défaut d'en-tête de réponse | `collection-runner.ts`, commit |
| 2026-08-31 | Adresse de contact dédiée, jamais versionnée ; les marqueurs sont détectés et signalés | `isPlaceholderContact`, `config.ts` |
| 2026-08-31 | Corpus SGG mesuré : 35 008 documents, 25–33 Go, ~60 h de collecte initiale | relevé des 6 catégories, 30/08 |
