/**
 * Test harness helpers.
 *
 * Integration tests run against the Docker Redis + Postgres. To stay isolated
 * from dev data they use Redis DB index 1 and a dedicated `spanoai_test`
 * database (created on demand). Connections are built fresh per test file and
 * torn down in afterAll.
 */
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { createConnections } from "../src/redis";
import { createSql } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { config } from "../src/config";
import type {
  AuditBackend,
  AuditQueryParams,
  BroadcastEvent,
  EventBroadcaster,
} from "../src/backends/interfaces";
import type { AuditEntry } from "../src/models/audit-entry";

export const TEST_REDIS_URL = `${config.REDIS_URL}/1`;
export const TEST_DATABASE_URL = config.DATABASE_URL.replace(
  /\/[^/]+$/,
  "/spanoai_test",
);

export function makeRedis(): {
  redis: Redis;
  redisPub: Redis;
  redisSub: Redis;
} {
  return createConnections(TEST_REDIS_URL);
}

export function makeSql(): Sql {
  return createSql(TEST_DATABASE_URL);
}

/** Create the test database if missing, then apply migrations to it. */
export async function ensureTestDatabase(): Promise<Sql> {
  const admin = createSql(config.DATABASE_URL);
  try {
    await admin.unsafe("CREATE DATABASE spanoai_test").simple();
  } catch (err) {
    if (!String((err as Error).message).toLowerCase().includes("already exists")) {
      throw err;
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const sql = makeSql();
  await runMigrations(sql);
  return sql;
}

export async function disconnectAll(conn: {
  redis: Redis;
  redisPub: Redis;
  redisSub: Redis;
}): Promise<void> {
  conn.redis.disconnect();
  conn.redisPub.disconnect();
  conn.redisSub.disconnect();
}

/** In-memory AuditBackend for facade tests that don't need Postgres. */
export class InMemoryAudit implements AuditBackend {
  readonly entries: AuditEntry[] = [];
  private readonly counters = new Map<string, number>();

  async append(entry: Omit<AuditEntry, "step">): Promise<AuditEntry> {
    const k = `${entry.tenantId}:${entry.runId}`;
    const step = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, step);
    const full: AuditEntry = { ...entry, step };
    this.entries.push(full);
    return full;
  }

  async getByRun(tenantId: string, runId: string): Promise<AuditEntry[]> {
    return this.entries
      .filter((e) => e.tenantId === tenantId && e.runId === runId)
      .sort((a, b) => a.step - b.step);
  }

  async query(p: AuditQueryParams): Promise<AuditEntry[]> {
    return this.entries.filter(
      (e) =>
        e.tenantId === p.tenantId &&
        (!p.runId || e.runId === p.runId) &&
        (!p.agentId || e.agentId === p.agentId) &&
        (!p.eventType || e.eventType === p.eventType),
    );
  }
}

/** Broadcaster that records every event for assertions. */
export class CollectingBroadcaster implements EventBroadcaster {
  readonly events: Array<{
    tenantId: string;
    sessionId: string;
    event: BroadcastEvent;
  }> = [];

  broadcast(tenantId: string, sessionId: string, event: BroadcastEvent): void {
    this.events.push({ tenantId, sessionId, event });
  }
}

/** Wait until `predicate` is true or `timeoutMs` elapses (for async fan-out). */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}
