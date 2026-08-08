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
