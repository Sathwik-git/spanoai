-- Artifact metadata. The file BYTES live in object storage (MinIO/S3/R2);
-- this table holds only references, checksums, and lifecycle status.
CREATE TABLE IF NOT EXISTS artifacts (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  created_by_agent TEXT NOT NULL,
  name             TEXT NOT NULL,            -- display name (never used for paths)
  storage_key      TEXT NOT NULL,            -- sanitized object key in the bucket
  mime_type        TEXT NOT NULL,
  size_bytes       BIGINT NOT NULL,          -- expected at init; verified at complete
  sha256           TEXT,                     -- expected at init; verified at complete
  kind             TEXT NOT NULL DEFAULT 'file',
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','available','quarantined','rejected','deleted')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_session
  ON artifacts(tenant_id, session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_status
  ON artifacts(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_expires
  ON artifacts(expires_at) WHERE expires_at IS NOT NULL;
