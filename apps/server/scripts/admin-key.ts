/**
 * Dev utility: mint or tear down an ephemeral tenant + API key directly via the
 * engine (the "signup/admin" step). Used by non-TypeScript SDK test suites (the
 * Python SDK) that need a real key but can't reach the engine internals.
 *
 *   bun run server/scripts/admin-key.ts mint my-suite     # -> {"apiKey","tenantId"} on stdout
 *   bun run server/scripts/admin-key.ts teardown <tenantId>
 */
import { bootstrap, teardown, shutdown } from "../../../examples/_shared/bootstrap";

const [, , cmd, arg] = process.argv;

try {
  if (cmd === "mint") {
    const result = await bootstrap(arg ?? "suite");
    process.stdout.write(JSON.stringify(result));
  } else if (cmd === "teardown") {
    if (!arg) throw new Error("teardown requires a tenantId");
    await teardown(arg);
  } else {
    process.stderr.write("usage: admin-key.ts mint <name> | teardown <tenantId>\n");
    process.exit(2);
  }
} finally {
  await shutdown();
}
