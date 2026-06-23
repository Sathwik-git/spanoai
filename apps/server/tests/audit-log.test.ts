import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Sql } from "postgres";
import { PostgresAudit } from "../src/backends/postgres-audit";
import { AuditLog, ReplayEngine } from "../src/audit-log";
import { EventType } from "../src/models/audit-entry";
import { ensureTestDatabase, makeRedis, disconnectAll } from "./setup";

const T = "tenant-audit";

let sql: Sql;
let conn: ReturnType<typeof makeRedis>;
let audit: AuditLog;
let replay: ReplayEngine;

beforeAll(async () => {
  sql = await ensureTestDatabase();
  conn = makeRedis();
  const backend = new PostgresAudit(sql);
  audit = new AuditLog(backend, conn.redis);
  replay = new ReplayEngine(backend);
});
afterAll(async () => {
  disconnectAll(conn);
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`TRUNCATE audit_log, audit_run_counters`;
  await conn.redis.flushdb();
});

const append = (runId: string, agentId: string, eventType = EventType.CTX_WRITE) =>
  audit.append({ tenantId: T, runId, agentId, eventType, payload: { note: agentId } });

describe("AuditLog — durable step allocation", () => {
  test("steps increment per run and are independent across runs", async () => {
    const a = await append("run-1", "alice");
    const b = await append("run-1", "alice");
    expect(a.step).toBe(1);
    expect(b.step).toBe(2);

    const c = await append("run-2", "alice");
    expect(c.step).toBe(1);
  });

  test("50 concurrent appends produce a contiguous, unique step sequence", async () => {
    const run = "run-concurrent";
    const results = await Promise.all(
      Array.from({ length: 50 }, () => append(run, "alice")),
    );
    const steps = results.map((r) => r.step).sort((x, y) => x - y);
    expect(steps).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe("AuditLog — vector clock", () => {
  test("clock advances per agent across the run", async () => {
    const run = "run-clock";
    await append(run, "alice"); // {alice:1}
    await append(run, "bob"); // {alice:1, bob:1}
    const third = await append(run, "alice"); // {alice:2, bob:1}
    expect(third.clock).toEqual({ alice: 2, bob: 1 });
  });
});

describe("AuditLog — query", () => {
  test("getByRun is ordered by step; query filters by agent and event", async () => {
    const run = "run-query";
    await append(run, "alice", EventType.SESSION_START);
    await append(run, "bob", EventType.MSG_DISPATCHED);
    await append(run, "alice", EventType.CTX_WRITE);

    const all = await audit.getByRun(T, run);
    expect(all.map((e) => e.step)).toEqual([1, 2, 3]);

    const byAgent = await audit.query({ tenantId: T, runId: run, agentId: "alice" });
    expect(byAgent).toHaveLength(2);

    const byEvent = await audit.query({
      tenantId: T,
      runId: run,
      eventType: EventType.MSG_DISPATCHED,
    });
    expect(byEvent).toHaveLength(1);
  });
});

describe("ReplayEngine", () => {
  test("replay yields entries in step order", async () => {
    const run = "run-replay";
    await append(run, "alice", EventType.SESSION_START);
    await append(run, "alice", EventType.CTX_WRITE);

    const seen: number[] = [];
    for await (const e of replay.replay(T, run)) seen.push(e.step);
    expect(seen).toEqual([1, 2]);
  });

  test("diff reports the first divergent step", async () => {
    await append("run-a", "alice", EventType.SESSION_START);
    await append("run-a", "alice", EventType.CTX_WRITE);
    await append("run-b", "alice", EventType.SESSION_START);
    await append("run-b", "alice", EventType.MSG_DISPATCHED);

    const diff = await replay.diff(T, "run-a", "run-b");
    expect(diff.divergedAtStep).toBe(2);
    expect(diff.differences).toHaveLength(1);
  });
});

describe("AuditLog — compliance export", () => {
  test("export is self-describing and signed", async () => {
    const run = "run-export";
    await append(run, "alice", EventType.SESSION_START);
    await append(run, "alice", EventType.SESSION_END);

    const doc = await audit.export(T, run);
    expect(doc.entryCount).toBe(2);
    expect(doc.entries).toHaveLength(2);
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
