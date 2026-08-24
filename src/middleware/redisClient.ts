import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";

/**
 * Single shared ioredis connection, created lazily on first use and only if
 * REDIS_URL is configured. Every caller (currently just the rate limiter)
 * should go through getRedisClient() rather than constructing their own -
 * Upstash's free tier caps concurrent connections, so one shared client per
 * process matters.
 *
 * Deliberately fails fast rather than hanging: if Redis is unreachable, a
 * command rejects within ~3s instead of queueing indefinitely. Every call
 * site is expected to catch and fall back to local behavior (see
 * rateLimiter.allowAsync) - Redis being down should degrade the app, never
 * take it offline.
 */
let client: Redis | null = null;
let loggedUnavailable = false;

export function getRedisClient(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (client) return client;

  client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => Math.min(times * 500, 5_000),
  });

  client.on("error", (error: Error) => {
    // ioredis emits this repeatedly while reconnecting after a drop - log
    // once per outage rather than flooding the logs on every retry.
    if (!loggedUnavailable) {
      logger.warn("Redis connection error - falling back to in-memory rate limiting", { error: error.message });
      loggedUnavailable = true;
    }
  });

  client.on("ready", () => {
    loggedUnavailable = false;
    logger.info("Redis connected");
  });

  client.defineCommand("slidingWindowAllow", {
    numberOfKeys: 1,
    lua: `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local windowMs = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local member = ARGV[4]
      local windowStart = now - windowMs

      redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
      local count = redis.call('ZCARD', key)
      if count >= limit then
        return 0
      end
      redis.call('ZADD', key, now, member)
      redis.call('PEXPIRE', key, windowMs)
      return 1
    `,
  });

  return client;
}

/** Narrow type for the custom command registered above - ioredis has no way to type defineCommand() itself. */
export interface RedisWithSlidingWindow extends Redis {
  slidingWindowAllow(key: string, now: number, windowMs: number, limit: number, member: string): Promise<number>;
}

export async function closeRedisClient(): Promise<void> {
  if (!client) return;
  const toClose = client;
  client = null;
  try {
    await toClose.quit();
  } catch {
    toClose.disconnect();
  }
}
