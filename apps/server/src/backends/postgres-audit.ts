/**
 * Postgres-backed Audit Log.
 *
 * `step` is allocated transactionally from `audit_run_counters` and the row is
 * inserted in the SAME transaction, so the durable per-run sequence stays
 * strictly increasing even across multiple API server instances and restarts —
 * never an in-memory counter.
 *
 * JSONB columns are written as text cast with `::jsonb` (postgres.js does not
 * auto-serialise a bare interpolated object).
 */
import type { Sql } from "postgres";
import { sql as defaultSql } from "../db/client";
import type { AuditBackend, AuditQueryParams } from "./interfaces";
import {
  type AuditEntry,
  type Clock,
  type EventType,
} from "../models/audit-entry";

type AuditRow = Record<string, unknown>;

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    runId: row.run_id as string,
    step: Number(row.step),
    ...(row.parent_id != null ? { parentId: row.parent_id as string } : {}),
    clock: row.clock as Clock,
    eventType: row.event_type as EventType,
    agentId: row.agent_id as string,
    payload: row.payload as Record<string, unknown>,
    ts: Number(row.ts),
  };
}

export class PostgresAudit implements AuditBackend {
  constructor(private readonly db: Sql = defaultSql) {}

  async append(entry: Omit<AuditEntry, "step">): Promise<AuditEntry> {
    const step = await this.db.begin(async (tx) => {
      const [counter] = await tx<{ step: number }[]>`
        INSERT INTO audit_run_counters (tenant_id, run_id, step)
        VALUES (${entry.tenantId}, ${entry.runId}, 1)
        ON CONFLICT (tenant_id, run_id)
        DO UPDATE SET step = audit_run_counters.step + 1
        RETURNING step
      `;
      const allocated = Number(counter!.step);

      await tx`
        INSERT INTO audit_log
          (id, tenant_id, run_id, step, parent_id, clock, event_type, agent_id, payload, ts)
        VALUES (
          ${entry.id}, ${entry.tenantId}, ${entry.runId}, ${allocated},
          ${entry.parentId ?? null},
          ${JSON.stringify(entry.clock)}::jsonb,
          ${entry.eventType}, ${entry.agentId},
          ${JSON.stringify(entry.payload)}::jsonb,
          ${entry.ts}
        )
      `;
      return allocated;
    });

    return { ...entry, step };
  }

  async getByRun(tenantId: string, runId: string): Promise<AuditEntry[]> {
    const rows = await this.db`
      SELECT * FROM audit_log
      WHERE tenant_id = ${tenantId} AND run_id = ${runId}
      ORDER BY step ASC
    `;
    return rows.map((r) => rowToEntry(r as AuditRow));
  }

  async query(p: AuditQueryParams): Promise<AuditEntry[]> {
    const db = this.db;
    let where = db`tenant_id = ${p.tenantId}`;
    if (p.runId) where = db`${where} AND run_id = ${p.runId}`;
    if (p.agentId) where = db`${where} AND agent_id = ${p.agentId}`;
    if (p.eventType) where = db`${where} AND event_type = ${p.eventType}`;
    if (p.fromStep !== undefined) where = db`${where} AND step >= ${p.fromStep}`;
    if (p.toStep !== undefined) where = db`${where} AND step <= ${p.toStep}`;
    if (p.fromTs !== undefined) where = db`${where} AND ts >= ${p.fromTs}`;
    if (p.toTs !== undefined) where = db`${where} AND ts <= ${p.toTs}`;

    const limit = p.limit ?? 1000;
    const rows = await db`
      SELECT * FROM audit_log
      WHERE ${where}
      ORDER BY step ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => rowToEntry(r as AuditRow));
  }
}
