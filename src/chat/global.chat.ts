import { env } from "../config/env";
import { generateEventId } from "../utils/ids";
import { sanitizeChatText } from "../utils/sanitize";
import { publishGlobalChat } from "../websocket/publish";

/**
 * Server-wide chat, separate from any room's chat. Every connected socket is
 * auto-subscribed to it in websocket/connection.ts (no explicit subscribe message,
 * unlike the open-rooms browse list) since it's meant to be visible
 * everywhere. Deliberately in-memory only, same as room chat - a ring
 * buffer capped at GLOBAL_CHAT_HISTORY_LIMIT, reset on server restart.
 */
export interface GlobalChatMessage {
  id: string;
  ts: number;
  senderId: string;
  senderName: string;
  senderAvatarId: string;
  text: string;
}

const history: GlobalChatMessage[] = [];
let timer: NodeJS.Timeout | null = null;

function getHistory(): GlobalChatMessage[] {
  return history;
}

/** Returns the stored message, or null if the text sanitized to nothing (e.g. was only stripped characters). */
function send(senderId: string, senderName: string, senderAvatarId: string, text: string): GlobalChatMessage | null {
  const sanitized = sanitizeChatText(text, env.GLOBAL_CHAT_MESSAGE_MAX_LENGTH);
  if (!sanitized) return null;

  const message: GlobalChatMessage = {
    id: generateEventId(),
    ts: Date.now(),
    senderId,
    senderName,
    senderAvatarId,
    text: sanitized,
  };

  history.push(message);
  if (history.length > env.GLOBAL_CHAT_HISTORY_LIMIT) {
    history.splice(0, history.length - env.GLOBAL_CHAT_HISTORY_LIMIT);
  }

  publishGlobalChat({ type: "global_chat_message", payload: { message } });
  return message;
}

/** Test-only reset hook - mirrors the pattern of other singleton modules' destroy(). */
function destroy(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  history.length = 0;
}

/**
 * Deletes global chat history older than 2 hours.
 * Runs every 5 minutes.
 */
export const clearHistory = () => {
  // 1. Prevent memory leaks from multiple intervals
  if (timer) {
    clearInterval(timer);
  }

  timer = setInterval(() => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const firstValidIndex = history.findIndex(m => m.ts >= twoHoursAgo);

    if (firstValidIndex > 0) {
      history.splice(0, firstValidIndex);
    } else if (firstValidIndex === -1 && history.length > 0) {
      history.length = 0;
    }
  }, 5 * 60 * 1000); // Runs every 5 minutes
  timer.unref?.();
};

export const globalChat = {
  getHistory,
  send,
  destroy,
};
