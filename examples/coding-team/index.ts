/**
 * Example: CODING TEAM (handoff via awaitKey + request/reply)
 *
 * A coder writes its result into shared context. A reviewer BLOCKS on that key
 * (await — no polling) until it appears, reviews it, and the coder asks the
 * reviewer for a verdict via request/reply. Demonstrates awaitKey as a
 * single-producer handoff and correlated request/reply between two agents.
 *
 *   bun run examples/coding-team/index.ts
 */
import { SpanoAIClient } from "../../packages/sdk-typescript/src/index";
import { bootstrap, teardown, shutdown, BASE_URL, makeChecker } from "../_shared/bootstrap";

async function main() {
  const { apiKey, tenantId } = await bootstrap("coding-team");
  const { check, summary } = makeChecker();
  const session = "pr-1234";

  const coder = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: "coder" });
  const reviewer = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: "reviewer" });
  await coder.sessions.create({ sessionId: session });

  // Reviewer blocks on the coder's output BEFORE it exists (no busy-polling).
  console.log("reviewer awaits coder.patch …");
  const awaitPatch = reviewer.context.awaitKey<{ diff: string }>(session, "coder", "patch", { timeoutMs: 5000 });

  // Coder finishes a bit later and publishes its patch.
  setTimeout(() => {
    void coder.context.write(session, "coder", "patch", { diff: "--- a/x\n+++ b/x\n+ fix" });
  }, 150);

  const patch = await awaitPatch;
  check("reviewer unblocked when the coder published the patch", patch !== null);
  check("reviewer sees the coder's diff", patch?.value.type === "json");

  // The coder asks the reviewer for a verdict and blocks for the reply.
  console.log("coder asks the reviewer for a verdict (request/reply)…");
  const ask = coder.bus.request(session, "reviewer", "review_request", { data: { pr: 1234 } }, { timeoutMs: 5000 });

  // Reviewer claims the request and replies with its verdict.
  setTimeout(async () => {
    const inbox = await reviewer.bus.claim(session, "reviewer");
    if (inbox[0]) await reviewer.bus.reply(session, inbox[0].id, { data: { approved: true, comments: "LGTM" } });
  }, 150);

  const { reply } = await ask;
  check("coder received the reviewer's verdict", reply !== null);
  check("verdict is approved", (reply?.payload.data as { approved?: boolean })?.approved === true);

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
