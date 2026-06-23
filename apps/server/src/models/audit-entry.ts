/**
 * Audit Log data model.
 *
 * Every meaningful state change appends an immutable `AuditEntry`. `step` is a
 * durable, strictly-increasing per-(tenant, run) sequence allocated in Postgres
 * — it is the canonical replay order. `clock` is a vector clock capturing
 * causal (happened-before) relationships between agents.
 */
import { z } from "zod";

export const EventType = {
  // Context store
  CTX_WRITE: "CTX_WRITE",
  CTX_READ: "CTX_READ",
  CTX_DELETE: "CTX_DELETE",
  CTX_CONFLICT: "CTX_CONFLICT",
  CTX_STALE: "CTX_STALE",
  CTX_SEARCH: "CTX_SEARCH",
  // Message bus
  MSG_DISPATCHED: "MSG_DISPATCHED",
  MSG_DELIVERED: "MSG_DELIVERED",
  MSG_REPLIED: "MSG_REPLIED",
  MSG_TIMEOUT: "MSG_TIMEOUT",
  MSG_RETRY: "MSG_RETRY",
  MSG_DEAD_LETTER: "MSG_DEAD_LETTER",
  MSG_ESCALATED: "MSG_ESCALATED",
  // Artifacts
  ARTIFACT_CREATED: "ARTIFACT_CREATED",
  ARTIFACT_AVAILABLE: "ARTIFACT_AVAILABLE",
  ARTIFACT_QUARANTINED: "ARTIFACT_QUARANTINED",
  ARTIFACT_REJECTED: "ARTIFACT_REJECTED",
  ARTIFACT_DELETED: "ARTIFACT_DELETED",
  // Lifecycle
  SESSION_START: "SESSION_START",
  SESSION_END: "SESSION_END",
  AGENT_JOIN: "AGENT_JOIN",
  AGENT_LEAVE: "AGENT_LEAVE",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];
export const EventTypeSchema = z.enum(EventType);

/** A vector clock: agentId -> logical counter. */
export const VectorClockSchema = z.record(z.string(), z.number().int());
export type Clock = z.infer<typeof VectorClockSchema>;

export const AuditEntrySchema = z.object({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  tenantId: z.string(),
  runId: z.string(),
  step: z.number().int().nonnegative(),
  parentId: z.string().optional(),
  clock: VectorClockSchema,
  eventType: EventTypeSchema,
  agentId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  /** Epoch milliseconds. */
  ts: z.number().int().default(() => Date.now()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/**
 * What callers pass to `AuditLog.append`. The engine assigns `step` (Postgres)
 * and `clock` (vector clock), so callers never manage either.
 */
export interface AuditAppendInput {
  tenantId: string;
  runId: string;
  agentId: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  parentId?: string;
  /** Override the generated id (rarely needed; useful for tests). */
  id?: string;
  /** Override the timestamp (rarely needed; useful for tests). */
  ts?: number;
}

/** A signed, self-describing export of an entire run's audit trail. */
export interface ComplianceExport {
  version: string;
  tenantId: string;
  runId: string;
  exportedAt: string;
  entryCount: number;
  entries: AuditEntry[];
  sha256: string;
}
