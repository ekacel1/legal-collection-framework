-- 0002_add_withdrawn_status.sql
-- Ajoute la date de retrait d'un document — Volume IV, 6.4.
-- Reversible. Non destructive. Aucune ligne existante n'est touchee.
--
-- Un document qu'une source cesse d'exposer n'est jamais supprime : il passe
-- en statut 'withdrawn' et conserve toutes ses versions et tous ses octets.
-- Le retrait par une source officielle est une information juridiquement
-- significative ; la supprimer detruirait precisement la donnee qui a de la
-- valeur, a savoir que le document a existe et a cesse d'etre publie.
--
-- Le statut 'withdrawn' figure deja dans la contrainte CHECK de la migration
-- 0001 : aucune reconstruction de table n'est donc necessaire ici.

ALTER TABLE documents ADD COLUMN withdrawn_at TEXT;

CREATE INDEX idx_documents_withdrawn ON documents(withdrawn_at)
  WHERE withdrawn_at IS NOT NULL;
