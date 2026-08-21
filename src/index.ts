import { startServer } from "./server.js";
import { logger } from "./core/logger.js";
import { roomManager } from "./game/roomManager.js";
import { sessionRegistry } from "./ws/sessionRegistry.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { connectDb } from "./config/db.js";
import { dailyjob } from "./crons/daily.js";

async function main(): Promise<void> {
  await connectDb();
  const server = await startServer();
  dailyjob.start();
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info("Shutting down", { signal });
    roomManager.destroy();
    sessionRegistry.destroy();
    rateLimiter.destroy();
    dailyjob.stop();
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
