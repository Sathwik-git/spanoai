/**
 * USER-POV DEMO: "an agent sends a file to another agent."
 *
 * Walks the real, end-to-end artifact flow against live MinIO + Redis +
 * Postgres, then shows the inline-payload guard rejecting an oversized value.
 *
 * Run: bun run scripts/artifact-scenario.ts   (docker compose up -d first)
 */
import { createEngine } from "../src/engine";
import { toArtifactRef } from "../src/artifacts";
import { EngineError } from "../src/errors";
import { redis, closeConnections } from "../src/redis";
import { sql, closeSql } from "../src/db/client";

const engine = createEngine();
const T = "tenant-artifact-demo";
const S = "run-artifact-001";

const ok = (m: string) => console.log(`  ✅ ${m}`);
const head = (m: string) => console.log(`\n=== ${m} ===`);

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  await redis.select(0);

  // ── 1. Researcher generates a "report" and uploads it as an artifact ──
  head("1. Researcher uploads a file (direct to object storage)");
  const fileBytes = new TextEncoder().encode(
    "DUE DILIGENCE REPORT\nRevenue: $4.2M\nGrowth: 47% YoY\n" + "lorem ipsum ".repeat(500),
  );
  const sha = await sha256Hex(fileBytes);

  const init = await engine.artifacts.initUpload(T, {
    sessionId: S,
    createdByAgent: "researcher",
    name: "due-diligence.pdf",
    mimeType: "application/pdf",
    sizeBytes: fileBytes.length,
    sha256: sha,
  });
  ok(`got a presigned upload URL (expires in 15m); storage key is sanitized`);

  await fetch(init.uploadUrl, {
    method: "PUT",
    body: fileBytes,
    headers: { "Content-Type": "application/pdf" },
  });
  const completed = await engine.artifacts.complete(T, init.artifactId, {
    sha256: sha,
    byAgent: "researcher",
  });
  ok(`upload verified (size + sha256) and marked '${completed.status}'`);

  // ── 2. Researcher shares the file with the writer via a message ───────
  head("2. Researcher sends the file reference to the writer");
  await engine.bus.dispatch(T, {
    sessionId: S,
    fromAgent: "researcher",
    toAgent: "writer",
    intent: "deliver_report",
    payload: { text: "Final report attached.", artifacts: [toArtifactRef(completed)] },
  });
  const inbox = await engine.bus.claim(T, S, "writer", "writer-worker", 10);
  const ref = inbox[0]?.payload.artifacts[0];
  ok(`writer received a message referencing artifact ${ref?.id}`);

  // ── 3. Writer fetches the actual bytes via a short-lived download URL ─
  head("3. Writer downloads the file");
  const grant = await engine.artifacts.downloadUrl(T, S, ref!.id);
  const got = new Uint8Array(await (await fetch(grant.url)).arrayBuffer());
  ok(`writer downloaded ${got.length} bytes (download URL expires in 5m)`);
  ok(`bytes match what the researcher uploaded: ${Buffer.from(got).equals(Buffer.from(fileBytes))}`);

  // ── 4. The inline guard now routes big payloads to artifacts ──────────
  head("4. Oversized INLINE payload is now rejected (claim-check guard)");
  const fiveMB = "x".repeat(5 * 1024 * 1024);
  try {
    await engine.store.write(T, {
      sessionId: S,
      namespace: "researcher",
      key: "inline_blob",
      value: { type: "text", text: fiveMB },
      writtenBy: "researcher",
    });
    console.log("  ❌ (unexpected) 5MB inline write was accepted");
  } catch (e) {
    if (e instanceof EngineError && e.code === "PAYLOAD_TOO_LARGE") {
      ok(`5MB inline write rejected with ${e.code} (${e.status}) — upload it as an artifact instead`);
    } else {
      throw e;
    }
  }

  // ── cleanup ───────────────────────────────────────────────────────────
  await engine.artifacts.delete(T, S, init.artifactId, "researcher").catch(() => {});
  const keys = await redis.keys(`spanoai:t:${T}:*`);
  if (keys.length) await redis.del(...keys);
  await sql`DELETE FROM artifacts WHERE tenant_id = ${T}`;
  await sql`DELETE FROM audit_log WHERE tenant_id = ${T}`;
  await sql`DELETE FROM audit_run_counters WHERE tenant_id = ${T}`;
  console.log("\n(demo data cleaned up)");
}

main()
  .catch((e) => {
    console.error("demo error:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections();
    await closeSql();
    process.exit(process.exitCode ?? 0);
  });
