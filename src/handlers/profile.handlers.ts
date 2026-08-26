import { sessionRegistry } from "../websocket/session.registry";
import { normalizeAvatarId, sanitizeName } from "../utils/sanitize";
import type { PayloadOf } from "../websocket/inbound";

export function handleSetName(playerId: string, payload: PayloadOf<"set_name">): void {
  const name = sanitizeName(payload.name) || "Guest";
  const avatarId = normalizeAvatarId(payload.avatarId);

  sessionRegistry.updateProfile(playerId, name, avatarId);
  sessionRegistry.send(playerId, { type: "name_updated", payload: { name, avatarId } });
}
