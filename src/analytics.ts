// =============================================================================
//  ANALYTICS — funnel events, behind ONE guarded seam.
//
//  WHY A SHIM AND NOT DIRECT CALLS:
//   • Provider-agnostic. Today the events go to VERCEL WEB ANALYTICS (`track()`
//     from @vercel/analytics, already injected on both entry points). If Umami is
//     ever added, `window.umami.track` is picked up automatically — no call site
//     changes. Adding a provider is a change HERE, nowhere else.
//   • Can never break the game. Every provider call is wrapped: analytics being
//     blocked (adblock, offline, a Pro-plan lapse, an SDK throw) must be a no-op,
//     never an exception on a gameplay path.
//   • ONE place enforces fire-once, so a reconnect loop or a re-render cannot
//     inflate the numbers into noise.
//
//  PRIVACY — the hard rule: NO PERSONAL DATA EVER. No client ids, no player
//  names, no room codes, no colours, no IPs, no free text. Aggregate counts and
//  fixed enum-ish strings only. Anything identifying a person or a session must
//  not be passed here, and reviewers should treat a new property as suspect
//  until it's proven to be a count or a constant. See privacy.html.
//
//  PERFORMANCE: never call from the physics step or a render frame. Every event
//  below is fired from a lifecycle transition that happens at most a handful of
//  times per session.
// =============================================================================
import { track } from '@vercel/analytics';

/** Only counts + fixed strings — never anything that identifies a person. */
export type EventProps = Record<string, string | number | boolean>;

interface UmamiLike { track?: (name: string, data?: EventProps) => void }

/**
 * Fire an event to whichever provider is present. Silent no-op when none is
 * (blocked / offline / not configured) — this must NEVER throw on a game path.
 */
export function trackEvent(name: string, props?: EventProps): void {
  // Vercel Web Analytics — the provider in use today.
  try { track(name, props); } catch { /* blocked or SDK error → ignore */ }
  // Umami, if it is ever added to the pages. Picked up automatically.
  try {
    const u = (globalThis as unknown as { umami?: UmamiLike }).umami;
    if (u && typeof u.track === 'function') u.track(name, props);
  } catch { /* ignore */ }
}

// ---- fire-once bookkeeping ---------------------------------------------------
// Funnel events must be counted ONCE per occurrence or the funnel is meaningless:
// the phone reconnects, the lobby re-renders and the QR toggles many times in a
// normal session. Keys are scoped by the caller (e.g. a per-race key) so a rematch
// legitimately counts again — see resetOnce().
const fired = new Set<string>();

/** Fire `name` only if `key` hasn't fired yet. Returns true if it actually fired. */
export function trackOnce(key: string, name: string, props?: EventProps): boolean {
  if (fired.has(key)) return false;
  fired.add(key);
  trackEvent(name, props);
  return true;
}

/** Re-arm keys for a NEW occurrence (e.g. a rematch re-arms the per-race events). */
export function resetOnce(...keys: string[]): void {
  for (const k of keys) fired.delete(k);
}

/**
 * Make an enum/bucket label safe to append to an EVENT NAME ('15m+' → '15m-plus').
 *
 * WHY VARIANTS LIVE IN THE NAME AT ALL: Vercel Web Analytics only reliably shows event
 * NAMES and counts on our plan — the per-property breakdown is not visible (Pro allows
 * just 2 properties per event, and the drill-down appears to be a Plus feature). A
 * breakdown that can't be read is not a measurement, so the variant goes in the name
 * where it always shows as its own row. The property is sent as well, so it lights up
 * for free if Web Analytics Plus is ever enabled.
 *
 * ⚠️ The variant must NEVER be folded into the trackOnce KEY — see the call sites: the
 * key stays constant so one session still reports exactly ONE failure, whichever
 * variant it turns out to be.
 */
export function nameSlug(label: string): string {
  return label
    .replace(/\+/g, '-plus')          // '15m+' → '15m-plus' (keep it name-safe)
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * A duration as a low-cardinality BUCKET LABEL.
 *
 * Raw seconds are useless in an analytics dashboard: every session produces a distinct
 * value, so the property explodes into thousands of one-hit rows you cannot read or
 * compare. Five buckets answer the actual question — did they bounce, or did they play?
 *
 * Boundaries are inclusive-low / exclusive-high, so 30 000 ms is the first '30s-2m'.
 */
export function durationBucket(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 30) return '0-30s';
  if (s < 120) return '30s-2m';
  if (s < 300) return '2-5m';
  if (s < 900) return '5-15m';
  return '15m+';
}
