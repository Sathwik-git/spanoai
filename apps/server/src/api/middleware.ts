/**
 * API middleware: authentication (API key OR dashboard session token) and
 * per-tenant rate limiting.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Redis } from "ioredis";
import { config } from "../config";
import { EngineError } from "../errors";
import type { ApiKeyService } from "../auth/api-keys";
import type { DashboardTokenService } from "../auth/dashboard-tokens";
import { Scope, type AgentPrincipal } from "../auth/principal";

export interface ApiEnv {
  Variables: {
    /** Set by authMiddleware: the resolved agent identity + scopes. */
    principal: AgentPrincipal;
    /** Set by userAuthMiddleware: the logged-in dashboard user. */
    session: { tenantId: string; userId: string };
  };
}

/** Every scope — granted to a logged-in dashboard user over their own tenant. */
const ALL_SCOPES = Object.values(Scope) as Scope[];

/** Extract a bearer token from the `Authorization` header, if present. */
export function bearerToken(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

/**
 * Resolve credentials → AgentPrincipal. Accepts EITHER:
 *  - a dashboard session token (`Authorization: Bearer …`, issued on login) →
 *    a full-scope principal over the user's tenant (the dashboard is a client), or
 *  - an API key (`X-SpanoAI-Key`) → the key's tenant, scopes, namespace allowlist.
 * The agent identity comes from `X-SpanoAI-Agent` (falling back to "dashboard"
 * for a session, or the key id for an API key).
 */
export function authMiddleware(
  apiKeys: ApiKeyService,
  dashboardTokens: DashboardTokenService,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const bearer = bearerToken(c);
    if (bearer) {
      const session = await dashboardTokens.verify(bearer);
      if (!session) {
        throw new EngineError("INVALID_TOKEN", "The session token is invalid or expired.", 401);
      }
      c.set("principal", {
        tenantId: session.tenantId,
        agentId: c.req.header("X-SpanoAI-Agent") ?? "dashboard",
        scopes: ALL_SCOPES,
      });
      await next();
      return;
    }

    const raw = c.req.header("X-SpanoAI-Key");
    if (!raw) {
      throw new EngineError(
        "MISSING_CREDENTIALS",
        "Provide an API key (X-SpanoAI-Key) or a session token (Authorization: Bearer …).",
        401,
      );
    }
    const resolved = await apiKeys.verify(raw);
    if (!resolved) {
      throw new EngineError("INVALID_API_KEY", "The API key is invalid or revoked.", 401);
    }
    const agentId = c.req.header("X-SpanoAI-Agent") ?? resolved.keyId;
    c.set("principal", {
      tenantId: resolved.tenantId,
      agentId,
      scopes: resolved.scopes,
      ...(resolved.namespaces ? { namespaces: resolved.namespaces } : {}),
    });
    await next();
  };
}

/**
 * Gate a route to a logged-in dashboard user (bearer token ONLY — an API key
 * cannot manage accounts or mint more keys, preventing privilege escalation).
 */
export function userAuthMiddleware(
  dashboardTokens: DashboardTokenService,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const bearer = bearerToken(c);
    if (!bearer) {
      throw new EngineError("MISSING_TOKEN", "A session token is required — log in first.", 401);
    }
    const session = await dashboardTokens.verify(bearer);
    if (!session) {
      throw new EngineError("INVALID_TOKEN", "The session token is invalid or expired.", 401);
    }
    c.set("session", session);
    await next();
  };
}

/** Per-tenant fixed-window rate limit (Redis INCR + EXPIRE). */
export function rateLimit(redis: Redis): MiddlewareHandler<ApiEnv> {
  const limit = config.SPANOAI_RATE_LIMIT_PER_MINUTE;
  const windowSec = 60;
  return async (c, next) => {
    const tenantId = c.get("principal")?.tenantId ?? "anon";
    const window = Math.floor(Date.now() / 1000 / windowSec);
    const key = `spanoai:t:${tenantId}:rl:${window}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec);
    if (n > limit) {
      throw new EngineError(
        "RATE_LIMIT_EXCEEDED",
        `Rate limit of ${limit} requests/min exceeded.`,
        429,
      );
    }
    await next();
  };
}
