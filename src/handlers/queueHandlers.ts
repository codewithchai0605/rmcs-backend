import { AppError } from "../core/errors.js";
import { normalizeAvatarId, sanitizeName } from "../core/sanitize.js";
import { matchmakingQueue } from "../matchmaking/queue.js";
import { sessionRegistry } from "../ws/sessionRegistry.js";
import type { PayloadOf } from "../ws/inbound.js";
import { requireSession } from "./helpers.js";

export function handleQueueJoin(playerId: string, payload: PayloadOf<"queue_join">): void {
  const record = requireSession(playerId);

  if (record.roomId) {
    throw new AppError("ALREADY_IN_ROOM", "Leave your current room before joining matchmaking");
  }
  if (record.inQueue) {
    throw new AppError("ALREADY_IN_QUEUE", "You are already queued");
  }

  if (payload?.name) {
    sessionRegistry.updateProfile(playerId, sanitizeName(payload.name) || record.name, record.avatarId);
  }
  if (payload?.avatarId) {
    sessionRegistry.updateProfile(playerId, record.name, normalizeAvatarId(payload.avatarId));
  }

  matchmakingQueue.join({
    playerId,
    sessionToken: record.sessionToken,
    name: record.name,
    avatarId: record.avatarId,
    joinedAt: Date.now(),
  });
}

export function handleQueueLeave(playerId: string): void {
  const removed = matchmakingQueue.remove(playerId);
  if (removed) {
    sessionRegistry.send(playerId, { type: "queue_left", payload: {} });
  }
}
