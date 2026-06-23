import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Sql } from "postgres";
import { RedisStore } from "../src/backends/redis-store";
import { ContextStore } from "../src/context-store";
import { AuditLog } from "../src/audit-log";
import { ApiKeyService } from "../src/auth/api-keys";
import { TenantService } from "../src/auth/tenants";
import { Scope, type AgentPrincipal } from "../src/auth/principal";
import { EngineError } from "../src/errors";
import {
  ensureTestDatabase,
  makeRedis,
  disconnectAll,
  InMemoryAudit,
  CollectingBroadcaster,
} from "./setup";

const T = "tenant-security";

let conn: ReturnType<typeof makeRedis>;
let store: ContextStore;
let sql: Sql;
let apiKeys: ApiKeyService;
let tenants: TenantService;

async function expectError(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EngineError);
  expect((err as EngineError).code).toBe(code);
}

beforeAll(async () => {
  sql = await ensureTestDatabase();
  conn = makeRedis();
  apiKeys = new ApiKeyService(sql, conn.redis);
  tenants = new TenantService(sql);
});
afterAll(async () => {
  disconnectAll(conn);
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await conn.redis.flushdb();
  const audit = new AuditLog(new InMemoryAudit(), conn.redis);
  store = new ContextStore(new RedisStore(conn.redis), audit, new CollectingBroadcaster());
});

describe("Namespace + scope ACL (ContextStore)", () => {
  const writer: AgentPrincipal = {
    tenantId: T, agentId: "writer",
    scopes: [Scope.CONTEXT_WRITE, Scope.CONTEXT_READ],
    namespaces: ["public"],
  };

  test("no principal = trusted (backward compatible)", async () => {
    const r = await store.write(T, { sessionId: "s", namespace: "secrets", key: "k", value: { type: "text", text: "x" }, writtenBy: "sys" });
    expect(r.outcome).toBe("written");
  });

  test("write requires context:write scope", async () => {
    const reader: AgentPrincipal = { tenantId: T, agentId: "r", scopes: [Scope.CONTEXT_READ] };
    await expectError(
      store.write(T, { sessionId: "s", namespace: "public", key: "k", value: { type: "text", text: "x" }, writtenBy: "r" }, undefined, reader),
      "INSUFFICIENT_SCOPE",
    );
  });

  test("write outside the namespace allowlist is forbidden", async () => {
    await expectError(
      store.write(T, { sessionId: "s", namespace: "secrets", key: "k", value: { type: "text", text: "x" }, writtenBy: "writer" }, undefined, writer),
      "NAMESPACE_FORBIDDEN",
    );
    const ok = await store.write(T, { sessionId: "s", namespace: "public", key: "k", value: { type: "text", text: "ok" }, writtenBy: "writer" }, undefined, writer);
    expect(ok.outcome).toBe("written");
  });

  test("read of a forbidden namespace is denied", async () => {
    await store.write(T, { sessionId: "s", namespace: "secrets", key: "api", value: { type: "text", text: "sk-live" }, writtenBy: "sys" });
    await expectError(
      store.read(T, "s", "secrets.api", undefined, writer),
      "NAMESPACE_FORBIDDEN",
    );
  });

  test("list never leaks namespaces outside the allowlist", async () => {
    await store.write(T, { sessionId: "s", namespace: "public", key: "a", value: { type: "text", text: "1" }, writtenBy: "sys" });
    await store.write(T, { sessionId: "s", namespace: "secrets", key: "b", value: { type: "text", text: "2" }, writtenBy: "sys" });
    const visible = await store.list(T, "s", undefined, writer);
    expect(visible.map((e) => e.namespace)).toEqual(["public"]);
  });

  test("a principal from another tenant is rejected", async () => {
    const intruder: AgentPrincipal = { tenantId: "other", agentId: "x", scopes: [Scope.CONTEXT_READ] };
    await expectError(store.read(T, "s", "public.a", undefined, intruder), "CROSS_TENANT_DENIED");
  });
});

describe("API keys", () => {
  beforeEach(async () => {
    await sql`DELETE FROM api_keys WHERE tenant_id = ${T}`;
    await sql`DELETE FROM tenants WHERE id = ${T}`;
    await tenants.create(T, { name: "Acme", email: `acme-${crypto.randomUUID()}@test.dev` });
  });

  test("create returns a raw key that verifies to its tenant + scopes", async () => {
    const { id, key } = await apiKeys.create(T, { scopes: [Scope.CONTEXT_READ, Scope.CONTEXT_WRITE] });
    expect(key.startsWith("spanoai_sk_")).toBe(true);

    const resolved = await apiKeys.verify(key);
    expect(resolved).not.toBeNull();
    expect(resolved!.tenantId).toBe(T);
    expect(resolved!.keyId).toBe(id);
    expect(resolved!.scopes).toEqual([Scope.CONTEXT_READ, Scope.CONTEXT_WRITE]);
  });

  test("a tampered secret with a valid keyId is rejected", async () => {
    const { key } = await apiKeys.create(T, { scopes: [Scope.CONTEXT_READ] });
    const tampered = key.slice(0, -4) + "0000";
    expect(await apiKeys.verify(tampered)).toBeNull();
  });

  test("garbage keys are rejected", async () => {
    expect(await apiKeys.verify("not-a-key")).toBeNull();
    expect(await apiKeys.verify("spanoai_sk_deadbeef_nope")).toBeNull();
  });

  test("verification is cached, and revocation purges the cache immediately", async () => {
    const { id, key } = await apiKeys.create(T, { scopes: [Scope.CONTEXT_READ] });
    expect(await apiKeys.verify(key)).not.toBeNull(); // cold -> caches
    expect(await apiKeys.verify(key)).not.toBeNull(); // warm (cache hit)

    await apiKeys.revoke(T, id);
    expect(await apiKeys.verify(key)).toBeNull();
  });
});
