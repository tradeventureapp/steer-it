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
  emailVerified: boolean;   // Supabase confirms the email before a session exists
  recovery: boolean;        // arrived via a password-reset link → show "set new password"
  loading: boolean;         // initial session still resolving
}

const MAX_DEVICES = 5;

let state: AuthState = {
  user: null, isPremium: false, emailVerified: false, recovery: false, loading: true,
};
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
  try {
    // `.maybeSingle()` → 0 rows returns { data: null, error: null } (RLS block or
    // missing row) INSTEAD of `.single()`'s spurious PGRST116 error. We check error
    // explicitly (the old code dropped it → silent FREE).
    const { data, error, status } = await supabase
      .from('profiles').select('is_premium').eq('id', user.id).maybeSingle();
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
    }
    console.info('[auth] entitlement = %s  (is_premium=%o, row=%o, authed=%s, email=%s)',
      premium ? 'PREMIUM' : 'FREE', data?.is_premium, !!data, authedId === user.id, user.email);
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
  if (state.user?.id === user.id) set({ isPremium: premium });
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
      set({ user, emailVerified: !!session?.user?.email_confirmed_at, recovery: true, loading: false });
      return;
    }
    const user = toUser(session?.user);
    if (user) {
      set({ user, emailVerified: !!session?.user?.email_confirmed_at, loading: false });
      // Defer OUT of the onAuthStateChange callback: supabase-js holds an auth lock
      // while the callback runs, and awaiting a DB read (which needs the session) from
      // inside it can hang / read with no session in some versions. setTimeout(0) runs
      // it after the lock releases, with the session fully applied.
      setTimeout(() => { void refreshEntitlement(user); }, 0);
    } else {
      set({ user: null, isPremium: false, emailVerified: false, loading: false });
    }
  });
  // Kick the initial read (onAuthStateChange also fires INITIAL_SESSION, but this
  // resolves `loading` even if no session and no event lands quickly).
  void supabase.auth.getSession().then(({ data }) => {
    if (!data.session && state.loading) set({ loading: false });
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

export async function signUp(email: string, password: string):
Promise<{ error?: string; needsVerification?: boolean; alreadyRegistered?: boolean }> {
  // Normalise to the uniqueness key (aliases of one inbox → one account) and reject
  // clearly-disposable domains up front.
  const clean = normalizeEmail(email);
  if (isDisposableEmail(clean)) return { error: 'Please use a permanent email address.' };

  const { data, error } = await supabase.auth.signUp({
    email: clean, password, options: { emailRedirectTo: redirectTo() },
  });
  if (error) {
    // If "Confirm email" is OFF, Supabase surfaces an explicit duplicate error.
    if (/already registered|already exists|already.*registered/i.test(error.message)) {
      return { error: 'This email is already registered — log in instead.', alreadyRegistered: true };
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

export async function signIn(email: string, password: string): Promise<{ error?: string }> {
  // Normalise so a user who typed an alias signs into the SAME account.
  const { error } = await supabase.auth.signInWithPassword({ email: normalizeEmail(email), password });
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

export async function sendPasswordReset(email: string): Promise<{ error?: string }> {
  const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), { redirectTo: redirectTo() });
  if (error) return { error: msg(error) };
  return {};
}

export async function resendVerification(email: string): Promise<{ error?: string }> {
  const { error } = await supabase.auth.resend({ type: 'signup', email: normalizeEmail(email), options: { emailRedirectTo: redirectTo() } });
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
