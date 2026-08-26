import { env } from "../config/env";
import { logger } from "../utils/logger";
import { AppError } from "../utils/errors";
import { generateEventId, generateInternalRoomId, generateRoomCode } from "../utils/ids";
import { sanitizeChatText } from "../utils/sanitize";
import type { ChatMessage, GameRoom, Player, QueueEntry } from "./types";
import * as logic from "./logic";
import { toPublicOpenRoom, toPublicPlayer, toPublicReplayStatus, toPublicRoom } from "./public.view";
import { OPEN_ROOMS_TOPIC, publishOpenRooms, publishToRoom, roomTopic } from "../websocket/publish";
import { sessionRegistry } from "../websocket/session.registry";
import { matchmakingQueue } from "../matchmaking/queue";
import type { GameFinishedView, GameRoundView } from "../websocket/outbound";

const rooms = new Map<string, GameRoom>();

// Tracks which roomIds are currently broadcast on the open-rooms topic, so
// we only ever emit one "removed" event per room (instead of spamming it on
// every mutation of an already-ineligible room) and so player-count-zero
// cleanup can detect "was this listed?" without re-deriving it from a room
// object that's about to be deleted.
const openRoomIds = new Set<string>();

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function getRoomOrThrow(roomId: string): GameRoom {
  const room = rooms.get(roomId);
  if (!room) throw new AppError("ROOM_NOT_FOUND", "Room not found");
  return room;
}

function findPlayer(room: GameRoom, playerId: string): Player | undefined {
  return room.players.find((p) => p.id === playerId);
}

function clampMaxRounds(value: number | undefined): number {
  if (value === undefined) return env.DEFAULT_MAX_ROUNDS;
  return Math.min(env.MAX_MAX_ROUNDS, Math.max(env.MIN_MAX_ROUNDS, Math.round(value)));
}

function subscribePlayerToRoom(playerId: string, roomId: string): void {
  const record = sessionRegistry.getByPlayerId(playerId);
  if (!record?.ws) return;
  try {
    record.ws.subscribe(roomTopic(roomId));
  } catch (error) {
    logger.warn("Failed to subscribe socket to room topic", { playerId, roomId, error: (error as Error).message });
  }
}

function unsubscribePlayerFromRoom(playerId: string, roomId: string): void {
  const record = sessionRegistry.getByPlayerId(playerId);
  if (!record?.ws) return;
  try {
    record.ws.unsubscribe(roomTopic(roomId));
  } catch {
    // socket may already be gone - nothing to do
  }
}

// ---------------------------------------------------------------------------
// Open-rooms browse list (Home/Matchmaking "instant join" discovery)
// ---------------------------------------------------------------------------

/** A room is discoverable exactly while it's a private, non-empty, still-in-lobby room the host has opted into. */
function isEligibleForOpenListing(room: GameRoom): boolean {
  return room.mode === "private" && room.isOpen && room.gameState === "waiting" && room.players.length > 0;
}

/**
 * Re-derives whether `room` should currently be on the open-rooms list and
 * publishes an update/removal if that changed anything worth telling
 * subscribers about. Called after every mutation that could affect
 * eligibility or the player count shown on the card (join, leave, kick,
 * open/close toggle, game start, lobby reset).
 */
function refreshOpenListing(room: GameRoom): void {
  if (isEligibleForOpenListing(room)) {
    openRoomIds.add(room.roomId);
    publishOpenRooms({ type: "open_room_updated", payload: { room: toPublicOpenRoom(room) } });
  } else if (openRoomIds.delete(room.roomId)) {
    publishOpenRooms({ type: "open_room_removed", payload: { roomId: room.roomId } });
  }
}

function subscribeOpenRooms(playerId: string): void {
  const record = sessionRegistry.getByPlayerId(playerId);
  if (!record?.ws) return;

  try {
    record.ws.subscribe(OPEN_ROOMS_TOPIC);
  } catch (error) {
    logger.warn("Failed to subscribe socket to open-rooms topic", { playerId, error: (error as Error).message });
    return;
  }

  const snapshot = [...rooms.values()].filter(isEligibleForOpenListing).map(toPublicOpenRoom);
  sessionRegistry.send(playerId, { type: "open_rooms_snapshot", payload: { rooms: snapshot } });
}

function unsubscribeOpenRooms(playerId: string): void {
  const record = sessionRegistry.getByPlayerId(playerId);
  if (!record?.ws) return;
  try {
    record.ws.unsubscribe(OPEN_ROOMS_TOPIC);
  } catch {
    // socket may already be gone - nothing to do
  }
}

function buildGameRoundView(room: GameRoom, playerId: string): GameRoundView {
  return {
    roomId: room.roomId,
    gameState: "playing",
    round: room.currentRound,
    maxRounds: room.maxRounds,
    players: room.players.map(toPublicPlayer),
    scores: { ...room.scores },
    mantriPlayerId: room.mantriPlayerId ?? "",
    yourCard: room.currentCards[playerId] ?? null,
  };
}

/**
 * Sends each connected player their own personalized round view (containing only
 * *their* card). This intentionally does NOT go through the room pub/sub topic,
 * because every player's payload differs - see docs/PROTOCOL.md for rationale.
 */
function broadcastGameRoundView(room: GameRoom, type: "game_started" | "game_updated"): void {
  for (const player of room.players) {
    sessionRegistry.send(player.id, { type, payload: buildGameRoundView(room, player.id) });
  }
}

function buildGameFinishedView(room: GameRoom): GameFinishedView {
  const results = logic.getResults(room);
  return {
    rankings: results.rankings.map((r) => ({ playerId: r.id, name: r.name, avatarId: r.avatarId, score: r.score })),
    winnerId: results.winnerId,
    totalRounds: results.totalRounds,
    gameDurationMs: results.gameDurationMs,
    averageScorePerRound: results.averageScorePerRound,
  };
}

// ---------------------------------------------------------------------------
// Round / game flow
// ---------------------------------------------------------------------------

function scheduleRoundGuessTimeout(room: GameRoom): void {
  if (room.timers.roundGuessTimeout) clearTimeout(room.timers.roundGuessTimeout);

  room.timers.roundGuessTimeout = setTimeout(() => {
    room.timers.roundGuessTimeout = null;
    if (room.gameState !== "playing" || room.roundResolved) return;

    const mantriId = room.mantriPlayerId;
    if (!mantriId) return;

    const candidates = room.players.filter((p) => p.id !== mantriId);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (!target) return;

    resolveRoundAndAdvance(room, target.id, true);
  }, env.ROUND_GUESS_TIMEOUT_MS);
}

function schedulePostGameReset(room: GameRoom): void {
  if (room.timers.postGameReset) clearTimeout(room.timers.postGameReset);

  room.timers.postGameReset = setTimeout(() => {
    room.timers.postGameReset = null;
    if (!rooms.has(room.roomId) || room.gameState !== "finished") return;

    logic.resetToLobby(room);
    publishToRoom(room.roomId, { type: "game_reset", payload: { room: toPublicRoom(room) } });
    refreshOpenListing(room);
  }, env.POST_GAME_AUTO_RESET_MS);
}

function onRoundStarted(room: GameRoom, type: "game_started" | "game_updated"): void {
  broadcastGameRoundView(room, type);
  scheduleRoundGuessTimeout(room);
}

function beginCountdownAndStart(room: GameRoom): void {
  publishToRoom(room.roomId, { type: "game_starting", payload: { countdownMs: env.ROUND_START_COUNTDOWN_MS } });

  room.timers.countdown = setTimeout(() => {
    room.timers.countdown = null;
    if (room.gameState !== "waiting" || room.players.length !== env.ROOM_SIZE) return;

    logic.startGame(room);
    // The game is live now - it's no longer a joinable "open" room. The
    // host has to explicitly re-open it (e.g. after a rematch) rather than
    // strangers silently being able to join a room mid-replay-vote.
    room.isOpen = false;
    room.openedAt = null;
    refreshOpenListing(room);
    onRoundStarted(room, "game_started");
  }, env.ROUND_START_COUNTDOWN_MS);
}

function resolveRoundAndAdvance(room: GameRoom, guessedPlayerId: string, auto: boolean): void {
  const result = logic.resolveGuess(room, guessedPlayerId, auto);
  const guessedPlayer = findPlayer(room, guessedPlayerId);
  const chorPlayer = findPlayer(room, result.chorPlayerId);

  publishToRoom(room.roomId, {
    type: "round_result",
    payload: {
      ...result,
      guessedPlayerName: guessedPlayer?.name ?? "Unknown",
      chorPlayerName: chorPlayer?.name ?? "Unknown",
    },
  });

  room.timers.roundAdvance = setTimeout(() => {
    room.timers.roundAdvance = null;
    if (!rooms.has(room.roomId)) return;

    const finished = logic.nextRound(room);
    if (finished) {
      publishToRoom(room.roomId, { type: "game_finished", payload: buildGameFinishedView(room) });
      schedulePostGameReset(room);
    } else {
      onRoundStarted(room, "game_updated");
    }
  }, env.ROUND_RESULT_DISPLAY_MS);
}

// ---------------------------------------------------------------------------
// Room creation / joining
// ---------------------------------------------------------------------------

export interface CreatePrivateRoomOptions {
  password?: string;
  maxRounds?: number;
}

function createPrivateRoom(
  playerId: string,
  name: string,
  avatarId: string,
  options: CreatePrivateRoomOptions
): GameRoom {
  if (rooms.size >= env.MAX_PRIVATE_ROOMS) {
    throw new AppError("SERVER_AT_CAPACITY", "Too many active rooms right now, please try again shortly");
  }

  let roomId = generateRoomCode(6);
  let attempts = 0;
  while (rooms.has(roomId) && attempts < 10) {
    roomId = generateRoomCode(6);
    attempts++;
  }
  if (rooms.has(roomId)) {
    throw new AppError("INTERNAL_ERROR", "Could not allocate a room code, please try again");
  }

  const password = options.password && options.password.length > 0 ? options.password : null;
  const room = logic.createRoomSkeleton(roomId, "private", password, clampMaxRounds(options.maxRounds));
  rooms.set(roomId, room);

  const player: Player = logic.createPlayer({ id: playerId, name, avatarId, isCreator: true });
  logic.addPlayer(room, player);

  sessionRegistry.setRoom(playerId, roomId);
  subscribePlayerToRoom(playerId, roomId);

  sessionRegistry.send(playerId, { type: "room_created", payload: { roomId, hasPassword: password !== null } });
  sessionRegistry.send(playerId, { type: "room_state", payload: { room: toPublicRoom(room) } });

  return room;
}

function joinPrivateRoom(
  playerId: string,
  name: string,
  avatarId: string,
  roomId: string,
  password: string | undefined
): GameRoom {
  const room = rooms.get(roomId);
  if (!room || room.mode !== "private") {
    throw new AppError("ROOM_NOT_FOUND", "Invalid room code or password");
  }
  if (findPlayer(room, playerId)) {
    throw new AppError("ALREADY_IN_ROOM", "You are already in this room");
  }
  if (room.password && room.password !== password) {
    // Deliberately identical to the "room not found" message above so a
    // brute-force attempt can't distinguish a bad code from a bad password.
    throw new AppError("INVALID_PASSWORD", "Invalid room code or password");
  }
  if (room.gameState !== "waiting") {
    throw new AppError("GAME_ALREADY_STARTED", "This room's game has already started");
  }
  if (room.players.length >= env.ROOM_SIZE) {
    throw new AppError("ROOM_FULL", "This room is full");
  }

  const nameTaken = room.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
  const finalName = nameTaken ? `${name}${Math.floor(10 + Math.random() * 89)}` : name;

  const player: Player = logic.createPlayer({ id: playerId, name: finalName, avatarId, isCreator: false });
  logic.addPlayer(room, player);

  sessionRegistry.setRoom(playerId, roomId);
  subscribePlayerToRoom(playerId, roomId);

  sessionRegistry.send(playerId, { type: "room_state", payload: { room: toPublicRoom(room) } });
  sessionRegistry.send(playerId, { type: "chat_history", payload: { messages: room.chat } });

  publishToRoom(roomId, { type: "player_joined", payload: { player: toPublicPlayer(player), room: toPublicRoom(room) } });
  refreshOpenListing(room);

  return room;
}

/**
 * The "instant join" flow used from the open-rooms browse list: no room
 * code typed, no password required (deliberately - it's a one-tap join off
 * a live listing the host explicitly opted into), but otherwise the same
 * mechanics as joinPrivateRoom. Every check below runs synchronously with
 * no `await` in between, so two players tapping "join" on the last open
 * slot at the same instant are still strictly serialized by the event
 * loop - the second one always observes the first's mutation and gets a
 * clean ROOM_FULL, never a corrupted 5-player room.
 */
function joinOpenRoom(playerId: string, name: string, avatarId: string, roomId: string): GameRoom {
  const room = rooms.get(roomId);
  if (!room || room.mode !== "private" || !room.isOpen) {
    throw new AppError("ROOM_NOT_FOUND", "This room is no longer open for instant join");
  }
  if (findPlayer(room, playerId)) {
    throw new AppError("ALREADY_IN_ROOM", "You are already in this room");
  }
  if (room.gameState !== "waiting") {
    throw new AppError("GAME_ALREADY_STARTED", "This room's game has already started");
  }
  if (room.players.length >= env.ROOM_SIZE) {
    throw new AppError("ROOM_FULL", "This room just filled up");
  }

  const nameTaken = room.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
  const finalName = nameTaken ? `${name}${Math.floor(10 + Math.random() * 89)}` : name;

  const player: Player = logic.createPlayer({ id: playerId, name: finalName, avatarId, isCreator: false });
  logic.addPlayer(room, player);

  sessionRegistry.setRoom(playerId, roomId);
  subscribePlayerToRoom(playerId, roomId);

  sessionRegistry.send(playerId, { type: "room_state", payload: { room: toPublicRoom(room) } });
  sessionRegistry.send(playerId, { type: "chat_history", payload: { messages: room.chat } });

  publishToRoom(roomId, { type: "player_joined", payload: { player: toPublicPlayer(player), room: toPublicRoom(room) } });
  refreshOpenListing(room);

  // They just landed in a room - no longer relevant for them to keep
  // getting open-rooms broadcasts until they browse again.
  unsubscribeOpenRooms(playerId);

  return room;
}

function createRandomMatch(entries: QueueEntry[]): GameRoom {
  const roomId = generateInternalRoomId();
  const room = logic.createRoomSkeleton(roomId, "random", null, env.DEFAULT_MAX_ROUNDS);
  rooms.set(roomId, room);

  entries.forEach((entry, index) => {
    const player: Player = logic.createPlayer({
      id: entry.playerId,
      name: entry.name,
      avatarId: entry.avatarId,
      isCreator: index === 0,
    });
    logic.addPlayer(room, player);
    sessionRegistry.setRoom(entry.playerId, roomId);
    subscribePlayerToRoom(entry.playerId, roomId);
  });

  for (const entry of entries) {
    sessionRegistry.send(entry.playerId, { type: "match_found", payload: { roomId } });
    sessionRegistry.send(entry.playerId, { type: "room_state", payload: { room: toPublicRoom(room) } });
  }

  beginCountdownAndStart(room);
  return room;
}

// ---------------------------------------------------------------------------
// Leaving / kicking / disconnect handling
// ---------------------------------------------------------------------------

type RemovalReason = "left" | "kicked" | "disconnected";

function requeueSurvivors(roomId: string, survivors: Player[], leavingName: string): void {
  publishToRoom(roomId, {
    type: "room_disbanded",
    payload: { reason: `${leavingName} left the match. You've been placed back into matchmaking.` },
  });

  for (const survivor of survivors) {
    unsubscribePlayerFromRoom(survivor.id, roomId);
    sessionRegistry.setRoom(survivor.id, null);

    const record = sessionRegistry.getByPlayerId(survivor.id);
    if (record && record.connected) {
      try {
        matchmakingQueue.join({
          playerId: survivor.id,
          sessionToken: record.sessionToken,
          name: survivor.name,
          avatarId: survivor.avatarId,
          joinedAt: Date.now(),
        });
      } catch (error) {
        logger.warn("Failed to auto-requeue survivor", { playerId: survivor.id, error: (error as Error).message });
      }
    }
  }
}

function removePlayer(roomId: string, playerId: string, reason: RemovalReason): void {
  const room = rooms.get(roomId);
  if (!room) return;

  const leavingPlayer = findPlayer(room, playerId);
  if (!leavingPlayer) return;

  const wasCreator = leavingPlayer.isCreator;
  const leavingName = leavingPlayer.name;

  // Voice teardown race fix: previously this only relied on the client
  // sending a separate voice_unpublish message before leaving, which never
  // arrives for a kick (the connection is severed by us), a disconnect
  // (the socket is already gone), or a fast client-side navigation away.
  // Remaining participants would be left believing this player was still
  // publishing. Explicitly unpublish here, while the player is still in
  // room.players, so voice_participant_left always goes out as part of the
  // same removal instead of depending on the client's cooperation.
  unpublishVoice(roomId, playerId);

  // Stop any in-flight timers referencing the round/replay state we're about to mutate.
  logic.clearRoomTimers(room);

  logic.removePlayerFromRoom(room, playerId);
  sessionRegistry.setRoom(playerId, null);
  if (reason !== "disconnected") {
    unsubscribePlayerFromRoom(playerId, roomId);
  }

  if (room.players.length === 0) {
    refreshOpenListing(room);
    rooms.delete(roomId);
    return;
  }

  let creatorChanged = false;
  let newCreator: Player | undefined;
  if (wasCreator) {
    newCreator = room.players[0];
    if (newCreator) {
      newCreator.isCreator = true;
      room.creatorId = newCreator.id;
      creatorChanged = true;
    }
  }

  const belowFull = room.players.length < env.ROOM_SIZE;

  if (room.mode === "random" && belowFull) {
    const survivors = [...room.players];
    rooms.delete(roomId);
    requeueSurvivors(roomId, survivors, leavingName);
    return;
  }

  if (belowFull && room.gameState === "playing") {
    logic.resetToLobby(room);
    publishToRoom(roomId, { type: "game_reset", payload: { room: toPublicRoom(room) } });
  }

  publishToRoom(roomId, {
    type: "player_left",
    payload: { playerId, name: leavingName, room: toPublicRoom(room) },
  });
  refreshOpenListing(room);

  if (creatorChanged && newCreator) {
    publishToRoom(roomId, {
      type: "creator_changed",
      payload: { newCreatorId: newCreator.id, newCreatorName: newCreator.name },
    });
  }

  if (room.gameState === "finished") {
    schedulePostGameReset(room);
  }
}

function markPlayerDisconnected(roomId: string, playerId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const player = findPlayer(room, playerId);
  if (!player) return;

  player.connected = false;
  logic.touchActivity(room);
  publishToRoom(roomId, { type: "player_disconnected", payload: { playerId, name: player.name } });
}

function markPlayerReconnected(roomId: string, playerId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const player = findPlayer(room, playerId);
  if (!player) return;

  player.connected = true;
  logic.touchActivity(room);
  subscribePlayerToRoom(playerId, roomId);

  sessionRegistry.send(playerId, { type: "room_state", payload: { room: toPublicRoom(room) } });
  sessionRegistry.send(playerId, { type: "chat_history", payload: { messages: room.chat } });

  if (room.gameState === "playing") {
    sessionRegistry.send(playerId, { type: "game_updated", payload: buildGameRoundView(room, playerId) });
  }
  if (room.replay.active) {
    sessionRegistry.send(playerId, {
      type: "replay_status",
      payload: toPublicReplayStatus(room.replay, room.players.length),
    });
  }

  publishToRoom(roomId, { type: "player_reconnected", payload: { playerId, name: player.name } });
}

// ---------------------------------------------------------------------------
// Host controls (private rooms only)
// ---------------------------------------------------------------------------

function kickPlayer(roomId: string, requesterId: string, targetPlayerId: string): void {
  const room = getRoomOrThrow(roomId);

  if (room.mode !== "private") {
    throw new AppError("NOT_ROOM_CREATOR", "Only private rooms support kicking players");
  }
  if (room.creatorId !== requesterId) {
    throw new AppError("NOT_ROOM_CREATOR", "Only the room host can kick players");
  }
  if (targetPlayerId === requesterId) {
    throw new AppError("INVALID_TARGET", "You cannot kick yourself");
  }
  if (!findPlayer(room, targetPlayerId)) {
    throw new AppError("INVALID_TARGET", "That player is not in this room");
  }

  sessionRegistry.send(targetPlayerId, { type: "kicked", payload: { reason: "Removed by the room host" } });
  removePlayer(roomId, targetPlayerId, "kicked");
}

export interface UpdateRoomSettingsInput {
  maxRounds?: number;
  password?: string | null;
}

function updateSettings(roomId: string, requesterId: string, settings: UpdateRoomSettingsInput): void {
  const room = getRoomOrThrow(roomId);

  if (room.mode !== "private") {
    throw new AppError("NOT_ROOM_CREATOR", "Only private rooms have configurable settings");
  }
  if (room.creatorId !== requesterId) {
    throw new AppError("NOT_ROOM_CREATOR", "Only the room host can change settings");
  }
  if (room.gameState !== "waiting") {
    throw new AppError("GAME_ALREADY_STARTED", "Settings can only be changed before the game starts");
  }

  if (settings.maxRounds !== undefined) {
    room.maxRounds = clampMaxRounds(settings.maxRounds);
  }
  if (settings.password !== undefined) {
    room.password = settings.password && settings.password.length > 0 ? settings.password : null;
  }

  logic.touchActivity(room);
  publishToRoom(roomId, { type: "room_settings_updated", payload: { room: toPublicRoom(room) } });
}

/**
 * Toggles whether this private room is broadcast on the server-wide
 * open-rooms list. Host-only, lobby-only (matches updateSettings' guard) -
 * a room that's already playing or full has nothing useful to advertise.
 */
function setRoomOpen(roomId: string, requesterId: string, open: boolean): void {
  const room = getRoomOrThrow(roomId);

  if (room.mode !== "private") {
    throw new AppError("NOT_ROOM_CREATOR", "Only private rooms can be made open for instant join");
  }
  if (room.creatorId !== requesterId) {
    throw new AppError("NOT_ROOM_CREATOR", "Only the room host can change this");
  }
  if (room.gameState !== "waiting") {
    throw new AppError("GAME_ALREADY_STARTED", "Can't change this once the game has started");
  }
  if (open && room.players.length >= env.ROOM_SIZE) {
    throw new AppError("ROOM_FULL", "This room is already full");
  }

  room.isOpen = open;
  room.openedAt = open ? Date.now() : null;
  logic.touchActivity(room);

  publishToRoom(roomId, { type: "room_open_changed", payload: { room: toPublicRoom(room) } });
  refreshOpenListing(room);
}

function startGameManually(roomId: string, requesterId: string): void {
  const room = getRoomOrThrow(roomId);

  if (room.mode !== "private") {
    throw new AppError("GAME_ALREADY_STARTED", "Random matches start automatically once matchmaking fills the room");
  }
  if (room.creatorId !== requesterId) {
    throw new AppError("NOT_ROOM_CREATOR", "Only the room host can start the game");
  }
  if (room.gameState !== "waiting") {
    throw new AppError("GAME_ALREADY_STARTED", "This game is already in progress or has finished");
  }
  if (room.players.length !== env.ROOM_SIZE) {
    throw new AppError("NOT_ENOUGH_PLAYERS", `Need ${env.ROOM_SIZE - room.players.length} more player(s) to start`);
  }

  beginCountdownAndStart(room);
}

// ---------------------------------------------------------------------------
// Gameplay
// ---------------------------------------------------------------------------

function makeGuess(roomId: string, playerId: string, guessedPlayerId: string): void {
  const room = getRoomOrThrow(roomId);

  if (room.gameState !== "playing" || room.roundResolved) {
    throw new AppError("GAME_NOT_IN_PROGRESS", "There is no active round to guess in");
  }
  if (playerId !== room.mantriPlayerId) {
    throw new AppError("NOT_YOUR_TURN", "Only the Mantri can make a guess this round");
  }
  if (guessedPlayerId === playerId) {
    throw new AppError("INVALID_TARGET", "You cannot guess yourself");
  }
  if (!findPlayer(room, guessedPlayerId)) {
    throw new AppError("INVALID_TARGET", "That player is not in this room");
  }

  if (room.timers.roundGuessTimeout) {
    clearTimeout(room.timers.roundGuessTimeout);
    room.timers.roundGuessTimeout = null;
  }

  resolveRoundAndAdvance(room, guessedPlayerId, false);
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function requestReplay(roomId: string, requesterId: string): void {
  const room = getRoomOrThrow(roomId);

  if (room.gameState !== "finished") {
    throw new AppError("GAME_NOT_FINISHED", "You can only request a rematch after the game finishes");
  }
  if (room.creatorId !== requesterId) {
    throw new AppError("NOT_ROOM_CREATOR", "Only the room host can start a rematch vote");
  }
  if (room.replay.active) {
    throw new AppError("REPLAY_ALREADY_ACTIVE", "A rematch vote is already in progress");
  }

  if (room.timers.postGameReset) {
    clearTimeout(room.timers.postGameReset);
    room.timers.postGameReset = null;
  }

  const requestId = generateEventId();
  logic.requestReplay(room, requestId, requesterId, env.REPLAY_TTL_MS);

  publishToRoom(roomId, {
    type: "replay_requested",
    payload: toPublicReplayStatus(room.replay, room.players.length),
  });

  room.timers.replayExpiry = setTimeout(() => {
    room.timers.replayExpiry = null;
    if (!room.replay.active || room.replay.requestId !== requestId) return;

    logic.clearReplay(room);
    publishToRoom(roomId, { type: "replay_expired", payload: {} });
    schedulePostGameReset(room);
  }, env.REPLAY_TTL_MS);
}

function respondReplay(roomId: string, playerId: string, accepted: boolean, requestId: string | undefined): void {
  const room = getRoomOrThrow(roomId);

  logic.respondReplay(room, playerId, accepted, requestId ?? null);

  const status = toPublicReplayStatus(room.replay, room.players.length);
  publishToRoom(roomId, { type: "replay_status", payload: status });

  if (logic.replayAnyDeclined(room)) {
    const decliner = findPlayer(room, playerId);
    if (room.timers.replayExpiry) {
      clearTimeout(room.timers.replayExpiry);
      room.timers.replayExpiry = null;
    }
    logic.clearReplay(room);
    publishToRoom(roomId, { type: "replay_cancelled", payload: { by: decliner?.name ?? "A player" } });
    schedulePostGameReset(room);
    return;
  }

  if (status.pending === 0 && status.accepted === status.total) {
    if (room.timers.replayExpiry) {
      clearTimeout(room.timers.replayExpiry);
      room.timers.replayExpiry = null;
    }
    logic.clearReplay(room);
    logic.resetToLobby(room);
    publishToRoom(roomId, { type: "game_reset", payload: { room: toPublicRoom(room) } });
    refreshOpenListing(room);
    beginCountdownAndStart(room);
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function sendChat(roomId: string, playerId: string, text: string): void {
  const room = getRoomOrThrow(roomId);
  const sender = findPlayer(room, playerId);
  if (!sender) {
    throw new AppError("NOT_IN_ROOM", "You are not in this room");
  }

  const sanitized = sanitizeChatText(text, env.CHAT_MESSAGE_MAX_LENGTH);
  if (!sanitized) return;

  const message: ChatMessage = {
    id: generateEventId(),
    roomId,
    ts: Date.now(),
    senderId: sender.id,
    senderName: sender.name,
    senderAvatarId: sender.avatarId,
    text: sanitized,
  };

  logic.appendChatMessage(room, message);
  publishToRoom(roomId, { type: "chat_message", payload: { message } });
}

/**
 * Reactions are deliberately ephemeral - unlike chat, nothing is persisted
 * on the room (no history to replay on reconnect). They're a fire-and-forget
 * broadcast; the emoji itself is already validated against the curated
 * allow-list at the zod schema layer (see websocket/inbound.ts REACTION_EMOJIS),
 * so no re-validation is needed here.
 */
function sendReaction(roomId: string, playerId: string, emoji: string): void {
  const room = getRoomOrThrow(roomId);
  const sender = findPlayer(room, playerId);
  if (!sender) {
    throw new AppError("NOT_IN_ROOM", "You are not in this room");
  }

  logic.touchActivity(room);
  publishToRoom(roomId, {
    type: "reaction",
    payload: { id: generateEventId(), playerId: sender.id, playerName: sender.name, emoji, ts: Date.now() },
  });
}

// ---------------------------------------------------------------------------
// Voice chat (Cloudflare Calls signaling)
// ---------------------------------------------------------------------------

/**
 * Records that this player has published a mic track and broadcasts it so
 * everyone else in the room can pull it. Stored on the player (not a
 * separate structure) so it also rides along on room_state/player_joined
 * for anyone who joins voice later and needs to discover who's already on.
 */
function publishVoice(roomId: string, playerId: string, sessionId: string, trackName: string): void {
  const room = getRoomOrThrow(roomId);
  const player = findPlayer(room, playerId);
  if (!player) {
    throw new AppError("NOT_IN_ROOM", "You are not in this room");
  }

  player.voiceSessionId = sessionId;
  player.voiceTrackName = trackName;
  player.voiceMuted = true; // always starts muted - the client unmutes explicitly afterwards
  logic.touchActivity(room);

  publishToRoom(roomId, {
    type: "voice_participant_published",
    payload: { playerId, sessionId, trackName },
  });
}

/** Marks a player as having left voice entirely (distinct from muting - clears the session/track). */
function unpublishVoice(roomId: string, playerId: string): void {
  const room = getRoomOrThrow(roomId);
  const player = findPlayer(room, playerId);
  if (!player) {
    throw new AppError("NOT_IN_ROOM", "You are not in this room");
  }
  if (player.voiceSessionId === null) return; // already not on voice - no-op

  player.voiceSessionId = null;
  player.voiceTrackName = null;
  player.voiceMuted = true;
  logic.touchActivity(room);

  publishToRoom(roomId, { type: "voice_participant_left", payload: { playerId } });
}

function setVoiceMuted(roomId: string, playerId: string, muted: boolean): void {
  const room = getRoomOrThrow(roomId);
  const player = findPlayer(room, playerId);
  if (!player) {
    throw new AppError("NOT_IN_ROOM", "You are not in this room");
  }
  if (player.voiceSessionId === null) {
    throw new AppError("VOICE_NOT_JOINED", "You haven't joined voice yet");
  }

  player.voiceMuted = muted;
  logic.touchActivity(room);
  publishToRoom(roomId, { type: "voice_participant_muted", payload: { playerId, muted } });
}

// ---------------------------------------------------------------------------
// Misc / lifecycle
// ---------------------------------------------------------------------------

function leaveRoom(roomId: string, playerId: string): void {
  if (!rooms.has(roomId)) throw new AppError("NOT_IN_ROOM", "You are not in this room");
  removePlayer(roomId, playerId, "left");
}

function getPublicRoom(roomId: string) {
  const room = rooms.get(roomId);
  return room ? toPublicRoom(room) : null;
}

/** Lightweight existence/metadata check used by the pre-join REST endpoint - never reveals the password. */
function getRoomPreview(roomId: string) {
  const room = rooms.get(roomId);
  if (!room || room.mode !== "private") return null;
  return {
    roomId: room.roomId,
    hasPassword: room.password !== null,
    playerCount: room.players.length,
    maxPlayers: env.ROOM_SIZE,
    gameState: room.gameState,
  };
}

function sweepStaleRooms(): void {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.players.length === 0 && now - room.lastActivityAt > env.STALE_ROOM_MAX_AGE_MS) {
      logic.clearRoomTimers(room);
      rooms.delete(roomId);
    }
  }
}

function getStats() {
  let waiting = 0;
  let playing = 0;
  let finished = 0;
  let totalPlayers = 0;

  for (const room of rooms.values()) {
    totalPlayers += room.players.length;
    if (room.gameState === "waiting") waiting++;
    else if (room.gameState === "playing") playing++;
    else finished++;
  }

  return {
    totalRooms: rooms.size,
    totalPlayers,
    waiting,
    playing,
    finished,
    queueSize: matchmakingQueue.size(),
  };
}

const sweepInterval = setInterval(sweepStaleRooms, env.EMPTY_ROOM_SWEEP_MS);
sweepInterval.unref?.();

function destroy(): void {
  clearInterval(sweepInterval);
  for (const room of rooms.values()) {
    logic.clearRoomTimers(room);
  }
  rooms.clear();
  openRoomIds.clear();
}

export const roomManager = {
  createPrivateRoom,
  joinPrivateRoom,
  createRandomMatch,
  leaveRoom,
  removePlayer,
  markPlayerDisconnected,
  markPlayerReconnected,
  kickPlayer,
  updateSettings,
  setRoomOpen,
  joinOpenRoom,
  subscribeOpenRooms,
  unsubscribeOpenRooms,
  startGameManually,
  makeGuess,
  requestReplay,
  respondReplay,
  sendChat,
  sendReaction,
  publishVoice,
  unpublishVoice,
  setVoiceMuted,
  getPublicRoom,
  getRoomPreview,
  getStats,
  destroy,
};