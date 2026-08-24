import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";

/**
 * Single shared ioredis connection, created on first use and only if
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
 *
 * Why not `lazyConnect: true` (the old setting): with enableOfflineQueue
 * false, ioredis only accepts a command when the socket status is "ready".
 * If a command is sent while the client is still in the "wait" status (i.e.
 * lazyConnect never triggered a connection yet), ioredis kicks off
 * connect() but - since that's async - evaluates the *same* command as not
 * writable yet and rejects it immediately with "Stream isn't writeable and
 * enableOfflineQueue options is false". With lazyConnect, that's not an
 * occasional race, it's guaranteed: the very first Redis-backed rate-limit
 * check after every process start (and Render free tier spins the process
 * down and back up regularly) always failed over to in-memory before Redis
 * had any chance to connect. Connecting eagerly (below) plus warming the
 * connection up at process startup (see warmUpRedisClient, called from
 * index.ts) gives the socket a head start so it's normally already "ready"
 * by the time real traffic arrives. enableOfflineQueue itself stays false
 * on purpose - a genuine outage should still fail fast rather than pile up
 * queued commands - this only removes the guaranteed cold-start failure.
 */
let client: Redis | null = null;
let loggedUnavailable = false;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

export function getRedisClient(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (client) return client;

  client = new Redis(env.REDIS_URL, {
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

  // This process is kept alive between requests (see crons/ping.ts), so the
  // shared connection can sit idle for minutes between Redis-backed rate
  // limit checks. Managed Redis providers, including Upstash, close TCP
  // connections that go idle for too long; without this, the next real
  // command after a gap pays for a full reconnect and - if it lands mid
  // reconnect - falls back to in-memory too. A cheap periodic PING keeps
  // the socket warm so that reconnects happen in the background instead of
  // on a player's request.
  keepAliveTimer = setInterval(
    () => {
      client?.ping().catch(() => {
        // Swallowed - the "error"/"ready" handlers above already cover
        // logging and recovery for a dead connection.
      });
    },
    4 * 60 * 1000,
  );
  keepAliveTimer.unref?.();

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

/**
 * Kicks off the shared Redis connection (if REDIS_URL is set) as early as
 * possible in the process lifetime and waits briefly for it to become
 * ready, so the connection has a head start before any real Redis-backed
 * rate-limit check can reach it. Call once from index.ts's startup
 * sequence, before the server starts accepting connections.
 *
 * Bounded by timeoutMs so a slow or unreachable Redis never delays server
 * startup - allowAsync() falls back to in-memory automatically regardless
 * of whether this warm-up finished in time.
 */
export async function warmUpRedisClient(timeoutMs = 2_000): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  if (redis.status === "ready") return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    redis.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function closeRedisClient(): Promise<void> {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (!client) return;
  const toClose = client;
  client = null;
  try {
    await toClose.quit();
  } catch {
    toClose.disconnect();
  }
}