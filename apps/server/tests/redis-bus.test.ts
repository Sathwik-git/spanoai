import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { RedisBus } from "../src/backends/redis-bus";
import { AgentMessageSchema, type AgentMessage } from "../src/models/agent-message";
import { makeRedis, disconnectAll } from "./setup";

const T = "tenant-bus";
const S = "sess-bus";

let conn: ReturnType<typeof makeRedis>;
let bus: RedisBus;

const msg = (o: Record<string, unknown> = {}): AgentMessage =>
  AgentMessageSchema.parse({
    tenantId: T,
    sessionId: S,
    fromAgent: "alice",
    toAgent: "bob",
    intent: "do_work",
    payload: { text: "hello" },
    ...o,
  });

beforeAll(() => {
  conn = makeRedis();
  bus = new RedisBus(conn.redis, conn.redisPub);
});
afterAll(() => disconnectAll(conn));
beforeEach(() => conn.redis.flushdb());

describe("RedisBus — enqueue / claim / ack", () => {
  test("a message can be enqueued, claimed once, and acked", async () => {
    const m = msg();
    await bus.enqueue(m);

    const claimed = await bus.claim(T, S, "bob", "worker-1", 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe(m.id);
    expect(claimed[0]!.payload.text).toBe("hello");

    // Already claimed -> not redelivered to a fresh claim of new (">") messages.
    expect(await bus.claim(T, S, "bob", "worker-1", 10)).toHaveLength(0);

    expect(await bus.ack(T, S, m.id)).toBe(true);
  });

  test("getMeta returns bookkeeping for a known message", async () => {
    const m = msg();
    await bus.enqueue(m);
    const meta = await bus.getMeta(T, S, m.id);
    expect(meta?.message.id).toBe(m.id);
    expect(meta?.priority).toBe(m.priority);
  });
});

describe("RedisBus — priority", () => {
  test("higher-priority messages are claimed first", async () => {
    const low = msg({ priority: 1, intent: "low" });
    const high = msg({ priority: 5, intent: "high" });
    await bus.enqueue(low);
    await bus.enqueue(high);

    const claimed = await bus.claim(T, S, "bob", "worker-1", 10);
    expect(claimed.map((m) => m.intent)).toEqual(["high", "low"]);
  });
});

describe("RedisBus — reclaim, retry, DLQ", () => {
  test("a stuck message is reclaimed and retried until maxRetries, then dead-lettered", async () => {
    const m = msg({ maxRetries: 1 });
    await bus.enqueue(m);
    await bus.claim(T, S, "bob", "worker-1", 10); // now pending (unacked)

    // First sweep: retryCount 0 -> 1, still within maxRetries -> re-enqueued.
    const r1 = await bus.reclaimStuck(T, S, "bob", 0);
    expect(r1.reclaimed).toBe(1);
    expect(r1.retried).toHaveLength(1);
    expect(r1.deadLettered).toHaveLength(0);

    // Re-claim the retried copy, leave it unacked, sweep again.
    const reclaimed = await bus.claim(T, S, "bob", "worker-1", 10);
    expect(reclaimed[0]!.retryCount).toBe(1);

    const r2 = await bus.reclaimStuck(T, S, "bob", 0);
    expect(r2.deadLettered).toHaveLength(1);

    const dlq = await bus.listDlq(T, S, 10);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.reason).toBe("max_retries_exceeded");
    expect(dlq[0]!.message.id).toBe(m.id);

    expect(await bus.removeFromDlq(T, S, dlq[0]!.streamId)).toBe(true);
    expect(await bus.listDlq(T, S, 10)).toHaveLength(0);
  });
});
