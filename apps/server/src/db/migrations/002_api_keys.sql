-- API keys. Only the first 16 chars (public lookup prefix) are stored as `id`;
-- the full key is bcrypt-hashed in `key_hash` and never persisted in clear.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL DEFAULT 'default',
  scopes       TEXT[] NOT NULL DEFAULT ARRAY['context:read', 'context:write'],
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active
  ON api_keys(is_active, tenant_id) WHERE is_active = TRUE;
