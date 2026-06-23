/**
 * Backend contracts.
 *
 * Core components (ContextStore, MessageBus, AuditLog) depend ONLY on these
 * interfaces, never on a concrete Redis/Postgres class. This keeps the engine
 * testable (swap in fakes) and lets storage evolve independently.
 *
 * `tenantId` is threaded explicitly through every method — there is no ambient
 * tenant. This makes cross-tenant isolation a property the type system helps
 * enforce, rather than a convention.
 */
import type {
  ContextEntry,
  ContextWriteRequest,
  ContextDeleteRequest,
  ContextAppendRequest,
  ContextIncrementRequest,
} from "../models/context-entry";
import type { AgentMessage, Priority } from "../models/agent-message";
import type { AuditEntry, EventType } from "../models/audit-entry";
import type { Artifact, ArtifactStatus } from "../models/artifact";

// ── Context storage ──────────────────────────────────────────────────

export type ContextWriteOutcome =
  /** A new version was created (normal write). */
  | "written"
  /** A soft-delete (tombstone) version was created. */
  | "deleted"
  /** A conflict strategy kept the existing value (e.g. lower confidence). */
  | "kept_existing"
  /** `reject` strategy hit an existing key, or a deleted key was not restorable. */
  | "rejected"
  /** `expectedVersion` (CAS) did not match the current version. */
  | "conflict";

export interface ContextWriteResult {
  outcome: ContextWriteOutcome;
  /** The winning entry (existing or newly written); null only when not found. */
  entry: ContextEntry | null;
  /** Current version after the operation, or null if there is no entry. */
  version: number | null;
  /** Explanation when outcome is conflict / rejected / kept_existing. */
  reason?: string;
  /** True when this result was replayed from the idempotency cache. */
  idempotentReplay?: boolean;
}

export interface StorageBackend {
  /**
   * Atomically (server-side) check idempotency, enforce CAS, resolve the
   * conflict strategy, assign a version, and persist the winner + history.
   * `nowMs` is supplied by the caller so the operation is deterministic.
   */
  write(
    tenantId: string,
    req: ContextWriteRequest,
    nowMs: number,
  ): Promise<ContextWriteResult>;

  /** Soft-delete a key as a new version. Idempotent by operationId. */
  delete(
    tenantId: string,
    req: ContextDeleteRequest,
    nowMs: number,
  ): Promise<ContextWriteResult>;

  /** Atomically append items to a list-valued key. Idempotent by operationId. */
  append(
    tenantId: string,
    req: ContextAppendRequest,
    nowMs: number,
  ): Promise<ContextWriteResult>;

  /** Atomically add to a numeric key. Idempotent by operationId. */
  increment(
    tenantId: string,
    req: ContextIncrementRequest,
    nowMs: number,
  ): Promise<ContextWriteResult>;

  get(
    tenantId: string,
    sessionId: string,
    fullKey: string,
    opts?: { includeDeleted?: boolean },
  ): Promise<ContextEntry | null>;

  list(
    tenantId: string,
    sessionId: string,
    namespace?: string,
  ): Promise<ContextEntry[]>;

  history(
    tenantId: string,
    sessionId: string,
    fullKey: string,
  ): Promise<ContextEntry[]>;

  search(
    tenantId: string,
    sessionId: string,
    queryEmbedding: number[],
    topK: number,
  ): Promise<ContextEntry[]>;

  /** Number of distinct live keys in a session (for entry-cap enforcement). */
  countKeys(tenantId: string, sessionId: string): Promise<number>;

  /** Whether a key is already tracked in the session index. */
  has(tenantId: string, sessionId: string, fullKey: string): Promise<boolean>;
}

// ── Message bus ──────────────────────────────────────────────────────

/** Internal bookkeeping for a message, keyed by message id. */
export interface MessageMeta {
  message: AgentMessage;
  /** Redis stream entry id for the live inbox copy (for XACK). */
  streamId: string;
  priority: Priority;
  /** Consumer-group name on the inbox stream. */
  group: string;
  status: "queued" | "claimed" | "acked" | "replied" | "timed_out" | "dead_letter";
}

export interface DlqEntry {
  streamId: string;
  message: AgentMessage;
  reason: string;
  failedAt: number;
}

/** What a reclaim sweep did, with detail so the facade can audit each message. */
export interface ReclaimReport {
  reclaimed: number;
  retried: AgentMessage[];
  deadLettered: Array<{ message: AgentMessage; reason: string }>;
}

export interface BusBackend {
  /** Append to the durable inbox stream; returns the stream entry id. */
  enqueue(msg: AgentMessage): Promise<{ streamId: string }>;

  /** Claim up to `count` messages for `agentId`, highest priority first. */
  claim(
    tenantId: string,
    sessionId: string,
    agentId: string,
    consumerId: string,
    count: number,
  ): Promise<AgentMessage[]>;

  /** Acknowledge a claimed message by id. Returns false if unknown. */
  ack(tenantId: string, sessionId: string, messageId: string): Promise<boolean>;

  /** Look up message bookkeeping by id (used for reply validation). */
  getMeta(
    tenantId: string,
    sessionId: string,
    messageId: string,
  ): Promise<MessageMeta | null>;

  /** Record a reply keyed by the original message id (TTL'd) for awaitReply. */
  recordReply(reply: AgentMessage, originalId: string): Promise<void>;

  /** Read a recorded reply for an original message id, or null. */
  takeReply(
    tenantId: string,
    sessionId: string,
    originalId: string,
  ): Promise<AgentMessage | null>;

  /** Copy a message to the DLQ and acknowledge it from its inbox stream. */
  moveToDlq(
    tenantId: string,
    sessionId: string,
    msg: AgentMessage,
    reason: string,
  ): Promise<void>;

  listDlq(
    tenantId: string,
    sessionId: string,
    count: number,
  ): Promise<DlqEntry[]>;

  /** Remove one DLQ entry by its stream id. */
  removeFromDlq(
    tenantId: string,
    sessionId: string,
    streamId: string,
  ): Promise<boolean>;

  /**
   * Reclaim messages claimed-but-unacked for longer than `minIdleMs`. Each is
   * re-enqueued (retryCount + 1) until maxRetries, then dead-lettered.
   */
  reclaimStuck(
    tenantId: string,
    sessionId: string,
    agentId: string,
    minIdleMs: number,
  ): Promise<ReclaimReport>;

  /** All inboxes that have ever been written (for the background sweeper). */
  listInboxes(): Promise<
    Array<{ tenantId: string; sessionId: string; agentId: string }>
  >;

  /** Drop an inbox from the registry (e.g. once its session has ended). */
  pruneInbox(tenantId: string, sessionId: string, agentId: string): Promise<void>;
}

// ── Audit ────────────────────────────────────────────────────────────

export interface AuditQueryParams {
  tenantId: string;
  runId?: string;
  agentId?: string;
  eventType?: EventType;
  fromStep?: number;
  toStep?: number;
  fromTs?: number;
  toTs?: number;
  limit?: number;
}

export interface AuditBackend {
  /**
   * Append an entry, allocating its durable `step` transactionally per
   * (tenantId, runId). Returns the stored entry including its assigned step.
   */
  append(entry: Omit<AuditEntry, "step">): Promise<AuditEntry>;

  getByRun(tenantId: string, runId: string): Promise<AuditEntry[]>;

  query(params: AuditQueryParams): Promise<AuditEntry[]>;
}

// ── Object storage (artifact bytes) ──────────────────────────────────

export interface ObjectStat {
  size: number;
  etag: string;
  type?: string;
}

export interface ObjectStorage {
  /** Synchronous presigned PUT URL — clients upload bytes directly to storage. */
  presignPut(key: string, opts: { expiresIn: number; contentType?: string }): string;
  /** Synchronous presigned GET URL — short-lived download link. */
  presignGet(key: string, opts: { expiresIn: number; downloadName?: string }): string;
  /** HEAD the object; null if it does not exist. */
  stat(key: string): Promise<ObjectStat | null>;
  /** Read the whole object (used for checksum verification of small files). */
  bytes(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

// ── Artifact metadata store ──────────────────────────────────────────

export interface ArtifactStore {
  insert(artifact: Artifact): Promise<void>;
  getById(tenantId: string, id: string): Promise<Artifact | null>;
  /** Mark available, stamp available_at, and persist the verified checksum. */
  markAvailable(tenantId: string, id: string, sha256: string): Promise<void>;
  setStatus(tenantId: string, id: string, status: ArtifactStatus): Promise<void>;
  /** Artifacts past their expiry that still hold bytes (for retention cleanup). */
  listExpired(nowMs: number, limit: number): Promise<Artifact[]>;
}

// ── Live broadcast (decouples core components from the WS layer) ──────

export interface BroadcastEvent {
  event: string;
  [key: string]: unknown;
}

export interface EventBroadcaster {
  /**
   * Deliver an event to a {tenant, session} room. Return value is ignored by
   * core components (best-effort), so implementations may return the enriched
   * event (e.g. with a seq) or nothing.
   */
  broadcast(
    tenantId: string,
    sessionId: string,
    event: BroadcastEvent,
  ): Promise<unknown> | void;
}

/**
 * Optional capability: register-or-keep-alive a session on activity, so a run
 * that only ever had context/message writes still appears in /sessions. Lets
 * core components keep sessions in sync without a hard dependency on
 * SessionService (which depends on them).
 */
export interface SessionToucher {
  touch(tenantId: string, sessionId: string, byAgent: string): Promise<void>;
}

/** Optional capability: subscribe to a room's live events (used by awaitKey). */
export interface RoomSubscriber {
  subscribe(
    tenantId: string,
    sessionId: string,
    handler: (event: BroadcastEvent) => void,
  ): Promise<() => Promise<void>>;
}
