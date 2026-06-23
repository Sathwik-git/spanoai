/**
 * Shared primitives for SpanoAI MCP tools.
 *
 * Every tool is described once as a {@link SpanoTool} so the same definition can
 * be registered with an `McpServer` and invoked directly in tests. Handlers must
 * NEVER throw: errors are caught and returned as `{ isError: true }` results so
 * the agent loop stays alive (an LLM can read the message and recover).
 */
import type { ZodRawShape } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { SpanoAIError } from "@spanoai/sdk";
import { z } from "zod";
import type { ToolContext } from "../config";

export interface SpanoTool {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Thrown inside a handler for an expected, user-facing failure (bad input). */
export class ToolInputError extends Error {}

/** A successful text result, optionally with machine-readable structured data. */
export function ok(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return structuredContent
    ? { content: [{ type: "text", text }], structuredContent }
    : { content: [{ type: "text", text }] };
}

/** An error result that keeps the agent loop alive. */
export function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Run a handler body, converting any thrown error into an `isError` result. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(formatError(err));
  }
}

export function formatError(err: unknown): string {
  if (err instanceof SpanoAIError) {
    const code = err.code ? ` ${err.code}` : "";
    const rid = err.requestId ? ` (requestId ${err.requestId})` : "";
    if (err.isForbidden) {
      return `SpanoAI ${err.status}${code}: ${err.message}. The API key is missing a required scope or namespace.${rid}`;
    }
    return `SpanoAI ${err.status}${code}: ${err.message}.${rid}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Resolve the session from the call args, the env default, or fail clearly. */
export function resolveSession(args: Record<string, unknown>, ctx: ToolContext): string {
  const session = (args.session as string | undefined) ?? ctx.config.defaultSession;
  if (!session) {
    throw new ToolInputError(
      "No session. Pass a `session` argument or set the SPANOAI_SESSION environment variable.",
    );
  }
  return session;
}

/** The optional agent override (falls back to the configured default agent). */
export function resolveAgent(args: Record<string, unknown>, ctx: ToolContext): string {
  return (args.agent as string | undefined) ?? ctx.config.defaultAgent;
}

/** Build the bus payload shape `{ text?, data? }` from loose tool args. */
export function toPayload(args: Record<string, unknown>): { text?: string; data?: unknown } {
  const payload: { text?: string; data?: unknown } = {};
  if (typeof args.text === "string") payload.text = args.text;
  if (args.data !== undefined) payload.data = args.data;
  return payload;
}

// Common zod fragments reused across tools. `session`/`agent` are optional on
// every tool so a call can override the server's env defaults.
export const sessionArg = z.string().optional().describe("Session id. Overrides SPANOAI_SESSION.");
export const agentArg = z
  .string()
  .optional()
  .describe("Agent identity for this call. Overrides SPANOAI_AGENT.");
