/**
 * Regression tests for value-encoding fidelity. The Redis store must NEVER
 * mangle a stored value: empty arrays must stay arrays (not become {}),
 * large numbers must keep full precision, and tags/unicode must round-trip
 * byte-for-byte. (Root cause once fixed: Lua cjson re-encoding the value.)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { RedisStore } from "../src/backends/redis-store";
import { ContextWriteRequestSchema, type ContextWriteRequest } from "../src/models/context-entry";
import { makeRedis, disconnectAll } from "./setup";

const T = "tenant-fidelity";
const S = "sess-fidelity";

let conn: ReturnType<typeof makeRedis>;
let store: RedisStore;

const wreq = (o: Record<string, unknown>): ContextWriteRequest =>
  ContextWriteRequestSchema.parse({ sessionId: S, namespace: "n", writtenBy: "x", ...o });

beforeAll(() => {
  conn = makeRedis();
  store = new RedisStore(conn.redis);
});
afterAll(() => disconnectAll(conn));
beforeEach(() => conn.redis.flushdb());

describe("value fidelity", () => {
  test("empty array stays an array", async () => {
    await store.write(T, wreq({ key: "a", value: { type: "json", data: [] } }), Date.now());
    const e = await store.get(T, S, "n.a");
    expect(Array.isArray((e!.value as { data: unknown }).data)).toBe(true);
  });

  test("nested empty array/object keep their JSON types", async () => {
    await store.write(T, wreq({ key: "b", value: { type: "json", data: { items: [], meta: {}, n: "x" } } }), Date.now());
    const e = await store.get(T, S, "n.b");
    const d = (e!.value as { data: { items: unknown; meta: unknown } }).data;
    expect(Array.isArray(d.items)).toBe(true);
    expect(Array.isArray(d.meta)).toBe(false);
  });

  test("large integers keep full precision", async () => {
    const big = 9007199254740991; // 2^53 - 1
    await store.write(T, wreq({ key: "c", value: { type: "json", data: { big } } }), Date.now());
    const e = await store.get(T, S, "n.c");
    expect((e!.value as { data: { big: number } }).data.big).toBe(big);
  });

  test("empty tags array stays an array", async () => {
    await store.write(T, wreq({ key: "d", value: { type: "text", text: "x" }, tags: [] }), Date.now());
    const e = await store.get(T, S, "n.d");
    expect(Array.isArray(e!.tags)).toBe(true);
    expect(e!.tags).toEqual([]);
  });

  test("unicode + quotes + control chars round-trip exactly", async () => {
    const text = 'emoji 🚀 "q" \n \\ 日本語 \t';
    await store.write(T, wreq({ key: "e", value: { type: "text", text } }), Date.now());
    const e = await store.get(T, S, "n.e");
    expect((e!.value as { text: string }).text).toBe(text);
  });

  test("fidelity holds across a version bump (read latest)", async () => {
    await store.write(T, wreq({ key: "f", value: { type: "json", data: { list: [1] } } }), Date.now());
    await store.write(T, wreq({ key: "f", value: { type: "json", data: { list: [] } } }), Date.now());
    const e = await store.get(T, S, "n.f");
    expect((e!.value as { data: { list: unknown } }).data.list).toEqual([]);
    expect(e!.version).toBe(2);
  });
});
