/**
 * Context-store MCP tools: shared working memory that agents read/write by
 * `namespace.key`. These map 1:1 onto `client.context.*`.
 */
import { z } from "zod";
import type { ContextEntry } from "@spanoai/sdk";
import type { ToolContext } from "../config";
import {
  type SpanoTool,
  ok,
  fail,
  guard,
  resolveSession,
  resolveAgent,
  sessionArg,
  agentArg,
} from "./shared";

/** A compact, LLM-friendly one-line description of an entry. */
function describeEntry(entry: ContextEntry): string {
  const v = entry.value;
  let preview: string;
  if (v.type === "text") preview = JSON.stringify(v.text);
  else if (v.type === "json") preview = JSON.stringify(v.data);
  else preview = `<${v.type}>`;
  if (preview.length > 280) preview = `${preview.slice(0, 277)}…`;
  return `${entry.namespace}.${entry.key} (v${entry.version}, by ${entry.writtenBy}): ${preview}`;
}

export function contextTools(): SpanoTool[] {
  return [
    {
      name: "spano_write",
      title: "Write shared memory",
      description:
        "Write a value into shared working memory at namespace.key. The value may be a string or any JSON value. Pass expectedVersion for optimistic concurrency (the write is rejected with a conflict if the current version differs). Other agents in the same session can read it back immediately.",
      inputSchema: {
        namespace: z.string().describe("Namespace, e.g. the writing agent's name or a topic."),
        key: z.string().describe("Key within the namespace."),
        value: z.any().describe("String or JSON value to store."),
        expectedVersion: z
          .number()
          .int()
          .optional()
          .describe("If set, only write when the current version matches (optimistic lock)."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Write shared memory", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const expectedVersion = args.expectedVersion as number | undefined;
          const result = await client.context.write(
            session,
            args.namespace as string,
            args.key as string,
            args.value,
            expectedVersion !== undefined ? { expectedVersion } : {},
          );
          if (result.outcome === "conflict" || result.outcome === "rejected") {
            return fail(
              `Write ${result.outcome}: ${result.reason ?? "version mismatch"} (current version ${result.version ?? "?"}).`,
            );
          }
          return ok(
            `Wrote ${args.namespace}.${args.key} → version ${result.version} (${result.outcome}).`,
            { outcome: result.outcome, version: result.version },
          );
        }),
    },
    {
      name: "spano_read",
      title: "Read shared memory",
      description:
        "Read the current value at namespace.key from shared working memory. Returns the stored value and its version, or reports that the key does not exist (a miss is not an error).",
      inputSchema: {
        namespace: z.string(),
        key: z.string(),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Read shared memory", readOnlyHint: true, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const entry = await client.context.read(session, args.namespace as string, args.key as string);
          if (!entry) {
            return ok(`No value at ${args.namespace}.${args.key}.`, { found: false });
          }
          return ok(describeEntry(entry), { found: true, entry });
        }),
    },
    {
      name: "spano_append",
      title: "Append to a list",
      description:
        "Append one or more items to a list stored at namespace.key (creating the list if needed). Atomic — concurrent appends from multiple agents do not clobber each other. Optionally cap the list to the most recent maxItems.",
      inputSchema: {
        namespace: z.string(),
        key: z.string(),
        items: z.array(z.any()).describe("Items to append (any JSON values)."),
        maxItems: z.number().int().positive().optional().describe("Trim to the last N items."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Append to a list", readOnlyHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const maxItems = args.maxItems as number | undefined;
          const result = await client.context.append(
            session,
            args.namespace as string,
            args.key as string,
            args.items as unknown[],
            maxItems !== undefined ? { maxItems } : {},
          );
          return ok(`Appended ${(args.items as unknown[]).length} item(s) to ${args.namespace}.${args.key} → version ${result.version}.`, {
            version: result.version,
          });
        }),
    },
    {
      name: "spano_increment",
      title: "Increment a counter",
      description:
        "Atomically add `by` (default 1) to a numeric counter at namespace.key, creating it at 0 first if absent. Safe under concurrency. Useful for vote tallies, progress counts, and quotas.",
      inputSchema: {
        namespace: z.string(),
        key: z.string(),
        by: z.number().default(1).describe("Amount to add (may be negative)."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Increment a counter", readOnlyHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const by = (args.by as number | undefined) ?? 1;
          const result = await client.context.increment(session, args.namespace as string, args.key as string, by);
          const value = result.entry?.value;
          const current = value && value.type === "json" ? value.data : undefined;
          return ok(`Incremented ${args.namespace}.${args.key} by ${by} → ${JSON.stringify(current)}.`, {
            value: current,
            version: result.version,
          });
        }),
    },
    {
      name: "spano_await",
      title: "Await a key",
      description:
        "Block until namespace.key exists (or the timeout elapses), then return it. Use this to wait for another agent's output without busy-polling — e.g. a reviewer waiting for the coder's patch. Times out as an error after timeoutMs (default 30000).",
      inputSchema: {
        namespace: z.string(),
        key: z.string(),
        timeoutMs: z.number().int().positive().optional().describe("Max wait in ms (default 30000)."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Await a key", readOnlyHint: true, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const timeoutMs = args.timeoutMs as number | undefined;
          const entry = await client.context.awaitKey(
            session,
            args.namespace as string,
            args.key as string,
            timeoutMs !== undefined ? { timeoutMs } : {},
          );
          return ok(describeEntry(entry), { entry });
        }),
    },
    {
      name: "spano_search",
      title: "Search shared memory",
      description:
        "Semantic search over everything written in the session's shared memory. Returns the most relevant entries for a natural-language query. Use it to recall facts other agents stored earlier.",
      inputSchema: {
        query: z.string().describe("Natural-language query."),
        topK: z.number().int().positive().optional().describe("Max hits to return (default 10)."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Search shared memory", readOnlyHint: true, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const topK = (args.topK as number | undefined) ?? 10;
          const hits = await client.context.search(session, args.query as string, topK);
          if (hits.length === 0) return ok("No matching entries.", { hits: [] });
          const lines = hits.map((h) => `• ${describeEntry(h)}`).join("\n");
          return ok(`${hits.length} hit(s):\n${lines}`, { hits });
        }),
    },
  ];
}
