import type { ChatMessage, GameRole, GameRoom, Player, ReplayState } from "./types";

export interface PublicPlayer {
  id: string;
  name: string;
  avatarId: string;
  isCreator: boolean;
  connected: boolean;
  joinedAt: number;
  /** Null if this player hasn't joined voice chat. */
  voiceSessionId: string | null;
  voiceTrackName: string | null;
  voiceMuted: boolean;
}

export interface PublicRoom {
  roomId: string;
  mode: GameRoom["mode"];
  hasPassword: boolean;
  creatorId: string | null;
  players: PublicPlayer[];
  playerCount: number;
  gameState: GameRoom["gameState"];
  currentRound: number;
  maxRounds: number;
  scores: Record<string, number>;
  createdAt: number;
}

export interface PublicReplayStatus {
  requestId: string | null;
  requestedBy: string | null;
  expiresAt: number | null;
  accepted: number;
  declined: number;
  pending: number;
  total: number;
}

/** playerId => role, only ever sent right after a round resolves. */
export type RevealedCards = Record<string, GameRole>;

export function toPublicPlayer(player: Player): PublicPlayer {
  return {
    id: player.id,
    name: player.name,
    avatarId: player.avatarId,
    isCreator: player.isCreator,
    connected: player.connected,
    joinedAt: player.joinedAt,
    voiceSessionId: player.voiceSessionId,
    voiceTrackName: player.voiceTrackName,
    voiceMuted: player.voiceMuted,
  };
}

export function toPublicRoom(room: GameRoom): PublicRoom {
  return {
    roomId: room.roomId,
    mode: room.mode,
    hasPassword: room.password !== null,
    creatorId: room.creatorId,
    players: room.players.map(toPublicPlayer),
    playerCount: room.players.length,
    gameState: room.gameState,
    currentRound: room.currentRound,
    maxRounds: room.maxRounds,
    scores: { ...room.scores },
    createdAt: room.createdAt,
  };
}

export function toPublicReplayStatus(replay: ReplayState, totalPlayers: number): PublicReplayStatus {
  let accepted = 0;
  let declined = 0;
  let pending = 0;

  for (const value of Object.values(replay.responses)) {
    if (value === true) accepted++;
    else if (value === false) declined++;
    else pending++;
  }

  return {
    requestId: replay.requestId,
    requestedBy: replay.requestedBy,
    expiresAt: replay.expiresAt,
    accepted,
    declined,
    pending,
    total: totalPlayers,
  };
}

export function toChatMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}