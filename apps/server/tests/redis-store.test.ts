import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { RedisStore } from "../src/backends/redis-store";
import {
  ContextWriteRequestSchema,
  ContextDeleteRequestSchema,
  type ContextWriteRequest,
  type ContextDeleteRequest,
} from "../src/models/context-entry";
import { makeRedis, disconnectAll } from "./setup";

const T = "tenant-store";
const S = "sess-store";

let conn: ReturnType<typeof makeRedis>;
let store: RedisStore;

const wreq = (o: Record<string, unknown> = {}): ContextWriteRequest =>
  ContextWriteRequestSchema.parse({
    sessionId: S,
    namespace: "n",
    key: "k",
    value: { type: "json", data: {} },
    writtenBy: "alice",
    ...o,
  });

const dreq = (o: Record<string, unknown> = {}): ContextDeleteRequest =>
  ContextDeleteRequestSchema.parse({
    sessionId: S,
    namespace: "n",
    key: "k",
    deletedBy: "alice",
    ...o,
  });

beforeAll(() => {
  conn = makeRedis();
  store = new RedisStore(conn.redis);
});
afterAll(() => disconnectAll(conn));
beforeEach(() => conn.redis.flushdb());

describe("RedisStore — versioning", () => {
  test("write then read; version increments per write", async () => {
    const r1 = await store.write(T, wreq({ value: { type: "json", data: { v: 1 } } }), Date.now());
    expect(r1.outcome).toBe("written");
    expect(r1.version).toBe(1);

    const read = await store.get(T, S, "n.k");
    expect(read?.version).toBe(1);
    expect(read?.value).toEqual({ type: "json", data: { v: 1 } });

    const r2 = await store.write(T, wreq({ value: { type: "json", data: { v: 2 } } }), Date.now());
    expect(r2.version).toBe(2);
  });

  test("history records every resolved version in order", async () => {
    await store.write(T, wreq({ value: { type: "json", data: { v: 1 } } }), Date.now());
    await store.write(T, wreq({ value: { type: "json", data: { v: 2 } } }), Date.now());
    const hist = await store.history(T, S, "n.k");
    expect(hist.map((h) => h.version)).toEqual([1, 2]);
  });
});

describe("RedisStore — idempotency", () => {
  test("same operationId applied twice creates only one version", async () => {
    const op = crypto.randomUUID();
    const first = await store.write(T, wreq({ operationId: op, value: { type: "json", data: { v: 1 } } }), Date.now());
    const second = await store.write(T, wreq({ operationId: op, value: { type: "json", data: { v: 999 } } }), Date.now());

    expect(first.version).toBe(1);
    expect(second.version).toBe(1);
    expect(second.idempotentReplay).toBe(true);
    // The replayed write must NOT have applied the different value.
    const read = await store.get(T, S, "n.k");
    expect(read?.value).toEqual({ type: "json", data: { v: 1 } });
  });
});

describe("RedisStore — optimistic concurrency (CAS)", () => {
  test("matching expectedVersion succeeds, mismatch conflicts", async () => {
    await store.write(T, wreq(), Date.now()); // v1
    const ok = await store.write(T, wreq({ expectedVersion: 1 }), Date.now());
    expect(ok.outcome).toBe("written");
    expect(ok.version).toBe(2);

    const bad = await store.write(T, wreq({ expectedVersion: 1 }), Date.now());
    expect(bad.outcome).toBe("conflict");
    expect(bad.version).toBe(2);
  });

  test("100 concurrent writes with the same expectedVersion: exactly one wins", async () => {
    await store.write(T, wreq(), Date.now()); // v1
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        store.write(T, wreq({ expectedVersion: 1, value: { type: "json", data: { i } } }), Date.now()),
      ),
    );
    const written = results.filter((r) => r.outcome === "written");
    const conflicts = results.filter((r) => r.outcome === "conflict");
    expect(written).toHaveLength(1);
    expect(written[0]!.version).toBe(2);
    expect(conflicts).toHaveLength(99);
  });
});

describe("RedisStore — conflict strategies", () => {
  test("reject: a second write to an existing key is rejected", async () => {
    await store.write(T, wreq({ conflictStrategy: "reject" }), Date.now());
    const r = await store.write(T, wreq({ conflictStrategy: "reject" }), Date.now());
    expect(r.outcome).toBe("rejected");
    expect(r.reason).toBe("exists");
  });

  test("conf: higher confidence wins, lower-or-equal keeps existing", async () => {
    await store.write(T, wreq({ conflictStrategy: "conf", confidence: 0.5, value: { type: "json", data: { who: "first" } } }), Date.now());

    const lower = await store.write(T, wreq({ conflictStrategy: "conf", confidence: 0.3, value: { type: "json", data: { who: "low" } } }), Date.now());
    expect(lower.outcome).toBe("kept_existing");

    const higher = await store.write(T, wreq({ conflictStrategy: "conf", confidence: 0.9, value: { type: "json", data: { who: "high" } } }), Date.now());
    expect(higher.outcome).toBe("written");
    const read = await store.get(T, S, "n.k");
    expect(read?.value).toEqual({ type: "json", data: { who: "high" } });
  });

  test("merge: shallow-merges JSON objects", async () => {
    await store.write(T, wreq({ value: { type: "json", data: { a: 1, list: [1, 2] } } }), Date.now());
    await store.write(T, wreq({ conflictStrategy: "merge", value: { type: "json", data: { b: 2, list: [9] } } }), Date.now());
    const read = await store.get(T, S, "n.k");
    expect(read?.value).toEqual({ type: "json", data: { a: 1, b: 2, list: [9] } });
  });
});

describe("RedisStore — soft delete", () => {
  test("delete hides the key; history keeps the tombstone; stale write cannot resurrect", async () => {
    await store.write(T, wreq({ value: { type: "json", data: { v: 1 } } }), Date.now()); // v1
    const del = await store.delete(T, dreq(), Date.now());
    expect(del.outcome).toBe("deleted");
    expect(del.version).toBe(2);

    expect(await store.get(T, S, "n.k")).toBeNull();
    expect((await store.get(T, S, "n.k", { includeDeleted: true }))?.isDeleted).toBe(true);

    // A plain (stale) write cannot bring it back.
    const resurrect = await store.write(T, wreq({ value: { type: "json", data: { v: 3 } } }), Date.now());
    expect(resurrect.outcome).toBe("rejected");
    expect(resurrect.reason).toBe("deleted");
    expect(await store.get(T, S, "n.k")).toBeNull();
  });

  test("allowRestore with matching expectedVersion restores a deleted key", async () => {
    await store.write(T, wreq(), Date.now()); // v1
    const del = await store.delete(T, dreq(), Date.now()); // v2
    const restored = await store.write(
      T,
      wreq({ allowRestore: true, expectedVersion: del.version!, value: { type: "json", data: { back: true } } }),
      Date.now(),
    );
    expect(restored.outcome).toBe("written");
    expect((await store.get(T, S, "n.k"))?.value).toEqual({ type: "json", data: { back: true } });
  });
});

describe("RedisStore — listing & staleness", () => {
  test("list filters by namespace", async () => {
    await store.write(T, wreq({ namespace: "alpha", key: "one" }), Date.now());
    await store.write(T, wreq({ namespace: "alpha", key: "two" }), Date.now());
    await store.write(T, wreq({ namespace: "beta", key: "three" }), Date.now());

    expect(await store.list(T, S)).toHaveLength(3);
    const alpha = await store.list(T, S, "alpha");
    expect(alpha.map((e) => e.fullKey).sort()).toEqual(["alpha.one", "alpha.two"]);
  });

  test("a TTL'd entry past its age reads as null", async () => {
    const past = Date.now() - 10_000;
    await store.write(T, wreq({ ttlSeconds: 1 }), past);
    expect(await store.get(T, S, "n.k")).toBeNull();
  });
});
