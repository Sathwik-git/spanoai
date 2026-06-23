/**
 * Streamable HTTP transport (for remote / hosted MCP). Optional in v1 — provided
 * so a hosted deployment can serve the same tools over HTTP instead of stdio.
 *
 * Runs statelessly: each POST /mcp gets a fresh server + transport, so it scales
 * horizontally without sticky sessions. Per-request auth can be layered by
 * reading a header and passing it as `apiKey` to `createSpanoMcpServer`.
 *
 *   import { startHttpServer } from "@spanoai/mcp/http";
 *   await startHttpServer({ port: 8787 });
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSpanoMcpServer } from "./server";
import type { SpanoMcpOptions } from "./config";

export interface HttpServerOptions extends SpanoMcpOptions {
  /** TCP port (default 8787 or $PORT). */
  port?: number;
  /** Route the MCP endpoint is served on (default /mcp). */
  path?: string;
  /**
   * Resolve per-request options (e.g. read an Authorization header → apiKey).
   * Return null to reject the request as unauthorized.
   */
  resolveRequestOptions?: (req: IncomingMessage) => SpanoMcpOptions | null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function startHttpServer(opts: HttpServerOptions = {}): Promise<{ close: () => Promise<void> }> {
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 8787);
  const path = opts.path ?? "/mcp";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqPath = (req.url ?? "").split("?")[0] ?? "";
    // The agent identity can be carried in the URL path: `/mcp` uses the env
    // default agent, while `/mcp/<name>` makes this connection that agent. This
    // lets one server + one tunnel back several distinct agents (e.g. two
    // laptops each adding a different name) sharing the same session.
    let agentFromPath: string | undefined;
    if (reqPath === path) {
      // base agent (from env / opts)
    } else if (reqPath.startsWith(path + "/")) {
      agentFromPath = decodeURIComponent(reqPath.slice(path.length + 1)).split("/")[0] || undefined;
    } else {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    const base = opts.resolveRequestOptions ? opts.resolveRequestOptions(req) : opts;
    if (!base) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const perReq = agentFromPath ? { ...base, agent: agentFromPath } : base;
    try {
      const body = await readBody(req);
      // Stateless: a fresh server + transport per request, torn down on close.
      const mcp = createSpanoMcpServer(perReq);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.error(`[spanoai-mcp] streamable HTTP on :${port}${path} (also ${path}/<agent> for per-connection identity)`);
      resolve({
        close: () =>
          new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
