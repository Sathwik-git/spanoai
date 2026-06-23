# @spanoai/server — core engine

The Context Store, Message Bus, and Audit Log, plus the WebSocket broadcaster
that ties them to live dashboards.

## Layout

```
src/
├── config.ts              env validation (Zod) → typed, frozen config
├── redis.ts               3 connections (cmd / pub / sub), lazy-connect
├── engine.ts              composition root — wires backends into components
├── index.ts               runnable entry: /health probe + graceful shutdown
├── errors.ts              EngineError (code + HTTP status)
├── limits.ts              inline claim-check guard + filename sanitiser
│
├── db/
│   ├── client.ts          postgres.js pool
│   ├── migrate.ts         idempotent migration runner (.simple())
│   └── migrations/        001_tenants … 005_context_embeddings
│
├── models/                Zod schemas + types (context / message / audit)
│
├── backends/
│   ├── interfaces.ts      StorageBackend · BusBackend · AuditBackend · EventBroadcaster
│   ├── redis-store.ts     atomic Lua write (idempotency · CAS · conflict · delete)
│   ├── redis-bus.ts       Redis Streams: priority inboxes · claim/ack · reclaim · DLQ
│   ├── postgres-audit.ts  transactional step allocation · JSONB columns
│   ├── postgres-artifacts.ts  artifact metadata store (tenant-scoped)
│   └── object-storage.ts  Bun S3Client adapter (MinIO/S3/R2) — presign/stat/delete
│
├── context-store/         ContextStore facade + pure conflict reference
├── message-bus/           MessageBus facade + StreamScheduler (sweeper)
├── audit-log/             AuditLog facade + VectorClock + ReplayEngine
├── artifacts/             ArtifactService: init/complete/download/delete + verify
└── ws-broadcaster.ts      seq · replay buffer · cross-server fan-out
```

## Design decisions

- **The Lua script is the source of truth for writes.** All conflict
  resolution, version assignment, idempotency, and CAS happen inside one
  Redis-atomic script (`redis-store.ts`). `context-store/conflict.ts` is a pure
  TypeScript mirror used for documentation and unit tests — keep them in sync.
- **Entries are stored as a single JSON string**, not a flattened hash, so
  nested values, tags, and artifact metadata round-trip exactly.
- **`tenantId` is an explicit parameter** on every backend method — there is no
  ambient tenant. This makes cross-tenant isolation type-checkable.
- **Audit append is awaited** on the write/dispatch path (it is the durable
  source of truth); WebSocket broadcasts are fire-and-forget (best-effort).
- **`runId` defaults to `sessionId`** (one run per session in the MVP) but can
  be passed explicitly when a run spans sessions.
- **Vector clocks** are advanced atomically in Redis; the durable, total replay
  order is the Postgres `step`.
- **Files vs. inline (claim check).** Inline values/payloads are capped (default
  256KB) so they stay cheap on the real-time Redis path; anything larger must be
  an artifact. File bytes upload **directly** to object storage via a presigned
  URL and never flow through the engine; size + SHA-256 are verified on
  `complete` before the file is exposed. Files are otherwise uncapped.

## Running

```bash
docker compose up -d      # from repo root — Redis + Postgres
bun run db:migrate        # apply migrations
bun run dev               # start engine (watch mode)
bun test                  # full suite (needs Docker)
bun run typecheck         # tsc --noEmit
```

Integration tests use Redis DB index 1 and a dedicated `spanoai_test` database
(created automatically), so they never touch dev data.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://:spanoaidev@localhost:6379` | Redis connection |
| `DATABASE_URL` | `postgresql://spanoai:spanoaidev@localhost:5432/spanoai` | Postgres connection |
| `SPANOAI_OPS_TTL_SECONDS` | `86400` | Idempotency-record retention |
| `SPANOAI_VISIBILITY_TIMEOUT_MS` | `30000` | Reclaim idle threshold for stuck messages |
| `SPANOAI_WS_BUFFER_SIZE` | `100` | WebSocket replay buffer size |
| `SPANOAI_WS_BUFFER_TTL_SECONDS` | `300` | WebSocket replay buffer TTL |
| `S3_ENDPOINT` | `http://localhost:9000` | Object storage endpoint (MinIO/S3/R2) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `minioadmin` | Object storage credentials |
| `S3_BUCKET` | `spanoai-artifacts` | Artifact bucket |
| `SPANOAI_MAX_INLINE_BYTES` | `262144` | Inline claim-check cap (256KB) |
| `SPANOAI_MAX_ARTIFACT_BYTES` | `0` | Artifact soft cap (0 = unlimited) |
| `SPANOAI_ARTIFACT_UPLOAD_TTL_SECONDS` | `900` | Presigned upload URL lifetime |
| `SPANOAI_ARTIFACT_DOWNLOAD_TTL_SECONDS` | `300` | Presigned download URL lifetime |
| `SPANOAI_DEBUG_SQL` | unset | Set to surface Postgres NOTICEs |
