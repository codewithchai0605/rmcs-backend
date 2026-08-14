import { roomManager } from "../game/roomManager.js";
import type { PayloadOf } from "../ws/inbound.js";
import { requireRoomId } from "./helpers.js";

export function handleChatSend(playerId: string, payload: PayloadOf<"chat_send">): void {
  const roomId = requireRoomId(playerId);
  roomManager.sendChat(roomId, playerId, payload.text);
}

export function handleReactionSend(playerId: string, payload: PayloadOf<"reaction_send">): void {
  const roomId = requireRoomId(playerId);
  roomManager.sendReaction(roomId, playerId, payload.emoji);
}