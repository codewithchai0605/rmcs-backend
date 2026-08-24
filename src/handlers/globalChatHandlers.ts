import { globalChat } from "../chat/globalChat.js";
import type { PayloadOf } from "../ws/inbound.js";
import { requireSession } from "./helpers.js";

export function handleGlobalChatSend(playerId: string, payload: PayloadOf<"global_chat_send">): void {
  const record = requireSession(playerId);
  globalChat.send(playerId, record.name, record.avatarId, payload.text);
}
