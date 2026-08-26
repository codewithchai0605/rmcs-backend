import { AppError } from "../utils/errors";
import { normalizeAvatarId, normalizeRoomCode, sanitizeName } from "../utils/sanitize";
import { roomManager } from "../game/room.manager";
import { matchmakingQueue } from "../matchmaking/queue";
import { sessionRegistry } from "../websocket/session.registry";
import type { PayloadOf } from "../websocket/inbound";
import { requireRoomId, requireSession } from "./helpers";

export function handleRoomSetOpen(playerId: string, payload: PayloadOf<"room_set_open">): void {
  const roomId = requireRoomId(playerId);
  roomManager.setRoomOpen(roomId, playerId, payload.open);
}

export function handleOpenRoomsSubscribe(playerId: string): void {
  roomManager.subscribeOpenRooms(playerId);
}

export function handleOpenRoomsUnsubscribe(playerId: string): void {
  roomManager.unsubscribeOpenRooms(playerId);
}

/**
 * The one-tap "instant join" from the open-rooms browse list. Unlike
 * private_room_join, this deliberately does NOT reject a player who's
 * currently in the matchmaking queue - it pulls them out of the queue
 * first so they can't be scooped into a random match immediately after
 * joining here, then proceeds. Both steps are synchronous with no `await`
 * in between, so there's no window for the queue to re-add them.
 */
export function handleOpenRoomJoin(playerId: string, payload: PayloadOf<"open_room_join">): void {
  const record = requireSession(playerId);
  if (record.roomId) {
    throw new AppError("ALREADY_IN_ROOM", "Leave your current room first");
  }

  const wasQueued = record.inQueue;
  if (wasQueued) {
    matchmakingQueue.remove(playerId);
  }

  const roomId = normalizeRoomCode(payload.roomId);
  const name = payload.name ? sanitizeName(payload.name) || record.name : record.name;
  const avatarId = payload.avatarId ? normalizeAvatarId(payload.avatarId) : record.avatarId;
  sessionRegistry.updateProfile(playerId, name, avatarId);

  try {
    roomManager.joinOpenRoom(playerId, name, avatarId, roomId);
  } catch (error) {
    if (wasQueued) {
      // The join failed (e.g. the room filled up a moment before this
      // message was processed) - put them back in matchmaking rather than
      // leaving them stranded in neither the queue nor a room.
      try {
        matchmakingQueue.join({
          playerId,
          sessionToken: record.sessionToken,
          name: record.name,
          avatarId: record.avatarId,
          joinedAt: Date.now(),
        });
      } catch {
        // best-effort - the original error still propagates to the client below
      }
    }
    throw error;
  }
}
