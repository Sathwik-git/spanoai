/**
 * Context Store data model.
 *
 * A `ContextEntry` is the resolved, versioned record stored for a key. A
 * `ContextWriteRequest` is what a caller submits; the engine derives the
 * stored entry from it (assigning `version`, `writtenAt`, resolving conflicts).
 *
 * `writtenAt` is epoch milliseconds (a number, not a Date) so the value
 * round-trips losslessly through Redis Lua / JSON without timezone surprises.
 */
import { z } from "zod";

/**
 * Identifiers that compose Redis keys must be sanitised so they cannot inject
 * the `:` delimiter and cross key boundaries. Dots are allowed (namespacing);
 * colons are not.
 */
export const SAFE_ID = /^[A-Za-z0-9_.\-]{1,256}$/;
const safeId = (label: string) =>
  z
    .string()
    .regex(SAFE_ID, `${label} must match ${SAFE_ID} (no ':' or spaces)`);

export const ConflictStrategy = {
  LAST_WRITE_WINS: "lww",
  HIGHEST_CONFIDENCE: "conf",
  MERGE: "merge",
  REJECT_IF_EXISTS: "reject",
} as const;
export type ConflictStrategy =
  (typeof ConflictStrategy)[keyof typeof ConflictStrategy];
export const ConflictStrategySchema = z.enum(ConflictStrategy);

export const ArtifactKindSchema = z.enum([
  "file",
  "image",
  "audio",
  "video",
  "json",
  "table",
  "diff",
  "report",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** Reference to a large output stored in object storage (never inline). */
export const ArtifactRefSchema = z.object({
  id: z.string().min(1),
  kind: ArtifactKindSchema,
  uri: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  name: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/** A context value is one of: inline text, inline JSON, or artifact reference(s). */
export const ContextValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("json"), data: z.unknown() }),
  z.object({ type: z.literal("artifact"), artifact: ArtifactRefSchema }),
  z.object({ type: z.literal("artifacts"), artifacts: z.array(ArtifactRefSchema) }),
]);
export type ContextValue = z.infer<typeof ContextValueSchema>;

/** The resolved, stored record for a key at a given version. */
export const ContextEntrySchema = z.object({
  tenantId: z.string(),
  sessionId: z.string(),
  namespace: z.string(),
  key: z.string(),
  fullKey: z.string(),
  value: ContextValueSchema,
  writtenBy: z.string(),
  /** Epoch milliseconds. */
  writtenAt: z.number().int(),
  version: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  ttlSeconds: z.number().int().nonnegative(),
  isDeleted: z.boolean(),
  conflictStrategy: ConflictStrategySchema,
  /** The operationId that produced this version (for idempotency tracing). */
  operationId: z.string(),
});
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

/** What a caller submits to write a key. */
export const ContextWriteRequestSchema = z.object({
  sessionId: safeId("sessionId"),
  namespace: safeId("namespace"),
  key: safeId("key"),
  value: ContextValueSchema,
  writtenBy: z.string().min(1),
  /** Idempotency key. SDKs generate this client-side before retrying. */
  operationId: z.string().min(1).default(() => crypto.randomUUID()),
  /** Optional optimistic-concurrency guard (CAS). */
  expectedVersion: z.number().int().nonnegative().optional(),
  conflictStrategy: ConflictStrategySchema.default(ConflictStrategy.LAST_WRITE_WINS),
  confidence: z.number().min(0).max(1).default(1),
  ttlSeconds: z.number().int().nonnegative().default(0),
  tags: z.array(z.string()).default([]),
  /** Permit overwriting a soft-deleted key (requires matching expectedVersion). */
  allowRestore: z.boolean().default(false),
});
export type ContextWriteRequest = z.infer<typeof ContextWriteRequestSchema>;
/** Pre-default shape callers may pass (operationId, defaults, etc. optional). */
export type ContextWriteRequestInput = z.input<typeof ContextWriteRequestSchema>;

/** What a caller submits to soft-delete a key. */
export const ContextDeleteRequestSchema = z.object({
  sessionId: safeId("sessionId"),
  namespace: safeId("namespace"),
  key: safeId("key"),
  deletedBy: z.string().min(1),
  operationId: z.string().min(1).default(() => crypto.randomUUID()),
  expectedVersion: z.number().int().nonnegative().optional(),
});
export type ContextDeleteRequest = z.infer<typeof ContextDeleteRequestSchema>;
export type ContextDeleteRequestInput = z.input<typeof ContextDeleteRequestSchema>;

/** Atomically append items to a list-valued key (concurrency-safe accumulate). */
export const ContextAppendRequestSchema = z.object({
  sessionId: safeId("sessionId"),
  namespace: safeId("namespace"),
  key: safeId("key"),
  items: z.array(z.unknown()).min(1),
  writtenBy: z.string().min(1),
  operationId: z.string().min(1).default(() => crypto.randomUUID()),
  ttlSeconds: z.number().int().nonnegative().default(0),
  tags: z.array(z.string()).default([]),
  /** Keep only the most recent N items (0 = unbounded). */
  maxItems: z.number().int().nonnegative().default(0),
});
export type ContextAppendRequest = z.infer<typeof ContextAppendRequestSchema>;
export type ContextAppendRequestInput = z.input<typeof ContextAppendRequestSchema>;

/** Atomically add to a numeric key (concurrency-safe counter). */
export const ContextIncrementRequestSchema = z.object({
  sessionId: safeId("sessionId"),
  namespace: safeId("namespace"),
  key: safeId("key"),
  by: z.number().default(1),
  writtenBy: z.string().min(1),
  operationId: z.string().min(1).default(() => crypto.randomUUID()),
  ttlSeconds: z.number().int().nonnegative().default(0),
});
export type ContextIncrementRequest = z.infer<typeof ContextIncrementRequestSchema>;
export type ContextIncrementRequestInput = z.input<
  typeof ContextIncrementRequestSchema
>;

/** `namespace.key` — the addressable identity of an entry within a session. */
export const makeFullKey = (namespace: string, key: string): string =>
  `${namespace}.${key}`;

/** True if a TTL'd entry has aged past its TTL (belt-and-suspenders vs EXPIRE). */
export const isStale = (entry: ContextEntry, now: number = Date.now()): boolean => {
  if (entry.ttlSeconds === 0) return false;
  return (now - entry.writtenAt) / 1000 > entry.ttlSeconds;
};
