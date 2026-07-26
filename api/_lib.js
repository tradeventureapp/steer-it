// =============================================================================
//  Shared helpers for the Stripe payment endpoints (Vercel serverless).
//
//  The `_` prefix means Vercel does NOT expose this file as a route — it is
//  imported by create-checkout-session / stripe-webhook / verify-session.
//
//  Zero external deps (matches api/turn.js): Stripe is called over its REST API
//  with fetch, the webhook signature is verified with Node crypto, and Supabase
//  writes go through PostgREST with the SERVICE-ROLE key (server-side only, never
//  shipped to the client — RLS lets a user READ is_premium but only the service
//  role may WRITE it, which is the whole security model).
// =============================================================================
import crypto from 'node:crypto';

const envOr = (...names) => { for (const n of names) { const v = process.env[n]; if (v) return v; } return ''; };

export const SUPA_URL     = () => envOr('SUPABASE_URL', 'VITE_SUPABASE_URL').replace(/\/$/, '');
export const SUPA_ANON    = () => envOr('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY');
export const SERVICE_ROLE = () => envOr('SUPABASE_SERVICE_ROLE_KEY');
export const STRIPE_SK    = () => envOr('STRIPE_SECRET_KEY');
export const WEBHOOK_SECRET = () => envOr('STRIPE_WEBHOOK_SECRET');
// The Premium price ($6.90 one-off). Overridable via env, else the known id.
export const PRICE_ID     = () => envOr('STRIPE_PRICE_ID') || 'price_1TxTdhKSjvof0rFuEPOkW79q';
// Canonical site origin for Checkout success/cancel URLs (never a forged Origin).
export const PUBLIC_BASE  = () => envOr('PUBLIC_BASE_URL', 'VITE_PUBLIC_BASE_URL') || 'https://steerit.app';

const ALLOWED_ORIGINS = ['https://steerit.app', 'https://steer-it.vercel.app'];

// Structured one-line logs → filter the Vercel function logs by `evt`.
export function log(evt, fields) {
  const line = JSON.stringify({ evt, ts: new Date().toISOString(), ...(fields || {}) });
  if (/(fail|error|reject|bad|mismatch|unconfigured)/.test(evt)) console.warn(line); else console.log(line);
}

// Block an explicit FOREIGN origin; allow a missing one (same-origin fetch may omit it).
export function originAllowed(req) {
  const origin = req.headers.origin || '';
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

// Read the exact raw request bytes (needed for Stripe signature verification).
export async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// Validate a Supabase access token (the JWT the client sends as Bearer) by asking
// Supabase who it belongs to. Returns { id, email } or null. This is what ties a
// checkout to a real, authenticated account.
export async function verifyUser(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const base = SUPA_URL(); const anon = SUPA_ANON();
  if (!base || !anon) return null;
  try {
    const r = await fetch(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id, email: u.email || '' } : null;
  } catch { return null; }
}

// Which "kind" of service key we were given (for diagnostics in the logs):
//   • legacy-jwt  = the classic service_role JWT (eyJ…) — a JWT whose role claim
//                   PostgREST decodes to bypass RLS. The reliable REST-write key.
//   • new-secret  = the new sb_secret_… key (NOT a JWT). PostgREST reads the ROLE
//                   from the Authorization JWT, so a non-JWT bearer can be rejected
//                   or fall back to `anon` → RLS blocks the write (0 rows / 401).
function keyKind(key) {
  if (key.startsWith('eyJ')) return 'legacy-jwt';
  if (key.startsWith('sb_secret_') || key.startsWith('sb_')) return 'new-secret';
  return 'unknown';
}

// One write attempt (PATCH the row; upsert if it's missing) with a given auth
// header set. Returns { httpOk, status, wrote, rows, viaUpsert, body }. `wrote` is
// true ONLY when a row with is_premium=true actually came back — so a 200 that RLS
// silently filtered to 0 rows counts as NOT written (the real silent-failure case).
async function writePremium(base, userId, authHeaders) {
  const base0 = { ...authHeaders, 'Content-Type': 'application/json' };
  const hasTrue = (txt) => { try { const a = JSON.parse(txt); return Array.isArray(a) && a.some((x) => x && x.is_premium === true); } catch { return false; } };

  const r = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH', headers: { ...base0, Prefer: 'return=representation' },
    body: JSON.stringify({ is_premium: true }),
  });
  const rBody = await r.text();
  if (r.ok && hasTrue(rBody)) return { httpOk: true, status: r.status, wrote: true, rows: 1, body: rBody };
  if (!r.ok) return { httpOk: false, status: r.status, wrote: false, rows: 0, body: rBody.slice(0, 300) };

  // HTTP 200 but no matching row (missing profile, or RLS filtered it) → upsert.
  const u = await fetch(`${base}/rest/v1/profiles?on_conflict=id`, {
    method: 'POST', headers: { ...base0, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ id: userId, is_premium: true }),
  });
  const uBody = await u.text();
  if (u.ok && hasTrue(uBody)) return { httpOk: true, status: u.status, wrote: true, rows: 1, viaUpsert: true, body: uBody };
  return { httpOk: u.ok, status: u.status, wrote: false, rows: 0, viaUpsert: true, body: uBody.slice(0, 300) };
}

// Set is_premium = true for a user with the SERVICE key (must bypass RLS —
// only the server may write it). IDEMPOTENT (a plain "set true"). ROBUST: tries the
// standard header set first, then an apikey-only variant, and only reports success
// when a row with is_premium=true actually came back (never a silent 200-with-0-rows).
// Every attempt is logged with its status + key kind so the exact failure is visible.
export async function setPremium(userId) {
  const base = SUPA_URL(); const key = SERVICE_ROLE();
  if (!base || !key) { log('setpremium_misconfigured', { base: !!base, key: !!key }); return { ok: false, error: 'supabase service role not configured' }; }
  const kind = keyKind(key);
  // Attempt 1: apikey + Authorization Bearer (the canonical PostgREST service-role
  //            method — works with a legacy service_role JWT).
  // Attempt 2: apikey only — a fallback for gateway setups that resolve the role
  //            from the apikey alone and reject a non-JWT bearer.
  const attempts = [
    { name: 'apikey+bearer', headers: { apikey: key, Authorization: `Bearer ${key}` } },
    { name: 'apikey-only', headers: { apikey: key } },
  ];
  let last = { status: 0, body: '' };
  for (const a of attempts) {
    let res;
    try { res = await writePremium(base, userId, a.headers); }
    catch (e) { log('setpremium_attempt', { user: userId, keyKind: kind, attempt: a.name, error: String(e) }); last = { status: 0, body: String(e) }; continue; }
    log('setpremium_attempt', { user: userId, keyKind: kind, attempt: a.name, status: res.status, httpOk: res.httpOk, wrote: res.wrote, body: res.wrote ? undefined : res.body });
    if (res.wrote) return { ok: true, updated: res.rows, viaUpsert: !!res.viaUpsert, attempt: a.name, keyKind: kind };
    last = res;
  }
  return { ok: false, keyKind: kind, error: `write failed (status ${last.status}, key ${kind}): ${(last.body || '').slice(0, 300)}` };
}

// Verify a Stripe webhook signature (the `Stripe-Signature` header) against the
// raw body + the endpoint secret. Implements Stripe's scheme exactly: HMAC-SHA256
// over `${t}.${payload}`, timing-safe compared to every v1 signature, with a
// 5-minute timestamp tolerance (replay protection). An unsigned/forged/expired
// request returns false → the caller rejects it and grants NOTHING.
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  let t = '';
  const v1 = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') v1.push(v);
  }
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts) || !v1.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;   // replay guard
  const expected = crypto.createHmac('sha256', secret)
    .update(`${t}.${rawBody.toString('utf8')}`, 'utf8').digest('hex');
  const expBuf = Buffer.from(expected, 'hex');
  for (const s of v1) {
    let sBuf; try { sBuf = Buffer.from(s, 'hex'); } catch { continue; }
    if (sBuf.length === expBuf.length && crypto.timingSafeEqual(sBuf, expBuf)) return true;
  }
  return false;
}
