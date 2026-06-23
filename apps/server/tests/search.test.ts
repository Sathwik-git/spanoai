import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Sql } from "postgres";
import { RedisStore } from "../src/backends/redis-store";
import { ContextStore } from "../src/context-store";
import { AuditLog } from "../src/audit-log";
import { PgVectorSearch } from "../src/backends/pgvector-search";
import { HashEmbedder } from "../src/search/embedder";
import {
  ensureTestDatabase,
  makeRedis,
  disconnectAll,
  InMemoryAudit,
  CollectingBroadcaster,
} from "./setup";

const T = "tenant-search";
const S = "run-search";

let sql: Sql;
let conn: ReturnType<typeof makeRedis>;
let store: ContextStore;

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
  await sql`DELETE FROM context_embeddings WHERE tenant_id = ${T}`;
  const audit = new AuditLog(new InMemoryAudit(), conn.redis);
  store = new ContextStore(
    new RedisStore(conn.redis), audit, new CollectingBroadcaster(),
    new HashEmbedder(), new PgVectorSearch(sql),
  );
});

describe("Semantic search (pgvector)", () => {
  test("returns the most relevant entry for a query", async () => {
    await store.write(T, { sessionId: S, namespace: "n", key: "finance", value: { type: "text", text: "quarterly revenue and profit growth" }, writtenBy: "a" });
    await store.write(T, { sessionId: S, namespace: "n", key: "legal", value: { type: "text", text: "merger contract liability and indemnification" }, writtenBy: "a" });
    await store.write(T, { sessionId: S, namespace: "n", key: "tech", value: { type: "text", text: "database sharding and replication latency" }, writtenBy: "a" });

    // Embedding writes are fire-and-forget; wait until all three are indexed.
    let indexed = 0;
    for (let i = 0; i < 60; i++) {
      const [row] = await sql`SELECT COUNT(*)::int AS count FROM context_embeddings WHERE tenant_id = ${T}`;
      indexed = Number(row!.count);
      if (indexed === 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(indexed).toBe(3);

    const results = await store.search(T, S, "revenue and profit", 2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.fullKey).toBe("n.finance");
  });

  test("search returns [] when no embedder is configured", async () => {
    const audit = new AuditLog(new InMemoryAudit(), conn.redis);
    const plain = new ContextStore(new RedisStore(conn.redis), audit, new CollectingBroadcaster());
    await plain.write(T, { sessionId: S, namespace: "n", key: "k", value: { type: "text", text: "hello" }, writtenBy: "a" });
    expect(await plain.search(T, S, "hello", 5)).toEqual([]);
  });
});
