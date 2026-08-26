import { toAppError } from "../utils/errors";
import { logger } from "../utils/logger";
import { RATE_LIMITS, rateLimiter } from "../middleware/rate.limiter";
import { parseClientMessage, type ClientMessageType } from "../websocket/inbound";
import { sessionRegistry } from "../websocket/session.registry";

import { handleSetName } from "./profile.handlers";
import { handleQueueJoin, handleQueueLeave } from "./queue.handlers";
import {
  handlePrivateRoomCreate,
  handlePrivateRoomJoin,
  handleRoomKick,
  handleRoomStart,
  handleRoomUpdateSettings,
} from "./private.room.handlers";
import { handleMakeGuess, handleReplayRequest, handleReplayResponse, handleRoomLeave } from "./room.handlers";
import { handleChatSend, handleReactionSend } from "./chat.handlers";
import { handleVoiceMute, handleVoicePublished, handleVoiceUnpublish } from "./voice.handlers";
import {
  handleOpenRoomJoin,
  handleOpenRoomsSubscribe,
  handleOpenRoomsUnsubscribe,
  handleRoomSetOpen,
} from "./open.room.handlers";
import { handleGlobalChatSend } from "./global.chat.handlers";

// The dispatch table intentionally uses `any` for the payload parameter: each
// concrete handler is fully typed against its own PayloadOf<T>, and the union
// is already runtime-validated by zod in parseClientMessage before we get here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (playerId: string, payload: any) => void;

const dispatchTable: Record<ClientMessageType, AnyHandler> = {
  set_name: handleSetName,
  queue_join: handleQueueJoin,
  queue_leave: handleQueueLeave,
  private_room_create: handlePrivateRoomCreate,
  private_room_join: handlePrivateRoomJoin,
  room_leave: handleRoomLeave,
  room_start: handleRoomStart,
  room_kick: handleRoomKick,
  room_update_settings: handleRoomUpdateSettings,
  room_set_open: handleRoomSetOpen,
  open_rooms_subscribe: handleOpenRoomsSubscribe,
  open_rooms_unsubscribe: handleOpenRoomsUnsubscribe,
  open_room_join: handleOpenRoomJoin,
  chat_send: handleChatSend,
  global_chat_send: handleGlobalChatSend,
  reaction_send: handleReactionSend,
  voice_published: handleVoicePublished,
  voice_unpublish: handleVoiceUnpublish,
  voice_mute: handleVoiceMute,
  make_guess: handleMakeGuess,
  replay_request: handleReplayRequest,
  replay_response: handleReplayResponse,
};

export async function handleRawMessage(playerId: string, raw: string): Promise<void> {
  // Blanket flood guard across all message types - deliberately the fast,
  // always-synchronous, purely local check (see rate.limiter.ts): it exists
  // to protect *this* process from *this* connection instantly, with zero
  // network dependency, so a flood is throttled on the first offending
  // message rather than after a Redis round trip.
  if (!rateLimiter.allow(playerId, "ws_message", RATE_LIMITS.ws_message.limit, RATE_LIMITS.ws_message.windowMs)) {
    sessionRegistry.send(playerId, {
      type: "error",
      payload: { code: "RATE_LIMITED", message: "You are sending messages too quickly" },
    });
    return;
  }

  const parsed = parseClientMessage(raw);
  if (!parsed.ok || !parsed.message) {
    sessionRegistry.send(playerId, {
      type: "error",
      payload: { code: "INVALID_MESSAGE", message: parsed.error ?? "Invalid message" },
    });
    return;
  }

  const { type, payload } = parsed.message;

  // Per-action limits are the ones worth sharing across instances (fair
  // per-player limits on real game actions), so they go through the
  // Redis-backed check - which transparently falls back to the same local
  // logic if Redis isn't configured or is unreachable.
  const limitConfig = RATE_LIMITS[type];
  if (limitConfig && !(await rateLimiter.allowAsync(playerId, type, limitConfig.limit, limitConfig.windowMs))) {
    sessionRegistry.send(playerId, {
      type: "error",
      payload: { code: "RATE_LIMITED", message: `You're doing "${type}" too often - slow down a bit` },
    });
    return;
  }

  sessionRegistry.touch(playerId);

  const handler = dispatchTable[type];
  try {
    handler(playerId, payload);
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code === "INTERNAL_ERROR") {
      logger.error("Unhandled error in message handler", { type, playerId, error: appError.message });
    }
    sessionRegistry.send(playerId, { type: "error", payload: { code: appError.code, message: appError.message } });
  }
}