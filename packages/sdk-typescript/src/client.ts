/**
 * SpanoAI TypeScript SDK.
 *
 *   const spano = new SpanoAIClient({ baseUrl, apiKey, agent: "researcher" });
 *   await spano.context.write("run-1", "researcher", "findings", { revenue: "$4.2M" });
 *   const data = await spano.context.read("run-1", "researcher", "findings");
 *
 * Retries transient failures (5xx / 429) with backoff; surfaces SpanoAIError.
 */
import { SpanoAIError } from "./errors";
import type {
  ContextEntry,
  ContextValue,
  WriteResult,
  WriteOptions,
  AgentMessage,
  Session,
  Artifact,
  InitUploadResult,
  DownloadGrant,
  StreamEvent,
} from "./types";

export interface SpanoAIClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Agent identity for this client (sent as X-SpanoAI-Agent). */
  agent: string;
  maxRetries?: number;
  fetch?: typeof fetch;
}

const KNOWN_VALUE_TYPES = new Set(["text", "json", "artifact", "artifacts"]);

function toValue(value: unknown): ContextValue {
  if (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    KNOWN_VALUE_TYPES.has((value as { type: string }).type)
  ) {
    return value as ContextValue;
  }
  if (typeof value === "string") return { type: "text", text: value };
  return { type: "json", data: value };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class SpanoAIClient {
  readonly context: ContextApi;
  readonly bus: BusApi;
  readonly sessions: SessionsApi;
  readonly artifacts: ArtifactsApi;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agent: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SpanoAIClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.agent = opts.agent;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetch ?? fetch;
    this.context = new ContextApi(this);
    this.bus = new BusApi(this);
    this.sessions = new SessionsApi(this);
    this.artifacts = new ArtifactsApi(this);
  }

  /** @internal */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    let qs = "";
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const s = params.toString();
      if (s) qs = `?${s}`;
    }
    const url = `${this.baseUrl}${path}${qs}`;

    let attempt = 0;
    for (;;) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-SpanoAI-Key": this.apiKey,
            "X-SpanoAI-Agent": this.agent,
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
            requestId?: string;
          };
          throw new SpanoAIError(err.message ?? res.statusText, res.status, err.error, err.requestId);
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      } catch (err) {
        const retryable = err instanceof SpanoAIError && err.isRetryable;
        if (!retryable || attempt >= this.maxRetries) throw err;
        await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 100, 2000)));
        attempt += 1;
      }
    }
  }

  /** @internal */
  get config() {
    return { baseUrl: this.baseUrl, apiKey: this.apiKey, agent: this.agent, fetchImpl: this.fetchImpl };
  }

  /**
   * Open a live event stream for a session. Reconnects automatically with
   * backoff, sends periodic PINGs, and tracks lastSeq for gap recovery.
   */
  stream(
    sessionId: string,
    handlers: { onEvent: (e: StreamEvent) => void; onError?: (e: unknown) => void; lastSeq?: number },
  ): { close: () => void } {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    let closed = false;
    let socket: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let lastSeq = handlers.lastSeq;
    let backoff = 250;

    const reconnect = () => {
      setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 5_000);
    };

    const connect = async () => {
      if (closed) return;
      // Mint a single-use ticket so the API key never goes in the WS URL.
      let ticket: string;
      try {
        ticket = (await this.request<{ ticket: string }>("POST", "/stream-ticket", { body: { sessionId } })).ticket;
      } catch (e) {
        handlers.onError?.(e);
        reconnect();
        return;
      }
      if (closed) return;
      const seqParam = lastSeq !== undefined ? `&lastSeq=${lastSeq}` : "";
      socket = new WebSocket(`${wsBase}/stream/${sessionId}?ticket=${ticket}${seqParam}`);
      socket.addEventListener("open", () => {
        backoff = 250;
        pingTimer = setInterval(() => socket?.send(JSON.stringify({ type: "PING" })), 25_000);
      });
      socket.addEventListener("message", (e) => {
        try {
          const data = JSON.parse(String((e as MessageEvent).data)) as StreamEvent;
          if (typeof data.seq === "number") lastSeq = data.seq;
          handlers.onEvent(data);
        } catch {
          /* ignore non-JSON frames */
        }
      });
      socket.addEventListener("error", (e) => handlers.onError?.(e));
      socket.addEventListener("close", () => {
        if (pingTimer) clearInterval(pingTimer);
        if (closed) return;
        reconnect();
      });
    };
    void connect();

    return {
      close: () => {
        closed = true;
        if (pingTimer) clearInterval(pingTimer);
        socket?.close();
      },
    };
  }
}

class ContextApi {
  constructor(private readonly c: SpanoAIClient) {}

  write(sessionId: string, namespace: string, key: string, value: unknown, opts: WriteOptions = {}): Promise<WriteResult> {
    // operationId is generated client-side and reused across retries so a retry
    // after a partial success replays idempotently rather than double-applying.
    return this.c.request("POST", `/context/${sessionId}/${namespace}/${key}`, {
      body: { ...opts, value: toValue(value), operationId: opts.operationId ?? crypto.randomUUID() },
    });
  }
  /** Read a key. Returns null if it does not exist (a miss is not an error). */
  async read<T = unknown>(
    sessionId: string,
    namespace: string,
    key: string,
  ): Promise<ContextEntry<T> | null> {
    try {
      return await this.c.request<ContextEntry<T>>("GET", `/context/${sessionId}/${namespace}/${key}`);
    } catch (err) {
      if (err instanceof SpanoAIError && err.isNotFound) return null;
      throw err;
    }
  }
  append(sessionId: string, namespace: string, key: string, items: unknown[], opts: { maxItems?: number; operationId?: string } = {}): Promise<WriteResult> {
    return this.c.request("POST", `/context/${sessionId}/${namespace}/${key}/append`, {
      body: { ...opts, items, operationId: opts.operationId ?? crypto.randomUUID() },
    });
  }
  increment(sessionId: string, namespace: string, key: string, by = 1, opts: { operationId?: string } = {}): Promise<WriteResult> {
    return this.c.request("POST", `/context/${sessionId}/${namespace}/${key}/increment`, {
      body: { ...opts, by, operationId: opts.operationId ?? crypto.randomUUID() },
    });
  }
  list(sessionId: string, namespace?: string): Promise<ContextEntry[]> {
    return this.c.request("GET", `/context/${sessionId}`, { query: { namespace } });
  }
  history(sessionId: string, namespace: string, key: string): Promise<ContextEntry[]> {
    return this.c.request("GET", `/context/${sessionId}/${namespace}/${key}/history`);
  }
  delete(sessionId: string, namespace: string, key: string): Promise<WriteResult> {
    return this.c.request("DELETE", `/context/${sessionId}/${namespace}/${key}`);
  }
  /** Block until the key satisfies the (server-side existence) condition. */
  awaitKey<T = unknown>(sessionId: string, namespace: string, key: string, opts: { timeoutMs?: number } = {}): Promise<ContextEntry<T>> {
    return this.c.request("GET", `/context/${sessionId}/${namespace}/${key}/await`, { query: { timeoutMs: opts.timeoutMs } });
  }
  search(sessionId: string, query: string, topK = 10): Promise<ContextEntry[]> {
    return this.c.request("POST", `/context/${sessionId}/search`, { body: { query, topK } });
  }
}

class BusApi {
  constructor(private readonly c: SpanoAIClient) {}

  dispatch(sessionId: string, toAgent: string, intent: string, payload: { text?: string; data?: unknown }, opts: { priority?: number; timeoutMs?: number; maxRetries?: number; operationId?: string } = {}): Promise<AgentMessage> {
    // Stable operationId lets consumers dedupe a message redelivered after a retry.
    return this.c.request("POST", `/messages`, {
      body: { sessionId, toAgent, intent, payload, ...opts, operationId: opts.operationId ?? crypto.randomUUID() },
    });
  }
  /** Send the same message to multiple agents at once (fan-out). */
  broadcast(
    sessionId: string,
    toAgents: string[],
    intent: string,
    payload: { text?: string; data?: unknown },
    opts: { priority?: number; timeoutMs?: number; maxRetries?: number } = {},
  ): Promise<AgentMessage[]> {
    return this.c.request("POST", `/messages/broadcast`, {
      body: { sessionId, toAgents, intent, payload, ...opts },
    });
  }

  claim(sessionId: string, agentId: string, count = 10): Promise<AgentMessage[]> {
    return this.c.request("POST", `/messages/${agentId}/claim`, { query: { sessionId, count } });
  }
  ack(sessionId: string, messageId: string): Promise<{ acked: boolean }> {
    return this.c.request("POST", `/messages/${messageId}/ack`, { query: { sessionId } });
  }
  reply(sessionId: string, messageId: string, payload: { text?: string; data?: unknown }, opts: { intent?: string; priority?: number } = {}): Promise<AgentMessage> {
    return this.c.request("POST", `/messages/${messageId}/reply`, { query: { sessionId }, body: { payload, ...opts } });
  }
  request(sessionId: string, toAgent: string, intent: string, payload: { text?: string; data?: unknown }, opts: { timeoutMs?: number } = {}): Promise<{ message: AgentMessage; reply: AgentMessage | null }> {
    return this.c.request("POST", `/messages/request`, { body: { sessionId, toAgent, intent, payload, ...opts } });
  }
  /** Long-poll for the reply to a message you already sent (e.g. after a broadcast). Resolves null on timeout. */
  awaitReply(sessionId: string, messageId: string, opts: { timeoutMs?: number } = {}): Promise<AgentMessage | null> {
    return this.c.request("GET", `/messages/${messageId}/await-reply`, { query: { sessionId, timeoutMs: opts.timeoutMs } });
  }
  listDlq(sessionId: string, count = 100): Promise<unknown[]> {
    return this.c.request("GET", `/messages/dlq`, { query: { sessionId, count } });
  }
  replayDlq(sessionId: string, streamId: string): Promise<AgentMessage> {
    return this.c.request("POST", `/messages/dlq/${streamId}/replay`, { query: { sessionId } });
  }
}

class SessionsApi {
  constructor(private readonly c: SpanoAIClient) {}

  create(opts: { sessionId?: string; ttlSeconds?: number; metadata?: Record<string, unknown> } = {}): Promise<Session> {
    return this.c.request("POST", `/sessions`, { body: opts });
  }
  get(sessionId: string): Promise<Session> {
    return this.c.request("GET", `/sessions/${sessionId}`);
  }
  list(): Promise<Session[]> {
    return this.c.request("GET", `/sessions`);
  }
  join(sessionId: string, agentId?: string): Promise<Session> {
    return this.c.request("POST", `/sessions/${sessionId}/join`, { body: { agentId } });
  }
  leave(sessionId: string, agentId?: string): Promise<{ left: boolean }> {
    return this.c.request("POST", `/sessions/${sessionId}/leave`, { body: { agentId } });
  }
  abort(sessionId: string): Promise<{ aborted: boolean }> {
    return this.c.request("POST", `/sessions/${sessionId}/abort`);
  }
  end(sessionId: string): Promise<{ ended: boolean }> {
    return this.c.request("DELETE", `/sessions/${sessionId}`);
  }
}

class ArtifactsApi {
  constructor(private readonly c: SpanoAIClient) {}

  initUpload(body: { sessionId: string; name: string; mimeType: string; sizeBytes: number; sha256?: string }): Promise<InitUploadResult> {
    return this.c.request("POST", `/artifacts/init-upload`, { body });
  }
  complete(artifactId: string, sha256: string): Promise<Artifact> {
    return this.c.request("POST", `/artifacts/${artifactId}/complete`, { body: { sha256 } });
  }
  getMetadata(sessionId: string, artifactId: string): Promise<Artifact> {
    return this.c.request("GET", `/artifacts/${artifactId}`, { query: { sessionId } });
  }
  downloadUrl(sessionId: string, artifactId: string): Promise<DownloadGrant> {
    return this.c.request("POST", `/artifacts/${artifactId}/download-url`, { query: { sessionId } });
  }
  delete(sessionId: string, artifactId: string): Promise<{ deleted: boolean }> {
    return this.c.request("DELETE", `/artifacts/${artifactId}`, { query: { sessionId } });
  }

  /** One-call upload: init → PUT bytes directly to storage → complete (verified). */
  async upload(sessionId: string, file: { name: string; mimeType: string; bytes: Uint8Array }): Promise<Artifact> {
    const sha256 = await sha256Hex(file.bytes);
    const init = await this.initUpload({ sessionId, name: file.name, mimeType: file.mimeType, sizeBytes: file.bytes.length, sha256 });
    const put = await this.c.config.fetchImpl(init.uploadUrl, {
      method: "PUT",
      body: file.bytes,
      headers: { "Content-Type": file.mimeType },
    });
    if (!put.ok) throw new SpanoAIError(`Upload failed: ${put.status}`, put.status);
    return this.complete(init.artifactId, sha256);
  }

  /** One-call download: resolve a signed URL → fetch the bytes. */
  async download(sessionId: string, artifactId: string): Promise<Uint8Array> {
    const grant = await this.downloadUrl(sessionId, artifactId);
    const res = await this.c.config.fetchImpl(grant.url);
    if (!res.ok) throw new SpanoAIError(`Download failed: ${res.status}`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}
