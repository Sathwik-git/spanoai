/**
 * Shared helper for the example apps. Mints an ephemeral tenant + API key
 * directly via the engine (the "signup/admin" step), then the examples talk to
 * the running server purely through the SDK — exactly how a real integration
 * would, once an API key has been issued.
 *
 * Requires the engine running (docker compose up -d && bun run --filter
 * @spanoai/server dev) on SPANOAI_API_URL (default http://localhost:8000).
 */
import { createEngine } from "../../apps/server/src/engine";
import { Scope } from "../../apps/server/src/auth/principal";
import { redis, closeConnections } from "../../apps/server/src/redis";
import { sql, closeSql } from "../../apps/server/src/db/client";

export const BASE_URL = process.env.SPANOAI_API_URL ?? "http://localhost:8000";

export async function bootstrap(name: string): Promise<{ apiKey: string; tenantId: string }> {
  const engine = createEngine();
  const tenantId = `ex-${name}-${crypto.randomUUID().slice(0, 8)}`;
  await engine.tenants.create(tenantId, { name, email: `${tenantId}@example.dev` });
  const { key } = await engine.apiKeys.create(tenantId, { scopes: Object.values(Scope) });
  return { apiKey: key, tenantId };
}

export async function teardown(tenantId: string): Promise<void> {
  const keys = await redis.keys(`spanoai:t:${tenantId}:*`);
  if (keys.length) await redis.del(...keys);
  const inboxes = (await redis.smembers("spanoai:bus:inboxes")).filter((m) => m.startsWith(`${tenantId}|`));
  if (inboxes.length) await redis.srem("spanoai:bus:inboxes", ...inboxes);
  await sql`DELETE FROM artifacts WHERE tenant_id = ${tenantId}`;
  await sql`DELETE FROM api_keys WHERE tenant_id = ${tenantId}`;
  await sql`DELETE FROM tenants WHERE id = ${tenantId}`;
  await sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`;
  await sql`DELETE FROM audit_run_counters WHERE tenant_id = ${tenantId}`;
}

export async function shutdown(): Promise<void> {
  await closeConnections();
  await closeSql();
}

/** Tiny assertion helper shared by the examples. */
export function makeChecker() {
  let pass = 0;
  let fail = 0;
  return {
    check(name: string, ok: boolean, detail = "") {
      if (ok) {
        pass += 1;
        console.log(`  ✅ ${name}`);
      } else {
        fail += 1;
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
      }
    },
    summary() {
      console.log(`\n${fail === 0 ? "✅ PASSED" : "❌ FAILED"} — ${pass} ok, ${fail} failed`);
      return fail === 0;
    },
  };
}
