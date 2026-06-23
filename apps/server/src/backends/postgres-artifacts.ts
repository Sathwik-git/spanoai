/**
 * Postgres-backed artifact metadata store. Holds references + checksums +
 * lifecycle status; the bytes live in object storage. Every query is scoped by
 * tenant_id.
 */
import type { Sql } from "postgres";
import { sql as defaultSql } from "../db/client";
import type { ArtifactStore } from "./interfaces";
import {
  type Artifact,
  type ArtifactStatus,
  type InitUploadRequest,
} from "../models/artifact";

type Row = Record<string, unknown>;

function toMs(v: unknown): number | null {
  if (v == null) return null;
  return new Date(v as string).getTime();
}

function rowToArtifact(r: Row): Artifact {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    sessionId: r.session_id as string,
    createdByAgent: r.created_by_agent as string,
    name: r.name as string,
    storageKey: r.storage_key as string,
    mimeType: r.mime_type as string,
    sizeBytes: Number(r.size_bytes),
    sha256: (r.sha256 as string | null) ?? null,
    kind: r.kind as Artifact["kind"],
    status: r.status as ArtifactStatus,
    createdAt: toMs(r.created_at) ?? 0,
    availableAt: toMs(r.available_at),
    expiresAt: toMs(r.expires_at),
  };
}

export class PostgresArtifactStore implements ArtifactStore {
  constructor(private readonly db: Sql = defaultSql) {}

  async insert(a: Artifact): Promise<void> {
    await this.db`
      INSERT INTO artifacts
        (id, tenant_id, session_id, created_by_agent, name, storage_key,
         mime_type, size_bytes, sha256, kind, status, expires_at)
      VALUES (
        ${a.id}, ${a.tenantId}, ${a.sessionId}, ${a.createdByAgent}, ${a.name},
        ${a.storageKey}, ${a.mimeType}, ${a.sizeBytes}, ${a.sha256 ?? null},
        ${a.kind}, ${a.status},
        ${a.expiresAt != null ? new Date(a.expiresAt) : null}
      )
    `;
  }

  async getById(tenantId: string, id: string): Promise<Artifact | null> {
    const [row] = await this.db`
      SELECT * FROM artifacts WHERE tenant_id = ${tenantId} AND id = ${id}
    `;
    return row ? rowToArtifact(row as Row) : null;
  }

  async markAvailable(tenantId: string, id: string, sha256: string): Promise<void> {
    await this.db`
      UPDATE artifacts
         SET status = 'available', sha256 = ${sha256}, available_at = NOW()
       WHERE tenant_id = ${tenantId} AND id = ${id}
    `;
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: ArtifactStatus,
  ): Promise<void> {
    await this.db`
      UPDATE artifacts SET status = ${status}
       WHERE tenant_id = ${tenantId} AND id = ${id}
    `;
  }

  async listExpired(nowMs: number, limit: number): Promise<Artifact[]> {
    const rows = await this.db`
      SELECT * FROM artifacts
       WHERE expires_at IS NOT NULL
         AND expires_at < ${new Date(nowMs)}
         AND status <> 'deleted'
       ORDER BY expires_at ASC
       LIMIT ${limit}
    `;
    return rows.map((r) => rowToArtifact(r as Row));
  }
}

/** Build the canonical, sanitised object key for an artifact. */
export function buildStorageKey(
  tenantId: string,
  req: Pick<InitUploadRequest, "sessionId">,
  artifactId: string,
  safeName: string,
): string {
  return `tenant/${tenantId}/session/${req.sessionId}/artifact/${artifactId}/${safeName}`;
}
