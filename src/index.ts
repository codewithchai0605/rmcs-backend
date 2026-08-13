import { startServer } from "./server.js";
import { logger } from "./core/logger.js";
import { roomManager } from "./game/roomManager.js";
import { sessionRegistry } from "./ws/sessionRegistry.js";
import { rateLimiter } from "./middleware/rateLimiter.js";

async function main(): Promise<void> {
  const server = await startServer();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info("Shutting down", { signal });
    roomManager.destroy();
    sessionRegistry.destroy();
    rateLimiter.destroy();
    server.stop();

    // Give in-flight sends a moment to flush before the process exits.
    setTimeout(() => process.exit(0), 100).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error: error.message, stack: error.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { reason: String(reason) });
  });
}

main().catch((error) => {
  logger.error("Fatal startup error", { error: (error as Error).message });
  process.exit(1);
});
