#!/usr/bin/env node
/**
 * Entry point for the remote (Streamable HTTP) MCP server — the transport used
 * by hosted/remote MCP clients such as claude.ai custom connectors.
 *
 *   SPANOAI_API_KEY=sk_... SPANOAI_SESSION=run-1 SPANOAI_AGENT=web-claude \
 *   PORT=8787 npx -p @spanoai/mcp spanoai-mcp-http
 *
 * Serves POST/GET /mcp. Identity (key/session/agent) is read from the same env
 * vars as the stdio server. Expose it over HTTPS (e.g. a Cloudflare/ngrok
 * tunnel) and point your connector at https://<host>/mcp.
 */
import { startHttpServer } from "./http";

startHttpServer().catch((err) => {
  console.error("[spanoai-mcp-http] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
