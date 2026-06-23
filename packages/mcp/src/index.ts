/**
 * @spanoai/mcp — Model Context Protocol server for SpanoAI.
 *
 * Exposes the SpanoAI shared context store and message bus as MCP tools so any
 * MCP client (Claude Desktop, Cursor, the Claude Agent SDK, Google ADK's
 * MCPToolset) can use them with no glue code.
 */
export { createSpanoMcpServer } from "./server";
export { startHttpServer, type HttpServerOptions } from "./http";
export {
  resolveConfig,
  createToolContext,
  type SpanoMcpOptions,
  type SpanoMcpConfig,
  type ToolContext,
} from "./config";
export { allTools, invokeTool, type SpanoTool } from "./tools";
