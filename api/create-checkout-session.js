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
  if (!sk) { log('checkout_unconfigured', {}); res.status(503).json({ error: 'payments not configured' }); return; }

  // Must be logged in — a payment can't be tied to no account.
  const user = await verifyUser(req);
  if (!user) { log('checkout_reject', { reason: 'unauthenticated' }); res.status(401).json({ error: 'login required' }); return; }

  const base = PUBLIC_BASE();
  const body = new URLSearchParams();
  body.append('mode', 'payment');
  body.append('line_items[0][price]', PRICE_ID());
  body.append('line_items[0][quantity]', '1');
  body.append('client_reference_id', user.id);         // ← the account
  body.append('metadata[user_id]', user.id);           // ← read by the webhook
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
