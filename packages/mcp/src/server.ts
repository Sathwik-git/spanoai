/**
 * Programmatic entry point: build a configured MCP server that exposes the
 * SpanoAI context store and message bus as tools.
 *
 *   import { createSpanoMcpServer } from "@spanoai/mcp";
 *   const server = createSpanoMcpServer({ apiKey, session: "run-1", agent: "planner" });
 *   await server.connect(transport);
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfig, createToolContext, type SpanoMcpOptions } from "./config";
import { allTools } from "./tools";

/**
 * Minimal registrar signature. We cast `server.registerTool` to this to bypass
 * the SDK's heavily-generic `ToolCallback<InputArgs>`, which TypeScript cannot
 * instantiate over our 14 zod shapes (TS2589). Args are validated by the SDK at
 * call time, and each handler is already strongly typed via SpanoTool.
 */
type ToolRegistrar = (
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: ZodRawShape;
    annotations?: ToolAnnotations;
  },
  cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
) => unknown;

const INSTRUCTIONS = [
  "SpanoAI gives multiple agents a shared working memory (a context store keyed by namespace.key) and a durable message bus for agent-to-agent coordination.",
  "Use spano_write/read/append/increment/search to share facts; spano_await to wait for another agent's output.",
  "Use spano_send/broadcast/claim/reply/request/await_reply to coordinate work between agents.",
  "All operations are scoped to one session; set SPANOAI_SESSION or pass `session` per call.",
].join(" ");

export function createSpanoMcpServer(opts: SpanoMcpOptions = {}): McpServer {
  const config = resolveConfig(opts);
  const ctx = createToolContext(config, opts);

  const server = new McpServer(
    { name: "spanoai", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  const register = server.registerTool.bind(server) as unknown as ToolRegistrar;
  for (const tool of allTools()) {
    register(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args) => tool.handler(args, ctx),
    );
  }

  return server;
}
