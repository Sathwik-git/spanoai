/**
 * Full product E2E against the RUNNING server (localhost:PORT), exercising the
 * stack exactly as a real client (SDK / dashboard) would: HTTP + WebSocket,
 * authenticated with a real API key. Bootstraps a tenant + keys via the engine,
 * then talks only over the network. Exits non-zero on any failed assertion.
 *
 *   Terminal A: bun run src/index.ts
 *   Terminal B: bun run scripts/e2e.ts
 */
import { createEngine } from "../src/engine";
import { Scope } from "../src/auth/principal";
import { redis, closeConnections } from "../src/redis";
import { sql, closeSql } from "../src/db/client";

const PORT = process.env.PORT ?? "8000";
const BASE = `http://localhost:${PORT}`;
const WS = BASE.replace("http", "ws");
const T = "tenant-e2e";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const head = (m: string) => console.log(`\n=== ${m} ===`);

type Res = { status: number; body: any };
async function req(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; agent?: string; query?: Record<string, string> } = {},
): Promise<Res> {
  const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.key) headers["X-SpanoAI-Key"] = opts.key;
  if (opts.agent) headers["X-SpanoAI-Agent"] = opts.agent;
  const res = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  // ── bootstrap (direct engine) ──────────────────────────────────────
  await redis.select(0);
  const engine = createEngine();
  await sql`DELETE FROM api_keys WHERE tenant_id = ${T}`;
  await sql`DELETE FROM tenants WHERE id = ${T}`;
  await engine.tenants.create(T, { name: "E2E", email: `e2e-${crypto.randomUUID()}@x.dev` });
  const full = (await engine.apiKeys.create(T, { scopes: Object.values(Scope) })).key;
  const scoped = (await engine.apiKeys.create(T, {
    scopes: [Scope.CONTEXT_READ, Scope.CONTEXT_WRITE],
    namespaces: ["public"],
  })).key;
  const S = `e2e-${crypto.randomUUID().slice(0, 8)}`;

  // ── 1. health + auth ───────────────────────────────────────────────
  head("1. Health & auth");
  check("GET /health is ok", (await req("GET", "/health")).body.status === "ok");
  check("no key → 401", (await req("GET", `/context/${S}/n/k`)).status === 401);
  check("bad key → 401", (await req("GET", `/context/${S}/n/k`, { key: "spanoai_sk_dead_beef" })).status === 401);
  const metrics = await fetch(`${BASE}/metrics`).then((r) => r.text());
  check("/metrics exposes Prometheus data", metrics.includes("spanoai_http_requests_total"));

  // ── 2. sessions ────────────────────────────────────────────────────
  head("2. Sessions");
  const created = await req("POST", "/sessions", { key: full, agent: "orchestrator", body: { sessionId: S } });
  check("create session → 201 active", created.status === 201 && created.body.status === "active");
  check("get session", (await req("GET", `/sessions/${S}`, { key: full })).body.sessionId === S);
  check("list sessions includes it", (await req("GET", "/sessions", { key: full })).body.some((x: any) => x.sessionId === S));

  // ── 3. context: write/read/append/increment/CAS ────────────────────
  head("3. Context store");
  const w = await req("POST", `/context/${S}/researcher/findings`, { key: full, agent: "researcher", body: { value: { type: "json", data: { revenue: "$4.2M" } } } });
  check("write → 201 written v1", w.status === 201 && w.body.outcome === "written" && w.body.version === 1);
  const r = await req("GET", `/context/${S}/researcher/findings`, { key: full });
  check("read returns the value", r.body.value?.data?.revenue === "$4.2M");

  for (const item of ["a", "b", "c"]) {
    await req("POST", `/context/${S}/shared/log/append`, { key: full, agent: "x", body: { items: [item] } });
  }
  const log = await req("GET", `/context/${S}/shared/log`, { key: full });
  check("append accumulated all 3 items", JSON.stringify(log.body.value?.data) === JSON.stringify(["a", "b", "c"]));

  await req("POST", `/context/${S}/stats/count/increment`, { key: full, body: { by: 5 } });
  await req("POST", `/context/${S}/stats/count/increment`, { key: full, body: { by: 3 } });
  const cnt = await req("GET", `/context/${S}/stats/count`, { key: full });
  check("increment summed to 8", cnt.body.value?.data === 8);

  const cas = await req("POST", `/context/${S}/researcher/findings`, { key: full, body: { value: { type: "json", data: { v: 2 } }, expectedVersion: 99 } });
  check("stale expectedVersion → 409 conflict", cas.status === 200 ? cas.body.outcome === "conflict" : cas.status === 409 || cas.body.outcome === "conflict");

  // ── 4. namespace ACL ───────────────────────────────────────────────
  head("4. Per-agent namespace ACL");
  const okNs = await req("POST", `/context/${S}/public/note`, { key: scoped, body: { value: { type: "text", text: "ok" } } });
  check("scoped key writes allowed namespace → 201", okNs.status === 201);
  const badNs = await req("POST", `/context/${S}/secret/note`, { key: scoped, body: { value: { type: "text", text: "no" } } });
  check("scoped key BLOCKED from other namespace → 403", badNs.status === 403 && badNs.body.error === "NAMESPACE_FORBIDDEN");

  // ── 5. messages ────────────────────────────────────────────────────
  head("5. Message bus");
  const m = await req("POST", "/messages", { key: full, agent: "alice", body: { sessionId: S, toAgent: "bob", intent: "q", payload: { text: "hi" } } });
  check("dispatch → 201", m.status === 201);
  const claim = await req("POST", `/messages/bob/claim`, { key: full, agent: "bob", query: { sessionId: S } });
  check("claim returns the message", Array.isArray(claim.body) && claim.body[0]?.id === m.body.id);
  const reply = await req("POST", `/messages/${m.body.id}/reply`, { key: full, agent: "bob", query: { sessionId: S }, body: { payload: { text: "yo" } } });
  check("reply → toAgent alice", reply.status === 200 && reply.body.toAgent === "alice");

  // request/reply with a background responder
  const reqPromise = req("POST", "/messages/request", { key: full, agent: "writer", body: { sessionId: S, toAgent: "researcher", intent: "need", payload: { text: "?" }, timeoutMs: 5000 } });
  setTimeout(async () => {
    const inbox = await req("POST", `/messages/researcher/claim`, { key: full, agent: "researcher", query: { sessionId: S } });
    if (inbox.body[0]) await req("POST", `/messages/${inbox.body[0].id}/reply`, { key: full, agent: "researcher", query: { sessionId: S }, body: { payload: { text: "$4.2M" } } });
  }, 200);
  const reqRes = await reqPromise;
  check("request() received correlated reply", reqRes.body.reply?.payload?.text === "$4.2M");

  // multi-recipient broadcast
  const bc = await req("POST", "/messages/broadcast", { key: full, agent: "orchestrator", body: { sessionId: S, toAgents: ["w1", "w2", "w3"], intent: "fanout", payload: { text: "go" } } });
  if (bc.status !== 201) console.log(`     (broadcast resp ${bc.status}: ${JSON.stringify(bc.body)})`);
  check("broadcast → 201 with one message per agent", bc.status === 201 && Array.isArray(bc.body) && bc.body.length === 3);
  const w1 = await req("POST", "/messages/w1/claim", { key: full, agent: "w1", query: { sessionId: S } });
  const w2 = await req("POST", "/messages/w2/claim", { key: full, agent: "w2", query: { sessionId: S } });
  check("each broadcast recipient received it", w1.body[0]?.intent === "fanout" && w2.body[0]?.intent === "fanout");
  check("broadcast messages share a traceId", Array.isArray(bc.body) && bc.body[0]?.traceId === bc.body[1]?.traceId);

  // session auto-registration on activity
  const autoSid = `${S}-auto`;
  await req("POST", `/context/${autoSid}/n/k`, { key: full, body: { value: { type: "text", text: "x" } } });
  const autoListed = (await req("GET", "/sessions", { key: full })).body.some((x: any) => x.sessionId === autoSid);
  check("writing context auto-registers the run in /sessions", autoListed);
  await req("DELETE", `/sessions/${autoSid}`, { key: full });

  // ── 6. artifacts (MinIO) ───────────────────────────────────────────
  head("6. Artifacts (object storage)");
  const bytes = new TextEncoder().encode("hello from the e2e test — the quick brown fox");
  const sha = await sha256Hex(bytes);
  const init = await req("POST", "/artifacts/init-upload", { key: full, body: { sessionId: S, name: "report.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, sha256: sha } });
  check("init-upload → presigned URL", init.status === 201 && typeof init.body.uploadUrl === "string");
  const put = await fetch(init.body.uploadUrl, { method: "PUT", body: bytes, headers: { "Content-Type": "application/pdf" } });
  check("PUT bytes directly to storage → ok", put.ok);
  const complete = await req("POST", `/artifacts/${init.body.artifactId}/complete`, { key: full, body: { sha256: sha } });
  check("complete verifies + marks available", complete.body.status === "available");
  const dl = await req("POST", `/artifacts/${init.body.artifactId}/download-url`, { key: full, query: { sessionId: S } });
  const back = new Uint8Array(await (await fetch(dl.body.url)).arrayBuffer());
  check("download bytes round-trip exactly", Buffer.from(back).equals(Buffer.from(bytes)));

  // ── 7. audit ───────────────────────────────────────────────────────
  head("7. Audit trail");
  const audit = await req("GET", `/audit/${S}`, { key: full });
  check("audit has entries with strictly increasing steps", Array.isArray(audit.body) && audit.body.length > 0 && audit.body.every((e: any, i: number) => e.step === i + 1));

  // ── 8. live WebSocket ──────────────────────────────────────────────
  head("8. Live WebSocket stream");
  const events: any[] = [];
  const ticketRes = await req("POST", "/stream-ticket", { key: full, body: { sessionId: S } });
  check("mint WS ticket → 200", ticketRes.status === 200 && typeof ticketRes.body.ticket === "string");
  const ws = new WebSocket(`${WS}/stream/${S}?ticket=${ticketRes.body.ticket}`);
  const opened = await new Promise<boolean>((res) => {
    ws.addEventListener("open", () => res(true));
    ws.addEventListener("error", () => res(false));
    setTimeout(() => res(false), 3000);
  });
  check("WebSocket connects", opened);
  ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  await new Promise((r) => setTimeout(r, 200));
  await req("POST", `/context/${S}/live/ping`, { key: full, body: { value: { type: "json", data: { t: Date.now() } } } });
  const start = Date.now();
  while (Date.now() - start < 3000 && !events.some((e) => e.event === "CTX_WRITE" && e.fullKey === "live.ping")) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check("live CTX_WRITE received over WS", events.some((e) => e.event === "CTX_WRITE" && e.fullKey === "live.ping"));
  ws.close();

  // ── cleanup ────────────────────────────────────────────────────────
  await req("DELETE", `/sessions/${S}`, { key: full, agent: "orchestrator" });
  const keys = await redis.keys(`spanoai:t:${T}:*`);
  if (keys.length) await redis.del(...keys);
  await sql`DELETE FROM artifacts WHERE tenant_id = ${T}`;
  await sql`DELETE FROM api_keys WHERE tenant_id = ${T}`;
  await sql`DELETE FROM tenants WHERE id = ${T}`;
  await sql`DELETE FROM audit_log WHERE tenant_id = ${T}`;
  await sql`DELETE FROM audit_run_counters WHERE tenant_id = ${T}`;

  console.log(`\n${fail === 0 ? "✅ ALL PASSED" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error("e2e error:", e); process.exitCode = 1; })
  .finally(async () => { await closeConnections(); await closeSql(); process.exit(process.exitCode ?? 0); });
