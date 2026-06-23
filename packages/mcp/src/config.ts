/**
 * Configuration for the SpanoAI MCP server.
 *
 * Resolved from explicit options first, then environment variables, then sane
 * defaults. The only required value is the API key.
 */
import { SpanoAIClient } from "@spanoai/sdk";

export interface SpanoMcpOptions {
  /** Engine base URL. Default: $SPANOAI_API_URL or http://localhost:8000. */
  apiUrl?: string;
  /** Scoped API key. Default: $SPANOAI_API_KEY (required). */
  apiKey?: string;
  /** Default session id used when a tool call omits `session`. */
  session?: string;
  /** Default agent identity used when a tool call omits `agent`. */
  agent?: string;
  /** Max bytes carried inline (base64) by upload/download tools. */
  maxInlineBytes?: number;
  /** Injectable client factory (tests / custom transports). */
  clientFactory?: (agent: string) => SpanoAIClient;
}

export interface SpanoMcpConfig {
  apiUrl: string;
  apiKey: string;
  defaultSession?: string;
  defaultAgent: string;
  maxInlineBytes: number;
}

const DEFAULT_MAX_INLINE_BYTES = 1_048_576; // 1 MiB — bigger files use the REST presigned flow.

export function resolveConfig(opts: SpanoMcpOptions = {}): SpanoMcpConfig {
  const apiKey = opts.apiKey ?? process.env.SPANOAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SpanoAI MCP: missing API key. Set SPANOAI_API_KEY (or pass { apiKey }).",
    );
  }
  const envMax = process.env.SPANOAI_MCP_MAX_INLINE_BYTES;
  return {
    apiUrl: opts.apiUrl ?? process.env.SPANOAI_API_URL ?? "http://localhost:8000",
    apiKey,
    defaultSession: opts.session ?? process.env.SPANOAI_SESSION,
    defaultAgent: opts.agent ?? process.env.SPANOAI_AGENT ?? "spano-mcp",
    maxInlineBytes: opts.maxInlineBytes ?? (envMax ? Number(envMax) : DEFAULT_MAX_INLINE_BYTES),
  };
}

/**
 * Tool execution context: resolved config plus a per-agent client cache. Each
 * distinct agent identity gets its own {@link SpanoAIClient} so the
 * `X-SpanoAI-Agent` header (writtenBy / fromAgent / claim identity) is correct
 * per call, without rebuilding a client every time.
 */
export interface ToolContext {
  readonly config: SpanoMcpConfig;
  clientFor(agent?: string): SpanoAIClient;
}

export function createToolContext(config: SpanoMcpConfig, opts: SpanoMcpOptions = {}): ToolContext {
  const cache = new Map<string, SpanoAIClient>();
  const make =
    opts.clientFactory ??
    ((agent: string) => new SpanoAIClient({ baseUrl: config.apiUrl, apiKey: config.apiKey, agent }));
  return {
    config,
    clientFor(agent?: string): SpanoAIClient {
      const id = agent ?? config.defaultAgent;
      let client = cache.get(id);
      if (!client) {
        client = make(id);
        cache.set(id, client);
      }
      return client;
    },
  };
}
