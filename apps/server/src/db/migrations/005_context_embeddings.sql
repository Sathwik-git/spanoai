-- Semantic search index for context values. Vectors live here; the live value
-- stays in Redis. Embeddings are written asynchronously by a background job.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS context_embeddings (
  id         TEXT    PRIMARY KEY,
  tenant_id  TEXT    NOT NULL,
  session_id TEXT    NOT NULL,
  full_key   TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  embedding  vector(1536),
  ts         BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embed_session ON context_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_embed_lookup
  ON context_embeddings(tenant_id, session_id, full_key);
