// =============================================================================
//  Vercel serverless function: the PUBLIC leaderboard page, SERVER-RENDERED.
//
//  Rewritten to /leaderboard (vercel.json). Renders the best Time Attack lap
//  times as real HTML — so search engines (and a JS-off visitor) see the times,
//  not an empty shell filled in later by client JS. Read-only: it never writes,
//  and it does NOT touch the in-game leaderboard / submit / ghost / gameplay path.
//
//  PRIVACY: reads with the PUBLIC ANON key (RLS "leaderboard: public read"), and
//  SELECTS ONLY the display columns — nickname, value (lap ms), car_key, track_id,
//  updated_at. It NEVER selects or renders user_id. (The RLS technically lets the
//  anon key read user_id too; that's a pre-existing condition tracked as a
//  follow-up in CLAUDE.md — this page simply doesn't expose it.)
//
//  Browse by track/car with a plain GET <form> (no JS needed → crawlable). The
//  bare /leaderboard is the indexable page (default combo below, self-canonical);
//  ?track=&car= variants canonical back to it + noindex, so we don't bloat the
//  index with thin per-combo pages.
// =============================================================================
import { SUPA_URL, SUPA_ANON } from './_lib.js';

// The Time-Attack tracks (map ids → display names) and the cars (car_key → name).
// Mirrors the in-game LB lists (maps.ts registry + desktop.ts LB_CAR_DISPLAY). Add a
// track/car here when the game adds one that can run Time Attack.
const TRACKS = {
  circuit:    'Circuit',
  circuit2:   'Circuit II',
  asphalt:    'Asphalt Oval',
  flat:       'Flat Track',
  rallycross: 'Rallycross',
};
const CARS = {
  scrappy: 'Scrappy GT',
  volt:    'Volt R',
  steerex: 'Stee-Rex',
  blitz:   'Blitz RS',
  fury:    'Fury 200 EVO',
  voltsim: 'Volt R (Sim)',
};
const DEFAULT_TRACK = 'circuit';   // most-played track
const DEFAULT_CAR    = 'scrappy';  // the default car new players start on
const TOP_N = 25;
const CANONICAL = 'https://steerit.app/leaderboard';
const OG_IMAGE  = 'https://steerit.app/og-image.jpg';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Lap ms → m:ss.mmm (matches formatLapTime in time-attack.ts).
function fmtLap(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), mm = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(mm).padStart(3, '0')}`;
}

async function fetchRows(track, car) {
  const base = SUPA_URL(), key = SUPA_ANON();
  if (!base || !key) return null;   // env not configured → fail soft (render the shell)
  const q = new URLSearchParams({
    mode: 'eq.timeattack', track_id: `eq.${track}`, car_key: `eq.${car}`, surface: 'eq.',
    select: 'nickname,value,car_key,track_id,updated_at',
    order: 'value.asc,updated_at.asc', limit: String(TOP_N),
  });
  try {
    const r = await fetch(`${base}/rest/v1/leaderboard?${q}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch { return null; }
}

// Pure render (unit-testable in Node): (track, car, rows, isDefault) -> full HTML page.
export function renderPage(track, car, rows, isDefault) {
  const trackName = TRACKS[track], carName = CARS[car];
  const title = isDefault
    ? 'Steer It Leaderboard — Best Time Attack Lap Times'
    : `${trackName} · ${carName} — Steer It Leaderboard`;
  const desc = `The fastest Time Attack lap times in Steer It — ${trackName} in the ${carName}. `
    + `A public, self-updating leaderboard. Beat a time and your name is on it. Free to play in your browser.`;
  const trackOpts = Object.entries(TRACKS).map(([id, n]) =>
    `<option value="${id}"${id === track ? ' selected' : ''}>${esc(n)}</option>`).join('');
  const carOpts = Object.entries(CARS).map(([k, n]) =>
    `<option value="${k}"${k === car ? ' selected' : ''}>${esc(n)}</option>`).join('');

  let tableBody;
  if (rows == null) {
    tableBody = `<tr><td colspan="4" class="lb-empty">The leaderboard is taking a breather — try again in a moment.</td></tr>`;
  } else if (rows.length === 0) {
    tableBody = `<tr><td colspan="4" class="lb-empty">No times here yet — be the first to set one.</td></tr>`;
  } else {
    tableBody = rows.map((row, i) => {
      const nick = esc(row.nickname || 'Player');
      return `<tr>
            <td class="lb-rank">${i + 1}</td>
            <td class="lb-nick">${nick}</td>
            <td class="lb-time">${fmtLap(row.value)}</td>
            <td class="lb-car">${esc(CARS[row.car_key] || row.car_key)}</td>
          </tr>`;
    }).join('\n');
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${CANONICAL}" />
  <meta name="robots" content="${isDefault ? 'index, follow, max-image-preview:large' : 'noindex, follow'}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Steer It" />
  <meta property="og:url" content="${CANONICAL}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${OG_IMAGE}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${OG_IMAGE}" />
  <link rel="stylesheet" href="/legal.css" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="theme-color" content="#0a0518" />
  <style>
    .mk-lead { font-size: 18px; color: var(--text-dim); margin: 6px 0 22px; }
    .mk-cta { display: inline-flex; align-items: center; gap: 8px; margin: 4px 8px 4px 0;
      font-family: var(--font-display); font-weight: 700; letter-spacing: 0.04em; font-size: 15px;
      text-decoration: none; padding: 12px 22px; border-radius: 999px; color: #17080f;
      background: linear-gradient(100deg, #ff8a3d 0%, #ff2d8f 55%, #7a1fff 120%);
      box-shadow: 0 6px 20px rgba(255, 45, 143, 0.28); }
    .mk-cta.ghost { color: var(--text-dim); background: none; border: 1px solid var(--border); box-shadow: none; }
    .mk-cta:hover { filter: brightness(1.06); }
    .mk-cta.ghost:hover { color: var(--gold); border-color: var(--gold); }
    .mk-ctarow { margin: 24px 0 8px; }
    .lb-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin: 18px 0 10px; }
    .lb-field { display: flex; flex-direction: column; gap: 5px; }
    .lb-field span { font-family: var(--font-display); font-size: 11px; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--text-muted); }
    .lb-field select { font-family: var(--font-body); font-size: 15px; color: var(--text);
      background: rgba(14, 8, 32, 0.9); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; min-width: 160px; }
    .lb-go { font-family: var(--font-display); font-weight: 700; letter-spacing: 0.04em; font-size: 13px;
      color: var(--text); background: none; border: 1px solid var(--border); border-radius: 10px; padding: 10px 16px; cursor: pointer; }
    .lb-go:hover { color: var(--gold); border-color: var(--gold); }
    .lb-caption { color: var(--text-muted); font-size: 13px; margin: 6px 0 12px; }
    .lb-caption b { color: var(--gold); font-weight: 700; }
    .lb-tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table.lb { width: 100%; border-collapse: collapse; min-width: 460px; font-size: 15px; }
    table.lb thead th { text-align: left; font-family: var(--font-display); font-weight: 700;
      font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--gold);
      padding: 10px 14px; border-bottom: 1px solid var(--border); }
    table.lb td { padding: 11px 14px; border-bottom: 1px solid var(--border-soft); color: var(--text-dim); vertical-align: middle; }
    table.lb .lb-rank { color: var(--text-muted); width: 3em; font-variant-numeric: tabular-nums; }
    table.lb .lb-nick { color: var(--text); font-weight: 600; }
    table.lb .lb-time { font-family: var(--font-display); color: var(--gold); font-variant-numeric: tabular-nums; white-space: nowrap; }
    table.lb tr:first-child .lb-time { font-size: 16px; }
    .lb-empty { color: var(--text-muted); text-align: center; padding: 26px 14px; }
    .mk-foot { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border-soft);
      color: var(--text-muted); font-size: 14px; }
    .mk-foot a { color: var(--text-dim); }
  </style>
</head>
<body>
  <div class="legal-wrap">
    <div class="legal-top">
      <a class="legal-home" href="/" aria-label="Steer It home">
        <img src="/logos/steer-it-logo.png" alt="Steer It" />
      </a>
      <a class="legal-back" href="/">◄ Back to game</a>
    </div>

    <h1>Steer It leaderboard</h1>
    <p class="mk-lead">The fastest laps in Steer It, live and open to anyone — no account needed to look.
      If your name is up here, you've got something to defend.</p>

    <p>Time Attack is Steer It's solo mode against the clock: you keep lapping a track and the game times
      every clean lap on the physics step, so the number is honest. Your best lap gets ranked here against
      everyone else's on the same track in the same car. Pick a track and a car below to see who's on top —
      then open the game, tilt your phone to steer, and try to knock someone off it.</p>

    <form class="lb-controls" method="get" action="/leaderboard">
      <label class="lb-field"><span>Track</span>
        <select name="track" onchange="this.form.submit()">${trackOpts}</select></label>
      <label class="lb-field"><span>Car</span>
        <select name="car" onchange="this.form.submit()">${carOpts}</select></label>
      <button type="submit" class="lb-go">Show times</button>
    </form>

    <p class="lb-caption">Best Time Attack laps · <b>${esc(trackName)}</b> · <b>${esc(carName)}</b> · top ${TOP_N}</p>

    <div class="lb-tablewrap">
      <table class="lb">
        <thead><tr><th>#</th><th>Player</th><th>Best lap</th><th>Car</th></tr></thead>
        <tbody>
          ${tableBody}
        </tbody>
      </table>
    </div>

    <div class="mk-ctarow">
      <a class="mk-cta" href="/">Play Steer It free ▸</a>
      <a class="mk-cta ghost" href="/">Steer It home</a>
    </div>

    <div class="mk-foot">
      <p>The leaderboard updates as players set new personal bests. <a href="/">Play Steer It</a> to get on it.</p>
      <p><a href="/">Home</a> ·
        <a href="/party-games-phone-controller">How phone-controller party games work</a> ·
        <a href="/party-games-at-work-and-school">Party games for work &amp; school</a> ·
        <a href="/airconsole-alternative">Steer It vs AirConsole</a></p>
    </div>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).send('method not allowed'); return; }
  const q = req.query || {};
  const track = TRACKS[q.track] ? q.track : DEFAULT_TRACK;
  const car   = CARS[q.car] ? q.car : DEFAULT_CAR;
  const isDefault = track === DEFAULT_TRACK && car === DEFAULT_CAR;
  const rows = await fetchRows(track, car);
  const html = renderPage(track, car, rows, isDefault);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // CDN-cache briefly so it's fast + cheap but never more than ~a minute stale (self-updating).
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.status(200).send(html);
}
