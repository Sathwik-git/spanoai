-- Dashboard user accounts: human login identities (email + password) that own a
-- tenant. Distinct from `api_keys` (machine credentials for the SDK/MCP) and
-- `auth_tokens` (short-lived dashboard sessions issued on login). A user signs
-- up, which provisions a tenant; the user then mints API keys from the UI.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'owner',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- Tie a dashboard session token to the user who logged in (not just the tenant),
-- so /auth/me can resolve the account. NULL for any pre-existing rows.
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
