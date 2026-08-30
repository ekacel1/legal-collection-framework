@TITLE: Legal Collection Framework
@SUBTITLE: Software Architecture Specification
@VOLUME: VOLUME IV — Data Model, Storage & Versioning
@VERSION: 0.4 (Draft)

# Préambule du Volume IV

Les trois premiers volumes ont défini une charte, un noyau et une frontière. Le Volume IV traite de ce qui reste quand tout le reste a disparu : **les octets sur le disque**.

C'est le volume le plus conservateur de la série, et c'est délibéré. Le code du Framework sera réécrit plusieurs fois en quinze ans. Les plugins seront remplacés. L'API évoluera. Les données, elles, doivent survivre à tout cela sans altération. Une décision de stockage prise aujourd'hui engage bien plus longtemps qu'une décision de conception applicative.

> Axiome du Volume IV : le code est un consommable, les données sont un actif. Toute décision qui échange de la simplicité de code contre un risque sur les données est mauvaise, quel que soit le gain de simplicité.

## Portée

- Le modèle conceptuel du domaine documentaire.
- Le schéma relationnel complet, en DDL.
- La disposition physique du magasin de contenu (Content Store).
- Le protocole d'écriture atomique et de reprise après panne.
- Le modèle de versionnement et la détection de changement.
- La vérification d'intégrité, la réparation et la politique anti-perte.
- La sauvegarde, la restauration et la reprise après sinistre.
- La stratégie de migration de schéma sur quinze ans.
- La portabilité entre moteurs de stockage.
- L'export et l'archivage à long terme.
- Le dimensionnement et la performance.

---

# Chapitre 1 — Invariants de stockage

Sept invariants gouvernent l'ensemble du volume. Ils sont testables, et chacun est rattaché à un critère d'acceptation du chapitre 14.

| # | Invariant | Signification opérationnelle |
|---|---|---|
| I-1 | Immuabilité | Un fichier écrit dans le Content Store n'est jamais modifié ni écrasé |
| I-2 | Atomicité | Un document est soit entièrement présent et indexé, soit totalement absent |
| I-3 | Vérifiabilité | Tout octet stocké est ré-adressable par son empreinte, à tout moment |
| I-4 | Auto-description | Le magasin reste interprétable sans la base de données |
| I-5 | Traçabilité | Toute écriture est rattachée à une exécution, une source et un instant |
| I-6 | Non-destruction | Aucune opération courante ne supprime de contenu |
| I-7 | Portabilité | La disposition physique ne dépend d'aucun moteur de base de données |

## 1.1 Sur l'invariant I-4

L'invariant d'auto-description mérite un développement, car il est contre-intuitif et coûteux.

Il exige que, si la base de données est intégralement perdue, le corpus reste exploitable : chaque fichier stocké est accompagné d'un descripteur JSON qui contient tout ce qu'il faut pour reconstruire l'index. La base de données devient alors un **cache reconstructible**, jamais une source de vérité unique.

Le coût est réel : une écriture supplémentaire par document, environ 1 Kio de surcharge. Le bénéfice est asymétrique : il transforme une catastrophe (perte de corpus) en incident (reconstruction de quelques heures).

```
lcf reindex --from-store ./data/objects
  -> parcourt le magasin, relit les descripteurs, reconstruit la base
```

## 1.2 Sur l'invariant I-6

« Aucune opération courante ne supprime » ne signifie pas « rien n'est jamais supprimable ». Cela signifie qu'aucune suppression n'est un effet de bord. Les seules suppressions autorisées sont explicites, journalisées, motivées et exécutées par une commande dédiée dont le nom dit ce qu'elle fait (`lcf purge --reason ...`). Voir chapitre 9.

---

# Chapitre 2 — Modèle conceptuel

## 2.1 Entités

```
   Source 1 ------ * Document 1 ------ * DocumentVersion
      |                  |                     |
      |                  |                     | 1
      |                  |                     |
      |                  |                     * 
      |                  |                 ContentObject
      |                  |                     (partage)
      |                  * 
      |             DocumentMetadata
      |
      * 
     Run 1 ------ * RunEvent
      |
      * 
   FetchAttempt
```

| Entité | Rôle | Mutabilité |
|---|---|---|
| `Source` | Une source configurée, correspondant à un plugin | Mutable (configuration) |
| `Document` | Une entité documentaire stable dans le temps | Quasi immuable |
| `DocumentVersion` | Un état daté du contenu d'un document | Immuable |
| `ContentObject` | Une suite d'octets adressée par son empreinte | Strictement immuable |
| `DocumentMetadata` | Métadonnées natives, par version | Immuable |
| `Run` | Une exécution de collecte | Immuable après clôture |
| `FetchAttempt` | Une tentative de récupération, réussie ou non | Immuable |

## 2.2 La distinction centrale : Document, Version, ContentObject

C'est la décision structurante de tout le volume.

```
Document  "acte n° 2024-118"          <- identite, ne change jamais
   |
   +-- Version 1  (2024-03-04)  --> ContentObject sha256:a1b2...
   +-- Version 2  (2024-06-19)  --> ContentObject sha256:c3d4...
   +-- Version 3  (2025-01-08)  --> ContentObject sha256:a1b2...   (retour v1)
```

Trois conséquences directes :

1. Un même `ContentObject` peut être référencé par plusieurs versions, voire par plusieurs documents. La déduplication est structurelle, pas optionnelle.
2. Une source qui republie un contenu antérieurement retiré est correctement représentée (version 3 ci-dessus) sans duplication d'octets.
3. Une même circulaire publiée par deux sources différentes n'occupe l'espace qu'une fois, tout en conservant deux `Document` distincts avec leurs provenances propres.

> Confondre le document et son contenu est l'erreur de conception la plus fréquente des systèmes de collecte. Elle rend impossible la réponse à la question la plus courante posée à un corpus juridique : « ce texte a-t-il été modifié, et quand ? »

## 2.3 Identités

| Identité | Formule | Propriétés |
|---|---|---|
| `source_id` | Fourni par la configuration | Stable, lisible, unique |
| `document_id` | `sha256(source_id ‖ 0x1F ‖ native_id)` | Déterministe, indépendant du contenu |
| `content_hash` | `sha256(octets)` | Déterministe, indépendant de la source |
| `version_no` | Entier croissant par document | Ordonné, dense, sans trou |
| `run_id` | ULID | Trié par le temps, unique |

Le séparateur `0x1F` (Unit Separator) n'est pas cosmétique : sans séparateur non ambigu, `("ab", "c")` et `("a", "bc")` produiraient le même identifiant. Une collision d'identité entre deux sources est indétectable une fois survenue.

---

# Chapitre 3 — Schéma relationnel

## 3.1 DDL de référence

Le DDL ci-dessous est écrit en SQL portable. Les spécificités de moteur sont isolées au chapitre 12.

```
-- =====================================================================
-- SOURCES
-- =====================================================================
CREATE TABLE sources (
  source_id            TEXT PRIMARY KEY,
  plugin_id            TEXT NOT NULL,
  plugin_version       TEXT NOT NULL,
  api_version          TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  config_json          TEXT NOT NULL,
  config_hash          TEXT NOT NULL,
  state                TEXT NOT NULL
                       CHECK (state IN ('ready','active','quarantined','disabled')),
  quarantine_reason    TEXT,
  quarantined_at       TEXT,
  first_seen_at        TEXT NOT NULL,
  last_run_at          TEXT,
  last_success_at      TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- =====================================================================
-- DOCUMENTS  (identite stable)
-- =====================================================================
CREATE TABLE documents (
  document_id          TEXT PRIMARY KEY,
  source_id            TEXT NOT NULL REFERENCES sources(source_id),
  native_id            TEXT NOT NULL,
  canonical_url        TEXT,
  current_version      INTEGER NOT NULL DEFAULT 0,
  version_count        INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL
                       CHECK (status IN ('discovered','stored','failed','withdrawn')),
  first_discovered_at  TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  last_changed_at      TEXT,
  discovery_run_id     TEXT NOT NULL,
  UNIQUE (source_id, native_id)
);

CREATE INDEX idx_documents_source_seen  ON documents(source_id, last_seen_at DESC);
CREATE INDEX idx_documents_status       ON documents(status, source_id);
CREATE INDEX idx_documents_changed      ON documents(last_changed_at DESC);

-- =====================================================================
-- CONTENT OBJECTS  (octets, adresses par empreinte)
-- =====================================================================
CREATE TABLE content_objects (
  content_hash         TEXT PRIMARY KEY,       -- "sha256:<hex>"
  byte_size            INTEGER NOT NULL,
  mime_type            TEXT NOT NULL,
  detected_mime        TEXT,                   -- issu des magic bytes
  storage_path         TEXT NOT NULL,          -- relatif a la racine du magasin
  compression          TEXT NOT NULL DEFAULT 'none'
                       CHECK (compression IN ('none','zstd','gzip')),
  stored_at            TEXT NOT NULL,
  ref_count            INTEGER NOT NULL DEFAULT 0,
  last_verified_at     TEXT,
  verify_status        TEXT NOT NULL DEFAULT 'unverified'
                       CHECK (verify_status IN ('unverified','ok','corrupt','missing'))
);

CREATE INDEX idx_content_verify ON content_objects(verify_status, last_verified_at);

-- =====================================================================
-- DOCUMENT VERSIONS  (etat date d'un document)
-- =====================================================================
CREATE TABLE document_versions (
  document_id          TEXT NOT NULL REFERENCES documents(document_id),
  version_no           INTEGER NOT NULL,
  content_hash         TEXT NOT NULL REFERENCES content_objects(content_hash),
  fetched_at           TEXT NOT NULL,
  fetched_from_url     TEXT,
  http_etag            TEXT,
  http_last_modified   TEXT,
  run_id               TEXT NOT NULL REFERENCES runs(run_id),
  change_reason        TEXT NOT NULL
                       CHECK (change_reason IN ('initial','content_changed',
                                                'reingest','repair')),
  supersedes_version   INTEGER,
  PRIMARY KEY (document_id, version_no)
);

CREATE INDEX idx_versions_content ON document_versions(content_hash);
CREATE INDEX idx_versions_run     ON document_versions(run_id);

-- =====================================================================
-- METADONNEES  (par version, jamais ecrasees)
-- =====================================================================
CREATE TABLE document_metadata (
  document_id          TEXT NOT NULL,
  version_no           INTEGER NOT NULL,
  raw_json             TEXT NOT NULL,
  common_json          TEXT,
  provenance_json      TEXT NOT NULL,
  extracted_at         TEXT NOT NULL,
  extractor_version    TEXT NOT NULL,
  PRIMARY KEY (document_id, version_no),
  FOREIGN KEY (document_id, version_no)
    REFERENCES document_versions(document_id, version_no)
);

-- =====================================================================
-- EXECUTIONS
-- =====================================================================
CREATE TABLE runs (
  run_id               TEXT PRIMARY KEY,        -- ULID
  source_id            TEXT NOT NULL REFERENCES sources(source_id),
  mode                 TEXT NOT NULL
                       CHECK (mode IN ('full','incremental','range','single','repair')),
  trigger              TEXT NOT NULL
                       CHECK (trigger IN ('schedule','manual','api','retry')),
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  status               TEXT NOT NULL
                       CHECK (status IN ('running','completed','failed','cancelled')),
  docs_discovered      INTEGER NOT NULL DEFAULT 0,
  docs_new             INTEGER NOT NULL DEFAULT 0,
  docs_updated         INTEGER NOT NULL DEFAULT 0,
  docs_unchanged       INTEGER NOT NULL DEFAULT 0,
  docs_failed          INTEGER NOT NULL DEFAULT 0,
  bytes_downloaded     INTEGER NOT NULL DEFAULT 0,
  requests_made        INTEGER NOT NULL DEFAULT 0,
  error_summary        TEXT,
  checkpoint_json      TEXT
);

CREATE INDEX idx_runs_source_time ON runs(source_id, started_at DESC);

-- =====================================================================
-- TENTATIVES DE RECUPERATION  (journal des echecs inclus)
-- =====================================================================
CREATE TABLE fetch_attempts (
  attempt_id           INTEGER PRIMARY KEY,
  document_id          TEXT NOT NULL,
  run_id               TEXT NOT NULL REFERENCES runs(run_id),
  attempt_no           INTEGER NOT NULL,
  url                  TEXT,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  http_status          INTEGER,
  bytes_received       INTEGER,
  outcome              TEXT NOT NULL
                       CHECK (outcome IN ('success','transient_error',
                                          'permanent_error','skipped')),
  error_class          TEXT,
  error_detail         TEXT
);

CREATE INDEX idx_attempts_doc ON fetch_attempts(document_id, started_at DESC);
CREATE INDEX idx_attempts_run ON fetch_attempts(run_id, outcome);

-- =====================================================================
-- JOURNAL D'INTEGRITE
-- =====================================================================
CREATE TABLE integrity_log (
  check_id             INTEGER PRIMARY KEY,
  content_hash         TEXT NOT NULL,
  checked_at           TEXT NOT NULL,
  result               TEXT NOT NULL
                       CHECK (result IN ('ok','hash_mismatch','missing_file',
                                         'size_mismatch','unreadable')),
  expected_hash        TEXT,
  actual_hash          TEXT,
  action_taken         TEXT
);

-- =====================================================================
-- VERSION DE SCHEMA
-- =====================================================================
CREATE TABLE schema_migrations (
  version              INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL,
  applied_at           TEXT NOT NULL,
  checksum             TEXT NOT NULL,
  execution_ms         INTEGER
);
```

## 3.2 Conventions transversales

| Convention | Règle | Motif |
|---|---|---|
| Horodatages | `TEXT`, ISO-8601 UTC avec `Z`, millisecondes | Lisible, triable lexicographiquement, sans piège de fuseau |
| Empreintes | `TEXT`, préfixé de l'algorithme (`sha256:`) | Permet de changer d'algorithme sans migration de colonne |
| JSON | `TEXT` contenant du JSON canonique | Portable entre SQLite et PostgreSQL |
| Booléens | `INTEGER` 0/1 | SQLite n'a pas de type booléen natif |
| Énumérations | `TEXT` + contrainte `CHECK` | Lisible en inspection directe, validé par le moteur |

Le préfixe d'algorithme sur les empreintes anticipe un événement quasi certain sur quinze ans : le remplacement de SHA-256. Le jour venu, `sha3-512:...` cohabitera avec `sha256:...` dans la même colonne, sans migration destructive.

## 3.3 Vues de commodité

```
CREATE VIEW v_current_documents AS
SELECT
  d.document_id, d.source_id, d.native_id, d.canonical_url, d.status,
  v.version_no, v.fetched_at, v.content_hash,
  c.byte_size, c.mime_type, c.verify_status
FROM documents d
JOIN document_versions v
  ON v.document_id = d.document_id AND v.version_no = d.current_version
JOIN content_objects c
  ON c.content_hash = v.content_hash;

CREATE VIEW v_source_health AS
SELECT
  s.source_id, s.state,
  COUNT(DISTINCT d.document_id)                              AS documents,
  SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END)       AS failed,
  MAX(s.last_success_at)                                     AS last_success,
  (SELECT COUNT(*) FROM runs r
    WHERE r.source_id = s.source_id AND r.status = 'failed'
      AND r.started_at > datetime('now','-7 days'))          AS failed_runs_7d
FROM sources s
LEFT JOIN documents d ON d.source_id = s.source_id
GROUP BY s.source_id, s.state;
```

---

# Chapitre 4 — Le Content Store

## 4.1 Adressage par contenu

Le magasin est un *content-addressable store* : le chemin d'un fichier est dérivé de son empreinte.

```
data/
  objects/
    6b/
      1d/
        6b1d4e0f8a2c...f31.bin      <- octets originaux, jamais modifies
        6b1d4e0f8a2c...f31.json     <- descripteur auto-portant
  tmp/
    run_01J9X3S9/                   <- zone de transit, nettoyee au demarrage
  index/
    lcf.db                          <- base de donnees (reconstructible)
  backup/
```

Le partitionnement à deux niveaux sur les quatre premiers caractères hexadécimaux produit 65 536 répertoires terminaux. À 100 millions de documents, cela reste environ 1 500 fichiers par répertoire — en deçà du seuil où les systèmes de fichiers classiques se dégradent.

## 4.2 Propriétés obtenues

| Propriété | Conséquence |
|---|---|
| Déduplication native | Deux contenus identiques occupent un seul fichier |
| Vérification triviale | Le chemin *est* l'empreinte attendue |
| Écriture sans verrou | Deux processus écrivant le même contenu produisent le même résultat |
| Immuabilité naturelle | Modifier le contenu changerait son adresse : l'écrasement n'a pas de sens |
| Sauvegarde incrémentale | Un fichier existant n'est jamais réécrit, donc jamais re-sauvegardé |

## 4.3 Le descripteur auto-portant

C'est l'implémentation de l'invariant I-4.

```
{
  "lcfObjectVersion": 1,
  "contentHash": "sha256:6b1d4e0f8a2c...f31",
  "byteSize": 482911,
  "mimeType": "application/pdf",
  "detectedMime": "application/pdf",
  "storedAt": "2026-08-30T03:14:07.221Z",
  "references": [
    {
      "documentId": "9f2c...ab71",
      "sourceId": "xx.gazette.official",
      "nativeId": "2024/118",
      "versionNo": 3,
      "fetchedFromUrl": "https://gazette.example/acts/2024-118.pdf",
      "fetchedAt": "2026-08-30T03:14:05.882Z",
      "runId": "run_01J9X3S9",
      "httpEtag": "\"a1b2c3\"",
      "metadata": {
        "raw": { "titre": "Acte n. 2024-118", "rubrique": "Actes" },
        "provenance": [
          { "field": "titre", "locator": "h1.doc-title",
            "at": "https://gazette.example/acts/2024-118" }
        ]
      }
    }
  ]
}
```

Le descripteur est une liste de références, pas une référence unique : un objet partagé par plusieurs documents accumule ses provenances. Le descripteur est réécrit atomiquement (écriture dans `tmp/` puis `rename`) à chaque nouvelle référence — c'est la seule exception apparente à l'immuabilité, et elle ne porte que sur les métadonnées, jamais sur les octets du document.

## 4.4 Compression

| Type de contenu | Politique | Justification |
|---|---|---|
| PDF, images, archives | Aucune | Déjà compressé ; la recompression coûte du CPU pour ~0 % de gain |
| HTML, XML, JSON, texte | `zstd` niveau 3 au-delà de 4 Kio | Gain typique de 70 à 85 % |
| Inconnu | Aucune | En cas de doute, on ne transforme pas |

Point capital : **l'empreinte porte toujours sur les octets décompressés**. Le mode de compression est un détail de stockage enregistré dans `content_objects.compression`. Changer de politique de compression n'invalide donc aucune empreinte, ne casse aucune référence, et n'exige aucune migration.

---

# Chapitre 5 — Protocole d'écriture atomique

## 5.1 Séquence complète

C'est le chemin critique du système. Toute panne à n'importe quelle étape doit laisser le magasin dans un état cohérent.

```
E1  Creer data/tmp/<run_id>/<uuid>.part
E2  Streamer les octets, calculer SHA-256 au fil de l'eau
E3  Verifier taille, type MIME, magic bytes
E4  Calculer le chemin cible depuis l'empreinte
E5  L'objet existe deja ?
      OUI -> aller a E8   (deduplication)
      NON -> continuer
E6  fsync du fichier temporaire
E7  rename atomique  tmp/*.part -> objects/xx/yy/<hash>.bin
E8  Ecrire/mettre a jour le descripteur .json (tmp + rename)
E9  fsync du repertoire parent
E10 TRANSACTION BASE :
       INSERT OR IGNORE content_objects
       INSERT document_versions
       INSERT document_metadata
       UPDATE documents (current_version, last_seen_at, version_count)
       UPDATE content_objects.ref_count
       INSERT fetch_attempts
       UPDATE runs (compteurs)
    COMMIT
E11 Emettre lcf.document.stored
```

## 5.2 Analyse de panne, étape par étape

| Panne après | État du magasin | Récupération |
|---|---|---|
| E1–E6 | Un fichier `.part` orphelin | Nettoyé au démarrage suivant |
| E7 | Objet présent, absent de la base | Le prochain passage le redécouvre ; `rename` sur un objet existant est un no-op |
| E8 | Objet présent, descripteur incomplet | Réparé par `lcf repair --descriptors` |
| E10 (avant commit) | Objet présent, base inchangée | Idem E7 ; aucune perte |
| E10 (après commit) | Cohérent | — |
| E11 | Cohérent, événement non émis | Rejoué depuis le journal d'événements |

Aucune séquence de panne ne produit une entrée de base pointant vers un fichier absent. C'est l'ordre qui le garantit : **le fichier est toujours écrit et synchronisé avant la transaction**. L'inverse — écrire la base puis le fichier — produirait des références fantômes, c'est-à-dire une corruption silencieuse.

> `rename` sur un même système de fichiers est atomique sur POSIX comme sur NTFS. C'est la seule primitive d'atomicité dont dépend le Content Store. Elle interdit en revanche que `tmp/` et `objects/` soient sur des volumes différents — contrainte vérifiée au démarrage.

## 5.3 Concurrence

| Situation | Résolution |
|---|---|
| Deux exécutions écrivent le même contenu | Le `rename` gagnant l'emporte, l'autre est un no-op ; empreintes identiques donc contenu identique |
| Deux exécutions sur la même source | Interdit : verrou exclusif par source, tenu par le Scheduler |
| Écriture pendant une vérification d'intégrité | Le vérificateur ne lit que les objets déjà présents en base et déjà commités |
| Lecture pendant écriture | Impossible d'observer un état partiel : l'objet n'apparaît qu'après `rename` |

---

# Chapitre 6 — Modèle de versionnement

## 6.1 Décision de version

À chaque collecte d'un document déjà connu :

```
                 Document connu ?
                   /          \
                 non          oui
                  |            |
            version 1     Comparer contenu
          change_reason         |
            = initial     +-----+------+
                          |            |
                    hash identique  hash different
                          |            |
                  aucune version   version N+1
                  UPDATE last_seen  change_reason
                                    = content_changed
```

## 6.2 Détection de changement en trois niveaux

L'objectif est de ne pas retélécharger inutilement, sans jamais manquer un changement réel.

| Niveau | Test | Coût réseau | Fiabilité |
|---|---|---|---|
| N1 | `If-None-Match` sur l'ETag connu | Une requête conditionnelle | Élevée si la source respecte HTTP |
| N2 | `If-Modified-Since` sur `Last-Modified` | Une requête conditionnelle | Moyenne, dates souvent fausses |
| N3 | Téléchargement complet et comparaison d'empreinte | Coût total | Absolue |

Politique : N1 puis N2 comme optimisations, **N3 obligatoirement** lors du balayage complet périodique. Les niveaux 1 et 2 sont des accélérateurs opportunistes ; seul N3 fait autorité.

```
async function decideVersion(doc, ref, plan) {
  const known = await repo.currentVersion(doc.documentId);
  if (!known) return { action: "create", reason: "initial" };

  if (ref.etag && ref.etag === known.httpEtag && !forceFull) {
    return { action: "skip", reason: "etag_match" };   // N1
  }

  const bytes = await downloader.fetch(plan);          // N3
  const hash  = sha256(bytes);

  if (hash === known.contentHash) {
    return { action: "touch", reason: "identical_content" };
  }
  return { action: "create", reason: "content_changed", hash, bytes };
}
```

## 6.3 Ce qui ne crée jamais une version

Ces cas ont été identifiés parce qu'ils produisent, dans les systèmes naïfs, un bruit de version qui rend l'historique inexploitable :

- une différence de métadonnées seule, sans changement d'octets ;
- un changement d'URL sans changement de contenu ;
- une recollecte du même contenu (`change_reason = reingest` est réservé aux réimportations administratives explicites) ;
- une re-vérification d'intégrité réussie ;
- une modification de la configuration de la source.

## 6.4 Le cas du document retiré

Une source qui cesse d'exposer un document ne provoque **aucune suppression**.

```
Document non revu lors de N balayages complets consecutifs
  -> status = 'withdrawn'
  -> withdrawn_at renseigne
  -> toutes les versions et tous les octets restent intacts
  -> le document reste interrogeable et telechargeable
```

Le seuil `N` est configurable, avec 3 pour valeur par défaut. Trois balayages complets consécutifs éliminent la quasi-totalité des faux positifs dus à une panne temporaire de source, à une refonte de site ou à une erreur d'indexation en amont.

> Le retrait d'un document par une source officielle est une information juridiquement significative. La supprimer du corpus détruirait précisément la donnée qui a de la valeur : le fait qu'elle a existé, et la date à laquelle elle a cessé d'être publiée.

---

# Chapitre 7 — Intégrité

## 7.1 Trois moments de vérification

| Moment | Portée | Fréquence | Action sur échec |
|---|---|---|---|
| À l'écriture | Le document courant | Systématique | Rejet, aucune écriture |
| À la lecture | Le document lu | Systématique | Erreur, marquage `corrupt` |
| En arrière-plan | Tout le magasin | Continue, par lots | Marquage puis réparation |

## 7.2 Le vérificateur de fond

```
export class IntegrityScanner {
  /** Verifie par lots, sans jamais saturer les E/S. */
  async scan(opts: ScanOptions): Promise<void> {
    const batch = await this.repo.oldestUnverified(opts.batchSize);

    for (const obj of batch) {
      const result = await this.verifyOne(obj);
      await this.repo.recordIntegrityCheck(result);

      if (result.result !== "ok") {
        this.bus.emit("lcf.integrity.violation", {
          contentHash: obj.contentHash,
          result: result.result,
          affectedDocuments: await this.repo.documentsFor(obj.contentHash),
        });
      }
      await this.throttle.wait();      // ne concurrence jamais la collecte
    }
  }
}
```

Cadence par défaut : l'intégralité du magasin est revérifiée sur une fenêtre glissante de 30 jours, en priorisant les objets les plus anciennement vérifiés. Sur un corpus d'un million de documents, cela représente environ 1 400 vérifications par heure — négligeable en E/S.

## 7.3 Réparation

Trois stratégies, dans l'ordre de préférence :

| Ordre | Stratégie | Condition | Résultat |
|---|---|---|---|
| 1 | Restauration depuis sauvegarde | Une sauvegarde contient l'empreinte attendue | Restauration exacte, aucune nouvelle version |
| 2 | Recollecte depuis la source | Le document est encore publié | Vérifie si le contenu est identique ; version `repair` sinon |
| 3 | Marquage définitif | Aucune des deux | `verify_status = corrupt`, document signalé, rien n'est supprimé |

Un objet corrompu n'est **jamais** supprimé. Il est marqué. Un fichier corrompu contient encore de l'information ; sa suppression n'en contient aucune.

## 7.4 Rapport d'intégrité

```
lcf verify --all --report

Magasin       : ./data/objects
Objets        : 1 284 991
Verifies      : 1 284 991
Octets        : 4.21 Tio
Duree         : 3 h 42 min

  ok             1 284 987
  hash_mismatch          2   -> restaures depuis backup-2026-08-01
  missing_file           1   -> recollecte, contenu identique
  unreadable             1   -> marque corrupt, document 9f2c...ab71

VERDICT : 4 anomalies, 3 reparees, 1 signalee
```

---

# Chapitre 8 — Rétention et purge

## 8.1 Position de principe

Le Framework ne purge pas. Il conserve. Le stockage coûte moins cher que la reconstitution d'un corpus perdu, et infiniment moins cher qu'une donnée juridique manquante au moment où on en a besoin.

Trois exceptions, toutes explicites.

## 8.2 Exception 1 — Obligation légale

Une injonction de suppression est un fait juridique auquel le système doit pouvoir répondre. La suppression est alors **tracée**, ce qui préserve l'auditabilité sans conserver le contenu.

```
lcf purge --document <id> --reason legal --ref "decision 2026-XXX" --confirm

  -> octets supprimes du Content Store
  -> descripteur remplace par une pierre tombale
  -> lignes de base conservees, content_hash mis a NULL
  -> tombstones : qui, quand, sur quel fondement
```

```
{
  "lcfObjectVersion": 1,
  "tombstone": true,
  "contentHash": "sha256:6b1d...f31",
  "purgedAt": "2026-09-14T10:22:41Z",
  "reason": "legal",
  "legalRef": "decision 2026-XXX",
  "operator": "ops@example.org",
  "byteSize": 482911
}
```

La pierre tombale est essentielle : sans elle, une vérification d'intégrité ultérieure signalerait un fichier manquant, et l'on ne saurait pas distinguer une suppression légitime d'une corruption.

## 8.3 Exception 2 — Purge de versions intermédiaires

Uniquement sur commande explicite, jamais automatiquement, et jamais sur la première ni la dernière version d'un document.

```
lcf prune-versions --source <id> --keep-first --keep-last --keep-per-year 1 --dry-run
```

Le mode `--dry-run` est le défaut. La commande refuse de s'exécuter sans `--confirm`.

## 8.4 Exception 3 — Ramasse-miettes des objets orphelins

Un `ContentObject` dont `ref_count = 0` peut être collecté après une période de grâce d'au moins 30 jours, et uniquement après recomptage complet des références.

```
lcf gc --min-age 30d --dry-run
  -> recompte ref_count depuis document_versions (jamais confiance au compteur)
  -> liste les objets a zero reference depuis plus de 30 jours
  -> --confirm requis pour agir
```

Le recomptage complet, plutôt que la lecture du compteur, est délibéré : un compteur dérivé qui a dérivé provoquerait la suppression d'un objet encore référencé. La règle générale s'applique — sur un chemin destructif, on ne fait jamais confiance à une donnée dérivée.

---

# Chapitre 9 — Sauvegarde et restauration

## 9.1 Trois classes de données, trois politiques

| Classe | Volume | Politique | RPO cible |
|---|---|---|---|
| Content Store | Très gros, immuable | Incrémental, uniquement les nouveaux objets | 24 h |
| Base d'index | Petite, mutable | Instantané complet | 1 h |
| Configuration | Minuscule | Contrôle de version | 0 |

L'immuabilité rend la sauvegarde du magasin triviale : un objet sauvegardé n'a jamais besoin d'être re-sauvegardé. Une simple synchronisation en ajout seul suffit, sans détection de modification.

```
lcf backup --target s3://bucket/lcf --mode incremental
  objects/ : ajout seul, aucune reecriture, aucune suppression
  index/   : instantane coherent via l'API de sauvegarde du moteur
```

## 9.2 Restauration

```
Scenario A — Base perdue, magasin intact
  lcf reindex --from-store ./data/objects
  Duree : ~2 h par million de documents
  Perte : aucune (invariant I-4)

Scenario B — Magasin partiellement perdu
  lcf restore --from s3://bucket/lcf --objects-only
  lcf verify --all --repair
  Perte : les objets absents des deux cotes, listes nominativement

Scenario C — Perte totale
  lcf restore --from s3://bucket/lcf --full
  lcf verify --all
  Perte : bornee par le RPO du magasin (24 h)
```

## 9.3 Vérification des sauvegardes

Une sauvegarde jamais restaurée n'est pas une sauvegarde : c'est une hypothèse.

Le Framework impose un test de restauration mensuel automatisé sur un échantillon aléatoire :

```
lcf backup-drill --sample 1000 --target s3://bucket/lcf
  -> restaure 1000 objets aleatoires dans un magasin temporaire
  -> verifie les empreintes
  -> compare aux descripteurs
  -> produit un rapport signe, echoue bruyamment si une anomalie apparait
```

---

# Chapitre 10 — Migrations de schéma

## 10.1 Le problème des quinze ans

Sur la durée de vie visée, le schéma évoluera des dizaines de fois. Trois exigences en découlent :

1. toute migration doit être rejouable et vérifiable ;
2. aucune migration ne doit pouvoir détruire de données ;
3. il doit rester possible de revenir en arrière d'au moins une version.

## 10.2 Format d'une migration

```
migrations/
  0001_initial_schema.sql
  0002_add_withdrawn_status.sql
  0003_add_detected_mime.sql
  ...
```

Chaque migration est un fichier SQL, immuable une fois publié, avec sa somme de contrôle enregistrée. Modifier une migration déjà appliquée est détecté au démarrage et bloque le lancement — sans quoi deux installations prétendant la même version de schéma pourraient avoir des schémas différents.

```
-- 0002_add_withdrawn_status.sql
-- Ajoute le statut 'withdrawn'. Reversible. Non destructive.

ALTER TABLE documents ADD COLUMN withdrawn_at TEXT;

-- SQLite ne permet pas d'alterer une contrainte CHECK :
-- reconstruction de table, en preservant integralement les donnees.
CREATE TABLE documents_new ( /* ... avec CHECK etendu ... */ );
INSERT INTO documents_new SELECT *, NULL FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
-- recreation des index...
```

## 10.3 Règles de migration

| Règle | Détail |
|---|---|
| Jamais de `DROP COLUMN` en une étape | Déprécier, cesser d'écrire, attendre deux versions majeures, puis supprimer |
| Jamais de perte de données | Une migration qui perd de l'information est refusée en revue |
| Toujours réversible | Une migration `down` accompagne chaque `up`, ou une justification écrite de son absence |
| Toujours testée sur volume réel | Une migration est mesurée sur un jeu de un million de lignes avant publication |
| Toujours précédée d'une sauvegarde | Le lanceur de migrations refuse de s'exécuter sans sauvegarde vérifiée récente |

## 10.4 Déroulement

```
1. Verifier la presence d'une sauvegarde de moins de 24 h  -> sinon ABANDON
2. Verifier les sommes de controle des migrations appliquees -> divergence : ABANDON
3. Lister les migrations en attente
4. Pour chaque migration, dans l'ordre :
     BEGIN
       executer le SQL
       INSERT INTO schema_migrations
     COMMIT
     -> toute erreur : ROLLBACK et arret immediat
5. Executer les verifications d'invariants post-migration
6. Emettre lcf.schema.migrated
```

L'étape 5 n'est pas décorative :

```
-- Aucune version orpheline
SELECT COUNT(*) FROM document_versions v
  LEFT JOIN documents d USING (document_id) WHERE d.document_id IS NULL;
-- attendu : 0

-- Aucune version sans objet de contenu
SELECT COUNT(*) FROM document_versions v
  LEFT JOIN content_objects c USING (content_hash) WHERE c.content_hash IS NULL;
-- attendu : 0

-- current_version coherent avec le maximum reel
SELECT COUNT(*) FROM documents d WHERE d.current_version <>
  (SELECT MAX(version_no) FROM document_versions v
    WHERE v.document_id = d.document_id);
-- attendu : 0
```

---

# Chapitre 11 — Portabilité du moteur de stockage

## 11.1 Le contrat de dépôt

Le Volume I exige que SQLite puisse être remplacé par PostgreSQL sans toucher au cœur. Cette exigence se matérialise par une interface de dépôt qui n'expose jamais de SQL.

```
export interface DocumentRepository {
  findByNativeId(sourceId: SourceId, nativeId: string): Promise<Document | null>;
  currentVersion(documentId: DocumentId): Promise<DocumentVersion | null>;
  listVersions(documentId: DocumentId): Promise<DocumentVersion[]>;
  query(q: DocumentQuery): Promise<Page<DocumentSummary>>;

  /** Ecriture transactionnelle : tout ou rien. */
  commitDocument(tx: DocumentCommit): Promise<CommitResult>;

  /** Unite de travail explicite, portable entre moteurs. */
  withTransaction<T>(fn: (repo: DocumentRepository) => Promise<T>): Promise<T>;
}
```

## 11.2 Différences encapsulées

| Aspect | SQLite | PostgreSQL | Encapsulation |
|---|---|---|---|
| Concurrence en écriture | Un seul écrivain | MVCC | Le Scheduler sérialise par source dans les deux cas |
| Upsert | `INSERT OR IGNORE` | `ON CONFLICT DO NOTHING` | Générateur SQL par dialecte |
| JSON | `json_extract` | opérateurs `->` / `->>` | Méthodes de requête dédiées |
| Recherche plein texte | FTS5 | `tsvector` | Interface `SearchIndex` séparée |
| Journalisation | WAL | WAL | Configuration, pas code |

## 11.3 Choix par profil de déploiement

| Profil | Moteur | Motif |
|---|---|---|
| Poste de travail, un opérateur | SQLite | Zéro administration, fichier unique, portable |
| Serveur unique, corpus < 10 M documents | SQLite en WAL | Suffisant, très rapide en lecture |
| Multi-processus, corpus > 10 M | PostgreSQL | Concurrence en écriture réelle |
| Multi-nœuds | PostgreSQL + magasin objet | Séparation index / stockage |

SQLite reste le défaut : il satisfait la contrainte du Volume I (« sans Docker obligatoire, sans API Cloud ») et couvre la grande majorité des déploiements réels sans aucune administration.

---

# Chapitre 12 — Export et archivage

## 12.1 Formats d'export

| Format | Usage | Contenu |
|---|---|---|
| `lcf-bundle` (tar) | Transfert entre instances | Objets + descripteurs + manifeste |
| JSONL | Alimentation de pipeline IA | Une ligne par document, chemins relatifs |
| BagIt (RFC 8493) | Archivage patrimonial | Structure normalisée avec sommes de contrôle |
| CSV | Analyse, tableur | Métadonnées uniquement, sans contenu |

## 12.2 Export JSONL

```
{"documentId":"9f2c...ab71","sourceId":"xx.gazette.official",
 "nativeId":"2024/118","version":3,"contentHash":"sha256:6b1d...f31",
 "contentPath":"objects/6b/1d/6b1d...f31.bin","bytes":482911,
 "mimeType":"application/pdf","fetchedAt":"2026-08-30T03:14:05.882Z",
 "sourceUrl":"https://gazette.example/acts/2024-118.pdf",
 "metadata":{"raw":{"titre":"Acte n. 2024-118"}}}
```

Une ligne par document, chemins relatifs, aucune dépendance à la base : un export reste exploitable des années plus tard sans le Framework qui l'a produit.

## 12.3 Archivage long terme

L'export BagIt vise l'horizon de plusieurs décennies, au-delà de la durée de vie du logiciel lui-même :

```
bag/
  bagit.txt
  bag-info.txt
  manifest-sha256.txt
  data/
    documents/...
    metadata/...
    README.txt        <- explique la structure en langage naturel
```

Le `README.txt` en langage naturel n'est pas un ornement : c'est ce qui permettra à quelqu'un, dans trente ans, d'interpréter l'archive sans aucune documentation technique du projet.

---

# Chapitre 13 — Performance et dimensionnement

## 13.1 Ordres de grandeur

| Métrique | Petit | Moyen | Grand |
|---|---|---|---|
| Documents | < 100 000 | 1 à 10 M | > 50 M |
| Octets | < 100 Gio | 1 à 10 Tio | > 50 Tio |
| Sources | < 10 | 10 à 100 | > 500 |
| Moteur | SQLite | SQLite WAL / PostgreSQL | PostgreSQL |
| Réindexation complète | < 5 min | 1 à 3 h | 12 à 24 h |

## 13.2 Objectifs de performance

| Opération | Cible | Mesurée sur |
|---|---|---|
| Recherche de document par `nativeId` | < 5 ms | Index unique |
| Écriture d'un document (hors réseau) | < 50 ms | Écriture + transaction |
| Liste paginée, 100 lignes | < 100 ms | Index couvrant |
| Vérification d'intégrité, un objet | < 20 ms/Mio | Débit disque |
| Réindexation | > 150 doc/s | Monofil, SQLite |

## 13.3 Points de contention connus

| Point | Symptôme | Atténuation |
|---|---|---|
| Écrivain unique SQLite | Erreurs `SQLITE_BUSY` | WAL, transactions courtes, sérialisation par source |
| Répertoire trop peuplé | Ralentissement des `stat` | Partitionnement à deux niveaux (4.1) |
| Descripteurs très référencés | Réécriture JSON coûteuse | Ajout en fin de fichier au-delà de 100 références |
| Vérification concurrente à la collecte | Saturation E/S | Limitation de débit du scanner (7.2) |

---

# Chapitre 14 — Critères d'acceptation du Volume IV

## AC-4.1 — Atomicité sous panne

```
ETANT DONNE une ecriture de document interrompue par une coupure brutale
QUAND le Kernel redemarre
ALORS aucune ligne de base ne reference un fichier absent
  ET les fichiers .part orphelins sont nettoyes
  ET le document est recollecte normalement au passage suivant
```

## AC-4.2 — Reconstruction depuis le magasin seul

```
ETANT DONNE un corpus de 100 000 documents
QUAND la base d'index est integralement supprimee
ALORS `lcf reindex --from-store` reconstruit 100 000 documents
  ET tous les document_id sont identiques a l'original
  ET tous les content_hash sont identiques a l'original
  ET aucun octet n'a ete relu depuis le reseau
```

## AC-4.3 — Déduplication

```
ETANT DONNE deux sources publiant un fichier strictement identique
QUAND les deux sont collectees
ALORS un seul ContentObject existe sur disque
  ET deux Documents distincts le referencent
  ET son descripteur contient les deux provenances
  ET ref_count vaut 2
```

## AC-4.4 — Idempotence de la collecte

```
ETANT DONNE une source inchangee
QUAND une collecte complete est executee dix fois
ALORS version_count reste identique pour chaque document
  ET aucun octet n'est reecrit
  ET seul last_seen_at est mis a jour
```

## AC-4.5 — Création de version

```
ETANT DONNE un document en version 2
QUAND la source publie un contenu different sous le meme native_id
ALORS une version 3 est creee avec change_reason = 'content_changed'
  ET les versions 1 et 2 restent telechargeables a l'octet pres
  ET documents.current_version vaut 3
```

## AC-4.6 — Non-destruction sur retrait

```
ETANT DONNE un document absent de trois balayages complets consecutifs
QUAND le troisieme balayage se termine
ALORS status devient 'withdrawn'
  ET aucun octet n'est supprime
  ET le document reste interrogeable et telechargeable
```

## AC-4.7 — Détection de corruption

```
ETANT DONNE un fichier du magasin altere hors du Framework
QUAND le scanner d'integrite l'examine
ALORS result vaut 'hash_mismatch'
  ET lcf.integrity.violation est emis avec la liste des documents affectes
  ET le fichier altere n'est pas supprime
```

## AC-4.8 — Sûreté des migrations

```
ETANT DONNE une base au schema version 7
QUAND une migration vers la version 8 echoue a mi-parcours
ALORS la base reste integralement en version 7
  ET aucune donnee n'a ete perdue
  ET l'echec est signale avec la migration fautive nommee
```

## AC-4.9 — Portabilité du moteur

```
ETANT DONNE un corpus stocke sous SQLite
QUAND il est migre vers PostgreSQL
ALORS le nombre de documents, versions et objets est identique
  ET tous les document_id et content_hash sont identiques
  ET aucun code du domaine ni du Kernel n'a ete modifie
```

---

# Chapitre 15 — Décisions d'architecture du Volume IV

## ADR-401 — Magasin adressé par contenu

**Statut** : Accepté · **Contexte** : Il faut la déduplication, l'immuabilité, la vérifiabilité et une sauvegarde incrémentale bon marché.
**Décision** : Le chemin de stockage est dérivé de SHA-256, avec un partitionnement à deux niveaux.
**Conséquences** : + Déduplication et immuabilité gratuites, sauvegarde en ajout seul, vérification triviale. − Chemins illisibles par un humain, nécessité d'un ramasse-miettes pour les orphelins.

## ADR-402 — Descripteur auto-portant par objet

**Statut** : Accepté · **Contexte** : Une base est le point de défaillance unique le plus probable d'un tel système.
**Décision** : Chaque objet est accompagné d'un JSON contenant tout le nécessaire à la réindexation.
**Conséquences** : + La base devient un cache reconstructible ; perte de base = incident, pas catastrophe. − ~1 Kio par objet ; réécriture du descripteur lors du partage.

## ADR-403 — Séparation Document / Version / ContentObject

**Statut** : Accepté · **Contexte** : Un document juridique est révisé ; son identité ne change pas pour autant.
**Décision** : Trois entités distinctes, trois cycles de vie distincts.
**Conséquences** : + Historique exact, déduplication inter-sources, republication correctement modélisée. − Trois jointures pour obtenir l'état courant, compensées par la vue `v_current_documents`.

## ADR-404 — Fichier avant base

**Statut** : Accepté · **Contexte** : Il faut choisir quel type d'incohérence on tolère en cas de panne.
**Décision** : Le fichier est écrit et synchronisé avant toute écriture en base.
**Conséquences** : + Aucune référence fantôme possible ; l'orphelin est réparable, la référence fantôme ne l'est pas. − Des objets orphelins temporaires, traités par le ramasse-miettes.

## ADR-405 — SQLite par défaut

**Statut** : Accepté · **Contexte** : Le Volume I interdit d'imposer Docker ou un service externe.
**Décision** : SQLite en WAL par défaut, PostgreSQL en option derrière la même interface de dépôt.
**Conséquences** : + Installation sans administration, fichier unique, sauvegarde triviale. − Un seul écrivain, contournable par sérialisation par source et migration possible à tout moment.

## ADR-406 — Empreinte sur les octets décompressés

**Statut** : Accepté · **Contexte** : La politique de compression doit pouvoir changer sans invalider le corpus.
**Décision** : `content_hash` porte toujours sur le contenu original décompressé.
**Conséquences** : + La compression devient un pur détail de stockage, modifiable rétroactivement. − Il faut décompresser pour vérifier, coût jugé négligeable.

---

# Synthèse du Volume IV

Le Volume IV a spécifié la couche qui doit survivre à toutes les autres.

Un magasin adressé par contenu, immuable, dédupliqué, sauvegardable par simple ajout. Un descripteur auto-portant qui rétrograde la base de données au rang de cache reconstructible. Un protocole d'écriture dont chaque point de panne a été analysé et dont aucun ne produit de référence fantôme. Un modèle à trois entités qui distingue l'identité d'un document, ses états successifs, et les octets qui les portent. Une politique de rétention qui conserve par défaut et ne supprime que sur ordre explicite et tracé.

Ces choix coûtent plus cher à écrire qu'un simple répertoire de fichiers indexé en base. Ils se paient une seule fois. L'alternative se paie le jour où l'on découvre qu'une partie du corpus a disparu sans que personne ne s'en aperçoive — et ce jour-là, aucune quantité de code n'y remédie.

**Volume V — Processing Pipeline & Extraction Layer** spécifiera ce qui se construit au-dessus de ce socle : l'architecture du pipeline de traitement, l'extraction de texte, la normalisation, l'enrichissement, la détection de langue et de structure, la mise en file, la reprise, et la frontière stricte entre collecte et interprétation.
