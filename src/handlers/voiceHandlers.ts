import { roomManager } from "../game/roomManager";
import type { PayloadOf } from "../ws/inbound";
import { requireRoomId } from "./helpers";

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