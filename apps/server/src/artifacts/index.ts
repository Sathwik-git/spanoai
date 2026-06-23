/**
 * ArtifactService — the file lifecycle facade.
 *
 *   initUpload  → create a pending record + a presigned PUT URL (client uploads
 *                 bytes DIRECTLY to object storage; bytes never touch the API).
 *   complete    → HEAD the object, verify size (always) and sha256 (for files
 *                 within the verify limit), run an optional quarantine scan,
 *                 then mark it available.
 *   getMetadata → tenant/session-scoped lookup (no URL).
 *   downloadUrl → short-lived presigned GET, only for available artifacts.
 *   delete      → soft-delete + remove the bytes.
 *
 * Access is scoped to {tenant, session}: a wrong tenant or wrong session is a
 * 404 (no existence leak). Per-agent ACLs are a route-layer concern.
 */
import { config } from "../config";
import { EngineError } from "../errors";
import { safeFileName } from "../limits";
import type {
  ObjectStorage,
  ArtifactStore,
  EventBroadcaster,
} from "../backends/interfaces";
import { buildStorageKey } from "../backends/postgres-artifacts";
import type { AuditLog } from "../audit-log";
import { EventType } from "../models/audit-entry";
import {
  Scope,
  requireTenant,
  requireScope,
  type AgentPrincipal,
} from "../auth/principal";
import {
  ArtifactStatus,
  InitUploadRequestSchema,
  CompleteUploadRequestSchema,
  type Artifact,
  type InitUploadRequestInput,
  type InitUploadResult,
  type CompleteUploadRequestInput,
  type DownloadGrant,
} from "../models/artifact";
import type { ArtifactRef } from "../models/context-entry";

/** Pluggable malware/content scan run before an artifact is made available. */
export interface QuarantineScanner {
  scan(artifact: Artifact, bytes?: Uint8Array): Promise<"clean" | "quarantined">;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed view so it satisfies BufferSource.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build a sharable reference (for messages / context values) from an artifact. */
export function toArtifactRef(artifact: Artifact): ArtifactRef {
  return {
    id: artifact.id,
    kind: artifact.kind,
    uri: `spanoai://artifact/${artifact.id}`,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256 ?? "",
    ...(artifact.name ? { name: artifact.name } : {}),
    metadata: {},
  };
}

export class ArtifactService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly store: ArtifactStore,
    private readonly audit: AuditLog,
    private readonly broadcaster: EventBroadcaster,
    private readonly scanner?: QuarantineScanner,
  ) {}

  async initUpload(
    tenantId: string,
    input: InitUploadRequestInput,
    principal?: AgentPrincipal,
  ): Promise<InitUploadResult> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.ARTIFACT_WRITE);
    const req = InitUploadRequestSchema.parse(input);
    this.assertWithinSoftCap(req.sizeBytes);

    const id = crypto.randomUUID();
    const storageKey = buildStorageKey(tenantId, req, id, safeFileName(req.name));
    const artifact: Artifact = {
      id,
      tenantId,
      sessionId: req.sessionId,
      createdByAgent: req.createdByAgent,
      name: req.name,
      storageKey,
      mimeType: req.mimeType,
      sizeBytes: req.sizeBytes,
      sha256: req.sha256 ?? null,
      kind: req.kind,
      status: ArtifactStatus.PENDING,
      createdAt: Date.now(),
      availableAt: null,
      expiresAt: null,
    };
    await this.store.insert(artifact);

    const uploadUrl = this.storage.presignPut(storageKey, {
      expiresIn: config.SPANOAI_ARTIFACT_UPLOAD_TTL_SECONDS,
      contentType: req.mimeType,
    });

    await this.audit.append({
      tenantId,
      runId: req.sessionId,
      agentId: req.createdByAgent,
      eventType: EventType.ARTIFACT_CREATED,
      payload: { artifactId: id, name: req.name, sizeBytes: req.sizeBytes, mimeType: req.mimeType },
    });

    return {
      artifactId: id,
      uploadUrl,
      method: "PUT",
      storageKey,
      expiresAt: Date.now() + config.SPANOAI_ARTIFACT_UPLOAD_TTL_SECONDS * 1000,
    };
  }

  async complete(
    tenantId: string,
    artifactId: string,
    input: CompleteUploadRequestInput,
  ): Promise<Artifact> {
    const { sha256, byAgent } = CompleteUploadRequestSchema.parse(input);
    const art = await this.requirePending(tenantId, artifactId);

    const stat = await this.storage.stat(art.storageKey);
    if (!stat) {
      throw new EngineError(
        "ARTIFACT_NOT_UPLOADED",
        "No uploaded object found for this artifact — upload to the presigned URL first.",
        409,
      );
    }

    // 1) Size must match what was declared, and respect the soft cap.
    if (stat.size !== art.sizeBytes) {
      await this.reject(art, byAgent, `size mismatch: declared ${art.sizeBytes}, actual ${stat.size}`);
      throw new EngineError(
        "ARTIFACT_SIZE_MISMATCH",
        `Uploaded size ${stat.size} does not match the declared ${art.sizeBytes}.`,
        422,
      );
    }
    try {
      this.assertWithinSoftCap(stat.size);
    } catch (err) {
      await this.reject(art, byAgent, "exceeds artifact size cap");
      throw err;
    }

    // 2) Verify the checksum by streaming the object back (small files only).
    const verifyMax = config.SPANOAI_ARTIFACT_HASH_VERIFY_MAX_BYTES;
    if (verifyMax === 0 || stat.size <= verifyMax) {
      const actual = await sha256Hex(await this.storage.bytes(art.storageKey));
      if (actual !== sha256.toLowerCase()) {
        await this.reject(art, byAgent, "sha256 mismatch");
        throw new EngineError(
          "ARTIFACT_HASH_MISMATCH",
          "Uploaded bytes do not match the provided sha256.",
          422,
        );
      }
    }

    // 3) Optional quarantine/malware scan before exposing to other agents.
    const verdict = this.scanner ? await this.scanner.scan(art) : "clean";
    if (verdict === "quarantined") {
      await this.store.setStatus(tenantId, artifactId, ArtifactStatus.QUARANTINED);
      await this.audit.append({
        tenantId,
        runId: art.sessionId,
        agentId: byAgent,
        eventType: EventType.ARTIFACT_QUARANTINED,
        payload: { artifactId },
      });
      return (await this.store.getById(tenantId, artifactId))!;
    }

    await this.store.markAvailable(tenantId, artifactId, sha256.toLowerCase());
    await this.audit.append({
      tenantId,
      runId: art.sessionId,
      agentId: byAgent,
      eventType: EventType.ARTIFACT_AVAILABLE,
      payload: { artifactId, sizeBytes: stat.size },
    });
    this.emit(tenantId, art.sessionId, {
      event: EventType.ARTIFACT_AVAILABLE,
      artifactId,
      name: art.name,
    });

    return (await this.store.getById(tenantId, artifactId))!;
  }

  async getMetadata(
    tenantId: string,
    sessionId: string,
    artifactId: string,
    principal?: AgentPrincipal,
  ): Promise<Artifact> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.ARTIFACT_READ);
    return this.requireAccessible(tenantId, sessionId, artifactId);
  }

  async downloadUrl(
    tenantId: string,
    sessionId: string,
    artifactId: string,
    principal?: AgentPrincipal,
  ): Promise<DownloadGrant> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.ARTIFACT_READ);
    const art = await this.requireAccessible(tenantId, sessionId, artifactId);
    if (art.status !== ArtifactStatus.AVAILABLE) {
      throw new EngineError(
        "ARTIFACT_NOT_AVAILABLE",
        `Artifact is '${art.status}', not 'available'.`,
        409,
      );
    }
    const url = this.storage.presignGet(art.storageKey, {
      expiresIn: config.SPANOAI_ARTIFACT_DOWNLOAD_TTL_SECONDS,
      downloadName: safeFileName(art.name),
    });
    return {
      url,
      expiresAt: Date.now() + config.SPANOAI_ARTIFACT_DOWNLOAD_TTL_SECONDS * 1000,
      name: art.name,
      mimeType: art.mimeType,
      sizeBytes: art.sizeBytes,
    };
  }

  async delete(
    tenantId: string,
    sessionId: string,
    artifactId: string,
    byAgent: string,
    principal?: AgentPrincipal,
  ): Promise<void> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.ARTIFACT_WRITE);
    const art = await this.requireAccessible(tenantId, sessionId, artifactId, {
      allowDeleted: true,
    });
    if (art.status === ArtifactStatus.DELETED) return; // idempotent

    await this.storage.delete(art.storageKey).catch(() => {
      /* bytes may already be gone; metadata delete still proceeds */
    });
    await this.store.setStatus(tenantId, artifactId, ArtifactStatus.DELETED);
    await this.audit.append({
      tenantId,
      runId: art.sessionId,
      agentId: byAgent,
      eventType: EventType.ARTIFACT_DELETED,
      payload: { artifactId },
    });
  }

  /** Delete bytes + tombstone metadata for artifacts past their expiry. */
  async runRetention(limit = 100): Promise<number> {
    const expired = await this.store.listExpired(Date.now(), limit);
    for (const a of expired) {
      await this.storage.delete(a.storageKey).catch(() => {});
      await this.store.setStatus(a.tenantId, a.id, ArtifactStatus.DELETED);
      await this.audit.append({
        tenantId: a.tenantId,
        runId: a.sessionId,
        agentId: "system",
        eventType: EventType.ARTIFACT_DELETED,
        payload: { artifactId: a.id, reason: "expired" },
      });
    }
    return expired.length;
  }

  // ── internals ──────────────────────────────────────────────────────

  private assertWithinSoftCap(sizeBytes: number): void {
    const cap = config.SPANOAI_MAX_ARTIFACT_BYTES;
    if (cap > 0 && sizeBytes > cap) {
      throw new EngineError(
        "ARTIFACT_TOO_LARGE",
        `Artifact size ${sizeBytes} exceeds the configured limit of ${cap} bytes.`,
        413,
      );
    }
  }

  private async requirePending(
    tenantId: string,
    artifactId: string,
  ): Promise<Artifact> {
    const art = await this.store.getById(tenantId, artifactId);
    if (!art) throw new EngineError("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
    if (art.status !== ArtifactStatus.PENDING) {
      throw new EngineError(
        "ARTIFACT_NOT_PENDING",
        `Artifact is '${art.status}'; only pending artifacts can be completed.`,
        409,
      );
    }
    return art;
  }

  private async requireAccessible(
    tenantId: string,
    sessionId: string,
    artifactId: string,
    opts?: { allowDeleted?: boolean },
  ): Promise<Artifact> {
    const art = await this.store.getById(tenantId, artifactId);
    // Wrong tenant (getById already scopes) or wrong session => 404, no leak.
    if (!art || art.sessionId !== sessionId) {
      throw new EngineError("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
    }
    if (art.status === ArtifactStatus.DELETED && !opts?.allowDeleted) {
      throw new EngineError("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
    }
    return art;
  }

  private async reject(
    art: Artifact,
    byAgent: string,
    reason: string,
  ): Promise<void> {
    await this.storage.delete(art.storageKey).catch(() => {});
    await this.store.setStatus(art.tenantId, art.id, ArtifactStatus.REJECTED);
    await this.audit.append({
      tenantId: art.tenantId,
      runId: art.sessionId,
      agentId: byAgent,
      eventType: EventType.ARTIFACT_REJECTED,
      payload: { artifactId: art.id, reason },
    });
  }

  private emit(
    tenantId: string,
    sessionId: string,
    event: { event: string; [k: string]: unknown },
  ): void {
    void Promise.resolve(
      this.broadcaster.broadcast(tenantId, sessionId, event),
    ).catch(() => {});
  }
}

export { buildStorageKey } from "../backends/postgres-artifacts";
