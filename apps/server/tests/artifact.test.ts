/**
 * Full artifact lifecycle against the live MinIO + Postgres:
 * init-upload -> direct PUT to presigned URL -> complete (verify) ->
 * download via presigned GET, plus integrity, access-control, and delete paths.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Sql } from "postgres";
import { BunObjectStorage } from "../src/backends/object-storage";
import { PostgresArtifactStore } from "../src/backends/postgres-artifacts";
import { ArtifactService } from "../src/artifacts";
import { AuditLog } from "../src/audit-log";
import { EngineError } from "../src/errors";
import {
  ensureTestDatabase,
  makeRedis,
  disconnectAll,
  InMemoryAudit,
  CollectingBroadcaster,
} from "./setup";

const T = "tenant-artifact-test";
const S = "sess-artifact";

let sql: Sql;
let conn: ReturnType<typeof makeRedis>;
let storage: BunObjectStorage;
let service: ArtifactService;
const createdKeys: string[] = [];

async function hashHex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function put(url: string, data: Uint8Array, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: data,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) throw new Error(`PUT failed ${res.status}: ${await res.text()}`);
}

async function expectError(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EngineError);
  expect((err as EngineError).code).toBe(code);
}

/** init + upload bytes; returns the artifactId and the file's real hash. */
async function upload(
  data: Uint8Array,
  opts: { declaredSize?: number; name?: string } = {},
): Promise<{ artifactId: string; sha: string }> {
  const sha = await hashHex(data);
  const init = await service.initUpload(T, {
    sessionId: S,
    createdByAgent: "researcher",
    name: opts.name ?? "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: opts.declaredSize ?? data.length,
    sha256: sha,
  });
  createdKeys.push(init.storageKey);
  await put(init.uploadUrl, data, "application/pdf");
  return { artifactId: init.artifactId, sha };
}

beforeAll(async () => {
  sql = await ensureTestDatabase();
  await sql`TRUNCATE artifacts`;
  conn = makeRedis();
  storage = new BunObjectStorage();
  const audit = new AuditLog(new InMemoryAudit(), conn.redis);
  service = new ArtifactService(
    storage,
    new PostgresArtifactStore(sql),
    audit,
    new CollectingBroadcaster(),
  );
});

afterAll(async () => {
  for (const key of createdKeys) await storage.delete(key).catch(() => {});
  await sql`TRUNCATE artifacts`;
  disconnectAll(conn);
  await sql.end({ timeout: 5 });
});

describe("Artifact lifecycle (MinIO)", () => {
  test("init -> upload -> complete -> download round-trips the bytes", async () => {
    const data = new TextEncoder().encode("hello artifact — the quick brown fox jumps");
    const { artifactId, sha } = await upload(data);

    const completed = await service.complete(T, artifactId, {
      sha256: sha,
      byAgent: "researcher",
    });
    expect(completed.status).toBe("available");

    const meta = await service.getMetadata(T, S, artifactId);
    expect(meta.status).toBe("available");

    const grant = await service.downloadUrl(T, S, artifactId);
    const fetched = new Uint8Array(await (await fetch(grant.url)).arrayBuffer());
    expect(Buffer.from(fetched).toString()).toBe(Buffer.from(data).toString());
  });

  test("a sha256 mismatch is rejected and the artifact is marked rejected", async () => {
    const data = new TextEncoder().encode("genuine bytes");
    const { artifactId } = await upload(data);

    await expectError(
      service.complete(T, artifactId, { sha256: "0".repeat(64), byAgent: "researcher" }),
      "ARTIFACT_HASH_MISMATCH",
    );
    // It's rejected, not available — getMetadata still returns the record.
    expect((await service.getMetadata(T, S, artifactId)).status).toBe("rejected");
  });

  test("a size mismatch is rejected", async () => {
    const data = new TextEncoder().encode("twelve bytes");
    const { artifactId, sha } = await upload(data, { declaredSize: data.length + 10 });
    await expectError(
      service.complete(T, artifactId, { sha256: sha, byAgent: "researcher" }),
      "ARTIFACT_SIZE_MISMATCH",
    );
  });

  test("download is denied for the wrong tenant and the wrong session", async () => {
    const data = new TextEncoder().encode("scoped bytes");
    const { artifactId, sha } = await upload(data);
    await service.complete(T, artifactId, { sha256: sha, byAgent: "researcher" });

    await expectError(service.downloadUrl("other-tenant", S, artifactId), "ARTIFACT_NOT_FOUND");
    await expectError(service.downloadUrl(T, "other-session", artifactId), "ARTIFACT_NOT_FOUND");
  });

  test("a soft-deleted artifact is hidden and undownloadable", async () => {
    const data = new TextEncoder().encode("temporary bytes");
    const { artifactId, sha } = await upload(data);
    await service.complete(T, artifactId, { sha256: sha, byAgent: "researcher" });

    await service.delete(T, S, artifactId, "researcher");
    await expectError(service.getMetadata(T, S, artifactId), "ARTIFACT_NOT_FOUND");
    await expectError(service.downloadUrl(T, S, artifactId), "ARTIFACT_NOT_FOUND");
  });

  test("a path-traversal file name is sanitised in the storage key", async () => {
    const init = await service.initUpload(T, {
      sessionId: S,
      createdByAgent: "researcher",
      name: "../../etc/passwd",
      mimeType: "text/plain",
      sizeBytes: 10,
    });
    createdKeys.push(init.storageKey);
    expect(init.storageKey).not.toContain("..");
    expect(init.storageKey.endsWith("/passwd")).toBe(true);
  });
});
