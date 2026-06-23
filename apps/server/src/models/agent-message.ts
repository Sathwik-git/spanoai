/**
 * Message Bus data model.
 *
 * Messages are durable work items, not chat events. They carry structured
 * payloads (text / JSON / artifact references), a reply schema, priority, and
 * at-least-once delivery metadata (operationId, retryCount, maxRetries).
 */
import { z } from "zod";
import { ArtifactRefSchema, SAFE_ID } from "./context-entry";

// Agent ids compose Redis stream keys and the `tid|sid|agent` inbox registry,
// so they must be sanitised exactly like sessionId/namespace/key (no ':' / '|'
// / spaces) to prevent key/registry corruption.
const agentId = z.string().regex(SAFE_ID, "agent id must match the safe-id charset");

export const OnTimeout = {
  RETRY: "retry",
  SKIP: "skip",
  ESCALATE: "escalate_human",
  DEAD_LETTER: "dead_letter",
} as const;
export type OnTimeout = (typeof OnTimeout)[keyof typeof OnTimeout];
export const OnTimeoutSchema = z.enum(OnTimeout);

export const MessageStatusSchema = z.enum([
  "queued",
  "claimed",
  "replied",
  "timed_out",
  "dead_letter",
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/** 1 = lowest, 5 = highest. Higher-priority inboxes are drained first. */
export const PrioritySchema = z.number().int().min(1).max(5);
export type Priority = z.infer<typeof PrioritySchema>;

export const AgentMessagePayloadSchema = z.object({
  text: z.string().optional(),
  data: z.unknown().optional(),
  artifacts: z.array(ArtifactRefSchema).default([]),
});
export type AgentMessagePayload = z.infer<typeof AgentMessagePayloadSchema>;
export type AgentMessagePayloadInput = z.input<typeof AgentMessagePayloadSchema>;

export const AgentMessageSchema = z.object({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  tenantId: z.string(),
  sessionId: z.string(),
  traceId: z.string().min(1).default(() => crypto.randomUUID()),
  fromAgent: agentId,
  toAgent: agentId,
  intent: z.string(),
  priority: PrioritySchema.default(3),
  payload: AgentMessagePayloadSchema,
  replySchema: z.record(z.string(), z.unknown()).optional(),
  replyTo: z.string().optional(),
  /** Epoch milliseconds. */
  createdAt: z.number().int().default(() => Date.now()),
  timeoutMs: z.number().int().positive().default(30_000),
  onTimeout: OnTimeoutSchema.default(OnTimeout.DEAD_LETTER),
  /** Idempotency key — surfaced to consumers so duplicates can be ignored. */
  operationId: z.string().min(1).default(() => crypto.randomUUID()),
  retryCount: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().nonnegative().default(3),
  status: MessageStatusSchema.default("queued"),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
/** Pre-default shape callers may pass to dispatch (id/traceId/etc. optional). */
export type AgentMessageInput = z.input<typeof AgentMessageSchema>;

/** True once a message has outlived its timeout from `createdAt`. */
export const isExpired = (msg: AgentMessage, now: number = Date.now()): boolean =>
  now - msg.createdAt > msg.timeoutMs;
