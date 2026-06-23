import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { RedisStore } from "../src/backends/redis-store";
import { RedisBus } from "../src/backends/redis-bus";
import { ContextStore } from "../src/context-store";
import { MessageBus } from "../src/message-bus";
import { AuditLog } from "../src/audit-log";
import { EngineError } from "../src/errors";
import { EventType } from "../src/models/audit-entry";
import {
  makeRedis,
  disconnectAll,
  InMemoryAudit,
  CollectingBroadcaster,
} from "./setup";

const T = "tenant-facade";
const S = "sess-facade";

let conn: ReturnType<typeof makeRedis>;
let mem: InMemoryAudit;
let bc: CollectingBroadcaster;
let store: ContextStore;
let bus: MessageBus;

beforeAll(() => {
  conn = makeRedis();
});
afterAll(() => disconnectAll(conn));
beforeEach(async () => {
  await conn.redis.flushdb();
  mem = new InMemoryAudit();
  bc = new CollectingBroadcaster();
  const audit = new AuditLog(mem, conn.redis);
  store = new ContextStore(new RedisStore(conn.redis), audit, bc);
  bus = new MessageBus(new RedisBus(conn.redis, conn.redisPub), audit, bc);
});

describe("ContextStore facade", () => {
  test("write records an audit entry and a broadcast, and is readable", async () => {
    const res = await store.write(T, {
      sessionId: S,
      namespace: "researcher",
      key: "findings",
      value: { type: "json", data: { revenue: "$4.2M" } },
      writtenBy: "researcher",
    });
    expect(res.outcome).toBe("written");

    expect(mem.entries).toHaveLength(1);
    expect(mem.entries[0]!.eventType).toBe(EventType.CTX_WRITE);
    expect(bc.events).toHaveLength(1);
    expect(bc.events[0]!.event.event).toBe(EventType.CTX_WRITE);

    const read = await store.read(T, S, "researcher.findings");
    expect(read?.value).toEqual({ type: "json", data: { revenue: "$4.2M" } });
  });

  test("an oversized inline value is rejected as PAYLOAD_TOO_LARGE", async () => {
    let caught: unknown;
    try {
      await store.write(T, {
        sessionId: S,
        namespace: "n",
        key: "blob",
        value: { type: "text", text: "x".repeat(300 * 1024) }, // ~300 KB
        writtenBy: "a",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("an artifact-reference value (small) is accepted", async () => {
    const res = await store.write(T, {
      sessionId: S,
      namespace: "researcher",
      key: "report",
      value: {
        type: "artifact",
        artifact: {
          id: crypto.randomUUID(),
          kind: "report",
          uri: "spanoai://artifact/abc",
          mimeType: "application/pdf",
          sizeBytes: 4_200_000,
          sha256: "a".repeat(64),
          name: "report.pdf",
        },
      },
      writtenBy: "researcher",
    });
    expect(res.outcome).toBe("written");
  });

  test("an idempotent replay does not append a second audit entry", async () => {
    const op = crypto.randomUUID();
    const base = {
      sessionId: S,
      namespace: "n",
      key: "k",
      value: { type: "json", data: { v: 1 } } as const,
      writtenBy: "a",
      operationId: op,
    };
    await store.write(T, base);
    await store.write(T, base);
    expect(mem.entries).toHaveLength(1);
  });

  test("a rejected conflict is audited as CTX_CONFLICT", async () => {
    const req = {
      sessionId: S,
      namespace: "n",
      key: "k",
      value: { type: "json", data: {} } as const,
      writtenBy: "a",
      conflictStrategy: "reject" as const,
    };
    await store.write(T, req);
    const r = await store.write(T, req);
    expect(r.outcome).toBe("rejected");
    expect(mem.entries.map((e) => e.eventType)).toEqual([
      EventType.CTX_WRITE,
      EventType.CTX_CONFLICT,
    ]);
  });
});

describe("MessageBus facade", () => {
  test("dispatch + claim are audited", async () => {
    const m = await bus.dispatch(T, {
      sessionId: S,
      fromAgent: "alice",
      toAgent: "bob",
      intent: "do_work",
      payload: { text: "hi" },
    });

    const claimed = await bus.claim(T, S, "bob", "worker-1", 10);
    expect(claimed[0]!.id).toBe(m.id);

    const events = mem.entries.map((e) => e.eventType);
    expect(events).toContain(EventType.MSG_DISPATCHED);
    expect(events).toContain(EventType.MSG_DELIVERED);
  });

  test("reply delivers to the original sender and acks the original", async () => {
    const original = await bus.dispatch(T, {
      sessionId: S,
      fromAgent: "alice",
      toAgent: "bob",
      intent: "question",
      payload: { text: "what is revenue?" },
    });

    const reply = await bus.reply(T, S, original.id, {
      fromAgent: "bob",
      payload: { text: "$4.2M" },
    });
    expect(reply.toAgent).toBe("alice");
    expect(reply.replyTo).toBe(original.id);

    const aliceInbox = await bus.claim(T, S, "alice", "worker-a", 10);
    expect(aliceInbox.map((m) => m.id)).toContain(reply.id);
    expect(mem.entries.map((e) => e.eventType)).toContain(EventType.MSG_REPLIED);
  });

  test("reply to an unknown message is rejected", async () => {
    await expect(
      bus.reply(T, S, "does-not-exist", { fromAgent: "bob", payload: { text: "x" } }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  test("dispatch rejects an oversized payload as PAYLOAD_TOO_LARGE", async () => {
    let caught: unknown;
    try {
      await bus.dispatch(T, {
        sessionId: S,
        fromAgent: "alice",
        toAgent: "bob",
        intent: "deliver",
        payload: { text: "x".repeat(300 * 1024) }, // ~300 KB > 256 KB cap
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("reply to an expired message is rejected", async () => {
    const original = await bus.dispatch(T, {
      sessionId: S,
      fromAgent: "alice",
      toAgent: "bob",
      intent: "question",
      payload: { text: "hi" },
      createdAt: Date.now() - 100_000,
      timeoutMs: 1,
    });

    let caught: unknown;
    try {
      await bus.reply(T, S, original.id, {
        fromAgent: "bob",
        payload: { text: "late" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("MESSAGE_EXPIRED");
  });
});
