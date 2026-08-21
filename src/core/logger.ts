import { env } from "../config/env";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel: LogLevel = (["debug", "info", "warn", "error"] as const).includes(
  env.LOG_LEVEL as LogLevel
)
  ? (env.LOG_LEVEL as LogLevel)
  : "info";

type Meta = Record<string, unknown>;

function write(level: LogLevel, message: string, meta?: Meta): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {}),
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: Meta) => write("debug", message, meta),
  info: (message: string, meta?: Meta) => write("info", message, meta),
  warn: (message: string, meta?: Meta) => write("warn", message, meta),
  error: (message: string, meta?: Meta) => write("error", message, meta),
};
