import type { ErrorCode } from "../core/errors.js";
import type { ChatMessage, GameRole } from "../game/types.js";
import type { PublicOpenRoom, PublicPlayer, PublicReplayStatus, PublicRoom, RevealedCards } from "../game/publicView.js";
import type { GlobalChatMessage } from "../chat/globalChat.js";

/** Shared fields broadcast to every player for the current round/game snapshot. */
export interface GameRoundView {
  roomId: string;
  gameState: "playing";
  round: number;
  maxRounds: number;
  players: PublicPlayer[];
  scores: Record<string, number>;
  mantriPlayerId: string;
  /** Only this connection's own role is ever included - see docs/PROTOCOL.md. */
  yourCard: GameRole | null;
}

export interface RoundResultView {
  round: number;
  isCorrect: boolean;
  auto: boolean;
  guessedPlayerId: string;
  guessedPlayerName: string;
  chorPlayerId: string;
  chorPlayerName: string;
  roundScores: Record<string, number>;
  totalScores: Record<string, number>;
  cards: RevealedCards;
}

export interface GameFinishedView {
  rankings: Array<{ playerId: string; name: string; avatarId: string; score: number }>;
  winnerId: string | null;
  totalRounds: number;
  gameDurationMs: number | null;
  averageScorePerRound: number;
}

export type ServerEvent =
  | { type: "welcome"; payload: { playerId: string; sessionToken: string; name: string; avatarId: string; resumed: boolean } }
  | { type: "name_updated"; payload: { name: string; avatarId: string } }
  | { type: "queue_status"; payload: { waiting: number; needed: number } }
  | { type: "queue_left"; payload: Record<string, never> }
  | { type: "match_found"; payload: { roomId: string } }
  | { type: "room_created"; payload: { roomId: string; hasPassword: boolean } }
  | { type: "room_state"; payload: { room: PublicRoom } }
  | { type: "chat_history"; payload: { messages: ChatMessage[] } }
  | { type: "chat_message"; payload: { message: ChatMessage } }
  | { type: "player_joined"; payload: { player: PublicPlayer; room: PublicRoom } }
  | { type: "player_left"; payload: { playerId: string; name: string; room: PublicRoom } }
  | { type: "player_disconnected"; payload: { playerId: string; name: string } }
  | { type: "player_reconnected"; payload: { playerId: string; name: string } }
  | { type: "creator_changed"; payload: { newCreatorId: string; newCreatorName: string } }
  | { type: "room_disbanded"; payload: { reason: string } }
  | { type: "kicked"; payload: { reason: string } }
  | { type: "room_settings_updated"; payload: { room: PublicRoom } }
  | { type: "room_open_changed"; payload: { room: PublicRoom } }
  | { type: "open_rooms_snapshot"; payload: { rooms: PublicOpenRoom[] } }
  | { type: "open_room_updated"; payload: { room: PublicOpenRoom } }
  | { type: "open_room_removed"; payload: { roomId: string } }
  | { type: "global_chat_history"; payload: { messages: GlobalChatMessage[] } }
  | { type: "global_chat_message"; payload: { message: GlobalChatMessage } }
  | { type: "game_starting"; payload: { countdownMs: number } }
  | { type: "game_started"; payload: GameRoundView }
  | { type: "game_updated"; payload: GameRoundView }
  | { type: "round_result"; payload: RoundResultView }
  | { type: "game_finished"; payload: GameFinishedView }
  | { type: "game_reset"; payload: { room: PublicRoom } }
  | { type: "replay_requested"; payload: PublicReplayStatus }
  | { type: "replay_status"; payload: PublicReplayStatus }
  | { type: "replay_cancelled"; payload: { by: string } }
  | { type: "replay_expired"; payload: Record<string, never> }
  | { type: "reaction"; payload: { id: string; playerId: string; playerName: string; emoji: string; ts: number } }
  | { type: "voice_participant_published"; payload: { playerId: string; sessionId: string; trackName: string } }
  | { type: "voice_participant_left"; payload: { playerId: string } }
  | { type: "voice_participant_muted"; payload: { playerId: string; muted: boolean } }
  | { type: "session_replaced"; payload: Record<string, never> }
  | { type: "error"; payload: { code: ErrorCode; message: string } };

export function encodeEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}