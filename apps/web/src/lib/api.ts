"use client";

/**
 * Browser-side client for the SpanoAI engine API.
 *
 * The dashboard authenticates as a logged-in *user*: signup/login returns a
 * session token that is stored in this browser and sent as
 * `Authorization: Bearer <token>` on every request. From there the user mints
 * API keys (for the SDK / MCP) via the `/keys` endpoints. The dashboard never
 * stores a long-lived API key.
 */

const TOKEN_STORAGE = "spanoai_token";
const URL_STORAGE = "spanoai_api_url";
const USER_STORAGE = "spanoai_user";

const DEFAULT_API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  tenantId: string;
  role: string;
}

const isBrowser = () => typeof window !== "undefined";

export const auth = {
  getToken: () => (isBrowser() ? localStorage.getItem(TOKEN_STORAGE) ?? "" : ""),
  getUrl: () =>
    (isBrowser() ? localStorage.getItem(URL_STORAGE) : DEFAULT_API_URL) || DEFAULT_API_URL,
  getUser: (): AuthUser | null => {
    if (!isBrowser()) return null;
    const raw = localStorage.getItem(USER_STORAGE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuthUser;
    } catch {
      return null;
    }
  },
  setUrl: (url: string) => localStorage.setItem(URL_STORAGE, url || DEFAULT_API_URL),
  setSession: (token: string, user: AuthUser, url?: string) => {
    localStorage.setItem(TOKEN_STORAGE, token);
    localStorage.setItem(USER_STORAGE, JSON.stringify(user));
    if (url) localStorage.setItem(URL_STORAGE, url || DEFAULT_API_URL);
  },
  clear: () => {
    localStorage.removeItem(TOKEN_STORAGE);
    localStorage.removeItem(USER_STORAGE);
  },
  hasToken: () => Boolean(isBrowser() && localStorage.getItem(TOKEN_STORAGE)),
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function api<T>(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    noAuth?: boolean;
  } = {},
): Promise<T> {
  const params = new URLSearchParams();
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) params.set(k, String(v));
    }
  }
  const qs = params.toString() ? `?${params.toString()}` : "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-SpanoAI-Agent": "dashboard",
  };
  if (!opts.noAuth) headers["Authorization"] = `Bearer ${auth.getToken()}`;

  const res = await fetch(`${auth.getUrl()}${path}${qs}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? "ERROR", err.message ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Types (subset of the engine wire shapes) ──────────────────────────
export interface Session {
  sessionId: string;
  tenantId: string;
  createdBy: string;
  status: string;
  createdAt: number;
  ttlSeconds: number;
  members: string[];
  aborted: boolean;
}

export interface ContextEntry {
  sessionId: string;
  namespace: string;
  key: string;
  fullKey: string;
  value: { type: string; [k: string]: unknown };
  writtenBy: string;
  writtenAt: number;
  version: number;
  isDeleted: boolean;
}

export interface AuditEntry {
  id: string;
  runId: string;
  step: number;
  eventType: string;
  agentId: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface StreamEvent {
  event: string;
  seq?: number;
  ts?: number;
  [k: string]: unknown;
}

export interface AuthResult {
  token: string;
  tenantId: string;
  user: AuthUser;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  scopes: string[];
  isActive: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface CreatedApiKey {
  id: string;
  key: string;
  scopes: string[];
}

export const ALL_SCOPES = [
  "context:read",
  "context:write",
  "message:send",
  "message:claim",
  "artifact:read",
  "artifact:write",
  "audit:read",
] as const;

export const Api = {
  auth: {
    signup: (email: string, password: string, orgName?: string) =>
      api<AuthResult>("POST", "/auth/signup", { body: { email, password, orgName }, noAuth: true }),
    login: (email: string, password: string) =>
      api<AuthResult>("POST", "/auth/login", { body: { email, password }, noAuth: true }),
    logout: () => api<{ ok: boolean }>("POST", "/auth/logout"),
    me: () => api<{ user: AuthUser; tenantId: string }>("GET", "/auth/me"),
  },
  keys: {
    list: () => api<ApiKeySummary[]>("GET", "/keys"),
    create: (name: string, scopes?: string[]) =>
      api<CreatedApiKey>("POST", "/keys", { body: { name, ...(scopes ? { scopes } : {}) } }),
    revoke: (id: string) => api<{ revoked: boolean }>("DELETE", `/keys/${id}`),
  },
  sessions: {
    list: () => api<Session[]>("GET", "/sessions"),
    get: (id: string) => api<Session>("GET", `/sessions/${id}`),
    create: (sessionId?: string) =>
      api<Session>("POST", "/sessions", { body: sessionId ? { sessionId } : {} }),
    abort: (id: string) => api<{ aborted: boolean }>("POST", `/sessions/${id}/abort`),
    end: (id: string) => api<{ ended: boolean }>("DELETE", `/sessions/${id}`),
  },
  context: {
    list: (sid: string, namespace?: string) =>
      api<ContextEntry[]>("GET", `/context/${sid}`, { query: { namespace } }),
  },
  audit: {
    byRun: (runId: string) => api<AuditEntry[]>("GET", `/audit/${runId}`),
  },
};

/** Open a live event stream for a session. Returns a close fn. */
export function openStream(
  sessionId: string,
  onEvent: (e: StreamEvent) => void,
  onStatus?: (status: "open" | "closed") => void,
): () => void {
  const wsUrl = auth.getUrl().replace(/^http/, "ws");
  let closed = false;
  let socket: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let backoff = 400;

  const connect = async () => {
    if (closed) return;
    // Mint a single-use ticket (keeps credentials out of the WS URL / logs).
    let ticket: string;
    try {
      ticket = (await api<{ ticket: string }>("POST", "/stream-ticket", { body: { sessionId } })).ticket;
    } catch {
      onStatus?.("closed");
      setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 5_000);
      return;
    }
    if (closed) return;
    socket = new WebSocket(`${wsUrl}/stream/${sessionId}?ticket=${ticket}`);
    socket.addEventListener("open", () => {
      backoff = 400;
      onStatus?.("open");
      ping = setInterval(() => socket?.send(JSON.stringify({ type: "PING" })), 25_000);
    });
    socket.addEventListener("message", (e) => {
      try {
        onEvent(JSON.parse(String(e.data)) as StreamEvent);
      } catch {
        /* ignore */
      }
    });
    socket.addEventListener("close", () => {
      if (ping) clearInterval(ping);
      onStatus?.("closed");
      if (closed) return;
      setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 5_000);
    });
  };
  void connect();

  return () => {
    closed = true;
    if (ping) clearInterval(ping);
    socket?.close();
  };
}
