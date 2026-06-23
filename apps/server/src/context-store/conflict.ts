/**
 * Conflict resolution — reference semantics.
 *
 * The AUTHORITATIVE, race-free implementation lives in the Redis Lua script
 * (see backends/redis-store.ts), which is the only place writes are actually
 * resolved. This pure function mirrors that decision logic so it can be unit
 * tested in isolation and serves as executable documentation of the four
 * strategies. Keep the two in sync.
 */
import {
  type ContextEntry,
  type ContextValue,
  type ConflictStrategy,
  ConflictStrategy as Strategy,
} from "../models/context-entry";

export interface ConflictInput {
  value: ContextValue;
  confidence: number;
  conflictStrategy: ConflictStrategy;
  isDelete: boolean;
}

export type ConflictDecision =
  | { winner: "incoming"; value: ContextValue }
  | { winner: "existing"; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shallow merge: overlay keys onto base; arrays/scalars replace wholesale. */
export function shallowMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...overlay };
}

/**
 * Decide the winner of a write against the current entry.
 *
 * @param existing  current live entry, or null if the key is empty/deleted
 * @param incoming  the proposed write
 * @param expectedVersionProvided  whether the caller supplied an expectedVersion
 *        that already matched (CAS) — lets `conf` accept an equal-confidence write
 */
export function resolveConflict(
  existing: ContextEntry | null,
  incoming: ConflictInput,
  expectedVersionProvided: boolean,
): ConflictDecision {
  // No live entry, or this is a delete: incoming always wins.
  if (existing === null || existing.isDeleted || incoming.isDelete) {
    return { winner: "incoming", value: incoming.value };
  }

  switch (incoming.conflictStrategy) {
    case Strategy.REJECT_IF_EXISTS:
      return { winner: "existing", reason: "exists" };

    case Strategy.HIGHEST_CONFIDENCE:
      if (incoming.confidence > existing.confidence || expectedVersionProvided) {
        return { winner: "incoming", value: incoming.value };
      }
      return { winner: "existing", reason: "lower_or_equal_confidence" };

    case Strategy.MERGE: {
      if (
        existing.value.type === "json" &&
        incoming.value.type === "json" &&
        isPlainObject(existing.value.data) &&
        isPlainObject(incoming.value.data)
      ) {
        return {
          winner: "incoming",
          value: {
            type: "json",
            data: shallowMerge(existing.value.data, incoming.value.data),
          },
        };
      }
      // Non-object JSON falls back to last-write-wins.
      return { winner: "incoming", value: incoming.value };
    }

    case Strategy.LAST_WRITE_WINS:
    default:
      return { winner: "incoming", value: incoming.value };
  }
}
