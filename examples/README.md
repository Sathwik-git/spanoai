# SpanoAI Examples

Five small, **runnable** applications — each one a real client of the product
(the TypeScript SDK over HTTP, or the MCP server over stdio) that exercises a
different coordination pattern and **asserts its own behaviour**. They are how we
verify the engine actually works the way the docs claim, not just that the unit
tests pass.

| Example | Pattern it proves | Primitives used |
|---|---|---|
| [`parallel-research/`](./parallel-research) | Fan-out + accumulate + client-side barrier; concurrent appends never lose data | `context.append`, `context.read` |
| [`coding-team/`](./coding-team) | Blocking handoff (no polling) + correlated request/reply | `context.awaitKey`, `bus.request`, `bus.reply` |
| [`broadcast-fanout/`](./broadcast-fanout) | One send → many durable inboxes, then collect every reply | `bus.broadcast`, `bus.claim`, `bus.reply`, `bus.awaitReply` |
| [`artifact-share/`](./artifact-share) | File handoff: upload → reference over a message → download, byte-exact | `artifacts.upload/getMetadata/download`, `bus.dispatch` |
| [`mcp-client/`](./mcp-client) | Driving SpanoAI through the Model Context Protocol — launch `@spanoai/mcp` over stdio, list + call tools | `@spanoai/mcp`, `spano_write`, `spano_send`, `spano_read` |

## Run them

1. Start the backends (Redis, Postgres, MinIO):

   ```bash
   docker compose up -d
   ```

2. Start the server:

   ```bash
   cd server && bun run src/index.ts
   ```

3. Run all examples (from the repo root):

   ```bash
   bun run examples/run-all.ts
   ```

   …or run one on its own:

   ```bash
   bun run examples/broadcast-fanout/index.ts
   ```

Each example mints its own tenant + API key on startup (via the engine) and
tears the tenant down at the end, so runs are isolated and repeatable. Point
them at a different server with `SPANOAI_API_URL=https://…`.

Every example prints `✅`/`❌` per assertion and exits non-zero if anything
fails — so they double as an integration smoke test.
