SET lock_timeout = '3s';

-- Append-only log of Yjs updates, one row per ~1 s batch per document.
-- doc_id is text until phase 3 adds a documents table to reference.
CREATE TABLE doc_updates (
  doc_id text NOT NULL,
  seq bigserial,
  update bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, seq)
);

-- The log up to and including upto_seq, merged into one Yjs update. One row per document.
CREATE TABLE doc_snapshots (
  doc_id text PRIMARY KEY,
  state bytea NOT NULL,
  upto_seq bigint NOT NULL
);
