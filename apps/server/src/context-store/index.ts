/**
 * ContextStore — the public Context Store facade.
 *
 * Responsibilities layered on top of the StorageBackend:
 *   - validate + apply defaults to incoming requests (Zod),
 *   - durably append an audit entry for every state change (source of truth),
 *   - emit a best-effort live broadcast (never blocks, errors swallowed).
 *
 * `runId` defaults to `sessionId` (a session is one run in the MVP), but may be
 * passed explicitly when a run spans/forks sessions.
 */
import type {
  StorageBackend,
  ContextWriteResult,
  EventBroadcaster,
  RoomSubscriber,
  BroadcastEvent,
  SessionToucher,
} from "../backends/interfaces";
import type { AuditLog } from "../audit-log";
import { config } from "../config";
import { EngineError } from "../errors";
import { assertInlineSize } from "../limits";
import {
  Scope,
  requireTenant,
  requireScope,
  requireNamespace,
  namespaceAllowed,
  namespaceOf,
  type AgentPrincipal,
} from "../auth/principal";
import {
  ContextWriteRequestSchema,
  ContextDeleteRequestSchema,
  ContextAppendRequestSchema,
  ContextIncrementRequestSchema,
  makeFullKey,
  type ContextEntry,
  type ContextValue,
  type ContextWriteRequestInput,
  type ContextDeleteRequestInput,
  type ContextAppendRequestInput,
  type ContextIncrementRequestInput,
} from "../models/context-entry";
import type { Embedder } from "../search/embedder";
import type { PgVectorSearch } from "../backends/pgvector-search";

/** Extract searchable text from a context value for embedding. */
function searchableText(value: ContextValue): string {
  switch (value.type) {
    case "text":
      return value.text;
    case "json":
      return JSON.stringify(value.data);
    case "artifact":
      return value.artifact.name ?? "";
    case "artifacts":
      return value.artifacts.map((a) => a.name ?? "").join(" ");
  }
}
import { EventType } from "../models/audit-entry";

export class ContextStore {
  constructor(
    private readonly storage: StorageBackend,
    private readonly audit: AuditLog,
    private readonly broadcaster: EventBroadcaster,
    private readonly embedder?: Embedder,
    private readonly searchBackend?: PgVectorSearch,
    private readonly maxEntriesPerSession: number = config.SPANOAI_MAX_ENTRIES_PER_SESSION,
    private readonly sessions?: SessionToucher,
  ) {}

  async write(
    tenantId: string,
    input: ContextWriteRequestInput,
    runId?: string,
    principal?: AgentPrincipal,
  ): Promise<ContextWriteResult> {
    const req = ContextWriteRequestSchema.parse(input);
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.CONTEXT_WRITE);
    requireNamespace(principal, req.namespace);
    // Claim-check guard: anything too big to live inline must be an artifact.
    assertInlineSize(req.value, "context value");
    await this.assertEntryCap(tenantId, req.sessionId, req.namespace, req.key);
    const result = await this.storage.write(tenantId, req, Date.now());
    await this.touch(tenantId, req.sessionId, req.writtenBy);

    // Idempotent replays must not append a second audit entry or re-broadcast.
    if (!result.idempotentReplay) {
      const fullKey = makeFullKey(req.namespace, req.key);
      const eventType =
        result.outcome === "written"
          ? EventType.CTX_WRITE
          : EventType.CTX_CONFLICT;

      await this.audit.append({
        tenantId,
        runId: runId ?? req.sessionId,
        agentId: req.writtenBy,
        eventType,
        payload: {
          fullKey,
          namespace: req.namespace,
          key: req.key,
          version: result.version,
          outcome: result.outcome,
          conflictStrategy: req.conflictStrategy,
          operationId: req.operationId,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        },
      });

      this.emit(tenantId, req.sessionId, {
        event: eventType,
        fullKey,
        version: result.version,
        writtenBy: req.writtenBy,
        outcome: result.outcome,
      });
    }

    this.maybeIndex(tenantId, req.sessionId, result);
    return result;
  }

  async delete(
    tenantId: string,
    input: ContextDeleteRequestInput,
    runId?: string,
    principal?: AgentPrincipal,
  ): Promise<ContextWriteResult> {
    const req = ContextDeleteRequestSchema.parse(input);
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.CONTEXT_WRITE);
    requireNamespace(principal, req.namespace);
    const result = await this.storage.delete(tenantId, req, Date.now());

    if (result.outcome === "deleted" && !result.idempotentReplay) {
      const fullKey = makeFullKey(req.namespace, req.key);
      await this.audit.append({
        tenantId,
        runId: runId ?? req.sessionId,
        agentId: req.deletedBy,
        eventType: EventType.CTX_DELETE,
        payload: { fullKey, version: result.version, operationId: req.operationId },
      });
      this.emit(tenantId, req.sessionId, {
        event: EventType.CTX_DELETE,
        fullKey,
        version: result.version,
        deletedBy: req.deletedBy,
      });
    }

    return result;
  }

  /** Concurrency-safe accumulate: append items to a list key (no lost updates). */
  async append(
    tenantId: string,
    input: ContextAppendRequestInput,
    runId?: string,
    principal?: AgentPrincipal,
  ): Promise<ContextWriteResult> {
    const req = ContextAppendRequestSchema.parse(input);
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.CONTEXT_WRITE);
    requireNamespace(principal, req.namespace);
    assertInlineSize(req.items, "appended items");
    await this.assertEntryCap(tenantId, req.sessionId, req.namespace, req.key);
    const result = await this.storage.append(tenantId, req, Date.now());
    await this.touch(tenantId, req.sessionId, req.writtenBy);
    await this.recordMutation(tenantId, req.sessionId, runId ?? req.sessionId, req.writtenBy, req.namespace, req.key, result, "append");
    this.maybeIndex(tenantId, req.sessionId, result);
    return result;
  }

  /** Concurrency-safe counter: atomically add to a numeric key. */
  async increment(
    tenantId: string,
    input: ContextIncrementRequestInput,
    runId?: string,
    principal?: AgentPrincipal,
  ): Promise<ContextWriteResult> {
    const req = ContextIncrementRequestSchema.parse(input);
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.CONTEXT_WRITE);
    requireNamespace(principal, req.namespace);
    const result = await this.storage.increment(tenantId, req, Date.now());
    await this.touch(tenantId, req.sessionId, req.writtenBy);
    await this.recordMutation(tenantId, req.sessionId, runId ?? req.sessionId, req.writtenBy, req.namespace, req.key, result, "increment");
    return result;
  }

  async read(
    tenantId: string,
    sessionId: string,
    fullKey: string,
    opts?: { includeDeleted?: boolean },
    principal?: AgentPrincipal,
  ): Promise<ContextEntry | null> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.CONTEXT_READ);
    requireNamespace(principal, namespaceOf(fullKey));
    return this.storage.get(tenantId, sessionId, fullKey, opts);
  }

  /**
   * Block until `fullKey` satisfies `predicate` (default: exists), or until
   * `timeoutMs` elapses (returns null). Lost-wakeup-safe: subscribes to live
   * events BEFORE the first read, and always re-reads state on wake. Also polls
   * as a fallback in case a best-effort event is missed. A `predicate` enables
   * barriers, e.g. "wait until this list has >= N items".
   */
  async awaitKey(
    tenantId: string,
    sessionId: string,
    fullKey: string,
    opts?: {
      timeoutMs?: number;
      includeDeleted?: boolean;
      pollMs?: number;
      predicate?: (entry: ContextEntry | null) => boolean;
    },
  ): Promise<ContextEntry | null> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const pollMs = opts?.pollMs ?? 250;
    const predicate = opts?.predicate ?? ((e) => e !== null);
    const deadline = Date.now() + timeoutMs;

    // Subscribe FIRST (if supported) so a write between read and subscribe is
    // not lost. The handler resolves the current wake promise.
    let wake: () => void = () => {};
    let woken = new Promise<void>((r) => (wake = r));
    const sub = (this.broadcaster as Partial<RoomSubscriber>).subscribe;
    const unsubscribe =
      typeof sub === "function"
        ? await sub.call(this.broadcaster, tenantId, sessionId, (e: BroadcastEvent) => {
            if (e.fullKey === fullKey) wake();
          })
        : null;

    try {
      for (;;) {
        const entry = await this.storage.get(tenantId, sessionId, fullKey, {
          includeDeleted: opts?.includeDeleted ?? false,
        });
        if (predicate(entry)) return entry;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await Promise.race([
          woken,
          new Promise((r) => setTimeout(r, Math.min(pollMs, remaining))),
        ]);
        woken = new Promise<void>((r) => (wake = r));
      }
    } finally {
      if (unsubscribe) await unsubscribe();
    }
  }

  async list(
    tenantId: string,
    sessionId: string,
    namespace?: string,
    principal?: AgentPrincipal,
  ): Promise<ContextEntry[]> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.CONTEXT_READ);
    if (namespace !== undefined) requireNamespace(principal, namespace);
    const entries = await this.storage.list(tenantId, sessionId, namespace);
    // When the principal is namespace-restricted, never leak other namespaces.
    return entries.filter((e) => namespaceAllowed(principal, e.namespace));
  }

  async history(
    tenantId: string,
    sessionId: string,
    fullKey: string,
    principal?: AgentPrincipal,
  ): Promise<ContextEntry[]> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.CONTEXT_READ);
    requireNamespace(principal, namespaceOf(fullKey));
    return this.storage.history(tenantId, sessionId, fullKey);
  }

  /**
   * Semantic search over a session's context. `query` may be raw text (embedded
   * with the configured embedder) or a precomputed vector. Returns [] when no
   * embedder is configured. Namespace ACLs are honoured.
   */
  async search(
    tenantId: string,
    sessionId: string,
    query: string | number[],
    topK = 10,
    principal?: AgentPrincipal,
  ): Promise<ContextEntry[]> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.CONTEXT_READ);
    if (!this.embedder || !this.searchBackend) return [];

    const vec = typeof query === "string" ? await this.embedder.embed(query) : query;
    const hits = await this.searchBackend.query(tenantId, sessionId, vec, topK);
    const entries = await Promise.all(
      hits.map((h) => this.storage.get(tenantId, sessionId, h.fullKey)),
    );
    return entries.filter(
      (e): e is ContextEntry => e !== null && namespaceAllowed(principal, e.namespace),
    );
  }

  /** Embed + index a freshly written entry (fire-and-forget). */
  private maybeIndex(
    tenantId: string,
    sessionId: string,
    result: ContextWriteResult,
  ): void {
    if (!this.embedder || !this.searchBackend) return;
    if (result.outcome !== "written" || result.idempotentReplay || !result.entry) return;
    const entry = result.entry;
    const text = searchableText(entry.value);
    if (!text) return;
    const embedder = this.embedder;
    const searchBackend = this.searchBackend;
    void (async () => {
      const embedding = await embedder.embed(text);
      await searchBackend.upsert({
        tenantId,
        sessionId,
        fullKey: entry.fullKey,
        version: entry.version,
        embedding,
        ts: entry.writtenAt,
      });
    })().catch(() => {
      /* best-effort indexing; search degrades gracefully */
    });
  }

  /** Audit + broadcast for append/increment mutations (skips idempotent replays). */
  private async recordMutation(
    tenantId: string,
    sessionId: string,
    runId: string,
    agentId: string,
    namespace: string,
    key: string,
    result: ContextWriteResult,
    op: "append" | "increment",
  ): Promise<void> {
    if (result.idempotentReplay) return;
    const fullKey = makeFullKey(namespace, key);
    const eventType =
      result.outcome === "written" ? EventType.CTX_WRITE : EventType.CTX_CONFLICT;
    await this.audit.append({
      tenantId,
      runId,
      agentId,
      eventType,
      payload: {
        fullKey,
        namespace,
        key,
        op,
        version: result.version,
        outcome: result.outcome,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      },
    });
    this.emit(tenantId, sessionId, {
      event: eventType,
      fullKey,
      version: result.version,
      writtenBy: agentId,
      op,
    });
  }

  /** Register/keep-alive the session on activity (best-effort, never blocks). */
  private async touch(tenantId: string, sessionId: string, byAgent: string): Promise<void> {
    if (!this.sessions) return;
    try {
      await this.sessions.touch(tenantId, sessionId, byAgent);
    } catch {
      /* session registry is a convenience index; never fail a write over it */
    }
  }

  /** Reject creating a NEW key once a session hits its entry cap (abuse guard). */
  private async assertEntryCap(
    tenantId: string,
    sessionId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    const cap = this.maxEntriesPerSession;
    if (cap <= 0) return;
    const fullKey = makeFullKey(namespace, key);
    if (await this.storage.has(tenantId, sessionId, fullKey)) return; // existing key
    if ((await this.storage.countKeys(tenantId, sessionId)) >= cap) {
      throw new EngineError(
        "ENTRY_LIMIT_EXCEEDED",
        `Session has reached its entry limit (${cap}).`,
        429,
      );
    }
  }

  /** Fire-and-forget broadcast; live delivery is best-effort. */
  private emit(
    tenantId: string,
    sessionId: string,
    event: { event: string; [k: string]: unknown },
  ): void {
    void Promise.resolve(
      this.broadcaster.broadcast(tenantId, sessionId, event),
    ).catch(() => {
      /* live delivery is best-effort; audit log is the source of truth */
    });
  }
}

export { resolveConflict, shallowMerge } from "./conflict";
export type { ConflictDecision, ConflictInput } from "./conflict";
