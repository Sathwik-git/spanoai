-- Append-only causal audit trail. Partitioned by tenant_id so enterprise
-- tenants can be moved to dedicated physical partitions later. Step numbers
-- are allocated transactionally from `audit_run_counters` (never in memory),
-- so replay order survives restarts and multiple API server instances.
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT    NOT NULL,
  tenant_id  TEXT    NOT NULL,
  run_id     TEXT    NOT NULL,
  step       INTEGER NOT NULL,
  parent_id  TEXT,
  clock      JSONB   NOT NULL,
  event_type TEXT    NOT NULL,
  agent_id   TEXT    NOT NULL,
  payload    JSONB   NOT NULL,
  ts         BIGINT  NOT NULL,
  PRIMARY KEY (tenant_id, id)
) PARTITION BY LIST (tenant_id);

-- Default partition: shared physical storage for free + pro tenants.
-- Enterprise tenants get a dedicated partition:
--   CREATE TABLE audit_log_<tid> PARTITION OF audit_log FOR VALUES IN ('<tid>');
CREATE TABLE IF NOT EXISTS audit_log_shared PARTITION OF audit_log DEFAULT;

CREATE INDEX IF NOT EXISTS idx_audit_run_step ON audit_log(tenant_id, run_id, step);
CREATE INDEX IF NOT EXISTS idx_audit_agent    ON audit_log(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_event    ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log(ts);

-- Durable monotonic step counter, one row per (tenant, run).
CREATE TABLE IF NOT EXISTS audit_run_counters (
  tenant_id TEXT    NOT NULL,
  run_id    TEXT    NOT NULL,
  step      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, run_id)
);

-- Retention cleanup. Schedule nightly via pg_cron once available:
--   SELECT cron.schedule('purge-audit','0 3 * * *','SELECT purge_expired_audit_logs()');
CREATE OR REPLACE FUNCTION purge_expired_audit_logs() RETURNS void AS $$
BEGIN
  DELETE FROM audit_log al
  USING tenants t
  WHERE al.tenant_id = t.id
    AND al.ts < (EXTRACT(EPOCH FROM NOW()) - (t.audit_retention_days * 86400)) * 1000;
END;
$$ LANGUAGE plpgsql;
