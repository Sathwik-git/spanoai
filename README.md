<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
  <img alt="SpanoAI" src=".github/assets/logo-light.svg" width="300">
</picture>

<p><b>Shared working memory <i>and</i> a durable message bus for multi-agent AI systems.</b><br/>
A live, versioned, conflict-resolved state store with durable agent messaging and an immutable causal audit trail.</p>

<p>
  <a href="./apps/docs/content/docs">Docs</a> ·
  <a href="#quick-start">Quickstart</a> ·
  <a href="./DEPLOYMENT.md">Self-host</a> ·
  <a href="./apps/web">Dashboard</a> ·
  <a href="#integrations">Integrations</a>
</p>

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/@spanoai/sdk"><img src="https://img.shields.io/badge/npm-%40spanoai%2Fsdk-CB3837?logo=npm&logoColor=white" alt="npm @spanoai/sdk"></a>
  <a href="https://pypi.org/project/spanoai/"><img src="https://img.shields.io/badge/pypi-spanoai-3775A9?logo=pypi&logoColor=white" alt="PyPI spanoai"></a>
  <img src="https://img.shields.io/badge/built%20with-Bun-111?logo=bun&logoColor=white" alt="Built with Bun">
</p>

</div>

## Repository structure

This repository is a **Turborepo** monorepo (Bun workspaces), split into
deployable **apps** and publishable **packages**.

```
spanoai/
├── apps/                        # things you run / deploy
│   ├── server/                  # core engine + HTTP/WebSocket API (Bun + Hono)
│   ├── web/                     # Next.js dashboard
│   └── docs/                    # documentation site (Fumadocs)
├── packages/                    # things you publish / import
│   ├── sdk-typescript/          # @spanoai/sdk  → npm
│   ├── sdk-python/              # spanoai       → PyPI
│   └── mcp/                     # @spanoai/mcp  → npm (Model Context Protocol server)
├── examples/                    # runnable, self-asserting demo apps
├── notes/                       # design notes & comparison write-ups (not built)
├── package.json                 # workspaces: ["apps/*", "packages/*"]
├── turbo.json                   # build / test / typecheck pipeline
├── tsconfig.base.json           # shared TS config
└── docker-compose.yml           # Redis + Postgres/pgvector + MinIO (local infra)
```

Workspace names: `@spanoai/server`, `@spanoai/web`, `@spanoai/docs`,
`@spanoai/sdk`, `@spanoai/mcp` (the Python package is `spanoai`). The CLI and
billing are future phases.

## What's implemented

| Layer | What it does | Backend |
|---|---|---|
| **Context Store** | Namespaced, versioned shared state with `operationId` idempotency, `expectedVersion` CAS, four conflict strategies, TTL, versioned soft-delete. | Redis (atomic Lua) |
| **Coordination primitives** | Atomic list **append** + **increment** (no lost updates), **awaitKey** (watch/barrier, lost-wakeup-safe), and **request/reply** (correlated, with timeout). | Redis |
| **Message Bus** | Durable agent-to-agent delivery via Redis Streams consumer groups — priority inboxes, claim/ack, reclaim/retry, DLQ, reply, bounded streams. Pub/Sub is only a wake-up hint. | Redis Streams |
| **Audit Log** | Append-only causal trail with transactional per-run step allocation, vector clocks, replay, run-diff, signed export — **buffers to Redis if Postgres is down** (writes never blocked). | Postgres |
| **Artifacts (files)** | Direct-to-storage presigned upload; size + SHA-256 verified on completion; private, tenant/session-scoped, short-lived download URLs; quarantine hook; soft-delete; retention. | MinIO/S3/R2 |
| **Sessions** | Lifecycle (create/join/leave/end), membership, TTL, and an **abort flag** for cancellation propagation. | Redis |
| **Semantic search** | Embed-on-write + pgvector cosine query (pluggable embedder). | Postgres/pgvector |
| **Auth + ACL** | API keys (argon2, cached verify), `AgentPrincipal` with **scopes + namespace allowlist** enforced on every facade. | Postgres + Redis |
| **HTTP/WS API** | Hono routes for all of the above + auth, per-tenant rate limit, unified errors, Prometheus `/metrics`, and a live WebSocket stream with gap recovery. | Bun + Hono |
| **TypeScript SDK** | Typed client (context / bus / sessions / artifacts / stream) with retry + a reconnecting WS client. | — |
| **Dashboard** | Next.js 15 + shadcn/ui: **email/password signup + login**, **API-key management** (create scoped keys, reveal once, revoke), overview metrics, sessions list, **live WebSocket session view** (events + context + audit), settings. | Next.js |
| **Background jobs** | Reclaim sweeper, session cleaner, artifact retention, audit drain. | — |

Everything is composed in [`apps/server/src/engine.ts`](./apps/server/src/engine.ts) — the
only file that knows the concrete backends. Everything else depends on the
interfaces in `apps/server/src/backends/interfaces.ts`.

## Quick start

```bash
# 1. Start infrastructure (Redis + Postgres/pgvector + MinIO object storage)
#    MinIO console: http://localhost:9001 (minioadmin / minioadmin)
docker compose up -d

# 2. Install + migrate
bun install
bun run db:migrate

# 3. Run the engine (health probe on :8000/health)
bun run dev

# 4. Run the test suite (needs Docker running)
bun test --cwd apps/server
```

## Monorepo tasks (Turborepo)

```bash
bun run build       # turbo run build
bun run typecheck   # turbo run typecheck
bun run test        # turbo run test
bun run db:migrate  # apply SQL migrations
```

## Reliability guarantees (verified by tests)

- **Idempotent writes** — replaying the same `operationId` never creates a second version.
- **Optimistic concurrency** — 100 concurrent writes to one key with the same `expectedVersion` yield exactly one winner; the other 99 are `409 CONFLICT`.
- **Versioned soft-delete** — a stale write cannot resurrect a deleted key; restore requires `allowRestore` + matching `expectedVersion`.
- **At-least-once messaging** — a crashed consumer's unacked messages are reclaimed (`XAUTOCLAIM`), retried, then dead-lettered past `maxRetries`.
- **Durable replay order** — audit `step` is allocated transactionally per `(tenant, run)`; 50 concurrent appends produce a contiguous, unique 1..50 sequence even across server instances.
- **No lost updates** — 100 concurrent `append`s to one list keep all 100; 100 concurrent `increment`s sum exactly (atomic Lua).
- **Claim-check sizing** — inline values/payloads are capped (default 256KB, configurable) and rejected with `PAYLOAD_TOO_LARGE`; larger data must be an artifact. Files themselves are **uncapped** (they live in object storage), with an optional soft cap as a cost lever.
- **Artifact integrity & isolation** — size + SHA-256 verified on completion (mismatches rejected); download URLs are short-lived; cross-tenant / cross-session access returns 404.
- **Per-agent ACL** — a namespace-scoped key cannot read or write outside its allowlist (403); cross-tenant principals are rejected.
- **Availability** — a Postgres outage does not block context writes; audit entries buffer in Redis and drain on recovery.
- **Tenant isolation** — `tenantId` is threaded explicitly through every backend call and embedded in every Redis key / Postgres row / object-storage path.

## SDK usage

```ts
import { SpanoAIClient } from "@spanoai/sdk";

const spano = new SpanoAIClient({ baseUrl: "http://localhost:8000", apiKey, agent: "researcher" });
await spano.context.write("run-1", "researcher", "findings", { revenue: "$4.2M" });
const data = await spano.context.read("run-1", "researcher", "findings");
const reviewed = await spano.context.awaitKey("run-1", "coder", "result", { timeoutMs: 30_000 });
const { reply } = await spano.bus.request("run-1", "researcher", "ask", { text: "revenue?" });
const stream = spano.stream("run-1", { onEvent: (e) => console.log(e) });
```

## Integrations

Use SpanoAI from any agent stack — see [the integrations docs](./apps/docs/content/docs/integrations).

```bash
npm i @spanoai/sdk        # TypeScript SDK  (./packages/sdk-typescript)
pip install spanoai       # Python SDK      (./packages/sdk-python)
npx @spanoai/mcp          # MCP server      (./packages/mcp)
```

The **MCP server** ([`packages/mcp/`](./packages/mcp)) exposes every operation as an MCP tool, so
Claude Desktop, Cursor, the Claude Agent SDK and Google ADK's `MCPToolset` get
them with zero glue:

```bash
SPANOAI_API_KEY=spanoai_sk_... SPANOAI_SESSION=run-1 npx @spanoai/mcp
```

The **Python SDK** ([`packages/sdk-python/`](./packages/sdk-python)) mirrors the TypeScript SDK 1:1
(sync + async), unlocking the Python agent ecosystem (Google ADK, the Claude
Agent SDK for Python, LangGraph, CrewAI):

```python
from spanoai import SpanoAI
spano = SpanoAI(api_key="spanoai_sk_...", agent="planner")
spano.context.write("run-1", "planner", "goal", {"task": "ship it"})
res = spano.bus.request("run-1", "reviewer", "review", {"data": {"pr": 1}}, timeout_ms=5000)
```

## Dashboard

```bash
# with the engine running on :8000
cd apps/web && bun run dev     # http://localhost:3000
```

**Sign up**, then create scoped API keys from the **API Keys** page and watch a live
overview, the sessions list, and a real-time session view (WebSocket event
feed + context + audit). The dashboard authenticates as a logged-in user (a session
token stored only in the browser) and talks to the engine purely over its HTTP API.
UI built from shadcn/ui v4 components (`apps/web/`).

See [`apps/server/README.md`](./apps/server/README.md) for architecture detail.
