import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { RedisStore } from "../src/backends/redis-store";
import { ContextStore } from "../src/context-store";
import { AuditLog } from "../src/audit-log";
import type { AuditBackend, AuditQueryParams } from "../src/backends/interfaces";
import type { AuditEntry } from "../src/models/audit-entry";
import { EngineError } from "../src/errors";
import { makeRedis, disconnectAll, InMemoryAudit, CollectingBroadcaster } from "./setup";

/** Audit backend whose append fails until `failing` is cleared. */
class ControllableAudit implements AuditBackend {
  failing = true;
  readonly inner = new InMemoryAudit();
  async append(e: Omit<AuditEntry, "step">): Promise<AuditEntry> {
    if (this.failing) throw new Error("postgres down");
    return this.inner.append(e);
  }
  getByRun(t: string, r: string) { return this.inner.getByRun(t, r); }
  query(p: AuditQueryParams) { return this.inner.query(p); }
}

const T = "tenant-resilience";

let conn: ReturnType<typeof makeRedis>;

beforeAll(() => { conn = makeRedis(); });
afterAll(() => disconnectAll(conn));
beforeEach(async () => { await conn.redis.flushdb(); });

describe("Audit resilience (Postgres outage)", () => {
  test("a context write succeeds even when the audit DB is down", async () => {
    const ctrl = new ControllableAudit();
    const audit = new AuditLog(ctrl, conn.redis);
    const store = new ContextStore(new RedisStore(conn.redis), audit, new CollectingBroadcaster());

    const r = await store.write(T, { sessionId: "s", namespace: "n", key: "k", value: { type: "text", text: "x" }, writtenBy: "a" });
    expect(r.outcome).toBe("written");
    expect(await store.read(T, "s", "n.k")).not.toBeNull(); // state is intact
    expect(await audit.pendingRetries()).toBe(1); // audit buffered, not lost
  });

  test("buffered audit entries drain to Postgres once it recovers", async () => {
    const ctrl = new ControllableAudit();
    const audit = new AuditLog(ctrl, conn.redis);

    const e = await audit.append({ tenantId: T, runId: "run", agentId: "a", eventType: "CTX_WRITE" as never, payload: {} });
    expect(e.step).toBe(-1); // buffered, step not yet assigned
    expect(await audit.pendingRetries()).toBe(1);

    ctrl.failing = false;
    expect(await audit.drainRetries()).toBe(1);
    expect(await audit.pendingRetries()).toBe(0);
    expect(ctrl.inner.entries).toHaveLength(1);
    expect(ctrl.inner.entries[0]!.step).toBe(1); // real durable step assigned on replay
  });
});

describe("Per-session entry cap (abuse guard)", () => {
  test("creating a new key past the cap is rejected, existing keys still writable", async () => {
    const audit = new AuditLog(new InMemoryAudit(), conn.redis);
    const store = new ContextStore(
      new RedisStore(conn.redis), audit, new CollectingBroadcaster(),
      undefined, undefined, 2, // maxEntriesPerSession = 2
    );

    await store.write(T, { sessionId: "s", namespace: "n", key: "a", value: { type: "text", text: "1" }, writtenBy: "x" });
    await store.write(T, { sessionId: "s", namespace: "n", key: "b", value: { type: "text", text: "2" }, writtenBy: "x" });

    let err: unknown;
    try {
      await store.write(T, { sessionId: "s", namespace: "n", key: "c", value: { type: "text", text: "3" }, writtenBy: "x" });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("ENTRY_LIMIT_EXCEEDED");

    // Existing keys remain writable even at the cap.
    const r = await store.write(T, { sessionId: "s", namespace: "n", key: "a", value: { type: "text", text: "updated" }, writtenBy: "x" });
    expect(r.outcome).toBe("written");
  });
});
