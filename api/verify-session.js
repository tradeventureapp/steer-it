// =============================================================================
//  POST /api/verify-session?session_id=cs_...    (the on-return FALLBACK)
//
//  When the user comes back from Stripe to the success page, the client calls this
//  with its access token + the Checkout Session id. We retrieve the session from
//  Stripe server-side and, if it is PAID and belongs to THIS authenticated user,
//  set is_premium = true — so even if the webhook is delayed or lost, a paid user
//  still gets Premium immediately on return. Idempotent (same setPremium path).
//
//  Security: the session's user_id must equal the caller's verified user id, so a
//  user can only confirm THEIR OWN paid session (not someone else's).
// =============================================================================
import { STRIPE_SK, verifyUser, setPremium, originAllowed, log } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!originAllowed(req)) { res.status(403).json({ error: 'forbidden' }); return; }

  const sk = STRIPE_SK();
  if (!sk) { res.status(503).json({ error: 'payments not configured' }); return; }

  const user = await verifyUser(req);
  if (!user) { res.status(401).json({ error: 'login required' }); return; }

  let sessionId = '';
  try { sessionId = new URL(req.url, 'http://x').searchParams.get('session_id') || ''; } catch { /* ignore */ }
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) { res.status(400).json({ error: 'session_id required' }); return; }

  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${sk}` },
    });
    const s = await r.json();
    if (!r.ok) { log('verify_stripe_error', { status: r.status, err: s?.error?.message }); res.status(502).json({ error: 'stripe error' }); return; }

    const paid = s.payment_status === 'paid' || s.status === 'complete';
    const sUser = (s.metadata && s.metadata.user_id) || s.client_reference_id || null;

    if (!paid) { log('verify_not_paid', { session: sessionId, user: user.id, payment_status: s.payment_status }); res.status(200).json({ premium: false, reason: 'not_paid' }); return; }
    if (sUser !== user.id) { log('verify_user_mismatch', { session: sessionId, sessionUser: sUser, caller: user.id }); res.status(403).json({ premium: false, reason: 'mismatch' }); return; }

    const up = await setPremium(user.id);   // idempotent — no-op if the webhook already did it
    if (!up.ok) { log('verify_upgrade_failed', { session: sessionId, user: user.id, error: up.error }); res.status(500).json({ premium: false, error: 'db error' }); return; }
    log('verify_upgraded', { session: sessionId, user: user.id, viaUpsert: !!up.viaUpsert });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ premium: true });
  } catch (e) {
    log('verify_error', { session: sessionId, error: String(e) });
    res.status(502).json({ error: 'verify error' });
  }
}
