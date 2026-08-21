import { toAppError } from "../core/errors";
import { logger } from "../core/logger";
import { RATE_LIMITS, rateLimiter } from "../middleware/rateLimiter";
import { parseClientMessage, type ClientMessageType } from "../ws/inbound";
import { sessionRegistry } from "../ws/sessionRegistry";

import { handleSetName } from "./profileHandlers";
import { handleQueueJoin, handleQueueLeave } from "./queueHandlers";
import {
  handlePrivateRoomCreate,
  handlePrivateRoomJoin,
  handleRoomKick,
  handleRoomStart,
  handleRoomUpdateSettings,
} from "./privateRoomHandlers";
import { handleMakeGuess, handleReplayRequest, handleReplayResponse, handleRoomLeave } from "./roomHandlers";
import { handleChatSend, handleReactionSend } from "./chatHandlers";
import { handleVoiceMute, handleVoicePublished, handleVoiceUnpublish } from "./voiceHandlers";

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
  chat_send: handleChatSend,
  reaction_send: handleReactionSend,
  voice_published: handleVoicePublished,
  voice_unpublish: handleVoiceUnpublish,
  voice_mute: handleVoiceMute,
  make_guess: handleMakeGuess,
  replay_request: handleReplayRequest,
  replay_response: handleReplayResponse,
};

export function handleRawMessage(playerId: string, raw: string): void {
  // Blanket flood guard across all message types, checked before we even parse.
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

  const limitConfig = RATE_LIMITS[type];
  if (limitConfig && !rateLimiter.allow(playerId, type, limitConfig.limit, limitConfig.windowMs)) {
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