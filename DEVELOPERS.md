# SpanoAI — Developer Onboarding

Welcome. This is the single doc to read before touching the SpanoAI codebase.
It covers what the product is, how the repo is laid out, how to run everything
locally, the core engine architecture, the data model, the key concepts you must
internalize, how to add a feature end-to-end, how to test, the gotchas that will
bite you, and where to go next.

For the deep "what/how/why" of every subsystem, read
[`apps/docs/ARCHITECTURE.md`](./apps/docs/ARCHITECTURE.md) — this doc deliberately does not
duplicate it. The live docs site is the Fumadocs app in [`apps/docs/`](./apps/docs)
(`cd apps/docs && bun run dev` → http://localhost:3001).

---

## 1. What is SpanoAI

SpanoAI is a **shared working-memory + coordination backend service for
multi-agent AI systems**, exposed over HTTP + WebSocket. It is the operational
substrate that independent agents use to share live state, hand off work, attach
large outputs, and leave an inspectable trail — without overwriting each other,
losing messages on a crash, or bloating the hot path.

It has three pillars plus two supporting subsystems:

- **Context Store** — namespaced, versioned shared state. Atomic Lua writes with
  version/CAS (`expectedVersion`), `append`, `increment`, `awaitKey`, four
  conflict strategies, TTL, versioned soft-delete, and pgvector semantic search.
- **Message Bus** — durable agent-to-agent delivery over Redis Streams: priority
  inboxes, claim/ack, request/reply, broadcast, reclaim/retry, DLQ. At-least-once
  delivery with `operationId` idempotency.
- **Audit Log** — append-only, durable, replayable causal trail in Postgres
  (transactional per-run `step` allocation + vector clocks).
- **Artifacts** — claim-check file handoff: direct-to-storage presigned upload to
  S3/MinIO, SHA-256 + size verified, 256 KB inline cap routes big data to files.
- **Sessions** — lifecycle, membership, TTL, abort flag, and auto-register.

Stack: **Bun** runtime, **Hono** HTTP framework, **Zod v4** schemas, **ioredis**,
**postgres.js**, **pgvector**, **Bun S3Client**. Monorepo via **Turborepo + Bun
workspaces**. Security: scoped API keys (argon2), namespace ACL, single-use WS
tickets, multi-tenant isolation threaded explicitly via `tenantId`.

See the "What's implemented" table in [`README.md`](./README.md) for a one-line
summary per layer.

---

## 2. Repo / workspace layout

Root is a Turborepo ([`turbo.json`](./turbo.json)) over Bun workspaces declared in
the root [`package.json`](./package.json) (`packageManager: bun@1.3.11`).

| Workspace | Package name | What it is |
|---|---|---|
| [`apps/server/`](./apps/server) | `@spanoai/server` | The engine + HTTP/WebSocket API. All the real logic lives here. |
| [`packages/sdk-typescript/`](./packages/sdk-typescript) | `@spanoai/sdk` | Typed TS client (context / bus / sessions / artifacts) + reconnecting WS client with retry. |
| [`apps/web/`](./apps/web) | `@spanoai/web` | Next.js 15 + shadcn/ui dashboard. Pure API client (key stored in browser). |
| [`apps/docs/`](./apps/docs) | `@spanoai/docs` | Fumadocs (Next.js 16) documentation site — concepts, cookbook, API reference. |
| [`examples/`](./examples) | (not a workspace) | Five runnable, self-asserting example apps that double as integration tests. Run with `bun`. |

Inside `apps/server/src/` (the part you will spend most time in):

| Path | Responsibility |
|---|---|
| `config.ts` | Validated, frozen env config (Zod). Single source — nothing else reads `process.env`. |
| `redis.ts` | Three lazy ioredis connections: `redis` (cmd), `redisPub`, `redisSub`. |
| `db/client.ts`, `db/migrate.ts`, `db/migrations/` | postgres.js client, idempotent migration runner, `001`–`007` SQL files. |
| `engine.ts` | **Composition root** — the only file that knows the concrete backends. Wires everything. |
| `index.ts` | Process entry point: boots engine, serves `Bun.serve`, starts jobs, graceful shutdown. |
| `api/app.ts` | Hono app: every route. `api/middleware.ts` (auth + rate limit), `api/errors.ts`. |
| `models/` | Zod schemas + types: `context-entry.ts`, `agent-message.ts`, `audit-entry.ts`, `artifact.ts`, `session.ts`. |
| `backends/` | `interfaces.ts` (the abstraction boundary) + impls: `redis-store.ts`, `redis-bus.ts`, `postgres-audit.ts`, `postgres-artifacts.ts`, `object-storage.ts`, `pgvector-search.ts`. |
| `context-store/` | `ContextStore` facade (`index.ts`) + `conflict.ts` (pure TS mirror of the Lua). |
| `message-bus/` | `MessageBus` facade (`index.ts`) + `stream-scheduler.ts`. |
| `audit-log/` | `AuditLog` (`index.ts`) + `vector-clock.ts` + `replay-engine.ts`. |
| `artifacts/`, `sessions/` | `ArtifactService` and `SessionService` facades. |
| `auth/` | `principal.ts` (`AgentPrincipal`, `Scope`, ACL helpers), `api-keys.ts`, `tenants.ts`. |
| `search/embedder.ts` | Pluggable `Embedder` (default off; `HashEmbedder` for dev/tests). |
| `jobs/index.ts` | Background jobs runner (sweeper, session cleaner, artifact retention, audit drain). |
| `limits.ts`, `errors.ts`, `observability.ts`, `ws-broadcaster.ts` | Claim-check/path safety, `EngineError`, Prometheus metrics, WS fan-out. |

---

## 3. Prerequisites + run it locally

**Prereqs:** Bun ≥ 1.3 (the repo pins `bun@1.3.11`), Docker (for Redis + Postgres
+ MinIO). On Windows the project runs in PowerShell; a Git Bash shell also works.

Commands (verified against the `scripts` in each `package.json`):

```bash
# 1. Start infrastructure: Redis, Postgres/pgvector, MinIO (+ one-shot bucket setup).
#    MinIO console: http://localhost:9001  (minioadmin / minioadmin)
docker compose up -d

# 2. Install all workspace deps.
bun install

# 3. Apply DB migrations (idempotent, ledgered in schema_migrations).
bun run db:migrate          # → bun run --filter=@spanoai/server db:migrate

# 4. Run the engine (HTTP+WS on :8000; health probe at /health).
bun run dev                 # → turbo run dev (runs server in --watch)
#    or just the server:    cd apps/server && bun run dev   (bun run --watch src/index.ts)

# 5. Run the test suite (needs Docker up — tests hit Redis DB 1 + a spanoai_test DB).
bun test --cwd apps/server       # or: cd apps/server && bun test

# 6. Run an example (needs the server running on :8000).
bun run examples/run-all.ts                 # all five, with a pass/fail summary
bun run examples/broadcast-fanout/index.ts  # just one

# 7. Docs site (Fumadocs) on :3001.
cd apps/docs && bun run dev      # next dev -p 3001  → http://localhost:3001

# 8. Dashboard on :3000 (with the engine running on :8000).
cd apps/web && bun run dev       # next dev -p 3000  → http://localhost:3000
```

Other root tasks (Turborepo): `bun run build`, `bun run typecheck`, `bun run test`,
`bun run lint`, `bun run clean`.

**Getting an API key.** Three ways:

1. **Dashboard** — run `bun run --filter @spanoai/web dev`, sign up (email +
   password — this provisions a tenant), then mint scoped keys from the **API
   Keys** page. This is the real user flow.
2. **HTTP** — `POST /auth/signup` → `{ token }`, then `POST /keys` with
   `Authorization: Bearer <token>` (see [`apps/server/src/api/app.ts`](./apps/server/src/api/app.ts)).
   Accounts live in [`apps/server/src/auth/users.ts`](./apps/server/src/auth/users.ts);
   session tokens in [`dashboard-tokens.ts`](./apps/server/src/auth/dashboard-tokens.ts).
3. **CLI / scripting** — mint a tenant + key straight from the engine:
   `bun run apps/server/scripts/admin-key.ts mint <name>`
   ([`examples/_shared/bootstrap.ts`](./examples/_shared/bootstrap.ts) does the
   same in-process). To seed the dashboard with realistic data and print a key,
   run [`examples/seed-demo.ts`](./examples/seed-demo.ts).

Config defaults live in [`.env.example`](./.env.example) and match
`docker-compose.yml`, so the above Just Works with no `.env`.

---

## 4. Core engine architecture (request lifecycle)

The composition root is [`apps/server/src/engine.ts`](./apps/server/src/engine.ts):
`createEngine()` is the only place that instantiates concrete backends and wires
them into the facades. Everything else depends on the interfaces in
`apps/server/src/backends/interfaces.ts` (deliberate dependency inversion — tests inject
fakes/isolated connections).

An HTTP request flows like this:

1. **`Bun.serve`** in [`index.ts`](./apps/server/src/index.ts) feeds requests to the
   Hono app's `fetch` and routes WS upgrades to `websocket`.
2. **Hono app** ([`api/app.ts`](./apps/server/src/api/app.ts)) applies CORS + a metrics
   timer to every request. `/health` and `/metrics` are public.
3. **Auth middleware** ([`api/middleware.ts`](./apps/server/src/api/middleware.ts)) runs
   on every protected route prefix (`/context/*`, `/messages/*`, `/audit/*`,
   `/artifacts/*`, `/sessions/*`, `/stream-ticket`). It reads `X-SpanoAI-Key`,
   resolves it via `ApiKeyService.verify()`
   ([`auth/api-keys.ts`](./apps/server/src/auth/api-keys.ts)) → an **`AgentPrincipal`**
   `{ tenantId, agentId, scopes[], namespaces? }`, where `agentId` comes from the
   optional `X-SpanoAI-Agent` header (falls back to the key id). The principal is
   set on the Hono context.
4. **Rate limit** — per-tenant fixed-window counter (Redis `INCR` + `EXPIRE`),
   default 6000 req/min (`SPANOAI_RATE_LIMIT_PER_MINUTE`), → 429 over limit.
5. **Route handler** pulls the principal (`P(c)`), merges path params + body, and
   calls the relevant **facade** method, passing the principal through.
6. **Facade** (e.g. `ContextStore.write`, [`context-store/index.ts`](./apps/server/src/context-store/index.ts))
   validates input with Zod, enforces **scope + namespace + tenant** via the
   helpers in [`auth/principal.ts`](./apps/server/src/auth/principal.ts)
   (`requireTenant` / `requireScope` / `requireNamespace`), checks claim-check size
   (`limits.ts`), then calls the **backend**.
7. **Backend** does the durable work: `RedisStore` runs an atomic Lua script;
   `RedisBus` uses Streams; `PostgresAudit`/`PostgresArtifactStore`/`PgVectorSearch`
   hit Postgres; `BunObjectStorage` presigns S3/MinIO.
8. **Audit + broadcast** — the facade durably appends an `AuditEntry` (the source
   of truth) and fires a **best-effort** WebSocket broadcast (`ws-broadcaster.ts`)
   that never blocks and swallows errors.

The principal is **optional** on facades: absent = trusted/internal (no ACL
checks, used by jobs/bootstrap); present = enforced. Same code path serves both.

Errors are unified via `EngineError(code, message, httpStatus)`
([`errors.ts`](./apps/server/src/errors.ts)); the response shape is
`{ error, message, code, docs, requestId }`.

---

## 5. Data model & backends

Each store does what it is best at (full table in `ARCHITECTURE.md` §2):

- **Redis** = live state + queues. Holds context entries (as a single JSON
  string), message Streams, sessions, pub/sub wake-ups, rate-limit counters,
  vector clocks, idempotency records, the WS replay buffer, and the audit-retry
  buffer. Atomicity comes from **Lua scripts** (`defineCommand`) and durable
  delivery from **Streams**. Keys are namespaced by tenant: `spanoai:t:<tid>:...`.
- **Postgres** = durable + relational. The append-only **audit log** (with
  transactional `step` allocation from `audit_run_counters`, partitioned by
  tenant), **tenants**, **api_keys**, and **artifact metadata**. Also hosts
  **pgvector** context embeddings.
- **S3 / MinIO** = artifact **bytes** only. Files never flow through the API; they
  go client → object storage via presigned URLs.

**Migrations** live in
[`apps/server/src/db/migrations/`](./apps/server/src/db/migrations) (`001_tenants.sql`,
`002_api_keys.sql`, `003_auth_tokens.sql`, `004_audit_log.sql`,
`005_context_embeddings.sql`, `006_artifacts.sql`, `007_api_key_namespaces.sql`).
The runner ([`db/migrate.ts`](./apps/server/src/db/migrate.ts)) applies each `*.sql`
once in lexical order, recording it in `schema_migrations`; multi-statement files
go over the simple protocol (one implicit transaction each). Add a new migration
by dropping in the next `NNN_*.sql` file — the runner picks it up.

Wire contracts are Zod schemas in `apps/server/src/models/`. The canonical types:
`ContextEntry`, `AgentMessage`, `AuditEntry`, `Artifact`, `AgentPrincipal`
(documented in `ARCHITECTURE.md` §5). All timestamps are **epoch-ms numbers**, not
`Date`, so they round-trip losslessly through Redis Lua / JSON.

---

## 6. Key concepts (must-know)

- **Sessions** — a `sessionId` is the coordination scope for context, messages,
  and artifacts. Sessions have a TTL (refreshed on activity), a member roster, and
  an **abort flag** (cancellation channel). Crucially, context/message writes
  **auto-register** a session via `SessionService.touch()` so a run surfaces in
  `/sessions` even if `createSession` was never called.
- **Namespaces** — the first dotted segment of a key. A `ContextEntry` is
  addressed by `fullKey = "<namespace>.<key>"`. A namespace-scoped API key may only
  touch namespaces in its allowlist (else 403).
- **The `SAFE_ID` rule** — `sessionId`, `namespace`, `key`, and agent ids must
  match `^[A-Za-z0-9_.\-]{1,256}$` (see `SAFE_ID` in
  [`models/context-entry.ts`](./apps/server/src/models/context-entry.ts)). Dots are
  allowed (namespacing); **colons are not**, because `:` is the Redis key
  delimiter — this prevents key-injection / crossing key boundaries.
- **`operationId` idempotency** — every mutating call carries an `operationId`
  (the SDK generates one client-side and **reuses it across retries**). The Lua
  script replays the original result for a repeated `operationId` instead of
  applying a second version. This is how at-least-once delivery + network retries
  stay safe.
- **Claim-check** — inline context values / message payloads are capped at 256 KB
  (`SPANOAI_MAX_INLINE_BYTES`, enforced in [`limits.ts`](./apps/server/src/limits.ts)).
  Anything larger must be uploaded as an **artifact** and shared as a reference.
  Files themselves are uncapped (object storage).
- **`awaitKey`** — block until a key satisfies a predicate (default: exists) or
  times out. **Lost-wakeup-safe**: subscribes to live events *before* the first
  read, always re-reads on wake, and polls as a fallback. A predicate enables
  **barriers** ("wait until this list has ≥ N items").
- **request / reply** — `request` dispatches a message and blocks for its
  correlated reply (keyed by message id) with a timeout; the responder calls
  `reply()`, which records the reply under a TTL'd key and acks the original.
- **broadcast** — fan-out: one logical send becomes one durable message per
  recipient (each with its own id, under a shared `traceId`).
- **DLQ** — a claimed-but-unacked message idle past the visibility timeout
  (`SPANOAI_VISIBILITY_TIMEOUT_MS`, 30 s) is reclaimed by the sweeper, retried with
  `retryCount + 1`, and **dead-lettered** after `maxRetries`. `listDlq` /
  `replayDlq` inspect and re-dispatch dead letters (a fresh id + `operationId`).

---

## 7. How to add a feature (e.g. a new context op or API route)

Work outward from the data, in this order — each layer has one home:

1. **Model** ([`apps/server/src/models/`](./apps/server/src/models)) — add/extend the Zod
   schema + type. Use `safeId(...)` for any field that becomes part of a Redis key.
2. **Backend** ([`apps/server/src/backends/`](./apps/server/src/backends)) — add the method
   to the relevant interface in `interfaces.ts`, then implement it. For a context
   mutation that must be race-free, write a **Lua script** in `redis-store.ts`,
   register it with `defineCommand`, and add its typed signature to the
   `declare module "ioredis"` block. (Follow the existing
   `WRITE_SCRIPT`/`APPEND_SCRIPT`/`INCREMENT_SCRIPT` pattern — see the gotchas
   below about cjson before you encode any value in Lua.)
3. **Service / facade** (e.g. [`context-store/index.ts`](./apps/server/src/context-store/index.ts))
   — validate the input, call `requireTenant` / `requireScope` / `requireNamespace`,
   enforce `assertInlineSize` where payloads are involved, call the backend, then
   `audit.append(...)` and `emit(...)` (best-effort broadcast). Skip the audit +
   broadcast when `result.idempotentReplay` is true.
4. **Route** ([`api/app.ts`](./apps/server/src/api/app.ts)) — add the Hono handler under
   the right prefix (so auth + rate limit already apply), pull the principal with
   `P(c)`, merge params/body, default the agent identity to `p.agentId`, call the
   facade, and return the JSON with the right status code.
5. **SDK method** ([`packages/sdk-typescript/src/client.ts`](./packages/sdk-typescript/src/client.ts))
   — add the typed method on the relevant `*Api` class; generate an `operationId`
   client-side for any mutating op (`opts.operationId ?? crypto.randomUUID()`).
   Add types to `packages/sdk-typescript/src/types.ts`.
6. **Test** ([`server/tests/`](./server/tests)) — a `bun:test` unit/integration test
   (see §8). For a coordination guarantee, add a concurrency test
   (`coordination.test.ts` style). Consider extending an `examples/` app if it is a
   user-facing pattern.

If you add a new `Scope`, define it in
[`auth/principal.ts`](./apps/server/src/auth/principal.ts) and enforce it in the facade.
If you add a new env knob, declare it in [`config.ts`](./apps/server/src/config.ts) and
document it in `.env.example`.

---

## 8. Testing

- **Unit / integration tests** — `bun:test`, in
  [`server/tests/`](./server/tests). They run against the Docker Redis + Postgres,
  isolated to **Redis DB index 1** and a dedicated **`spanoai_test`** database
  created on demand (see [`tests/setup.ts`](./server/tests/setup.ts), which also
  provides `InMemoryAudit`, `CollectingBroadcaster`, and `waitFor`). Run with
  `bun test --cwd apps/server`. Notable suites: `redis-store.test.ts`,
  `coordination.test.ts` (append/increment/CAS concurrency), `redis-bus.test.ts`
  (claim/ack/reclaim/DLQ), `audit-log.test.ts` (step ordering), `security.test.ts`
  (scopes/namespace/cross-tenant), `resilience.test.ts` (Postgres-down buffering),
  `value-fidelity.test.ts` (the cjson fix), `routes.test.ts`, `sdk-e2e.test.ts`.
- **Live E2E script** — [`server/scripts/e2e.ts`](./server/scripts) and sibling
  probes (`qa-probe.ts`, `coordination-gaps.ts`, `ws-smoke.ts`,
  `artifact-scenario.ts`) drive a running engine.
- **Examples as integration tests** — the four apps in
  [`examples/`](./examples) are real SDK-over-HTTP clients that **assert their own
  behaviour** and exit non-zero on failure. Each mints its own tenant + key and
  tears it down. `bun run examples/run-all.ts` aggregates them into a pass/fail
  summary (and fails fast if no server is reachable). They are how we verify the
  engine behaves the way the docs claim.

---

## 9. Gotchas / lessons (read before you debug)

- **cjson is lossy — never re-encode a value through it.** Redis's Lua `cjson`
  encodes empty arrays as `{}` and formats numbers with `%.14g` (precision loss
  past ~14 digits). The fix in [`backends/redis-store.ts`](./apps/server/src/backends/redis-store.ts):
  the client sends the entry JSON **without** a `version`, and the Lua injects the
  authoritative version into the verbatim string (`'{"version":N,' .. sub(json,2)`),
  so values/tags/numbers are stored byte-for-byte. **Residual edge:** `append`
  items and `increment` values are still built in Lua, so a nested empty array or a
  >15-digit number inside those can still hit the cjson edge. If you write new Lua
  that touches a user value, do not `cjson.encode` it — use the string-injection
  pattern.
- **Lua is the source of truth.** All conflict resolution + version assignment
  happen inside one atomic Lua script. `context-store/conflict.ts` is a pure-TS
  **mirror** for unit testing / executable docs only — keep them in sync, but the
  Lua wins.
- **Redis fast-fail → 503.** `redis.ts` sets `commandTimeout`
  (`SPANOAI_REDIS_COMMAND_TIMEOUT_MS`, default 10 s) so commands fail fast during a
  Redis outage instead of hanging; the API maps the timeout / closed-connection to a
  `503 SERVICE_UNAVAILABLE` (`apps/server/src/api/errors.ts`). All engine commands are
  non-blocking and sub-ms, so this ceiling never trips normally.
- **WS auth uses single-use tickets, not the API key in the URL.** Mint a ticket
  over HTTP (`POST /stream-ticket`, bound to `{tenant, sessionId}`, 30 s TTL), then
  connect to `WS /stream/:sessionId?ticket=...`. The server consumes it with
  `GETDEL`. This keeps the API key out of WS URLs / proxy logs. The SDK's
  `stream()` does this automatically and reconnects with backoff + `lastSeq` gap
  recovery.
- **Stale dev server on a port.** Bun's `--watch` plus a crashed/orphaned process
  can leave port 8000 (or 3000/3001) held, so your new server silently binds
  nothing or you talk to old code. On Windows, find and kill it:
  ```powershell
  Get-NetTCPConnection -LocalPort 8000 | Select-Object -Expand OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }
  ```
- **Docs require Next 16 / React 19.2.** The `apps/docs/` workspace pins
  `next@^16.2.0` + `react@^19.2.0` (Fumadocs). The `apps/web/` dashboard is on
  Next 15 / React 19. Don't cross-pin them. Run `bunx fumadocs-mdx` (the docs
  `postinstall`) after changing MDX/source config.
- **Sessions vs context are decoupled.** `sessionId` is just a namespace string in
  context/message calls; auto-register via `touch()` is best-effort and never
  blocks a write. A run only carries rich metadata if `sessions.create()` was
  called.
- **Audit is awaited but resilient.** A Postgres outage does not block writes:
  failed audit appends buffer into a Redis list (`spanoai:audit:retry`) and a drain
  job replays them once Postgres recovers (`audit-log/index.ts`).

---

## 10. Where to go next

- [`apps/docs/ARCHITECTURE.md`](./apps/docs/ARCHITECTURE.md) — the authoritative
  what/how/why for every subsystem, the reliability-guarantees table, the
  technical-decisions log, and known limitations. Read this next.
- [`INTEGRATIONS_IMPLEMENTATION_PLAN.md`](./INTEGRATIONS_IMPLEMENTATION_PLAN.md) —
  the roadmap for the distribution layer: an `@spanoai/mcp` MCP server (highest
  priority), a Python SDK, and per-framework adapters (Claude Agent SDK, Google
  ADK, Vercel AI SDK, OpenAI, Mastra, LangChain). Golden rule there: **do not
  refactor the engine** — integrations are pure clients of the existing API.
- [`packages/sdk-typescript/src/client.ts`](./packages/sdk-typescript/src/client.ts) — the canonical
  client surface (`context` / `bus` / `sessions` / `artifacts` / `stream`) that
  every integration wraps.
- [`server/README.md`](./server/README.md) and the live docs site
  (`cd apps/docs && bun run dev`, http://localhost:3001) — engine internals and the
  concepts/cookbook/API reference.
- [`examples/`](./examples) — read these to see real coordination patterns end to
  end before writing your own.
