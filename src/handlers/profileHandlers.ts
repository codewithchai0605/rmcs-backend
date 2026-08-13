import { sessionRegistry } from "../ws/sessionRegistry.js";
import { normalizeAvatarId, sanitizeName } from "../core/sanitize.js";
import type { PayloadOf } from "../ws/inbound.js";

export function handleSetName(playerId: string, payload: PayloadOf<"set_name">): void {
  const name = sanitizeName(payload.name) || "Guest";
  const avatarId = normalizeAvatarId(payload.avatarId);

  sessionRegistry.updateProfile(playerId, name, avatarId);
  sessionRegistry.send(playerId, { type: "name_updated", payload: { name, avatarId } });
}
