const HTML_TAG_RE = /<[^>]*>/g;
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

const ALLOWED_AVATARS = new Set([
  "avatar-1",
  "avatar-2",
  "avatar-3",
  "avatar-4",
  "avatar-5",
  "avatar-6",
  "avatar-7",
  "avatar-8",
]);

/** Strips tags/control chars and restricts to a conservative charset. Used for display names. */
export function sanitizeName(input: unknown, maxLength = 20): string {
  if (typeof input !== "string") return "";

  let sanitized = input.replace(HTML_TAG_RE, "");
  sanitized = sanitized.replace(CONTROL_CHARS_RE, "");
  sanitized = sanitized.replace(/[^a-zA-Z0-9 \-_]/g, "");
  return sanitized.trim().slice(0, maxLength);
}

/** Slightly more permissive than sanitizeName - allows common punctuation used in chat. */
export function sanitizeChatText(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return "";

  let sanitized = input.replace(HTML_TAG_RE, "");
  sanitized = sanitized.replace(CONTROL_CHARS_RE, "");
  sanitized = sanitized.replace(/[^\w\s\-.,!?@#$%&*()[\]{}'"/:;+=%]/gu, "");
  return sanitized.trim().slice(0, maxLength);
}

export function normalizeAvatarId(input: unknown): string {
  if (typeof input !== "string") return "avatar-1";
  const normalized = input.trim().toLowerCase().replace(/_/g, "-");
  return ALLOWED_AVATARS.has(normalized) ? normalized : "avatar-1";
}

export function normalizeRoomCode(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().toUpperCase();
}
