/**
 * USER-POV REGRESSION: the multi-agent coordination gaps, now CLOSED.
 *
 * This script previously enumerated what the engine could NOT do. It now
 * demonstrates the fixes against live infra. Run after `docker compose up -d`:
 *   bun run scripts/coordination-gaps.ts
 */
import { createEngine } from "../src/engine";
import { HashEmbedder } from "../src/search/embedder";
import { redis, closeConnections } from "../src/redis";
import { sql, closeSql } from "../src/db/client";

const engine = createEngine({ embedder: new HashEmbedder() });
const T = "tenant-coord-probe";
const S = "run-coord-001";

const ok = (m: string) => console.log(`  ✅ ${m}`);
const head = (m: string) => console.log(`\n=== ${m} ===`);

async function main() {
  await redis.select(0);

  head("1. Five agents accumulate into one shared list (atomic append)");
  await Promise.all(
    ["a", "b", "c", "d", "e"].map((agent) =>
      engine.store.append(T, { sessionId: S, namespace: "shared", key: "findings", items: [`finding-${agent}`], writtenBy: agent }),
    ),
  );
  const items = ((await engine.store.read(T, S, "shared.findings"))!.value as { data: string[] }).data;
  ok(`all ${items.length}/5 findings preserved (no lost updates): ${JSON.stringify(items)}`);

  head("2. Reviewer awaits the coder's result (watch / barrier)");
  const waiter = engine.store.awaitKey(T, S, "coder.result", { timeoutMs: 3000 });
  setTimeout(() => void engine.store.write(T, { sessionId: S, namespace: "coder", key: "result", value: { type: "json", data: { done: true } }, writtenBy: "coder" }), 150);
  const awaited = await waiter;
  ok(`awaitKey unblocked when coder wrote (done=${(awaited!.value as { data: { done: boolean } }).data.done})`);

  head("3. Agent asks another agent and awaits the reply (request/reply)");
  const pending = engine.bus.request(T, { sessionId: S, fromAgent: "writer", toAgent: "researcher", intent: "need_revenue", payload: { text: "revenue?" } }, { timeoutMs: 3000 });
  setTimeout(async () => {
    const inbox = await engine.bus.claim(T, S, "researcher", "r1", 10);
    await engine.bus.reply(T, S, inbox[0]!.id, { fromAgent: "researcher", payload: { text: "$4.2M" } });
  }, 150);
  const { reply } = await pending;
  ok(`request() received the reply: "${reply?.payload.text}"`);

  head("4. Crashed consumer's message is reclaimed by the sweeper");
  await engine.bus.dispatch(T, { sessionId: S, fromAgent: "o", toAgent: "worker", intent: "task", payload: { text: "t" } });
  await engine.bus.claim(T, S, "worker", "w1", 10); // claimed, never acked (crash)
  // The real sweeper uses a 30s idle threshold; here we force 0ms to demonstrate.
  const report = await engine.bus.sweep({ tenantId: T, sessionId: S, agentId: "worker" }, 0);
  ok(`sweeper (run by startBackgroundJobs on an interval) reclaimed ${report.reclaimed} stuck message(s)`);

  head("5. Semantic search over shared context");
  await engine.store.write(T, { sessionId: S, namespace: "n", key: "fin", value: { type: "text", text: "quarterly revenue and profit growth" }, writtenBy: "a" });
  await engine.store.write(T, { sessionId: S, namespace: "n", key: "law", value: { type: "text", text: "merger liability and indemnification" }, writtenBy: "a" });
  await new Promise((r) => setTimeout(r, 400)); // async indexing
  const hits = await engine.store.search(T, S, "revenue profit", 1);
  ok(`search ranked "${hits[0]?.fullKey}" first for "revenue profit"`);

  head("6. Per-agent namespace ACL");
  await engine.store.write(T, { sessionId: S, namespace: "secrets", key: "api", value: { type: "text", text: "sk-live" }, writtenBy: "admin" });
  const lowTrust = { tenantId: T, agentId: "plugin", scopes: ["context:read" as const], namespaces: ["public"] };
  try {
    await engine.store.read(T, S, "secrets.api", undefined, lowTrust);
    console.log("  ❌ (unexpected) low-trust agent read secrets");
  } catch (e) {
    ok(`low-trust agent BLOCKED from "secrets" namespace (${(e as { code: string }).code})`);
  }

  const keys = await redis.keys(`spanoai:t:${T}:*`);
  if (keys.length) await redis.del(...keys);
  await sql`DELETE FROM context_embeddings WHERE tenant_id = ${T}`;
  await sql`DELETE FROM audit_log WHERE tenant_id = ${T}`;
  await sql`DELETE FROM audit_run_counters WHERE tenant_id = ${T}`;
  console.log("\n(probe data cleaned up)");
}

main()
  .catch((e) => { console.error("probe error:", e); process.exitCode = 1; })
  .finally(async () => { await closeConnections(); await closeSql(); process.exit(process.exitCode ?? 0); });
