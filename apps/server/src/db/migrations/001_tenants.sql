-- Tenants: the billing/ownership root. Every Redis key and Postgres row is
-- scoped by tenant_id for hard multi-tenant isolation.
CREATE TABLE IF NOT EXISTS tenants (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  email                   TEXT UNIQUE NOT NULL,
  github_id               TEXT UNIQUE,
  avatar_url              TEXT,
  plan                    TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id      TEXT UNIQUE,
  stripe_subscription_id  TEXT UNIQUE,

  -- Plan limits (updated by billing webhooks on upgrade/downgrade).
  max_sessions_per_day    INTEGER NOT NULL DEFAULT 100,
  max_concurrent_sessions INTEGER NOT NULL DEFAULT 3,
  max_agents_per_session  INTEGER NOT NULL DEFAULT 5,
  max_entries_per_session INTEGER NOT NULL DEFAULT 100,
  max_writes_per_hour     INTEGER NOT NULL DEFAULT 10000,
  session_ttl_seconds     INTEGER NOT NULL DEFAULT 3600,
  audit_retention_days    INTEGER NOT NULL DEFAULT 30,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active               BOOLEAN NOT NULL DEFAULT TRUE
);
