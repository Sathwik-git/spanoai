/**
 * Live smoke test: HTTP write should fan out to a connected WebSocket client.
 * Requires the server running on PORT (default 8000) + docker infra up.
 *   Terminal A: bun run src/index.ts
 *   Terminal B: bun run scripts/ws-smoke.ts
 */
import { createEngine } from "../src/engine";
import { Scope } from "../src/auth/principal";
import { redis, closeConnections } from "../src/redis";
import { sql, closeSql } from "../src/db/client";

const BASE = `http://localhost:${process.env.PORT ?? 8000}`;
const WS_BASE = BASE.replace("http", "ws");
const T = "smoke-tenant";

async function main() {
  await redis.select(0);
  const engine = createEngine();
  await engine.tenants.create(T, { name: "Smoke", email: `smoke-${crypto.randomUUID()}@x.dev` });
  const { key } = await engine.apiKeys.create(T, { scopes: Object.values(Scope) });
  const sid = `ws-smoke-${crypto.randomUUID().slice(0, 8)}`;

  const received: Array<Record<string, unknown>> = [];
  const ticket = await fetch(`${BASE}/stream-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SpanoAI-Key": key },
    body: JSON.stringify({ sessionId: sid }),
  }).then((r) => r.json()).then((j) => (j as { ticket: string }).ticket);
  const ws = new WebSocket(`${WS_BASE}/stream/${sid}?ticket=${ticket}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  ws.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
  console.log("  ✅ WebSocket connected");

  // Give the subscription a moment, then write over HTTP.
  await new Promise((r) => setTimeout(r, 200));
  const res = await fetch(`${BASE}/context/${sid}/researcher/findings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SpanoAI-Key": key },
    body: JSON.stringify({ value: { type: "json", data: { revenue: "$4.2M" } } }),
  });
  console.log(`  ✅ HTTP write status ${res.status}`);

  // Wait for the broadcast to arrive on the socket.
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (received.some((m) => m.event === "CTX_WRITE")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const event = received.find((m) => m.event === "CTX_WRITE");
  if (event) console.log(`  ✅ WS received live CTX_WRITE (seq=${event.seq}, key=${event.fullKey})`);
  else console.log(`  ❌ no CTX_WRITE received; got: ${JSON.stringify(received)}`);

  ws.close();

  // cleanup
  const keys = await redis.keys(`spanoai:t:${T}:*`);
  if (keys.length) await redis.del(...keys);
  await sql`DELETE FROM api_keys WHERE tenant_id = ${T}`;
  await sql`DELETE FROM tenants WHERE id = ${T}`;
  await sql`DELETE FROM audit_log WHERE tenant_id = ${T}`;
  await sql`DELETE FROM audit_run_counters WHERE tenant_id = ${T}`;
  console.log("  (cleaned up)");
  process.exitCode = event ? 0 : 1;
}

main()
  .catch((e) => { console.error("smoke error:", e); process.exitCode = 1; })
  .finally(async () => { await closeConnections(); await closeSql(); process.exit(process.exitCode ?? 0); });
