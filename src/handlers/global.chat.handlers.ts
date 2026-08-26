import { globalChat } from "../chat/global.chat";
import type { PayloadOf } from "../websocket/inbound";
import { requireSession } from "./helpers";

export function handleGlobalChatSend(playerId: string, payload: PayloadOf<"global_chat_send">): void {
  const record = requireSession(playerId);
  globalChat.send(playerId, record.name, record.avatarId, payload.text);
}
