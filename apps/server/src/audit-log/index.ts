/**
 * AuditLog facade.
 *
 * Callers never manage steps or clocks. `append`:
 *   1. atomically ticks the run's vector clock in Redis (HINCRBY + HGETALL),
 *   2. builds the entry (id, ts, clock),
 *   3. delegates to the backend, which allocates the durable `step` in Postgres.
 *
 * `export` produces a self-describing, SHA-256-signed snapshot of a whole run
 * for compliance / external verification.
 */
import type { Redis, Result, Callback } from "ioredis";
import { config } from "../config";
import type { AuditBackend, AuditQueryParams } from "../backends/interfaces";
import {
  type AuditEntry,
  type AuditAppendInput,
  type Clock,
  type ComplianceExport,
} from "../models/audit-entry";

// Atomically advance one agent's clock component and return the full clock.
const TICK_SCRIPT = `
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return redis.call('HGETALL', KEYS[1])
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    spanoaiAuditTick(
      clockKey: string,
      agentId: string,
      ttlSeconds: string,
      callback?: Callback<string[]>,
    ): Result<string[], Context>;
  }
}

const RETRY_KEY = "spanoai:audit:retry";

function flatToClock(flat: string[]): Clock {
  const clock: Clock = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    clock[flat[i] as string] = Number(flat[i + 1]);
  }
  return clock;
}

export class AuditLog {
  constructor(
    private readonly backend: AuditBackend,
    private readonly redis: Redis,
  ) {
    if (
      typeof (this.redis as unknown as Record<string, unknown>)
        .spanoaiAuditTick !== "function"
    ) {
      this.redis.defineCommand("spanoaiAuditTick", {
        numberOfKeys: 1,
        lua: TICK_SCRIPT,
      });
    }
  }

  private clockKey(tenantId: string, runId: string): string {
    return `spanoai:t:${tenantId}:audit:${runId}:clock`;
  }

  private async tick(
    tenantId: string,
    runId: string,
    agentId: string,
  ): Promise<Clock> {
    const flat = await this.redis.spanoaiAuditTick(
      this.clockKey(tenantId, runId),
      agentId,
      String(config.SPANOAI_OPS_TTL_SECONDS),
    );
    return flatToClock(flat);
  }

  async append(input: AuditAppendInput): Promise<AuditEntry> {
    const clock = await this.tick(input.tenantId, input.runId, input.agentId);
    const entry: Omit<AuditEntry, "step"> = {
      id: input.id ?? crypto.randomUUID(),
      tenantId: input.tenantId,
      runId: input.runId,
      clock,
      eventType: input.eventType,
      agentId: input.agentId,
      payload: input.payload,
      ts: input.ts ?? Date.now(),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    };

    try {
      return await this.backend.append(entry);
    } catch (err) {
      // Postgres unavailable: buffer the entry durably in Redis so a write/
      // dispatch is never blocked by an audit-DB hiccup. A drain job replays
      // these (allocating the durable step) once Postgres recovers.
      await this.redis
        .multi()
        .lpush(RETRY_KEY, JSON.stringify(entry))
        .ltrim(RETRY_KEY, 0, config.SPANOAI_AUDIT_RETRY_MAX - 1)
        .exec()
        .catch(() => {});
      console.error("[audit] buffered to Redis (Postgres append failed):", err);
      return { ...entry, step: -1 }; // step is assigned when the drain replays it
    }
  }

  /** Replay buffered audit entries to Postgres. Stops on the first failure. */
  async drainRetries(limit = 500): Promise<number> {
    let drained = 0;
    for (let i = 0; i < limit; i++) {
      const raw = await this.redis.rpop(RETRY_KEY);
      if (!raw) break;
      try {
        await this.backend.append(JSON.parse(raw) as Omit<AuditEntry, "step">);
        drained += 1;
      } catch {
        // Still failing — put it back and stop until the next tick.
        await this.redis.rpush(RETRY_KEY, raw);
        break;
      }
    }
    return drained;
  }

  /** Count of audit entries currently buffered (Postgres degraded indicator). */
  async pendingRetries(): Promise<number> {
    return this.redis.llen(RETRY_KEY);
  }

  getByRun(tenantId: string, runId: string): Promise<AuditEntry[]> {
    return this.backend.getByRun(tenantId, runId);
  }

  query(params: AuditQueryParams): Promise<AuditEntry[]> {
    return this.backend.query(params);
  }

  async export(tenantId: string, runId: string): Promise<ComplianceExport> {
    const entries = await this.backend.getByRun(tenantId, runId);
    const doc = {
      version: "1.0",
      tenantId,
      runId,
      exportedAt: new Date().toISOString(),
      entryCount: entries.length,
      entries,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return { ...doc, sha256 };
  }
}

export { VectorClock, type ClockComparison } from "./vector-clock";
export {
  ReplayEngine,
  type RunDiff,
  type RunDifference,
} from "./replay-engine";
