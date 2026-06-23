/**
 * API key issuance + verification.
 *
 * Key format: `spanoai_sk_<keyId>_<secret>`. `keyId` is the public lookup id
 * (stored as the row PK); the FULL key is hashed with Bun's password hashing
 * (argon2id) at rest — the raw key is shown once and never persisted.
 *
 * Hot-path verification is cached in Redis for 5 minutes. To avoid running the
 * slow hash on every request WITHOUT weakening security, the cache stores a
 * fast SHA-256 "verifier" of the full key; a cache hit still requires the full
 * secret (constant-time compared), it just skips argon2. Revocation deletes the
 * cache entry immediately.
 */
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { sql as defaultSql } from "../db/client";
import { redis as defaultRedis } from "../redis";
import type { Scope } from "./principal";

const CACHE_TTL_SECONDS = 300;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseKeyId(raw: string): string | null {
  const parts = raw.split("_");
  // spanoai_sk_<keyId>_<secret>
  if (parts.length !== 4 || parts[0] !== "spanoai" || parts[1] !== "sk") return null;
  return parts[2] ?? null;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison of two equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface ResolvedKey {
  tenantId: string;
  scopes: Scope[];
  keyId: string;
  /** Namespace allowlist; undefined = all namespaces. */
  namespaces?: string[];
}

interface CacheEntry {
  tenantId: string;
  scopes: Scope[];
  verifier: string;
  namespaces?: string[];
}

export class ApiKeyService {
  constructor(
    private readonly db: Sql = defaultSql,
    private readonly redis: Redis = defaultRedis,
  ) {}

  private cacheKey(keyId: string): string {
    return `spanoai:apikey:${keyId}`;
  }

  /** Create a key for a tenant. Returns the raw key ONCE. */
  async create(
    tenantId: string,
    opts: { name?: string; scopes: Scope[]; namespaces?: string[] },
  ): Promise<{ id: string; key: string; scopes: Scope[] }> {
    const keyId = randomHex(8); // 16 hex chars
    const raw = `spanoai_sk_${keyId}_${randomHex(24)}`;
    const hash = await Bun.password.hash(raw);
    await this.db`
      INSERT INTO api_keys (id, tenant_id, key_hash, name, scopes, namespaces)
      VALUES (${keyId}, ${tenantId}, ${hash}, ${opts.name ?? "default"},
              ${opts.scopes}, ${opts.namespaces ?? null})
    `;
    return { id: keyId, key: raw, scopes: opts.scopes };
  }

  /** Resolve a raw key to its tenant + scopes, or null if invalid/revoked. */
  async verify(raw: string): Promise<ResolvedKey | null> {
    const keyId = parseKeyId(raw);
    if (!keyId) return null;
    const verifier = await sha256Hex(raw);

    // Fast path: cached verifier (skips argon2, still needs the full secret).
    const cachedRaw = await this.redis.get(this.cacheKey(keyId));
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CacheEntry;
      if (timingSafeEqual(verifier, cached.verifier)) {
        return {
          tenantId: cached.tenantId,
          scopes: cached.scopes,
          keyId,
          ...(cached.namespaces ? { namespaces: cached.namespaces } : {}),
        };
      }
      return null; // keyId known but secret wrong
    }

    // Cold path: look up + argon2 verify + tenant active check.
    const [row] = await this.db`
      SELECT k.tenant_id, k.key_hash, k.scopes, k.namespaces, k.is_active, k.expires_at,
             t.is_active AS tenant_active
        FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
       WHERE k.id = ${keyId}
    `;
    if (!row || row.is_active !== true || row.tenant_active !== true) return null;
    if (row.expires_at && new Date(row.expires_at as string).getTime() < Date.now()) {
      return null;
    }
    const ok = await Bun.password.verify(raw, row.key_hash as string);
    if (!ok) return null;

    const tenantId = row.tenant_id as string;
    const scopes = row.scopes as Scope[];
    const namespaces = (row.namespaces as string[] | null) ?? undefined;
    const entry: CacheEntry = {
      tenantId,
      scopes,
      verifier,
      ...(namespaces ? { namespaces } : {}),
    };
    await this.redis.set(this.cacheKey(keyId), JSON.stringify(entry), "EX", CACHE_TTL_SECONDS);
    // Best-effort last-used stamp.
    void this.db`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${keyId}`.catch(
      () => {},
    );
    return { tenantId, scopes, keyId, ...(namespaces ? { namespaces } : {}) };
  }

  /** Revoke a key and purge its cache entry immediately. */
  async revoke(tenantId: string, keyId: string): Promise<void> {
    await this.db`
      UPDATE api_keys SET is_active = FALSE
       WHERE tenant_id = ${tenantId} AND id = ${keyId}
    `;
    await this.redis.del(this.cacheKey(keyId));
  }

  async list(tenantId: string): Promise<
    Array<{
      id: string;
      name: string;
      scopes: Scope[];
      isActive: boolean;
      createdAt: string | null;
      lastUsedAt: string | null;
    }>
  > {
    const rows = await this.db`
      SELECT id, name, scopes, is_active, created_at, last_used_at
        FROM api_keys WHERE tenant_id = ${tenantId}
       ORDER BY created_at DESC
    `;
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      scopes: r.scopes as Scope[],
      isActive: r.is_active as boolean,
      createdAt: (r.created_at as string | null) ?? null,
      lastUsedAt: (r.last_used_at as string | null) ?? null,
    }));
  }
}
