/**
 * End-to-end: the published SDK driving the real server over HTTP + WebSocket.
 * Boots the Hono app on an ephemeral port with a test engine (HashEmbedder so
 * semantic search is live), then exercises every SDK surface.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Sql } from "postgres";
import type { Server } from "bun";
import { createEngine } from "../src/engine";
import { createApp, websocket } from "../src/api/app";
import { HashEmbedder } from "../src/search/embedder";
import { Scope } from "../src/auth/principal";
import { SpanoAIClient } from "../../../packages/sdk-typescript/src/index";
import { ensureTestDatabase, makeRedis, disconnectAll } from "./setup";

const T = "tenant-sdk-e2e";

let sql: Sql;
let conn: ReturnType<typeof makeRedis>;
let server: Server;
let client: SpanoAIClient;

beforeAll(async () => {
  sql = await ensureTestDatabase();
  await sql`TRUNCATE artifacts`;
  await sql`DELETE FROM api_keys WHERE tenant_id = ${T}`;
  await sql`DELETE FROM tenants WHERE id = ${T}`;
  conn = makeRedis();
  await conn.redis.flushdb();

  const engine = createEngine({
    redis: conn.redis, redisPub: conn.redisPub, redisSub: conn.redisSub, sql,
    embedder: new HashEmbedder(),
  });
  await engine.tenants.create(T, { name: "E2E", email: `e2e-${crypto.randomUUID()}@x.dev` });
  const { key } = await engine.apiKeys.create(T, { scopes: Object.values(Scope) });

  const app = createApp(engine);
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  client = new SpanoAIClient({ baseUrl: `http://localhost:${server.port}`, apiKey: key, agent: "tester" });
});

afterAll(async () => {
  server.stop(true);
  // Let server-side WS onClose handlers run their redisSub.unsubscribe before
  // we tear the connections down, so no command is flushed mid-flight.
  await new Promise((r) => setTimeout(r, 200));
  disconnectAll(conn);
  await sql.end({ timeout: 5 });
});

describe("SDK ↔ server e2e", () => {
  const S = "run-sdk";

  test("context write/read/append/search", async () => {
    const w = await client.context.write(S, "researcher", "findings", { revenue: "$4.2M" });
    expect(w.outcome).toBe("written");

    const r = await client.context.read<{ revenue: string }>(S, "researcher", "findings");
    expect(r.value.type).toBe("json");
    if (r.value.type === "json") expect(r.value.data.revenue).toBe("$4.2M");

    await client.context.append(S, "shared", "log", ["a"]);
    await client.context.append(S, "shared", "log", ["b"]);
    const log = await client.context.read<string[]>(S, "shared", "log");
    if (log.value.type === "json") expect(log.value.data).toEqual(["a", "b"]);

    // give async indexing a moment, then semantic search
    await new Promise((r) => setTimeout(r, 400));
    const hits = await client.context.search(S, "revenue", 3);
    expect(hits.some((h) => h.fullKey === "researcher.findings")).toBe(true);
  });

  test("sessions create + get", async () => {
    const s = await client.sessions.create({ sessionId: "run-sdk-sess" });
    expect(s.status).toBe("active");
    expect((await client.sessions.get("run-sdk-sess")).sessionId).toBe("run-sdk-sess");
  });

  test("bus request/reply round-trips", async () => {
    const pending = client.bus.request(S, "researcher", "need_revenue", { text: "revenue?" }, { timeoutMs: 5000 });
    setTimeout(async () => {
      const inbox = await client.bus.claim(S, "researcher");
      await client.bus.reply(S, inbox[0]!.id, { text: "$4.2M" });
    }, 100);
    const { reply } = await pending;
    expect(reply?.payload.text).toBe("$4.2M");
  });

  test("artifacts upload + download round-trips the bytes", async () => {
    const bytes = new TextEncoder().encode("hello from the SDK e2e test");
    const art = await client.artifacts.upload(S, { name: "note.txt", mimeType: "text/plain", bytes });
    expect(art.status).toBe("available");
    const back = await client.artifacts.download(S, art.id);
    expect(new TextDecoder().decode(back)).toBe("hello from the SDK e2e test");
  });

  test("live WebSocket stream receives a write", async () => {
    const events: Array<{ event: string; [k: string]: unknown }> = [];
    const stream = client.stream("run-ws", { onEvent: (e) => events.push(e) });
    await new Promise((r) => setTimeout(r, 300)); // allow connect + subscribe
    await client.context.write("run-ws", "n", "k", { hi: true });

    const start = Date.now();
    while (Date.now() - start < 3000 && !events.some((e) => e.event === "CTX_WRITE")) {
      await new Promise((r) => setTimeout(r, 50));
    }
    stream.close();
    expect(events.some((e) => e.event === "CTX_WRITE")).toBe(true);
  });
});
