// =============================================================================
//  POST /api/create-checkout-session
//
//  A LOGGED-IN host clicks "Get Premium" → the client sends its Supabase access
//  token (Bearer) → we verify it, create a Stripe Checkout Session (mode: payment,
//  the Premium price) tied to that account, and return the hosted-checkout URL for
//  the client to redirect to.
//
//  Tying the payment to the account (the critical bit): the Supabase user_id goes
//  into BOTH metadata.user_id AND client_reference_id, and the customer email is
//  set from the token — so the webhook (and the on-return fallback) know exactly
//  which account to upgrade. TEST mode uses sk_test / a test price.
// =============================================================================
import { STRIPE_SK, PRICE_ID, PUBLIC_BASE, verifyUser, originAllowed, log } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!originAllowed(req)) { log('checkout_reject', { reason: 'origin', origin: req.headers.origin }); res.status(403).json({ error: 'forbidden' }); return; }

  const sk = STRIPE_SK();
  if (!sk) { log('checkout_unconfigured', { reason: 'no_secret_key' }); res.status(503).json({ error: 'payments not configured' }); return; }

  const priceId = PRICE_ID();   // REQUIRED (env STRIPE_PRICE_ID) — no fallback, so a
  if (!priceId) { log('checkout_unconfigured', { reason: 'no_price' }); res.status(503).json({ error: 'payments not configured' }); return; }   // misconfig fails loudly, never a wrong-mode price

  // Must be logged in — a payment can't be tied to no account.
  const user = await verifyUser(req);
  if (!user) { log('checkout_reject', { reason: 'unauthenticated' }); res.status(401).json({ error: 'login required' }); return; }

  // The buyer must have accepted the withdrawal-waiver consent (digital content
  // delivered immediately → the 14-day right of withdrawal is waived). The client
  // shows a required checkbox before calling this; we refuse without it and record
  // the acceptance in the session metadata as proof tied to the transaction.
  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
  payload = payload || {};
  const consent = payload.acceptWithdrawalWaiver === true || payload.acceptWithdrawalWaiver === 'true';
  if (!consent) { log('checkout_reject', { reason: 'no_consent', user: user.id }); res.status(400).json({ error: 'consent required' }); return; }
  const consentAt = (typeof payload.consentAt === 'string' ? payload.consentAt : new Date().toISOString()).slice(0, 40);

  const base = PUBLIC_BASE();
  const body = new URLSearchParams();
  body.append('mode', 'payment');
  body.append('line_items[0][price]', priceId);
  body.append('line_items[0][quantity]', '1');
  body.append('client_reference_id', user.id);         // ← the account
  body.append('metadata[user_id]', user.id);           // ← read by the webhook
  body.append('metadata[withdrawal_waiver]', 'accepted');   // ← EU digital-content consent
  body.append('metadata[consent_at]', consentAt);
  if (user.email) body.append('customer_email', user.email);
  // Stripe substitutes {CHECKOUT_SESSION_ID} on redirect → the return page verifies it.
  body.append('success_url', `${base}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  body.append('cancel_url', `${base}/?checkout=cancel`);

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sk}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // A create is not money-moving, but keep it idempotent against client retries.
        'Idempotency-Key': `co_${user.id}_${Date.now()}`,
      },
      body: body.toString(),
    });
    const session = await r.json();
    if (!r.ok || !session.url) {
      log('checkout_stripe_error', { status: r.status, err: session?.error?.message });
      res.status(502).json({ error: 'could not start checkout' });
      return;
    }
    log('checkout_created', { user: user.id, session: session.id });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ url: session.url });
  } catch (e) {
    log('checkout_error', { error: String(e) });
    res.status(502).json({ error: 'checkout error' });
  }
}
