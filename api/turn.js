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
//  Layered. Every layer FAILS SOFT for a real player: a rejection returns no
//  creds, and `fetchTurnServers` (src/rtc.ts) maps ANY non-ok response to null →
//  the phone pairs STUN-only. TURN being refused never blocks a join.
//   1. SESSION CODE (?s=) — a HARD GATE. Missing / empty / malformed → 403, no
//      credentials. (Was previously computed but only logged, so the endpoint
//      handed working relay creds to any unauthenticated caller — the whitehat
//      finding this gate closes.) A real phone ALWAYS sends one: startRtc()
//      returns early without a code (src/phone.ts), so gating cannot break it.
//   2. SHORT TTL (TTL_SECONDS) — a harvested credential dies fast.
//   3. Best-effort rate limits — per IP, PER CODE, and a per-instance circuit
//      breaker (in-memory, per warm instance; see the honest caveat below).
//   4. Origin / Referer — block an explicit FOREIGN origin, but ALLOW a missing
//      one (a same-origin GET fetch sends no Origin, and privacy modes strip
//      Referer — blocking on absence would break real players).
//
//  ⚠️ HONEST LIMITS — what this does NOT stop:
//   • The code gate is a FORMAT check, not a liveness check. There is no server-
//     side room registry (codes are generated in the browser and never leave the
//     client), so the server cannot prove a room is LIVE — an attacker can still
//     invent a well-formed code. Closing that needs a `sessions` table the host
//     writes on start + a lookup here (~1-2 days). Until then the gate raises
//     effort and makes abuse obvious: invented codes never match a real room in
//     the logs.
//   • The rate limits are per WARM INSTANCE (this Map is not shared). Vercel runs
//     many instances and cold-starts often, so the true global ceiling is higher
//     than the numbers below. A real distributed limiter needs a shared store
//     (Upstash / Vercel KV) — deliberately NOT added here (new infra).
//   • Origin/Referer are client-set and therefore spoofable; they only stop lazy
//     cross-origin use, never a determined caller.
//   • ⚠️ Cloudflare exposes NO per-key hard usage/spend cap for Realtime TURN
//     (only per-allocation rate limits), so there is no platform backstop to fall
//     back on: THIS endpoint is the real control. Kill switch = rotate
//     CF_TURN_KEY_ID / CF_TURN_API_TOKEN (unset ⇒ 503 ⇒ STUN-only, nothing breaks).
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
// ABCDEFGHJKLMNPQRSTUVWXYZ23456789 — no I/O/0/1). This is now a HARD GATE: no
// well-formed code ⇒ no credentials.
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;

// TTL of an issued credential, in seconds. 600 = 10 min.
//  - The docs example is 86400 (24 h) — far too long; a harvested cred would relay
//    for a day.
//  - 1800 (30 min) was the previous value, chosen to cover one continuous sitting.
//    Lowered to 600 because a HARVESTED credential is only as valuable as the time
//    it keeps relaying, and 30 min of free relay per harvest is the whole cost risk.
//  A legitimate longer sitting is unaffected: the phone re-fetches on every
//  reconnect (onDead → startRtc, src/phone.ts), so a session that outlives the TTL
//  simply re-pairs transparently — the behaviour the file already relied on.
const TTL_SECONDS = 600;

// ---- best-effort rate limits (in-memory, per warm instance) ------------------
// HONEST CAVEAT: Vercel runs many instances and cold-starts often, so these Maps
// are NOT shared globally — they only catch a loop hammering the SAME warm
// instance. Speed bumps, not walls; a real distributed limiter needs a shared
// store (Upstash / Vercel KV), deliberately not added here.
//
// Three axes, so evading one requires evading the others too: rotating IPs still
// hits the per-CODE limit, rotating codes still hits the per-IP limit, and the
// per-instance breaker bounds the worst case regardless.
const RL_WINDOW_MS = 60_000;   // 1-minute sliding window
// Per IP. Lowered 60 → 30. Still generous: a legit player needs ~1 on join + ~1 per
// reconnect, but CGNAT (and a whole classroom on one school WiFi — the target use
// case) stacks many real players behind ONE IP, so this keeps real headroom.
const RL_MAX_IP = 30;
// Per ROOM CODE. A room holds ≤ PLAYER_CAP (8) phones; 24/min = every player
// re-pairing three times a minute. Far past normal, but caps a harvester that
// hammers one code.
const RL_MAX_CODE = 24;
// Per-instance circuit breaker. Well above realistic legit load for a single warm
// instance; bounds the damage if one instance is milked. Tripping it is SAFE —
// callers fall back to STUN-only, which pairs fine for most NATs.
const RL_MAX_GLOBAL = 600;

const _byIp = new Map();       // ip   -> number[] recent timestamps
const _byCode = new Map();     // code -> number[] recent timestamps
let _global = [];              // all issuances on this instance

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function prune(arr, cutoff) {
  while (arr.length && arr[0] < cutoff) arr.shift();
  return arr;
}

// Read-only check — does NOT record. All axes are tested BEFORE any is recorded, so
// a request blocked on one axis never inflates the counters of the others (and a
// blocked caller can't extend its own window by being blocked).
function over(map, key, now, max) {
  const arr = map.get(key);
  return !!arr && prune(arr, now - RL_WINDOW_MS).length >= max;
}

function record(map, key, now) {
  let arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  prune(arr, now - RL_WINDOW_MS).push(now);
  // Bound memory: drop entries whose window has fully expired (cheaper + less
  // destructive than clearing the whole map, which used to reset every limiter).
  if (map.size > 5000) {
    const cutoff = now - RL_WINDOW_MS;
    for (const [k, v] of map) if (!prune(v, cutoff).length) map.delete(k);
  }
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

  // ---- SESSION CODE: the HARD GATE. Missing / empty / malformed ⇒ no creds. ----
  // Normalised to upper case first, so a lower-case code in a hand-typed link still
  // works (the phone already uppercases it; the QR carries the canonical form).
  let code = '';
  try {
    const u = new URL(req.url, 'http://x');
    code = (u.searchParams.get('s') || '').toUpperCase();
  } catch { /* ignore — falls through to the gate below */ }
  if (!CODE_RE.test(code)) {
    // GENERIC error, identical to the origin/referer rejection: never reveal WHICH
    // check failed or what a valid code looks like. `codePresent` is logged (not
    // returned) so harvesting attempts stay visible without leaking to the caller.
    log('turn_reject', { reason: 'code', ip, codePresent: !!code, len: code.length });
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  // ---- rate limits: per IP, per CODE, and the per-instance breaker ----
  // Checked before any is recorded (see `over`), so one axis can't inflate another.
  const now = Date.now();
  const limit =
    over(_byIp, ip, now, RL_MAX_IP) ? 'ip'
      : over(_byCode, code, now, RL_MAX_CODE) ? 'code'
        : prune(_global, now - RL_WINDOW_MS).length >= RL_MAX_GLOBAL ? 'global'
          : null;
  if (limit) {
    log('turn_reject', { reason: 'ratelimit', axis: limit, ip, code });
    res.setHeader('Retry-After', '30');
    res.status(429).json({ error: 'rate limited' });
    return;
  }

  // Record the ATTEMPT (not just a success) on all three axes: every attempt past
  // this point costs a Cloudflare API call, so attempts are what must be bounded —
  // otherwise a caller forcing upstream errors would never be limited.
  record(_byIp, ip, now);
  record(_byCode, code, now);
  prune(_global, now - RL_WINDOW_MS).push(now);

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
    // `code` is always a valid-format code here (the gate above guarantees it), so a
    // single IP issuing across MANY distinct codes is the signal to watch for.
    log('turn_issue', { ip, code, ttl: TTL_SECONDS });
    // Cloudflare returns { iceServers: { urls: [...], username, credential } }.
    res.status(200).json({ iceServers: data.iceServers ?? null });
  } catch {
    log('turn_reject', { reason: 'error', ip });
    res.status(502).json({ error: 'turn error' });
  }
}
