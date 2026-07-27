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

export const NICK_COOLDOWN_DAYS = 30;
const DAY_MS = 86400_000;

/**
 * Whole days LEFT in the 30-day change cooldown, computed from the last-change
 * timestamp (ISO string) so the UI can gate up-front. 0 = no cooldown — the
 * timestamp is null (never set → a first-time set is free) or 30 days have
 * elapsed. This is a UI aid only; set_nickname() re-enforces it server-side.
 */
export function nicknameCooldownDaysLeft(changedAtIso: string | null, nowMs: number = Date.now()): number {
  if (!changedAtIso) return 0;
  const t = Date.parse(changedAtIso);
  if (!Number.isFinite(t)) return 0;
  const remaining = NICK_COOLDOWN_DAYS * DAY_MS - (nowMs - t);
  if (remaining <= 0) return 0;
  return Math.max(1, Math.ceil(remaining / DAY_MS));
}
