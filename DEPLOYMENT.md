# Deploying SpanoAI

SpanoAI self-hosts cleanly. This guide covers running it in production: the
required **engine**, plus the optional dashboard, docs site, and remote MCP
server.

## What you deploy

| Component | Path | Required? | Notes |
|---|---|---|---|
| **Engine** (HTTP + WS API) | `apps/server` | ✅ Yes | The product. Stateless — scale horizontally. |
| **Dashboard** | `apps/web` | Optional | Next.js app; pure API client. |
| **Docs site** | `apps/docs` | Optional | Next.js (Fumadocs). |
| **Remote MCP server** | `packages/mcp` | Optional | Streamable-HTTP MCP for hosted/remote connectors. |

The engine keeps **no local state** — all state lives in its backends. You can
run many engine instances behind a load balancer.

## 1. Provision the backends

The engine needs three backends (managed services or self-run):

| Backend | Purpose | Notes |
|---|---|---|
| **Redis 7+** | Live state, queues, pub/sub, rate limit | Needs persistence (AOF) for durability. |
| **Postgres 16 + `pgvector`** | Audit log, metadata, semantic search | The `vector` extension must be available. |
| **S3-compatible storage** | Artifacts (file bytes) | AWS S3, Cloudflare R2, or MinIO. |

For a quick single-box deploy, `docker-compose.yml` brings up all three locally.
For production, prefer managed Redis + Postgres (e.g. with `pgvector` enabled)
and S3/R2.

## 2. Configure the environment

Copy `.env.example` to `.env` and set every value for your infrastructure. The
key variables:

```bash
NODE_ENV=production
PORT=8000

REDIS_URL=redis://:PASSWORD@your-redis-host:6379
DATABASE_URL=postgresql://USER:PASSWORD@your-pg-host:5432/spanoai

# Object storage (artifacts)
S3_ENDPOINT=https://s3.your-region.amazonaws.com   # or your R2/MinIO endpoint
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=spanoai-artifacts
S3_REGION=us-east-1

# Lock CORS down to the origins that may call the API from a browser
CORS_ORIGIN=https://app.example.com

# Semantic search embedder: "hash" (dependency-free) or "none".
# For real semantic recall in production, inject a model embedder in code
# (createEngine({ embedder })) instead.
SPANOAI_EMBEDDER=hash
```

See `.env.example` for the full, commented list (TTLs, claim-check size, presign
lifetimes, etc.).

## 3. Run database migrations

Apply the SQL migrations once per database (and after upgrades):

```bash
bun run db:migrate          # from the repo root
# or, in Docker:
docker run --rm --env-file .env spanoai-server bun run src/db/migrate.ts
```

The runner is idempotent and tracks applied migrations in `schema_migrations`.

## 4. Run the engine

**With Docker** (recommended):

```bash
# Build from the repo root
docker build -f apps/server/Dockerfile -t spanoai-server .

# Run (after migrations)
docker run -d --env-file .env -p 8000:8000 --name spanoai spanoai-server
```

**With Bun** (no container):

```bash
bun install
NODE_ENV=production bun run --filter @spanoai/server start   # or: bun apps/server/src/index.ts
```

Then put it behind a reverse proxy that terminates TLS and forwards both HTTP
and **WebSocket upgrades** (the live stream uses WS) to `:8000`.

- **Health:** `GET /health` → `200` when Redis + Postgres are reachable, `503`
  otherwise. Wire this to your load balancer / orchestrator.
- **Metrics:** `GET /metrics` (Prometheus format).

## 5. Scaling & operations

- **Stateless engine** — run N replicas behind a load balancer. State lives in
  Redis/Postgres/object-storage; the WebSocket fan-out uses Redis pub/sub so a
  client connected to any replica sees events produced on any other.
- **Background jobs** (reclaim sweeper, session cleaner, artifact retention,
  audit drain) run inside every engine process and are safe to run concurrently.
- **Availability** — a Postgres outage does not block context writes; audit
  entries buffer in Redis and drain on recovery. A Redis outage fails requests
  fast (`503`) rather than hanging.
- **Backups** — back up Postgres (audit + metadata) and your object-storage
  bucket. Redis holds live working state; enable AOF persistence.

## 6. Deploy the dashboard & docs (optional)

Both are standard Next.js apps:

```bash
bun run --filter @spanoai/web build && bun run --filter @spanoai/web start    # :3000
bun run --filter @spanoai/docs build && bun run --filter @spanoai/docs start  # :3001
```

Or deploy them to any Next.js host (e.g. Vercel). The dashboard is a pure API
client — point users at your engine URL; the API key is stored only in the
browser.

## 7. Deploy the remote MCP server (optional)

To let hosted MCP clients (e.g. a claude.ai custom connector) reach SpanoAI,
run the Streamable-HTTP MCP server and expose it over HTTPS:

```bash
SPANOAI_API_KEY=sk_... SPANOAI_API_URL=https://your-engine.example.com \
SPANOAI_SESSION=run-1 SPANOAI_AGENT=web PORT=8787 \
bun packages/mcp/src/http-server.ts
# serves POST/GET /mcp  → point the connector at https://<host>/mcp
```

Identity can also be carried per-connection in the URL path
(`/mcp/<agent>`), so several clients can share one session as distinct agents.

## Production checklist

- [ ] Managed Redis (AOF on) + Postgres with `pgvector` + S3/R2 bucket created
- [ ] `.env` set; `NODE_ENV=production`; `CORS_ORIGIN` locked to real origins
- [ ] `bun run db:migrate` applied
- [ ] Engine behind TLS reverse proxy with WebSocket upgrade forwarding
- [ ] `/health` wired to the load balancer; `/metrics` scraped
- [ ] Postgres + object-storage backups scheduled
- [ ] API keys issued per tenant/agent with least-privilege scopes
