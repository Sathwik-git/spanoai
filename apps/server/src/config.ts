/**
 * Centralised, validated runtime configuration.
 *
 * Every environment variable the engine reads is declared here once, parsed
 * with Zod, and exported as a typed, frozen object. Nothing else in the
 * codebase should touch `process.env` directly — import `config` instead.
 */
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8000),

  REDIS_URL: z.string().default("redis://:spanoaidev@localhost:6379"),
  /** Per-command timeout (ms). Makes requests fail fast (503) during a Redis
   *  outage instead of hanging indefinitely. All engine ops are sub-ms. */
  SPANOAI_REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DATABASE_URL: z
    .string()
    .default("postgresql://spanoai:spanoaidev@localhost:5432/spanoai"),

  /** Idempotency record retention. Spec default: max(session TTL, 24h). */
  SPANOAI_OPS_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** Idle time before the sweeper reclaims a claimed-but-unacked message. */
  SPANOAI_VISIBILITY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),
  /** Approximate max length of an inbox stream (XADD MAXLEN ~) to bound memory. */
  SPANOAI_STREAM_MAXLEN: z.coerce.number().int().positive().default(10_000),

  /** Default session TTL in seconds (refreshed on activity). */
  SPANOAI_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  /** Max agents that may join one session (0 = unlimited). */
  SPANOAI_MAX_AGENTS_PER_SESSION: z.coerce.number().int().nonnegative().default(0),
  /** Max live entries per session (0 = unlimited; abuse guard). */
  SPANOAI_MAX_ENTRIES_PER_SESSION: z.coerce.number().int().nonnegative().default(0),

  /** Per-tenant request rate limit (requests per 60s sliding window). */
  SPANOAI_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(6_000),
  /** CORS allowed origin for the API. */
  CORS_ORIGIN: z.string().default("*"),

  /** Lifetime of a dashboard session token (issued on login). Default 7 days. */
  SPANOAI_DASHBOARD_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),

  /**
   * Which embedder the served engine wires in for semantic search.
   *   "hash" — deterministic, dependency-free (dev/default; no external API).
   *   "none" — semantic search disabled (search returns []).
   * Production deployments wanting real semantic recall inject a model embedder
   * programmatically via createEngine({ embedder }); this knob covers the
   * dependency-free path used by the served binary, SDKs and MCP tools.
   */
  SPANOAI_EMBEDDER: z.enum(["hash", "none"]).default("hash"),

  /** Max audit entries buffered in Redis while Postgres is unavailable. */
  SPANOAI_AUDIT_RETRY_MAX: z.coerce.number().int().positive().default(100_000),

  /** Background job intervals (ms). */
  SPANOAI_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  SPANOAI_AUDIT_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  SPANOAI_SESSION_CLEAN_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  SPANOAI_ARTIFACT_RETENTION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Number of events kept in the per-session WebSocket replay buffer. */
  SPANOAI_WS_BUFFER_SIZE: z.coerce.number().int().positive().default(100),
  /** TTL of the WebSocket replay buffer, in seconds. */
  SPANOAI_WS_BUFFER_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),

  // ── Object storage (artifacts) ──────────────────────────────────────
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_ACCESS_KEY_ID: z.string().default("minioadmin"),
  S3_SECRET_ACCESS_KEY: z.string().default("minioadmin"),
  S3_BUCKET: z.string().default("spanoai-artifacts"),
  S3_REGION: z.string().default("us-east-1"),

  /**
   * Claim-check threshold: the max byte size of an INLINE context value or
   * message payload (lives in Redis). Anything larger must be an artifact.
   * Default 256 KB — matches the industry inline-message band (SQS/SNS/Service
   * Bus) and keeps the real-time Redis/WebSocket path fast.
   */
  SPANOAI_MAX_INLINE_BYTES: z.coerce.number().int().positive().default(262_144),

  /**
   * Soft cap on artifact (file) byte size. 0 = unlimited. Files live in object
   * storage which scales to GB–TB, so this is a cost/abuse lever, not a
   * technical limit. Enforced against the actual uploaded size on `complete`.
   */
  SPANOAI_MAX_ARTIFACT_BYTES: z.coerce.number().int().nonnegative().default(0),

  /** TTL of a presigned upload URL, in seconds. */
  SPANOAI_ARTIFACT_UPLOAD_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  /** TTL of a presigned download URL, in seconds (spec default: 5 minutes). */
  SPANOAI_ARTIFACT_DOWNLOAD_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  /**
   * On `complete`, verify the SHA-256 by streaming the object back when its
   * size is <= this many bytes (downloading huge files to hash is wasteful).
   * Size is always verified via a cheap HEAD regardless. 0 = always hash.
   */
  SPANOAI_ARTIFACT_HASH_VERIFY_MAX_BYTES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(67_108_864),
});

export type Config = z.infer<typeof EnvSchema>;

function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}

export const config = loadConfig();

export const isProduction = config.NODE_ENV === "production";
export const isTest = config.NODE_ENV === "test";
