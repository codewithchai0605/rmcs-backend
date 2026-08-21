import { AppError } from "../core/errors.js";
import { sessionRegistry, type SessionRecord } from "../ws/sessionRegistry.js";

export function requireSession(playerId: string): SessionRecord {
  const record = sessionRegistry.getByPlayerId(playerId);
  if (!record) {
    throw new AppError("NOT_AUTHENTICATED", "Session not found - please reconnect");
  }
  return record;
}

export function requireRoomId(playerId: string): string {
  const record = requireSession(playerId);
  if (!record.roomId) {
    throw new AppError("NOT_IN_ROOM", "You are not currently in a room");
  }
  return record.roomId;
}
