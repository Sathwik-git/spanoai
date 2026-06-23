/**
 * Replay + diff over the durable audit trail.
 *
 * Replay yields a run's entries in canonical `step` order. Diff aligns two runs
 * step-by-step and reports the first point at which their event signatures
 * (eventType + agentId) diverge — useful for debugging "why did run B behave
 * differently from run A?".
 */
import type { AuditBackend } from "../backends/interfaces";
import type { AuditEntry } from "../models/audit-entry";

export interface RunDifference {
  step: number;
  a: AuditEntry | null;
  b: AuditEntry | null;
}

export interface RunDiff {
  runA: string;
  runB: string;
  /** First step at which the runs diverge, or null if structurally identical. */
  divergedAtStep: number | null;
  differences: RunDifference[];
}

function sameSignature(a: AuditEntry | null, b: AuditEntry | null): boolean {
  if (a === null || b === null) return false;
  return a.eventType === b.eventType && a.agentId === b.agentId;
}

export class ReplayEngine {
  constructor(private readonly backend: AuditBackend) {}

  /** Stream a run's entries in durable step order. */
  async *replay(tenantId: string, runId: string): AsyncGenerator<AuditEntry> {
    const entries = await this.backend.getByRun(tenantId, runId);
    for (const entry of entries) yield entry;
  }

  /** Materialise the whole trail (convenience over `replay`). */
  async trail(tenantId: string, runId: string): Promise<AuditEntry[]> {
    return this.backend.getByRun(tenantId, runId);
  }

  async diff(tenantId: string, runA: string, runB: string): Promise<RunDiff> {
    const [a, b] = await Promise.all([
      this.backend.getByRun(tenantId, runA),
      this.backend.getByRun(tenantId, runB),
    ]);

    const max = Math.max(a.length, b.length);
    const differences: RunDifference[] = [];
    let divergedAtStep: number | null = null;

    for (let i = 0; i < max; i++) {
      const ea = a[i] ?? null;
      const eb = b[i] ?? null;
      if (!sameSignature(ea, eb)) {
        const step = ea?.step ?? eb?.step ?? i + 1;
        if (divergedAtStep === null) divergedAtStep = step;
        differences.push({ step, a: ea, b: eb });
      }
    }

    return { runA, runB, divergedAtStep, differences };
  }
}
