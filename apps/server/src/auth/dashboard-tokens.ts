/**
 * Dashboard session tokens — issued on login, sent by the web UI as
 * `Authorization: Bearer <token>`. Distinct from API keys: these represent a
 * logged-in *human*, are short-lived, and are the only credential allowed to
 * manage API keys.
 *
 * Token format: `spanoai_dt_<tokenId>_<secret>`. Only an argon2id hash of the
 * full token is stored. Like API keys, hot-path verification is cached in Redis
 * for a few minutes behind a fast SHA-256 verifier (a cache hit still requires
 * the full secret, constant-time compared) — revocation/logout deletes it.
 */
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { sql as defaultSql } from "../db/client";
import { redis as defaultRedis } from "../redis";
import { config } from "../config";
import { randomHex, sha256Hex, timingSafeEqual } from "./crypto";

const CACHE_TTL_SECONDS = 300;

export interface DashboardSession {
  tenantId: string;
  userId: string;
}

interface CacheEntry {
  tenantId: string;
  userId: string;
  verifier: string;
}

function parseTokenId(raw: string): string | null {
  const parts = raw.split("_");
  // spanoai_dt_<tokenId>_<secret>
  if (parts.length !== 4 || parts[0] !== "spanoai" || parts[1] !== "dt") return null;
  return parts[2] ?? null;
}

export class DashboardTokenService {
  constructor(
    private readonly db: Sql = defaultSql,
    private readonly redis: Redis = defaultRedis,
  ) {}

  private cacheKey(tokenId: string): string {
    return `spanoai:dtoken:${tokenId}`;
  }

  /** Issue a session token for a logged-in user. Returns the raw token ONCE. */
  async issue(tenantId: string, userId: string): Promise<string> {
    const tokenId = randomHex(8);
    const raw = `spanoai_dt_${tokenId}_${randomHex(24)}`;
    const hash = await Bun.password.hash(raw);
    const ttl = config.SPANOAI_DASHBOARD_TOKEN_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await this.db`
      INSERT INTO auth_tokens (id, tenant_id, user_id, token_hash, expires_at)
      VALUES (${tokenId}, ${tenantId}, ${userId}, ${hash}, ${expiresAt})
    `;
    return raw;
  }

  /** Resolve a raw token to its session, or null if invalid/expired/revoked. */
  async verify(raw: string): Promise<DashboardSession | null> {
    const tokenId = parseTokenId(raw);
    if (!tokenId) return null;
    const verifier = await sha256Hex(raw);

    const cachedRaw = await this.redis.get(this.cacheKey(tokenId));
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CacheEntry;
      if (timingSafeEqual(verifier, cached.verifier)) {
        return { tenantId: cached.tenantId, userId: cached.userId };
      }
      return null; // tokenId known but secret wrong
    }

    const [row] = await this.db`
      SELECT a.tenant_id, a.user_id, a.token_hash, a.is_revoked, a.expires_at,
             t.is_active AS tenant_active
        FROM auth_tokens a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.id = ${tokenId}
    `;
    if (!row || row.is_revoked === true || row.tenant_active !== true) return null;
    if (row.expires_at && new Date(row.expires_at as string).getTime() < Date.now()) {
      return null;
    }
    const ok = await Bun.password.verify(raw, row.token_hash as string);
    if (!ok) return null;

    const tenantId = row.tenant_id as string;
    const userId = row.user_id as string;
    const entry: CacheEntry = { tenantId, userId, verifier };
    await this.redis.set(this.cacheKey(tokenId), JSON.stringify(entry), "EX", CACHE_TTL_SECONDS);
    return { tenantId, userId };
  }

  /** Revoke a token (logout) and purge its cache entry immediately. */
  async revoke(raw: string): Promise<void> {
    const tokenId = parseTokenId(raw);
    if (!tokenId) return;
    await this.db`UPDATE auth_tokens SET is_revoked = TRUE WHERE id = ${tokenId}`;
    await this.redis.del(this.cacheKey(tokenId));
  }
}
