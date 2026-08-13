import { randomBytes, randomInt, randomUUID } from "node:crypto";

/** Stable identifier for a player, kept across reconnects within the same session. */
export function generatePlayerId(): string {
  return randomUUID();
}

/** Long, unguessable bearer token used by the client to resume a session after a reconnect. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Identifier for a single chat message / round / replay request. */
export function generateEventId(): string {
  return randomUUID();
}

/** Internal room id for matchmade rooms - never typed by a human, so a UUID is fine. */
export function generateInternalRoomId(): string {
  return randomUUID();
}

// Charset for shareable room codes: uppercase alphanumeric with visually
// ambiguous characters removed (0/O, 1/I/L) so codes are easy to read aloud
// and to type on a phone.
const ROOM_CODE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateRoomCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARSET[randomInt(0, ROOM_CODE_CHARSET.length)];
  }
  return code;
}

const GUEST_ADJECTIVES = [
  "Swift",
  "Clever",
  "Brave",
  "Sneaky",
  "Lucky",
  "Mighty",
  "Silent",
  "Jolly",
  "Fierce",
  "Nimble",
];

const GUEST_NOUNS = [
  "Falcon",
  "Tiger",
  "Panda",
  "Otter",
  "Wolf",
  "Eagle",
  "Fox",
  "Lion",
  "Hawk",
  "Bear",
];

export function generateGuestName(): string {
  const adjective = GUEST_ADJECTIVES[randomInt(0, GUEST_ADJECTIVES.length)];
  const noun = GUEST_NOUNS[randomInt(0, GUEST_NOUNS.length)];
  const suffix = randomInt(10, 99);
  return `${adjective}${noun}${suffix}`;
}
