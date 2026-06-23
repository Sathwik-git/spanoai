import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { RedisStore } from "../src/backends/redis-store";
import { RedisBus } from "../src/backends/redis-bus";
import { ContextStore } from "../src/context-store";
import { MessageBus } from "../src/message-bus";
import { SessionService } from "../src/sessions";
import { AuditLog } from "../src/audit-log";
import { makeRedis, disconnectAll, InMemoryAudit, CollectingBroadcaster } from "./setup";

const T = "tenant-bt";
const S = "sess-bt";

let conn: ReturnType<typeof makeRedis>;
let store: ContextStore;
let bus: MessageBus;
let sessions: SessionService;

beforeAll(() => { conn = makeRedis(); });
afterAll(() => disconnectAll(conn));
beforeEach(async () => {
  await conn.redis.flushdb();
  const audit = new AuditLog(new InMemoryAudit(), conn.redis);
  sessions = new SessionService(conn.redis, audit);
  store = new ContextStore(new RedisStore(conn.redis), audit, new CollectingBroadcaster(), undefined, undefined, 0, sessions);
  bus = new MessageBus(new RedisBus(conn.redis, conn.redisPub), audit, new CollectingBroadcaster(), sessions);
});

describe("Multi-recipient broadcast", () => {
  test("fans out one durable message per agent, sharing a traceId", async () => {
    const msgs = await bus.broadcast(T, {
      sessionId: S, fromAgent: "orchestrator", intent: "do_task",
      payload: { text: "go" }, toAgents: ["worker-a", "worker-b", "worker-c"],
    });
    expect(msgs).toHaveLength(3);
    expect(new Set(msgs.map((m) => m.traceId)).size).toBe(1); // correlated
    expect(new Set(msgs.map((m) => m.id)).size).toBe(3); // distinct messages

    for (const agent of ["worker-a", "worker-b", "worker-c"]) {
      const inbox = await bus.claim(T, S, agent, "c1", 10);
      expect(inbox.map((m) => m.intent)).toContain("do_task");
    }
  });

  test("deduplicates repeated recipients and rejects empty list", async () => {
    const msgs = await bus.broadcast(T, {
      sessionId: S, fromAgent: "o", intent: "x", payload: { text: "y" },
      toAgents: ["a", "a", "b"],
    });
    expect(msgs).toHaveLength(2);

    let err: unknown;
    try {
      await bus.broadcast(T, { sessionId: S, fromAgent: "o", intent: "x", payload: {}, toAgents: [] });
    } catch (e) { err = e; }
    expect((err as { code: string }).code).toBe("MISSING_PARAM");
  });
});

describe("Session auto-registration on activity", () => {
  test("a context write auto-registers the run in /sessions", async () => {
    expect(await sessions.get(T, "auto-run")).toBeNull();
    await store.write(T, { sessionId: "auto-run", namespace: "n", key: "k", value: { type: "text", text: "x" }, writtenBy: "agent-1" });
    const s = await sessions.get(T, "auto-run");
    expect(s).not.toBeNull();
    expect(s!.status).toBe("active");
    expect((await sessions.list(T)).some((x) => x.sessionId === "auto-run")).toBe(true);
  });

  test("a message dispatch auto-registers the run", async () => {
    await bus.dispatch(T, { sessionId: "auto-msg", fromAgent: "a", toAgent: "b", intent: "i", payload: { text: "x" } });
    expect((await sessions.list(T)).some((x) => x.sessionId === "auto-msg")).toBe(true);
  });

  test("explicit createSession is not clobbered by a later touch", async () => {
    const created = await sessions.create(T, { sessionId: "explicit", createdBy: "owner", metadata: { kind: "test" } });
    expect(created.metadata).toEqual({ kind: "test" });
    await store.write(T, { sessionId: "explicit", namespace: "n", key: "k", value: { type: "text", text: "x" }, writtenBy: "agent-9" });
    const s = await sessions.get(T, "explicit");
    expect(s!.createdBy).toBe("owner"); // touch refreshed TTL, did not overwrite
    expect(s!.metadata).toEqual({ kind: "test" });
  });
});
