/**
 * HTTP + WebSocket API (Hono).
 *
 * Every protected route runs auth → rate-limit, then resolves the principal and
 * passes it to the engine facades so scope + namespace ACLs are enforced. The
 * agent identity (writtenBy / fromAgent / createdBy) defaults to the principal.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket, websocket } from "hono/bun";
import { config } from "../config";
import { EngineError } from "../errors";
import type { Engine } from "../engine";
import { errorHandler } from "./errors";
import { authMiddleware, userAuthMiddleware, rateLimit, bearerToken, type ApiEnv } from "./middleware";
import { registry, metrics } from "../observability";
import {
  Scope,
  requireScope,
  requireNamespace,
  type AgentPrincipal,
} from "../auth/principal";

export { websocket };

export function createApp(engine: Engine): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.onError(errorHandler);
  app.use("*", cors({ origin: config.CORS_ORIGIN, allowHeaders: ["Content-Type", "Authorization", "X-SpanoAI-Key", "X-SpanoAI-Agent"] }));

  // Metrics: time every request and count by route + status.
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const route = c.req.routePath;
    metrics.httpRequests.inc({ method: c.req.method, route, status: String(c.res.status) });
    metrics.httpDurationMs.observe({ route }, Date.now() - start);
  });

  app.get("/metrics", async (c) =>
    c.text(await registry.metrics(), 200, { "Content-Type": registry.contentType }),
  );

  // ── Public ──────────────────────────────────────────────────────────
  app.get("/health", async (c) => {
    const [r, p] = await Promise.allSettled([engine.redis.ping(), engine.sql`SELECT 1`]);
    const redisOk = r.status === "fulfilled";
    const pgOk = p.status === "fulfilled";
    return c.json(
      {
        status: redisOk && pgOk ? "ok" : "degraded",
        service: "spanoai",
        version: "0.1.0",
        redis: redisOk ? "ok" : "error",
        postgres: pgOk ? "ok" : "error",
      },
      redisOk && pgOk ? 200 : 503,
    );
  });

  // ── Accounts: signup / login (public) + session-gated account routes ──
  // A user signs up (provisioning a tenant), logs in to get a session token,
  // then mints API keys for the SDK / MCP. Key management is gated to a
  // logged-in user (bearer token only) — an API key cannot mint more keys.
  const limit = rateLimit(engine.redis);
  const userAuth = userAuthMiddleware(engine.dashboardTokens);

  app.post("/auth/signup", limit, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const user = await engine.users.signup({
      email: body.email,
      password: body.password,
      orgName: body.orgName,
    });
    const token = await engine.dashboardTokens.issue(user.tenantId, user.id);
    return c.json({ token, user, tenantId: user.tenantId }, 201);
  });

  app.post("/auth/login", limit, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.email || !body.password) {
      throw new EngineError("MISSING_PARAM", "email and password are required.", 400);
    }
    const user = await engine.users.login(body.email, body.password);
    if (!user) throw new EngineError("INVALID_CREDENTIALS", "Incorrect email or password.", 401);
    const token = await engine.dashboardTokens.issue(user.tenantId, user.id);
    return c.json({ token, user, tenantId: user.tenantId });
  });

  app.post("/auth/logout", userAuth, async (c) => {
    const bearer = bearerToken(c);
    if (bearer) await engine.dashboardTokens.revoke(bearer);
    return c.json({ ok: true });
  });

  app.get("/auth/me", userAuth, async (c) => {
    const { userId, tenantId } = c.get("session");
    const user = await engine.users.getById(userId);
    if (!user) throw new EngineError("USER_NOT_FOUND", "User not found.", 404);
    return c.json({ user, tenantId });
  });

  // ── API key management (logged-in user, over their own tenant) ────────
  app.get("/keys", userAuth, limit, async (c) =>
    c.json(await engine.apiKeys.list(c.get("session").tenantId)),
  );

  app.post("/keys", userAuth, limit, async (c) => {
    const { tenantId } = c.get("session");
    const body = await c.req.json().catch(() => ({}));
    const scopes =
      Array.isArray(body.scopes) && body.scopes.length
        ? (body.scopes as Scope[])
        : (Object.values(Scope) as Scope[]);
    const created = await engine.apiKeys.create(tenantId, {
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "default",
      scopes,
      ...(Array.isArray(body.namespaces) ? { namespaces: body.namespaces as string[] } : {}),
    });
    return c.json(created, 201);
  });

  app.delete("/keys/:id", userAuth, async (c) => {
    await engine.apiKeys.revoke(c.get("session").tenantId, c.req.param("id"));
    return c.json({ revoked: true });
  });

  // ── Auth + rate limit for everything below ──────────────────────────
  const auth = authMiddleware(engine.apiKeys, engine.dashboardTokens);
  app.use("/context/*", auth, limit);
  app.use("/messages/*", auth, limit);
  app.use("/audit/*", auth, limit);
  app.use("/artifacts/*", auth, limit);
  app.use("/sessions/*", auth, limit);
  app.use("/stream-ticket", auth, limit);

  // Mint a short-lived, single-use WebSocket ticket (so the API key never goes
  // in a WS URL / proxy logs). Bound to {tenant, session}; consumed on connect.
  app.post("/stream-ticket", async (c) => {
    const p = P(c);
    const body = await c.req.json().catch(() => ({}));
    const sessionId = body.sessionId ?? c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId is required.", 400);
    const ticket = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    await engine.redis.set(
      `spanoai:wsticket:${ticket}`,
      JSON.stringify({ tenantId: p.tenantId, sessionId }),
      "EX",
      30,
    );
    return c.json({ ticket, expiresIn: 30 });
  });

  const P = (c: { get: (k: "principal") => AgentPrincipal }) => c.get("principal");

  // ── Context ─────────────────────────────────────────────────────────
  app.post("/context/:sessionId/:namespace/:key", async (c) => {
    const p = P(c);
    const { sessionId, namespace, key } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const result = await engine.store.write(
      p.tenantId,
      { ...body, sessionId, namespace, key, writtenBy: body.writtenBy ?? p.agentId },
      body.runId,
      p,
    );
    return c.json(result, result.outcome === "written" ? 201 : 200);
  });

  app.post("/context/:sessionId/:namespace/:key/append", async (c) => {
    const p = P(c);
    const { sessionId, namespace, key } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const result = await engine.store.append(
      p.tenantId,
      { ...body, sessionId, namespace, key, writtenBy: body.writtenBy ?? p.agentId },
      body.runId,
      p,
    );
    return c.json(result);
  });

  app.post("/context/:sessionId/:namespace/:key/increment", async (c) => {
    const p = P(c);
    const { sessionId, namespace, key } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const result = await engine.store.increment(
      p.tenantId,
      { ...body, sessionId, namespace, key, writtenBy: body.writtenBy ?? p.agentId },
      body.runId,
      p,
    );
    return c.json(result);
  });

  app.get("/context/:sessionId/:namespace/:key/history", async (c) => {
    const p = P(c);
    const { sessionId, namespace, key } = c.req.param();
    return c.json(await engine.store.history(p.tenantId, sessionId, `${namespace}.${key}`, p));
  });

  app.get("/context/:sessionId/:namespace/:key/await", async (c) => {
    const p = P(c);
    const { sessionId, namespace, key } = c.req.param();
    requireScope(p, Scope.CONTEXT_READ);
    requireNamespace(p, namespace);
    const timeoutMs = c.req.query("timeoutMs") ? Number(c.req.query("timeoutMs")) : 30_000;
    const entry = await engine.store.awaitKey(p.tenantId, sessionId, `${namespace}.${key}`, { timeoutMs });
    if (!entry) throw new EngineError("AWAIT_TIMEOUT", "Key did not appear before the timeout.", 408);
    return c.json(entry);
  });

  app.get("/context/:sessionId/:namespace/:key", async (c) => {
    const p = P(c);
    const { sessionId, namespace, key } = c.req.param();
    const entry = await engine.store.read(
      p.tenantId, sessionId, `${namespace}.${key}`,
      { includeDeleted: c.req.query("includeDeleted") === "true" }, p,
    );
    if (!entry) throw new EngineError("ENTRY_NOT_FOUND", "Entry not found.", 404);
    return c.json(entry);
  });

  app.delete("/context/:sessionId/:namespace/:key", async (c) => {
    const p = P(c);
    const { sessionId, namespace, key } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    return c.json(
      await engine.store.delete(
        p.tenantId,
        { ...body, sessionId, namespace, key, deletedBy: body.deletedBy ?? p.agentId },
        body.runId, p,
      ),
    );
  });

  app.post("/context/:sessionId/search", async (c) => {
    const p = P(c);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.query !== "string") {
      throw new EngineError("MISSING_PARAM", "body.query (string) is required.", 400);
    }
    return c.json(
      await engine.store.search(p.tenantId, c.req.param("sessionId"), body.query, body.topK ?? 10, p),
    );
  });

  app.get("/context/:sessionId", async (c) => {
    const p = P(c);
    return c.json(
      await engine.store.list(p.tenantId, c.req.param("sessionId"), c.req.query("namespace"), p),
    );
  });

  // ── Messages ────────────────────────────────────────────────────────
  app.post("/messages", async (c) => {
    const p = P(c);
    const body = await c.req.json();
    return c.json(await engine.bus.dispatch(p.tenantId, { ...body, fromAgent: body.fromAgent ?? p.agentId }, body.runId, p), 201);
  });

  app.post("/messages/broadcast", async (c) => {
    const p = P(c);
    const body = await c.req.json();
    return c.json(
      await engine.bus.broadcast(p.tenantId, { ...body, fromAgent: body.fromAgent ?? p.agentId }, body.runId, p),
      201,
    );
  });

  app.post("/messages/request", async (c) => {
    const p = P(c);
    const body = await c.req.json();
    const timeoutMs = body.timeoutMs ?? 30_000;
    return c.json(await engine.bus.request(p.tenantId, { ...body, fromAgent: body.fromAgent ?? p.agentId }, { timeoutMs, principal: p, runId: body.runId }));
  });

  app.post("/messages/:agentId/claim", async (c) => {
    const p = P(c);
    const agentId = c.req.param("agentId");
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    const count = c.req.query("count") ? Number(c.req.query("count")) : 10;
    const consumerId = c.req.query("consumerId") ?? p.agentId;
    return c.json(await engine.bus.claim(p.tenantId, sessionId, agentId, consumerId, count, undefined, p));
  });

  app.post("/messages/dlq/:streamId/replay", async (c) => {
    const p = P(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    const replayed = await engine.bus.replayDlq(p.tenantId, sessionId, c.req.param("streamId"));
    if (!replayed) throw new EngineError("DLQ_ENTRY_NOT_FOUND", "DLQ entry not found.", 404);
    return c.json(replayed);
  });

  app.get("/messages/dlq", async (c) => {
    const p = P(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    return c.json(await engine.bus.listDlq(p.tenantId, sessionId, Number(c.req.query("count") ?? 100)));
  });

  app.post("/messages/:id/ack", async (c) => {
    const p = P(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    return c.json({ acked: await engine.bus.ack(p.tenantId, sessionId, c.req.param("id")) });
  });

  app.get("/messages/:id/await-reply", async (c) => {
    const p = P(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    const timeoutMs = c.req.query("timeoutMs") ? Number(c.req.query("timeoutMs")) : 30_000;
    const reply = await engine.bus.awaitReply(p.tenantId, sessionId, c.req.param("id"), { timeoutMs });
    return c.json(reply ?? null);
  });

  app.post("/messages/:id/reply", async (c) => {
    const p = P(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    const body = await c.req.json();
    return c.json(await engine.bus.reply(p.tenantId, sessionId, c.req.param("id"), { ...body, fromAgent: body.fromAgent ?? p.agentId }, body.runId));
  });

  // ── Audit ───────────────────────────────────────────────────────────
  app.get("/audit/:runId/export", async (c) => {
    const p = P(c);
    requireScope(p, Scope.AUDIT_READ);
    return c.json(await engine.audit.export(p.tenantId, c.req.param("runId")));
  });

  app.get("/audit/:runId/query", async (c) => {
    const p = P(c);
    requireScope(p, Scope.AUDIT_READ);
    const q = c.req.query();
    return c.json(
      await engine.audit.query({
        tenantId: p.tenantId,
        runId: c.req.param("runId"),
        ...(q.agentId ? { agentId: q.agentId } : {}),
        ...(q.eventType ? { eventType: q.eventType as never } : {}),
        ...(q.fromStep ? { fromStep: Number(q.fromStep) } : {}),
        ...(q.toStep ? { toStep: Number(q.toStep) } : {}),
      }),
    );
  });

  app.get("/audit/:runId", async (c) => {
    const p = P(c);
    requireScope(p, Scope.AUDIT_READ);
    return c.json(await engine.audit.getByRun(p.tenantId, c.req.param("runId")));
  });

  // ── Artifacts ───────────────────────────────────────────────────────
  app.post("/artifacts/init-upload", async (c) => {
    const p = P(c);
    const body = await c.req.json();
    return c.json(await engine.artifacts.initUpload(p.tenantId, { ...body, createdByAgent: body.createdByAgent ?? p.agentId }, p), 201);
  });

  app.post("/artifacts/:id/complete", async (c) => {
    const p = P(c);
    const body = await c.req.json();
    return c.json(await engine.artifacts.complete(p.tenantId, c.req.param("id"), { ...body, byAgent: body.byAgent ?? p.agentId }));
  });

  app.post("/artifacts/:id/download-url", async (c) => {
    const p = P(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    return c.json(await engine.artifacts.downloadUrl(p.tenantId, sessionId, c.req.param("id"), p));
  });

  app.delete("/artifacts/:id", async (c) => {
    const p = P(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    await engine.artifacts.delete(p.tenantId, sessionId, c.req.param("id"), p.agentId, p);
    return c.json({ deleted: true });
  });

  app.get("/artifacts/:id", async (c) => {
    const p = P(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new EngineError("MISSING_PARAM", "sessionId query param is required.", 400);
    return c.json(await engine.artifacts.getMetadata(p.tenantId, sessionId, c.req.param("id"), p));
  });

  // ── Sessions ────────────────────────────────────────────────────────
  app.post("/sessions", async (c) => {
    const p = P(c);
    const body = await c.req.json().catch(() => ({}));
    return c.json(await engine.sessions.create(p.tenantId, { ...body, createdBy: body.createdBy ?? p.agentId }), 201);
  });

  app.get("/sessions", async (c) => c.json(await engine.sessions.list(P(c).tenantId)));

  app.get("/sessions/:id", async (c) => {
    const p = P(c);
    const session = await engine.sessions.get(p.tenantId, c.req.param("id"));
    if (!session) throw new EngineError("SESSION_NOT_FOUND", "Session not found.", 404);
    return c.json(session);
  });

  app.post("/sessions/:id/join", async (c) => {
    const p = P(c);
    const body = await c.req.json().catch(() => ({}));
    return c.json(await engine.sessions.join(p.tenantId, c.req.param("id"), body.agentId ?? p.agentId));
  });

  app.post("/sessions/:id/leave", async (c) => {
    const p = P(c);
    const body = await c.req.json().catch(() => ({}));
    await engine.sessions.leave(p.tenantId, c.req.param("id"), body.agentId ?? p.agentId);
    return c.json({ left: true });
  });

  app.post("/sessions/:id/abort", async (c) => {
    const p = P(c);
    await engine.sessions.abort(p.tenantId, c.req.param("id"));
    return c.json({ aborted: true });
  });

  app.delete("/sessions/:id", async (c) => {
    const p = P(c);
    await engine.sessions.end(p.tenantId, c.req.param("id"), p.agentId);
    return c.json({ ended: true });
  });

  // ── WebSocket: live session events with gap recovery ────────────────
  app.get(
    "/stream/:sessionId",
    upgradeWebSocket(async (c) => {
      const sessionId = c.req.param("sessionId");
      const ticket = c.req.query("ticket");
      const lastSeq = c.req.query("lastSeq") ? Number(c.req.query("lastSeq")) : undefined;
      let unsubscribe: (() => Promise<void>) | null = null;

      // Single-use ticket (minted via POST /stream-ticket). GETDEL consumes it.
      let tenantId: string | null = null;
      if (ticket) {
        const raw = await engine.redis.getdel(`spanoai:wsticket:${ticket}`);
        if (raw) {
          const t = JSON.parse(raw) as { tenantId: string; sessionId: string };
          if (t.sessionId === sessionId) tenantId = t.tenantId;
        }
      }
      if (!tenantId || !sessionId) {
        return { onOpen: (_e, ws) => ws.close(1008, "unauthorized") };
      }

      return {
        async onOpen(_evt, ws) {
          metrics.wsConnections.inc();
          unsubscribe = await engine.ws.subscribe(tenantId, sessionId, (event) => {
            ws.send(JSON.stringify(event));
          });
          if (lastSeq !== undefined) {
            const missed = await engine.ws.getMissed(tenantId, sessionId, lastSeq);
            ws.send(JSON.stringify({ event: "RESYNC", reload: missed.reload, missed: missed.events }));
          }
          ws.send(JSON.stringify({ event: "CONNECTED", sessionId }));
        },
        onMessage(evt, ws) {
          try {
            const data = JSON.parse(String(evt.data));
            if (data.type === "PING") ws.send(JSON.stringify({ type: "PONG" }));
          } catch {
            /* ignore non-JSON frames */
          }
        },
        async onClose() {
          metrics.wsConnections.dec();
          if (unsubscribe) await unsubscribe();
        },
      };
    }),
  );

  return app;
}
