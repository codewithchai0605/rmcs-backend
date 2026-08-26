import { AppError } from "../utils/errors";
import { normalizeAvatarId, normalizeRoomCode, sanitizeName } from "../utils/sanitize";
import { roomManager } from "../game/room.manager";
import { sessionRegistry } from "../websocket/session.registry";
import type { PayloadOf } from "../websocket/inbound";
import { requireRoomId, requireSession } from "./helpers";

function ensureNotBusy(record: ReturnType<typeof requireSession>): void {
  if (record.roomId) {
    throw new AppError("ALREADY_IN_ROOM", "Leave your current room first");
  }
  if (record.inQueue) {
    throw new AppError("ALREADY_IN_QUEUE", "Leave matchmaking first");
  }
}

export function handlePrivateRoomCreate(playerId: string, payload: PayloadOf<"private_room_create">): void {
  const record = requireSession(playerId);
  ensureNotBusy(record);

  const name = payload.name ? sanitizeName(payload.name) || record.name : record.name;
  const avatarId = payload.avatarId ? normalizeAvatarId(payload.avatarId) : record.avatarId;
  sessionRegistry.updateProfile(playerId, name, avatarId);

  roomManager.createPrivateRoom(playerId, name, avatarId, {
    password: payload.password,
    maxRounds: payload.maxRounds,
  });
}

export function handlePrivateRoomJoin(playerId: string, payload: PayloadOf<"private_room_join">): void {
  const record = requireSession(playerId);
  ensureNotBusy(record);

  const roomId = normalizeRoomCode(payload.roomId);
  const name = payload.name ? sanitizeName(payload.name) || record.name : record.name;
  const avatarId = payload.avatarId ? normalizeAvatarId(payload.avatarId) : record.avatarId;
  sessionRegistry.updateProfile(playerId, name, avatarId);

  roomManager.joinPrivateRoom(playerId, name, avatarId, roomId, payload.password);
}

export function handleRoomKick(playerId: string, payload: PayloadOf<"room_kick">): void {
  const roomId = requireRoomId(playerId);
  roomManager.kickPlayer(roomId, playerId, payload.targetPlayerId);
}

export function handleRoomUpdateSettings(playerId: string, payload: PayloadOf<"room_update_settings">): void {
  const roomId = requireRoomId(playerId);
  roomManager.updateSettings(roomId, playerId, payload);
}

export function handleRoomStart(playerId: string): void {
  const roomId = requireRoomId(playerId);
  roomManager.startGameManually(roomId, playerId);
}
