// =============================================================================
//  NICKNAME (display name) — client-side FORMAT validation only.
//
//  Pure + unit-testable. This is the instant, list-free check for live UI
//  feedback (length + allowed characters). The AUTHORITATIVE checks —
//  case-insensitive UNIQUENESS, the PROFANITY filter, and the 30-day CHANGE
//  cooldown — all live in the database (see supabase/schema.sql: the CHECK
//  constraint, the unique index on lower(nickname), and the check_nickname /
//  set_nickname SECURITY DEFINER functions). The client never enforces those;
//  it only calls those RPCs and shows their verdict.
//
//  Rules: 3–20 chars, letters / numbers / underscore / hyphen. No spaces, no
//  emoji, no other punctuation. Kept in lock-step with the DB regex
//  `^[A-Za-z0-9_-]{3,20}$`.
// =============================================================================

export const NICK_MIN = 3;
export const NICK_MAX = 20;
export const NICK_ALLOWED = /^[A-Za-z0-9_-]+$/;

/**
 * A human-readable FORMAT error for a candidate nickname, or null if the format
 * is valid. Does NOT check uniqueness or profanity (those are server RPCs).
 */
export function nicknameFormatError(raw: string): string | null {
  const n = (raw || '').trim();
  if (n.length === 0) return 'Pick a nickname.';
  if (n.length < NICK_MIN) return `Too short — at least ${NICK_MIN} characters.`;
  if (n.length > NICK_MAX) return `Too long — at most ${NICK_MAX} characters.`;
  if (!NICK_ALLOWED.test(n)) return 'Letters, numbers, _ and - only (no spaces).';
  return null;
}

/** True if the nickname passes the client FORMAT rules (not uniqueness/profanity). */
export function isNicknameFormatValid(raw: string): boolean {
  return nicknameFormatError(raw) === null;
}
