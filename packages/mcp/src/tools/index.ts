/**
 * The full SpanoAI MCP tool set, plus a helper to invoke a tool directly
 * (validating args against its zod schema) — used both for embedding and tests.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../config";
import type { SpanoTool } from "./shared";
import { contextTools } from "./context";
import { busTools } from "./bus";
import { artifactTools } from "./artifacts";

export type { SpanoTool } from "./shared";

/** Every SpanoAI tool, in a stable order. */
export function allTools(): SpanoTool[] {
  return [...contextTools(), ...busTools(), ...artifactTools()];
}

/**
 * Validate `args` against a tool's input schema, then run its handler. Mirrors
 * what an `McpServer` does on a tool call, so tests exercise the real schema.
 */
export async function invokeTool(
  tool: SpanoTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  const parsed = z.object(tool.inputSchema).parse(args);
  return tool.handler(parsed as Record<string, unknown>, ctx);
}
