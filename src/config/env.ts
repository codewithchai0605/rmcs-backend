import "dotenv/config";
function readString(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.length > 0 ? value : fallback;
}

function readNumber(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readList(key: string, fallback: string[]): string[] {
  const value = process.env[key];
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export const env = {
  NODE_ENV: readString("NODE_ENV", "development"),
  PORT: readNumber("PORT", 8080),
  HOST: readString("HOST", "0.0.0.0"),

  // Comma separated list of allowed browser origins. Use "*" to allow any origin (dev only).
  ALLOWED_ORIGINS: readList("ALLOWED_ORIGINS", ["*"]),

  // Optional TLS. If both are set, the server listens with SSLApp instead of App.
  SSL_KEY_FILE: process.env.SSL_KEY_FILE,
  SSL_CERT_FILE: process.env.SSL_CERT_FILE,

  // --- Game / room tuning -----------------------------------------------
  ROOM_SIZE: readNumber("ROOM_SIZE", 4),
  DEFAULT_MAX_ROUNDS: readNumber("DEFAULT_MAX_ROUNDS", 15),
  MIN_MAX_ROUNDS: readNumber("MIN_MAX_ROUNDS", 4),
  MAX_MAX_ROUNDS: readNumber("MAX_MAX_ROUNDS", 30),
  MAX_PRIVATE_ROOMS: readNumber("MAX_PRIVATE_ROOMS", 500),
  ROUND_GUESS_TIMEOUT_MS: readNumber("ROUND_GUESS_TIMEOUT_MS", 45_000),
  ROUND_RESULT_DISPLAY_MS: readNumber("ROUND_RESULT_DISPLAY_MS", 4_000),
  ROUND_START_COUNTDOWN_MS: readNumber("ROUND_START_COUNTDOWN_MS", 3_000),
  REPLAY_TTL_MS: readNumber("REPLAY_TTL_MS", 30_000),
  POST_GAME_AUTO_RESET_MS: readNumber("POST_GAME_AUTO_RESET_MS", 30_000),
  EMPTY_ROOM_SWEEP_MS: readNumber("EMPTY_ROOM_SWEEP_MS", 300_000),
  STALE_ROOM_MAX_AGE_MS: readNumber("STALE_ROOM_MAX_AGE_MS", 600_000),

  // --- Session / reconnect -------------------------------------------
  DISCONNECT_GRACE_MS: readNumber("DISCONNECT_GRACE_MS", 25_000),
  SESSION_SWEEP_MS: readNumber("SESSION_SWEEP_MS", 60_000),
  REDIS_URL: process.env.REDIS_URL || undefined,

  // --- Chat ---------------------------------------------------------------
  CHAT_HISTORY_LIMIT: readNumber("CHAT_HISTORY_LIMIT", 50),
  CHAT_MESSAGE_MAX_LENGTH: readNumber("CHAT_MESSAGE_MAX_LENGTH", 250),

  // --- Global (server-wide, non-room) chat -------------------------------
  GLOBAL_CHAT_HISTORY_LIMIT: readNumber("GLOBAL_CHAT_HISTORY_LIMIT", 200),
  GLOBAL_CHAT_MESSAGE_MAX_LENGTH: readNumber("GLOBAL_CHAT_MESSAGE_MAX_LENGTH", 250),

  // --- Connection / rate limiting ----------------------------------------
  MAX_CONNECTIONS_PER_IP: readNumber("MAX_CONNECTIONS_PER_IP", 8),
  WS_MAX_PAYLOAD_BYTES: readNumber("WS_MAX_PAYLOAD_BYTES", 16 * 1024),
  // uWS auto-pings roughly every idleTimeout/2 seconds and force-closes the
  // socket if nothing (including a pong) comes back within idleTimeout.
  // Kept fairly tight so other players find out someone dropped promptly,
  // without being so aggressive that a brief mobile-network blip trips it.
  WS_IDLE_TIMEOUT_S: readNumber("WS_IDLE_TIMEOUT_S", 20),
  WS_MAX_BACKPRESSURE_BYTES: readNumber("WS_MAX_BACKPRESSURE_BYTES", 1024 * 1024),

  TRUST_PROXY_HEADERS: readBool("TRUST_PROXY_HEADERS", false),

  // --- Voice chat (Cloudflare Calls) --------------------------------------
  // Cloudflare's managed WebRTC SFU. Get these from the Cloudflare dashboard
  // under Realtime > Calls after creating an "App": the App ID is public-ish
  // (sent to Cloudflare per request) but the App Token is a secret and must
  // never reach the client - that's exactly why these proxy routes exist.
  // Voice chat is simply unavailable (registration/join requests fail with
  // a clear error) if these aren't set - everything else in the app works
  // fine without them.
  CLOUDFLARE_APP_ID: process.env.CLOUDFLARE_APP_ID,
  CLOUDFLARE_APP_TOKEN: process.env.CLOUDFLARE_APP_TOKEN,
  CLOUDFLARE_CALLS_API_BASE: readString("CLOUDFLARE_CALLS_API_BASE", "https://rtc.live.cloudflare.com/v1"),

  // --- Admin usage reporting (separate, account-level Cloudflare API) ------
  // This is a *different* credential pair than the Calls App ID/Token above:
  // it's a normal Cloudflare account API token (Billing/Usage read scope),
  // used only to query how much of the Realtime free tier (1000 GB/month)
  // has been consumed - not to create/manage SFU sessions.
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,

  LOG_LEVEL: readString("LOG_LEVEL", "info"),

  MONGOOSE_URI: process.env.MONGOOSE_URI,

  // --- Admin auth (JWT access + refresh tokens) ---------------------------
  // No fallback on purpose: admin auth is hard-disabled with a clear 503
  // (see middleware/adminAuth.ts's assertAuthConfigured) if these aren't
  // set, the same "everything else still works" pattern used for the
  // Cloudflare Calls voice credentials above - rather than crashing the
  // whole process over a feature that's independent of gameplay.
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_ACCESS_TTL_SECONDS: readNumber("JWT_ACCESS_TTL_SECONDS", 15 * 60), // 15 minutes
  JWT_REFRESH_TTL_SECONDS: readNumber("JWT_REFRESH_TTL_SECONDS", 30 * 24 * 60 * 60), // 30 days

  // Failed-login lockout (defense in depth alongside the IP/username rate
  // limits in http/adminRoutes.ts).
  ADMIN_LOGIN_MAX_ATTEMPTS: readNumber("ADMIN_LOGIN_MAX_ATTEMPTS", 8),
  ADMIN_LOGIN_LOCKOUT_MS: readNumber("ADMIN_LOGIN_LOCKOUT_MS", 15 * 60_000),

  // Secret the external midnight cron must present to trigger aggregation
  // over HTTP. Optional - the cron can instead just run
  // `node dist/scripts/aggregateDailyUsage` directly against the same
  // database, which needs no HTTP exposure at all (see that script's
  // header comment). Set this only if the external cron can't do that.
  CRON_SECRET: process.env.CRON_SECRET
} as const;

export type Env = typeof env;