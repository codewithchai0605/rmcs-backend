import { startServer } from "./server";
import { logger } from "./core/logger";
import { roomManager } from "./game/roomManager";
import { sessionRegistry } from "./ws/sessionRegistry";
import { rateLimiter } from "./middleware/rateLimiter";
import { connectDb } from "./config/db";
import { dailyjob } from "./crons/daily";

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
