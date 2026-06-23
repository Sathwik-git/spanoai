/**
 * Engine composition root.
 *
 * The ONLY place that knows which concrete backends are used. Everything else
 * depends on interfaces. `createEngine` wires Redis + Postgres backends into the
 * Context Store, Message Bus, Audit Log, WebSocket broadcaster, replay engine,
 * and stream scheduler. Dependencies can be overridden (tests inject isolated
 * connections).
 */
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { config } from "./config";

import { RedisStore } from "./backends/redis-store";
import { RedisBus } from "./backends/redis-bus";
import { PostgresAudit } from "./backends/postgres-audit";
import { PostgresArtifactStore } from "./backends/postgres-artifacts";
import { BunObjectStorage } from "./backends/object-storage";
import { PgVectorSearch } from "./backends/pgvector-search";
import type { Embedder } from "./search/embedder";
import { AuditLog, ReplayEngine } from "./audit-log";
import { ContextStore } from "./context-store";
import { MessageBus, StreamScheduler } from "./message-bus";
import { ArtifactService } from "./artifacts";
import { SessionService } from "./sessions";
import { ApiKeyService } from "./auth/api-keys";
import { TenantService } from "./auth/tenants";
import { UserService } from "./auth/users";
import { DashboardTokenService } from "./auth/dashboard-tokens";
import { WSBroadcaster } from "./ws-broadcaster";
import type { BusBackend } from "./backends/interfaces";

import {
  redis as defaultRedis,
  redisPub as defaultPub,
  redisSub as defaultSub,
} from "./redis";
import { sql as defaultSql } from "./db/client";

export interface Engine {
  store: ContextStore;
  bus: MessageBus;
  audit: AuditLog;
  replay: ReplayEngine;
  artifacts: ArtifactService;
  sessions: SessionService;
  apiKeys: ApiKeyService;
  tenants: TenantService;
  users: UserService;
  dashboardTokens: DashboardTokenService;
  ws: WSBroadcaster;
  scheduler: StreamScheduler;
  /** Exposed for the background-jobs runner. */
  busBackend: BusBackend;
  /** Exposed for the API layer (rate limiting, health). */
  redis: Redis;
  sql: Sql;
}

export interface EngineDeps {
  redis?: Redis;
  redisPub?: Redis;
  redisSub?: Redis;
  sql?: Sql;
  /** When provided, enables semantic search (embed-on-write + vector query). */
  embedder?: Embedder;
}

export function createEngine(deps: EngineDeps = {}): Engine {
  const redis = deps.redis ?? defaultRedis;
  const redisPub = deps.redisPub ?? defaultPub;
  const redisSub = deps.redisSub ?? defaultSub;
  const sql = deps.sql ?? defaultSql;

  const storage = new RedisStore(redis);
  const busBackend = new RedisBus(redis, redisPub);
  const auditBackend = new PostgresAudit(sql);
  const artifactStore = new PostgresArtifactStore(sql);
  const objectStorage = new BunObjectStorage();

  const search = new PgVectorSearch(sql);
  const ws = new WSBroadcaster(redis, redisPub, redisSub);
  const audit = new AuditLog(auditBackend, redis);
  const replay = new ReplayEngine(auditBackend);
  // Sessions is built first so context/message writes can auto-register a run.
  const sessions = new SessionService(redis, audit);
  const store = new ContextStore(
    storage, audit, ws, deps.embedder, search,
    config.SPANOAI_MAX_ENTRIES_PER_SESSION, sessions,
  );
  const bus = new MessageBus(busBackend, audit, ws, sessions);
  const artifacts = new ArtifactService(objectStorage, artifactStore, audit, ws);
  const apiKeys = new ApiKeyService(sql, redis);
  const tenants = new TenantService(sql);
  const users = new UserService(sql);
  const dashboardTokens = new DashboardTokenService(sql, redis);
  const scheduler = new StreamScheduler(bus);

  return {
    store, bus, audit, replay, artifacts, sessions,
    apiKeys, tenants, users, dashboardTokens, ws, scheduler, busBackend, redis, sql,
  };
}
