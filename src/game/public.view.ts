import { env } from "../config/env";
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
  /** Whether this room is currently discoverable via the open-rooms list (see roomManager). */
  isOpen: boolean;
}

/**
 * Slim projection of a room used for the server-wide "open rooms" browse
 * list (Home/Matchmaking screens). Deliberately smaller than PublicRoom -
 * never includes hasPassword (instant-join always bypasses it) and only
 * carries what a browse card needs to render.
 */
export interface PublicOpenRoom {
  roomId: string;
  hostId: string | null;
  hostName: string | null;
  hostAvatarId: string | null;
  players: PublicPlayer[];
  playerCount: number;
  maxPlayers: number;
  maxRounds: number;
  openedAt: number;
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
    isOpen: room.isOpen,
  };
}

/** Only meaningful for a room currently eligible for the open-rooms list - see roomManager.refreshOpenListing. */
export function toPublicOpenRoom(room: GameRoom): PublicOpenRoom {
  const host = room.players.find((p) => p.id === room.creatorId) ?? null;
  return {
    roomId: room.roomId,
    hostId: room.creatorId,
    hostName: host?.name ?? null,
    hostAvatarId: host?.avatarId ?? null,
    players: room.players.map(toPublicPlayer),
    playerCount: room.players.length,
    maxPlayers: env.ROOM_SIZE,
    maxRounds: room.maxRounds,
    openedAt: room.openedAt ?? room.createdAt,
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