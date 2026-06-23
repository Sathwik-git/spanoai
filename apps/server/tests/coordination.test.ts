import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { RedisStore } from "../src/backends/redis-store";
import { RedisBus } from "../src/backends/redis-bus";
import { ContextStore } from "../src/context-store";
import { MessageBus } from "../src/message-bus";
import { AuditLog } from "../src/audit-log";
import { WSBroadcaster } from "../src/ws-broadcaster";
import {
  makeRedis,
  disconnectAll,
  InMemoryAudit,
  CollectingBroadcaster,
} from "./setup";

const T = "tenant-coord";
const S = "sess-coord";

let conn: ReturnType<typeof makeRedis>;
let store: ContextStore;
let storeWithWs: ContextStore;
let bus: MessageBus;
let ws: WSBroadcaster;

beforeAll(() => {
  conn = makeRedis();
  // One WSBroadcaster per process (it attaches a persistent sub listener).
  ws = new WSBroadcaster(conn.redis, conn.redisPub, conn.redisSub);
});
afterAll(() => disconnectAll(conn));
beforeEach(async () => {
  await conn.redis.flushdb();
  const audit = new AuditLog(new InMemoryAudit(), conn.redis);
  const backend = new RedisStore(conn.redis);
  store = new ContextStore(backend, audit, new CollectingBroadcaster());
  storeWithWs = new ContextStore(backend, audit, ws);
  bus = new MessageBus(new RedisBus(conn.redis, conn.redisPub), audit, new CollectingBroadcaster());
});

describe("Atomic append (accumulate)", () => {
  test("100 concurrent appends to one list lose nothing", async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        store.append(T, {
          sessionId: S, namespace: "shared", key: "findings",
          items: [`item-${i}`], writtenBy: `agent-${i}`,
        }),
      ),
    );
    const entry = await store.read(T, S, "shared.findings");
    const items = (entry!.value as { type: "json"; data: string[] }).data;
    expect(items).toHaveLength(100);
    expect(new Set(items).size).toBe(100); // all distinct, none lost
  });

  test("append is idempotent by operationId", async () => {
    const op = crypto.randomUUID();
    await store.append(T, { sessionId: S, namespace: "n", key: "log", items: ["a"], writtenBy: "x", operationId: op });
    const replay = await store.append(T, { sessionId: S, namespace: "n", key: "log", items: ["a"], writtenBy: "x", operationId: op });
    expect(replay.idempotentReplay).toBe(true);
    const items = ((await store.read(T, S, "n.log"))!.value as { data: string[] }).data;
    expect(items).toEqual(["a"]);
  });

  test("maxItems keeps only the most recent N", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(T, { sessionId: S, namespace: "n", key: "ring", items: [i], writtenBy: "x", maxItems: 3 });
    }
    const items = ((await store.read(T, S, "n.ring"))!.value as { data: number[] }).data;
    expect(items).toEqual([2, 3, 4]);
  });

  test("append to a non-list value is rejected (type_mismatch)", async () => {
    await store.write(T, { sessionId: S, namespace: "n", key: "obj", value: { type: "json", data: { a: 1 } }, writtenBy: "x" });
    const r = await store.append(T, { sessionId: S, namespace: "n", key: "obj", items: ["x"], writtenBy: "y" });
    expect(r.outcome).toBe("rejected");
    expect(r.reason).toBe("type_mismatch");
  });
});

describe("Atomic increment (counter)", () => {
  test("100 concurrent increments sum exactly", async () => {
    await Promise.all(
      Array.from({ length: 100 }, () =>
        store.increment(T, { sessionId: S, namespace: "stats", key: "done", by: 1, writtenBy: "w" }),
      ),
    );
    const n = ((await store.read(T, S, "stats.done"))!.value as { data: number }).data;
    expect(n).toBe(100);
  });

  test("increment is idempotent by operationId", async () => {
    const op = crypto.randomUUID();
    await store.increment(T, { sessionId: S, namespace: "n", key: "c", by: 5, writtenBy: "w", operationId: op });
    await store.increment(T, { sessionId: S, namespace: "n", key: "c", by: 5, writtenBy: "w", operationId: op });
    const n = ((await store.read(T, S, "n.c"))!.value as { data: number }).data;
    expect(n).toBe(5);
  });
});

describe("awaitKey (watch / barrier)", () => {
  test("resolves when a producer writes the key after the waiter starts", async () => {
    const waiter = storeWithWs.awaitKey(T, S, "coder.result", { timeoutMs: 5000 });
    // Write shortly after the waiter has subscribed + done its first read.
    setTimeout(() => {
      void storeWithWs.write(T, { sessionId: S, namespace: "coder", key: "result", value: { type: "json", data: { ok: true } }, writtenBy: "coder" });
    }, 100);
    const entry = await waiter;
    expect(entry).not.toBeNull();
    expect((entry!.value as { data: { ok: boolean } }).data.ok).toBe(true);
  });

  test("returns immediately if the key already satisfies the predicate", async () => {
    await store.write(T, { sessionId: S, namespace: "n", key: "k", value: { type: "json", data: { v: 1 } }, writtenBy: "x" });
    const entry = await storeWithWs.awaitKey(T, S, "n.k", { timeoutMs: 2000 });
    expect(entry).not.toBeNull();
  });

  test("times out to null when the key never appears", async () => {
    const entry = await storeWithWs.awaitKey(T, S, "never.appears", { timeoutMs: 300, pollMs: 50 });
    expect(entry).toBeNull();
  });

  test("barrier: waits until a list reaches N items", async () => {
    const barrier = storeWithWs.awaitKey(T, S, "shared.findings", {
      timeoutMs: 5000,
      predicate: (e) => !!e && (e.value as { data: unknown[] }).data.length >= 3,
    });
    for (let i = 0; i < 3; i++) {
      await store.append(T, { sessionId: S, namespace: "shared", key: "findings", items: [i], writtenBy: `a${i}` });
    }
    const entry = await barrier;
    expect((entry!.value as { data: unknown[] }).data).toHaveLength(3);
  });
});

describe("request / awaitReply", () => {
  test("request blocks until the responder replies", async () => {
    const pending = bus.request(T, {
      sessionId: S, fromAgent: "writer", toAgent: "researcher",
      intent: "need_revenue", payload: { text: "revenue?" },
    }, { timeoutMs: 5000, pollMs: 50 });

    // Responder claims and replies shortly after.
    setTimeout(async () => {
      const inbox = await bus.claim(T, S, "researcher", "r1", 10);
      await bus.reply(T, S, inbox[0]!.id, { fromAgent: "researcher", payload: { text: "$4.2M" } });
    }, 100);

    const { reply } = await pending;
    expect(reply).not.toBeNull();
    expect(reply!.payload.text).toBe("$4.2M");
    expect(reply!.replyTo).toBeDefined();
  });

  test("awaitReply times out to null when no reply arrives", async () => {
    const msg = await bus.dispatch(T, {
      sessionId: S, fromAgent: "a", toAgent: "b", intent: "x", payload: { text: "hi" },
    });
    const reply = await bus.awaitReply(T, S, msg.id, { timeoutMs: 250, pollMs: 50 });
    expect(reply).toBeNull();
  });
});
