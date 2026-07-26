// =============================================================================
//  POST /api/stripe-webhook   (register this URL in the Stripe dashboard)
//
//  Stripe → us on `checkout.session.completed`. This is the AUTHORITATIVE grant of
//  Premium, so it is locked down:
//   • SIGNATURE VERIFIED — the raw body + `Stripe-Signature` are checked against
//     STRIPE_WEBHOOK_SECRET (HMAC-SHA256, timing-safe, 5-min replay window). An
//     unsigned / forged / stale request is rejected and grants NOTHING.
//   • Reads the account from session.metadata.user_id (falls back to
//     client_reference_id) and sets is_premium = true via the SERVICE-ROLE key
//     (bypasses RLS — only the server can do this).
//   • IDEMPOTENT — Stripe retries webhooks; the upgrade is a plain "set true", so
//     the same event processed twice is a no-op (no error, no duplicate).
//   • Returns 200 fast on success; a transient DB failure returns 500 so Stripe
//     retries (and the on-return fallback is a second safety net).
//
//  bodyParser is disabled so we get the exact bytes Stripe signed.
// =============================================================================
import { WEBHOOK_SECRET, readRawBody, verifyStripeSignature, setPremium, log } from './_lib.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('method not allowed'); return; }

  const secret = WEBHOOK_SECRET();
  if (!secret) { log('webhook_unconfigured', {}); res.status(503).send('webhook not configured'); return; }

  const raw = await readRawBody(req);
  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(raw, sig, secret)) {
    log('webhook_bad_signature', { hasSig: !!sig });
    res.status(400).send('invalid signature');   // forged/unsigned → NOTHING granted
    return;
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { log('webhook_bad_json', {}); res.status(400).send('bad json'); return; }

  log('webhook_verified', { id: event.id, type: event.type });

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data?.object || {};
      const paid = s.payment_status === 'paid' || s.status === 'complete';
      const userId = (s.metadata && s.metadata.user_id) || s.client_reference_id || null;

      if (!paid) { log('webhook_not_paid', { id: event.id, payment_status: s.payment_status }); res.status(200).send('ignored: unpaid'); return; }
      if (!userId) { log('webhook_no_user', { id: event.id }); res.status(200).send('ignored: no user'); return; }

      const r = await setPremium(userId);   // idempotent
      if (!r.ok) { log('webhook_upgrade_failed', { id: event.id, user: userId, error: r.error }); res.status(500).send('db error'); return; }
      log('webhook_upgraded', { id: event.id, user: userId, updated: r.updated, viaUpsert: !!r.viaUpsert });
    } else {
      log('webhook_ignored', { id: event.id, type: event.type });
    }
    res.status(200).send('ok');
  } catch (e) {
    log('webhook_error', { id: event && event.id, error: String(e) });
    res.status(500).send('error');   // transient → let Stripe retry
  }
}
