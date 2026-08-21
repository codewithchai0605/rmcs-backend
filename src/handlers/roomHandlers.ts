import { roomManager } from "../game/roomManager";
import type { PayloadOf } from "../ws/inbound";
import { requireRoomId } from "./helpers";

export function handleRoomLeave(playerId: string): void {
  const roomId = requireRoomId(playerId);
  roomManager.leaveRoom(roomId, playerId);
}

export function handleMakeGuess(playerId: string, payload: PayloadOf<"make_guess">): void {
  const roomId = requireRoomId(playerId);
  roomManager.makeGuess(roomId, playerId, payload.guessedPlayerId);
}

export function handleReplayRequest(playerId: string): void {
  const roomId = requireRoomId(playerId);
  roomManager.requestReplay(roomId, playerId);
}

export function handleReplayResponse(playerId: string, payload: PayloadOf<"replay_response">): void {
  const roomId = requireRoomId(playerId);
  roomManager.respondReplay(roomId, playerId, payload.accepted, payload.requestId);
}
