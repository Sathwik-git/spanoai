/**
 * Vector clocks for causal ordering between agents.
 *
 * A clock maps `agentId -> logical counter`. All operations are pure and
 * immutable. These capture *causality* (who-knew-what-when); the durable,
 * total replay order is the Postgres `step`, not the clock.
 */
import type { Clock } from "../models/audit-entry";

export type ClockComparison = "before" | "after" | "equal" | "concurrent";

export const VectorClock = {
  /** Increment one agent's component, returning a new clock. */
  tick(clock: Clock, agentId: string): Clock {
    return { ...clock, [agentId]: (clock[agentId] ?? 0) + 1 };
  },

  /** Component-wise maximum of two clocks (what a receiver knows after merge). */
  merge(a: Clock, b: Clock): Clock {
    const out: Clock = { ...a };
    for (const [agent, count] of Object.entries(b)) {
      out[agent] = Math.max(out[agent] ?? 0, count);
    }
    return out;
  },

  /** True iff `a` causally happened-before `b` (a <= b and a != b). */
  happenedBefore(a: Clock, b: Clock): boolean {
    let strictlyLess = false;
    for (const agent of allAgents(a, b)) {
      const av = a[agent] ?? 0;
      const bv = b[agent] ?? 0;
      if (av > bv) return false;
      if (av < bv) strictlyLess = true;
    }
    return strictlyLess;
  },

  equal(a: Clock, b: Clock): boolean {
    for (const agent of allAgents(a, b)) {
      if ((a[agent] ?? 0) !== (b[agent] ?? 0)) return false;
    }
    return true;
  },

  compare(a: Clock, b: Clock): ClockComparison {
    if (VectorClock.equal(a, b)) return "equal";
    if (VectorClock.happenedBefore(a, b)) return "before";
    if (VectorClock.happenedBefore(b, a)) return "after";
    return "concurrent";
  },
} as const;

function allAgents(a: Clock, b: Clock): Set<string> {
  return new Set([...Object.keys(a), ...Object.keys(b)]);
}
