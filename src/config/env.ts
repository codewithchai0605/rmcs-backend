import { readFileSync, existsSync } from "node:fs";

/**
 * Tiny .env loader so we don't need a `dotenv` dependency.
 * Only fills in keys that aren't already present in process.env,
 * so real environment variables (e.g. set by a process manager) always win.
 */
function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;

  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

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

  // --- Chat -------------------------------------------------------------
  CHAT_HISTORY_LIMIT: readNumber("CHAT_HISTORY_LIMIT", 200),
  CHAT_MESSAGE_MAX_LENGTH: readNumber("CHAT_MESSAGE_MAX_LENGTH", 500),

  // --- Connection / rate limiting ----------------------------------------
  MAX_CONNECTIONS_PER_IP: readNumber("MAX_CONNECTIONS_PER_IP", 8),
  WS_MAX_PAYLOAD_BYTES: readNumber("WS_MAX_PAYLOAD_BYTES", 16 * 1024),
  WS_IDLE_TIMEOUT_S: readNumber("WS_IDLE_TIMEOUT_S", 20),
  WS_MAX_BACKPRESSURE_BYTES: readNumber("WS_MAX_BACKPRESSURE_BYTES", 1024 * 1024),

  TRUST_PROXY_HEADERS: readBool("TRUST_PROXY_HEADERS", false),

  LOG_LEVEL: readString("LOG_LEVEL", "info"),
} as const;

export type Env = typeof env;