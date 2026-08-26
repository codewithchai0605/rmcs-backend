/**
 * Rate limiter with two faces:
 *  - allow(): the original synchronous, purely in-memory sliding-window
 *    check. Used for the blanket per-connection flood guard and HTTP
 *    routes, where a hard dependency on network I/O would be the wrong
 *    trade-off (a flood guard needs to be instant; uWS HttpRequest is only
 *    valid synchronously, so awaiting mid-handler isn't free there either).
 *  - allowAsync(): Redis-backed when REDIS_URL is configured, so limits on
 *    real player actions (chat, joining rooms, etc.) are enforced
 *    consistently across multiple server instances instead of each
 *    process keeping its own local buckets. Falls back to the exact same
 *    in-memory logic - automatically, per call, with a logged warning -
 *    whenever Redis isn't configured or a call fails/times out. It never
 *    throws and never blocks longer than the client's connectTimeout.
 */
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger";
import { getRedisClient, type RedisWithSlidingWindow } from "./redis.client";

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

function key(identity: string, action: string): string {
  return `${action}:${identity}`;
}

/**
 * Returns true if the call is allowed (and records it), false if the identity
 * has exceeded `limit` calls for `action` within the last `windowMs`.
 */
function allow(identity: string, action: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucketKey = key(identity, action);

  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(bucketKey, bucket);
  }

  const windowStart = now - windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

  if (bucket.timestamps.length >= limit) {
    return false;
  }

  bucket.timestamps.push(now);
  return true;
}

/**
 * Same semantics as allow(), backed by Redis when available. Safe to call
 * on every message - on any Redis failure it transparently falls back to
 * the in-memory allow() above rather than rejecting or blocking the caller.
 */
async function allowAsync(identity: string, action: string, limit: number, windowMs: number): Promise<boolean> {
  const client = getRedisClient();
  if (!client) {
    return allow(identity, action, limit, windowMs);
  }

  try {
    const now = Date.now();
    const result = await (client as RedisWithSlidingWindow).slidingWindowAllow(
      `rl:${key(identity, action)}`,
      now,
      windowMs,
      limit,
      `${now}-${randomUUID()}`
    );
    return result === 1;
  } catch (error) {
    logger.warn("Redis rate-limit check failed - falling back to in-memory", {
      action,
      error: (error as Error).message,
    });
    return allow(identity, action, limit, windowMs);
  }
}

function reset(identity: string, action: string): void {
  buckets.delete(key(identity, action));
}

/** Periodic sweep so long-idle buckets don't accumulate forever. */
function sweep(maxAgeMs: number): void {
  const now = Date.now();
  for (const [bucketKey, bucket] of buckets) {
    const last = bucket.timestamps[bucket.timestamps.length - 1];
    if (last === undefined || now - last > maxAgeMs) {
      buckets.delete(bucketKey);
    }
  }
}

const sweepInterval = setInterval(() => sweep(10 * 60 * 1000), 5 * 60 * 1000);
sweepInterval.unref?.();

function destroy(): void {
  clearInterval(sweepInterval);
  buckets.clear();
}

export const rateLimiter = {
  allow,
  allowAsync,
  reset,
  destroy,
};

/**
 * Named limits for each client action. Centralized here so tuning the whole
 * app's rate limits means editing one table instead of hunting through handlers.
 */
export const RATE_LIMITS = {
  ws_message: { limit: 40, windowMs: 10_000 }, // blanket flood guard across all message types
  set_name: { limit: 5, windowMs: 30_000 },
  queue_join: { limit: 10, windowMs: 30_000 },
  queue_leave: { limit: 10, windowMs: 30_000 },
  private_room_create: { limit: 5, windowMs: 60_000 },
  private_room_join: { limit: 10, windowMs: 60_000 },
  room_leave: { limit: 10, windowMs: 30_000 },
  room_start: { limit: 10, windowMs: 30_000 },
  room_kick: { limit: 10, windowMs: 30_000 },
  room_update_settings: { limit: 10, windowMs: 30_000 },
  room_set_open: { limit: 10, windowMs: 30_000 },
  open_rooms_subscribe: { limit: 20, windowMs: 30_000 },
  open_rooms_unsubscribe: { limit: 20, windowMs: 30_000 },
  open_room_join: { limit: 10, windowMs: 30_000 },
  chat_send: { limit: 8, windowMs: 8_000 },
  global_chat_send: { limit: 8, windowMs: 8_000 },
  reaction_send: { limit: 20, windowMs: 15_000 },
  voice_published: { limit: 5, windowMs: 30_000 },
  voice_unpublish: { limit: 5, windowMs: 30_000 },
  voice_mute: { limit: 20, windowMs: 15_000 }, // mute is a quick toggle players might tap repeatedly
  make_guess: { limit: 10, windowMs: 10_000 },
  replay_request: { limit: 5, windowMs: 30_000 },
  replay_response: { limit: 10, windowMs: 30_000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>;

export type RateLimitedAction = keyof typeof RATE_LIMITS;