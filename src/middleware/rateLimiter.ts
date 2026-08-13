/**
 * Simple in-memory sliding-window rate limiter. Keyed by an arbitrary identity
 * (session token, player id, or IP) plus an action name, so different actions
 * can have independent limits without stepping on each other.
 */

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
  chat_send: { limit: 8, windowMs: 8_000 },
  make_guess: { limit: 10, windowMs: 10_000 },
  replay_request: { limit: 5, windowMs: 30_000 },
  replay_response: { limit: 10, windowMs: 30_000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>;

export type RateLimitedAction = keyof typeof RATE_LIMITS;
