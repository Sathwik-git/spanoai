/**
 * Example: PARALLEL RESEARCH (fan-out + accumulate + barrier)
 *
 * Five researcher agents work concurrently and each appends its finding to one
 * shared list. A lead agent waits until all five have reported (a barrier),
 * then reads the consolidated result. Demonstrates that concurrent appends
 * never lose data, and a client-side barrier over shared context.
 *
 *   bun run examples/parallel-research/index.ts
 */
import { SpanoAIClient } from "../../packages/sdk-typescript/src/index";
import { bootstrap, teardown, shutdown, BASE_URL, makeChecker } from "../_shared/bootstrap";

const AGENTS = ["climate", "policy", "markets", "tech", "legal"];

async function main() {
  const { apiKey, tenantId } = await bootstrap("parallel-research");
  const { check, summary } = makeChecker();
  const session = "mna-due-diligence";

  const lead = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: "lead" });
  await lead.sessions.create({ sessionId: session });

  console.log(`\n${AGENTS.length} researchers append findings concurrently…`);
  // Each researcher is its own SDK client (its own agent identity), running in
  // parallel. Atomic append means no finding is lost despite the race.
  await Promise.all(
    AGENTS.map((name) => {
      const agent = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: `researcher-${name}` });
      return agent.context.append(session, "shared", "findings", [
        { area: name, summary: `finding from ${name}`, confidence: 0.8 },
      ]);
    }),
  );

  // The lead waits (barrier) until all five findings are in, then reads.
  console.log("lead waits for the barrier (all 5 findings)…");
  let findings: unknown[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const entry = await lead.context.read<unknown[]>(session, "shared", "findings");
    findings = entry?.value.type === "json" ? (entry.value.data as unknown[]) : [];
    if (findings.length >= AGENTS.length) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  check("all 5 concurrent findings were preserved (no lost updates)", findings.length === 5);
  check("each researcher's area is present", new Set(findings.map((f) => (f as { area: string }).area)).size === 5);

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
