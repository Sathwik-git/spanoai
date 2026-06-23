/**
 * Background jobs. Each runs on an interval and is wrapped so a failure in one
 * tick is logged and never crashes the loop:
 *   - sweeper           reclaims stuck (claimed-but-unacked) stream messages
 *   - session-cleaner   reconciles session indexes after TTL expiry
 *   - artifact-retention deletes bytes + tombstones expired artifacts
 */
import { config } from "../config";
import type { BusBackend } from "../backends/interfaces";
import type { StreamScheduler } from "../message-bus";
import type { SessionService } from "../sessions";
import type { ArtifactService } from "../artifacts";
import type { AuditLog } from "../audit-log";

export interface BackgroundJobsDeps {
  scheduler: StreamScheduler;
  busBackend: BusBackend;
  sessions: SessionService;
  artifacts: ArtifactService;
  audit: AuditLog;
  onError?: (where: string, err: unknown) => void;
}

export function startBackgroundJobs(deps: BackgroundJobsDeps): () => void {
  const onError =
    deps.onError ?? ((where, err) => console.error(`[jobs:${where}]`, err));
  const timers: ReturnType<typeof setInterval>[] = [];

  const every = (ms: number, where: string, fn: () => Promise<unknown>) => {
    timers.push(
      setInterval(() => {
        void fn().catch((err) => onError(where, err));
      }, ms),
    );
  };

  every(config.SPANOAI_SWEEP_INTERVAL_MS, "sweeper", async () => {
    const inboxes = await deps.busBackend.listInboxes();
    if (inboxes.length > 0) await deps.scheduler.sweepAll(inboxes);
  });

  every(config.SPANOAI_SESSION_CLEAN_INTERVAL_MS, "session-cleaner", () =>
    deps.sessions.cleanupExpired(),
  );

  every(config.SPANOAI_ARTIFACT_RETENTION_INTERVAL_MS, "artifact-retention", () =>
    deps.artifacts.runRetention(),
  );

  every(config.SPANOAI_AUDIT_DRAIN_INTERVAL_MS, "audit-drain", () =>
    deps.audit.drainRetries(),
  );

  return () => {
    for (const t of timers) clearInterval(t);
  };
}
