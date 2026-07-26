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

// Set is_premium = true for a user with the SERVICE-ROLE key (bypasses RLS).
// IDEMPOTENT: setting true when already true is a no-op, so processing the same
// Stripe event twice yields the same result — no error, no duplicate. Returns
// { ok, updated?, viaUpsert?, error? }.
export async function setPremium(userId) {
  const base = SUPA_URL(); const key = SERVICE_ROLE();
  if (!base || !key) return { ok: false, error: 'supabase service role not configured' };
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  try {
    // Update the existing profile row.
    const r = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ is_premium: true }),
    });
    if (!r.ok) return { ok: false, error: `patch ${r.status}: ${(await r.text()).slice(0, 300)}` };
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length > 0) return { ok: true, updated: rows.length };
    // No row matched → idempotent upsert (creates the row if the profile is missing).
    const up = await fetch(`${base}/rest/v1/profiles?on_conflict=id`, {
      method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ id: userId, is_premium: true }),
    });
    if (!up.ok) return { ok: false, error: `upsert ${up.status}: ${(await up.text()).slice(0, 300)}` };
    return { ok: true, updated: 1, viaUpsert: true };
  } catch (e) { return { ok: false, error: String(e) }; }
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
