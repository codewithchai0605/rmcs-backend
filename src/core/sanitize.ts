const HTML_TAG_RE = /<[^>]*>/g;
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

// Bidi embedding/override/isolate controls and the BOM. These render invisibly
// but can reorder how surrounding characters are *displayed* - e.g. making a
// message look like it says something different from its actual character
// sequence. Worth stripping now that sanitizeChatText allows arbitrary
// Unicode; ordinary marks like ZWJ/ZWNJ (used in emoji sequences and several
// Indic scripts) are deliberately left alone.
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Truncates by Unicode code point rather than UTF-16 code unit, so a
 * surrogate pair (most emoji, many non-BMP scripts) never gets split in half
 * and left as an orphan/broken glyph.
 */
function truncateByCodePoint(text: string, maxLength: number): string {
  const chars = Array.from(text);
  return chars.length > maxLength ? chars.slice(0, maxLength).join("") : text;
}

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

/**
 * Slightly more permissive than sanitizeName - strips HTML/control/bidi-spoofing
 * characters but otherwise allows free-form Unicode text (emoji, non-Latin
 * scripts, accents, etc.) rather than an ASCII allow-list, so messages typed
 * in e.g. Hindi or containing emoji aren't silently reduced to nothing.
 */
export function sanitizeChatText(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return "";

  let sanitized = input.replace(HTML_TAG_RE, "");
  sanitized = sanitized.replace(CONTROL_CHARS_RE, "");
  sanitized = sanitized.replace(BIDI_CONTROL_RE, "");
  return truncateByCodePoint(sanitized.trim(), maxLength);
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

// --- Admin API input hygiene -----------------------------------------------
//
// Mongoose casts query values against the schema type, so `{ username:
// { $ne: null } }` sent as JSON body/query already fails to match a String
// path in most cases - but we don't rely on that alone. Every value pulled
// from a request body/query and handed to a Mongoose filter is passed
// through one of these first, so an object/array can never reach a query
// where a primitive was expected (the classic NoSQL-injection vector).

/** Asserts `value` is a non-empty string, otherwise returns null. Never returns an object/array. */
export function asPlainString(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

const USERNAME_INPUT_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

/** Validates a login username without normalizing case (the model does that) - just rejects non-strings/shapes. */
export function isPlausibleUsername(value: unknown): value is string {
  return typeof value === "string" && USERNAME_INPUT_RE.test(value);
}

/** Passwords intentionally allow any characters - only type/length are checked here. */
export function isPlausiblePassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 256;
}