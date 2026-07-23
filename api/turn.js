// =============================================================================
//  Vercel serverless function: short-lived Cloudflare TURN credentials.
//
//  The phone fetches GET /api/turn?s=<ROOMCODE> at pairing time and receives
//  Cloudflare TURN iceServers. NO static TURN secret ships in client code — the
//  Cloudflare key id + API token live in Vercel env (CF_TURN_KEY_ID,
//  CF_TURN_API_TOKEN). Unset / Cloudflare error → an error status and the phone
//  proceeds STUN-only; TURN being down NEVER blocks pairing.
//
//  ---- HARDENING (the creds cost money once relayed — $0.05/GB) --------------
//  Layered, and every layer is designed to NEVER reject a legitimate player:
//   1. SHORT TTL (TTL_SECONDS) — a harvested credential dies fast.
//   2. Best-effort per-IP rate limit — a speed bump against a tight harvest loop
//      (in-memory, per warm instance; see the honest caveat below). Headroom is
//      set HIGH because carrier-grade NAT puts many real mobile players behind
//      ONE IP, and mobile reconnects legitimately re-fetch.
//   3. Origin / Referer — block an explicit FOREIGN origin, but ALLOW a missing
//      one (a same-origin GET fetch sends no Origin, and privacy modes strip
//      Referer — blocking on absence would break real players).
//   4. Room code (?s=) — logged for monitoring and format-checked. It is NOT a
//      hard gate: the codes are generated client-side and never stored server-
//      side, so the server CANNOT prove a room is live (that needs a room
//      registry — see the report). A missing/odd code is still served (so an
//      old cached phone build never breaks) but logged, so a single IP pulling
//      creds for many random codes stands out as abuse.
//
//  ⚠️ The in-memory rate limit and the code check are SPEED BUMPS, not walls.
//  The guaranteed bill ceiling is a USAGE CAP on the Cloudflare TURN key itself
//  (set it in the Cloudflare dashboard) + the short TTL. Everything here just
//  raises the effort and makes abuse visible in the logs.
//
//  Plain JS, deliberately OUTSIDE the Vite/tsc build (tsconfig includes src/
//  only) — Vercel picks up /api automatically.
// =============================================================================

const ALLOWED_ORIGINS = [
  'https://steerit.app',
  'https://steer-it.vercel.app',
];
// Hosts we accept in a Referer (same set, host-only — a Referer carries a path).
const ALLOWED_HOSTS = ['steerit.app', 'steer-it.vercel.app'];

// The exact room-code shape the app generates (4 chars, confusable-free alphabet
// ABCDEFGHJKLMNPQRSTUVWXYZ23456789). Used for logging/format only, never as a gate.
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;

// TTL of an issued credential, in seconds. 1800 = 30 min.
//  - The docs example is 86400 (24 h) — far too long; a harvested cred would relay
//    for a day.
//  - The old value was 600 (10 min) — a continuous relay session longer than that
//    would drop when the TURN allocation can't refresh, forcing a mid-game re-pair.
//  30 min comfortably covers a single continuous relay session in one party-game
//  sitting, yet a harvested credential expires within half an hour. Longer sittings
//  are fine too: the phone re-fetches on every reconnect (onDead → startRtc), so a
//  session that outlives the TTL simply re-pairs transparently.
const TTL_SECONDS = 1800;

// ---- best-effort per-IP rate limit (in-memory, per warm instance) ------------
// HONEST CAVEAT: Vercel runs many instances and cold-starts often, so this Map is
// NOT shared globally — it only catches a tight loop hammering the SAME warm
// instance. It is a speed bump; a real distributed limiter needs a shared store
// (Upstash / Vercel KV). Kept because it is zero-infra and free, and the real
// ceiling is the Cloudflare usage cap + the short TTL.
const RL_WINDOW_MS = 60_000;   // 1-minute sliding window
const RL_MAX = 60;             // ≤60 issues / IP / minute / instance — generous:
                               // a legit player needs ~1 on join + ~1 per reconnect,
                               // and CGNAT stacks many real players on one IP.
const _hits = new Map();       // ip -> number[] recent timestamps

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimited(ip, now) {
  let arr = _hits.get(ip);
  if (!arr) { arr = []; _hits.set(ip, arr); }
  const cutoff = now - RL_WINDOW_MS;
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= RL_MAX) return true;
  arr.push(now);
  if (_hits.size > 5000) _hits.clear();   // bound memory (best-effort anyway)
  return false;
}

function foreignHost(referer) {
  if (!referer) return false;             // absent → allow (privacy modes strip it)
  try { return !ALLOWED_HOSTS.includes(new URL(referer).host); }
  catch { return false; }                 // unparseable → don't block a real player
}

// One structured log line per outcome → filter the Vercel function logs by `evt`.
function log(evt, fields) {
  const line = JSON.stringify({ evt, ts: new Date().toISOString(), ...fields });
  if (evt === 'turn_issue') console.log(line); else console.warn(line);
}

export default async function handler(req, res) {
  const ip = clientIp(req);

  // Only GET — nothing else should ever hit this.
  if (req.method && req.method !== 'GET') {
    log('turn_reject', { reason: 'method', ip, method: req.method });
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  // Origin: block an explicit FOREIGN origin; allow a missing one (same-origin
  // GET fetch sends none). Referer: same idea, host-only, absent = allowed.
  const origin = req.headers.origin || '';
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    log('turn_reject', { reason: 'origin', ip, origin });
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (foreignHost(req.headers.referer || req.headers.referrer)) {
    log('turn_reject', { reason: 'referer', ip, referer: req.headers.referer });
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  // Room code — for MONITORING + format, not a gate (see header). Normalised;
  // flagged in the log when absent/odd so cred-harvesting for random codes shows.
  let code = '';
  try {
    const u = new URL(req.url, 'http://x');
    code = (u.searchParams.get('s') || '').toUpperCase();
  } catch { /* ignore */ }
  const codeOk = CODE_RE.test(code);

  const now = Date.now();
  if (rateLimited(ip, now)) {
    log('turn_reject', { reason: 'ratelimit', ip, code: code || null });
    res.setHeader('Retry-After', '30');
    res.status(429).json({ error: 'rate limited' });
    return;
  }

  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_API_TOKEN;
  if (!keyId || !token) {
    // Not configured — the phone falls back to STUN-only.
    log('turn_reject', { reason: 'unconfigured', ip });
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
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );
    if (!r.ok) {
      log('turn_reject', { reason: 'upstream', ip, status: r.status });
      res.status(502).json({ error: `turn upstream ${r.status}` });
      return;
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    // One line per successful issuance: count these + group by ip/code to spot abuse.
    log('turn_issue', { ip, code: codeOk ? code : null, codePresent: !!code, ttl: TTL_SECONDS });
    // Cloudflare returns { iceServers: { urls: [...], username, credential } }.
    res.status(200).json({ iceServers: data.iceServers ?? null });
  } catch {
    log('turn_reject', { reason: 'error', ip });
    res.status(502).json({ error: 'turn error' });
  }
}
