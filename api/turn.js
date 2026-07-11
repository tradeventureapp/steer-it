// =============================================================================
//  Vercel serverless function: short-lived TURN credentials (WebRTC Step 3).
//
//  The phone fetches GET /api/turn at pairing time and receives Cloudflare TURN
//  iceServers with a 600 s TTL — NO static TURN secret ever ships in client
//  code. The Cloudflare key id + API token live in Vercel env vars:
//    CF_TURN_KEY_ID, CF_TURN_API_TOKEN
//  If they are not set (or Cloudflare errors), this returns an error status and
//  the phone silently proceeds STUN-only (today's V1 behavior) — TURN being
//  down NEVER blocks pairing.
//
//  Plain JS, deliberately OUTSIDE the Vite/tsc build (tsconfig includes src/
//  only) — Vercel picks up /api automatically.
// =============================================================================

const ALLOWED_ORIGINS = [
  'https://steerit.app',
  'https://steer-it.vercel.app',
];

export default async function handler(req, res) {
  // Light abuse guard: same-origin GETs usually omit Origin; reject only an
  // explicit FOREIGN origin. (Real caps belong on the Cloudflare key itself.)
  const origin = req.headers.origin || '';
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_API_TOKEN;
  if (!keyId || !token) {
    // Not configured yet — the phone falls back to STUN-only.
    res.status(503).json({ error: 'turn not configured' });
    return;
  }

  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 600 }),   // 10 min — one pairing's worth
      },
    );
    if (!r.ok) {
      res.status(502).json({ error: `turn upstream ${r.status}` });
      return;
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    // Cloudflare returns { iceServers: { urls: [...], username, credential } }.
    res.status(200).json({ iceServers: data.iceServers ?? null });
  } catch {
    res.status(502).json({ error: 'turn error' });
  }
}
