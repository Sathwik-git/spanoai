/**
 * StreamScheduler — drives reclaim sweeps over agent inboxes.
 *
 * A background job discovers active {tenant, session, agent} inboxes and asks
 * the scheduler to sweep them. The scheduler delegates the durable work (XAUTO-
 * CLAIM, retry, DLQ) to MessageBus.sweep, applying the configured visibility
 * timeout, and aggregates the results.
 */
import { config } from "../config";
import type { ReclaimReport } from "../backends/interfaces";
import type { MessageBus, SweepTarget } from "./index";

export interface SweepSummary {
  targets: number;
  reclaimed: number;
  retried: number;
  deadLettered: number;
}

export class StreamScheduler {
  constructor(
    private readonly bus: MessageBus,
    private readonly minIdleMs: number = config.SPANOAI_VISIBILITY_TIMEOUT_MS,
  ) {}

  /** Sweep a single inbox. */
  sweep(target: SweepTarget): Promise<ReclaimReport> {
    return this.bus.sweep(target, this.minIdleMs);
  }

  /** Sweep many inboxes, returning an aggregate summary. */
  async sweepAll(targets: SweepTarget[]): Promise<SweepSummary> {
    const summary: SweepSummary = {
      targets: targets.length,
      reclaimed: 0,
      retried: 0,
      deadLettered: 0,
    };

    for (const target of targets) {
      const report = await this.sweep(target);
      summary.reclaimed += report.reclaimed;
      summary.retried += report.retried.length;
      summary.deadLettered += report.deadLettered.length;
    }

    return summary;
  }
}
