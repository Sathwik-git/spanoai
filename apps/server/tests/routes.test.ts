/**
 * HTTP API tests — driven through `app.request` (no network). Covers auth,
 * the main route surface, scope/namespace ACL, and cross-tenant isolation.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Hono } from "hono";
import type { Sql } from "postgres";
import { createEngine } from "../src/engine";
import { createApp } from "../src/api/app";
import { Scope } from "../src/auth/principal";
import type { ApiEnv } from "../src/api/middleware";
import { ensureTestDatabase, makeRedis, disconnectAll } from "./setup";

let sql: Sql;
let conn: ReturnType<typeof makeRedis>;
let app: Hono<ApiEnv>;
let keyA = "";
let keyB = "";
const TA = "tenant-routes-a";
const TB = "tenant-routes-b";

function req(
  app: Hono<ApiEnv>,
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; agent?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.key) headers["X-SpanoAI-Key"] = opts.key;
  if (opts.agent) headers["X-SpanoAI-Agent"] = opts.agent;
  return app.request(path, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

beforeAll(async () => {
  sql = await ensureTestDatabase();
  conn = makeRedis();
  const engine = createEngine({
    redis: conn.redis,
    redisPub: conn.redisPub,
    redisSub: conn.redisSub,
    sql,
  });
  app = createApp(engine);

  for (const t of [TA, TB]) {
    await sql`DELETE FROM api_keys WHERE tenant_id = ${t}`;
    await sql`DELETE FROM tenants WHERE id = ${t}`;
    await engine.tenants.create(t, { name: t, email: `${t}-${crypto.randomUUID()}@x.dev` });
  }
  keyA = (await engine.apiKeys.create(TA, { scopes: Object.values(Scope) })).key;
  keyB = (await engine.apiKeys.create(TB, { scopes: Object.values(Scope) })).key;
});
afterAll(async () => {
  disconnectAll(conn);
  await sql.end({ timeout: 5 });
});
beforeEach(() => conn.redis.flushdb());

describe("Auth", () => {
  test("health is public", async () => {
    const res = await req(app, "GET", "/health");
    expect(res.status).toBe(200);
  });

  test("missing key → 401", async () => {
    const res = await req(app, "GET", "/context/s/n/k");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("MISSING_API_KEY");
  });

  test("invalid key → 401", async () => {
    const res = await req(app, "GET", "/context/s/n/k", { key: "spanoai_sk_deadbeef_nope" });
    expect(res.status).toBe(401);
  });
});

describe("Context routes", () => {
  test("write then read round-trips", async () => {
    const w = await req(app, "POST", "/context/run1/researcher/findings", {
      key: keyA, body: { value: { type: "json", data: { revenue: "$4.2M" } } },
    });
    expect(w.status).toBe(201);

    const r = await req(app, "GET", "/context/run1/researcher/findings", { key: keyA });
    expect(r.status).toBe(200);
    expect((await r.json()).value).toEqual({ type: "json", data: { revenue: "$4.2M" } });
  });

  test("append accumulates via the route", async () => {
    await req(app, "POST", "/context/run1/shared/log/append", { key: keyA, body: { items: ["a"] } });
    await req(app, "POST", "/context/run1/shared/log/append", { key: keyA, body: { items: ["b"] } });
    const r = await req(app, "GET", "/context/run1/shared/log", { key: keyA });
    expect((await r.json()).value.data).toEqual(["a", "b"]);
  });

  test("reading a missing key → 404", async () => {
    const r = await req(app, "GET", "/context/run1/x/y", { key: keyA });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("ENTRY_NOT_FOUND");
  });
});

describe("Messages routes", () => {
  test("dispatch + claim + reply", async () => {
    const d = await req(app, "POST", "/messages", {
      key: keyA, agent: "alice",
      body: { sessionId: "run1", toAgent: "bob", intent: "q", payload: { text: "hi" } },
    });
    expect(d.status).toBe(201);
    const msg = await d.json();

    const claim = await req(app, "POST", `/messages/bob/claim?sessionId=run1`, { key: keyA, agent: "bob" });
    const claimed = await claim.json();
    expect(claimed[0].id).toBe(msg.id);

    const reply = await req(app, "POST", `/messages/${msg.id}/reply?sessionId=run1`, {
      key: keyA, agent: "bob", body: { payload: { text: "yo" } },
    });
    expect(reply.status).toBe(200);
    expect((await reply.json()).toAgent).toBe("alice");
  });

  test("broadcast fans out + await-reply correlates each reply", async () => {
    const b = await req(app, "POST", "/messages/broadcast", {
      key: keyA, agent: "lead",
      body: { sessionId: "fan1", toAgents: ["w1", "w2"], intent: "go", payload: { text: "task" } },
    });
    expect(b.status).toBe(201);
    const sent = await b.json();
    expect(sent.length).toBe(2);
    expect(new Set(sent.map((m: { traceId: string }) => m.traceId)).size).toBe(1);

    // Each worker claims its copy and replies.
    for (const w of ["w1", "w2"]) {
      const claim = await req(app, "POST", `/messages/${w}/claim?sessionId=fan1`, { key: keyA, agent: w });
      const claimed = await claim.json();
      await req(app, "POST", `/messages/${claimed[0].id}/reply?sessionId=fan1`, {
        key: keyA, agent: w, body: { payload: { data: { from: w } } },
      });
    }

    // The lead long-polls each original id for its reply.
    for (const m of sent) {
      const r = await req(app, "GET", `/messages/${m.id}/await-reply?sessionId=fan1&timeoutMs=2000`, { key: keyA, agent: "lead" });
      expect(r.status).toBe(200);
      expect((await r.json()).fromAgent).toBe(m.toAgent);
    }
  });

  test("await-reply returns null when no reply arrives before the timeout", async () => {
    const d = await req(app, "POST", "/messages", {
      key: keyA, agent: "alice", body: { sessionId: "to1", toAgent: "bob", intent: "q", payload: { text: "hi" } },
    });
    const msg = await d.json();
    const r = await req(app, "GET", `/messages/${msg.id}/await-reply?sessionId=to1&timeoutMs=200`, { key: keyA, agent: "alice" });
    expect(r.status).toBe(200);
    expect(await r.json()).toBeNull();
  });
});

describe("Sessions + audit routes", () => {
  test("create + get a session", async () => {
    const c = await req(app, "POST", "/sessions", { key: keyA, agent: "orchestrator", body: { sessionId: "run-sess" } });
    expect(c.status).toBe(201);
    const g = await req(app, "GET", "/sessions/run-sess", { key: keyA });
    expect((await g.json()).status).toBe("active");
  });

  test("audit trail is queryable after writes", async () => {
    await req(app, "POST", "/context/run-audit/n/k", { key: keyA, body: { value: { type: "text", text: "x" } } });
    const a = await req(app, "GET", "/audit/run-audit", { key: keyA });
    expect(a.status).toBe(200);
    expect((await a.json()).length).toBeGreaterThanOrEqual(1);
  });
});

describe("Artifacts route", () => {
  test("init-upload returns a presigned URL", async () => {
    await sql`TRUNCATE artifacts`;
    const res = await req(app, "POST", "/artifacts/init-upload", {
      key: keyA,
      body: { sessionId: "run1", name: "f.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.uploadUrl).toContain("http");
    expect(body.artifactId).toBeDefined();
  });
});

describe("Isolation + ACL", () => {
  test("a tenant cannot read another tenant's context", async () => {
    await req(app, "POST", "/context/shared/n/secret", { key: keyA, body: { value: { type: "text", text: "A-only" } } });
    const bRead = await req(app, "GET", "/context/shared/n/secret", { key: keyB });
    expect(bRead.status).toBe(404); // B's keyspace has nothing here
  });

  test("a read-only key cannot write", async () => {
    const engine = createEngine({ redis: conn.redis, redisPub: conn.redisPub, redisSub: conn.redisSub, sql });
    const roKey = (await engine.apiKeys.create(TA, { scopes: [Scope.CONTEXT_READ] })).key;
    const res = await req(app, "POST", "/context/run1/n/k", { key: roKey, body: { value: { type: "text", text: "x" } } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("INSUFFICIENT_SCOPE");
  });

  test("a namespace-scoped key cannot touch other namespaces", async () => {
    const engine = createEngine({ redis: conn.redis, redisPub: conn.redisPub, redisSub: conn.redisSub, sql });
    const nsKey = (await engine.apiKeys.create(TA, { scopes: [Scope.CONTEXT_READ, Scope.CONTEXT_WRITE], namespaces: ["public"] })).key;
    const ok = await req(app, "POST", "/context/run1/public/k", { key: nsKey, body: { value: { type: "text", text: "ok" } } });
    expect(ok.status).toBe(201);
    const denied = await req(app, "POST", "/context/run1/secret/k", { key: nsKey, body: { value: { type: "text", text: "no" } } });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("NAMESPACE_FORBIDDEN");
  });
});
