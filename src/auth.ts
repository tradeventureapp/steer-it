// =============================================================================
//  STEER IT — HOST auth + entitlement (Supabase Auth).
//
//  ONLY the host (the person running the game on the big screen) ever touches
//  this. Phone controllers (play.html / phone.ts) NEVER import it — joining via
//  QR stays account-free. This module wraps supabase.auth (email+password, email
//  verification, password reset) and the server-authoritative entitlement:
//    • is_premium  — read from public.profiles (RLS-protected; the client can
//                    never set it — only a service-role payment webhook can).
//    • device cap  — register_device() RPC enforces the rolling 5-device limit.
//
//  Everything is a thin, typed wrapper returning { error?: string } so the UI
//  can show a friendly message; the Supabase session is persisted + auto-refreshed
//  by the client (createClient defaults), so the host stays logged in across reloads.
// =============================================================================
import { supabase } from './supabase';
import { normalizeEmail, isDisposableEmail } from './email';

export interface AuthUser { id: string; email: string; }
export interface AuthState {
  user: AuthUser | null;    // null = logged out
  isPremium: boolean;       // the entitlement (server truth); false when logged out
  nickname: string | null;  // display name (server truth); null = logged out / not set yet
  nicknameChangedAt: string | null;  // last_nickname_change (ISO) — drives the 30-day cooldown UI
  emailVerified: boolean;   // Supabase confirms the email before a session exists
  recovery: boolean;        // arrived via a password-reset link → show "set new password"
  loading: boolean;         // initial session still resolving
  // Is the ENTITLEMENT (is_premium) resolved for the current user? False in the window
  // between "a session appeared" and "the profile read returned" — while false the UI
  // must NOT render the free/locked state (it would flash FREE→PREMIUM). Trivially true
  // when logged out (no entitlement), and seeded true instantly from the cache below for
  // a returning user (then re-verified against the server).
  entitlementKnown: boolean;
}

const MAX_DEVICES = 5;

let state: AuthState = {
  user: null, isPremium: false, nickname: null, nicknameChangedAt: null,
  emailVerified: false, recovery: false, loading: true, entitlementKnown: false,
};

// ---- Last-known-entitlement cache (per user id) + a session hint --------------
// So a returning host renders the CORRECT plan immediately on load/login instead of
// flashing FREE while the profile read is in flight. The cache is only a display
// optimisation — refreshEntitlement() always re-reads the server, and server truth
// overwrites it. The session hint lets the UI route to the game menu (not the
// marketing landing) before auth has resolved, for a returning host.
const ENT_PREFIX = 'steerit.ent.';
const SESSION_HINT = 'steerit.session';
interface EntCache { isPremium: boolean; nickname: string | null; nicknameChangedAt: string | null }
function readEntCache(uid: string): EntCache | null {
  try { const raw = localStorage.getItem(ENT_PREFIX + uid); if (!raw) return null;
    const o = JSON.parse(raw) as { p?: boolean; n?: string | null; c?: string | null };
    return { isPremium: !!o.p, nickname: o.n ?? null, nicknameChangedAt: o.c ?? null };
  } catch { return null; }
}
function writeEntCache(uid: string, e: EntCache) {
  try { localStorage.setItem(ENT_PREFIX + uid, JSON.stringify({ p: e.isPremium, n: e.nickname, c: e.nicknameChangedAt })); } catch { /* storage off */ }
}
function setSessionHint(uid: string) { try { localStorage.setItem(SESSION_HINT, uid); } catch { /* storage off */ } }
function clearSessionHint() { try { localStorage.removeItem(SESSION_HINT); } catch { /* storage off */ } }
// True if a host was logged in last time — used to avoid flashing the landing on reload.
export function hasSessionHint(): boolean { try { return !!localStorage.getItem(SESSION_HINT); } catch { return false; } }
const listeners = new Set<(s: AuthState) => void>();
function emit() { for (const l of listeners) l(state); }
function set(patch: Partial<AuthState>) { state = { ...state, ...patch }; emit(); }

export function getAuthState(): AuthState { return state; }
export function onAuthChange(cb: (s: AuthState) => void): () => void {
  listeners.add(cb); cb(state);
  return () => listeners.delete(cb);
}

// A stable per-browser id for the device cap (NOT a security token — just an
// identity for the 5-device rolling window). Persisted in localStorage.
function deviceId(): string {
  const KEY = 'steerit.device.id';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = (crypto as Crypto).randomUUID(); localStorage.setItem(KEY, id); }
    return id;
  } catch { return 'no-storage'; }
}

// After a session exists: read the entitlement + register this device (rolling
// 5-cap). Fail-closed on a genuine error, but LOUD — every read logs exactly what
// the client got back (data + error + whether it's authenticated), so a premium
// account that reads as FREE is diagnosable (RLS blocking, missing row, etc.).
async function refreshEntitlement(user: AuthUser): Promise<boolean> {
  let premium = false;
  let nickname: string | null = null;
  let nicknameChangedAt: string | null = null;
  try {
    // `.maybeSingle()` → 0 rows returns { data: null, error: null } (RLS block or
    // missing row) INSTEAD of `.single()`'s spurious PGRST116 error. We check error
    // explicitly (the old code dropped it → silent FREE).
    const { data, error, status } = await supabase
      .from('profiles').select('is_premium, nickname, last_nickname_change').eq('id', user.id).maybeSingle();
    // Confirm we're querying with the AUTHENTICATED session (RLS auth.uid()), not anon.
    const { data: authData } = await supabase.auth.getUser();
    const authedId = authData.user?.id ?? null;

    if (error) {
      console.error('[auth] profiles read FAILED (HTTP %s, code %s): %s',
        status, error.code, error.message, { details: error.details, hint: error.hint });
    } else if (!data) {
      console.warn(
        '[auth] profiles returned NO ROW for id=%s (authed uid=%s). Either the row ' +
        'is missing OR the RLS SELECT policy is blocking the authenticated read — ' +
        'a service-role SELECT in the dashboard would still see it. Defaulting to FREE.',
        user.id, authedId);
    } else {
      premium = data.is_premium === true;
      nickname = (data.nickname as string | null) ?? null;
      nicknameChangedAt = (data.last_nickname_change as string | null) ?? null;
    }
    console.info('[auth] entitlement = %s  (is_premium=%o, nick=%o, row=%o, authed=%s, email=%s)',
      premium ? 'PREMIUM' : 'FREE', data?.is_premium, nickname, !!data, authedId === user.id, user.email);
  } catch (e) {
    console.error('[auth] profiles read threw:', e);
  }
  // Register/refresh this device + prune to the newest MAX_DEVICES (server-side).
  try {
    await supabase.rpc('register_device', {
      p_device_id: deviceId(),
      p_user_agent: (navigator.userAgent || '').slice(0, 200),
    });
  } catch { /* the cap RPC is best-effort; entitlement still applies */ }
  if (state.user?.id === user.id) {
    // Server truth wins — and mark the entitlement KNOWN so the UI renders the real
    // state once, and cache it so the next load doesn't flash.
    set({ isPremium: premium, nickname, nicknameChangedAt, entitlementKnown: true });
    writeEntCache(user.id, { isPremium: premium, nickname, nicknameChangedAt });
  }
  return premium;
}

// Manual re-check (exposed on window in desktop.ts) — re-reads the profile, logs
// what came back, and updates the chip. Lets the host verify entitlement live.
export async function checkEntitlement(): Promise<AuthState> {
  if (!state.user) { console.info('[auth] not logged in → FREE'); return state; }
  await refreshEntitlement(state.user);
  console.info('[auth] state now:', { email: state.user.email, isPremium: state.isPremium });
  return state;
}

function toUser(u: { id: string; email?: string } | null | undefined): AuthUser | null {
  return u ? { id: u.id, email: u.email ?? '' } : null;
}

// ---- Nickname (display name) --------------------------------------------------
export interface NickCheck { ok: boolean; reason: string | null; available: boolean; }
// Live availability + validity for the UI (safe to call logged-out, for signup).
// Authoritative source is the DB check_nickname() RPC — format, profanity, taken.
export async function checkNickname(nick: string): Promise<NickCheck> {
  try {
    const { data, error } = await supabase.rpc('check_nickname', { p_nick: nick.trim() });
    if (error) return { ok: false, reason: 'error', available: false };
    const r = (data ?? {}) as { ok?: boolean; reason?: string | null; available?: boolean };
    return { ok: !!r.ok, reason: r.reason ?? null, available: !!r.available };
  } catch { return { ok: false, reason: 'error', available: false }; }
}

export interface NickChange { ok: boolean; reason?: string; daysLeft?: number; }
// Change the caller's nickname. The DB set_nickname() RPC enforces validity,
// profanity, case-insensitive uniqueness AND the 30-day cooldown server-side; we
// just relay its verdict and reflect the new name locally on success.
export async function changeNickname(nick: string): Promise<NickChange> {
  try {
    const { data, error } = await supabase.rpc('set_nickname', { p_nick: nick.trim() });
    if (error) return { ok: false, reason: 'error' };
    const r = (data ?? {}) as { ok?: boolean; reason?: string; days_left?: number };
    if (r.ok) {
      // The server just set last_nickname_change = now(); reflect it so the 30-day
      // cooldown is active immediately in the UI (and in the cache, so it doesn't flash back).
      if (state.user) {
        const at = new Date().toISOString();
        set({ nickname: nick.trim(), nicknameChangedAt: at });
        writeEntCache(state.user.id, { isPremium: state.isPremium, nickname: nick.trim(), nicknameChangedAt: at });
      }
      return { ok: true };
    }
    return { ok: false, reason: r.reason, daysLeft: r.days_left };
  } catch { return { ok: false, reason: 'error' }; }
}

// ---- Marketing email consent (GDPR opt-in) -----------------------------------
// Records the caller's marketing opt-in from the OAuth nickname prompt (the
// email/password path writes it via the signup trigger instead — see signUp). Goes
// through the SECURITY DEFINER set_marketing_consent() RPC because the client can't
// write profiles directly. Fire-and-forget: a failure is swallowed so it never blocks
// setting the nickname / continuing. `optIn=false` records "no consent" (timestamp null).
export async function setMarketingConsent(optIn: boolean): Promise<void> {
  try { await supabase.rpc('set_marketing_consent', { p_opt_in: !!optIn }); }
  catch { /* best-effort; never blocks the prompt */ }
}

// The current session's access token (Supabase JWT) — sent as a Bearer to our own
// serverless endpoints (Stripe checkout / verify) so they can authenticate the
// host server-side. null if logged out.
export async function getAccessToken(): Promise<string | null> {
  try { const { data } = await supabase.auth.getSession(); return data.session?.access_token ?? null; }
  catch { return null; }
}

// Wire the auth lifecycle. Supabase fires INITIAL_SESSION on load (restored
// session), SIGNED_IN / SIGNED_OUT / USER_UPDATED / TOKEN_REFRESHED, and
// PASSWORD_RECOVERY when the host follows a reset link back to the site.
export function initAuth() {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      const user = toUser(session?.user);
      // Recovery is its own screen (no premium UI) → entitlement is "known" so nothing holds.
      set({ user, emailVerified: !!session?.user?.email_confirmed_at, recovery: true, loading: false, entitlementKnown: true });
      if (user) setSessionHint(user.id);
      return;
    }
    const user = toUser(session?.user);
    if (user) {
      setSessionHint(user.id);
      const same = state.user?.id === user.id;
      if (same && state.entitlementKnown) {
        // Already resolved for this user (a token refresh, etc.) — keep the plan, just refresh session fields.
        set({ user, emailVerified: !!session?.user?.email_confirmed_at, loading: false });
      } else {
        // New session appearing: seed the plan from the cache (instant, correct for a
        // returning user → no FREE flash). If there's no cache, mark the entitlement
        // PENDING (entitlementKnown:false) so the UI holds a neutral state instead of
        // showing free. Either way the server read below confirms/corrects it.
        const cached = readEntCache(user.id);
        set({
          user, emailVerified: !!session?.user?.email_confirmed_at, loading: false,
          isPremium: cached ? cached.isPremium : false,
          nickname: cached ? cached.nickname : null,
          nicknameChangedAt: cached ? cached.nicknameChangedAt : null,
          entitlementKnown: !!cached,
        });
      }
      // Defer OUT of the onAuthStateChange callback: supabase-js holds an auth lock
      // while the callback runs, and awaiting a DB read (which needs the session) from
      // inside it can hang / read with no session in some versions. setTimeout(0) runs
      // it after the lock releases, with the session fully applied.
      setTimeout(() => { void refreshEntitlement(user); }, 0);
    } else {
      clearSessionHint();
      set({ user: null, isPremium: false, nickname: null, nicknameChangedAt: null, emailVerified: false, loading: false, entitlementKnown: true });
    }
  });
  // Kick the initial read (onAuthStateChange also fires INITIAL_SESSION, but this
  // resolves `loading` even if no session and no event lands quickly).
  void supabase.auth.getSession().then(({ data }) => {
    if (!data.session && state.loading) { clearSessionHint(); set({ loading: false, entitlementKnown: true }); }
  });
}

// The redirect target for verification + reset links: the real site origin.
function redirectTo(): string {
  try { return window.location.origin; } catch { return ''; }
}

function msg(e: unknown): string {
  const m = (e as { message?: string })?.message || String(e || 'Something went wrong');
  return m;
}

// The nickname is claimed atomically by the signup trigger (see schema.sql): it
// goes into the auth metadata, and the DB CHECK + unique index + nickname_reason()
// make an invalid/taken/profane nickname fail the whole signup. The caller
// pre-checks with checkNickname() for clean messages, so a trigger failure here is
// the rare race/abuse case → we map it to "nickname taken".
export async function signUp(email: string, password: string, nickname: string, marketingOptIn = false):
Promise<{ error?: string; needsVerification?: boolean; alreadyRegistered?: boolean; nicknameTaken?: boolean }> {
  // Reject clearly-disposable domains up front. The NORMALISED form is still what we
  // test (so `foo+throwaway@mailinator.com` is caught), but it is NOT what we store.
  const clean = normalizeEmail(email);
  if (isDisposableEmail(clean)) return { error: 'Please use a permanent email address.' };
  // STORE THE ADDRESS AS TYPED (trimmed + lower-cased only). Storing the normalised
  // form used to collapse inbox aliases to one account, but it also broke Google
  // identity linking for every Gmail user with a dot or a "+tag" in their address —
  // Supabase matches the provider's email against this value EXACTLY, and a mismatch
  // silently creates a second account, orphaning their premium. Alias-collapsing was
  // worth little here (extra FREE accounts gain nobody anything; premium is bought
  // per-account), so correctness of linking wins.
  const stored = (email || '').trim().toLowerCase();

  // `marketing_opt_in` rides in the signup metadata alongside the nickname; the
  // handle_new_user trigger writes it (+ its consent timestamp) into the profile at
  // creation — the same server-side path the nickname uses. Defaults false (unticked).
  const { data, error } = await supabase.auth.signUp({
    email: stored, password,
    options: { emailRedirectTo: redirectTo(), data: { nickname: nickname.trim(), marketing_opt_in: !!marketingOptIn } },
  });
  if (error) {
    // If "Confirm email" is OFF, Supabase surfaces an explicit duplicate error.
    if (/already registered|already exists|already.*registered/i.test(error.message)) {
      return { error: 'This email is already registered — log in instead.', alreadyRegistered: true };
    }
    // The nickname trigger rejected it (unique race / invalid) → surfaces as a
    // generic "Database error saving new user". After the client pre-check, that's
    // almost always the nickname being taken in the meantime.
    if (/database error|nickname|duplicate|unique|constraint/i.test(error.message)) {
      return { error: 'That nickname was just taken — try another.', nicknameTaken: true };
    }
    return { error: msg(error) };
  }
  // SILENT DUPLICATE (the "Confirm email" ON case): to avoid revealing which emails
  // exist, Supabase returns a fabricated user with an EMPTY identities array for an
  // already-registered (confirmed) address. Detect that so the user gets clear
  // feedback instead of a misleading "check your email".
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { error: 'This email is already registered — log in instead.', alreadyRegistered: true };
  }
  // With "Confirm email" ON, no session is returned until the link is clicked.
  return { needsVerification: !data.session };
}

// =============================================================================
//  GOOGLE (OAuth) — additive. Email+password is untouched.
//
//  ⚠️ WHY THE EMAIL IS NO LONGER NORMALISED AT SIGN-UP (see signUp above):
//  Supabase auto-links an OAuth identity to an existing user when the provider's
//  VERIFIED email matches `auth.users.email` exactly. We used to store a MUTATED
//  address (normalizeEmail strips Gmail dots + "+tags"), so `jakub.dyk@gmail.com`
//  was stored as `jakubdyk@gmail.com` while Google returns the real one — no match,
//  a SECOND account, and the premium purchase (keyed on the auth UUID) orphaned.
//  Storing the address as typed is what makes linking work in BOTH directions.
// =============================================================================

/** Sign in / sign up with Google. Redirects away and back to the site origin. */
export async function signInWithGoogle(): Promise<{ error?: string }> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectTo(),
      // Always show the account chooser: hosts often have several Google accounts,
      // and silently reusing the last one is how people end up on the wrong account.
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error) return { error: msg(error) };
  return {};
}

export async function signIn(email: string, password: string): Promise<{ error?: string }> {
  // Normalise so a user who typed an alias signs into the SAME account.
  // Sign in with the address AS TYPED — the same form signUp stores, so it matches
  // exactly. (NOT normalizeEmail: that would send the dot-stripped form and fail to
  // match a real Gmail address like steer.it@gmail.com.)
  const { error } = await supabase.auth.signInWithPassword({
    email: (email || '').trim().toLowerCase(), password,
  });
  if (error) return { error: msg(error) };
  return {};
}

export async function signOut(): Promise<void> {
  try {
    // Drop this device from the cap list on an explicit sign-out (tidy the window).
    if (state.user) await supabase.from('devices').delete()
      .eq('user_id', state.user.id).eq('device_id', deviceId());
  } catch { /* ignore */ }
  await supabase.auth.signOut();
}

// Address AS TYPED, matching how signUp stores it. These endpoints deliberately do NOT
// error on an unknown address (so they can't be used to probe which emails exist), so
// sending the wrong form would fail SILENTLY — the user waits for a mail that never
// comes. Typed is the stored form, so there is nothing to reconcile.
export async function sendPasswordReset(email: string): Promise<{ error?: string }> {
  const { error } = await supabase.auth.resetPasswordForEmail(
    (email || '').trim().toLowerCase(), { redirectTo: redirectTo() });
  if (error) return { error: msg(error) };
  return {};
}

export async function resendVerification(email: string): Promise<{ error?: string }> {
  const { error } = await supabase.auth.resend({
    type: 'signup', email: (email || '').trim().toLowerCase(),
    options: { emailRedirectTo: redirectTo() },
  });
  if (error) return { error: msg(error) };
  return {};
}

// Complete a password reset: called from the recovery form (host arrived via the
// email link, PASSWORD_RECOVERY set `recovery`). On success the recovery flag clears.
export async function updatePassword(newPassword: string): Promise<{ error?: string }> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: msg(error) };
  set({ recovery: false });
  return {};
}

export const DEVICE_LIMIT = MAX_DEVICES;
