/**
 * SessionService — session lifecycle, membership, TTL, and cancellation.
 *
 * A session is a Redis-resident record with a TTL, a member roster, and an
 * abort flag. Lifecycle transitions are audited (SESSION_START / AGENT_JOIN /
 * AGENT_LEAVE / SESSION_END). The abort flag gives agents a cancellation
 * channel — a commonly-missed coordination primitive — so in-flight work can
 * stop instead of writing stale state.
 */
import type { Redis } from "ioredis";
import { config } from "../config";
import { EngineError } from "../errors";
import type { AuditLog } from "../audit-log";
import { EventType } from "../models/audit-entry";
import {
  CreateSessionRequestSchema,
  SessionStatus,
  type Session,
  type CreateSessionRequestInput,
} from "../models/session";

interface SessionMeta {
  sessionId: string;
  tenantId: string;
  createdBy: string;
  status: SessionStatus;
  createdAt: number;
  ttlSeconds: number;
  metadata: Record<string, unknown>;
}

export class SessionService {
  constructor(
    private readonly redis: Redis,
    private readonly audit: AuditLog,
  ) {}

  private metaKey(t: string, s: string) { return `spanoai:t:${t}:session:${s}`; }
  private membersKey(t: string, s: string) { return `spanoai:t:${t}:session:${s}:members`; }
  private abortKey(t: string, s: string) { return `spanoai:t:${t}:session:${s}:abort`; }
  private indexKey(t: string) { return `spanoai:t:${t}:sessions`; }
  private tenantsKey() { return `spanoai:tenants`; }

  async create(
    tenantId: string,
    input: CreateSessionRequestInput,
  ): Promise<Session> {
    const req = CreateSessionRequestSchema.parse(input);
    const ttl = req.ttlSeconds ?? config.SPANOAI_SESSION_TTL_SECONDS;
    const meta: SessionMeta = {
      sessionId: req.sessionId,
      tenantId,
      createdBy: req.createdBy,
      status: SessionStatus.ACTIVE,
      createdAt: Date.now(),
      ttlSeconds: ttl,
      metadata: req.metadata,
    };
    await this.redis
      .multi()
      .set(this.metaKey(tenantId, req.sessionId), JSON.stringify(meta), "EX", ttl)
      .sadd(this.indexKey(tenantId), req.sessionId)
      .sadd(this.tenantsKey(), tenantId)
      .exec();

    await this.audit.append({
      tenantId, runId: req.sessionId, agentId: req.createdBy,
      eventType: EventType.SESSION_START, payload: { sessionId: req.sessionId },
    });
    return (await this.get(tenantId, req.sessionId))!;
  }

  async join(tenantId: string, sessionId: string, agentId: string): Promise<Session> {
    const meta = await this.readMeta(tenantId, sessionId);
    if (!meta) throw new EngineError("SESSION_NOT_FOUND", "Session not found.", 404);

    const cap = config.SPANOAI_MAX_AGENTS_PER_SESSION;
    if (cap > 0) {
      const isMember = await this.redis.sismember(this.membersKey(tenantId, sessionId), agentId);
      if (!isMember) {
        const count = await this.redis.scard(this.membersKey(tenantId, sessionId));
        if (count >= cap) {
          throw new EngineError("AGENT_LIMIT_EXCEEDED", `Session is at its agent limit (${cap}).`, 429);
        }
      }
    }

    await this.redis.sadd(this.membersKey(tenantId, sessionId), agentId);
    await this.refreshTtl(tenantId, sessionId, meta.ttlSeconds);
    await this.audit.append({
      tenantId, runId: sessionId, agentId,
      eventType: EventType.AGENT_JOIN, payload: { sessionId, agentId },
    });
    return (await this.get(tenantId, sessionId))!;
  }

  async leave(tenantId: string, sessionId: string, agentId: string): Promise<void> {
    await this.redis.srem(this.membersKey(tenantId, sessionId), agentId);
    await this.audit.append({
      tenantId, runId: sessionId, agentId,
      eventType: EventType.AGENT_LEAVE, payload: { sessionId, agentId },
    });
  }

  async get(tenantId: string, sessionId: string): Promise<Session | null> {
    const meta = await this.readMeta(tenantId, sessionId);
    if (!meta) return null;
    const [members, aborted] = await Promise.all([
      this.redis.smembers(this.membersKey(tenantId, sessionId)),
      this.redis.exists(this.abortKey(tenantId, sessionId)),
    ]);
    return { ...meta, members, aborted: aborted === 1 };
  }

  async list(tenantId: string): Promise<Session[]> {
    const ids = await this.redis.smembers(this.indexKey(tenantId));
    const sessions = await Promise.all(ids.map((id) => this.get(tenantId, id)));
    // Prune index entries whose session has expired.
    const stale = ids.filter((_, i) => sessions[i] === null);
    if (stale.length > 0) await this.redis.srem(this.indexKey(tenantId), ...stale);
    return sessions.filter((s): s is Session => s !== null);
  }

  async end(tenantId: string, sessionId: string, byAgent: string): Promise<void> {
    const meta = await this.readMeta(tenantId, sessionId);
    await this.audit.append({
      tenantId, runId: sessionId, agentId: byAgent,
      eventType: EventType.SESSION_END,
      payload: { sessionId, existed: meta !== null },
    });
    await this.redis
      .multi()
      .del(this.metaKey(tenantId, sessionId))
      .del(this.membersKey(tenantId, sessionId))
      .del(this.abortKey(tenantId, sessionId))
      .srem(this.indexKey(tenantId), sessionId)
      .exec();
  }

  /**
   * Register the session if it doesn't exist (so writes auto-surface a run in
   * /sessions), or refresh its TTL if it does (activity keep-alive). Cheap:
   * one SET NX, plus a one-time SESSION_START on first creation.
   */
  async touch(tenantId: string, sessionId: string, byAgent: string): Promise<void> {
    const ttl = config.SPANOAI_SESSION_TTL_SECONDS;
    const meta: SessionMeta = {
      sessionId,
      tenantId,
      createdBy: byAgent,
      status: SessionStatus.ACTIVE,
      createdAt: Date.now(),
      ttlSeconds: ttl,
      metadata: {},
    };
    const created = await this.redis.set(
      this.metaKey(tenantId, sessionId),
      JSON.stringify(meta),
      "EX",
      ttl,
      "NX",
    );
    if (created) {
      await this.redis
        .multi()
        .sadd(this.indexKey(tenantId), sessionId)
        .sadd(this.tenantsKey(), tenantId)
        .exec();
      await this.audit.append({
        tenantId,
        runId: sessionId,
        agentId: byAgent,
        eventType: EventType.SESSION_START,
        payload: { sessionId, auto: true },
      });
    } else {
      await this.redis.expire(this.metaKey(tenantId, sessionId), ttl);
    }
  }

  /** Signal cancellation; agents should observe this and stop in-flight work. */
  async abort(tenantId: string, sessionId: string, ttlSeconds?: number): Promise<void> {
    const meta = await this.readMeta(tenantId, sessionId);
    const ttl = ttlSeconds ?? meta?.ttlSeconds ?? config.SPANOAI_SESSION_TTL_SECONDS;
    await this.redis.set(this.abortKey(tenantId, sessionId), "1", "EX", ttl);
  }

  async isAborted(tenantId: string, sessionId: string): Promise<boolean> {
    return (await this.redis.exists(this.abortKey(tenantId, sessionId))) === 1;
  }

  /** Reconcile session indexes: drop ids whose TTL'd meta has expired. */
  async cleanupExpired(): Promise<number> {
    const tenants = await this.redis.smembers(this.tenantsKey());
    let cleaned = 0;
    for (const tenantId of tenants) {
      const ids = await this.redis.smembers(this.indexKey(tenantId));
      for (const sessionId of ids) {
        if ((await this.redis.exists(this.metaKey(tenantId, sessionId))) === 0) {
          await this.redis.srem(this.indexKey(tenantId), sessionId);
          await this.audit.append({
            tenantId, runId: sessionId, agentId: "system",
            eventType: EventType.SESSION_END,
            payload: { sessionId, reason: "expired" },
          });
          cleaned += 1;
        }
      }
    }
    return cleaned;
  }

  private async readMeta(tenantId: string, sessionId: string): Promise<SessionMeta | null> {
    const raw = await this.redis.get(this.metaKey(tenantId, sessionId));
    return raw ? (JSON.parse(raw) as SessionMeta) : null;
  }

  private async refreshTtl(tenantId: string, sessionId: string, ttl: number): Promise<void> {
    await Promise.all([
      this.redis.expire(this.metaKey(tenantId, sessionId), ttl),
      this.redis.expire(this.membersKey(tenantId, sessionId), ttl),
    ]);
  }
}
