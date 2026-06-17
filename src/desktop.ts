import QRCode from 'qrcode';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { channelName, createResilientChannel } from './supabase';
import {
  CONFIG, makeCar, step, bodyToWorld, collideWithRects,
  type CarState, type Inputs,
} from './physics';
import { collideCars, applyInputs } from './cars';
import {
  getMap, listMaps, DEFAULT_MAP_ID,
  type MapDefinition, type MapWorld, type MapObstacle,
} from './maps';
import { SoundEngine } from './sound';
import { Effects } from './effects';
import {
  PLAYER_CAP, LOBBY_SYNC_MS, RESILIENCE, EV, colorName, LobbyState,
} from './lobby';
import {
  RaceManager, RACE_CONFIG, formatRaceTime,
  placeElement, removeElementAt, clearElements, findElementIndexAt,
  countCheckpoints, isCircuitTrack,
  type RaceElement, type RaceHud, type RaceType,
} from './race';
import {
  XP_CONFIG, makeXpRun, updateXpRun, formatXp,
  type XpRunState,
} from './xp';
import { inject } from '@vercel/analytics';

// Vercel Web Analytics — framework-agnostic vanilla init (NOT the React
// <Analytics/> component). Injects the tracking script for the desktop/host
// page (index.html). Safe no-op in local/dev where the endpoint isn't present.
inject();

// ---------- Session ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = Array.from(
  { length: 4 },
  () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
).join('');
// Build the phone URL from a FIXED production base so the QR always points at
// the stable public domain — never the Vercel deployment URL the desktop page
// happened to be opened from (those are auth-walled per-deploy). Falls back to
// the current origin for local dev when the env var isn't set.
const publicBase = (
  import.meta.env.VITE_PUBLIC_BASE_URL || window.location.origin
).replace(/\/+$/, '');
const playUrl = `${publicBase}/play?s=${code}`;

const qrCanvas = document.getElementById('qr') as HTMLCanvasElement;
const codeText = document.getElementById('code-text') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const rosterEl = document.getElementById('lobby-roster') as HTMLDivElement | null;
const raceHudEl       = document.getElementById('race-hud')         as HTMLElement | null;
const raceTimerEl     = document.getElementById('race-timer')       as HTMLDivElement | null;
const raceCpEl        = document.getElementById('race-cp')          as HTMLSpanElement | null;
const raceLapEl       = document.getElementById('race-lap')         as HTMLSpanElement | null;
const raceFinishEl    = document.getElementById('race-finish')      as HTMLElement | null;
const finishFeedEl    = document.getElementById('finish-feed')      as HTMLElement | null;
const raceResultsEl   = document.getElementById('race-results')     as HTMLElement | null;
const resultsRestEl   = document.getElementById('results-rest')     as HTMLElement | null;
const xpHudEl       = document.getElementById('xp-hud')        as HTMLElement | null;
const xpScoreEl     = document.getElementById('xp-score')      as HTMLDivElement | null;
const xpMultEl      = document.getElementById('xp-mult')       as HTMLDivElement | null;
const xpEndEl       = document.getElementById('xp-end')        as HTMLElement | null;
const xpEndRecordEl = document.getElementById('xp-end-record') as HTMLDivElement | null;
const xpEndLabelEl  = document.getElementById('xp-end-label')  as HTMLDivElement | null;
const xpEndScoreEl  = document.getElementById('xp-end-score')  as HTMLDivElement | null;
const xpEndBestEl   = document.getElementById('xp-end-best')   as HTMLDivElement | null;
const speedEl = document.getElementById('speed') as HTMLDivElement;
const driftEl = document.getElementById('drift') as HTMLDivElement;
const throttleBarEl  = document.getElementById('throttle-bar')  as HTMLDivElement;
const brakeBarEl     = document.getElementById('brake-bar')     as HTMLDivElement;
const handbrakeHudEl = document.getElementById('handbrake-hud') as HTMLDivElement;
const steerMarkerEl  = document.getElementById('steer-marker')  as HTMLDivElement | null;
const rearSlipValEl  = document.getElementById('rear-slip-val') as HTMLSpanElement | null;
const wspinValEl     = document.getElementById('wspin-val')     as HTMLSpanElement | null;
const soundBtn       = document.getElementById('sound-toggle')  as HTMLButtonElement | null;
const hudBlEl        = document.getElementById('hud-bl')         as HTMLElement | null;
const hudTrEl        = document.getElementById('hud-tr')         as HTMLElement | null;
const pauseOverlayEl = document.getElementById('pause-overlay')  as HTMLElement | null;
const editorEl       = document.getElementById('editor')         as HTMLElement | null;
const editorStatusEl = document.getElementById('editor-status')  as HTMLDivElement | null;
const editorHintEl   = document.getElementById('editor-hint')    as HTMLDivElement | null;
const mainMenuEl     = document.getElementById('main-menu')       as HTMLElement | null;
const mapSelectEl    = document.getElementById('map-select')      as HTMLElement | null;
const mapTilesEl     = document.getElementById('map-tiles')       as HTMLElement | null;

// ---------- Freeze: the main menu, pause (P), and the editor (E) each halt the
// simulation + race timer (not the render). isPaused is the combined gate. ----
let userPaused = false;  // toggled by P
let editorMode = false;  // toggled by E
let menuOpen = true;     // the host front-end (menu) shows at startup
let raceResultsOpen = false;  // the multi-car podium is up (freezes the sim)
let isPaused = false;    // = userPaused || editorMode || menuOpen || results (loop gate)
let pausedAccumMs = 0;   // total frozen time, subtracted from the game clock
let pauseStartedAt = 0;  // performance.now() when the current freeze began

function refreshFreeze() {
  const want = userPaused || editorMode || menuOpen || raceResultsOpen;
  if (want !== isPaused) {
    isPaused = want;
    if (isPaused) pauseStartedAt = performance.now();
    else pausedAccumMs += performance.now() - pauseStartedAt;  // bank frozen time
  }
  // PAUSED overlay only for a manual pause (not while editing / in a menu);
  // editor UI only while editing.
  if (pauseOverlayEl) pauseOverlayEl.hidden = !(userPaused && !editorMode && !menuOpen);
  if (editorEl) editorEl.hidden = !editorMode;
  document.body.classList.toggle('editing', editorMode);
}

// Physics-input debug overlay (toggle with D). Shows the steer/throttle as the
// PHYSICS step actually receives them (post-expo, post-smoothing) plus the
// burnout-boost gate and spin-arm state — so the real commanded values are
// visible on the screen, not guessed at. Hidden by default.
const debugEl = document.createElement('div');
debugEl.id = 'phys-debug';
debugEl.style.cssText =
  'position:fixed;left:8px;bottom:8px;z-index:9999;display:none;white-space:pre;' +
  'font:12px/1.45 ui-monospace,monospace;color:#6f6;background:rgba(0,0,0,.66);' +
  'padding:6px 9px;border-radius:5px;pointer-events:none;';
document.body.appendChild(debugEl);
let debugOn = false;

// ---------- Live BRAKE tuners (p21) — shown with the D debug HUD ----------
// Clickable +/- steppers that mutate CONFIG in memory (resets on reload) so the
// foot-brake feel can be dialled mid-drive on the PC, then baked into physics.ts.
// Starting values: brakeForce 30000, brakeGripFraction 0.85.
const brakeTunerEl = document.createElement('div');
brakeTunerEl.id = 'brake-tuner';
brakeTunerEl.style.cssText =
  'position:fixed;right:8px;bottom:8px;z-index:9999;display:none;' +
  'font:12px/1.3 ui-monospace,monospace;color:#ffd9b0;background:rgba(0,0,0,.72);' +
  'padding:8px 10px;border-radius:6px;border:1px solid rgba(255,138,61,.5);' +
  'pointer-events:auto;user-select:none;min-width:230px;';
document.body.appendChild(brakeTunerEl);
{
  const title = document.createElement('div');
  title.textContent = 'BRAKE TUNE — live (start 30000 / 0.85)';
  title.style.cssText = 'font-weight:700;letter-spacing:.5px;margin-bottom:6px;color:#ff8a3d;';
  brakeTunerEl.appendChild(title);
  const subhead = (txt: string) => {
    const d = document.createElement('div');
    d.textContent = txt;
    d.style.cssText = 'font-weight:700;letter-spacing:.5px;margin:9px 0 2px;color:#ff8a3d;';
    brakeTunerEl.appendChild(d);
  };

  const mkRow = (
    label: string, get: () => number, set: (v: number) => void,
    step: number, lo: number, hi: number, fmt: (v: number) => string,
  ) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:5px;';
    const name = document.createElement('span');
    name.textContent = label; name.style.cssText = 'flex:1;';
    const val = document.createElement('b');
    val.style.cssText = 'min-width:64px;text-align:center;color:#fff;';
    const upd = () => { val.textContent = fmt(get()); };
    const mkBtn = (txt: string, d: number) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = txt;
      b.style.cssText =
        'pointer-events:auto;cursor:pointer;font:700 13px/1 ui-monospace,monospace;' +
        'width:26px;height:24px;border-radius:5px;color:#ffd9b0;' +
        'background:rgba(255,138,61,.18);border:1px solid rgba(255,138,61,.55);';
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        set(Math.max(lo, Math.min(hi, get() + d)));
        upd();
      });
      return b;
    };
    row.append(name, mkBtn('−', -step), val, mkBtn('+', step));
    upd();
    brakeTunerEl.appendChild(row);
  };

  mkRow('brakeForce', () => CONFIG.brakeForce, (v) => { CONFIG.brakeForce = v; },
    2000, 6000, 60000, (v) => String(Math.round(v)));
  mkRow('brakeGripFraction', () => CONFIG.brakeGripFraction,
    (v) => { CONFIG.brakeGripFraction = v; },
    0.05, 0.4, 1.2, (v) => v.toFixed(2));

  // p24..p28 — SIM-branch drift knobs (only affect driftMode==='sim').
  // p28 drift-build POWER: enginePower 12500 N (>10530 reaction → willing wheelspin,
  // <16200 budget → grips straight); boostFade 40 keeps the slide alive at speed.
  subhead('SIM DRIFT — drift-build power 12500N / fade 40 (arcade=9000/14)');
  mkRow('driftFrontCarve', () => CONFIG.driftFrontCarve, (v) => { CONFIG.driftFrontCarve = v; },
    0.1, 0, 1, (v) => v.toFixed(2));
  mkRow('driftScrubRate', () => CONFIG.driftScrubRate, (v) => { CONFIG.driftScrubRate = v; },
    0.2, 0, 4, (v) => v.toFixed(2));
  mkRow('driftSimRearGrip', () => CONFIG.driftSimRearGrip, (v) => { CONFIG.driftSimRearGrip = v; },
    0.025, 0.30, 0.65, (v) => v.toFixed(3));
  mkRow('driftSimCatch', () => CONFIG.driftSimCatch, (v) => { CONFIG.driftSimCatch = v; },
    0.05, 0, 1, (v) => v.toFixed(2));
  mkRow('driftSimSpeedHold', () => CONFIG.driftSimSpeedHold, (v) => { CONFIG.driftSimSpeedHold = v; },
    0.05, 0, 1, (v) => v.toFixed(2));
  mkRow('driftSimEnginePower', () => CONFIG.driftSimEnginePower, (v) => { CONFIG.driftSimEnginePower = v; },
    500, 9000, 18000, (v) => String(Math.round(v)));
  mkRow('driftSimBoostFadeSpeed', () => CONFIG.driftSimBoostFadeSpeed, (v) => { CONFIG.driftSimBoostFadeSpeed = v; },
    2, 14, 60, (v) => v.toFixed(0));

  // p23 — DRIFT MODEL dev toggle (arcade ⇄ sim). 'sim' is the new front-carve model
  // (WORK IN PROGRESS — currently mirrors arcade). Dev-only; no player menu yet.
  {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:9px;';
    const name = document.createElement('span');
    name.textContent = 'driftMode'; name.style.cssText = 'flex:1;font-weight:700;color:#ff8a3d;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText =
      'pointer-events:auto;cursor:pointer;font:700 12px/1 ui-monospace,monospace;' +
      'padding:5px 12px;border-radius:5px;color:#ffd9b0;' +
      'background:rgba(255,138,61,.18);border:1px solid rgba(255,138,61,.55);';
    const upd = () => { btn.textContent = CONFIG.driftMode === 'sim' ? 'SIM (wip)' : 'ARCADE'; };
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      CONFIG.driftMode = CONFIG.driftMode === 'sim' ? 'arcade' : 'sim';
      upd();
    });
    upd();
    row.append(name, btn);
    brakeTunerEl.appendChild(row);
  }
}

// ---------- Sound + visual effects ----------
const sound = new SoundEngine();
const fx = new Effects();

function updateSoundButton() {
  if (!soundBtn) return;
  soundBtn.textContent = sound.enabled && !sound.muted ? '🔊' : '🔇';
  soundBtn.classList.toggle('off', !sound.enabled || sound.muted);
  soundBtn.title = sound.enabled
    ? 'Sound on/off (M)'
    : 'Tap for sound (M)';
}
sound.onChange = updateSoundButton;
updateSoundButton();

// Sound is OFF BY DEFAULT — only the visible toggle (or the M key)
// enables it. No auto-enable on random clicks.
soundBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  sound.toggleMute();
});
// QR join panel is visible by default; Q toggles it. The gameplay HUD
// (speedo / SLIP / WSPIN / pedal bars / phys-debug) is HIDDEN by default and
// revealed by D — so by default the screen is just the game world + QR.
let qrOn = true;
// The QR/join panel shows only once a map is loaded (menu dismissed) and qrOn.
function updateQrVisibility() {
  if (hudTrEl) hudTrEl.style.display = (qrOn && !menuOpen) ? 'block' : 'none';
}
window.addEventListener('keydown', (e) => {
  if (menuOpen) return;   // game keys are inert while the host menu is open
  if (e.key === 'm' || e.key === 'M') sound.toggleMute();
  if (e.key === 'd' || e.key === 'D') {
    debugOn = !debugOn;
    debugEl.style.display = debugOn ? 'block' : 'none';
    brakeTunerEl.style.display = debugOn ? 'block' : 'none';
    if (hudBlEl) hudBlEl.style.display = debugOn ? 'flex' : 'none';
  }
  if (e.key === 'q' || e.key === 'Q') {
    qrOn = !qrOn;
    updateQrVisibility();
  }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
    if (e.key === 'Escape') e.preventDefault();   // just toggle the menu, nothing else
    if (!editorMode) { userPaused = !userPaused; refreshFreeze(); }  // no-op in the editor
  }
  if (e.key === 'e' || e.key === 'E') {
    editorMode = !editorMode;
    if (!editorMode) rebuildRace();   // exiting → apply the built track (fresh race)
    else editorDragIdx = null;        // entering → no stale drag
    refreshFreeze();
    updateEditorStatus();
  }
});

codeText.textContent = code;
QRCode.toCanvas(qrCanvas, playUrl, { width: 160, margin: 1 }).catch(console.error);

// ================= HOST FRONT-END: main menu → map select =================
// The desktop (host) picks the map for everyone. Phones are controllers only.
// At startup the menu holds the game frozen (no QR yet); choosing a map calls
// switchMap(id) — which respawns connected cars — and drops into gameplay.
function openMainMenu() {
  menuOpen = true;
  if (mainMenuEl) mainMenuEl.hidden = false;
  if (mapSelectEl) mapSelectEl.hidden = true;
  refreshFreeze();
  updateQrVisibility();
}
function openMapSelect() {
  if (mainMenuEl) mainMenuEl.hidden = true;
  if (mapSelectEl) mapSelectEl.hidden = false;
  buildMapTiles();
}
function closeMenusIntoGame() {
  menuOpen = false;
  if (mainMenuEl) mainMenuEl.hidden = true;
  if (mapSelectEl) mapSelectEl.hidden = true;
  refreshFreeze();
  updateQrVisibility();   // QR/join panel appears now a map is live
}
function chooseMap(id: string) {
  goFullscreen();         // gameplay starts — fill the host screen (gesture)
  switchMap(id);          // load the map + respawn any connected cars
  closeMenusIntoGame();
}

// Fullscreen on the HOST PC only (phones never call this). MUST run inside a
// user gesture (the START RACE / map-tile click) — browsers reject auto-
// fullscreen. Standard Fullscreen API with the webkit fallback for Safari/macOS.
// We only request; we NEVER auto re-request, so a manual Esc-exit is not fought
// (the next START RACE click may request again, which is fine). Any rejection
// (denied / unsupported / older browser) is swallowed — gameplay continues.
function goFullscreen() {
  // Already fullscreen → don't re-fire (covers START RACE then tile click).
  if (document.fullscreenElement ||
      (document as { webkitFullscreenElement?: Element }).webkitFullscreenElement) {
    return;
  }
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  try {
    const req = el.requestFullscreen
      ? el.requestFullscreen()
      : el.webkitRequestFullscreen?.();
    // Standard API returns a promise; swallow rejection so nothing breaks.
    if (req && typeof (req as Promise<void>).then === 'function') {
      (req as Promise<void>).catch(() => { /* denied / unsupported — ignore */ });
    }
  } catch {
    /* API missing / threw synchronously — ignore, keep playing windowed */
  }
}

// Selected surface per map-select GROUP (group key → chosen member map id). Held
// in module memory so the choice persists for the SESSION across reopening the
// map select — NO localStorage/sessionStorage. Seeded lazily from each group's
// default member (or its first member if none is flagged default).
const groupSurface = new Map<string, string>();

// The members of a surfaceGroup, in switcher order (ascending `order`).
function groupMembers(key: string): MapDefinition[] {
  return listMaps()
    .map((m) => getMap(m.id))
    .filter((d): d is MapDefinition => !!d && d.surfaceGroup?.key === key)
    .sort((a, b) => a.surfaceGroup!.order - b.surfaceGroup!.order);
}
// The currently-selected member id for a group (default-seeded on first read).
function selectedSurfaceId(key: string): string {
  let id = groupSurface.get(key);
  if (id && getMap(id)?.surfaceGroup?.key === key) return id;
  const members = groupMembers(key);
  const def = members.find((d) => d.surfaceGroup!.isDefault) ?? members[0];
  id = def.id;
  groupSurface.set(key, id);
  return id;
}

// Render a map's mini-preview into an already-sized tile canvas (background +
// decor). Shared by plain tiles and the grouped tile (re-called on a switch).
function renderMapPreview(c: CanvasRenderingContext2D, def: MapDefinition, RW: number, RH: number) {
  c.clearRect(0, 0, RW, RH);
  try {
    const w = def.createWorld(RW / CONFIG.pxPerMeter, RH / CONFIG.pxPerMeter);
    def.drawBackground(c, RW, RH);
    def.drawObstacles(c, w, CONFIG.pxPerMeter, null);
  } catch { /* a preview must never break the menu */ }
}

// Build the map-select tiles from the registry (so new maps appear here
// automatically). Each tile renders a REAL mini-preview of the map. Maps that
// share a surfaceGroup.key collapse into ONE tile with an in-tile surface
// switcher (presentation only — each member is still launched by its own id).
function buildMapTiles() {
  if (!mapTilesEl) return;
  mapTilesEl.innerHTML = '';
  const dpr = window.devicePixelRatio || 1;
  const RW = 440, RH = 240, DW = 220, DH = 120;   // render 2×, display 1× (crisp)
  const renderedGroups = new Set<string>();

  const makeCanvas = () => {
    const cvs = document.createElement('canvas');
    cvs.width = Math.floor(RW * dpr); cvs.height = Math.floor(RH * dpr);
    cvs.style.width = DW + 'px'; cvs.style.height = DH + 'px';
    const c = cvs.getContext('2d');
    if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { cvs, c };
  };

  for (const { id } of listMaps()) {
    const def = getMap(id);
    if (!def) continue;

    // ---- Grouped maps → one merged tile (built once, at the first member) ----
    const grp = def.surfaceGroup;
    if (grp) {
      if (renderedGroups.has(grp.key)) continue;   // already built for this group
      renderedGroups.add(grp.key);

      const tile = document.createElement('div');
      tile.className = 'map-tile map-tile-group';
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');

      const thumb = document.createElement('span');
      thumb.className = 'map-thumb';
      const { cvs, c } = makeCanvas();
      thumb.appendChild(cvs);

      const label = document.createElement('span');
      label.className = 'map-name';
      label.textContent = grp.title;

      // Segmented surface switcher (members in switcher order).
      const sw = document.createElement('span');
      sw.className = 'map-switch';
      sw.setAttribute('role', 'group');
      sw.setAttribute('aria-label', 'Surface');
      const members = groupMembers(grp.key);
      const renderSelected = () => {
        if (c) renderMapPreview(c, getMap(selectedSurfaceId(grp.key)) ?? def, RW, RH);
      };
      const segs: HTMLButtonElement[] = [];
      for (const member of members) {
        const seg = document.createElement('button');
        seg.type = 'button';
        seg.className = 'map-seg';
        seg.textContent = member.surfaceGroup!.option;
        seg.dataset.id = member.id;
        const refreshActive = () => {
          const cur = selectedSurfaceId(grp.key);
          for (const s of segs) s.classList.toggle('is-active', s.dataset.id === cur);
        };
        // Tap/click a segment → select that surface (works on touch + mouse);
        // never bubbles to the tile body (so it doesn't launch the race).
        seg.addEventListener('click', (e) => {
          e.stopPropagation();
          groupSurface.set(grp.key, member.id);
          refreshActive();
          renderSelected();
        });
        segs.push(seg);
        sw.appendChild(seg);
      }
      // Initial active state + preview reflect the (default-seeded) selection.
      const cur0 = selectedSurfaceId(grp.key);
      for (const s of segs) s.classList.toggle('is-active', s.dataset.id === cur0);
      renderSelected();

      // Clicking the tile body (not a segment) launches the selected surface.
      tile.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.map-switch')) return;
        chooseMap(selectedSurfaceId(grp.key));
      });
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseMap(selectedSurfaceId(grp.key)); }
      });

      tile.appendChild(thumb);
      tile.appendChild(label);
      tile.appendChild(sw);
      mapTilesEl.appendChild(tile);
      continue;
    }

    // ---- Ungrouped map → a plain tile (unchanged behaviour) ----
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'map-tile';

    const thumb = document.createElement('span');
    thumb.className = 'map-thumb';
    const { cvs, c } = makeCanvas();
    if (c) renderMapPreview(c, def, RW, RH);
    thumb.appendChild(cvs);

    const label = document.createElement('span');
    label.className = 'map-name';
    label.textContent = def.name;

    tile.appendChild(thumb);
    tile.appendChild(label);
    tile.addEventListener('click', () => chooseMap(def.id));
    mapTilesEl.appendChild(tile);
  }
}

document.getElementById('btn-start-race')?.addEventListener('click', () => {
  goFullscreen();   // START RACE is the user gesture — fill the host screen
  openMapSelect();
});
document.getElementById('btn-map-back')?.addEventListener('click', openMainMenu);
openMainMenu();   // show the host menu at startup

// ---------- Pause menu (P / Esc) — RESUME / RESTART / EXIT TO MENU ----------
// The pause-overlay element IS the menu (shown by refreshFreeze while userPaused
// && !editorMode && !menuOpen). The keydown handler toggles userPaused; these
// buttons drive the three actions. The Supabase channel + lobby are never torn
// down — phones stay connected through pause / restart / exit.
function resumeGame() {
  userPaused = false;
  refreshFreeze();
}
// Reset the race on the CURRENT map: respawn every car at the map's spawn and
// zero the race (laps, time, checkpoints, phase). The map + editor-placed track
// elements STAY — only progress resets. Then resume.
function restartRace() {
  // XP mode: RESTART = a fresh score run (respawn + zero XP), not a lap reset.
  if (isXpMode()) { startXpRun(); userPaused = false; refreshFreeze(); return; }
  skidCtx.clearRect(0, 0, logicalPxW, logicalPxH);
  for (const car of cars.values()) {
    const pose = currentMap.spawn(car.slot, world);
    car.state = makeCar(pose.x, pose.y, pose.heading);
    car.target = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    car.current = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    car.skidL.active = false;
    car.skidR.active = false;
    car.lastInputAt = performance.now();
  }
  raceManager.reset();   // every car's laps/time/phase → zero
  resetRaceFeed();       // clear finish feed + podium + raceResultsOpen
  userPaused = false;
  refreshFreeze();
}
// Back to the MAIN MENU. Players stay connected (lobby/cars preserved); the game
// is held (menuOpen freeze, QR hidden) until the host picks a map again, which
// respawns the cars via switchMap. No phone is dropped, no QR rescan.
function exitToMainMenu() {
  userPaused = false;
  resetRaceFeed();   // drop any finish feed / podium so it's clean next race
  openMainMenu();
}
document.getElementById('btn-resume')?.addEventListener('click', resumeGame);
document.getElementById('btn-restart')?.addEventListener('click', restartRace);
document.getElementById('btn-exit-menu')?.addEventListener('click', exitToMainMenu);
// Race results (podium): REMATCH re-runs the race (reuses restartRace); EXIT goes
// to the main menu. Both clear the podium + feed.
document.getElementById('btn-rematch')?.addEventListener('click', restartRace);
document.getElementById('btn-results-menu')?.addEventListener('click', exitToMainMenu);

// ---------- Canvases ----------
// Layered rendering (back to front):
//   wallpaper (static offscreen) → skid marks (persistent offscreen)
//   → overlay: icons + taskbar (static offscreen) → clock → car.
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const skidCanvas = document.createElement('canvas');
const skidCtx = skidCanvas.getContext('2d')!;
const wallpaperCanvas = document.createElement('canvas');
const wallpaperCtx = wallpaperCanvas.getContext('2d')!;
const overlayCanvas = document.createElement('canvas');
const overlayCtx = overlayCanvas.getContext('2d')!;

let dpr = window.devicePixelRatio || 1;

// ---------- The active MAP (background, obstacles, spawn, bounds, wrap) ------
// Everything below reads through `currentMap` rather than hardcoding the
// desktop, so the game is map-driven. Default = the desktop map → behaviour is
// byte-for-byte identical to before. switchMap(id) swaps it (see below).
let currentMap: MapDefinition = getMap(DEFAULT_MAP_ID)!;
let world: MapWorld = currentMap.createWorld(
  window.innerWidth / CONFIG.pxPerMeter,
  window.innerHeight / CONFIG.pxPerMeter,
);

// ---------- View transform (logical world px → screen px) -------------------
// A FIXED-world map (the oval) is built at a constant logical size and rendered
// with a SINGLE UNIFORM scale that fits it into the viewport, centred, with
// letterbox/pillarbox margins — so the shape never deforms and a lap is the same
// effort at any window size. The desktop map has no fixedWorld, so the logical
// size equals the viewport and the transform is identity (behaviour unchanged).
//
// The offscreen layers (wallpaper/skids/overlay) live at the LOGICAL pixel size;
// render() blits them into the fitted rectangle. The dynamic layers (cars, fx,
// gates, foreground) draw in logical space under the same translate+scale. All
// physics/collision stay in logical world METRES, untouched by the view.
let viewScale = 1;              // logical px → screen px (uniform, both axes)
let viewOffX = 0, viewOffY = 0; // letterbox offset in screen CSS px
let logicalPxW = 0, logicalPxH = 0;  // offscreen layer size in CSS px
let layerDpr = 0;               // dpr the offscreen layers were last built at

// Logical world size in METRES: the map's fixed size, or the viewport.
function logicalMeters(): { wM: number; hM: number } {
  const f = currentMap.fixedWorld;
  if (f) return { wM: f.widthM, hM: f.heightM };
  return {
    wM: window.innerWidth / CONFIG.pxPerMeter,
    hM: window.innerHeight / CONFIG.pxPerMeter,
  };
}

// Invert the view transform: screen client px → world METRES. Identity-safe for
// the desktop (scale 1, offset 0 ⇒ clientX / pxPerMeter, as before).
function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: (clientX - viewOffX) / viewScale / CONFIG.pxPerMeter,
    y: (clientY - viewOffY) / viewScale / CONFIG.pxPerMeter,
  };
}

// Size the MAIN canvas to the viewport, recompute the uniform fit transform, and
// — only when the logical pixel size or dpr actually changed — (re)size the
// offscreen layers. Returns true when those layers were (re)sized (hence cleared
// and needing a redraw). A pure window-resize of a fixed-world map returns false,
// so the oval keeps its world, skids and race progress; only the view updates.
function syncCanvasesAndView(): boolean {
  dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;

  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const { wM, hM } = logicalMeters();
  const lpW = Math.max(1, Math.round(wM * CONFIG.pxPerMeter));
  const lpH = Math.max(1, Math.round(hM * CONFIG.pxPerMeter));

  // Uniform scale-to-fit + centre. Desktop: lpW=W, lpH=H ⇒ scale 1, offset 0.
  viewScale = Math.min(W / lpW, H / lpH);
  viewOffX = (W - lpW * viewScale) / 2;
  viewOffY = (H - lpH * viewScale) / 2;

  if (lpW === logicalPxW && lpH === logicalPxH && dpr === layerDpr) return false;
  logicalPxW = lpW; logicalPxH = lpH; layerDpr = dpr;
  for (const [cv, cx] of [
    [skidCanvas, skidCtx],
    [wallpaperCanvas, wallpaperCtx], [overlayCanvas, overlayCtx],
  ] as Array<[HTMLCanvasElement, CanvasRenderingContext2D]>) {
    cv.width = Math.floor(lpW * dpr);
    cv.height = Math.floor(lpH * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return true;
}

function resize() {
  // Layers are only rebuilt when their logical size/dpr changed: every time for
  // the desktop (logical = viewport), but for the fixed oval only on first build,
  // a map switch, or a dpr change — so a plain resize keeps its skids + race.
  if (syncCanvasesAndView()) {
    draggedObstacle = null;
    const { wM, hM } = logicalMeters();
    world = currentMap.createWorld(wM, hM);
    currentMap.drawBackground(wallpaperCtx, logicalPxW, logicalPxH);
    redrawOverlay();
  }
}

// ---------- Obstacle dragging (mouse builds the track; phone drives) --------
// Only active for maps whose obstacles are draggable (the desktop). Handlers
// route through the active map's drag API, which mutates obstacle data +
// collision rects — the game loop and the phone input path are untouched.
let draggedObstacle: MapObstacle | null = null;

function redrawOverlay() {
  overlayCtx.clearRect(0, 0, logicalPxW, logicalPxH);
  currentMap.drawObstacles(overlayCtx, world, CONFIG.pxPerMeter, draggedObstacle);
}

canvas.addEventListener('pointerdown', (e) => {
  if (editorMode) { editorPointerDown(e); return; }  // editor owns the mouse
  if (!currentMap.draggableObstacles) return;
  const { x: mx, y: my } = screenToWorld(e.clientX, e.clientY);
  const obs = currentMap.obstacleAt?.(world, mx, my) ?? null;
  if (!obs) return;
  e.preventDefault();
  draggedObstacle = obs;
  currentMap.beginDragObstacle?.(world, obs, mx, my);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  canvas.style.cursor = 'grabbing';
  redrawOverlay();
});

canvas.addEventListener('pointermove', (e) => {
  if (editorMode) { editorPointerMove(e); return; }
  if (!currentMap.draggableObstacles) return;
  const { x: mx, y: my } = screenToWorld(e.clientX, e.clientY);
  if (draggedObstacle) {
    currentMap.dragObstacleTo?.(world, draggedObstacle, mx, my);
    redrawOverlay();
  } else {
    canvas.style.cursor = currentMap.obstacleAt?.(world, mx, my) ? 'grab' : 'default';
  }
});

function endObstacleDrag() {
  if (!draggedObstacle) return;
  currentMap.dropObstacle?.(world, draggedObstacle);
  draggedObstacle = null;
  canvas.style.cursor = currentMap.draggableObstacles ? 'grab' : 'default';
  redrawOverlay();
}
canvas.addEventListener('pointerup', (e) => {
  if (editorMode) { editorPointerUp(); return; }
  endObstacleDrag();
  void e;
});
canvas.addEventListener('pointercancel', (e) => {
  if (editorMode) { editorPointerUp(); return; }
  endObstacleDrag();
  void e;
});

resize();
window.addEventListener('resize', resize);

// ---------- Cars — one per connected lobby slot (built for N) ----------
const PX = () => CONFIG.pxPerMeter;

// A skid trail remembers a rear wheel's last pixel position so we can draw a
// continuous line while it slides. One pair per car.
type WheelTrail = { px: number; py: number; active: boolean };

// One playable car: physics state + the slot's colour (+ a precomputed skid
// stroke style) + that slot's smoothed inputs + its own rear-wheel skid trails.
interface Car {
  slot: number;
  state: CarState;
  color: string;
  skidStyle: string;
  target: Inputs;
  current: Inputs;
  skidL: WheelTrail;
  skidR: WheelTrail;
  lastInputAt: number;   // performance.now() of the last control packet (liveness)
  inputStale: boolean;   // currently RECONNECTING (ramping/neutral)? (for D-debug)
  coastInput: Inputs | null;  // snapshot of the last live input, taken at ramp
                              //   start so the ramp eases from it to neutral
}

// Keyed by slot so routing/lookup is O(1) and nothing is hardcoded to 2 cars.
const cars = new Map<number, Car>();
const DEFAULT_CAR_COLOR = '#1d3fa0';
// Input behaviour through a packet gap is governed by the UNIFIED lifecycle —
// hold (coast) → ramp to neutral → parked-in-place — all keyed off RESILIENCE
// (lobby.ts), the single source of truth. See the per-frame block in the loop.
// Replaces the old standalone STALE_INPUT_MS hard-zero (de1f475/47319e6).

function makeManagedCar(slot: number, color: string): Car {
  const pose = currentMap.spawn(slot, world);   // per-map spawn layout
  return {
    slot,
    state: makeCar(pose.x, pose.y, pose.heading),
    color,
    skidStyle: skidColorFor(color),
    target: { steer: 0, throttle: 0, brake: 0, handbrake: false },
    current: { steer: 0, throttle: 0, brake: 0, handbrake: false },
    skidL: { px: 0, py: 0, active: false },
    skidR: { px: 0, py: 0, active: false },
    lastInputAt: performance.now(),
    inputStale: false,
    coastInput: null,
  };
}

// The "primary" car drives the single HUD / engine sound / race timer — the
// lowest connected slot (slot 0 in the solo case, so nothing changes there).
function primaryCar(): Car | null {
  let best: Car | null = null;
  for (const c of cars.values()) if (!best || c.slot < best.slot) best = c;
  return best;
}

// Reconcile the car set with the lobby: spawn a car when a slot connects,
// remove it when the slot frees (disconnect / timeout), and keep colours live.
// Never resets an existing car, so periodic lobby re-syncs don't teleport
// anyone back to spawn. Reconnect (slot reclaim) re-spawns the car here.
function syncCars() {
  const snap = lobby.snapshot();
  const live = new Set<number>();
  for (const p of snap) {
    live.add(p.slot);
    const existing = cars.get(p.slot);
    if (!existing) {
      cars.set(p.slot, makeManagedCar(p.slot, p.color || DEFAULT_CAR_COLOR));
    } else if (existing.color !== p.color) {
      existing.color = p.color;            // live colour change
      existing.skidStyle = skidColorFor(p.color);
    }
  }
  for (const slot of [...cars.keys()]) {
    if (!live.has(slot)) {
      cars.delete(slot);
      raceManager.remove(slot);   // a gone car never blocks the race end
    }
  }
}

// Skid stroke for a car: its colour darkened toward tarmac, semi-transparent so
// the marks read on the green lawn while still hinting whose they are. Cheap
// (one rgba string, recomputed only on colour change).
function skidColorFor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'rgba(28, 28, 32, 0.42)';
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * 0.45);
  const g = Math.round(((n >> 8) & 255) * 0.45);
  const b = Math.round((n & 255) * 0.45);
  return `rgba(${r}, ${g}, ${b}, 0.42)`;
}

// ---------- Race elements ----------
// OPEN maps (desktop): the editor (E) mutates this RaceElement[] (world metres)
// in place — place/drag/delete start/finish/checkpoints. CIRCUIT maps (oval):
// the array is DERIVED from the map's built-in start line + the laps panel
// (0 laps ⇒ empty ⇒ free-roam; N laps ⇒ [startLine] ⇒ N-lap circuit race).
const raceElements: RaceElement[] = [];
// Lap count is an editor setting. Open maps use 1..10; circuit maps 0..99 (0 =
// free-roam). The built track uses it; the race HUD shows LAP n/m off it.
let editorLaps = RACE_CONFIG.laps;
// MULTI-CAR race: one RaceManager drives per-car lap counting + finishing order.
// The lead car (lowest slot) still feeds the single lap/timer HUD; the manager
// adds the live finish feed + podium for N players.
let raceManager = new RaceManager(raceElements, { ...RACE_CONFIG, laps: editorLaps });
const isCircuitMap = () => currentMap.trackType === 'circuit';

// Live finish feed (captured per finisher with the NAME/COLOUR at finish time, so
// a later disconnect/reclaim can't corrupt the display). Drives the corner feed
// while racing and the podium once the race completes.
interface FeedEntry { position: number; slot: number; name: string; color: string; finishMs: number; }
let finishFeed: FeedEntry[] = [];
let lastFinisherCount = 0;
// A race is "live" (feed + podium apply) only when there are race elements AND
// we're not in XP mode — i.e. circuit RACE (laps≥1) or an open-map sprint/circuit.
const isRaceLive = () => raceElements.length > 0 && !isXpMode();

function resetRaceFeed() {
  finishFeed = [];
  lastFinisherCount = 0;
  raceResultsOpen = false;
  if (finishFeedEl) { finishFeedEl.innerHTML = ''; finishFeedEl.hidden = true; }
  if (raceResultsEl) raceResultsEl.hidden = true;
}

function playerName(slot: number): string {
  const p = lobby.snapshot().find((q) => q.slot === slot);
  return (p?.name && p.name.trim()) || `P${slot + 1}`;
}

// Ingest any cars that finished since last frame: snapshot their name/colour into
// the feed and render the corner notice. Does NOT block still-racing cars.
function pollFinishers() {
  const fs = raceManager.finishers();
  for (let i = lastFinisherCount; i < fs.length; i++) {
    const f = fs[i];
    finishFeed.push({
      position: f.position, slot: f.slot, name: playerName(f.slot),
      color: cars.get(f.slot)?.color || DEFAULT_CAR_COLOR, finishMs: f.finishMs,
    });
  }
  if (fs.length !== lastFinisherCount) { lastFinisherCount = fs.length; renderFinishFeed(); }
}

function renderFinishFeed(): void {
  if (!finishFeedEl) return;
  if (finishFeed.length === 0 || raceResultsOpen) { finishFeedEl.hidden = true; return; }
  finishFeedEl.hidden = false;
  finishFeedEl.innerHTML = finishFeed.map((e) =>
    `<div class="ff-row" style="--c:${e.color}">` +
    `<span class="ff-pos">✓ P${e.position}</span>` +
    `<span class="ff-name">${escapeHtml(e.name)}</span>` +
    `<span class="ff-time">${formatRaceTime(e.finishMs)}</span></div>`,
  ).join('');
}

// All connected cars finished → freeze + show the podium (top 3) + rest list.
function openRaceResults() {
  raceResultsOpen = true;
  refreshFreeze();
  if (finishFeedEl) finishFeedEl.hidden = true;
  // Podium steps: P2 (left), P1 (centre, tallest), P3 (right).
  for (const pos of [1, 2, 3]) {
    const e = finishFeed.find((x) => x.position === pos);
    const pod = raceResultsEl?.querySelector(`.pod-${pos}`) as HTMLElement | null;
    if (!pod) continue;
    pod.hidden = !e;
    if (e) {
      (pod.querySelector('.pod-name') as HTMLElement).textContent = e.name;
      (pod.querySelector('.pod-time') as HTMLElement).textContent = formatRaceTime(e.finishMs);
      pod.style.setProperty('--c', e.color);
    }
  }
  // 4th onward as a plain list.
  if (resultsRestEl) {
    resultsRestEl.innerHTML = finishFeed.filter((e) => e.position >= 4).map((e) =>
      `<div class="rr-row"><span>P${e.position}</span>` +
      `<span class="rr-name" style="color:${e.color}">${escapeHtml(e.name)}</span>` +
      `<span>${formatRaceTime(e.finishMs)}</span></div>`).join('');
  }
  if (raceResultsEl) raceResultsEl.hidden = false;
}

// ---------- XP MODE (circuit maps) — a third mode beside LAPS ----------
// SOLO + LOCAL: the run READS the primary car's speed/slip (never writes physics)
// and banks a score; the best is persisted in localStorage per map. Rules: xp.ts.
type CircuitMode = 'laps' | 'xp';
let circuitMode: CircuitMode = 'laps';
let xpRun: XpRunState = makeXpRun();
let xpEndHandled = false;            // bank/record exactly once per ended run
let xpBest = 0;                      // current map's stored best (refreshed on start)
const isXpMode = () => isCircuitMap() && circuitMode === 'xp';

function xpBestKey(): string { return `steerit.xp.best.${currentMap.id}`; }
function loadXpBest(): number {
  try { return Math.max(0, Math.floor(Number(localStorage.getItem(xpBestKey())) || 0)); }
  catch { return 0; }
}
function saveXpBest(v: number): void {
  try { localStorage.setItem(xpBestKey(), String(Math.floor(v))); } catch { /* ignore */ }
}

// (Re)start an XP run: fresh score, respawn the solo car at spawn, load the best,
// hide the end card. Called on entering XP mode, on RETRY, and on RESTART.
function startXpRun() {
  xpRun = makeXpRun();
  xpEndHandled = false;
  xpBest = loadXpBest();
  for (const [slot, car] of cars) {
    const pose = currentMap.spawn(slot, world);
    car.state = makeCar(pose.x, pose.y, pose.heading);
    car.target = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    car.current = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    car.skidL.active = false; car.skidR.active = false;
    car.lastInputAt = performance.now();
  }
  skidCtx.clearRect(0, 0, logicalPxW, logicalPxH);
  if (xpEndEl) xpEndEl.hidden = true;
}

// End of a run: bank the score, beat-the-best check + persist, fill the end card.
function handleXpEnd() {
  xpEndHandled = true;
  const score = Math.floor(xpRun.xp);
  const isRecord = score > xpBest;
  if (isRecord) { xpBest = score; saveXpBest(score); }
  if (xpEndRecordEl) xpEndRecordEl.hidden = !isRecord;
  if (xpEndLabelEl)  xpEndLabelEl.textContent = xpRun.endReason === 'crash' ? 'CRASHED' : 'TOO SLOW';
  if (xpEndScoreEl)  xpEndScoreEl.textContent = formatXp(score);
  if (xpEndBestEl)   xpEndBestEl.textContent  = `BEST ${formatXp(xpBest)}`;
  if (xpEndEl) xpEndEl.hidden = false;
}

function rebuildRace() {
  if (isCircuitMap()) {
    // Circuit: the race IS the built-in start/finish line. Rebuild it from the
    // laps panel — 0 = free-roam (no element → inactive HUD), N = circuit race.
    // XP mode has no lap timer at all, so it builds no race elements.
    raceElements.length = 0;
    if (circuitMode === 'laps' && editorLaps >= 1 && currentMap.startLine) {
      raceElements.push(currentMap.startLine(world));
    }
  }
  raceManager = new RaceManager(raceElements, { ...RACE_CONFIG, laps: Math.max(1, editorLaps) });
  resetRaceFeed();
}

// ---------- Track editor (key E) — place/drag/delete into raceElements ----------
type EditorTool = RaceType | 'delete';
let editorTool: EditorTool = 'start';
let editorDragIdx: number | null = null;
let editorDragOff = { x: 0, y: 0 };
const EDITOR_GRAB_R = 1.8;  // metres — generous hit radius for drag/delete
const EDITOR_DEFAULT_HINT = 'click to place · drag to move · E to exit';

function editorPointerDown(e: PointerEvent) {
  if (isCircuitMap()) return;   // circuit maps have no place-elements editor
  e.preventDefault();
  const { x: mx, y: my } = screenToWorld(e.clientX, e.clientY);
  const idx = findElementIndexAt(raceElements, mx, my, EDITOR_GRAB_R);
  if (idx >= 0) {
    if (editorTool === 'delete') {
      removeElementAt(raceElements, idx);
      updateEditorStatus();
    } else {
      // Any placement tool can also REPOSITION the element under the cursor.
      editorDragIdx = idx;
      editorDragOff = { x: mx - raceElements[idx].x, y: my - raceElements[idx].y };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    return;
  }
  if (editorTool === 'delete') return;            // empty space + delete → nothing
  const r = placeElement(raceElements, editorTool, mx, my, RACE_CONFIG);
  if (!r.ok && r.reason === 'cap') showEditorHint(`MAX ${RACE_CONFIG.maxCheckpoints} CHECKPOINTS`);
  updateEditorStatus();
}
function editorPointerMove(e: PointerEvent) {
  if (editorDragIdx === null) return;
  const { x: mx, y: my } = screenToWorld(e.clientX, e.clientY);
  raceElements[editorDragIdx].x = mx - editorDragOff.x;
  raceElements[editorDragIdx].y = my - editorDragOff.y;
}
function editorPointerUp() { editorDragIdx = null; }

let hintTimer = 0;
function showEditorHint(msg: string) {
  if (!editorHintEl) return;
  editorHintEl.textContent = msg;
  editorHintEl.classList.add('flash');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    editorHintEl.classList.remove('flash');
    editorHintEl.textContent = EDITOR_DEFAULT_HINT;
  }, 1400);
}

function updateEditorStatus() {
  const sep = `<span class="sep">·</span>`;
  if (editorStatusEl) {
    if (isCircuitMap()) {
      // CIRCUIT: choose LAPS (timed/free-roam) or XP MODE (endless score run).
      let detail: string;
      if (circuitMode === 'xp') {
        detail = `<span class="ok">XP MODE · drift for score</span>`;
      } else {
        detail = editorLaps >= 1
          ? `<span class="ok">RACE · ${editorLaps} LAP${editorLaps > 1 ? 'S' : ''}</span>`
          : `<span class="no">FREE ROAM · no timer</span>`;
      }
      editorStatusEl.innerHTML = `<span class="mode">CIRCUIT</span>${sep}${detail}`;
      syncModeButtons();
    } else {
      // OPEN: the full place-elements editor (unchanged).
      const hasStart = raceElements.some((el) => el.type === 'start');
      const hasFinish = raceElements.some((el) => el.type === 'finish');
      const circuit = isCircuitTrack(raceElements);
      const cp = countCheckpoints(raceElements);
      const mode = hasFinish ? 'SPRINT' : hasStart ? 'CIRCUIT' : '—';
      let html = `<span class="mode">${mode}</span>` + sep +
        `<span class="${hasStart ? 'ok' : 'no'}">START ${hasStart ? '✓' : '·'}</span>`;
      if (!circuit) {
        html += sep +
          `<span class="${hasFinish ? 'ok' : 'no'}">FINISH ${hasFinish ? '✓' : '·'}</span>`;
      }
      html += sep + `<span class="cp">CP ${cp}/${RACE_CONFIG.maxCheckpoints}</span>` +
        sep + `<span class="laps">LAPS ${editorLaps}</span>`;
      editorStatusEl.innerHTML = html;
    }
  }
  for (const b of Array.from(document.querySelectorAll('#editor-palette .etool')) as HTMLElement[]) {
    b.classList.toggle('sel', b.dataset.tool === editorTool);
  }
  // The laps value lives in a number input; don't clobber it while it's focused.
  if (lapsValEl && document.activeElement !== lapsValEl) lapsValEl.value = String(editorLaps);
  if (editorHintEl && !editorHintEl.classList.contains('flash')) {
    editorHintEl.textContent = isCircuitMap()
      ? 'set laps · 0 = free roam · E to exit'
      : EDITOR_DEFAULT_HINT;
  }
  // CSS hides the place-elements palette on circuit maps (laps-only editor).
  document.body.classList.toggle('circuit-edit', editorMode && isCircuitMap());
}

// Palette buttons (exist in index.html). Selecting a tool never touches the map.
for (const b of Array.from(document.querySelectorAll('#editor-palette .etool')) as HTMLElement[]) {
  b.addEventListener('click', () => { editorTool = b.dataset.tool as EditorTool; updateEditorStatus(); });
}
document.getElementById('editor-clear')?.addEventListener('click', () => {
  clearElements(raceElements);
  updateEditorStatus();
});

// Lap-count control. Range depends on the map: OPEN 1..10, CIRCUIT 0..99 (0 =
// free-roam). The value is a type-able number input + / − steppers, so any
// 0..99 is reachable without 99 clicks. Changing laps only updates the editor
// setting; the race rebuilds with it on editor exit (E).
const lapsValEl = document.getElementById('laps-val') as HTMLInputElement | null;
function lapsRange(): [number, number] { return isCircuitMap() ? [0, 99] : [1, 10]; }
function setEditorLaps(n: number) {
  const [lo, hi] = lapsRange();
  editorLaps = Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));
  updateEditorStatus();
}
document.getElementById('laps-dec')?.addEventListener('click', () => setEditorLaps(editorLaps - 1));
document.getElementById('laps-inc')?.addEventListener('click', () => setEditorLaps(editorLaps + 1));
lapsValEl?.addEventListener('change', () => setEditorLaps(Number(lapsValEl.value)));

// Circuit game-mode toggle (LAPS / XP MODE). Switching to XP starts a fresh run;
// switching back to LAPS rebuilds the lap/free-roam race and drops the XP HUD.
function syncModeButtons() {
  for (const b of Array.from(document.querySelectorAll('#editor-mode .emode')) as HTMLElement[]) {
    b.classList.toggle('sel', b.dataset.mode === circuitMode);
  }
}
function setCircuitMode(mode: CircuitMode) {
  if (!isCircuitMap()) return;
  circuitMode = mode;
  document.body.classList.toggle('circuit-xp', mode === 'xp');
  syncModeButtons();
  rebuildRace();          // XP ⇒ no race elements (no lap timer)
  updateEditorStatus();
  if (mode === 'xp') startXpRun();
  else if (xpEndEl) xpEndEl.hidden = true;
}
for (const b of Array.from(document.querySelectorAll('#editor-mode .emode')) as HTMLElement[]) {
  b.addEventListener('click', () => setCircuitMode(b.dataset.mode as CircuitMode));
}
document.getElementById('xp-retry')?.addEventListener('click', () => startXpRun());

// ================= LOBBY — the desktop is the authority =================
// The desktop owns the ONLY LobbyState; phones never self-assign slots (no
// races — Supabase delivers to this single JS thread, processed in order).
// Built for N: the cap lives in lobby.ts (PLAYER_CAP).
const lobby = new LobbyState(PLAYER_CAP);

// Realtime health: the idle-sweep must NOT free everyone just because OUR own
// channel dropped — only when a phone genuinely went quiet. So the sweep is
// gated on channelReady, plus a grace window after a reconnect for phones to
// re-announce (they heartbeat ~PHONE_HEARTBEAT_MS).
let channelReady = false;
let sweepGraceUntil = 0;
const nowIso = () => new Date().toISOString();

function broadcastLobby() {
  rc.send({
    type: 'broadcast', event: EV.lobby,
    payload: { players: lobby.snapshot(), cap: PLAYER_CAP },
  });
  renderLobbyUI();
}

// Lighten (f>1) / darken (f<1) a #rrggbb colour for cohesive body accents.
function shadeHex(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function renderLobbyUI() {
  const n = lobby.size();
  statusEl.textContent = n === 0 ? 'Waiting for phone…' : `${n}/${PLAYER_CAP} connected`;
  statusEl.classList.toggle('connected', n > 0);

  const snap = lobby.snapshot();
  // Reconcile the live cars with the lobby (spawn/remove/recolour per slot).
  syncCars();

  if (!rosterEl) return;
  rosterEl.innerHTML = n === 0 ? '' : snap.map((p) => {
    const label = p.name ? escapeHtml(p.name) : `PLAYER ${p.slot + 1}`;
    return `<div class="roster-row">` +
      `<span class="roster-dot" style="background:${p.color};box-shadow:0 0 8px ${p.color}"></span>` +
      `<span class="roster-name">${label}</span>` +
      `<span class="roster-color">${colorName(p.color)}</span>` +
      `<span class="roster-ok">●</span>` +
    `</div>`;
  }).join('');
}

// ---- phone → desktop handlers (re-attached to every (re)created channel) ----
function wireDesktop(ch: RealtimeChannel) {
  ch.on('broadcast', { event: EV.join }, ({ payload }) => {
    const p = payload as { id?: unknown; color?: string; name?: string };
    const id = String(p?.id ?? '');
    if (!id) return;
    const r = lobby.join(id, p?.color, Date.now(), p?.name);
    if (r.slot === null) {
      rc.send({ type: 'broadcast', event: EV.full, payload: { id } }); // lobby full
    } else if (r.changed) {
      broadcastLobby();
    }
  });

  ch.on('broadcast', { event: EV.color }, ({ payload }) => {
    const id = String((payload as { id?: unknown })?.id ?? '');
    const color = (payload as { color?: string })?.color;
    if (!id || !color) return;
    if (lobby.setColor(id, color, Date.now()).changed) broadcastLobby();
  });

  ch.on('broadcast', { event: EV.name }, ({ payload }) => {
    const id = String((payload as { id?: unknown })?.id ?? '');
    const name = (payload as { name?: string })?.name;
    if (!id || name === undefined) return;
    if (lobby.setName(id, name, Date.now()).changed) broadcastLobby();
  });

  ch.on('broadcast', { event: EV.leave }, ({ payload }) => {
    const id = String((payload as { id?: unknown })?.id ?? '');
    if (id && lobby.leave(id).changed) broadcastLobby();
  });

  ch.on('broadcast', { event: EV.control }, ({ payload }) => {
    const id = String((payload as { id?: unknown })?.id ?? '');
    // STEP 2: every connected slot drives its OWN car. Route by the desktop's
    // authoritative id→slot map (never trust the phone's self-reported slot).
    if (!id) {                                       // legacy id-less → drive slot 0
      const c0 = cars.get(0);
      if (c0) { applyInputs(c0.target, payload as Inputs); c0.lastInputAt = performance.now(); }
      return;
    }
    const r = lobby.join(id, undefined, Date.now()); // lazy-join if join was missed
    if (r.changed) broadcastLobby();                 // → syncCars spawns the car
    if (r.slot === null) return;                     // lobby full
    const car = cars.get(r.slot);
    if (car) {
      const t = performance.now();
      // D-debug: surface real network gaps (jitter spikes) between packets.
      if (debugOn) {
        const gap = t - car.lastInputAt;
        if (gap > 120) console.info(`[ctrl] ${nowIso()} slot ${car.slot} packet gap ${Math.round(gap)}ms`);
      }
      applyInputs(car.target, payload as Inputs);
      car.lastInputAt = t;
    }
  });
}

// Resilient channel: auto-reconnects on a dropped socket (the ~60s idle/timeout)
// and re-accepts the existing players by id — no QR rescan.
const rc = createResilientChannel(
  channelName(code), { broadcast: { self: false } }, wireDesktop,
  {
    label: 'desktop',
    onReady: () => {
      channelReady = true;
      // After ANY (re)subscribe the desktop was BLIND (received nothing), so it
      // must not declare anyone departed until phones have had the full grace to
      // re-announce. Single source of truth: RESILIENCE.PRESENCE_GRACE_MS.
      sweepGraceUntil = Date.now() + RESILIENCE.PRESENCE_GRACE_MS;
      broadcastLobby();   // push current roster to (re)connected phones
    },
    onDrop: (status) => {
      channelReady = false;   // STOP the sweep — our channel died, the phones didn't
      console.warn(`[desktop] ${nowIso()} channel dropped (${status}); reconnecting, NOT freeing slots`);
    },
  },
);

// ---- DEPARTURE sweep + periodic lobby re-sync ----
// Declares a phone DEPARTED (frees its slot → syncCars removes the car +
// raceManager.remove) ONLY after PRESENCE_GRACE_MS of total silence — long
// enough that any recoverable reconnect is preserved in place, never mistaken
// for a departure. Gated on the desktop's OWN channel health + reconnect grace
// so the desktop dropping never mass-frees slots. Single source: RESILIENCE.
setInterval(() => {
  if (!channelReady || Date.now() < sweepGraceUntil) return;
  const r = lobby.sweep(Date.now(), RESILIENCE.PRESENCE_GRACE_MS);
  if (r.changed) {
    for (const f of r.freed) {
      console.info(
        `[desktop] ${nowIso()} idle-sweep freed slot ${f.slot} (id=${f.id}, silent ${Math.round(f.ageMs)}ms)`,
      );
    }
    broadcastLobby();
  }
}, 1000);
setInterval(() => { if (lobby.size()) broadcastLobby(); }, LOBBY_SYNC_MS);

renderLobbyUI();

// ---------- Skids (per car) ----------
// We draw skid lines straight onto the shared persistent skidCanvas every
// physics step. Each car's rear wheels keep their own "previous pixel position"
// (car.skidL/skidR) so a continuous line is drawn while that wheel slides, and
// each car's marks are tinted with its colour (car.skidStyle).
function rearWheelPositions(state: CarState) {
  const halfTrack = CONFIG.trackWidth / 2;
  const rearOffset = -CONFIG.wheelbase / 2;
  const L = bodyToWorld(state, rearOffset, +halfTrack);
  const R = bodyToWorld(state, rearOffset, -halfTrack);
  return { L, R };
}

function drawSkidSegment(
  trail: WheelTrail, wx: number, wy: number, sliding: boolean, style: string,
) {
  const px = wx * PX();
  const py = wy * PX();
  if (sliding) {
    if (trail.active) {
      // Don't draw across an edge-wrap jump.
      const dx = px - trail.px, dy = py - trail.py;
      if (dx * dx + dy * dy < 10000) {
        skidCtx.strokeStyle = style;
        skidCtx.lineWidth = 3;
        skidCtx.lineCap = 'round';
        skidCtx.beginPath();
        skidCtx.moveTo(trail.px, trail.py);
        skidCtx.lineTo(px, py);
        skidCtx.stroke();
      }
    }
    trail.px = px;
    trail.py = py;
    trail.active = true;
  } else {
    trail.active = false;
  }
}

function recordSkids(car: Car) {
  const s = car.state;
  const driftingRear =
    s.isRearSliding || Math.abs(s.rearSlip) > CONFIG.slipThresholdForSkid;
  const { L, R } = rearWheelPositions(s);
  drawSkidSegment(car.skidL, L.x, L.y, driftingRear, car.skidStyle);
  drawSkidSegment(car.skidR, R.x, R.y, driftingRear, car.skidStyle);
}

// ---------- World wrap (per car) — delegated to the active map ----------
// The map owns its bounds + wrap behaviour (the desktop wraps L/R/top and
// re-enters above the taskbar). Returns true when the car teleported, so we
// break its skid trail.
function wrap(car: Car) {
  if (currentMap.wrap(car.state, world)) invalidateSkidTrails(car);
}
function invalidateSkidTrails(car: Car) {
  // After wrapping we don't want a long streak across the screen.
  car.skidL.active = false;
  car.skidR.active = false;
}

// Tire smoke from one car's rear wheels while drifting or spinning — the visual
// twin of the squeal. state.rearSlip is speed-gated in physics, so a parked car
// (slip == 0) only smokes from genuine WSPIN (standing burnout), never atan2
// noise. Emission is capped globally by the shared Effects pool.
function emitCarSmoke(car: Car, realDt: number) {
  const s = car.state;
  const slipNorm = Math.min(1,
    Math.abs(s.rearSlip) / (CONFIG.slipThresholdForSkid * 2.5));
  const smokeIntensity = Math.max(s.wheelSpin, slipNorm > 0.4 ? slipNorm : 0);
  if (smokeIntensity <= 0.2) return;
  // Spawn slightly BEHIND the rear wheels (along -heading) and keep puffs
  // modest near a slow car so a standing burnout never hides it.
  const back = 0.45;
  const bx = -Math.cos(s.heading) * back;
  const by = -Math.sin(s.heading) * back;
  const sizeScale = 0.55 + 0.45 * Math.min(1, s.speed / 6);
  const tint = currentMap.smokeColor;   // undefined ⇒ default white smoke
  const { L, R } = rearWheelPositions(s);
  fx.emitSmoke(L.x + bx, L.y + by, s.vx, s.vy, smokeIntensity, realDt, sizeScale, tint);
  fx.emitSmoke(R.x + bx, R.y + by, s.vx, s.vy, smokeIntensity, realDt, sizeScale, tint);
}

// ---------- Main loop with fixed-timestep accumulator ----------
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;
let lastTime = performance.now();
let accumulator = 0;

function frame(now: number) {
  const realDt = Math.min(0.25, (now - lastTime) / 1000);
  // D-debug: flag long frames (GC / render hitch) that could feel like a stutter.
  if (debugOn && now - lastTime > 100) {
    console.info(`[frame] ${nowIso()} long frame ${Math.round(now - lastTime)}ms`);
  }
  lastTime = now;

  // Monotonic game clock that EXCLUDES paused time, so the race timer freezes
  // while paused and never jumps on resume. While paused it holds the value it
  // had at the instant of pausing; pausedAccumMs grows by the pause length on
  // resume, so `now - pausedAccumMs` continues seamlessly from there.
  const gameNow = isPaused ? pauseStartedAt - pausedAccumMs : now - pausedAccumMs;

  // The single pause gate: skip the entire SIMULATION (physics, race detection,
  // skids, smoke, particles, engine sound) — but never the render below.
  const lead = primaryCar();  // drives the single HUD / sound / race timer
  if (!isPaused) {
    // UNIFIED CONNECTION LIFECYCLE (input half) — single source of truth in
    // RESILIENCE. Per car, age = time since its last control packet:
    //   ≤ INPUT_COAST_MS      → CONNECTED: hold last input (bridge jitter/blip).
    //   COAST … NEUTRAL_BY    → RECONNECTING: RAMP the last-held input linearly to
    //                           neutral (no twitch, no runaway); handbrake released.
    //   ≥ INPUT_NEUTRAL_BY_MS → fully neutral; the car coasts to rest IN PLACE.
    // The car itself is PRESERVED until the lobby sweep declares it DEPARTED at
    // PRESENCE_GRACE_MS (≫ NEUTRAL_BY) — so a reconnect never teleports/removes it.
    const tnow = performance.now();
    for (const car of cars.values()) {
      const age = tnow - car.lastInputAt;
      if (age <= RESILIENCE.INPUT_COAST_MS) {
        car.coastInput = null;                 // live / holding last — nothing to ramp
      } else {
        // Snapshot the last-held input ONCE at ramp start, then ramp it to 0 by a
        // fixed deadline (frame-rate independent) so the car eases to neutral.
        if (!car.coastInput) car.coastInput = { ...car.target };
        const span = RESILIENCE.INPUT_NEUTRAL_BY_MS - RESILIENCE.INPUT_COAST_MS;
        const k = Math.max(0, 1 - (age - RESILIENCE.INPUT_COAST_MS) / span);
        car.target.steer    = car.coastInput.steer    * k;
        car.target.throttle = car.coastInput.throttle * k;
        car.target.brake    = car.coastInput.brake    * k;
        car.target.handbrake = false;          // release on any sustained gap
      }
      const reconnecting = age > RESILIENCE.INPUT_COAST_MS;
      if (debugOn && reconnecting !== car.inputStale) {
        console.info(`[conn] ${nowIso()} slot ${car.slot} ` +
          (reconnecting
            ? `RECONNECTING — no packet ${Math.round(age)}ms → input ramping to neutral`
            : `LIVE (channelReady=${channelReady})`));
      }
      car.inputStale = reconnecting;
    }
    let xpCrash = false;   // set if the SOLO (lead) car hits a barrier this frame
    accumulator += realDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      // Advance every car: smooth its inputs, integrate, then resolve obstacle
      // collisions. The smoothing/step is IDENTICAL to the old single-car path,
      // so each car drives exactly as the solo car always did.
      for (const car of cars.values()) {
        const { current, target } = car;
        // Smooth incoming inputs inside the fixed step so the smoothing rate is
        // frame-rate independent. Steer gets the heaviest smoothing. Throttle /
        // brake get a light lerp so 30Hz network steps don't visibly jump the
        // 60Hz physics. Handbrake is binary — snap.
        current.steer    += (target.steer    - current.steer)    * CONFIG.inputLerp;
        // p15b: throttle lerp 0.3 → 0.5. A pinned pedal must reach near-full FAST,
        // before the standing car accelerates past the boost-fade window — at 0.3
        // the throttle ramp lagged so far that a full-pedal launch never lit the
        // burnout (the boost had already faded by the time throttle maxed).
        current.throttle += (target.throttle - current.throttle) * 0.5;
        current.brake    += (target.brake    - current.brake)    * 0.3;
        current.handbrake = target.handbrake;

        step(car.state, current, FIXED_DT);
        const impact = collideWithRects(car.state, world.rects);
        if (impact > 0.8) {
          sound.impact(impact);
          fx.impact(car.state.x, car.state.y, impact);
        }
        if (car === lead && impact > XP_CONFIG.crashImpact) xpCrash = true;
      }

      // Cars bounce off EACH OTHER (arcade, clamped) after all have integrated.
      if (cars.size > 1) {
        const carImpact = collideCars([...cars.values()].map((c) => c.state));
        if (carImpact > 0.8 && lead) fx.impact(lead.state.x, lead.state.y, carImpact);
      }

      // Per-car trails + edge wrap; race detection PER CAR (multi-car race).
      for (const car of cars.values()) { recordSkids(car); wrap(car); }
      // Each car races independently — velocity drives the directional start-line
      // crossing (circuit anti-cheat). The manager records finishing order.
      if (isRaceLive()) {
        for (const [slot, car] of cars) {
          raceManager.update(slot, car.state.x, car.state.y, gameNow, car.state.vx, car.state.vy);
        }
      }

      accumulator -= FIXED_DT;
      steps++;
    }
    // Drop accumulated time if we fell way behind (prevents spiral of death).
    if (steps === MAX_SUBSTEPS) accumulator = 0;

    // ---- MULTI-CAR RACE: surface new finishers in the live corner feed (the
    // still-racing cars keep going), and once EVERY connected car has finished,
    // freeze + raise the podium.
    if (isRaceLive()) {
      pollFinishers();
      if (!raceResultsOpen && raceManager.isComplete(cars.keys())) openRaceResults();
    }

    // ---- XP MODE: read the SOLO car's speed + sideways slip and accrue score.
    // Pure read — physics/drift untouched. Banks + shows the end card on end.
    if (isXpMode() && lead && xpRun.active) {
      updateXpRun(xpRun, realDt, lead.state.speed, lead.state.rearSlip, xpCrash);
      if (xpRun.ended && !xpEndHandled) handleXpEnd();
    }

    // ---- Engine sound: the primary car only (one engine; keeps it cheap). ----
    if (lead) {
      sound.update({
        wheelSpeed: lead.state.rearWheelSpeed,
        speed: lead.state.speed,
        slipAngle: lead.state.rearSlip,
        wheelSpin: lead.state.wheelSpin,
        throttle: lead.current.throttle,
      });
    } else {
      sound.update({ wheelSpeed: 0, speed: 0, slipAngle: 0, wheelSpin: 0, throttle: 0 });
    }

    // ---- Tire smoke — emitted PER CAR. The Effects pool is hard-capped
    // (FX_CONFIG.maxParticles) and shared, so N cars can't blow the budget.
    for (const car of cars.values()) emitCarSmoke(car, realDt);
    fx.update(realDt);
  } else {
    // Paused: idle the engine so it doesn't hold a note. Everything else frozen.
    sound.update({ wheelSpeed: 0, speed: 0, slipAngle: 0, wheelSpin: 0, throttle: 0 });
  }

  // Render ALWAYS (paused frame still draws the frozen car + overlay on top).
  render();
  updateRaceHud(raceManager.hud(primaryCar()?.slot ?? -1, gameNow));
  updateXpHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Render ----------
function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  // Fill the whole viewport first so the letterbox/pillarbox margins of a fixed-
  // world map are clean. The desktop world fully overdraws this.
  ctx.fillStyle = '#05030d';
  ctx.fillRect(0, 0, W, H);

  // Screen shake wraps every world layer (HUD is HTML, unaffected).
  const shake = fx.shakeOffset();
  ctx.save();
  ctx.translate(shake.x, shake.y);

  // Static layers (logical bitmaps) → blit into the fitted, centred rectangle
  // with a UNIFORM scale (never stretched). Desktop: offset 0, scale 1 ⇒ 1:1.
  const dw = logicalPxW * viewScale, dh = logicalPxH * viewScale;
  ctx.drawImage(wallpaperCanvas, viewOffX, viewOffY, dw, dh);
  ctx.drawImage(skidCanvas, viewOffX, viewOffY, dw, dh);
  ctx.drawImage(overlayCanvas, viewOffX, viewOffY, dw, dh);

  // Dynamic layers draw in LOGICAL pixel space; the same uniform scale + offset
  // fits them to the window, so cars/gates/fx track the world exactly.
  ctx.save();
  ctx.translate(viewOffX, viewOffY);
  ctx.scale(viewScale, viewScale);
  currentMap.drawForeground?.(ctx, world, CONFIG.pxPerMeter);
  drawRaceElements();
  for (const car of cars.values()) drawCar(car);  // paint every connected car
  fx.draw(ctx, CONFIG.pxPerMeter);
  ctx.restore();

  ctx.restore();
  updateHud();
}

// The single gameplay HUD reflects the PRIMARY car (lowest slot). With no car
// connected it idles at zeros so nothing reads stale.
function updateHud() {
  const lead = primaryCar();
  const s = lead?.state;
  const cur = lead?.current;

  // Fake "km/h" so it reads like a dashboard. 1 m/s ≈ 3.6 km/h.
  const kmh = Math.round((s?.speed ?? 0) * 3.6);
  speedEl.textContent = String(kmh).padStart(3, '0');

  // GRIP / DRIFT badge — LATERAL sliding only (p9). A straight-line
  // burnout spins the wheels but isn't a drift; the badge keys off the
  // rear slip angle alone. (Skid marks still include pure wheelspin —
  // burnout stripes are a feature.)
  const drifting = Math.abs(s?.rearSlip ?? 0) > CONFIG.slipThresholdForSkid;
  driftEl.textContent = drifting ? 'DRIFT' : 'GRIP';
  driftEl.classList.toggle('on', drifting);

  // Live rear slip angle in degrees. Signed (+ = sliding one way, - the
  // other) so the tuner can see direction at a glance.
  if (rearSlipValEl) {
    const slipDeg = (s?.rearSlip ?? 0) * 180 / Math.PI;
    const sign = slipDeg >= 0 ? '+' : '';
    rearSlipValEl.textContent = sign + slipDeg.toFixed(1) + '°';
  }

  // Rear wheelspin as a percentage. 0% while the tire grips (even at full
  // throttle), >0% only when the rear is saturated — burnout, handbrake
  // lock, or power-over spin.
  if (wspinValEl) {
    wspinValEl.textContent = Math.round((s?.wheelSpin ?? 0) * 100) + '%';
  }

  // Pedal bars — show smoothed (current) values, what the physics actually
  // sees, not the raw 30Hz packet. 0 = empty, 1 = full.
  if (throttleBarEl) throttleBarEl.style.height = ((cur?.throttle ?? 0) * 100).toFixed(0) + '%';
  if (brakeBarEl)    brakeBarEl.style.height    = ((cur?.brake    ?? 0) * 100).toFixed(0) + '%';
  if (handbrakeHudEl) handbrakeHudEl.classList.toggle('on', !!cur?.handbrake);
  // Steer marker — same smoothed value the physics sees. Linear: 50% = neutral,
  // 0% = full left (−1), 100% = full right (+1).
  if (steerMarkerEl) {
    const st = Math.max(-1, Math.min(1, cur?.steer ?? 0));
    steerMarkerEl.style.left = (50 + st * 50).toFixed(1) + '%';
  }

  if (debugOn && s && cur) {
    // Mirror the physics gates so the screen shows WHY a burnout/spin did or
    // didn't fire from the real commanded values. The low-speed power-over boost
    // is now STEER-GATED (straight = traction, turned = wheelspin): the readout
    // shows the SAME effective multiplier the force path applies.
    const boostSteer = Math.max(0, Math.min(1,
      (Math.abs(cur.steer) - CONFIG.boostSteerDead) /
      (CONFIG.boostSteerFull - CONFIG.boostSteerDead)));
    const boostFade = Math.max(0, 1 - s.speed / CONFIG.torqueBoostFadeSpeed);
    const boostMult =
      1 + CONFIG.lowSpeedTorqueBoost * boostFade * boostSteer * cur.throttle;
    const armT = cur.handbrake
      ? CONFIG.spinReleaseThresholdHB : CONFIG.spinReleaseThreshold;
    // |v| and yaw with 3 decimals so a true rest reads EXACTLY 0.000 (the
    // creep-fix verification); `rest=Y` when the hard-park lock is engaged.
    const parked = cur.throttle < 0.02 && cur.brake < 0.02 && !cur.handbrake
      && s.speed < CONFIG.restSpeed;
    debugEl.textContent =
      `slot ${lead!.slot}   steer ${cur.steer.toFixed(2)}   (spin-arm ≥ ${armT.toFixed(2)}${cur.handbrake ? ' HB' : ''})\n` +
      `throttle ${cur.throttle.toFixed(2)}  brake ${cur.brake.toFixed(2)}  hb ${cur.handbrake ? 'ON' : 'off'}\n` +
      `|v| ${s.speed.toFixed(3)} m/s   yaw ${s.angularVel.toFixed(3)} rad/s   rest=${parked ? 'Y' : 'n'} (≤${CONFIG.restSpeed})\n` +
      `power-over boost ×${boostMult.toFixed(2)}   (steer-gate ${(boostSteer * 100).toFixed(0)}% · throttle-gated)\n` +
      `spinTimer ${s.spinTimer.toFixed(2)}  drift ${s.driftActive ? 'Y' : 'n'}  wspin ${(s.wheelSpin * 100).toFixed(0)}%   cars ${cars.size}`;
  } else if (debugOn) {
    debugEl.textContent = `no car connected   cars ${cars.size}`;
  }
}

// ---------- Race elements: synthwave gates + checkpoint rings ----------
const RACE_GREEN = '#39ff6a';
const RACE_MAGENTA = '#ff2d95';
const RACE_CYAN = '#2de2e6';

type GateKind = 'start' | 'finish' | 'startfinish';

function drawRaceElements() {
  // Circuit maps draw their OWN start/finish line (the map's checkered band);
  // the built-in race element is detection-only, so skip drawing gates here.
  if (isCircuitMap()) return;
  const px = PX();
  const collected = raceManager.collectedElementIndices(primaryCar()?.slot ?? -1);
  // In a circuit (start, no finish) the START gate is also the finish line.
  const circuit = isCircuitTrack(raceElements);
  raceElements.forEach((e, i) => {
    const sx = e.x * px, sy = e.y * px;
    const rPx = (e.radius ?? RACE_CONFIG.gateRadius) * px;
    if (e.type === 'checkpoint') {
      drawCheckpoint(sx, sy, rPx, e.index ?? 0, !editorMode && collected.has(i));
    } else {
      const kind: GateKind =
        e.type === 'finish' ? 'finish' : circuit ? 'startfinish' : 'start';
      drawGate(sx, sy, rPx, e.angle ?? 0, kind);
    }
  });
}

function drawGate(sx: number, sy: number, rPx: number, angle: number, kind: GateKind) {
  const startish = kind === 'start' || kind === 'startfinish';
  const color = startish ? RACE_GREEN : RACE_MAGENTA;
  const half = rPx;            // bar half-width ≈ the trigger zone
  ctx.save();
  // faint trigger-zone wash
  ctx.fillStyle = startish ? 'rgba(57,255,106,0.06)' : 'rgba(255,45,149,0.06)';
  ctx.beginPath(); ctx.arc(sx, sy, rPx, 0, Math.PI * 2); ctx.fill();

  ctx.translate(sx, sy);
  ctx.rotate(angle);
  ctx.lineCap = 'round';
  if (kind === 'start') {
    // Plain start line — solid green bar.
    ctx.shadowColor = color; ctx.shadowBlur = 16;
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-half, 0); ctx.lineTo(half, 0); ctx.stroke();
  } else {
    // Checkered bar — magenta for a sprint FINISH, green when the circuit's
    // START gate doubles as the finish line.
    ctx.shadowColor = color; ctx.shadowBlur = 12;
    const n = 8, sw = (half * 2) / n;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 === 0 ? color : '#ffffff';
      ctx.fillRect(-half + i * sw, -4.5, sw, 9);
    }
  }
  // Bright posts at the ends.
  ctx.shadowColor = color; ctx.shadowBlur = 14;
  ctx.fillStyle = color;
  ctx.fillRect(-half - 3, -11, 6, 22);
  ctx.fillRect(half - 3, -11, 6, 22);
  ctx.restore();

  // Label above (unrotated).
  const label = kind === 'finish' ? 'FINISH'
    : kind === 'startfinish' ? 'START / FINISH' : 'START';
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 10;
  ctx.fillStyle = color;
  ctx.font = '700 13px Orbitron, ui-monospace, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, sx, sy - rPx - 9);
  ctx.restore();
}

function drawCheckpoint(sx: number, sy: number, rPx: number, index: number, done: boolean) {
  ctx.save();
  ctx.shadowColor = RACE_CYAN; ctx.shadowBlur = done ? 5 : 16;
  ctx.strokeStyle = done ? 'rgba(45,226,230,0.32)' : RACE_CYAN;
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(sx, sy, rPx, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = done ? 'rgba(45,226,230,0.03)' : 'rgba(45,226,230,0.08)';
  ctx.beginPath(); ctx.arc(sx, sy, rPx, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = done ? 'rgba(45,226,230,0.5)' : RACE_CYAN;
  ctx.font = '700 15px Orbitron, ui-monospace, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(index), sx, sy + 1);
  ctx.restore();
}

// ---------- Race HUD (functional readout; independent of the D/Q debug toggles) ----------
function updateRaceHud(h: RaceHud) {
  if (!raceHudEl) return;
  if (editorMode || isXpMode()) {  // editor/XP mode: lap+timer HUD hidden
    raceHudEl.hidden = true;
    if (raceFinishEl) raceFinishEl.hidden = true;
    return;
  }
  if (!h.active) {
    raceHudEl.hidden = true;
    if (raceFinishEl) raceFinishEl.hidden = true;
    return;
  }
  raceHudEl.hidden = false;
  if (raceTimerEl) raceTimerEl.textContent = formatRaceTime(h.elapsedMs);
  if (raceCpEl)  raceCpEl.textContent  = h.cpTotal > 0 ? `CP ${h.cpCollected}/${h.cpTotal}` : '';
  if (raceLapEl) raceLapEl.textContent = `LAP ${h.lap}/${h.laps}`;
  // The single-car "FINISH" card is superseded by the live feed + podium.
  if (raceFinishEl) raceFinishEl.hidden = true;
}

// XP MODE HUD: big score top-centre + drift multiplier, blinking under the slow
// warning. The end card is shown by handleXpEnd / hidden by startXpRun; here we
// only keep it (and the live HUD) tucked away when not actually playing XP mode.
function updateXpHud() {
  const playing = isXpMode() && !editorMode && !menuOpen;
  if (xpHudEl) xpHudEl.hidden = !playing || xpRun.ended;
  if (xpEndEl) {
    if (!isXpMode() || editorMode || menuOpen) xpEndEl.hidden = true;
    else if (xpRun.ended && xpEndHandled) xpEndEl.hidden = false;
  }
  if (!playing || xpRun.ended) return;
  if (xpScoreEl) xpScoreEl.textContent = formatXp(xpRun.xp);
  if (xpMultEl) {
    const drifting = xpRun.mult > 1.05;
    xpMultEl.hidden = !drifting;
    if (drifting) xpMultEl.textContent = '×' + xpRun.mult.toFixed(1);
  }
  if (xpHudEl) xpHudEl.classList.toggle('warn', xpRun.warning);
}

// ---------- Drawing: top-down Blitz RS (early-90s RWD drift coupe) ----------
// Vector-drawn each frame from the slot's base colour (shadeHex lightens >1 /
// darkens <1) so every player's car recolours for free. Footprint matches the
// physics body (1.5 m × 0.617 m); tyres sit at the physics wheel positions. A
// sculpted boxy coupe — long hood, 3-box cabin, twin round headlights, slim slat
// grille, chrome window/bumper trim, boxy door mirrors, a ducktail, and dark
// tyre-tops (no rim shows from straight above). +x = front. All marks ORIGINAL:
// it evokes the era and copies no real car.
function drawCar(car: Car) {
  const s = car.state;
  const base = car.color;
  const crown   = shadeHex(base, 1.28);   // lit spine
  const edge    = shadeHex(base, 0.52);   // dark flanks / AO
  const outline = shadeHex(base, 0.34);   // crisp body outline
  const roofCol = shadeHex(base, 1.12);   // roof panel
  const LOWER = '#24272e', CHROME = '#cdd2d9', TYRE = '#15161b';

  ctx.save();
  ctx.translate(s.x * PX(), s.y * PX());
  ctx.rotate(s.heading);
  ctx.scale(PX(), PX());

  const L = 0.75, W = 0.309;                 // half-length / half-width (footprint)
  const hw = CONFIG.wheelbase / 2, ht = CONFIG.trackWidth / 2;

  // 1. Ground drop shadow (screen-space offset so light stays fixed as it turns).
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.40)'; ctx.shadowBlur = 13;
  ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 7;
  ctx.fillStyle = '#000'; blitzBody(ctx, L, W); ctx.fill();
  ctx.restore();

  // 2. Tyres (dark rubber only — rims live on the wheel's SIDE face, unseen from
  // directly above). Drawn UNDER the body so they tuck into the arches; track is
  // the physics track (narrower than the body → natural tuck). Fronts steer.
  drawTyre(hw, -ht, s.steerAngle, TYRE);
  drawTyre(hw,  ht, s.steerAngle, TYRE);
  drawTyre(-hw, -ht, 0, TYRE);
  drawTyre(-hw,  ht, 0, TYRE);

  // 3. Body shell — cross-width gradient (lit crown down the spine → dark flanks).
  const bg = ctx.createLinearGradient(0, -W, 0, W);
  bg.addColorStop(0.00, edge); bg.addColorStop(0.30, base);
  bg.addColorStop(0.50, crown); bg.addColorStop(0.70, base); bg.addColorStop(1.00, edge);
  blitzBody(ctx, L, W);
  ctx.save();
  ctx.fillStyle = bg; ctx.fill();
  ctx.clip();   // interior detail clipped to the silhouette
  // specular sheen down the spine
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, -L + 0.10, -0.05, L * 2 - 0.20, 0.10, 0.05); ctx.fill();
  // lower-body sills along both flanks (graphite two-tone)
  ctx.fillStyle = LOWER;
  ctx.fillRect(-0.46, W - 0.034, 0.92, 0.034);
  ctx.fillRect(-0.46, -W, 0.92, 0.034);
  // hood shut-lines (paired emboss) + a faint centre crease
  ctx.lineWidth = 0.01;
  ctx.strokeStyle = 'rgba(0,0,0,0.26)';
  ctx.beginPath(); ctx.moveTo(0.16, 0.175); ctx.lineTo(0.70, 0.155);
  ctx.moveTo(0.16, -0.175); ctx.lineTo(0.70, -0.155); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath(); ctx.moveTo(0.16, 0.187); ctx.lineTo(0.70, 0.167);
  ctx.moveTo(0.16, -0.187); ctx.lineTo(0.70, -0.167); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath(); ctx.moveTo(0.18, 0); ctx.lineTo(0.70, 0); ctx.stroke();
  // cowl + deck shut-lines (across the width)
  ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 0.012;
  ctx.beginPath(); ctx.moveTo(0.15, -0.20); ctx.lineTo(0.15, 0.20);
  ctx.moveTo(-0.34, -0.20); ctx.lineTo(-0.34, 0.20); ctx.stroke();
  ctx.restore();   // un-clip
  // body outline
  blitzBody(ctx, L, W);
  ctx.strokeStyle = outline; ctx.lineWidth = 0.02; ctx.stroke();

  // 4. Greenhouse — windshield, roof panel, rear window. Tinted glass + a sheen,
  // thin chrome surround; the cabin is set back behind the long hood.
  drawGlass([[0.15, -0.20], [0.15, 0.20], [0.02, 0.18], [0.02, -0.18]]);
  ctx.fillStyle = roofCol;
  roundRect(ctx, -0.18, -0.205, 0.20, 0.41, 0.045); ctx.fill();
  ctx.strokeStyle = CHROME; ctx.lineWidth = 0.012;
  roundRect(ctx, -0.18, -0.205, 0.20, 0.41, 0.045); ctx.stroke();
  drawGlass([[-0.20, -0.185], [-0.20, 0.185], [-0.34, 0.165], [-0.34, -0.165]]);

  // 5. Roof number (NO roundel) — white with a dark outline so it reads on any
  // body colour.
  const n = String(car.slot + 1);
  ctx.font = 'bold 0.24px Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 0.035; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(n, -0.08, 0.006);
  ctx.fillStyle = '#f5f7fb'; ctx.fillText(n, -0.08, 0.006);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

  // 6. Front — bumper (chrome strip), twin round headlights, slim slat grille,
  // amber indicators.
  ctx.fillStyle = LOWER;
  roundRect(ctx, L - 0.05, -0.235, 0.05, 0.47, 0.02); ctx.fill();
  ctx.strokeStyle = CHROME; ctx.lineWidth = 0.012;
  ctx.beginPath(); ctx.moveTo(L - 0.012, -0.21); ctx.lineTo(L - 0.012, 0.21); ctx.stroke();
  ctx.fillStyle = '#101115';
  roundRect(ctx, L - 0.085, -0.085, 0.06, 0.17, 0.015); ctx.fill();   // grille
  ctx.strokeStyle = '#3d424b'; ctx.lineWidth = 0.008;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath(); ctx.moveTo(L - 0.082, i * 0.045); ctx.lineTo(L - 0.03, i * 0.045); ctx.stroke();
  }
  for (const ly of [0.085, 0.20, -0.085, -0.20]) {   // twin round lamps each side
    const r = Math.abs(ly) > 0.15 ? 0.05 : 0.044;
    ctx.fillStyle = '#0e0f12'; ctx.beginPath(); ctx.arc(L - 0.055, ly, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#eef0e8'; ctx.beginPath(); ctx.arc(L - 0.055, ly, r - 0.008, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = CHROME; ctx.lineWidth = 0.008;
    ctx.beginPath(); ctx.arc(L - 0.055, ly, r - 0.008, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(L - 0.07, ly - 0.014, 0.012, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#f4a72a';
  roundRect(ctx, L - 0.045, 0.235, 0.035, 0.04, 0.01); ctx.fill();
  roundRect(ctx, L - 0.045, -0.275, 0.035, 0.04, 0.01); ctx.fill();

  // 7. Boxy door mirrors on short stalks at the cabin front.
  for (const my of [W + 0.02, -(W + 0.055)]) {
    ctx.fillStyle = base;
    roundRect(ctx, 0.05, my, 0.07, 0.035, 0.012); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.008;
    roundRect(ctx, 0.05, my, 0.07, 0.035, 0.012); ctx.stroke();
    ctx.fillStyle = '#0e1521';
    roundRect(ctx, 0.062, my + 0.006, 0.046, 0.023, 0.008); ctx.fill();
  }

  // 8. Rear — ducktail lip (raised), simple twin taillights + centre panel,
  // bumper with chrome strip, subtle twin exhaust.
  ctx.fillStyle = base;
  roundRect(ctx, -0.66, -0.255, 0.055, 0.51, 0.02); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  roundRect(ctx, -0.66, -0.255, 0.02, 0.51, 0.02); ctx.fill();   // lit lip edge
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(-0.612, -0.255, 0.006, 0.51);
  ctx.fillStyle = '#d23b33';
  roundRect(ctx, -0.715, -0.215, 0.05, 0.165, 0.015); ctx.fill();
  roundRect(ctx, -0.715,  0.05, 0.05, 0.165, 0.015); ctx.fill();
  ctx.fillStyle = 'rgba(255,150,140,0.65)';
  roundRect(ctx, -0.71, -0.205, 0.04, 0.05, 0.01); ctx.fill();
  roundRect(ctx, -0.71,  0.155, 0.04, 0.05, 0.01); ctx.fill();
  ctx.fillStyle = LOWER;
  roundRect(ctx, -L, -0.235, 0.05, 0.47, 0.02); ctx.fill();
  ctx.strokeStyle = CHROME; ctx.lineWidth = 0.012;
  ctx.beginPath(); ctx.moveTo(-L + 0.012, -0.21); ctx.lineTo(-L + 0.012, 0.21); ctx.stroke();
  ctx.fillStyle = '#3a3d44';
  roundRect(ctx, -L - 0.012, -0.075, 0.03, 0.05, 0.012); ctx.fill();
  roundRect(ctx, -L - 0.012,  0.025, 0.03, 0.05, 0.012); ctx.fill();

  ctx.restore();
}

// Tinted glass pane (windshield / rear window) with a soft reflection sheen
// clipped to the pane. `pts` are body-space metres.
function drawGlass(pts: Array<[number, number]>) {
  let minX = Infinity, maxX = -Infinity;
  for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; }
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  // Slight gradient across the glass — darker at the base, lighter toward front.
  const gg = ctx.createLinearGradient(minX, 0, maxX, 0);
  gg.addColorStop(0, '#0e1421');
  gg.addColorStop(1, '#1c2b45');
  ctx.fillStyle = gg;
  ctx.fill();
  // Reflection streak — a soft light band, clipped inside the pane.
  ctx.clip();
  const w = maxX - minX;
  ctx.fillStyle = 'rgba(150, 182, 226, 0.16)';
  ctx.beginPath();
  ctx.moveTo(minX, -1);
  ctx.lineTo(minX + w * 0.45, -1);
  ctx.lineTo(minX + w * 0.28, 1);
  ctx.lineTo(minX, 1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Sculpted top-down coupe silhouette (meters, +x = front). Flowing flanks with
// front/rear arch bulges to the half-width and a slight waist, tapered nose/
// tail — boxy-but-sleek, not slab. Used for the body fill, clip, outline and the
// ground shadow so they all share one shape.
function blitzBody(c: CanvasRenderingContext2D, L: number, W: number) {
  c.beginPath();
  c.moveTo(L - 0.05, -0.20);
  c.quadraticCurveTo(L, -0.13, L, 0);
  c.quadraticCurveTo(L, 0.13, L - 0.05, 0.20);
  c.bezierCurveTo(L - 0.18, 0.30, 0.50, W, 0.40, W);
  c.bezierCurveTo(0.22, W, 0.10, 0.295, 0.0, 0.295);
  c.bezierCurveTo(-0.18, 0.295, -0.34, W, -0.45, W);
  c.bezierCurveTo(-0.58, W, -0.66, 0.27, -0.70, 0.22);
  c.quadraticCurveTo(-L, 0.14, -L, 0);
  c.quadraticCurveTo(-L, -0.14, -0.70, -0.22);
  c.bezierCurveTo(-0.66, -0.27, -0.58, -W, -0.45, -W);
  c.bezierCurveTo(-0.34, -W, -0.18, -0.295, 0.0, -0.295);
  c.bezierCurveTo(0.10, -0.295, 0.22, -W, 0.40, -W);
  c.bezierCurveTo(0.50, -W, L - 0.18, -0.30, L - 0.05, -0.20);
  c.closePath();
}

// A tyre as seen from DIRECTLY above: just the dark rubber top (the rim is on
// the wheel's side face, not visible from a bird's-eye view). A faint lengthwise
// crown sheen sells the roundness. Fronts pass the live steer angle.
function drawTyre(bx: number, by: number, angle: number, col: string) {
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(angle);
  ctx.fillStyle = col;
  roundRect(ctx, -0.15, -0.057, 0.30, 0.114, 0.028); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  roundRect(ctx, -0.15, -0.018, 0.30, 0.036, 0.02); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.01;
  roundRect(ctx, -0.15, -0.057, 0.30, 0.114, 0.028); ctx.stroke();
  ctx.restore();
}

function roundRect(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

// ---------- Map switching ----------
// Swap the active map: rebuild the world + static layers, clear skids, reset
// the race track (per-map; cleared on switch for now), exit the editor, and
// respawn every connected car at the new map's spawn layout. The render loop,
// collisions, spawn and wrap already read `currentMap`/`world`, so they follow
// automatically. Returns false for an unknown id.
function switchMap(id: string): boolean {
  const def = getMap(id);
  if (!def) {
    console.warn(`[map] unknown id "${id}". available:`, listMaps().map((m) => m.id));
    return false;
  }
  currentMap = def;

  // Force a full re-layout at the NEW map's logical size (fixed for the oval,
  // viewport for the desktop): mark the offscreen layers stale so resize()
  // rebuilds the world + static layers + view transform for this map.
  logicalPxW = logicalPxH = 0;
  resize();
  skidCtx.clearRect(0, 0, logicalPxW, logicalPxH);   // drop the previous map's skids

  // Reset the (per-map) race track and leave the editor if it was open. Lap
  // default per type: OPEN → 1 lap (RACE_CONFIG); CIRCUIT → 0 = free-roam (just
  // cruise/drift the oval until the host sets a lap count). rebuildRace then
  // regenerates the circuit's built-in start line (or leaves it empty at 0).
  if (editorMode) { editorMode = false; refreshFreeze(); }
  clearElements(raceElements);
  editorLaps = currentMap.trackType === 'circuit' ? 0 : RACE_CONFIG.laps;
  // Every map starts in LAPS mode; the host opts into XP mode via the editor.
  circuitMode = 'laps';
  document.body.classList.remove('circuit-xp');
  if (xpEndEl) xpEndEl.hidden = true;
  syncModeButtons();
  rebuildRace();
  updateEditorStatus();

  // Respawn each connected car at the new map's spawn (fresh physics state,
  // keep its colour/inputs). No car ⇒ nothing to respawn.
  for (const [slot, car] of cars) {
    const pose = currentMap.spawn(slot, world);
    car.state = makeCar(pose.x, pose.y, pose.heading);
    car.skidL.active = false;
    car.skidR.active = false;
  }
  console.info(`[map] switched to "${def.id}" (${def.name})`);
  return true;
}

// Temporary DEV verification hook (no menu yet — that lands once a 2nd map
// exists). In the console: `steerMaps()` lists registered maps; `steerSwitchMap('id')`
// switches. Proves switchMap() works without any UI.
(window as unknown as {
  steerSwitchMap: (id: string) => boolean;
  steerMaps: () => Array<{ id: string; name: string }>;
}).steerSwitchMap = switchMap;
(window as unknown as {
  steerMaps: () => Array<{ id: string; name: string }>;
}).steerMaps = listMaps;
