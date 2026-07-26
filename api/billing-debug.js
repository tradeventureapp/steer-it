// =============================================================================
//  GET /api/billing-debug   (auth-gated; run it as the logged-in host)
//
//  A safe self-diagnostic for the "payment ok but is_premium still false" bug.
//  It reveals which env vars are set (booleans only — never values), the SERVICE
//  key's kind + decoded role/ref (service_role vs anon vs new-secret), and whether
//  the service key can actually READ and WRITE the caller's own profiles row — so
//  we can see exactly which link is broken (wrong key/role, stale deploy, missing
//  row, or the write erroring).
//
//  SAFE: the write test sets is_premium to its CURRENT value (a no-op — it never
//  grants premium), and it only ever touches the caller's OWN id. No key values,
//  no other users' data. Remove this endpoint once billing is confirmed working.
// =============================================================================
import { SUPA_URL, SERVICE_ROLE, STRIPE_SK, WEBHOOK_SECRET, serviceKeyInfo, verifyUser, originAllowed, log } from './_lib.js';

export default async function handler(req, res) {
  if (!originAllowed(req)) { res.status(403).json({ error: 'forbidden' }); return; }
  const user = await verifyUser(req);
  if (!user) { res.status(401).json({ error: 'login required' }); return; }

  const out = {
    env: {
      SUPABASE_URL: !!SUPA_URL(),
      SUPABASE_SERVICE_ROLE_KEY: !!SERVICE_ROLE(),
      STRIPE_SECRET_KEY: !!STRIPE_SK(),
      STRIPE_WEBHOOK_SECRET: !!WEBHOOK_SECRET(),
    },
    serviceKey: serviceKeyInfo(),   // { kind, role, ref } — the crucial check
    userId: user.id,
  };

  const base = SUPA_URL(); const key = SERVICE_ROLE();
  if (base && key) {
    const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    // READ the caller's row with the SERVICE key. A real service_role bypasses RLS
    // and returns the row; anon/wrong key returns [] or 401.
    let current = false;
    try {
      const gr = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,is_premium`, { headers: H });
      const gt = await gr.text();
      out.read = { status: gr.status, body: gt.slice(0, 300) };
      try { const a = JSON.parse(gt); out.read.rowFound = Array.isArray(a) && a.length > 0; if (a[0]) current = a[0].is_premium === true; } catch { /* ignore */ }
    } catch (e) { out.read = { error: String(e) }; }
    // NO-OP WRITE TEST: PATCH is_premium to its CURRENT value → proves write auth
    // WITHOUT granting anything. A working service key returns the row (rows:1).
    try {
      const pr = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ is_premium: current }),
      });
      const pt = await pr.text();
      let rows = null; try { const a = JSON.parse(pt); rows = Array.isArray(a) ? a.length : null; } catch { /* ignore */ }
      out.writeTest = { status: pr.status, rows, noGrant: true, body: rows ? undefined : pt.slice(0, 300) };
    } catch (e) { out.writeTest = { error: String(e) }; }
  }

  log('billing_debug', { user: user.id, keyKind: out.serviceKey.kind, role: out.serviceKey.role, readStatus: out.read?.status, writeStatus: out.writeTest?.status, writeRows: out.writeTest?.rows });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
