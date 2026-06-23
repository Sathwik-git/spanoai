/**
 * pgvector-backed semantic index over context values. One row per key (latest
 * version). Cosine distance (`<=>`) ranks matches; lower is closer.
 */
import type { Sql } from "postgres";
import { sql as defaultSql } from "../db/client";

export interface EmbeddingUpsert {
  tenantId: string;
  sessionId: string;
  fullKey: string;
  version: number;
  embedding: number[];
  ts: number;
}

export interface SearchHit {
  fullKey: string;
  version: number;
  distance: number;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class PgVectorSearch {
  constructor(private readonly db: Sql = defaultSql) {}

  async upsert(row: EmbeddingUpsert): Promise<void> {
    const id = `${row.tenantId}:${row.sessionId}:${row.fullKey}`;
    const vec = toVectorLiteral(row.embedding);
    await this.db`
      INSERT INTO context_embeddings (id, tenant_id, session_id, full_key, version, embedding, ts)
      VALUES (${id}, ${row.tenantId}, ${row.sessionId}, ${row.fullKey}, ${row.version},
              ${vec}::vector, ${row.ts})
      ON CONFLICT (id) DO UPDATE
        SET embedding = EXCLUDED.embedding, version = EXCLUDED.version, ts = EXCLUDED.ts
    `;
  }

  async query(
    tenantId: string,
    sessionId: string,
    queryEmbedding: number[],
    topK: number,
  ): Promise<SearchHit[]> {
    const vec = toVectorLiteral(queryEmbedding);
    const rows = await this.db`
      SELECT full_key, version, embedding <=> ${vec}::vector AS distance
        FROM context_embeddings
       WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
       ORDER BY distance ASC
       LIMIT ${topK}
    `;
    return rows.map((r) => ({
      fullKey: r.full_key as string,
      version: Number(r.version),
      distance: Number(r.distance),
    }));
  }
}
