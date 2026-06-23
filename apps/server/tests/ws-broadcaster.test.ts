import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { WSBroadcaster, type SeqEvent } from "../src/ws-broadcaster";
import { makeRedis, disconnectAll, waitFor } from "./setup";

const T = "tenant-ws";
const S = "sess-ws";

let conn: ReturnType<typeof makeRedis>;
let ws: WSBroadcaster;

beforeAll(() => {
  conn = makeRedis();
  ws = new WSBroadcaster(conn.redis, conn.redisPub, conn.redisSub);
});
afterAll(() => disconnectAll(conn));
beforeEach(() => conn.redis.flushdb());

describe("WSBroadcaster — sequencing & buffer", () => {
  test("assigns a monotonic seq to each event", async () => {
    const a = await ws.broadcast(T, S, { event: "CTX_WRITE" });
    const b = await ws.broadcast(T, S, { event: "CTX_WRITE" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  test("getMissed returns only events after lastSeq", async () => {
    await ws.broadcast(T, S, { event: "e1" });
    await ws.broadcast(T, S, { event: "e2" });
    await ws.broadcast(T, S, { event: "e3" });

    const missed = await ws.getMissed(T, S, 1);
    expect(missed.reload).toBe(false);
    expect(missed.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  test("signals reload when the gap exceeds the buffer", async () => {
    await ws.broadcast(T, S, { event: "e1" });
    await ws.broadcast(T, S, { event: "e2" });
    await ws.broadcast(T, S, { event: "e3" });
    // Simulate buffer eviction: keep only the newest event (seq 3).
    await conn.redis.ltrim(`spanoai:t:${T}:ws:${S}:buf`, -1, -1);

    const missed = await ws.getMissed(T, S, 1);
    expect(missed.reload).toBe(true);
  });
});

describe("WSBroadcaster — cross-server fan-out", () => {
  test("a subscriber receives broadcast events", async () => {
    const received: SeqEvent[] = [];
    const unsubscribe = await ws.subscribe(T, S, (e) => received.push(e));

    await ws.broadcast(T, S, { event: "CTX_WRITE", fullKey: "n.k" });

    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe("CTX_WRITE");
    expect(received[0]!.seq).toBe(1);

    await unsubscribe();
  });
});
