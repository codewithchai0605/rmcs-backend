import { env } from "../config/env";
import { AppError } from "../utils/errors";
import type { ChatMessage, GameResults, GameRole, GameRoom, Player, ReplayState, RoomMode, RoundResult } from "./types";

const ROLES: GameRole[] = ["Raja", "Mantri", "Chor", "Sipahi"];

function emptyReplayState(): ReplayState {
  return {
    active: false,
    requestId: null,
    requestedBy: null,
    requestedAt: null,
    expiresAt: null,
    responses: {},
  };
}

export function createRoomSkeleton(roomId: string, mode: RoomMode, password: string | null, maxRounds: number): GameRoom {
  const now = Date.now();
  return {
    roomId,
    mode,
    password,
    creatorId: null,
    players: [],
    gameState: "waiting",
    currentRound: 0,
    maxRounds,
    isOpen: false,
    openedAt: null,
    currentCards: {},
    roundResolved: true,
    scores: {},
    mantriPlayerId: null,
    rajaPlayerId: null,
    chorPlayerId: null,
    sipahiPlayerId: null,
    replay: emptyReplayState(),
    chat: [],
    createdAt: now,
    lastActivityAt: now,
    gameStartTime: null,
    gameEndTime: null,
    timers: {
      roundGuessTimeout: null,
      roundAdvance: null,
      replayExpiry: null,
      postGameReset: null,
      countdown: null,
    },
  };
}

export function touchActivity(room: GameRoom): void {
  room.lastActivityAt = Date.now();
}

export function clearRoomTimers(room: GameRoom): void {
  const { timers } = room;
  if (timers.roundGuessTimeout) clearTimeout(timers.roundGuessTimeout);
  if (timers.roundAdvance) clearTimeout(timers.roundAdvance);
  if (timers.replayExpiry) clearTimeout(timers.replayExpiry);
  if (timers.postGameReset) clearTimeout(timers.postGameReset);
  if (timers.countdown) clearTimeout(timers.countdown);
  timers.roundGuessTimeout = null;
  timers.roundAdvance = null;
  timers.replayExpiry = null;
  timers.postGameReset = null;
  timers.countdown = null;
}

export interface CreatePlayerInput {
  id: string;
  name: string;
  avatarId: string;
  isCreator: boolean;
}

/** Constructs a new Player with consistent defaults (voice starts unpublished/muted). */
export function createPlayer(input: CreatePlayerInput): Player {
  return {
    id: input.id,
    name: input.name,
    avatarId: input.avatarId,
    isCreator: input.isCreator,
    connected: true,
    joinedAt: Date.now(),
    voiceSessionId: null,
    voiceTrackName: null,
    voiceMuted: true,
  };
}

export function addPlayer(room: GameRoom, player: Player): void {
  room.players.push(player);
  room.scores[player.id] = 0;
  if (player.isCreator) room.creatorId = player.id;
  touchActivity(room);
}

export function removePlayerFromRoom(room: GameRoom, playerId: string): void {
  room.players = room.players.filter((p) => p.id !== playerId);
  delete room.scores[playerId];
  delete room.currentCards[playerId];

  if (room.replay.active) {
    delete room.replay.responses[playerId];
    if (room.replay.requestedBy === playerId) {
      room.replay = emptyReplayState();
    }
  }

  touchActivity(room);
}

export function hasPlayer(room: GameRoom, playerId: string): boolean {
  return room.players.some((p) => p.id === playerId);
}

export function distributeCards(room: GameRoom): void {
  const remainingCards = [...ROLES];
  const unassigned = [...room.players];

  room.currentCards = {};
  room.mantriPlayerId = null;
  room.rajaPlayerId = null;
  room.chorPlayerId = null;
  room.sipahiPlayerId = null;
  room.roundResolved = false;

  while (remainingCards.length > 0 && unassigned.length > 0) {
    const cardIndex = Math.floor(Math.random() * remainingCards.length);
    const playerIndex = Math.floor(Math.random() * unassigned.length);

    const card = remainingCards.splice(cardIndex, 1)[0];
    const player = unassigned.splice(playerIndex, 1)[0];
    if (!card || !player) continue;

    room.currentCards[player.id] = card;

    switch (card) {
      case "Raja":
        room.rajaPlayerId = player.id;
        break;
      case "Mantri":
        room.mantriPlayerId = player.id;
        break;
      case "Chor":
        room.chorPlayerId = player.id;
        break;
      case "Sipahi":
        room.sipahiPlayerId = player.id;
        break;
    }
  }

  touchActivity(room);
}

export function startGame(room: GameRoom): void {
  if (room.players.length !== env.ROOM_SIZE) {
    throw new AppError("NOT_ENOUGH_PLAYERS", `Need exactly ${env.ROOM_SIZE} players to start`);
  }

  room.gameState = "playing";
  room.currentRound = 1;
  room.gameStartTime = Date.now();
  room.gameEndTime = null;
  distributeCards(room);
  touchActivity(room);
}

/**
 * Resolves the current round's Mantri guess (or an automatic random guess if
 * the round guess timer expired). Mutates scores and marks the round resolved.
 */
export function resolveGuess(room: GameRoom, guessedPlayerId: string, auto: boolean): RoundResult {
  const chorPlayerId = room.chorPlayerId;
  if (!chorPlayerId) {
    throw new AppError("INTERNAL_ERROR", "Chor player not found for this round");
  }

  const isCorrect = guessedPlayerId === chorPlayerId;
  const roundScores: Record<string, number> = {};

  for (const player of room.players) {
    const card = room.currentCards[player.id];
    let score = 0;

    switch (card) {
      case "Raja":
        score = 1000;
        break;
      case "Mantri":
        score = isCorrect ? 800 : 0;
        break;
      case "Chor":
        score = isCorrect ? 0 : 800;
        break;
      case "Sipahi":
        score = 500;
        break;
      default:
        score = 0;
    }

    roundScores[player.id] = score;
    room.scores[player.id] = (room.scores[player.id] ?? 0) + score;
  }

  room.roundResolved = true;
  touchActivity(room);

  const cards: Record<string, GameRole> = {};
  for (const [playerId, role] of Object.entries(room.currentCards)) {
    if (role) cards[playerId] = role;
  }

  return {
    round: room.currentRound,
    isCorrect,
    auto,
    guessedPlayerId,
    chorPlayerId,
    roundScores,
    totalScores: { ...room.scores },
    cards,
  };
}

/** Advances to the next round, or marks the game finished if maxRounds was reached. Returns true if finished. */
export function nextRound(room: GameRoom): boolean {
  if (room.currentRound >= room.maxRounds) {
    room.gameState = "finished";
    room.gameEndTime = Date.now();
    touchActivity(room);
    return true;
  }

  room.currentRound += 1;
  distributeCards(room);
  touchActivity(room);
  return false;
}

export function forceEndGame(room: GameRoom): void {
  room.gameState = "finished";
  room.gameEndTime = Date.now();
  touchActivity(room);
}

export function getResults(room: GameRoom): GameResults {
  const rankings = room.players
    .map((player) => ({ ...player, score: room.scores[player.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);

  const totalScore = rankings.reduce((sum, p) => sum + p.score, 0);
  const averageScorePerRound = room.currentRound > 0 ? Math.round(totalScore / (rankings.length * room.currentRound)) : 0;

  return {
    rankings,
    winnerId: rankings[0]?.id ?? null,
    totalRounds: room.currentRound,
    gameDurationMs: room.gameEndTime && room.gameStartTime ? room.gameEndTime - room.gameStartTime : null,
    averageScorePerRound,
  };
}

/** Resets a room back to the lobby, keeping the current players and re-zeroing scores. */
export function resetToLobby(room: GameRoom): void {
  room.gameState = "waiting";
  room.currentRound = 0;
  room.currentCards = {};
  room.roundResolved = true;
  room.mantriPlayerId = null;
  room.rajaPlayerId = null;
  room.chorPlayerId = null;
  room.sipahiPlayerId = null;
  room.replay = emptyReplayState();
  room.gameStartTime = null;
  room.gameEndTime = null;

  for (const player of room.players) {
    room.scores[player.id] = 0;
  }

  touchActivity(room);
}

export function requestReplay(room: GameRoom, requestId: string, requestedBy: string, ttlMs: number): void {
  room.replay = {
    active: true,
    requestId,
    requestedBy,
    requestedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    responses: {},
  };

  for (const player of room.players) {
    room.replay.responses[player.id] = null;
  }
  room.replay.responses[requestedBy] = true;
  touchActivity(room);
}

export function respondReplay(room: GameRoom, playerId: string, accepted: boolean, requestId: string | null): void {
  if (!room.replay.active) {
    throw new AppError("REPLAY_NOT_ACTIVE", "No active replay request");
  }
  if (requestId && room.replay.requestId !== requestId) {
    throw new AppError("REPLAY_NOT_ACTIVE", "Replay request is no longer valid");
  }
  if (!hasPlayer(room, playerId)) {
    throw new AppError("NOT_IN_ROOM", "Player not in room");
  }

  const current = room.replay.responses[playerId];
  if (current !== null && current !== undefined) {
    throw new AppError("REPLAY_ALREADY_RESPONDED", "Replay response already submitted");
  }

  room.replay.responses[playerId] = accepted;
  touchActivity(room);
}

export function replayAllAccepted(room: GameRoom): boolean {
  return room.players.every((p) => room.replay.responses[p.id] === true);
}

export function replayAnyDeclined(room: GameRoom): boolean {
  return Object.values(room.replay.responses).some((v) => v === false);
}

export function clearReplay(room: GameRoom): void {
  room.replay = emptyReplayState();
  touchActivity(room);
}

export function appendChatMessage(room: GameRoom, message: ChatMessage): void {
  room.chat.push(message);
  if (room.chat.length > env.CHAT_HISTORY_LIMIT) {
    room.chat.splice(0, room.chat.length - env.CHAT_HISTORY_LIMIT);
  }
  touchActivity(room);
}