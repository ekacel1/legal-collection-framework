-- 0001_initial_schema.sql
-- Schema de reference du Legal Collection Framework — Volume IV, chapitre 3.1.
--
-- Immuable une fois publiee. Toute correction passe par une migration
-- ulterieure : modifier ce fichier apres application est detecte au demarrage
-- par divergence de somme de controle, et bloque le lancement.
--
-- Ordre de creation : les tables referencees precedent les tables referencantes.
-- Le Volume IV presente le DDL par ordre de lecture ; il est ici reordonne pour
-- rester applicable tel quel sur un moteur qui resout les cles etrangeres a la
-- creation (PostgreSQL), sans qu'aucune colonne ni contrainte ne change.
--
-- La table `schema_migrations` n'est volontairement pas creee ici : elle
-- appartient au lanceur de migrations, qui doit pouvoir enregistrer
-- l'application de la migration 0001 elle-meme.

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
-- EXECUTIONS
-- =====================================================================
CREATE TABLE runs (
  run_id               TEXT PRIMARY KEY,        -- ULID prefixe "run_"
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

CREATE INDEX idx_integrity_hash ON integrity_log(content_hash, checked_at DESC);

-- =====================================================================
-- VUES DE COMMODITE  (Volume IV, 3.3)
-- =====================================================================
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

-- La fenetre glissante ci-dessous est la seule expression specifique au moteur
-- de tout le schema. Le portage PostgreSQL la remplacera par
-- `now() - interval '7 days'` dans sa propre variante de cette migration.
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
