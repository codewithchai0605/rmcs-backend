import { env } from "../config/env.js";
import { logger } from "../core/logger.js";
import { AppError } from "../core/errors.js";
import type { QueueEntry } from "../game/types.js";
import { sessionRegistry } from "../ws/sessionRegistry.js";
import { roomManager } from "../game/roomManager.js";

// Map preserves insertion order, which is exactly the FIFO behaviour we want.
const queue = new Map<string, QueueEntry>();

function broadcastQueueStatus(): void {
  const waiting = queue.size;
  for (const entry of queue.values()) {
    sessionRegistry.send(entry.playerId, {
      type: "queue_status",
      payload: { waiting, needed: env.ROOM_SIZE },
    });
  }
}

function tryFormMatch(): void {
  while (queue.size >= env.ROOM_SIZE) {
    const entries: QueueEntry[] = [];
    for (const key of queue.keys()) {
      if (entries.length >= env.ROOM_SIZE) break;
      const entry = queue.get(key);
      if (entry) entries.push(entry);
    }

    for (const entry of entries) {
      queue.delete(entry.playerId);
      sessionRegistry.setInQueue(entry.playerId, false);
    }

    try {
      roomManager.createRandomMatch(entries);
    } catch (error) {
      logger.error("Failed to form random match", { error: (error as Error).message });
      // Put players back at the front of the queue conceptually - simplest safe
      // recovery is to notify them so the client can retry.
      for (const entry of entries) {
        sessionRegistry.send(entry.playerId, {
          type: "error",
          payload: { code: "INTERNAL_ERROR", message: "Could not start your match, please try again." },
        });
      }
    }
  }

  broadcastQueueStatus();
}

function join(entry: QueueEntry): void {
  if (queue.has(entry.playerId)) {
    throw new AppError("ALREADY_IN_QUEUE", "You are already queued");
  }

  queue.set(entry.playerId, entry);
  sessionRegistry.setInQueue(entry.playerId, true);
  tryFormMatch();
}

function remove(playerId: string): boolean {
  const removed = queue.delete(playerId);
  if (removed) {
    sessionRegistry.setInQueue(playerId, false);
    broadcastQueueStatus();
  }
  return removed;
}

function size(): number {
  return queue.size;
}

export const matchmakingQueue = {
  join,
  remove,
  size,
};
