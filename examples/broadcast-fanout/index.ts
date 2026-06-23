/**
 * Example: BROADCAST FAN-OUT (multi-recipient send + collect replies)
 *
 * A coordinator broadcasts the SAME task to several workers at once, each
 * worker claims its copy and replies, and the coordinator collects every
 * reply. Demonstrates multi-recipient messaging (one call → many durable
 * inboxes) and reply correlation.
 *
 *   bun run examples/broadcast-fanout/index.ts
 */
import { SpanoAIClient } from "../../packages/sdk-typescript/src/index";
import { bootstrap, teardown, shutdown, BASE_URL, makeChecker } from "../_shared/bootstrap";

const WORKERS = ["worker-1", "worker-2", "worker-3"];

async function main() {
  const { apiKey, tenantId } = await bootstrap("broadcast-fanout");
  const { check, summary } = makeChecker();
  const session = "batch-job-7";

  const coordinator = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: "coordinator" });
  await coordinator.sessions.create({ sessionId: session });

  console.log(`coordinator broadcasts a task to ${WORKERS.length} workers…`);
  const sent = await coordinator.bus.broadcast(session, WORKERS, "process_chunk", { data: { chunk: "abc" } });
  check("one durable message was created per worker", sent.length === WORKERS.length);
  check("all share one traceId (correlated fan-out)", new Set(sent.map((m) => m.traceId)).size === 1);

  // Each worker claims its own copy and replies.
  console.log("each worker claims + replies…");
  for (const name of WORKERS) {
    const worker = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: name });
    const inbox = await worker.bus.claim(session, name);
    check(`${name} received the broadcast`, inbox.some((m) => m.intent === "process_chunk"));
    if (inbox[0]) await worker.bus.reply(session, inbox[0].id, { data: { worker: name, result: "done" } });
  }

  // Coordinator collects every reply (correlated to the messages it sent).
  console.log("coordinator collects replies…");
  const replies = await Promise.all(
    sent.map((m) => coordinator.bus.awaitReply(session, m.id, { timeoutMs: 4000 })),
  );
  check("coordinator received a reply from every worker", replies.filter(Boolean).length === WORKERS.length);
  check("each reply carries the worker's result", replies.every((r) => (r?.payload.data as { result?: string })?.result === "done"));

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
