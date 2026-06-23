/**
 * Object storage backend, backed by Bun's native S3 client.
 *
 * Works with any S3-compatible service (MinIO in dev, S3/R2 in prod) via the
 * `endpoint` option. Presigning is synchronous (no network) so the API can
 * hand a client a direct upload/download URL cheaply — file bytes never flow
 * through the engine.
 */
import { S3Client } from "bun";
import { config } from "../config";
import type { ObjectStorage, ObjectStat } from "./interfaces";

export class BunObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor() {
    this.client = new S3Client({
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      bucket: config.S3_BUCKET,
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
    });
  }

  presignPut(
    key: string,
    opts: { expiresIn: number; contentType?: string },
  ): string {
    return this.client.presign(key, {
      method: "PUT",
      expiresIn: opts.expiresIn,
      ...(opts.contentType ? { type: opts.contentType } : {}),
    });
  }

  presignGet(
    key: string,
    opts: { expiresIn: number; downloadName?: string },
  ): string {
    return this.client.presign(key, {
      method: "GET",
      expiresIn: opts.expiresIn,
      ...(opts.downloadName
        ? { contentDisposition: `attachment; filename="${opts.downloadName}"` }
        : {}),
    });
  }

  async stat(key: string): Promise<ObjectStat | null> {
    if (!(await this.client.exists(key))) return null;
    const s = await this.client.stat(key);
    return { size: Number(s.size), etag: s.etag, type: s.type };
  }

  async bytes(key: string): Promise<Uint8Array> {
    return this.client.file(key).bytes();
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }
}
