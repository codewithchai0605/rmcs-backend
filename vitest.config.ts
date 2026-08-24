import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Applied to process.env before any test file (or the src modules it
    // imports) loads - config/env.ts reads these once at import time, so
    // this is the only reliable place to override them for the whole run.
    env: {
      NODE_ENV: "test",
      PORT: "18799",
      HOST: "127.0.0.1",
      ALLOWED_ORIGINS: "*",
      LOG_LEVEL: "error",
      // No REDIS_URL - integration/unit tests exercise the in-memory
      // rate-limiter fallback path, which is exactly what allowAsync()
      // degrades to whenever Redis isn't configured or reachable.
      DISCONNECT_GRACE_MS: "500",
      SESSION_SWEEP_MS: "999999999",
      EMPTY_ROOM_SWEEP_MS: "999999999",
      STALE_ROOM_MAX_AGE_MS: "999999999",
      ROUND_START_COUNTDOWN_MS: "150",
      POST_GAME_AUTO_RESET_MS: "999999999",
      REPLAY_TTL_MS: "999999999",
      // The whole suite connects from 127.0.0.1 - raise the per-IP cap well
      // past the production default (8) so it never interferes with tests.
      MAX_CONNECTIONS_PER_IP: "500",
    },
    // The integration suite boots one real server on a fixed port - keep
    // test files from running concurrently against each other so nothing
    // else races to bind that port or shares module-level singleton state
    // (rooms map, matchmaking queue, rate limiter buckets) across files.
    fileParallelism: false,
  },
});
