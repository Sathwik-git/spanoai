# SpanoAI — Architecture & Technical Decisions

> Shared working memory for multi-agent AI systems: a live, versioned,
> conflict-resolved state store with durable agent messaging, an immutable
> causal audit trail, file artifacts, semantic search, and a live dashboard
> stream. This document explains **what** each part does, **how** it works, and
> **why** it is built this way.

---

## 1. The problem

Independent AI agents that work on the same task need a place to:

- **share live state** without silently overwriting each other,
- **send durable messages / hand off work** without losing them on a crash,
- **attach large outputs** (files, reports) without bloating the hot path,
- **leave an inspectable trail** of who did what, in what order.

SpanoAI is the operational layer between agents that provides exactly this —
not a replacement for Redis, a vector DB, or an orchestration framework, but the
missing **coordination substrate**.

The hard parts are classic distributed-systems problems: concurrency, race
conditions, duplicate operations (retries), delivery guarantees, ordering, large
payloads, tenant isolation, and durable replay. Every decision below is in
service of getting those right.

---

## 2. System architecture

```
        Agents (LangChain / CrewAI / custom / any HTTP)  +  Dashboard
                              │ HTTP + WebSocket
        ┌─────────────────────▼─────────────────────────────────────┐
        │            API (Hono on Bun)                               │
        │  auth → rate-limit → route → facade (scope+namespace ACL)  │
        │  /context /messages /audit /artifacts /sessions /metrics   │
        └───────┬───────────────┬───────────────┬───────────────┬────┘
                │               │               │               │
          ┌─────▼────┐    ┌─────▼─────┐   ┌──────▼─────┐   ┌─────▼──────┐
          │  Redis   │    │ Postgres  │   │  MinIO/S3  │   │  pgvector  │
          │ live     │    │ audit log │   │  artifact  │   │  semantic  │
          │ state    │    │ tenants   │   │  bytes     │   │  index     │
          │ streams  │    │ api keys  │   │            │   │            │
          │ pub/sub  │    │ artifacts │   │            │   │            │
          └──────────┘    └───────────┘   └────────────┘   └────────────┘
```

Each store is used for what it is best at:

| Store | Holds | Why |
|---|---|---|
| **Redis** | live context, message streams, sessions, pub/sub, rate limits, vector clocks, idempotency, WS replay buffer, audit-retry buffer | in-memory speed for the latency-sensitive hot path; atomic Lua; Streams give durable at-least-once delivery |
| **Postgres** | append-only audit log, tenants, API keys, artifact metadata | durable, transactional (step allocation), relational queries, partitioning |
| **Object storage** (MinIO/S3/R2) | artifact file bytes | scales to GB–TB; never put large blobs in Redis/Postgres |
| **pgvector** | context embeddings | cosine similarity search over shared memory |

The **composition root** is `server/src/engine.ts` — the only file that knows
which concrete backends are used. Everything else depends on the interfaces in
`server/src/backends/interfaces.ts`. This is deliberate dependency inversion: it
keeps the engine testable (swap fakes) and lets storage evolve independently.

---

## 3. Tech stack — and why

| Choice | Why this, not the alternatives |
|---|---|
| **Bun** runtime | Native TS execution (no build step in dev), fast, built-in test runner, native S3 client + password hashing (fewer deps), `Bun.serve` WebSockets. |
| **Hono** framework | First-class TS, tiny, runs on Bun with native WS; `app.request()` lets routes be tested without a network. |
| **Zod v4** | One schema = runtime validation **and** static types. v4 specifics applied: `z.record(z.string(), z.unknown())` (two args), `z.enum(constObject)` (not the deprecated `z.nativeEnum`). |
| **ioredis** | Full Lua (`defineCommand`), Streams, and pub/sub support. Used `lazyConnect` to dodge a Bun build-time DNS issue; `unpack` (not `table.unpack`) in Redis 7 Lua 5.1. |
| **postgres.js** | Fastest JS Postgres client; clean tagged-template transactions. JSONB is written with an explicit `::jsonb` cast (it does not auto-serialise objects); multi-statement migrations use `.simple()`. |
| **Bun S3Client** | Native, no AWS SDK dependency, synchronous presigning, works with MinIO via `endpoint`. |
| **prom-client** | Standard Prometheus metrics. |
| **Turborepo** (v2) | Monorepo task orchestration on top of Bun workspaces. v2 uses the `tasks` key (not `pipeline`). |

These specifics were verified against current official docs before implementation
to avoid version-drift mistakes (Zod v3→v4, Turbo v1→v2, etc.).

---

## 4. Package layout

```
spanoai/                         Turborepo + Bun workspaces
├── server/                      engine + HTTP/WS API
│   └── src/
│       ├── config.ts            validated, frozen env config (single source)
│       ├── redis.ts             3 connections (cmd/pub/sub), lazy-connect
│       ├── engine.ts            composition root — wires backends → components
│       ├── api/                 Hono app, middleware (auth/rate-limit), errors
│       ├── models/              Zod schemas + types (context/message/audit/artifact/session)
│       ├── backends/            interfaces + Redis/Postgres/S3/pgvector impls
│       ├── context-store/       ContextStore facade + conflict reference
│       ├── message-bus/         MessageBus facade + StreamScheduler
│       ├── audit-log/           AuditLog + VectorClock + ReplayEngine
│       ├── artifacts/           ArtifactService lifecycle
│       ├── sessions/            SessionService
│       ├── auth/                AgentPrincipal + ApiKeyService + TenantService
│       ├── search/              Embedder abstraction (+ HashEmbedder)
│       ├── jobs/                background jobs runner
│       ├── observability.ts     Prometheus metrics
│       └── db/migrations/       001–007 SQL
└── sdk-typescript/              @spanoai/sdk — typed client + reconnecting WS
```

---

## 5. Data model (the wire contracts)

- **ContextEntry** — `{tenantId, sessionId, namespace, key, fullKey, value,
  writtenBy, writtenAt(ms), version, confidence, tags, ttlSeconds, isDeleted,
  conflictStrategy, operationId}`. `value` is a discriminated union:
  `text | json | artifact | artifacts`.
- **AgentMessage** — durable work item: `{id, tenantId, sessionId, traceId,
  fromAgent, toAgent, intent, priority(1–5), payload{text?,data?,artifacts[]},
  replyTo?, timeoutMs, operationId, retryCount, maxRetries, status}`.
- **AuditEntry** — `{id, tenantId, runId, step, parentId?, clock, eventType,
  agentId, payload, ts}`. `step` is the durable total order; `clock` is a vector
  clock for causal ordering.
- **Artifact** — file metadata + lifecycle status (`pending → available |
  quarantined | rejected | deleted`); bytes live in object storage.
- **AgentPrincipal** — `{tenantId, agentId, scopes[], namespaces?}`. The ACL
  subject.

`writtenAt`/`ts`/`createdAt` are epoch-ms **numbers** (not `Date`) so they
round-trip losslessly through Redis Lua / JSON.

---

## 6. Subsystems — how & why

### 6.1 Context Store (Redis, atomic Lua)

**How.** Every write/append/increment/delete is a single Lua script executed
atomically by Redis. The script, in order: (1) replays the result if this
`operationId` was already applied (idempotency); (2) enforces `expectedVersion`
CAS; (3) guards against resurrecting a soft-deleted key; (4) resolves the
conflict strategy; (5) assigns the next version and persists the winner +
history + key index. Entries are stored as a **single JSON string**, not a
flattened hash, so nested values/tags/artifact refs round-trip exactly.

**Why Lua.** Conflict resolution + version assignment must be race-free. Doing
read-modify-write in application code allows lost updates under concurrency. A
Lua script runs atomically on Redis's single thread, so 100 concurrent CAS
writes yield exactly one winner per version — verified by test.

**Conflict strategies.** `lww` (last write wins), `conf` (highest confidence
wins; equal keeps existing unless CAS targets it), `merge` (shallow object
merge; arrays replace), `reject` (fail if exists). `context-store/conflict.ts`
is a pure TypeScript mirror of the Lua logic — it exists for unit testing and as
executable documentation; the Lua is the source of truth.

### 6.2 Coordination primitives

The store-level primitives are what make this a coordination layer, not just a
database:

- **`append` / `increment`** — atomic Lua, idempotent by `operationId`. Fixes
  the classic "5 agents accumulate into one list and 4 results vanish" footgun.
  `append` supports `maxItems` (capped ring buffer).
- **`awaitKey`** — block until a key satisfies a predicate (default: exists),
  with a timeout. **Lost-wakeup-safe**: it subscribes to live events *before* the
  first read, always re-reads on wake, and polls as a fallback in case a
  best-effort pub/sub event is missed. A predicate enables **barriers**
  ("wait until this list has ≥ N items").
- **`request` / `awaitReply`** — send a message and block for its correlated
  reply (by message id) with a timeout. The responder's `reply()` records the
  reply under a TTL'd key; the requester polls that key. Late/duplicate replies
  are harmless (the key just expires).

These designs follow established patterns (claim-check, RPC correlation,
subscribe-first-then-read) and mandate timeouts on every blocking call to avoid
deadlock.

### 6.3 Message Bus (Redis Streams)

**How.** Durable delivery uses Redis Streams consumer groups (at-least-once).
`XADD` (capped with `MAXLEN ~`) writes the message before enqueue returns;
`XREADGROUP >` moves it into the consumer's pending list; `XACK` removes it only
after success/reply. Each agent inbox is split across five priority streams
(p5..p1), drained highest-first. A crashed consumer's unacked messages are
reclaimed by a background sweeper (`XAUTOCLAIM` past a 30 s idle threshold),
re-enqueued with `retryCount + 1`, and dead-lettered after `maxRetries`.

**Why Streams, not Pub/Sub.** Pub/Sub drops messages when no subscriber is
connected. Streams persist messages and track per-consumer acknowledgement, so a
disconnected/crashed agent does not lose work. Pub/Sub is used *only* as a
best-effort wake-up hint.

**Why at-least-once.** Exactly-once delivery is not achievable over a queue;
instead, delivery is at-least-once and consumers dedupe by `operationId` /
`message.id`. The SDK generates a stable `operationId` per logical send so a
retried dispatch can be deduped.

### 6.4 Audit Log (Postgres)

**How.** Append-only. `step` is allocated transactionally from
`audit_run_counters` and the row is inserted in the **same transaction**, so the
per-`(tenant, run)` sequence is strictly increasing even across multiple API
instances and restarts — verified by a 50-way concurrent test producing a
contiguous 1..50. Each entry carries a **vector clock** (advanced atomically in
Redis via `HINCRBY`) for causal ordering. The table is `PARTITION BY LIST
(tenant_id)` so enterprise tenants can later get dedicated physical partitions.

**Resilience.** Audit append is on the write path (it is the source of truth for
replay), but a Postgres outage must not block coordination. So if the insert
fails, the entry is **buffered durably in a Redis list** and the write succeeds;
a background drain job replays buffered entries (allocating their real step) once
Postgres recovers. This trades a brief window of unordered audit for
availability, without data loss.

**Replay & export.** `ReplayEngine` streams a run in step order and diffs two
runs (first divergent step). `export` produces a SHA-256-signed JSON snapshot for
compliance.

### 6.5 Artifacts (object storage)

**How.** Files never flow through the API. `initUpload` creates a `pending`
record and returns a **presigned PUT URL**; the client uploads bytes directly to
object storage. `complete` HEADs the object, verifies **size** (always) and
**SHA-256** (by streaming small files back), runs an optional quarantine scan,
then marks it `available`. `downloadUrl` returns a short-lived (5 min) presigned
GET. Access is scoped to `{tenant, session}` (wrong tenant/session → 404, no
existence leak). Filenames are sanitised for the storage key (path-traversal
safe) but preserved for display. A retention job deletes expired bytes.

**Why direct-to-storage.** Proxying file bytes through the API hits body-size
walls and doubles bandwidth. Presigned URLs let the client talk to storage
directly; the API only signs (a tiny request) and verifies on completion.

**Files vs. inline (the size policy).** Two distinct limits:
- **Inline payloads** (context values / message payloads, which live in Redis)
  are capped at **256 KB** by default (`SPANOAI_MAX_INLINE_BYTES`). This is the
  *claim-check threshold*: anything larger must become an artifact. Small inline
  payloads keep the real-time Redis/WS path fast (large Redis values hurt
  latency, replication, and fork-based persistence).
- **Files** are **uncapped** by default — they live in object storage which
  scales to GB–TB. `SPANOAI_MAX_ARTIFACT_BYTES` is an optional cost/abuse lever,
  not a technical limit.

### 6.6 Sessions

`SessionService` owns lifecycle (`create/join/leave/end`), a member roster, a
TTL, and an **abort flag** for cancellation propagation. Lifecycle transitions
are audited. A cleaner job reconciles the session index after TTLs expire.

### 6.7 Semantic search (pgvector)

An **injectable `Embedder`** turns context values into vectors on write
(fire-and-forget) and queries into vectors on search; `PgVectorSearch` does a
cosine (`<=>`) nearest-neighbour query, then the matching entries are fetched.
When no embedder is configured, search returns `[]` and no embeddings are
written (zero overhead). The dependency-free `HashEmbedder` exercises the full
path in dev/tests; production injects a real model (e.g. OpenAI 1536-dim).

### 6.8 Auth & per-agent ACL

- **API keys**: `spanoai_sk_<keyId>_<secret>`. The full key is hashed with
  argon2 (`Bun.password`) at rest; only `keyId` is the public lookup id.
  Hot-path verification is cached in Redis for 5 min — to avoid running argon2
  on every request *without weakening security*, the cache stores a fast SHA-256
  verifier of the full key, so a cache hit still requires the full secret
  (constant-time compared). Revocation deletes the cache entry immediately.
- **AgentPrincipal** carries `scopes` and an optional `namespaces` allowlist.
  Facades take an **optional** principal: absent = trusted/internal (no checks);
  present = scope + namespace + tenant enforced. This is the per-agent ACL — a
  namespace-scoped key cannot read or write outside its allowlist (403), and a
  cross-tenant principal is rejected.

### 6.9 WebSocket broadcaster

Every event gets a per-session monotonic `seq` and is appended to a bounded
Redis replay buffer, then published on a tenant-scoped channel that every server
subscribes to (cross-server fan-out). A reconnecting client sends its `lastSeq`;
`getMissed` returns the gap or signals a reload from the audit log if the gap
exceeds the buffer. Live delivery is best-effort; the audit log is the source of
truth.

### 6.10 Background jobs

`startBackgroundJobs` runs, each wrapped so a failure never crashes the loop:
the **reclaim sweeper** (stuck messages), **session cleaner**, **artifact
retention**, and **audit drain** (replay buffered audit to Postgres).

---

## 7. Reliability guarantees (and how they're met)

| Guarantee | Mechanism | Verified by |
|---|---|---|
| No lost updates on shared collections | atomic Lua append/increment | 100 concurrent appends/increments tests |
| Idempotent writes | `operationId` replay in Lua; SDK reuses op id across retries | store + SDK tests |
| Optimistic concurrency | `expectedVersion` CAS in Lua | 100-way concurrent CAS test |
| Versioned soft-delete, no stale resurrection | resurrection guard in Lua | soft-delete test |
| At-least-once messaging, crash recovery | Streams + consumer groups + XAUTOCLAIM sweeper | reclaim/DLQ tests |
| Durable, strictly-increasing replay order | transactional step allocation | 50-way concurrent append test |
| Writes survive a Postgres outage | audit buffers to Redis + drain job | resilience test |
| Tenant + namespace isolation | tenantId in every key/row; principal ACL | cross-tenant + ACL tests |
| File integrity | size + SHA-256 verified on completion | artifact tests |

---

## 8. Configuration

All config is parsed/validated once in `server/src/config.ts` (frozen). Key
knobs (see that file + `.env.example` for the full list and defaults):
`REDIS_URL`, `DATABASE_URL`, `S3_*`, `SPANOAI_MAX_INLINE_BYTES` (256 KB),
`SPANOAI_MAX_ARTIFACT_BYTES` (0 = unlimited), `SPANOAI_VISIBILITY_TIMEOUT_MS`
(reclaim idle), `SPANOAI_SESSION_TTL_SECONDS`, `SPANOAI_MAX_AGENTS_PER_SESSION`,
`SPANOAI_MAX_ENTRIES_PER_SESSION`, `SPANOAI_RATE_LIMIT_PER_MINUTE`, the job
intervals, and `SPANOAI_AUDIT_RETRY_MAX`.

---

## 9. API surface (summary)

```
# Context
POST   /context/:sid/:ns/:key            write
GET    /context/:sid/:ns/:key            read
DELETE /context/:sid/:ns/:key            soft-delete
POST   /context/:sid/:ns/:key/append     atomic list append
POST   /context/:sid/:ns/:key/increment  atomic counter
GET    /context/:sid/:ns/:key/history    version history
GET    /context/:sid/:ns/:key/await      block until present (?timeoutMs)
GET    /context/:sid                     list (?namespace)
POST   /context/:sid/search              semantic search

# Messages
POST   /messages                         dispatch
POST   /messages/request                 dispatch + await reply
POST   /messages/:agent/claim            claim (?sessionId&count)
POST   /messages/:id/ack                 ack (?sessionId)
POST   /messages/:id/reply               reply + ack (?sessionId)
GET    /messages/dlq                      list DLQ (?sessionId)
POST   /messages/dlq/:streamId/replay     replay DLQ entry (?sessionId)

# Audit / Sessions / Artifacts
GET    /audit/:runId   /audit/:runId/query   /audit/:runId/export
POST   /sessions   GET /sessions   GET/POST(join,leave,abort)/DELETE /sessions/:id
POST   /artifacts/init-upload   /artifacts/:id/complete
GET    /artifacts/:id   POST /artifacts/:id/download-url   DELETE /artifacts/:id

# Ops (public)
GET    /health     GET /metrics     WS /stream/:sid?key=&lastSeq=
```

All protected routes require `X-SpanoAI-Key`; the agent identity comes from
`X-SpanoAI-Agent`. Errors share one shape:
`{ error, message, code, docs, requestId }`.

---

## 10. Operations

- **Health**: `GET /health` checks Redis + Postgres.
- **Metrics**: `GET /metrics` (Prometheus) — HTTP throughput/latency/errors, WS
  connections, audit-retry depth.
- **Graceful shutdown**: stops jobs, drains the server, closes Redis + Postgres.
- **Migrations**: `bun run db:migrate` (idempotent, ledgered).

---

## 11. Known limitations & future work

These are deliberately deferred or are honest gaps (see also `plan.md` phases):

- **Value-encoding fidelity (fixed for write/delete).** Redis's Lua cjson encodes
  empty arrays as `{}` and formats numbers with `%.14g`. The write/delete path no
  longer round-trips the value through cjson (it injects the version into the
  verbatim client JSON), so empty arrays, tags, unicode, and large integers are
  preserved byte-for-byte (regression-tested). **Residual:** `append` items and
  `increment` values are still built in Lua, so an *appended item* that is itself
  an empty array or a `>15`-digit number, and `merge` of objects containing nested
  empty arrays, can still hit the cjson edge. Low-likelihood; a follow-up would
  store the value as a raw string separate from metadata.
- **Identifier sanitisation (fixed).** `fromAgent`/`toAgent` now use the same
  `SAFE_ID` charset as `sessionId`/`namespace`/`key`, so they can't inject `:`/`|`
  into Redis stream keys or the `tid|sid|agent` registry.
- **Redis fast-fail (fixed).** A per-command timeout
  (`SPANOAI_REDIS_COMMAND_TIMEOUT_MS`, default 10s) makes commands fail fast during a
  Redis outage; the API maps the timeout / closed-connection / `ECONNREFUSED` to
  `503 SERVICE_UNAVAILABLE` (`server/src/api/errors.ts`) instead of hanging. (Earlier
  the `maxRetriesPerRequest: null` setting queued commands and let requests hang.)
- **Session auto-registration (fixed).** Writing context or dispatching a message now
  auto-registers the Session (`SessionService.touch`: SET NX + index + `SESSION_START`
  audit), so a run appears in `/sessions` and the dashboard without an explicit
  `createSession`. An explicit `createSession` (with TTL/metadata) is never clobbered.
- **WS auth via single-use ticket (fixed).** `/stream` no longer accepts `?key=`.
  Clients mint a single-use ticket via `POST /stream-ticket` (Redis key `EX 30s`,
  consumed with `GETDEL`) and connect with `?ticket=`, so the API key never lands in
  proxy/server logs or browser history.
- **Cancellation is cooperative** — the session abort flag exists, but
  `awaitKey`/`claim` do not auto-abort; agents must check `isAborted`.
- **Semantic search needs a real embedder** — ships with a deterministic
  `HashEmbedder` for dev/tests; production must inject a model. Embeddings are
  written async (eventual consistency for search).
- **Entry-cap / rate-limit are not strictly atomic** — fixed-window limiter
  allows a small boundary burst; the entry cap has a tiny TOCTOU window. Both
  are abuse guards, acceptable for that purpose.
- **No billing / plan-tier enforcement, no CLI, no email** — later phases.
- **Artifacts**: single presigned PUT caps at 5 GB (multipart is future); the
  quarantine scanner is a no-op hook by default.
- **Load testing** — correctness is covered by 111 tests; the 1k-concurrent
  target still needs a k6 load run before claiming it.

---

## 12. Technical decisions log

1. **Lua is the write source of truth.** Atomicity beats application-level RMW.
   `conflict.ts` mirrors it for tests only.
2. **Store entries as JSON strings, not hashes.** Avoids flattening nested
   values; exact round-trip.
3. **Thread `tenantId` explicitly everywhere.** No ambient tenant → isolation is
   type-checkable.
4. **Await audit, buffer on failure.** Durability first, availability preserved
   via Redis-backed retry.
5. **`runId` defaults to `sessionId`.** One run per session in the MVP; can be
   overridden when a run spans sessions.
6. **Priority = separate streams**, not a non-durable scored set (the spec's
   explicit rule).
7. **Optional principal on facades.** Same code path works trusted (internal)
   and untrusted (route) — ACL is opt-in by passing a principal.
8. **Small inline cap, unlimited files.** Claim-check pattern: route big data to
   object storage; keep the real-time path lean.
9. **Cache API-key verification with a SHA-256 verifier**, not the argon2 hash —
   fast hot path, full secret still required.
10. **Injectable embedder, default off.** No embedding cost unless search is
    wanted; mechanism is fully tested with a local embedder.

---

*See `README.md` for quick start, `server/README.md` for the engine internals,
and `plan.md` for the full product roadmap.*
