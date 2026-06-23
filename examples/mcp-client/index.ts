/**
 * Example: MCP CLIENT (drive SpanoAI through the Model Context Protocol)
 *
 * Launches the `@spanoai/mcp` server over stdio — exactly how Claude Desktop,
 * Cursor, the Claude Agent SDK or Google ADK's MCPToolset would — then connects
 * a real MCP client, lists the tools, and calls them. The engine state is then
 * verified with the plain SDK, proving the tools did real work over the wire.
 *
 *   bun run examples/mcp-client/index.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SpanoAIClient } from "../../packages/sdk-typescript/src/index";
import { bootstrap, teardown, shutdown, BASE_URL, makeChecker } from "../_shared/bootstrap";

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

async function main() {
  const { apiKey, tenantId } = await bootstrap("mcp-client");
  const { check, summary } = makeChecker();
  const session = "mcp-demo";

  // A verifier client (plain SDK) confirms the MCP tools actually changed state.
  const verifier = new SpanoAIClient({ baseUrl: BASE_URL, apiKey, agent: "verifier" });
  await verifier.sessions.create({ sessionId: session });

  // Spawn the SpanoAI MCP server over stdio, configured via env.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  Object.assign(env, {
    SPANOAI_API_KEY: apiKey,
    SPANOAI_API_URL: BASE_URL,
    SPANOAI_SESSION: session,
    SPANOAI_AGENT: "planner",
  });

  const transport = new StdioClientTransport({
    command: process.execPath, // bun
    args: ["run", `${import.meta.dir}/../../packages/mcp/src/stdio.ts`],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "spano-mcp-example", version: "0.1.0" });

  try {
    await client.connect(transport);

    console.log("an MCP client lists the SpanoAI tools…");
    const { tools } = await client.listTools();
    check("the server exposes all 14 SpanoAI tools", tools.length === 14);
    check("spano_write and spano_send are advertised", tools.some((t) => t.name === "spano_write") && tools.some((t) => t.name === "spano_send"));

    console.log("the agent writes shared memory through a tool call…");
    const wrote = (await client.callTool({
      name: "spano_write",
      arguments: { namespace: "planner", key: "goal", value: { task: "ship integrations" } },
    })) as ToolResult;
    check("spano_write returned success", !wrote.isError);
    const entry = await verifier.context.read<{ task: string }>(session, "planner", "goal");
    check("the write is visible to another client", entry?.value.type === "json");
    check("the write recorded the MCP agent identity", entry?.writtenBy === "planner");

    console.log("the agent hands off work to a teammate over the bus…");
    const sent = (await client.callTool({
      name: "spano_send",
      arguments: { toAgent: "worker", intent: "handoff", text: "please build it", data: { ref: "goal" } },
    })) as ToolResult;
    check("spano_send returned a message id", typeof sent.structuredContent?.messageId === "string");
    const inbox = await verifier.bus.claim(session, "worker");
    check("the worker received the durable handoff", inbox.some((m) => m.intent === "handoff"));

    console.log("the agent reads a value back through a tool call…");
    const readBack = (await client.callTool({
      name: "spano_read",
      arguments: { namespace: "planner", key: "goal" },
    })) as ToolResult;
    check("spano_read found the value", readBack.structuredContent?.found === true);
  } finally {
    await client.close();
  }

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
