/**
 * Seeds a demo tenant + API key and populates a few sessions with realistic
 * activity (context, messages, an artifact) so the dashboard has something to
 * show. Prints the API key to paste into the dashboard.
 *
 *   bun run examples/seed-demo.ts
 */
import { SpanoAIClient } from "../packages/sdk-typescript/src/index";
import { bootstrap, shutdown, BASE_URL } from "./_shared/bootstrap";

async function main() {
  const { apiKey, tenantId } = await bootstrap("dashboard-demo");
  const client = (agent: string) => new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent });

  // ---- Session 1: M&A due diligence (parallel research) ----
  const s1 = "mna-due-diligence";
  const lead = client("lead");
  await lead.sessions.create({
    sessionId: s1,
    metadata: { task: "M&A due diligence", owner: "lead", priority: "high" },
  });
  await lead.context.write(s1, "shared", "plan", {
    steps: ["research", "analyze", "write"],
    status: "in_progress",
  });
  for (const area of ["climate", "markets", "legal", "tech"]) {
    const a = client(`researcher-${area}`);
    await a.context.append(s1, "shared", "findings", [
      { area, summary: `Key finding from the ${area} workstream.`, confidence: 0.82 },
    ]);
    await a.bus.dispatch(s1, "lead", "area_complete", { data: { area, done: true } });
  }
  await lead.context.increment(s1, "metrics", "tokens_used", 18450);
  const report = new TextEncoder().encode(
    "DUE DILIGENCE REPORT\nRevenue: $4.2M\nGrowth: 47% YoY\n" + "lorem ".repeat(400),
  );
  await lead.artifacts.upload(s1, { name: "report.txt", mimeType: "text/plain", bytes: report });

  // ---- Session 2: PR review (request / reply) ----
  const s2 = "pr-1234-review";
  const coder = client("coder");
  await coder.sessions.create({ sessionId: s2, metadata: { task: "Review PR #1234", repo: "spanoai/core" } });
  await coder.context.write(s2, "coder", "patch", { diff: "--- a/bus.ts\n+++ b/bus.ts\n+ fix race" });
  const ask = coder.bus.request(s2, "reviewer", "review_request", { data: { pr: 1234 } }, { timeoutMs: 4000 });
  const reviewer = client("reviewer");
  const inbox = await reviewer.bus.claim(s2, "reviewer");
  if (inbox[0]) await reviewer.bus.reply(s2, inbox[0].id, { data: { approved: true, comments: "LGTM" } });
  await ask;

  // ---- Session 3: batch broadcast fan-out ----
  const s3 = "batch-job-7";
  const coordinator = client("coordinator");
  await coordinator.sessions.create({ sessionId: s3, metadata: { task: "Process batch", chunks: 3 } });
  await coordinator.bus.broadcast(s3, ["worker-1", "worker-2", "worker-3"], "process_chunk", {
    data: { batch: 7 },
  });

  console.log("\n========================================");
  console.log(" DEMO READY — paste these into the dashboard");
  console.log("========================================");
  console.log(" API URL :", BASE_URL);
  console.log(" API key :", apiKey);
  console.log(" Tenant  :", tenantId);
  console.log("========================================\n");

  await shutdown();
}

main().catch(async (e) => {
  console.error("seed error:", e);
  await shutdown();
  process.exit(1);
});
