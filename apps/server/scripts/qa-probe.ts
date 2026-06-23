/**
 * SENIOR-QA ADVERSARIAL PROBE of the core engine. Hunts subtle failures that
 * happy-path tests miss: data-encoding edges, number precision, unicode,
 * concurrency idempotency, identifier injection into infra keys, and the
 * session/context coordination model. Run with Docker infra up:
 *   bun run scripts/qa-probe.ts
 */
import { createEngine } from "../src/engine";
import { RedisStore } from "../src/backends/redis-store";
import { ContextWriteRequestSchema } from "../src/models/context-entry";
import { redis, closeConnections } from "../src/redis";
import { sql, closeSql } from "../src/db/client";

const engine = createEngine();
const store = engine.store;
const rawStore = new RedisStore(redis);
const T = "tenant-qa";
const S = `qa-${crypto.randomUUID().slice(0, 8)}`;

const ok = (m: string) => console.log(`  ✅ ${m}`);
const bug = (m: string) => console.log(`  🐞 BUG: ${m}`);
const warn = (m: string) => console.log(`  ⚠️  ${m}`);
const head = (m: string) => console.log(`\n=== ${m} ===`);
let bugs = 0;

async function main() {
  await redis.select(0);

  // ── 1. Empty array / object round-trip (cjson can't tell [] from {}) ──
  head("1. Empty array / nested empty round-trip");
  await store.write(T, { sessionId: S, namespace: "n", key: "emptyArr", value: { type: "json", data: [] }, writtenBy: "x" });
  const ea = await store.read(T, S, "n.emptyArr");
  const eaData = (ea!.value as { data: unknown }).data;
  if (Array.isArray(eaData)) ok(`[] stayed an array`);
  else { bugs++; bug(`wrote [] but read back ${JSON.stringify(eaData)} (${Array.isArray(eaData) ? "array" : typeof eaData}) — array became object`); }

  await store.write(T, { sessionId: S, namespace: "n", key: "nested", value: { type: "json", data: { items: [], meta: {}, name: "ok" } }, writtenBy: "x" });
  const ne = await store.read(T, S, "n.nested");
  const neData = (ne!.value as { data: { items: unknown; meta: unknown } }).data;
  if (Array.isArray(neData.items)) ok(`nested empty [] stayed an array`);
  else { bugs++; bug(`nested {items:[]} read back as items=${JSON.stringify(neData.items)} — array became object`); }

  // ── 2. Number precision (large ints in value + writtenAt) ────────────
  head("2. Number precision");
  const bigInt = 9007199254740991; // 2^53 - 1, max safe integer
  const ts = 1700000000123;
  await store.write(T, { sessionId: S, namespace: "n", key: "nums", value: { type: "json", data: { big: bigInt, ts } }, writtenBy: "x" });
  const nm = await store.read(T, S, "n.nums");
  const nmData = (nm!.value as { data: { big: number; ts: number } }).data;
  if (nmData.big === bigInt && nmData.ts === ts) ok(`large ints preserved exactly (${nmData.big}, ${nmData.ts})`);
  else { bugs++; bug(`number precision lost: big=${nmData.big} (want ${bigInt}), ts=${nmData.ts} (want ${ts})`); }

  const fixedNow = 1700000000123;
  await rawStore.write(T, ContextWriteRequestSchema.parse({ sessionId: S, namespace: "n", key: "wa", value: { type: "text", text: "x" }, writtenBy: "x" }), fixedNow);
  const wa = await rawStore.get(T, S, "n.wa");
  if (wa!.writtenAt === fixedNow) ok(`writtenAt round-trips exactly (${wa!.writtenAt})`);
  else { bugs++; bug(`writtenAt corrupted: ${wa!.writtenAt} (want ${fixedNow})`); }

  // ── 3. Unicode / special characters ──────────────────────────────────
  head("3. Unicode & special characters");
  const tricky = 'emoji 🚀 "quotes" \n newline \\ backslash 日本語 \t tab';
  await store.write(T, { sessionId: S, namespace: "n", key: "uni", value: { type: "text", text: tricky }, writtenBy: "x" });
  const uni = await store.read(T, S, "n.uni");
  if ((uni!.value as { text: string }).text === tricky) ok(`unicode + quotes + control chars preserved`);
  else { bugs++; bug(`unicode corrupted: got ${JSON.stringify((uni!.value as { text: string }).text)}`); }

  // ── 4. Concurrent SAME operationId append (idempotency under race) ───
  head("4. Concurrent same-operationId append");
  const op = crypto.randomUUID();
  await Promise.all(
    Array.from({ length: 50 }, () =>
      store.append(T, { sessionId: S, namespace: "n", key: "idemList", items: ["x"], writtenBy: "a", operationId: op }),
    ),
  );
  const il = await store.read(T, S, "n.idemList");
  const ilLen = (il!.value as { data: unknown[] }).data.length;
  if (ilLen === 1) ok(`50 concurrent appends w/ same operationId → exactly 1 item`);
  else { bugs++; bug(`idempotency race: list has ${ilLen} items (want 1)`); }

  // ── 5. Unsanitized agent identifiers in infra keys ───────────────────
  head("5. Identifier injection (agent ids that build Redis keys)");
  const evilAgent = "evil|pipe:colon";
  let rejected = false;
  try {
    await engine.bus.dispatch(T, { sessionId: S, fromAgent: "a", toAgent: evilAgent, intent: "t", payload: { text: "hi" } });
  } catch {
    rejected = true;
  }
  if (rejected) ok(`agent id with ':'/'|' is rejected (cannot corrupt stream keys or the inbox registry)`);
  else { bugs++; bug(`agent id "${evilAgent}" was accepted — could corrupt the 'tid|sid|agent' registry`); }

  // ── 6. Session / context coordination model ──────────────────────────
  head("6. Session vs context coupling");
  await store.write(T, { sessionId: "ghost-session", namespace: "n", key: "k", value: { type: "text", text: "orphan" }, writtenBy: "x" });
  const listed = (await engine.sessions.list(T)).some((s) => s.sessionId === "ghost-session");
  if (listed) ok(`writing context auto-registered the session`);
  else warn(`context written to "ghost-session" but it is NOT in /sessions — context & sessions are decoupled; a dev who never calls createSession won't see runs in the dashboard/session API`);

  // ── cleanup ───────────────────────────────────────────────────────────
  const keys = await redis.keys(`spanoai:t:${T}:*`);
  if (keys.length) await redis.del(...keys);
  await redis.srem(
    "spanoai:bus:inboxes",
    ...(await redis.smembers("spanoai:bus:inboxes")).filter((m) => m.startsWith(`${T}|`)),
  ).catch(() => {});
  await sql`DELETE FROM audit_log WHERE tenant_id = ${T}`;
  await sql`DELETE FROM audit_run_counters WHERE tenant_id = ${T}`;

  console.log(`\n${bugs === 0 ? "no data/concurrency bugs found" : `${bugs} issue(s) found`}`);
}

main()
  .catch((e) => { console.error("probe error:", e); process.exitCode = 1; })
  .finally(async () => { await closeConnections(); await closeSql(); process.exit(process.exitCode ?? 0); });
