import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { SessionService } from "../src/sessions";
import { MessageBus, StreamScheduler } from "../src/message-bus";
import { RedisBus } from "../src/backends/redis-bus";
import { AuditLog } from "../src/audit-log";
import { ArtifactService } from "../src/artifacts";
import { BunObjectStorage } from "../src/backends/object-storage";
import { PostgresArtifactStore } from "../src/backends/postgres-artifacts";
import { EngineError } from "../src/errors";
import { EventType } from "../src/models/audit-entry";
import {
  ensureTestDatabase,
  makeRedis,
  disconnectAll,
  InMemoryAudit,
  CollectingBroadcaster,
} from "./setup";
import type { Sql } from "postgres";

const T = "tenant-sessions";

let conn: ReturnType<typeof makeRedis>;
let mem: InMemoryAudit;
let sessions: SessionService;
let bus: MessageBus;
let busBackend: RedisBus;
let sql: Sql;

beforeAll(async () => {
  sql = await ensureTestDatabase();
  conn = makeRedis();
});
afterAll(async () => {
  disconnectAll(conn);
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await conn.redis.flushdb();
  mem = new InMemoryAudit();
  const audit = new AuditLog(mem, conn.redis);
  sessions = new SessionService(conn.redis, audit);
  busBackend = new RedisBus(conn.redis, conn.redisPub);
  bus = new MessageBus(busBackend, audit, new CollectingBroadcaster());
});

describe("SessionService lifecycle", () => {
  test("create + get + join + leave + end", async () => {
    const s = await sessions.create(T, { sessionId: "run-1", createdBy: "orchestrator" });
    expect(s.status).toBe("active");
    expect(s.members).toEqual([]);

    await sessions.join(T, "run-1", "alice");
    await sessions.join(T, "run-1", "bob");
    expect((await sessions.get(T, "run-1"))!.members.sort()).toEqual(["alice", "bob"]);

    await sessions.leave(T, "run-1", "bob");
    expect((await sessions.get(T, "run-1"))!.members).toEqual(["alice"]);

    expect((await sessions.list(T)).map((x) => x.sessionId)).toEqual(["run-1"]);

    await sessions.end(T, "run-1", "orchestrator");
    expect(await sessions.get(T, "run-1")).toBeNull();
    expect(await sessions.list(T)).toHaveLength(0);

    const events = mem.entries.map((e) => e.eventType);
    expect(events).toContain(EventType.SESSION_START);
    expect(events).toContain(EventType.AGENT_JOIN);
    expect(events).toContain(EventType.AGENT_LEAVE);
    expect(events).toContain(EventType.SESSION_END);
  });

  test("join a non-existent session is rejected", async () => {
    let err: unknown;
    try {
      await sessions.join(T, "ghost", "alice");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("SESSION_NOT_FOUND");
  });

  test("abort sets a cancellation flag agents can observe", async () => {
    await sessions.create(T, { sessionId: "run-2", createdBy: "x" });
    expect(await sessions.isAborted(T, "run-2")).toBe(false);
    await sessions.abort(T, "run-2");
    expect(await sessions.isAborted(T, "run-2")).toBe(true);
    expect((await sessions.get(T, "run-2"))!.aborted).toBe(true);
  });

  test("cleanupExpired reconciles the index after a session's meta expires", async () => {
    await sessions.create(T, { sessionId: "run-3", createdBy: "x" });
    // Simulate TTL expiry by deleting the meta key directly.
    await conn.redis.del(`spanoai:t:${T}:session:run-3`);
    const cleaned = await sessions.cleanupExpired();
    expect(cleaned).toBe(1);
    expect(await sessions.list(T)).toHaveLength(0);
  });
});

describe("Background-job building blocks", () => {
  test("dispatch registers the inbox; the sweeper reclaims a stuck message", async () => {
    await bus.dispatch(T, {
      sessionId: "run-x", fromAgent: "o", toAgent: "worker",
      intent: "task", payload: { text: "do" },
    });
    const inboxes = await busBackend.listInboxes();
    expect(inboxes).toContainEqual({ tenantId: T, sessionId: "run-x", agentId: "worker" });

    await bus.claim(T, "run-x", "worker", "w1", 10); // claimed, not acked

    const scheduler = new StreamScheduler(bus, 0); // minIdle 0 for the test
    const summary = await scheduler.sweepAll(inboxes);
    expect(summary.reclaimed).toBeGreaterThanOrEqual(1);
  });

  test("artifact retention is a no-op when nothing has expired", async () => {
    await sql`TRUNCATE artifacts`;
    const audit = new AuditLog(mem, conn.redis);
    const artifacts = new ArtifactService(
      new BunObjectStorage(),
      new PostgresArtifactStore(sql),
      audit,
      new CollectingBroadcaster(),
    );
    expect(await artifacts.runRetention()).toBe(0);
  });
});
