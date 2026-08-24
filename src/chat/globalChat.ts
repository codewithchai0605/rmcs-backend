import { env } from "../config/env.js";
import { generateEventId } from "../core/ids.js";
import { sanitizeChatText } from "../core/sanitize.js";
import { publishGlobalChat } from "../ws/publish.js";

/**
 * Server-wide chat, separate from any room's chat. Every connected socket is
 * auto-subscribed to it in ws/connection.ts (no explicit subscribe message,
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
  history.length = 0;
}

export const globalChat = {
  getHistory,
  send,
  destroy,
};
