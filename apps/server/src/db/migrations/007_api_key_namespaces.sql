-- Per-key namespace allowlist for agent-level ACLs. NULL = all namespaces.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS namespaces TEXT[];
