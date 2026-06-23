/**
 * Runs every example app in sequence against a live SpanoAI server and reports
 * a pass/fail summary. Each example is a real client of the product (SDK over
 * HTTP) and asserts its own behaviour, exiting non-zero on failure.
 *
 * Prereq: a server on http://localhost:8000 (cd server && bun run src/index.ts),
 * plus its backends (docker compose up -d). Then:
 *
 *   bun run examples/run-all.ts
 */
const BASE_URL = process.env.SPANOAI_API_URL ?? "http://localhost:8000";
const EXAMPLES = ["parallel-research", "coding-team", "broadcast-fanout", "artifact-share", "mcp-client"];

async function main() {
  // Fail fast with a clear message if the server isn't reachable.
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(`health ${res.status}`);
  } catch {
    console.error(`✗ No SpanoAI server reachable at ${BASE_URL}.`);
    console.error("  Start it first:  cd server && bun run src/index.ts");
    process.exit(2);
  }

  const results: { name: string; ok: boolean }[] = [];
  for (const name of EXAMPLES) {
    console.log(`\n${"=".repeat(60)}\n▶ ${name}\n${"=".repeat(60)}`);
    const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/${name}/index.ts`], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, SPANOAI_API_URL: BASE_URL },
    });
    const code = await proc.exited;
    results.push({ name, ok: code === 0 });
  }

  console.log(`\n${"=".repeat(60)}\nSUMMARY\n${"=".repeat(60)}`);
  for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.name}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `\nAll ${results.length} examples passed.` : `\n${failed} example(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
