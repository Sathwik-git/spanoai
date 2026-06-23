/**
 * Redis connection management.
 *
 * The engine needs three logical connections:
 *   - `redis`     — normal commands (GET/SET/streams/Lua/...)
 *   - `redisPub`  — publishing wake-up / broadcast notifications
 *   - `redisSub`  — a connection in subscriber mode (can only sub/unsub/ping)
 *
 * A subscribed connection enters "subscriber mode" in Redis and cannot issue
 * regular commands, which is exactly why pub/sub needs its own socket.
 *
 * `lazyConnect: true` means no socket is opened until the first command. This
 * keeps imports side-effect-free (cleaner tests, and avoids a known Bun
 * build-time DNS resolution loop with ioredis: oven-sh/bun#19086).
 */
import { Redis, type RedisOptions } from "ioredis";
import { config } from "./config";

const baseOptions: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableAutoPipelining: true,
  // Fail a command fast (instead of hanging forever) if Redis is unreachable —
  // the API maps the timeout to 503. All engine commands are non-blocking and
  // sub-millisecond, so this ceiling never trips in normal operation.
  commandTimeout: config.SPANOAI_REDIS_COMMAND_TIMEOUT_MS,
  retryStrategy: (times) => Math.min(times * 200, 2_000),
};

/**
 * Build a fresh trio of connections for a given Redis URL. Tests use this to
 * target an isolated DB index without touching the process-wide singletons.
 */
export function createConnections(url: string = config.REDIS_URL): {
  redis: Redis;
  redisPub: Redis;
  redisSub: Redis;
} {
  const redis = new Redis(url, baseOptions);
  // `duplicate()` clones options but NOT defineCommand scripts (ioredis#1496);
  // pub/sub connections never run the Lua scripts, so that is fine here.
  const redisPub = redis.duplicate();
  const redisSub = redis.duplicate();
  return { redis, redisPub, redisSub };
}

const connections = createConnections();

export const redis = connections.redis;
export const redisPub = connections.redisPub;
export const redisSub = connections.redisSub;

/** Close all process-wide connections cleanly (used on shutdown). */
export async function closeConnections(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisPub.quit(), redisSub.quit()]);
}
