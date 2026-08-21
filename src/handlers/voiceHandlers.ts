import { roomManager } from "../game/roomManager.js";
import type { PayloadOf } from "../ws/inbound.js";
import { requireRoomId } from "./helpers.js";

export function handleVoicePublished(playerId: string, payload: PayloadOf<"voice_published">): void {
    const roomId = requireRoomId(playerId);
    roomManager.publishVoice(roomId, playerId, payload.sessionId, payload.trackName);
}

export function handleVoiceUnpublish(playerId: string): void {
    const roomId = requireRoomId(playerId);
    roomManager.unpublishVoice(roomId, playerId);
}

export function handleVoiceMute(playerId: string, payload: PayloadOf<"voice_mute">): void {
    const roomId = requireRoomId(playerId);
    roomManager.setVoiceMuted(roomId, playerId, payload.muted);
}