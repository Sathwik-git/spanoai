/**
 * End-to-end tests for the SpanoAI MCP tools against a LIVE engine.
 *
 * Prereq: docker compose up -d && the server running on :8000 (bun run
 * --filter @spanoai/server dev). Mirrors the examples' bootstrap: mints an
 * ephemeral tenant + key directly, then drives the tools exactly as an MCP
 * client would (each tool maps to a real HTTP call) and verifies engine state
 * with an independent SDK client.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { bootstrap, teardown, shutdown, BASE_URL } from "../../../examples/_shared/bootstrap";
import { SpanoAIClient } from "@spanoai/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveConfig, createToolContext, type ToolContext } from "../src/config";
import { allTools, invokeTool, type SpanoTool } from "../src/tools";
import { startHttpServer } from "../src/http";

let tenantId: string;
let apiKey: string;
let ctx: ToolContext;
let session: string;
let sdk: SpanoAIClient;

const tool = (name: string): SpanoTool => {
  const t = allTools().find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
};
const call = (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
  invokeTool(tool(name), args, ctx);
const textOf = (r: CallToolResult): string =>
  r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const structured = (r: CallToolResult): Record<string, unknown> =>
  (r.structuredContent ?? {}) as Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const boot = await bootstrap("mcp");
  tenantId = boot.tenantId;
  apiKey = boot.apiKey;
  session = `mcp-${crypto.randomUUID().slice(0, 8)}`;
  ctx = createToolContext(resolveConfig({ apiKey: boot.apiKey, apiUrl: BASE_URL, session, agent: "planner" }));
  sdk = new SpanoAIClient({ baseUrl: BASE_URL, apiKey: boot.apiKey, agent: "verifier" });
  await sdk.sessions.create({ sessionId: session });
});

afterAll(async () => {
  await teardown(tenantId);
  await shutdown();
});

test("exposes all 14 tools with unique names + schemas", () => {
  const tools = allTools();
  expect(tools.length).toBe(14);
  const names = new Set(tools.map((t) => t.name));
  expect(names.size).toBe(14);
  for (const t of tools) {
    expect(t.description.length).toBeGreaterThan(20);
    expect(typeof t.inputSchema).toBe("object");
    expect(t.handler).toBeInstanceOf(Function);
  }
  // The headline tools the spec requires.
  for (const n of [
    "spano_write", "spano_read", "spano_append", "spano_increment", "spano_await",
    "spano_search", "spano_send", "spano_broadcast", "spano_claim", "spano_reply",
    "spano_request", "spano_await_reply", "spano_upload", "spano_download",
  ]) {
    expect(names.has(n)).toBe(true);
  }
});

test("spano_write writes and the engine reflects it", async () => {
  const res = await call("spano_write", { namespace: "planner", key: "goal", value: { task: "ship integrations" } });
  expect(res.isError).toBeUndefined();
  expect(structured(res).outcome).toBe("written");
  const entry = await sdk.context.read(session, "planner", "goal");
  expect(entry).not.toBeNull();
  expect(entry?.value).toEqual({ type: "json", data: { task: "ship integrations" } });
  expect(entry?.writtenBy).toBe("planner"); // agent identity flowed through
});

test("spano_read returns the value, and reports a miss without erroring", async () => {
  const hit = await call("spano_read", { namespace: "planner", key: "goal" });
  expect(hit.isError).toBeUndefined();
  expect(structured(hit).found).toBe(true);

  const miss = await call("spano_read", { namespace: "planner", key: "does-not-exist" });
  expect(miss.isError).toBeUndefined(); // a miss is NOT an error
  expect(structured(miss).found).toBe(false);
});

test("spano_write honours expectedVersion (optimistic concurrency)", async () => {
  await call("spano_write", { namespace: "lock", key: "k", value: "v1" });
  const conflict = await call("spano_write", { namespace: "lock", key: "k", value: "v2", expectedVersion: 99 });
  expect(conflict.isError).toBe(true);
  expect(textOf(conflict).toLowerCase()).toContain("conflict");
});

test("spano_append appends atomically", async () => {
  await call("spano_append", { namespace: "log", key: "events", items: ["a", "b"] });
  await call("spano_append", { namespace: "log", key: "events", items: ["c"] });
  const entry = await sdk.context.read<unknown[]>(session, "log", "events");
  expect(entry?.value.type).toBe("json");
  expect((entry?.value as { data: unknown[] }).data).toEqual(["a", "b", "c"]);
});

test("spano_increment increments a counter", async () => {
  const r1 = await call("spano_increment", { namespace: "stats", key: "votes", by: 2 });
  expect(structured(r1).value).toBe(2);
  const r2 = await call("spano_increment", { namespace: "stats", key: "votes", by: 3 });
  expect(structured(r2).value).toBe(5);
});

test("spano_await unblocks when another agent writes the key", async () => {
  const waiting = call("spano_await", { namespace: "coder", key: "patch", timeoutMs: 4000 });
  setTimeout(() => void sdk.context.write(session, "coder", "patch", { diff: "+fix" }), 150);
  const res = await waiting;
  expect(res.isError).toBeUndefined();
  expect((structured(res).entry as { key: string }).key).toBe("patch");
});

test("spano_await times out as an error when nothing arrives", async () => {
  const res = await call("spano_await", { namespace: "coder", key: "never", timeoutMs: 600 });
  expect(res.isError).toBe(true);
});

test("spano_search finds a semantically related entry", async () => {
  await sdk.context.write(session, "research", "finding", "quarterly revenue grew to four million dollars");
  let hits: unknown[] = [];
  for (let i = 0; i < 10; i++) {
    const res = await call("spano_search", { query: "revenue", topK: 5 });
    expect(res.isError).toBeUndefined();
    hits = (structured(res).hits as unknown[]) ?? [];
    if (hits.some((h) => (h as { key: string }).key === "finding")) break;
    await sleep(200);
  }
  expect(hits.some((h) => (h as { key: string }).key === "finding")).toBe(true);
});

test("spano_send → spano_claim → spano_reply round-trips", async () => {
  const sent = await call("spano_send", {
    toAgent: "worker", intent: "do_task", text: "please process", data: { id: 7 },
  });
  expect(sent.isError).toBeUndefined();
  const messageId = structured(sent).messageId as string;
  expect(messageId).toBeTruthy();

  const claimed = await call("spano_claim", { agent: "worker", count: 5 });
  expect(claimed.isError).toBeUndefined();
  const messages = structured(claimed).messages as Array<{ id: string; intent: string }>;
  expect(messages.length).toBeGreaterThanOrEqual(1);
  const mine = messages.find((m) => m.id === messageId);
  expect(mine?.intent).toBe("do_task");

  const replied = await call("spano_reply", { agent: "worker", messageId, data: { ok: true } });
  expect(replied.isError).toBeUndefined();

  const reply = await sdk.bus.awaitReply(session, messageId, { timeoutMs: 3000 });
  expect((reply?.payload.data as { ok?: boolean })?.ok).toBe(true);
});

test("spano_request blocks until the peer replies", async () => {
  const asking = call("spano_request", {
    toAgent: "reviewer", intent: "review", data: { pr: 1 }, timeoutMs: 4000,
  });
  setTimeout(async () => {
    const inbox = await sdk.bus.claim(session, "reviewer");
    if (inbox[0]) await sdk.bus.reply(session, inbox[0].id, { data: { approved: true } });
  }, 150);
  const res = await asking;
  expect(res.isError).toBeUndefined();
  expect((structured(res).reply as { payload: { data: { approved: boolean } } }).payload.data.approved).toBe(true);
});

test("spano_broadcast fans out and replies can be awaited", async () => {
  const res = await call("spano_broadcast", {
    toAgents: ["w1", "w2", "w3"], intent: "fanout", data: { job: "x" },
  });
  expect(res.isError).toBeUndefined();
  const ids = structured(res).messageIds as string[];
  expect(ids.length).toBe(3);
  // a worker replies, the original sender awaits it
  const inbox = await sdk.bus.claim(session, "w2");
  expect(inbox.length).toBe(1);
  await sdk.bus.reply(session, inbox[0]!.id, { data: { done: true } });
  const reply = await call("spano_await_reply", { messageId: ids[1]!, timeoutMs: 3000 });
  expect((structured(reply).reply as { payload: { data: { done: boolean } } }).payload.data.done).toBe(true);
});

test("spano_upload → spano_download round-trips bytes", async () => {
  const original = "hello spano artifacts — binary-safe ✓";
  const base64 = Buffer.from(original, "utf8").toString("base64");
  const up = await call("spano_upload", { name: "note.txt", mimeType: "text/plain", base64 });
  expect(up.isError).toBeUndefined();
  const artifactId = structured(up).artifactId as string;
  expect(artifactId).toBeTruthy();

  const down = await call("spano_download", { artifactId });
  expect(down.isError).toBeUndefined();
  const got = Buffer.from(structured(down).base64 as string, "base64").toString("utf8");
  expect(got).toBe(original);
  expect(structured(down).mimeType).toBe("text/plain");
});

test("missing session is surfaced as an error, not a throw", async () => {
  const noSessionCtx = createToolContext(resolveConfig({ apiKey: "x", apiUrl: BASE_URL, agent: "a" }));
  const res = await invokeTool(tool("spano_read"), { namespace: "n", key: "k" }, noSessionCtx);
  expect(res.isError).toBe(true);
  expect(textOf(res).toLowerCase()).toContain("session");
});

test("a bad API key surfaces as an isError result (loop stays alive)", async () => {
  const badCtx = createToolContext(resolveConfig({ apiKey: "sk_invalid", apiUrl: BASE_URL, session, agent: "a" }));
  const res = await invokeTool(tool("spano_write"), { namespace: "n", key: "k", value: "v" }, badCtx);
  expect(res.isError).toBe(true);
});

// Full MCP wire-protocol check: spawn the stdio binary exactly as Claude
// Desktop / Cursor / ADK MCPToolset would, then drive it over JSON-RPC.
test("stdio binary: a real MCP client lists and calls tools over the wire", async () => {
  const stdioEntry = `${import.meta.dir}/../src/stdio.ts`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  env.SPANOAI_API_KEY = apiKey;
  env.SPANOAI_API_URL = BASE_URL;
  env.SPANOAI_SESSION = session;
  env.SPANOAI_AGENT = "stdio-agent";

  const transport = new StdioClientTransport({
    command: process.execPath, // the bun executable running this test
    args: ["run", stdioEntry],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "spano-test-client", version: "0.0.0" });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(14);
    expect(tools.map((t) => t.name)).toContain("spano_write");

    const wrote = await client.callTool({
      name: "spano_write",
      arguments: { namespace: "stdio", key: "ping", value: { ok: true } },
    });
    expect(wrote.isError).toBeFalsy();

    // The write really happened on the engine, under the stdio agent identity.
    const entry = await sdk.context.read(session, "stdio", "ping");
    expect(entry?.value).toEqual({ type: "json", data: { ok: true } });
    expect(entry?.writtenBy).toBe("stdio-agent");

    const readBack = await client.callTool({
      name: "spano_read",
      arguments: { namespace: "stdio", key: "ping" },
    });
    expect(readBack.isError).toBeFalsy();
  } finally {
    await client.close();
  }
}, 30_000);

// Remote (Streamable HTTP) transport — the path a claude.ai custom connector
// uses. Start the HTTP server with a baked-in identity, connect a real
// Streamable-HTTP MCP client, and verify a tool call hits the engine.
test("streamable HTTP: a remote MCP client lists and calls tools over /mcp", async () => {
  const port = 8793;
  const httpServer = await startHttpServer({
    port,
    apiUrl: BASE_URL,
    apiKey,
    session,
    agent: "web-claude",
  });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
  const client = new Client({ name: "remote-test", version: "0.0.0" });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(14);

    const wrote = await client.callTool({
      name: "spano_write",
      arguments: { namespace: "web", key: "shared", value: { from: "web-claude" } },
    });
    expect(wrote.isError).toBeFalsy();

    const entry = await sdk.context.read(session, "web", "shared");
    expect(entry?.value).toEqual({ type: "json", data: { from: "web-claude" } });
    expect(entry?.writtenBy).toBe("web-claude");
  } finally {
    await client.close();
    await httpServer.close();
  }
}, 30_000);

// Two connections to ONE HTTP server, distinct agents via the URL path
// (/mcp/alice vs /mcp/bob), coordinate over the bus in the same session.
test("streamable HTTP: /mcp/<agent> gives distinct identities that message each other", async () => {
  const port = 8795;
  const httpServer = await startHttpServer({ port, apiUrl: BASE_URL, apiKey, session, agent: "default" });
  const alice = new Client({ name: "alice", version: "0" });
  const bob = new Client({ name: "bob", version: "0" });
  try {
    await alice.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp/alice`)));
    await bob.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp/bob`)));

    // alice writes — the engine records her path-derived identity
    await alice.callTool({ name: "spano_write", arguments: { namespace: "alice", key: "note", value: "hi from alice" } });
    const aliceEntry = await sdk.context.read(session, "alice", "note");
    expect(aliceEntry?.writtenBy).toBe("alice");

    // alice sends bob a durable message
    const sent = await alice.callTool({ name: "spano_send", arguments: { toAgent: "bob", intent: "handoff", text: "please build it" } });
    expect((sent.structuredContent as { messageId?: string }).messageId).toBeTruthy();

    // bob claims his inbox and sees alice's message
    const claimed = await bob.callTool({ name: "spano_claim", arguments: {} });
    const msgs = (claimed.structuredContent as { messages: Array<{ fromAgent: string; intent: string }> }).messages;
    expect(msgs.some((m) => m.fromAgent === "alice" && m.intent === "handoff")).toBe(true);
  } finally {
    await alice.close();
    await bob.close();
    await httpServer.close();
  }
}, 30_000);
