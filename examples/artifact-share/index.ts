/**
 * Example: ARTIFACT SHARE (file handoff between agents)
 *
 * A producer uploads a file (directly to object storage via a presigned URL,
 * verified by size + SHA-256), then hands the reference to a consumer over a
 * message. The consumer fetches the bytes with a short-lived download URL and
 * checks they match. Demonstrates the full artifact lifecycle between agents.
 *
 *   bun run examples/artifact-share/index.ts
 */
import { SpanoAIClient } from "../../packages/sdk-typescript/src/index";
import { bootstrap, teardown, shutdown, BASE_URL, makeChecker } from "../_shared/bootstrap";

async function main() {
  const { apiKey, tenantId } = await bootstrap("artifact-share");
  const { check, summary } = makeChecker();
  const session = "report-run";

  const producer = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: "producer" });
  const consumer = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: "consumer" });
  await producer.sessions.create({ sessionId: session });

  const original = new TextEncoder().encode(
    "DUE DILIGENCE REPORT\nRevenue: $4.2M\nGrowth: 47% YoY\n" + "lorem ".repeat(2000),
  );

  console.log("producer uploads the report (direct-to-storage, verified)…");
  const artifact = await producer.artifacts.upload(session, {
    name: "report.txt",
    mimeType: "text/plain",
    bytes: original,
  });
  check("artifact is available after verification", artifact.status === "available");

  console.log("producer hands the reference to the consumer…");
  await producer.bus.dispatch(session, "consumer", "deliver_report", { data: { artifactId: artifact.id } });

  console.log("consumer claims the message + downloads the file…");
  const inbox = await consumer.bus.claim(session, "consumer");
  const artifactId = (inbox[0]?.payload.data as { artifactId?: string })?.artifactId;
  check("consumer received the artifact reference", typeof artifactId === "string");

  const meta = await consumer.artifacts.getMetadata(session, artifactId!);
  check("consumer can read the artifact metadata", meta.status === "available" && meta.sizeBytes === original.length);

  const fetched = await consumer.artifacts.download(session, artifactId!);
  check("downloaded bytes match the original exactly", Buffer.from(fetched).equals(Buffer.from(original)));

  // Cross-agent isolation sanity: a wrong session can't read it.
  let denied = false;
  try {
    await consumer.artifacts.getMetadata("some-other-session", artifactId!);
  } catch {
    denied = true;
  }
  check("artifact is not visible from another session", denied);

  await teardown(tenantId);
  const okAll = summary();
  await shutdown();
  process.exit(okAll ? 0 : 1);
}

main().catch(async (e) => {
  console.error("example error:", e);
  await shutdown();
  process.exit(1);
});
