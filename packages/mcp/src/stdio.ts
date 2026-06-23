#!/usr/bin/env node
/**
 * stdio entry point — the `spanoai-mcp` binary.
 *
 *   SPANOAI_API_KEY=sk_... SPANOAI_SESSION=run-1 npx @spanoai/mcp
 *
 * Designed to be spawned by an MCP client (Claude Desktop, Cursor, the Claude
 * Agent SDK, Google ADK's MCPToolset). Communicates over stdin/stdout, so this
 * process must never write protocol-breaking output to stdout — logs go to
 * stderr only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSpanoMcpServer } from "./server";

async function main(): Promise<void> {
  const server = createSpanoMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[spanoai-mcp] ready on stdio");
}

main().catch((err) => {
  console.error("[spanoai-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
