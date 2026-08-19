export type GameRole = "Raja" | "Mantri" | "Chor" | "Sipahi";
export type GameState = "waiting" | "playing" | "finished";
export type RoomMode = "random" | "private";

export interface Player {
  id: string;
  name: string;
  avatarId: string;
  isCreator: boolean;
  connected: boolean;
  joinedAt: number;

  // --- Voice chat (Cloudflare Calls) --------------------------------------
  // Set once this player has published a mic track; null means they haven't
  // joined voice at all. Carried on the player (rather than a separate
  // parallel "voice room" concept) so it rides along on the room broadcasts
  // we already send (room_state, player_joined, ...) - a newly-joining
  // player automatically learns who's already on voice and can pull their
  // tracks without a separate handshake.
  voiceSessionId: string | null;
  voiceTrackName: string | null;
  /** Meaningless while voiceSessionId is null. Defaults to true (muted) so nobody is heard until they explicitly unmute. */
  voiceMuted: boolean;
}

export interface ReplayState {
  active: boolean;
  requestId: string | null;
  requestedBy: string | null;
  requestedAt: number | null;
  expiresAt: number | null;
  responses: Record<string, boolean | null>;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  ts: number;
  senderId: string;
  senderName: string;
  /** Snapshotted at send time, same reasoning as senderName - so chat
   * history still shows the right avatar even if the sender later leaves. */
  senderAvatarId: string;
  text: string;
}

/**
 * Internal timers attached to a room. Kept together so we can reliably
 * clear all of them on disband/reset instead of hunting through separate maps.
 */
export interface RoomTimers {
  roundGuessTimeout: ReturnType<typeof setTimeout> | null;
  roundAdvance: ReturnType<typeof setTimeout> | null;
  replayExpiry: ReturnType<typeof setTimeout> | null;
  postGameReset: ReturnType<typeof setTimeout> | null;
  countdown: ReturnType<typeof setTimeout> | null;
}

export interface GameRoom {
  roomId: string;
  mode: RoomMode;
  /** Private rooms only. Never sent to clients - only `hasPassword` is. */
  password: string | null;
  creatorId: string | null;
  players: Player[];

  gameState: GameState;
  currentRound: number;
  maxRounds: number;

  /** playerId -> role for the current round. Cleared between rounds. */
  currentCards: Partial<Record<string, GameRole>>;
  /** Whether the current round's guess has already been resolved (manually or by timeout). */
  roundResolved: boolean;

  scores: Record<string, number>;
  mantriPlayerId: string | null;
  rajaPlayerId: string | null;
  chorPlayerId: string | null;
  sipahiPlayerId: string | null;

  replay: ReplayState;
  chat: ChatMessage[];

  createdAt: number;
  lastActivityAt: number;
  gameStartTime: number | null;
  gameEndTime: number | null;

  timers: RoomTimers;
}

export interface QueueEntry {
  playerId: string;
  sessionToken: string;
  name: string;
  avatarId: string;
  joinedAt: number;
}

/** Round-result payload shape shared between manual and auto-resolved guesses. */
export interface RoundResult {
  round: number;
  isCorrect: boolean;
  auto: boolean;
  guessedPlayerId: string;
  chorPlayerId: string;
  roundScores: Record<string, number>;
  totalScores: Record<string, number>;
  cards: Record<string, GameRole>;
}

export interface GameResults {
  rankings: Array<Player & { score: number }>;
  winnerId: string | null;
  totalRounds: number;
  gameDurationMs: number | null;
  averageScorePerRound: number;
}