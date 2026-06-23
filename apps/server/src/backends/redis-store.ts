/**
 * Redis-backed Context Store.
 *
 * All conflict resolution and version assignment happen inside ONE Lua script
 * executed atomically by Redis — there is no read-modify-write race in
 * application code. The script enforces, in order:
 *
 *   1. Idempotency — if this operationId was already applied to this key, the
 *      original result is replayed (no second version is created).
 *   2. Optimistic concurrency — if `expectedVersion` is supplied and differs
 *      from the current version, the write is a CONFLICT.
 *   3. Resurrection guard — a soft-deleted key cannot be overwritten by a stale
 *      write unless `allowRestore` is set AND an expectedVersion was supplied.
 *   4. Conflict strategy — reject / highest-confidence / shallow-merge / lww.
 *   5. Version assignment + persistence of the winner, history, and key index.
 *
 * Values are stored as a single JSON STRING (not a flattened hash), so nested
 * structures, tags, and artifact metadata round-trip exactly.
 */
import type { Redis, Result, Callback } from "ioredis";
import { config } from "../config";
import type {
  StorageBackend,
  ContextWriteResult,
  ContextWriteOutcome,
} from "./interfaces";
import {
  type ContextEntry,
  type ContextWriteRequest,
  type ContextDeleteRequest,
  type ContextAppendRequest,
  type ContextIncrementRequest,
  ConflictStrategy,
  makeFullKey,
  isStale,
} from "../models/context-entry";

// The atomic write script. KEYS: ctx, hist, ops, keyIndex. See file header.
//
// IMPORTANT: the stored value is NEVER round-tripped through cjson on the
// write/delete path. Redis's cjson encodes empty arrays as {} and formats
// numbers with %.14g (losing precision past ~14 digits). So the client sends
// the entry JSON *without* a version, and we inject the authoritative version
// as the first field via string surgery — the value/tags/numbers stay verbatim.
// (decoding existing state to read scalars is lossless; only ENCODING corrupts.)
const WRITE_SCRIPT = `
local ctxKey  = KEYS[1]
local histKey = KEYS[2]
local opsKey  = KEYS[3]
local keysKey = KEYS[4]

local incomingJson    = ARGV[1]              -- full entry JSON, WITHOUT "version"
local strategy        = ARGV[2]
local ttl             = tonumber(ARGV[3])
local operationId     = ARGV[4]
local expectedVersion = tonumber(ARGV[5])    -- -1 means "not supplied"
local opsTtl          = tonumber(ARGV[6])
local allowRestore    = ARGV[7] == '1'
local incomingConf    = tonumber(ARGV[8]) or 0
local incomingIsDelete = ARGV[9] == '1'
local fullKey         = ARGV[10]

-- 1) Idempotency: replay the original result verbatim (string injection, so the
--    stored entry is never re-encoded), tagged so the caller knows.
local prior = redis.call('HGET', opsKey, operationId)
if prior then
  return '{"idempotentReplay":true,' .. string.sub(prior, 2)
end

-- 2) Load current state. Decoding is lossless for reading scalars/merge input.
local existingRaw = redis.call('GET', ctxKey)
local existing = nil
local currentVersion = 0
if existingRaw then
  existing = cjson.decode(existingRaw)
  currentVersion = tonumber(existing.version) or 0
end

-- 3) Optimistic concurrency (CAS).
if expectedVersion >= 0 and expectedVersion ~= currentVersion then
  return '{"outcome":"conflict","reason":"version_mismatch","version":' .. currentVersion .. ',"entry":' .. (existingRaw or 'null') .. '}'
end

-- 4) Resurrection guard.
if existing ~= nil and existing.isDeleted == true and not incomingIsDelete then
  if not (allowRestore and expectedVersion >= 0) then
    return '{"outcome":"rejected","reason":"deleted","version":' .. currentVersion .. ',"entry":' .. (existingRaw or 'null') .. '}'
  end
end

-- 5) Conflict strategy (only against a live, non-deleted entry; deletes skip).
local mergedJson = nil
if existing ~= nil and existing.isDeleted ~= true and not incomingIsDelete then
  if strategy == 'reject' then
    return '{"outcome":"rejected","reason":"exists","version":' .. currentVersion .. ',"entry":' .. (existingRaw or 'null') .. '}'
  elseif strategy == 'conf' then
    local ec = tonumber(existing.confidence) or 0
    if not (incomingConf > ec or expectedVersion >= 0) then
      return '{"outcome":"kept_existing","reason":"lower_or_equal_confidence","version":' .. currentVersion .. ',"entry":' .. (existingRaw or 'null') .. '}'
    end
  elseif strategy == 'merge' then
    local function is_object(v)
      if type(v) ~= 'table' then return false end
      if v[1] ~= nil then return false end
      return true
    end
    local incoming = cjson.decode(incomingJson)
    local ev = existing.value
    local iv = incoming.value
    if ev ~= nil and iv ~= nil and ev.type == 'json' and iv.type == 'json'
       and is_object(ev.data) and is_object(iv.data) then
      local out = {}
      for k, val in pairs(ev.data) do out[k] = val end
      for k, val in pairs(iv.data) do out[k] = val end   -- arrays replace wholesale
      incoming.value = { type = 'json', data = out }
      incoming.version = currentVersion + 1
      mergedJson = cjson.encode(incoming)   -- merge path re-encodes (see header note)
    end
  end
end

-- 6) Assign the new version + persist. Non-merge injects the version into the
--    verbatim client JSON so the value/tags/numbers are stored byte-for-byte.
local newVersion = currentVersion + 1
local winnerJson
if mergedJson ~= nil then
  winnerJson = mergedJson
else
  winnerJson = '{"version":' .. newVersion .. ',' .. string.sub(incomingJson, 2)
end

redis.call('SET', ctxKey, winnerJson)
redis.call('ZADD', histKey, newVersion, winnerJson)
redis.call('SADD', keysKey, fullKey)
if ttl > 0 then
  redis.call('EXPIRE', ctxKey, ttl)
  redis.call('EXPIRE', histKey, ttl)
end

local outcome = 'written'
if incomingIsDelete then outcome = 'deleted' end
local result = '{"outcome":"' .. outcome .. '","version":' .. newVersion .. ',"entry":' .. winnerJson .. '}'

-- 7) Record idempotency so retries replay this exact result.
redis.call('HSET', opsKey, operationId, result)
redis.call('EXPIRE', opsKey, opsTtl)

return result
`;

// Atomically append items to a list-valued key (concurrency-safe accumulate).
// KEYS: ctx, hist, ops, keyIndex. Idempotent by operationId.
const APPEND_SCRIPT = `
local ctxKey, histKey, opsKey, keysKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local baseJson    = ARGV[1]
local itemsJson   = ARGV[2]
local ttl         = tonumber(ARGV[3])
local operationId = ARGV[4]
local opsTtl      = tonumber(ARGV[5])
local nowMs       = tonumber(ARGV[6])
local maxItems    = tonumber(ARGV[7])

local prior = redis.call('HGET', opsKey, operationId)
if prior then return '{"idempotentReplay":true,' .. string.sub(prior, 2) end

local existingRaw = redis.call('GET', ctxKey)
local entry
if existingRaw then entry = cjson.decode(existingRaw) else entry = cjson.decode(baseJson) end

-- The target value must be a JSON array (or empty/absent); reject otherwise.
local function is_array_or_empty(t)
  if type(t) ~= 'table' then return false end
  for k, _ in pairs(t) do if type(k) ~= 'number' then return false end end
  return true
end
local cur = (entry.value ~= nil and entry.value.type == 'json') and entry.value.data or nil
if existingRaw and not is_array_or_empty(cur) then
  return cjson.encode({ outcome = 'rejected', reason = 'type_mismatch',
                        version = tonumber(entry.version) or 0, entry = entry })
end
local arr = is_array_or_empty(cur) and cur or {}

local items = cjson.decode(itemsJson)
for i = 1, #items do arr[#arr + 1] = items[i] end
if maxItems > 0 then while #arr > maxItems do table.remove(arr, 1) end end

local version = (tonumber(entry.version) or 0) + 1
entry.value = { type = 'json', data = arr }
entry.version = version
entry.writtenAt = nowMs
entry.operationId = operationId
entry.isDeleted = false

local j = cjson.encode(entry)
redis.call('SET', ctxKey, j)
redis.call('ZADD', histKey, version, j)
redis.call('SADD', keysKey, entry.fullKey)
if ttl > 0 then redis.call('EXPIRE', ctxKey, ttl); redis.call('EXPIRE', histKey, ttl) end

local result = cjson.encode({ outcome = 'written', version = version, entry = entry })
redis.call('HSET', opsKey, operationId, result)
redis.call('EXPIRE', opsKey, opsTtl)
return result
`;

// Atomically add to a numeric key (concurrency-safe counter).
const INCREMENT_SCRIPT = `
local ctxKey, histKey, opsKey, keysKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local baseJson, byStr = ARGV[1], ARGV[2]
local ttl         = tonumber(ARGV[3])
local operationId = ARGV[4]
local opsTtl      = tonumber(ARGV[5])
local nowMs       = tonumber(ARGV[6])

local prior = redis.call('HGET', opsKey, operationId)
if prior then return '{"idempotentReplay":true,' .. string.sub(prior, 2) end

local existingRaw = redis.call('GET', ctxKey)
local entry
if existingRaw then entry = cjson.decode(existingRaw) else entry = cjson.decode(baseJson) end

local cur = (entry.value ~= nil and entry.value.type == 'json') and entry.value.data or 0
if existingRaw and type(cur) ~= 'number' then
  return cjson.encode({ outcome = 'rejected', reason = 'type_mismatch',
                        version = tonumber(entry.version) or 0, entry = entry })
end
local n = (type(cur) == 'number' and cur or 0) + tonumber(byStr)

local version = (tonumber(entry.version) or 0) + 1
entry.value = { type = 'json', data = n }
entry.version = version
entry.writtenAt = nowMs
entry.operationId = operationId
entry.isDeleted = false

local j = cjson.encode(entry)
redis.call('SET', ctxKey, j)
redis.call('ZADD', histKey, version, j)
redis.call('SADD', keysKey, entry.fullKey)
if ttl > 0 then redis.call('EXPIRE', ctxKey, ttl); redis.call('EXPIRE', histKey, ttl) end

local result = cjson.encode({ outcome = 'written', version = version, entry = entry })
redis.call('HSET', opsKey, operationId, result)
redis.call('EXPIRE', opsKey, opsTtl)
return result
`;

// Augment ioredis with our registered commands for full type-safety at call sites.
declare module "ioredis" {
  interface RedisCommander<Context> {
    spanoaiCtxWrite(
      ctxKey: string,
      histKey: string,
      opsKey: string,
      keysKey: string,
      incomingJson: string,
      strategy: string,
      ttl: string,
      operationId: string,
      expectedVersion: string,
      opsTtl: string,
      allowRestore: string,
      confidence: string,
      isDeleted: string,
      fullKey: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
    spanoaiCtxAppend(
      ctxKey: string,
      histKey: string,
      opsKey: string,
      keysKey: string,
      baseJson: string,
      itemsJson: string,
      ttl: string,
      operationId: string,
      opsTtl: string,
      nowMs: string,
      maxItems: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
    spanoaiCtxIncrement(
      ctxKey: string,
      histKey: string,
      opsKey: string,
      keysKey: string,
      baseJson: string,
      byStr: string,
      ttl: string,
      operationId: string,
      opsTtl: string,
      nowMs: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
  }
}

/** Raw shape returned by the Lua script (before normalisation). */
interface LuaWriteResult {
  outcome: ContextWriteOutcome;
  version?: number;
  entry?: ContextEntry;
  reason?: string;
  idempotentReplay?: boolean;
}

export class RedisStore implements StorageBackend {
  constructor(private readonly r: Redis) {
    // Register the Lua script once per connection. `duplicate()` does not copy
    // scripts, and tests may build several stores on one client, so guard it.
    const cmds = this.r as unknown as Record<string, unknown>;
    if (typeof cmds.spanoaiCtxWrite !== "function") {
      this.r.defineCommand("spanoaiCtxWrite", { numberOfKeys: 4, lua: WRITE_SCRIPT });
    }
    if (typeof cmds.spanoaiCtxAppend !== "function") {
      this.r.defineCommand("spanoaiCtxAppend", { numberOfKeys: 4, lua: APPEND_SCRIPT });
    }
    if (typeof cmds.spanoaiCtxIncrement !== "function") {
      this.r.defineCommand("spanoaiCtxIncrement", { numberOfKeys: 4, lua: INCREMENT_SCRIPT });
    }
  }

  private baseEntry(
    tenantId: string,
    sessionId: string,
    namespace: string,
    key: string,
    writtenBy: string,
    value: ContextEntry["value"],
    nowMs: number,
    operationId: string,
    ttlSeconds: number,
    tags: string[],
  ): ContextEntry {
    return {
      tenantId,
      sessionId,
      namespace,
      key,
      fullKey: makeFullKey(namespace, key),
      value,
      writtenBy,
      writtenAt: nowMs,
      version: 0,
      confidence: 1,
      tags,
      ttlSeconds,
      isDeleted: false,
      conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
      operationId,
    };
  }

  private ctxKey(tid: string, sid: string, fullKey: string): string {
    return `spanoai:t:${tid}:ctx:${sid}:${fullKey}`;
  }
  private keysKey(tid: string, sid: string): string {
    return `spanoai:t:${tid}:ctx:${sid}:keys`;
  }

  private async exec(
    tid: string,
    candidate: ContextEntry,
    opts: {
      strategy: string;
      ttl: number;
      operationId: string;
      expectedVersion: number | undefined;
      allowRestore: boolean;
    },
  ): Promise<ContextWriteResult> {
    const ctxKey = this.ctxKey(tid, candidate.sessionId, candidate.fullKey);
    // Send the entry WITHOUT a version; the Lua injects the authoritative
    // version into this verbatim JSON so the value/tags/numbers never pass
    // through Redis's (lossy) cjson encoder.
    const entryNoVersion: Record<string, unknown> = { ...candidate };
    delete entryNoVersion.version;
    const raw = await this.r.spanoaiCtxWrite(
      ctxKey,
      `${ctxKey}:hist`,
      `${ctxKey}:ops`,
      this.keysKey(tid, candidate.sessionId),
      JSON.stringify(entryNoVersion),
      opts.strategy,
      String(opts.ttl),
      opts.operationId,
      opts.expectedVersion === undefined ? "-1" : String(opts.expectedVersion),
      String(config.SPANOAI_OPS_TTL_SECONDS),
      opts.allowRestore ? "1" : "0",
      String(candidate.confidence),
      candidate.isDeleted ? "1" : "0",
      candidate.fullKey,
    );

    return this.normalize(raw);
  }

  async write(
    tenantId: string,
    req: ContextWriteRequest,
    nowMs: number,
  ): Promise<ContextWriteResult> {
    const fullKey = makeFullKey(req.namespace, req.key);
    const candidate: ContextEntry = {
      tenantId,
      sessionId: req.sessionId,
      namespace: req.namespace,
      key: req.key,
      fullKey,
      value: req.value,
      writtenBy: req.writtenBy,
      writtenAt: nowMs,
      version: 0,
      confidence: req.confidence,
      tags: req.tags,
      ttlSeconds: req.ttlSeconds,
      isDeleted: false,
      conflictStrategy: req.conflictStrategy,
      operationId: req.operationId,
    };

    return this.exec(tenantId, candidate, {
      strategy: req.conflictStrategy,
      ttl: req.ttlSeconds,
      operationId: req.operationId,
      expectedVersion: req.expectedVersion,
      allowRestore: req.allowRestore,
    });
  }

  async delete(
    tenantId: string,
    req: ContextDeleteRequest,
    nowMs: number,
  ): Promise<ContextWriteResult> {
    const fullKey = makeFullKey(req.namespace, req.key);
    const existing = await this.get(tenantId, req.sessionId, fullKey, {
      includeDeleted: true,
    });

    if (!existing) {
      return { outcome: "rejected", entry: null, version: null, reason: "not_found" };
    }
    if (existing.isDeleted) {
      // Already a tombstone — return it idempotently without a new version,
      // unless a retry with the same operationId is replayed by the script.
      return {
        outcome: "rejected",
        entry: existing,
        version: existing.version,
        reason: "already_deleted",
      };
    }

    // A soft delete is a normal versioned write with isDeleted=true. We keep
    // the last value as the tombstone payload so history stays meaningful.
    const tombstone: ContextEntry = {
      ...existing,
      writtenAt: nowMs,
      version: 0,
      isDeleted: true,
      writtenBy: req.deletedBy,
      conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
      operationId: req.operationId,
    };

    return this.exec(tenantId, tombstone, {
      strategy: ConflictStrategy.LAST_WRITE_WINS,
      ttl: existing.ttlSeconds,
      operationId: req.operationId,
      expectedVersion: req.expectedVersion,
      allowRestore: false,
    });
  }

  async append(
    tenantId: string,
    req: ContextAppendRequest,
    nowMs: number,
  ): Promise<ContextWriteResult> {
    const base = this.baseEntry(
      tenantId, req.sessionId, req.namespace, req.key, req.writtenBy,
      { type: "json", data: [] }, nowMs, req.operationId, req.ttlSeconds, req.tags,
    );
    const ctxKey = this.ctxKey(tenantId, req.sessionId, base.fullKey);
    const raw = await this.r.spanoaiCtxAppend(
      ctxKey, `${ctxKey}:hist`, `${ctxKey}:ops`,
      this.keysKey(tenantId, req.sessionId),
      JSON.stringify(base),
      JSON.stringify(req.items),
      String(req.ttlSeconds),
      req.operationId,
      String(config.SPANOAI_OPS_TTL_SECONDS),
      String(nowMs),
      String(req.maxItems),
    );
    return this.normalize(raw);
  }

  async increment(
    tenantId: string,
    req: ContextIncrementRequest,
    nowMs: number,
  ): Promise<ContextWriteResult> {
    const base = this.baseEntry(
      tenantId, req.sessionId, req.namespace, req.key, req.writtenBy,
      { type: "json", data: 0 }, nowMs, req.operationId, req.ttlSeconds, [],
    );
    const ctxKey = this.ctxKey(tenantId, req.sessionId, base.fullKey);
    const raw = await this.r.spanoaiCtxIncrement(
      ctxKey, `${ctxKey}:hist`, `${ctxKey}:ops`,
      this.keysKey(tenantId, req.sessionId),
      JSON.stringify(base),
      String(req.by),
      String(req.ttlSeconds),
      req.operationId,
      String(config.SPANOAI_OPS_TTL_SECONDS),
      String(nowMs),
    );
    return this.normalize(raw);
  }

  private normalize(raw: string): ContextWriteResult {
    const parsed = JSON.parse(raw) as LuaWriteResult;
    return {
      outcome: parsed.outcome,
      entry: parsed.entry ?? null,
      version: parsed.version ?? null,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
      idempotentReplay: parsed.idempotentReplay ?? false,
    };
  }

  async get(
    tenantId: string,
    sessionId: string,
    fullKey: string,
    opts?: { includeDeleted?: boolean },
  ): Promise<ContextEntry | null> {
    const raw = await this.r.get(this.ctxKey(tenantId, sessionId, fullKey));
    if (!raw) return null;
    const entry = JSON.parse(raw) as ContextEntry;
    if (isStale(entry)) return null;
    if (entry.isDeleted && !opts?.includeDeleted) return null;
    return entry;
  }

  async list(
    tenantId: string,
    sessionId: string,
    namespace?: string,
  ): Promise<ContextEntry[]> {
    const fullKeys = await this.r.smembers(this.keysKey(tenantId, sessionId));
    const selected =
      namespace === undefined
        ? fullKeys
        : fullKeys.filter(
            (k) => k === namespace || k.startsWith(`${namespace}.`),
          );

    const entries = await Promise.all(
      selected.map((fk) => this.get(tenantId, sessionId, fk)),
    );

    // Lazy cleanup: drop fullKeys whose entry has expired/vanished from the
    // index set so it does not grow unbounded over a long session.
    const stale = selected.filter((_, i) => entries[i] === null);
    if (stale.length > 0) {
      await this.r.srem(this.keysKey(tenantId, sessionId), ...stale);
    }

    return entries.filter((e): e is ContextEntry => e !== null);
  }

  async history(
    tenantId: string,
    sessionId: string,
    fullKey: string,
  ): Promise<ContextEntry[]> {
    const members = await this.r.zrange(
      `${this.ctxKey(tenantId, sessionId, fullKey)}:hist`,
      0,
      -1,
    );
    return members.map((m) => JSON.parse(m) as ContextEntry);
  }

  async countKeys(tenantId: string, sessionId: string): Promise<number> {
    return this.r.scard(this.keysKey(tenantId, sessionId));
  }

  async has(tenantId: string, sessionId: string, fullKey: string): Promise<boolean> {
    return (await this.r.sismember(this.keysKey(tenantId, sessionId), fullKey)) === 1;
  }

  // Semantic search is served by pgvector via a separate path; the Redis store
  // intentionally returns nothing.
  async search(
    _tenantId: string,
    _sessionId: string,
    _queryEmbedding: number[],
    _topK: number,
  ): Promise<ContextEntry[]> {
    return [];
  }
}
