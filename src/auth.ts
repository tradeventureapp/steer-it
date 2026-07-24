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
// 5-cap). Both are best-effort — a network hiccup just leaves is_premium false
// (fail-closed: you never accidentally get premium).
async function refreshEntitlement(user: AuthUser) {
  let premium = false;
  try {
    const { data } = await supabase.from('profiles').select('is_premium').eq('id', user.id).single();
    premium = !!data?.is_premium;
  } catch { /* fail closed */ }
  // Register/refresh this device + prune to the newest MAX_DEVICES (server-side).
  try {
    await supabase.rpc('register_device', {
      p_device_id: deviceId(),
      p_user_agent: (navigator.userAgent || '').slice(0, 200),
    });
  } catch { /* the cap RPC is best-effort; entitlement still applies */ }
  if (state.user?.id === user.id) set({ isPremium: premium });
}

function toUser(u: { id: string; email?: string } | null | undefined): AuthUser | null {
  return u ? { id: u.id, email: u.email ?? '' } : null;
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
      void refreshEntitlement(user);
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

export async function signUp(email: string, password: string): Promise<{ error?: string; needsVerification?: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email, password, options: { emailRedirectTo: redirectTo() },
  });
  if (error) return { error: msg(error) };
  // With "Confirm email" ON, no session is returned until the link is clicked.
  return { needsVerification: !data.session };
}

export async function signIn(email: string, password: string): Promise<{ error?: string }> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
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
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
  if (error) return { error: msg(error) };
  return {};
}

export async function resendVerification(email: string): Promise<{ error?: string }> {
  const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirectTo() } });
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
