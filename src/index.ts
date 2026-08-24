import { startServer } from "./server.js";
import { logger } from "./core/logger.js";
import { roomManager } from "./game/roomManager.js";
import { sessionRegistry } from "./ws/sessionRegistry.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { closeRedisClient, warmUpRedisClient } from "./middleware/redisClient.js";
import { connectDb } from "./config/db.js";
import { dailyjob } from "./crons/daily.js";
import { pingjob } from "./crons/ping.js";
import { clearHistory, globalChat } from "./chat/globalChat.js";

async function main(): Promise<void> {
  await connectDb();
  // Give the shared Redis connection a head start (bounded, non-fatal) so
  // it's normally already "ready" before the first real rate-limit check
  // reaches it - see the comment in middleware/redisClient.ts for why this
  // matters. Falls straight through to in-memory limits if Redis is slow
  // or unset, so this never delays or blocks startup.
  await warmUpRedisClient();
  const server = await startServer();
  pingjob.start();
  dailyjob.start();
  clearHistory();
  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info("Shutting down", { signal });
    roomManager.destroy();
    sessionRegistry.destroy();
    rateLimiter.destroy();
    globalChat.destroy();
    closeRedisClient().catch(() => { });
    pingjob.stop();
    dailyjob.stop();
    server.stop();

    // Give in-flight sends a moment to flush before the process exits.
    setTimeout(() => process.exit(exitCode), 100).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    // Node's own guidance is that resuming normal operation after an
    // uncaughtException is unsafe - the code path that threw may have left
    // shared in-memory state (a room, the session registry, ...) mutated
    // only halfway, and every *other* connection now shares a process with
    // that corruption too. Log it and exit through the same shutdown() path
    // used for SIGINT/SIGTERM so in-flight sends still get a chance to
    // flush. This deploys to a platform that auto-restarts on exit, and the
    // client already reconnects with backoff on its own, so a clean crash
    // + restart is safer than quietly limping on in an unknown state.
    logger.error("Uncaught exception - shutting down", { error: error.message, stack: error.stack });
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection - shutting down", { reason: String(reason) });
    shutdown("unhandledRejection", 1);
  });
}

main().catch((error) => {
  logger.error("Fatal startup error", { error: (error as Error).message });
  process.exit(1);
});