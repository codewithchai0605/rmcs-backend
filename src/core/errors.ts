/**
 * Error codes sent to the client so the frontend can branch on them
 * instead of parsing human-readable text.
 */
export type ErrorCode =
  | "INVALID_MESSAGE"
  | "RATE_LIMITED"
  | "NOT_AUTHENTICATED"
  | "ALREADY_IN_ROOM"
  | "ALREADY_IN_QUEUE"
  | "NOT_IN_ROOM"
  | "NOT_IN_QUEUE"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ROOM_LOCKED"
  | "INVALID_ROOM_CODE"
  | "INVALID_PASSWORD"
  | "NOT_ROOM_CREATOR"
  | "GAME_ALREADY_STARTED"
  | "GAME_NOT_IN_PROGRESS"
  | "GAME_NOT_FINISHED"
  | "NOT_ENOUGH_PLAYERS"
  | "NOT_YOUR_TURN"
  | "REPLAY_NOT_ACTIVE"
  | "REPLAY_ALREADY_ACTIVE"
  | "REPLAY_ALREADY_RESPONDED"
  | "INVALID_TARGET"
  | "SERVER_AT_CAPACITY"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "Unexpected error";
  return new AppError("INTERNAL_ERROR", message);
}
