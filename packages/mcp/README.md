# @spanoai/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
**SpanoAI** — shared working memory (a context store) **plus a durable message
bus** — to any MCP client: Claude Desktop, Cursor, the Claude Agent SDK, and
Google ADK's `MCPToolset`. No glue code.

```bash
SPANOAI_API_KEY=sk_... SPANOAI_SESSION=run-1 npx @spanoai/mcp
```

## Why

Memory tools let agents `add` → `search` → recall. SpanoAI does that **and**
gives agents verbs to coordinate with each other — `send`, `claim`, `reply`,
`request`, `await` — over a durable, idempotent bus. This server surfaces both.

## Configuration

All configuration is via environment variables (or the programmatic options):

| Env | Required | Default | Meaning |
| --- | --- | --- | --- |
| `SPANOAI_API_KEY` | ✅ | — | A scoped SpanoAI API key. |
| `SPANOAI_API_URL` |   | `http://localhost:8000` | Engine base URL. |
| `SPANOAI_SESSION` |   | — | Default session id (tools may override per call). |
| `SPANOAI_AGENT` |   | `spano-mcp` | Default agent identity (tools may override per call). |
| `SPANOAI_MCP_MAX_INLINE_BYTES` | | `1048576` | Max bytes carried inline by `spano_upload`/`spano_download`. |

## Tools

| Tool | Args | Does |
| --- | --- | --- |
| `spano_write` | `namespace, key, value, expectedVersion?` | Write a value (optimistic-locked if `expectedVersion`). |
| `spano_read` | `namespace, key` | Read a value (a miss is reported, not an error). |
| `spano_append` | `namespace, key, items[], maxItems?` | Atomically append to a list. |
| `spano_increment` | `namespace, key, by?` | Atomically bump a counter. |
| `spano_await` | `namespace, key, timeoutMs?` | Block until a key appears. |
| `spano_search` | `query, topK?` | Semantic search over the session's memory. |
| `spano_send` | `toAgent, intent, text?, data?, priority?` | Send a durable message. |
| `spano_broadcast` | `toAgents[], intent, text?, data?` | Fan-out to several agents. |
| `spano_claim` | `count?` | Claim pending messages from this agent's inbox. |
| `spano_reply` | `messageId, text?, data?` | Reply to (and ack) a claimed message. |
| `spano_request` | `toAgent, intent, text?, data?, timeoutMs?` | Send and block for the reply. |
| `spano_await_reply` | `messageId, timeoutMs?` | Long-poll for a reply to a sent message. |
| `spano_upload` | `name, mimeType, base64` | Upload file bytes as an artifact. |
| `spano_download` | `artifactId` | Download artifact bytes (base64). |

Every tool accepts optional `session` and `agent` arguments that override the
environment defaults. Errors (including missing scopes → 403) are returned as
`isError` results, never thrown, so the agent loop stays alive.

## Use it from an MCP client

**Claude Desktop / Cursor** (`claude_desktop_config.json` / `mcp.json`):

```json
{
  "mcpServers": {
    "spanoai": {
      "command": "npx",
      "args": ["-y", "@spanoai/mcp"],
      "env": {
        "SPANOAI_API_KEY": "sk_...",
        "SPANOAI_SESSION": "run-1",
        "SPANOAI_AGENT": "desktop"
      }
    }
  }
}
```

**Google ADK** (`MCPToolset`):

```python
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset, StdioServerParameters

tools = MCPToolset(connection_params=StdioServerParameters(
    command="npx", args=["-y", "@spanoai/mcp"],
    env={"SPANOAI_API_KEY": "sk_...", "SPANOAI_SESSION": "run-1"},
))
```

## Programmatic / in-process

```ts
import { createSpanoMcpServer } from "@spanoai/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createSpanoMcpServer({ apiKey: "sk_...", session: "run-1", agent: "planner" });
await server.connect(new StdioServerTransport());
```

A streamable-HTTP server is also available for hosted/remote MCP:

```ts
import { startHttpServer } from "@spanoai/mcp/http";
await startHttpServer({ port: 8787 }); // serves POST /mcp
```

## License

MIT
