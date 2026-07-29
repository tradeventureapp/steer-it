import QRCode from 'qrcode';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { channelName, createResilientChannel } from './supabase';
import { createRtcHost, connectionInfoOf, createFallbackTracker, RTC_EV } from './rtc';
import {
  CONFIG, makeCar, bodyToWorld, collideWithRects, collideWithArcs,
  type CarState, type Inputs,
} from './vehicle-core';
import { collideCars, applyInputs } from './cars';
import { TyreMarks } from './marks';
import {
  getMap, listMaps, DEFAULT_MAP_ID, markClassAt, setCircuitSurfaceReady,
  circuitFitDebug,
  type MapDefinition, type MapWorld, type MapObstacle, type Surface, type MarkClass,
} from './maps';
import { fitCanvasScale, sizeCanvasFitted, preloadSurfaceAssets, clearSurfaceCaches,
  surfaceCacheStats } from './surfaces';
import { Effects, FX_CONFIG, GRASS_DUST_RGB, GRAVEL_SPRAY_RGB } from './effects';
import { startPageEscort } from './page-escort';
import { startHowScene } from './how-anim';
import { createMusicPlayer } from './music';
import { collectDiag, noteError, noteStep } from './diag';
import {
  PLAYER_CAP, LOBBY_SYNC_MS, RESILIENCE, EV, colorName, LobbyState, paletteForMode,
} from './lobby';
import { ROAD_SPEC, STEEREX_SILVER, STEEREX_BLACK, STEEREX_SKIN_COLORS, BLITZ_RS_COLORS,
  type VehicleSpec, type CarColor } from './vehicles';
import { steerexSprite, steerexScaled, steerexOpaque, preloadSteerex, type SteerexSkin } from './steerex-sprite';
import { step4, PHYS4, wheelDebug, type Physics4Params } from './physics4';

// physics4 (the per-wheel sim — Blitz RS) is THE drive model: every car, every
// map, always. The old kinematic arcade branch and its X toggle are retired; a
// forgiving arcade CAR (a physics4 tune) is a future second vehicle, not a mode.
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
import {
  initAuth, onAuthChange, getAuthState, signIn, signUp, signOut,
  sendPasswordReset, updatePassword, checkEntitlement, getAccessToken,
  checkNickname, changeNickname, hasSessionHint, type AuthState,
} from './auth';
import { nicknameFormatError, nicknameCooldownDaysLeft } from './nickname';

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
// The race MODE (= physics branch + car family), chosen in the menu. Declared HERE, above
// the QR, because the join URL carries it: `?m=arcade|sim` lets a scanning phone paint the
// RIGHT car's colour picker on its very first frame (no flash of the other car's palette
// while it waits for the host's first lobby message). The lobby message remains the
// authority and corrects a stale URL; the param is purely a first-paint hint.
let raceMode: RaceMode = 'sim';
const playUrl = () => `${publicBase}/play?s=${code}&m=${raceMode}`;

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
const liveStandingsEl = document.getElementById('live-standings')   as HTMLElement | null;
const raceResultsEl   = document.getElementById('race-results')     as HTMLElement | null;
const resultsRestEl   = document.getElementById('results-rest')     as HTMLElement | null;
const countdownEl   = document.getElementById('countdown')     as HTMLElement | null;
const countdownNEl  = document.getElementById('countdown-n')   as HTMLElement | null;
const finishTimeoutEl = document.getElementById('finish-timeout') as HTMLElement | null;
const xpHudEl       = document.getElementById('xp-hud')        as HTMLElement | null;
const xpScoreEl     = document.getElementById('xp-score')      as HTMLDivElement | null;
const xpMultEl      = document.getElementById('xp-mult')       as HTMLDivElement | null;
const xpComboEl     = document.getElementById('xp-combo')      as HTMLDivElement | null;
const xpComboFillEl = document.getElementById('xp-combo-fill') as HTMLDivElement | null;
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
const hudBlEl        = document.getElementById('hud-bl')         as HTMLElement | null;
const hudTrEl        = document.getElementById('hud-tr')         as HTMLElement | null;
const pauseOverlayEl = document.getElementById('pause-overlay')  as HTMLElement | null;
const editorEl       = document.getElementById('editor')         as HTMLElement | null;
const editorStatusEl = document.getElementById('editor-status')  as HTMLDivElement | null;
const editorHintEl   = document.getElementById('editor-hint')    as HTMLDivElement | null;
const mainMenuEl     = document.getElementById('main-menu')       as HTMLElement | null;
const gameMenuEl     = document.getElementById('game-menu')       as HTMLElement | null;
const optionsModalEl = document.getElementById('options-modal')   as HTMLElement | null;
const premiumPromoEl = document.getElementById('premium-promo')    as HTMLElement | null;
const heroCanvasEl   = document.getElementById('page-car')        as HTMLCanvasElement | null;
const modeSelectEl   = document.getElementById('mode-select')     as HTMLElement | null;
const carMapSelectEl = document.getElementById('car-map-select')  as HTMLElement | null;
const mapTilesEl     = document.getElementById('map-tiles')       as HTMLElement | null;
const carTilesEl     = document.getElementById('car-tiles')       as HTMLElement | null;
const cmsStartBtn    = document.getElementById('btn-cms-start')   as HTMLButtonElement | null;
const modePanelEl    = document.getElementById('mode-panel')      as HTMLElement | null;
const raceReadyEl    = document.getElementById('race-ready')      as HTMLElement | null;
const readyBtn       = document.getElementById('btn-ready')       as HTMLButtonElement | null;
const raceLapsEl     = document.getElementById('race-laps')       as HTMLElement | null;
const raceLapsOptsEl = document.getElementById('race-laps-opts')  as HTMLElement | null;
const accountBarEl   = document.getElementById('account-bar')     as HTMLElement | null;

// ---------- Freeze: the main menu, pause (P), and the editor (E) each halt the
// simulation + race timer (not the render). isPaused is the combined gate. ----
let userPaused = false;  // toggled by P
let editorMode = false;  // toggled by E
let menuOpen = true;     // the host front-end (menu) shows at startup
let raceResultsOpen = false;  // the multi-car podium is up (freezes the sim)
// RACE WARM-UP: a race map is loaded and cars drive FREELY (no countdown, no lap
// counting) until the host presses READY — which snaps everyone to the grid and
// starts the 3-2-1-GO. While true the race is in its free-roam state (no elements),
// so late joiners can warm up; `pendingRaceLaps` is the lap count READY commits.
let raceWarmup = false;
let pendingRaceLaps = 3;   // overwritten on each warm-up entry (default = MENU_RACE_LAPS)
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
  updateReadyButton();
  // host account chip — menu screens only, but NOT the game menu (its own account
  // panel lives in OPTIONS there).
  if (accountBarEl) accountBarEl.hidden = !menuOpen || !(gameMenuEl?.hidden ?? true);
}

// The READY button shows ONLY during a race warm-up and only when nothing else is
// on top (menu / pause / editor / results). Pressing it starts the race.
function updateReadyButton() {
  const show = raceWarmup && !menuOpen && !userPaused && !editorMode && !raceResultsOpen;
  if (raceReadyEl) raceReadyEl.hidden = !show;
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

// =============================================================================
//  DEV TUNER FLAG — the D-key debug HUD + the PHYSICS4 TUNE panel are OFF for
//  players. Everything below is kept intact and disabled by this ONE constant:
//    • false → the tuner rows are never built, the panels never show, and the
//      D key does nothing at all.
//    • true  → the full debug HUD + live knob panel come back exactly as before.
//  TO RESTORE LATER (once accounts/login exist): flip this to true and gate it on
//  the dev-account flag instead — no other change is needed anywhere.
//  Typed `boolean` (not the literal `false`) so TS keeps type-checking both branches.
// =============================================================================
const DEV_TUNER: boolean = false;

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
if (DEV_TUNER) {
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;letter-spacing:.5px;margin-bottom:6px;color:#ff8a3d;';
  brakeTunerEl.appendChild(title);

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

  // ---------- PHYSICS4 knobs (per-wheel) — the only model's live tune ----------
  // only the NUMERIC params are steppable (PHYS4.tire is a structured tyre profile)
  type NumKey<T> = { [K in keyof T]-?: T[K] extends number ? K : never }[keyof T];
  const pRow = (label: string, key: NumKey<Physics4Params>,
                stp: number, lo: number, hi: number, d = 2) =>
    mkRow(label, () => PHYS4[key], (v) => { PHYS4[key] = v; }, stp, lo, hi, (v) => v.toFixed(d));
  pRow('massKg',            'massKg',               25,   800, 1800, 0);
  pRow('weightDistFront',   'weightDistFront',      0.01, 0.4, 0.65, 2);
  pRow('cgHeight',          'cgHeight',             0.02, 0.2, 0.9, 2);
  pRow('yawInertiaK',       'yawInertiaK',          0.05, 0.8, 1.8, 2);
  pRow('loadTransLong',     'loadTransferLongGain', 0.1,  0,   2.5, 2);
  pRow('loadTransLat',      'loadTransferLatGain',  0.1,  0,   2.5, 2);
  pRow('muNom (grip)',      'muNom',                0.05, 0.8, 2.5, 2);
  pRow('loadSensitivity',   'loadSensitivity',      0.02, 0,   0.6, 2);
  pRow('tireB (stiffness)', 'tireB',                0.5,  4,   20, 1);
  pRow('tireC (shape)',     'tireC',                0.05, 1.1, 2.0, 2);
  pRow('tireEllipseLong',   'tireEllipseLong',      0.05, 0.5, 1.5, 2);
  pRow('relaxLength',       'relaxLength',          0.05, 0.1, 1.5, 2);
  pRow('lowSpeedBlend',     'lowSpeedBlend',        0.25, 1,   6, 2);
  pRow('maxSteer',          'maxSteer',             0.02, 0.3, 0.8, 2);
  // Fase 1 drive tools
  pRow('peakThrust',        'peakThrust',           500,  3000, 20000, 0);
  pRow('enginePower (W)',   'enginePower',          5000, 60000, 300000, 0);
  pRow('powerFloorSpeed',   'powerFloorSpeed',      0.5,  2,   15, 1);
  pRow('rollRadius',        'rollRadius',           0.01, 0.2, 0.45, 2);
  pRow('wheelInertia',      'wheelInertia',         0.1,  0.4, 4, 1);
  pRow('brakeForce',        'brakeForce',           500,  5000, 30000, 0);
  pRow('brakeBiasFront',    'brakeBiasFront',       0.05, 0.3, 0.85, 2);
  pRow('tireBx (long stiff)','tireBx',              1,    6,   30, 0);
  pRow('tireCx (long shape)','tireCx',              0.05, 1.1, 2.2, 2);
  pRow('hbKineticMu',       'hbKineticMu',          0.05, 0.4, 1.2, 2);
  pRow('dragCoef',          'dragCoef',             0.1,  0,   4, 2);
  pRow('rollResist',        'rollResist',           50,   0,   1200, 0);
  pRow('engineBrakeTorque', 'engineBrakeTorque',    50,   0,   2000, 0);
  pRow('engBrakeSlideFade', 'engineBrakeSlideFade', 0.05, 0,   1, 2);
  pRow('wheelInertiaSlide', 'wheelInertiaSlideFactor', 0.05, 0.2, 1, 2);
  pRow('wheelReturnRate',   'wheelReturnRate',      1,    0,   30, 0);
  pRow('pneumaticTrail',    'pneumaticTrail',       0.01, 0,   0.5, 2);
  pRow('trailPeakSlip',     'trailPeakSlip',        0.01, 0.05, 0.3, 2);
  pRow('yawDampConst',      'yawDampConst',         20,   0,   800, 0);
  pRow('reverseSpeed',      'reverseSpeed',         0.5,  3,   12, 1);
  pRow('reverseForce',      'reverseForce',         500,  2000, 12000, 0);
  pRow('reverseDelay',      'reverseDelay',         0.05, 0.1, 1.5, 2);
  // GRAVEL — three decoupled knobs, each owning ONE behaviour: const = how hard it is to
  // crawl OUT on a feathered throttle, quad = how hard it BRAKES at speed (stone
  // displacement ∝v²), digGain = how deep a SPINNING wheel buries itself. Tune independently.
  pRow('gravelDragConst',   'gravelDragConst',      25,   100, 900, 0);
  pRow('gravelDragQuad',    'gravelDragQuad',       0.25, 0,   8,   2);
  pRow('gravelDigGain',     'gravelDigGain',        0.5,  0,   12,  1);

  title.textContent = 'PHYSICS4 TUNE — per-wheel (live, resets on reload)';
}

// ---------- Visual effects ----------
// SOUND IS REMOVED (parked): there is no audio in the game for now — no engine note,
// no impact sound, no toggle button, no M key. `src/sound.ts` (the WebAudio SoundEngine)
// is deliberately LEFT IN THE REPO but is no longer imported or instantiated, so nothing
// can play and it tree-shakes out of the bundle. To bring sound back: re-import
// SoundEngine here, re-add `const sound = new SoundEngine()`, the sound.update(...) calls
// in the loop, sound.impact(...) on collisions, and the toggle button + M key.
const fx = new Effects();
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
  // D = debug HUD + PHYSICS4 TUNE panel — DEV ONLY (see DEV_TUNER above). With the
  // flag off the key is inert; flip DEV_TUNER to true to get the whole thing back.
  if (DEV_TUNER && (e.key === 'd' || e.key === 'D')) {
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
    // Options is an overlay above the pause menu — Esc/P closes it first (a natural
    // "back") rather than unpausing underneath it.
    if (optionsModalEl && !optionsModalEl.hidden) { closeOptions(); return; }
    if (!editorMode) {
      userPaused = !userPaused; refreshFreeze();   // no-op in the editor
      if (userPaused) maybeShowPremiumPromo();      // promo on PAUSE (free/anon, capped)
    }
  }
  if (e.key === 'e' || e.key === 'E') {
    if (editorMode) {
      editorMode = false;
      rebuildRace();                  // exiting → apply the built track (fresh race)
      refreshFreeze();
      updateEditorStatus();
      return;
    }
    // Entering the editor is gated. The E editor is the ONLY path to a RACE on the
    // Desktop free map (place START/FINISH → exit → rebuildRace runs it), so it was a
    // backdoor around the map/mode paywall. Restrict it: DESKTOP map only, and PREMIUM
    // only. Off the desktop → nothing. Free/anon on desktop → the premium upsell (the
    // same positive prompt as a locked map/mode), never the editor.
    if (currentMap.id !== 'desktop') return;              // ovals/circuit/flat-track: no editor
    if (!isPremium()) { openUpsell('generic'); return; }  // free/anon → pitch premium, not the editor
    editorMode = true;
    editorDragIdx = null;             // entering → no stale drag
    refreshFreeze();
    updateEditorStatus();
  }
});

// ---------- Keyboard driving (LOCAL TESTING — no phone / no Supabase needed) -----
// Arrow keys + Space feed the SAME Inputs the phone tilt produces (steer / throttle /
// brake / handbrake) into a LOCAL car at slot 0, via the IDENTICAL physics path — so
// you can drive + test the real feel on the desktop without pairing. A paired phone
// owns slot 0 and the keyboard goes inert; with no phone the keyboard spawns + drives
// the local car. ↑ throttle · ↓ brake/reverse · ←/→ steer · Space handbrake.
const keyDrive = { up: false, down: false, left: false, right: false, hb: false };
const KEY_TO_DRIVE: Record<string, keyof typeof keyDrive> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'hb',
};
function onDriveKey(e: KeyboardEvent, down: boolean) {
  // Don't hijack typing (e.g. the editor's LAPS number input).
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const k = KEY_TO_DRIVE[e.key];
  if (!k) return;
  e.preventDefault();   // arrows / space would otherwise scroll the page
  keyDrive[k] = down;
}
window.addEventListener('keydown', (e) => onDriveKey(e, true));
window.addEventListener('keyup', (e) => onDriveKey(e, false));

codeText.textContent = code;
// Re-rendered whenever the mode changes (chooseMode) so the QR always encodes the mode the
// phones are about to join — the QR is only ever VISIBLE after a mode + map are chosen.
function renderQr() {
  QRCode.toCanvas(qrCanvas, playUrl(), { width: 160, margin: 1 }).catch(console.error);
}
renderQr();

// ============ HOST FRONT-END: main menu → MODE → CAR & MAP → race ============
// The desktop (host) picks the MODE (= physics branch + car family) and the map
// for everyone; phones are controllers only. Flow:
//   MAIN MENU → START RACE → MODE [ARCADE|SIM] → CAR (left) + MAP (right) → START.
// The chosen MODE decides which cars are offered AND which physics branch every
// phone drives (arcade = Stee-Rex, sim = Blitz RS); each phone then picks its own
// colour/skin after joining. At startup the menu holds the game frozen (no QR
// yet); START respawns connected cars in the chosen variant and drops into play.
type RaceMode = 'arcade' | 'sim';
let selectedMapId: string | null = null;
let selectedCarKey: string | null = null;

// ---- GAME MODES (RACE / XP …) — the in-game mode picked on the CAR & MAP screen.
// This is a DIFFERENT axis from RaceMode (arcade/sim = the car family): a GameMode
// is what you DO on a track. It maps onto the existing circuit `circuitMode`
// ('race' → 'laps', 'xp' → 'xp'). The registry is the single source of truth so a
// NEW mode is one entry here + listing its key in the supporting maps' `gameModes`
// (maps.ts) — the menu filter logic never changes.
interface GameMode {
  key: string;          // matches MapDefinition.gameModes entries
  name: string;         // shown on the picker button/option
  desc: string;         // one-line description under the name
  players: string;      // MULTIPLAYER / SOLO tag — makes the distinction clear
}
const GAME_MODES: GameMode[] = [
  { key: 'free', name: 'FREE RIDE', desc: 'Just drive. No rules, no timer.', players: 'SOLO/MULTI' },
  { key: 'race', name: 'RACE', desc: 'Race your friends — or set your own best time.', players: 'SOLO/MULTI' },
  { key: 'xp', name: 'XP MODE', desc: "Solo. Chain drifts, don't crash, beat your best.", players: 'SOLO' },
];
const DEFAULT_GAME_MODE = 'free';   // FREE RIDE — every map supports it; the resting default
const RACE_LAP_OPTIONS = [1, 3, 5, 10] as const;   // menu lap-count choices for RACE
const MENU_RACE_LAPS = 3;           // default lap count (must be one of RACE_LAP_OPTIONS)
let selectedGameMode: string = DEFAULT_GAME_MODE;
let selectedRaceLaps = MENU_RACE_LAPS;   // the lap count RACE will run (set in the menu)

// The modes a map supports. Every map includes 'free'; the desktop is 'free' ONLY.
function mapGameModes(id: string | null): readonly string[] {
  return (id && getMap(id)?.gameModes) || [DEFAULT_GAME_MODE];
}

// ---- FREE vs PREMIUM gating (host-account entitlement) -----------------------
// FREE needs no account: Desktop + Asphalt Oval, FREE RIDE only, unlimited
// players. Everything else (Circuit, Flat-track dirt oval, RACE, XP MODE, global
// leaderboards) is PREMIUM. The entitlement is server truth (auth.isPremium, read
// from an RLS-protected Supabase row); the checks below gate the UI, and the
// leaderboard write is enforced server-side so a hacked client gains nothing online.
const FREE_MAP_IDS = ['desktop', 'asphalt'];
const FREE_MODE_KEYS = ['free'];
const isPremium = () => getAuthState().isPremium;
// Entitlement still resolving for a logged-in host (a session appeared but the
// profile read hasn't returned and there was no cache to seed from). While true the
// UI must show a neutral "checking…" state, NOT the free/locked one (avoids the flash).
const entitlementPending = (s: AuthState = getAuthState()) => !!s.user && !s.entitlementKnown;
const isMapLocked  = (id: string)  => !isPremium() && !FREE_MAP_IDS.includes(id);
const isModeLocked = (key: string) => !isPremium() && !FREE_MODE_KEYS.includes(key);
// SIM (Blitz RS) is PREMIUM; ARCADE (Stee-Rex) is free for everyone. Same
// server-truth is_premium gate as the maps/modes above (as advertised in the
// Free-vs-Premium table). Enforced at mode selection AND at launch (below).
const isSimLocked = () => !isPremium();

function hideAllMenus() {
  heroDrift?.setActive(false);   // the hero animation only runs on the landing screen
  howScene?.setEnabled(false);   // ...and so does the HOW IT WORKS demo loop
  if (mainMenuEl) mainMenuEl.hidden = true;
  if (gameMenuEl) gameMenuEl.hidden = true;
  if (modeSelectEl) modeSelectEl.hidden = true;
  if (carMapSelectEl) carMapSelectEl.hidden = true;
}
// The page-escort car — ONE Stee-Rex laps a loop in whatever section you're
// looking at (the hero headline orbit up top, HOW IT WORKS below), drifting
// across from one to the next as you scroll, behind all content. Runs ONLY while
// the landing is on screen (the rAF is fully stopped otherwise, so it costs
// nothing in-game or on the other screens). Purely client-side; no state, no net.
const ESCORT_SECTION_NAMES = ['hero', 'how it works', 'free vs premium', 'roadmap'];
const heroDrift = (() => {
  if (!heroCanvasEl || !mainMenuEl) return null;
  const heroEl = mainMenuEl.querySelector('.hero-wrap') as HTMLElement | null;
  const howEl = mainMenuEl.querySelector('.how') as HTMLElement | null;
  const priceEl = mainMenuEl.querySelector('.pricing') as HTMLElement | null;
  const roadEl = mainMenuEl.querySelector('.roadmap') as HTMLElement | null;
  const card = mainMenuEl.querySelector('.menu-card') as HTMLElement | null;
  // EVERY section below the hero gets its own loop slot (undrawn ones fall back to
  // a calm default oval in page-escort). Order defines the section indices.
  const sections = [heroEl, howEl, priceEl, roadEl].filter((e): e is HTMLElement => !!e);
  if (!sections.length) return null;
  return startPageEscort(heroCanvasEl, { scroller: mainMenuEl, sections, heroKeepOut: card, loops: [], skin: 'silver' });
})();
(window as unknown as { steerEscort?: unknown }).steerEscort = heroDrift;  // preview/editor hook

// PATH EDITOR — author-only, gated behind the `#escort-edit` hash. Lets you draw
// each section's loop visually (the car follows live); Export hands back the final
// points. Never runs for a normal visitor. Also on window as steerEscortEdit().
let escortEditor: { destroy(): void } | null = null;
function toggleEscortEditor(on: boolean) {
  if (on && !escortEditor && heroDrift) {
    openMainMenu();   // the editor draws over the landing page
    void import('./escort-editor').then((m) => {
      if (!escortEditor && heroDrift && mainMenuEl) {
        escortEditor = m.startEscortEditor(heroDrift, mainMenuEl, ESCORT_SECTION_NAMES);
      }
    });
  } else if (!on && escortEditor) { escortEditor.destroy(); escortEditor = null; }
}
// DEFER the initial-hash activation to a later task: toggleEscortEditor →
// openMainMenu → hideAllMenus references module state (howScene, music, …) declared
// FURTHER DOWN this file, so calling it synchronously during module init hits the
// temporal dead zone and throws, aborting the whole page. setTimeout(0) runs it
// once the module body has finished and every const is initialized. (hashchange +
// steerEscortEdit() are user-triggered, always post-init, so they're already safe.)
if (location.hash === '#escort-edit') setTimeout(() => toggleEscortEditor(true), 0);
window.addEventListener('hashchange', () => toggleEscortEditor(location.hash === '#escort-edit'));
(window as unknown as { steerEscortEdit?: () => void }).steerEscortEdit = () => toggleEscortEditor(true);

// ROADMAP draw-in — a one-shot reveal when the section scrolls into view. Pure
// progressive enhancement: the section is fully visible by default (no JS / under
// reduced-motion it never hides), and only with both JS + motion does the path +
// items animate in once. No ongoing cost (the observer disconnects after firing).
(() => {
  const track = document.querySelector('#roadmap .rm-track') as HTMLElement | null;
  if (!track || typeof IntersectionObserver === 'undefined') return;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  track.classList.add('rm-anim');
  const io = new IntersectionObserver((entries, obs) => {
    for (const e of entries) if (e.isIntersecting) { track.classList.add('in'); obs.disconnect(); break; }
  }, { threshold: 0.25 });
  io.observe(track);
})();
// HOW IT WORKS: the single-rAF demo (car laps the circuit's SVG path; the SAME
// steering value tilts the wheel phone). Runs only while the landing shows AND
// the section is scrolled into view (its own IntersectionObserver).
const howScene = (() => {
  const pathEl = document.getElementById('how-loop-path') as unknown as SVGPathElement | null;
  const cv = document.getElementById('how-car') as HTMLCanvasElement | null;
  const img = document.getElementById('how-screen-img') as HTMLImageElement | null;
  const wheel = document.getElementById('how-wheel') as HTMLElement | null;
  return (pathEl && cv && img && wheel)
    ? startHowScene({ pathEl, canvas: cv, screenImg: img, wheelEl: wheel, skin: 'silver' })
    : null;
})();
// The escort car runs on EVERY device (it's the page's hook) — on phones it's smaller,
// 30fps-capped and softened (see page-escort.ts + the mobile CSS). The module itself falls
// back to a single static frame under prefers-reduced-motion, so that case is handled there.

// The LANDING (marketing) page — for logged-OUT visitors. Free ride still starts
// from here (START RACE), so no account is needed to play.
function openMainMenu() {
  menuOpen = true;
  hideAllMenus();
  if (mainMenuEl) mainMenuEl.hidden = false;
  heroDrift?.setActive(true);
  howScene?.setEnabled(true);
  music.setActive(false);   // no autoplay music for landing-page visitors
  refreshFreeze();
  updateQrVisibility();
}
// The GAME MENU — for a logged-IN host (PLAY / OPTIONS / LEADERBOARDS). The
// marketing landing is only for converting logged-out visitors, so a signed-in
// host never sees it.
type GameMenuView = 'home' | 'leaderboards';
function setGameMenuView(view: GameMenuView) {
  if (!gameMenuEl) return;
  for (const v of gameMenuEl.querySelectorAll<HTMLElement>('.gm-view')) {
    v.hidden = v.dataset.view !== view;
  }
}
// OPTIONS is ONE shared overlay panel (account · music · controls), opened from
// BOTH the main/game menu AND the pause menu, so they stay identical + in sync.
// It sits above everything; closing reveals whatever screen is underneath, and
// changes (e.g. muting) take effect immediately (the music player is global).
function openOptions() {
  renderGameMenuAccount(getAuthState());
  renderMusicToggle();
  // Always open OPTIONS with the nickname editor collapsed (no stale state).
  const nickEd = document.getElementById('gm-nick-editor'); if (nickEd) nickEd.hidden = true;
  if (optionsModalEl) optionsModalEl.hidden = false;
}
function closeOptions() { if (optionsModalEl) optionsModalEl.hidden = true; }
function openGameMenu() {
  menuOpen = true;
  hideAllMenus();
  if (gameMenuEl) gameMenuEl.hidden = false;
  setGameMenuView('home');
  renderGameMenuAccount(getAuthState());
  renderMusicToggle();
  music.setActive(true);   // music plays in the game menu (starts on first interaction)
  refreshFreeze();
  updateQrVisibility();
}
// Route "home" by auth state: signed-in host → the game menu; otherwise → the
// marketing landing. Everywhere that used to return to the landing calls this.
// On the FIRST load, auth is still resolving (user unknown); if the host was logged
// in last time (session hint), open the game-menu shell rather than flashing the
// marketing landing — routeHomeByAuth() corrects it if auth resolves to logged-out.
function goHome() {
  const s = getAuthState();
  if (s.user || (s.loading && hasSessionHint())) openGameMenu();
  else openMainMenu();
}
// SIM (Blitz RS) is premium-only — reflect the lock on its mode button (the 🔒
// badge + dimmed style) for a free host, exactly like the locked map/mode tiles.
// Clicking it still fires chooseMode('sim'), which pitches premium (see below).
function refreshModeLock() {
  const simBtn = document.getElementById('btn-mode-sim');
  if (!simBtn) return;
  const locked = isSimLocked();
  simBtn.classList.toggle('is-locked', locked);
  simBtn.querySelector('.lock-badge')?.remove();   // avoid duplicates on refresh
  if (locked) simBtn.appendChild(lockBadge());
}
function openModeSelect() {
  menuOpen = true;
  hideAllMenus();
  if (modeSelectEl) modeSelectEl.hidden = false;
  refreshModeLock();       // SIM shows the 🔒 for a free host, unlocked for premium
  music.setActive(true);
}
// Show the CAR & MAP screen for the CURRENT mode. Rebuilds the tiles and restores the
// highlight for whatever is still selected — so returning here mid-session (EXIT TO MENU)
// lands on the right mode's screen with the last car/map still picked, ready to re-START.
// Safe to call from GAMEPLAY (sets menuOpen + freezes + hides the QR) as well as from the
// mode screen (where those are already the case).
function openCarMapSelect() {
  menuOpen = true;
  hideAllMenus();
  if (carMapSelectEl) carMapSelectEl.hidden = false;
  music.setActive(true);
  buildCarTiles();
  buildMapTiles();
  buildModeOptions();
  buildRaceLaps();
  refreshSelectionUi();
  refreshFreeze();
  updateQrVisibility();
}
// Choosing the mode fixes the branch + car family, then opens the CAR & MAP screen.
// A FRESH mode choice clears the previous car/map/game-mode pick (a new selection).
function chooseMode(mode: RaceMode) {
  // SIM (Blitz RS) is premium-only — a free host gets the positive premium upsell
  // instead of the mode. Defense in depth: even a click on the locked SIM button is
  // refused here (the upsell → GET PREMIUM → the same checkout flow).
  if (mode === 'sim' && isSimLocked()) { openUpsell('generic'); return; }
  raceMode = mode;
  renderQr();             // the join URL carries the mode → phones paint the right colours
  selectedMapId = null;
  selectedCarKey = null;
  selectedGameMode = DEFAULT_GAME_MODE;   // FREE RIDE is the resting default
  openCarMapSelect();
}
function closeMenusIntoGame() {
  menuOpen = false;
  hideAllMenus();
  music.setActive(true);   // keep the music going in-game
  refreshFreeze();
  updateQrVisibility();   // QR/join panel appears now a map is live
}
// START is enabled once a car AND a map are chosen. A game mode is ALWAYS set
// (FREE RIDE is the default), so it never gates START.
function updateStartEnabled() {
  if (cmsStartBtn) cmsStartBtn.disabled = !(selectedMapId && selectedCarKey);
}
// START: commit the mode to every car, load the map (respawns cars), enter play.
function launchSelected() {
  if (!selectedMapId) return;
  // Entitlement gate (defense-in-depth on top of the locked tiles): never launch
  // premium content for a non-premium host — pitch premium instead. This is the
  // real "can't bypass the UI" enforcement: even if raceMode were forced to 'sim',
  // START refuses it for a free host. isPremium() is server truth (RLS-protected).
  if (raceMode === 'sim' && isSimLocked()) { openUpsell('generic'); return; }
  if (isMapLocked(selectedMapId)) { openUpsell('map', selectedMapId); return; }
  if (isModeLocked(selectedGameMode)) { openUpsell('mode', selectedGameMode); return; }
  goFullscreen();         // gameplay starts — fill the host screen (gesture)
  applyModeToAllCars();   // re-spec any already-connected cars to the chosen mode
  broadcastLobby();       // phones learn the mode + its colour palette
  switchMap(selectedMapId);   // load the map + respawn any connected cars (resets to free-roam)
  applySelectedGameMode();    // then commit RACE (laps) / XP on top of the free-roam default
  closeMenusIntoGame();
  // Promo AFTER START (free/anon, capped). The backdrop is see-through + it's
  // dismissible, so it never blocks the QR/joining — see the promo styling.
  maybeShowPremiumPromo();
}
// Translate the chosen GameMode onto the loaded map. FREE RIDE keeps switchMap's
// default (the desktop's editor / a circuit's free-roam cruise — no rules, no
// timer). RACE sets a real lap race (default laps); XP starts a score run. RACE/XP
// only ever reach a circuit-type map (the picker filters them off free-ride-only
// maps), and setCircuitMode itself no-ops on a non-circuit map, so this is safe.
function applySelectedGameMode() {
  if (selectedGameMode === 'xp') {
    setCircuitMode('xp');
  } else if (selectedGameMode === 'race') {
    enterRaceWarmup(selectedRaceLaps);   // free driving + READY (no countdown yet), the menu's lap count
  }
  // 'free' → nothing: switchMap already left the map in its free-roam default.
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

// The map tiles register here so the selection highlight can be toggled across
// all of them (a group tile's effective id changes with its surface switcher, so
// each entry reports its CURRENT id via getId()).
type MapTileEntry = { el: HTMLElement; getId: () => string };
let mapTileEntries: MapTileEntry[] = [];
// Highlight the selected map, and DIM (filter) any map that doesn't support the
// selected game mode — the mode→map half of the two-way filter. FREE RIDE is in
// every map's list, so the resting default dims nothing.
function highlightMapTiles() {
  for (const e of mapTileEntries) {
    const id = e.getId();
    e.el.classList.toggle('is-selected', id === selectedMapId);
    e.el.classList.toggle('is-filtered', !mapGameModes(id).includes(selectedGameMode));
  }
}
// Pick a map (does NOT launch — START does). If it can't host the currently-chosen
// game mode (e.g. Desktop supports only FREE RIDE), the MAP wins and the mode falls
// back to FREE RIDE — so clicking is always allowed and both orders work.
function selectMap(id: string) {
  selectedMapId = id;
  if (!mapGameModes(id).includes(selectedGameMode)) selectedGameMode = DEFAULT_GAME_MODE;
  refreshSelectionUi();
}

// ---- MODE panel (always-visible list; the map→mode half of the two-way filter) ----
let modeOptEls: HTMLButtonElement[] = [];
// Build the mode option rows once (data-driven from GAME_MODES).
function buildModeOptions() {
  if (!modePanelEl) return;
  modePanelEl.innerHTML = '';
  modeOptEls = [];
  for (const m of GAME_MODES) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'mode-opt';
    opt.dataset.mode = m.key;
    opt.innerHTML =
      `<span class="mode-opt-head"><span class="mode-opt-name">${m.name}</span>` +
      `<span class="mode-opt-tag">${m.players}</span></span>` +
      `<span class="mode-opt-desc">${m.desc}</span>`;
    if (isModeLocked(m.key)) { opt.classList.add('is-locked'); opt.appendChild(lockBadge()); }
    opt.addEventListener('click', () => {
      if (isModeLocked(m.key)) { openUpsell('mode', m.key); return; }   // locked mode → pitch premium
      selectGameMode(m.key);
    });
    modePanelEl.appendChild(opt);
    modeOptEls.push(opt);
  }
}
// Build the LAP COUNT segments once (data-driven from RACE_LAP_OPTIONS).
let raceLapEls: HTMLButtonElement[] = [];
function buildRaceLaps() {
  if (!raceLapsOptsEl) return;
  raceLapsOptsEl.innerHTML = '';
  raceLapEls = [];
  for (const n of RACE_LAP_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cms-laps-opt';
    b.textContent = String(n);
    b.dataset.laps = String(n);
    b.addEventListener('click', (e) => { e.stopPropagation(); selectedRaceLaps = n; refreshRaceLaps(); });
    raceLapsOptsEl.appendChild(b);
    raceLapEls.push(b);
  }
}
// Show the lap selector only while RACE is the chosen mode; highlight the pick.
function refreshRaceLaps() {
  const show = selectedGameMode === 'race';
  if (raceLapsEl) raceLapsEl.hidden = !show;
  for (const b of raceLapEls) b.classList.toggle('is-active', Number(b.dataset.laps) === selectedRaceLaps);
}

// Pick a game mode. If the currently-selected map can't host it (RACE/XP on a
// free-ride-only map), the MODE wins and the map is cleared (both orders work).
// There's no "deselect to nothing" — FREE RIDE IS the cleared state, so choose it.
function selectGameMode(key: string) {
  selectedGameMode = key;
  if (selectedMapId && !mapGameModes(selectedMapId).includes(key)) selectedMapId = null;
  refreshSelectionUi();
}
// Highlight the chosen mode option + dim any the selected map can't host (the
// map→mode half of the two-way filter). A mode is ALWAYS set (FREE RIDE default).
function refreshModePicker() {
  const mapModes = mapGameModes(selectedMapId);
  for (const el of modeOptEls) {
    const key = el.dataset.mode!;
    el.classList.toggle('is-selected', key === selectedGameMode);
    el.classList.toggle('is-filtered', !!selectedMapId && !mapModes.includes(key));
  }
}
// One call refreshes both halves of the two-way filter + the START button.
function refreshSelectionUi() {
  highlightMapTiles();
  refreshModePicker();
  refreshRaceLaps();
  updateStartEnabled();
}

// Build the map-select tiles from the registry (so new maps appear here
// automatically). Each tile renders a REAL mini-preview of the map. Maps that
// share a surfaceGroup.key collapse into ONE tile with an in-tile surface
// switcher (presentation only — each member is still selected by its own id).
function lockBadge(): HTMLSpanElement {
  const b = document.createElement('span');
  b.className = 'lock-badge';
  b.textContent = '🔒';
  return b;
}
function buildMapTiles() {
  if (!mapTilesEl) return;
  mapTilesEl.innerHTML = '';
  mapTileEntries = [];
  const dpr = backingDpr();
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
        // Tap/click a segment → switch that surface (works on touch + mouse);
        // never bubbles to the tile body. If this tile is the currently-selected
        // map, switching surface moves the selection to the new surface id.
        if (isMapLocked(member.id)) { seg.classList.add('is-locked'); seg.appendChild(lockBadge()); }
        seg.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isMapLocked(member.id)) { openUpsell('map', member.id); return; }   // locked surface → pitch
          const wasSelected = selectedMapId === selectedSurfaceId(grp.key);
          groupSurface.set(grp.key, member.id);
          refreshActive();
          renderSelected();
          if (wasSelected) selectMap(member.id);
        });
        segs.push(seg);
        sw.appendChild(seg);
      }
      // Initial active state + preview reflect the (default-seeded) selection.
      const cur0 = selectedSurfaceId(grp.key);
      for (const s of segs) s.classList.toggle('is-active', s.dataset.id === cur0);
      renderSelected();

      // Clicking the tile body (not a segment) SELECTS the current surface — or,
      // if the current surface is locked (Flattrack for a free host), pitches premium.
      const chooseGroup = () => {
        const id = selectedSurfaceId(grp.key);
        if (isMapLocked(id)) openUpsell('map', id); else selectMap(id);
      };
      tile.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.map-switch')) return;
        chooseGroup();
      });
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseGroup(); }
      });

      tile.appendChild(thumb);
      tile.appendChild(label);
      tile.appendChild(sw);
      mapTilesEl.appendChild(tile);
      mapTileEntries.push({ el: tile, getId: () => selectedSurfaceId(grp.key) });
      continue;
    }

    // ---- Ungrouped map → a plain tile ----
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
    if (isMapLocked(def.id)) { tile.classList.add('is-locked'); tile.appendChild(lockBadge()); }
    tile.addEventListener('click', () => {
      if (isMapLocked(def.id)) openUpsell('map', def.id); else selectMap(def.id);
    });
    mapTilesEl.appendChild(tile);
    mapTileEntries.push({ el: tile, getId: () => def.id });
  }
  highlightMapTiles();
}

// ---- CAR tiles (left column) — data-driven per mode so more cars slot in. ----
// Collapsed = the NAME only (a small tile). HOVER = a detail flyout with the
// full spec sheet + description, and (if `image`) the car's sprite. Every field
// lives in the data here so a new car is one more MenuCar entry.
interface CarSpec { label: string; value: string; }
interface MenuCar {
  key: string;
  name: string;
  image?: SteerexSkin;   // sprite skin shown in the flyout; omit → no image (Blitz has no art yet)
  specs: CarSpec[];
  blurb: string;
}
function modeCars(mode: RaceMode): MenuCar[] {
  if (mode === 'arcade') return [{
    key: 'steerex', name: 'Stee-Rex', image: 'silver',
    specs: [
      { label: 'ENGINE',    value: 'Hydrogen fusion spiral' },
      { label: 'POWER',     value: '666 kW (893 hp)' },
      { label: 'DRIVE',     value: 'AWD 40:60' },
      { label: 'WEIGHT',    value: '900 kg' },
      { label: '0-100',     value: '2.1 s' },
      { label: '0-200',     value: '4.6 s' },
      { label: 'TOP SPEED', value: '300 km/h' },
      { label: 'TIRES',     value: 'Universal - all surfaces' },
      { label: 'ORIGIN',    value: '███ CLASSIFIED ███' },
    ],
    blurb: "A secret project developed with involvement from a space program. "
      + "Officially, it doesn't exist.",
  }];
  // SIM — Blitz RS. 0-100 + top speed MEASURED from the car (step4 / PHYS4, full
  // throttle on asphalt): 3.05 s, 246 km/h. No image (no finished design yet).
  return [{
    key: 'blitz', name: 'Blitz RS',
    specs: [
      { label: 'ENGINE',    value: '2.5L I4 - naturally aspirated' },
      { label: 'POWER',     value: '276 kW (370 hp)' },
      { label: 'DRIVE',     value: 'RWD' },
      { label: 'WEIGHT',    value: '1020 kg' },
      { label: '0-100',     value: '3.0 s' },
      { label: 'TOP SPEED', value: '246 km/h' },
      { label: 'TIRES',     value: 'Slicks - asphalt only' },
      { label: 'ORIGIN',    value: 'Europe' },
    ],
    blurb: '90s European touring car. Group A pedigree - raw, rear-driven, unforgiving. '
      + 'Brilliant on asphalt, a struggle anywhere else.',
  }];
}

// Draw the car's sprite (cropped to its opaque bbox, nose UP) into a flyout canvas.
// The sprite bakes async — if it isn't decoded yet, redraw shortly (preloadSteerex
// warms it at startup, so this is usually a no-op).
function drawCarImage(cvs: HTMLCanvasElement, skin: SteerexSkin, dpr: number) {
  const c = cvs.getContext('2d'); if (!c) return;
  const W = cvs.width / dpr, H = cvs.height / dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const sprite = steerexSprite(skin);
  if (!sprite) { window.setTimeout(() => drawCarImage(cvs, skin, dpr), 120); return; }
  const op = steerexOpaque();
  const sx = op ? op.cxPx - op.widPx / 2 : 0;
  const sy = op ? op.cyPx - op.lenPx / 2 : 0;
  const sw = op ? op.widPx : sprite.width;
  const sh = op ? op.lenPx : sprite.height;
  const scale = Math.min(W / sw, H / sh) * 0.94;
  const dw = sw * scale, dh = sh * scale;
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(sprite, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function selectCar(key: string) {
  selectedCarKey = key;
  if (carTilesEl) for (const el of Array.from(carTilesEl.children))
    el.classList.toggle('is-selected', (el as HTMLElement).dataset.carKey === key);
  updateStartEnabled();
}
function buildCarTiles() {
  if (!carTilesEl) return;
  carTilesEl.innerHTML = '';
  const dpr = backingDpr();
  const cars = modeCars(raceMode);
  for (const car of cars) {
    const card = document.createElement('div');
    card.className = 'map-tile car-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.carKey = car.key;

    const name = document.createElement('span');
    name.className = 'map-name car-card-name';
    name.textContent = car.name;
    card.appendChild(name);

    // Detail flyout (revealed on hover / focus — see .car-detail in style.css).
    const detail = document.createElement('div');
    detail.className = 'car-detail';

    if (car.image) {
      const imgWrap = document.createElement('span');
      imgWrap.className = 'car-image';
      const DW = 150, DH = 190;
      const cvs = document.createElement('canvas');
      cvs.width = Math.floor(DW * dpr); cvs.height = Math.floor(DH * dpr);
      cvs.style.width = DW + 'px'; cvs.style.height = DH + 'px';
      drawCarImage(cvs, car.image, dpr);
      imgWrap.appendChild(cvs);
      detail.appendChild(imgWrap);
    }

    const specs = document.createElement('dl');
    specs.className = 'car-specs';
    for (const s of car.specs) {
      const dt = document.createElement('dt'); dt.textContent = s.label;
      const dd = document.createElement('dd'); dd.textContent = s.value;
      specs.appendChild(dt); specs.appendChild(dd);
    }
    detail.appendChild(specs);

    const blurb = document.createElement('p');
    blurb.className = 'car-blurb';
    blurb.textContent = car.blurb;
    detail.appendChild(blurb);

    card.appendChild(detail);
    card.addEventListener('click', () => selectCar(car.key));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCar(car.key); }
    });
    carTilesEl.appendChild(card);
  }
  // Keep a still-valid pick (returning here via EXIT TO MENU), else auto-select the first
  // car so START just needs a map. Matters once a mode offers more than one car.
  const keep = cars.some((c) => c.key === selectedCarKey) ? selectedCarKey! : cars[0]?.key;
  if (keep) selectCar(keep);
}

// ---- HOST-SCREEN-SIZE GATE ----------------------------------------------------
// Steer It is a shared-screen party game: the host screen is the racetrack a group
// watches, so it must be big enough to read. A phone as the host is unplayable (the
// phone is the CONTROLLER — a separate page, play.html, entirely unaffected by this).
//
// Based on SCREEN SIZE, not device sniffing (iPads report as desktop, phones request
// desktop mode — UA is unreliable, and size is the real constraint). We read
// window.screen (the DEVICE screen, CSS px), not the window, so a desktop user with a
// small browser window is NOT blocked (their screen is big, and START goes fullscreen
// anyway). We use the LONG and SHORT sides (orientation-agnostic) because the width
// alone can't separate an iPad mini (1024) from a big phone in landscape (930) — the
// HEIGHT does (768 vs 430). One tunable constant:
//   • longPx 1000  — screen's longer side (landscape width). iPad mini 1024 clears it;
//                    a landscape phone (~930) does not.
//   • shortPx 600  — screen's shorter side (landscape height). iPad mini 768 clears it;
//                    a landscape phone (~430) does not. This is the clean discriminator.
// At/above 1024×768 the track + cars render readably (iPad mini is a real target); below
// ~600 tall the whole course is scaled down too far to watch from across a table.
const HOST_MIN_SCREEN = { longPx: 1000, shortPx: 600 };

function hostScreenBigEnough(): boolean {
  const w = window.screen?.width || window.innerWidth;
  const h = window.screen?.height || window.innerHeight;
  const long = Math.max(w, h), short = Math.min(w, h);
  return long >= HOST_MIN_SCREEN.longPx && short >= HOST_MIN_SCREEN.shortPx;
}

// The "too small" note is a DISMISSIBLE POPUP shown ONLY at the moment the user tries
// to play — not a passive menu state. Dismiss via the button or by tapping the backdrop.
const hostTooSmallEl = document.getElementById('host-too-small') as HTMLElement | null;
function hideHostTooSmall() { if (hostTooSmallEl) hostTooSmallEl.hidden = true; }
document.getElementById('host-note-dismiss')?.addEventListener('click', hideHostTooSmall);
hostTooSmallEl?.addEventListener('click', (e) => { if (e.target === hostTooSmallEl) hideHostTooSmall(); });

// THE PLAY GUARD — call this at every "I want to play" entry point. Runs the action on
// a big-enough host; otherwise pops the "bigger screen" note. Used by START RACE now;
// the future free-play-from-page and post-login "start game" buttons call the SAME guard.
// `action` runs synchronously so it stays inside the click gesture (fullscreen needs that).
function requireHostScreen(action: () => void) {
  if (hostScreenBigEnough()) action();
  else if (hostTooSmallEl) hostTooSmallEl.hidden = false;
}

document.getElementById('btn-start-race')?.addEventListener('click', () => {
  requireHostScreen(() => {
    goFullscreen();   // START RACE is the user gesture — fill the host screen
    openModeSelect();
  });
});
document.getElementById('btn-mode-arcade')?.addEventListener('click', () => chooseMode('arcade'));
document.getElementById('btn-mode-sim')?.addEventListener('click', () => chooseMode('sim'));
document.getElementById('btn-mode-back')?.addEventListener('click', goHome);

// ---- GAME MENU (logged-in host) ----
document.getElementById('gm-play')?.addEventListener('click', () => {
  requireHostScreen(() => { goFullscreen(); openModeSelect(); });   // same PLAY flow as START RACE
});
document.getElementById('gm-options')?.addEventListener('click', openOptions);
document.getElementById('gm-get-premium')?.addEventListener('click', startPremiumPurchase);
document.getElementById('gm-opt-upgrade')?.addEventListener('click', () => { closeOptions(); startPremiumPurchase(); });
document.getElementById('btn-pause-options')?.addEventListener('click', openOptions);
document.getElementById('opt-close')?.addEventListener('click', closeOptions);
document.getElementById('opt-back')?.addEventListener('click', closeOptions);
optionsModalEl?.addEventListener('click', (e) => { if (e.target === optionsModalEl) closeOptions(); });
document.getElementById('gm-leaderboards')?.addEventListener('click', () => setGameMenuView('leaderboards'));
document.getElementById('gm-lb-back')?.addEventListener('click', () => setGameMenuView('home'));
document.getElementById('gm-music')?.addEventListener('click', toggleMusic);
document.getElementById('gm-logout')?.addEventListener('click', () => { closeOptions(); void signOut(); });
document.getElementById('btn-cms-back')?.addEventListener('click', openModeSelect);
cmsStartBtn?.addEventListener('click', launchSelected);

// ================= HOST ACCOUNT · AUTH · PAYWALL UPSELL =================
// Only the host uses this. Login/signup/verification/reset all ride Supabase Auth
// (src/auth.ts). The account chip shows the state; locked tiles open the upsell.
const authModalEl   = document.getElementById('auth-modal')     as HTMLElement | null;
const upsellEl      = document.getElementById('upsell-modal')   as HTMLElement | null;
const authMsgEl     = document.getElementById('auth-msg')       as HTMLElement | null;
const accountLabel  = document.getElementById('account-label')  as HTMLElement | null;
const accountBadge  = document.getElementById('account-badge')  as HTMLElement | null;
const accountAuthEl = document.getElementById('account-auth')   as HTMLElement | null;
const accountChip   = document.getElementById('account-btn')    as HTMLButtonElement | null;
let authMode: 'login' | 'signup' = 'login';

function authSection(name: string) {
  for (const s of Array.from(document.querySelectorAll('#auth-modal .auth-sec')) as HTMLElement[]) {
    (s).hidden = s.dataset.sec !== name;
  }
  setAuthMsg('', false);
}
function setAuthMsg(text: string, isError: boolean) {
  if (!authMsgEl) return;
  authMsgEl.textContent = text;
  authMsgEl.hidden = !text;
  authMsgEl.classList.toggle('is-error', isError);
}
function openAuthModal(section: 'form' | 'forgot' | 'account' | 'recovery') {
  if (!authModalEl) return;
  if (section === 'form') applyAuthMode();
  // Always open the account panel with the nickname editor collapsed (no stale state).
  if (section === 'account') { const ed = document.getElementById('account-nick-editor'); if (ed) ed.hidden = true; }
  authSection(section);
  authModalEl.hidden = false;
}
function closeAuthModal() { if (authModalEl) authModalEl.hidden = true; }
function applyAuthMode() {
  const login = authMode === 'login';
  const t = document.getElementById('auth-title');
  const sub = document.getElementById('auth-sub');
  const submit = document.getElementById('auth-submit');
  const toggle = document.getElementById('auth-toggle');
  const pw = document.getElementById('auth-password') as HTMLInputElement | null;
  const pw2 = document.getElementById('auth-password2') as HTMLInputElement | null;
  if (t) t.textContent = login ? 'LOG IN' : 'CREATE ACCOUNT';
  if (sub) sub.textContent = login
    ? 'Only the host needs an account — players just scan the QR.'
    : "Free needs no account — sign up only to unlock premium maps, modes & leaderboards.";
  if (submit) submit.textContent = login ? 'LOG IN' : 'SIGN UP';
  if (toggle) toggle.innerHTML = login ? 'Need an account? <b>Sign up</b>' : 'Have an account? <b>Log in</b>';
  if (pw) pw.autocomplete = login ? 'current-password' : 'new-password';
  // Confirm-password field is SIGN UP only — shown + required there, hidden +
  // not-required (so it never blocks validation) on log in. Cleared on switch.
  if (pw2) { pw2.hidden = login; pw2.required = !login; if (login) pw2.value = ''; }
  // Nickname field + its live-validation hint are SIGN UP only.
  const nick = document.getElementById('auth-nickname') as HTMLInputElement | null;
  const nickHint = document.getElementById('nick-hint');
  if (nick) { nick.hidden = login; nick.required = !login; if (login) nick.value = ''; }
  if (nickHint) { nickHint.hidden = login; if (login) { nickHint.textContent = ''; nickHint.className = 'nick-hint'; } }
}

// Live nickname validator shared by the SIGN UP field and the account CHANGE
// field: instant local format check, then a debounced server check_nickname() for
// availability + profanity (the authoritative verdict). `isValid()` is true only
// when the last verdict was format-ok AND available AND clean — the submit/save
// reads it (and re-checks authoritatively before committing).
function makeNickValidator(inputId: string, hintId: string) {
  let ok = false, timer = 0, seq = 0;
  const setHint = (t: string, kind: '' | 'ok' | 'err' | 'pending') => {
    const el = document.getElementById(hintId); if (!el) return;
    el.textContent = t; el.className = 'nick-hint' + (kind ? ' is-' + kind : '');
  };
  const value = () => (document.getElementById(inputId) as HTMLInputElement | null)?.value.trim() || '';
  const run = () => {
    ok = false; window.clearTimeout(timer);
    const v = value();
    const fmt = nicknameFormatError(v);
    if (fmt) { setHint(v ? fmt : '', v ? 'err' : ''); return; }
    setHint('Checking availability…', 'pending');
    const s = ++seq;
    timer = window.setTimeout(() => { void checkNickname(v).then((r) => {
      if (s !== seq) return;   // a newer keystroke superseded this check
      if (r.ok && r.available) { ok = true; setHint('✓ Available', 'ok'); }
      else setHint(nickReasonMsg(r.reason), 'err');
    }); }, 450);
  };
  document.getElementById(inputId)?.addEventListener('input', run);
  return {
    isValid: () => ok, value, setHint,
    reset: () => { ok = false; seq++; window.clearTimeout(timer); setHint('', ''); },
  };
}
// Map a server nickname reason code to a clear user message.
function nickReasonMsg(reason: string | null): string {
  return reason === 'taken' ? 'That nickname is taken, try another.'
    : reason === 'profane' ? 'Please choose a different nickname.'
    : reason === 'format' ? 'Letters, numbers, _ and - only (3–20).'
    : 'Could not check right now — try again.';
}
const signupNick = makeNickValidator('auth-nickname', 'nick-hint');
const accountNick = makeNickValidator('account-nick-input', 'account-nick-hint');
const gmNick = makeNickValidator('gm-nick-input', 'gm-nick-hint');   // the OPTIONS-modal editor

// Shared wiring for a nickname CHANGE editor (the account panel + the OPTIONS
// panel are identical): Change/Set toggles the editor, Cancel closes it, Save
// runs changeNickname() and surfaces the server verdict (incl. the 30-day
// cooldown). A first-time set from "not set" is allowed immediately server-side
// (last_nickname_change is null → no cooldown).
function wireNickEditor(opts: {
  editId: string; editorId: string; fieldsId: string; cooldownId: string;
  inputId: string; cancelId: string; saveId: string;
  validator: ReturnType<typeof makeNickValidator>;
}) {
  const $ = (id: string) => document.getElementById(id);
  const cooldownText = (days: number) =>
    `You can change your nickname again in ${days} day${days === 1 ? '' : 's'}.`;
  // Show either the read-only COOLDOWN message (no input/save) or the EDITABLE
  // fields + Save — never both. `days` overrides the client estimate (e.g. the
  // server's verdict) when provided.
  const showCooldown = (days: number) => {
    const cd = $(opts.cooldownId), fields = $(opts.fieldsId), save = $(opts.saveId);
    if (cd) { cd.textContent = cooldownText(days); cd.hidden = false; }
    if (fields) fields.hidden = true;
    if (save) save.hidden = true;
  };
  const showEditable = () => {
    const cd = $(opts.cooldownId), fields = $(opts.fieldsId), save = $(opts.saveId);
    if (cd) cd.hidden = true;
    if (fields) fields.hidden = false;
    if (save) save.hidden = false;
    const input = $(opts.inputId) as HTMLInputElement | null;
    if (input) input.value = getAuthState().nickname || '';
    opts.validator.reset();
  };
  $(opts.editId)?.addEventListener('click', () => {
    const ed = $(opts.editorId); if (!ed) return;
    const days = nicknameCooldownDaysLeft(getAuthState().nicknameChangedAt);
    if (days > 0) { showCooldown(days); }        // within cooldown → message only
    else { showEditable(); }                     // editable (or first-time set)
    ed.hidden = false;
    if (days === 0) ($(opts.inputId) as HTMLInputElement | null)?.focus();
  });
  $(opts.cancelId)?.addEventListener('click', () => {
    const ed = $(opts.editorId); if (ed) ed.hidden = true;
    opts.validator.reset();
  });
  $(opts.saveId)?.addEventListener('click', () => {
    const btn = $(opts.saveId) as HTMLButtonElement | null;
    const nick = opts.validator.value();
    const fmt = nicknameFormatError(nick);
    if (fmt) { opts.validator.setHint(fmt, 'err'); return; }
    if (btn) btn.disabled = true;
    opts.validator.setHint('Saving…', 'pending');
    void changeNickname(nick).then((r) => {
      if (btn) btn.disabled = false;
      if (r.ok) {
        opts.validator.setHint('✓ Nickname updated', 'ok');   // state updated → chip + panels re-render
        window.setTimeout(() => { const ed = $(opts.editorId); if (ed) ed.hidden = true; }, 900);
        return;
      }
      // Server says cooldown (clock skew / stale client) → switch to the read-only view.
      if (r.reason === 'cooldown') { showCooldown(r.daysLeft ?? 30); }
      else { opts.validator.setHint(nickReasonMsg(r.reason ?? null), 'err'); }
    });
  });
}

// The account chip (menu) + the account panel reflect the live auth state.
function renderAccount(s: AuthState) {
  const email = s.user?.email || '';
  const pending = entitlementPending(s);   // logged in but plan not resolved yet → neutral, not free
  // Logged OUT → SIGN UP + LOG IN buttons; logged IN → the account chip.
  if (accountAuthEl) accountAuthEl.hidden = !!s.user;
  if (accountChip) accountChip.hidden = !s.user;
  // Chip shows the NICKNAME (the public identity); falls back to the email local
  // part for legacy accounts that have no nickname yet.
  if (accountLabel) accountLabel.textContent = s.user ? (s.nickname || email.split('@')[0] || 'ACCOUNT') : 'ACCOUNT';
  if (accountBadge) {
    accountBadge.hidden = !s.user;
    accountBadge.textContent = pending ? '···' : (s.isPremium ? 'PREMIUM' : 'FREE');
    accountBadge.classList.toggle('is-premium', !pending && s.isPremium);
    accountBadge.classList.toggle('is-pending', pending);
  }
  // Account panel fields
  const emailEl = document.getElementById('account-email');
  const pill = document.getElementById('plan-pill');
  const note = document.getElementById('plan-note');
  const upgrade = document.getElementById('account-upgrade') as HTMLButtonElement | null;
  if (emailEl) emailEl.textContent = email || '—';
  const nickEl = document.getElementById('account-nick');
  if (nickEl) nickEl.textContent = s.nickname || 'not set';
  const nickEditBtn = document.getElementById('account-nick-edit');
  if (nickEditBtn) nickEditBtn.textContent = s.nickname ? 'Change' : 'Set nickname';
  if (pill) { pill.textContent = pending ? '···' : (s.isPremium ? 'PREMIUM' : 'FREE'); pill.classList.toggle('is-premium', !pending && s.isPremium); pill.classList.toggle('is-pending', pending); }
  if (note) note.textContent = pending ? 'Checking your plan…' : (s.isPremium
    ? 'All maps & modes · global leaderboards'
    : 'Desktop & Asphalt Oval · Free Ride');
  if (upgrade) upgrade.hidden = pending || s.isPremium;   // don't offer upgrade until the plan is known

  // Pricing-section CTA reflects the plan: premium owners see it as owned.
  const getPrem = document.getElementById('btn-get-premium') as HTMLButtonElement | null;
  if (getPrem) {
    getPrem.textContent = s.isPremium ? '✓ You have Premium' : 'Get Premium';
    getPrem.disabled = s.isPremium || pending;            // neutral while pending
  }

  // Arrived via a password-reset link → jump straight to the set-new-password form.
  if (s.recovery && authModalEl) openAuthModal('recovery');

  // Keep the SIM mode button's lock badge current whenever the plan changes.
  refreshModeLock();

  // While the plan is still resolving, do NOT run the plan-dependent side effects
  // below (they'd treat the pending state as free — closing the editor, clearing a
  // premium map/mode selection). They re-run once the entitlement resolves.
  if (pending) { renderGameMenuAccount(s); routeHomeByAuth(s); return; }

  // The E editor is premium-only. If the plan dropped to free while it was open
  // (logout / expiry), leave the editor and drop any Desktop race it built — the
  // paywall must hold even mid-session. rebuildRace() re-checks isPremium() and
  // clears a Desktop race for a non-premium account.
  if (!s.isPremium && editorMode) {
    editorMode = false;
    rebuildRace();
    refreshFreeze();
    updateEditorStatus();
  }
  // Re-gate the CAR & MAP screen when the plan changes (unlock/lock tiles). If a
  // now-locked item was selected (e.g. logged out), fall back to a free choice; a
  // now-locked SIM car family bounces the host back to the mode screen (which shows
  // SIM locked) rather than leaving them on a screen that can't START.
  if (carMapSelectEl && !carMapSelectEl.hidden) {
    if (raceMode === 'sim' && isSimLocked()) {
      openModeSelect();
    } else {
      if (selectedMapId && isMapLocked(selectedMapId)) selectedMapId = null;
      if (isModeLocked(selectedGameMode)) selectedGameMode = DEFAULT_GAME_MODE;
      buildMapTiles();
      buildModeOptions();
      refreshSelectionUi();
    }
  }

  // The game menu's own account panel (OPTIONS) mirrors the same state.
  renderGameMenuAccount(s);
  routeHomeByAuth(s);
}

// HOME view follows auth: a host who just logged IN gets the game menu instead of
// the marketing landing; a host who logged OUT is returned to the landing. Only
// swap while actually ON a home screen — never yank out of a selection screen, the
// pause menu, or gameplay. (Runs from both the resolved and the pending render.)
function routeHomeByAuth(s: AuthState) {
  const onLanding  = !!mainMenuEl && !mainMenuEl.hidden;
  const onGameMenu = !!gameMenuEl && !gameMenuEl.hidden;
  if (s.user && onLanding) openGameMenu();
  else if (!s.user && onGameMenu) openMainMenu();
}

// The game-menu account UI (email/username + FREE/PREMIUM) + the prominent
// upgrade CTA, shown to a FREE host and hidden once premium.
function renderGameMenuAccount(s: AuthState) {
  // The whole ACCOUNT section (email, nickname, Log Out, upgrade) is gated on
  // LOGIN STATE, not plan. Anonymous "Try Free" users have no account → hide it;
  // a logged-in FREE user is still logged in → they see it (nickname + Log Out +
  // the GET PREMIUM upsell). Logged-in PREMIUM: nickname + Log Out, no upsell.
  const accSec = document.getElementById('gm-account-sec');
  if (accSec) accSec.hidden = !s.user;
  const pending = entitlementPending(s);   // neutral chip + no CTA until the plan is known
  const emailEl = document.getElementById('gm-acc-email');
  const badge = document.getElementById('gm-acc-badge');
  const email = s.user?.email || '';
  if (emailEl) emailEl.textContent = email || '—';
  if (badge) {
    badge.textContent = pending ? '···' : (s.isPremium ? 'PREMIUM' : 'FREE');
    badge.classList.toggle('is-premium', !pending && s.isPremium);
    badge.classList.toggle('is-pending', pending);
  }
  // Nickname (display name) — read from the profile (AuthState.nickname). "not set"
  // for legacy accounts; the button then reads "Set nickname" and the first set is
  // allowed immediately (server-side: no cooldown when last_nickname_change is null).
  const nickEl = document.getElementById('gm-nick');
  if (nickEl) nickEl.textContent = s.nickname || 'not set';
  const nickEdit = document.getElementById('gm-nick-edit');
  if (nickEdit) nickEdit.textContent = s.nickname ? 'Change' : 'Set nickname';
  // The loud GET PREMIUM CTA (game-menu home) + the subtle PREMIUM status + the
  // OPTIONS upgrade button all follow FREE-vs-PREMIUM. In the game menu the user
  // is always logged in, so the split is purely on entitlement.
  // FREE-only UI shows ONLY once the plan is known (pending → hide both the CTA and
  // the owned badge, so a premium host never flashes GET PREMIUM on load/login).
  const free = !!s.user && !s.isPremium && !pending;
  const cta = document.getElementById('gm-get-premium');
  const owned = document.getElementById('gm-premium-owned');
  const optUp = document.getElementById('gm-opt-upgrade');
  if (cta) cta.hidden = !free;
  if (owned) owned.hidden = pending || !s.isPremium;
  if (optUp) optUp.hidden = !free;
}

// ---- Background music (host only) — a shuffled synthwave playlist that plays in
// the menu + in-game but never on the marketing landing, and only after the first
// user interaction (autoplay policy). The OPTIONS toggle mutes/persists it. ----
const music = createMusicPlayer();
const MUSIC_KEY = 'steerit.music';
// Default ON (starts after the first interaction); OFF only if the host turned it off.
let musicOn = (() => { try { return localStorage.getItem(MUSIC_KEY) !== '0'; } catch { return true; } })();
music.setEnabled(musicOn);
function renderMusicToggle() {
  const btn = document.getElementById('gm-music');
  if (!btn) return;
  btn.setAttribute('aria-checked', musicOn ? 'true' : 'false');
  const txt = btn.querySelector('.gm-switch-txt');
  if (txt) txt.textContent = musicOn ? 'ON' : 'OFF';
}
function toggleMusic() {
  musicOn = !musicOn;
  try { localStorage.setItem(MUSIC_KEY, musicOn ? '1' : '0'); } catch { /* ignore */ }
  music.setEnabled(musicOn);
  renderMusicToggle();
}

// ---- Paywall upsell — a positive pitch, not a wall. Adapts to the auth state. ----
function openUpsell(kind: 'map' | 'mode' | 'generic', id?: string) {
  if (!upsellEl) return;
  const titleEl = document.getElementById('upsell-title');
  const leadEl  = document.getElementById('upsell-lead');
  const primary = document.getElementById('upsell-primary') as HTMLButtonElement | null;
  const secondary = document.getElementById('upsell-secondary') as HTMLButtonElement | null;
  let what = 'the full game';
  if (kind === 'map' && id) what = getMap(id)?.name ? `the ${getMap(id)!.name}` : 'this map';
  else if (kind === 'mode' && id) what = `${GAME_MODES.find((m) => m.key === id)?.name ?? 'this mode'}`;
  if (titleEl) titleEl.textContent = `Unlock ${what}`;

  const s = getAuthState();
  if (leadEl) leadEl.textContent = s.user
    ? "You're signed in — unlock everything below with a one-time purchase:"
    : "That's a premium track. Here's everything premium adds:";
  if (primary && secondary) {
    if (!s.user) {
      primary.textContent = 'CREATE ACCOUNT'; primary.dataset.act = 'signup';
      secondary.textContent = 'LOG IN';       secondary.dataset.act = 'login'; secondary.hidden = false;
    } else {
      // No price in the small upsell banner — it overflowed at some entry points.
      // The price still shows in the landing pricing section + the game-menu CTA.
      primary.textContent = 'GET PREMIUM'; primary.dataset.act = 'buy';
      secondary.hidden = true;
    }
  }
  upsellEl.hidden = false;
}
function closeUpsell() { if (upsellEl) upsellEl.hidden = true; }

// ---- Premium purchase (Stripe Checkout) ----
//   • already PREMIUM  → the account panel (nothing to buy)
//   • logged OUT       → remember the intent, prompt sign up / log in, then RESUME
//                        to checkout automatically once they're authenticated
//   • logged in, FREE  → create a Checkout Session server-side + redirect to Stripe
function startPremiumPurchase() {
  const s = getAuthState();
  if (s.isPremium) { setBuyIntent(false); openAuthModal('account'); return; }
  if (!s.user) { setBuyIntent(true); authMode = 'signup'; openAuthModal('form'); return; }
  setBuyIntent(false);
  void beginCheckout();
}

// ---- Interstitial premium promo (FREE / anonymous only) ----------------------
// A bold, animated "buy premium" pop-up shown at natural breaks: after START, on
// PAUSE, and when a game ENDS. Rules:
//   • PREMIUM users NEVER see it (gated on is_premium).
//   • GLOBAL cap: at most one every 3 minutes across all three trigger points.
//   • NEVER mid-drive — it's only ever fired from those non-driving moments.
//   • The X (dismiss) appears after ~5 s; before that it can't be closed.
//   • The CTA goes straight to the purchase flow (startPremiumPurchase): logged in
//     → Stripe checkout; logged out → signup first, buy-intent preserved → checkout.
const PROMO_COOLDOWN_MS = 3 * 60 * 1000;   // one promo per 3 min, across all triggers
const PROMO_CLOSE_DELAY_MS = 5000;         // X appears after ~5 s
let promoLastAt = -Infinity;
let promoCloseTimer = 0;
function maybeShowPremiumPromo(): void {
  if (!premiumPromoEl) return;
  if (getAuthState().isPremium) return;                       // premium: never
  if (!premiumPromoEl.hidden) return;                          // already showing
  const now = performance.now();
  if (now - promoLastAt < PROMO_COOLDOWN_MS) return;           // 3-min global cap
  promoLastAt = now;
  const x = document.getElementById('promo-close');
  if (x) x.hidden = true;                                      // no dismiss for the first 5 s
  premiumPromoEl.hidden = false;
  window.clearTimeout(promoCloseTimer);
  promoCloseTimer = window.setTimeout(() => {
    if (premiumPromoEl && !premiumPromoEl.hidden && x) x.hidden = false;
  }, PROMO_CLOSE_DELAY_MS);
}
function closePremiumPromo(): void {
  window.clearTimeout(promoCloseTimer);
  if (premiumPromoEl) premiumPromoEl.hidden = true;
}
document.getElementById('promo-cta')?.addEventListener('click', () => { closePremiumPromo(); startPremiumPurchase(); });
document.getElementById('promo-close')?.addEventListener('click', closePremiumPromo);
// Backdrop click closes it ONLY once the X is available (i.e. after the 5 s window).
premiumPromoEl?.addEventListener('click', (e) => {
  const x = document.getElementById('promo-close');
  if (e.target === premiumPromoEl && x && !x.hidden) closePremiumPromo();
});

// A short-lived "I want to buy Premium" flag that survives a login/signup detour
// (incl. the email-verification page reload) so the purchase resumes automatically.
const BUY_INTENT_KEY = 'steerit.buyIntent';
const BUY_INTENT_TTL = 60 * 60 * 1000;   // 1 hour
function setBuyIntent(on: boolean) {
  try { if (on) localStorage.setItem(BUY_INTENT_KEY, String(Date.now())); else localStorage.removeItem(BUY_INTENT_KEY); } catch { /* ignore */ }
}
function hasBuyIntent(): boolean {
  try {
    const v = localStorage.getItem(BUY_INTENT_KEY);
    if (!v) return false;
    const t = Number(v);
    if (Number.isFinite(t) && Date.now() - t < BUY_INTENT_TTL) return true;
    localStorage.removeItem(BUY_INTENT_KEY);
  } catch { /* ignore */ }
  return false;
}
// The page was opened via a Supabase auth redirect (email confirm / magic link) —
// captured at load BEFORE supabase-js consumes the URL. Used to resume a purchase
// on the verification return without firing on ordinary reloads.
const openedViaAuthRedirect = (() => {
  try { const s = location.hash + location.search; return /(access_token|refresh_token|[?#&]code)=/.test(s) || /type=(signup|magiclink|email|recovery)/.test(s); }
  catch { return false; }
})();
// Resume a purchase the user started before authenticating: only when logged in +
// an intent is pending. Deferred out of the auth callback (a DB read inside it can
// hang), and confirms FREE-vs-PREMIUM from the server so a premium account isn't
// sent to pay again.
function resumePurchaseIfIntended() {
  if (!hasBuyIntent()) return;
  if (!getAuthState().user) return;
  setBuyIntent(false);              // consume once
  closeAuthModal();
  window.setTimeout(() => { void (async () => {
    const st = await checkEntitlement();
    if (st.isPremium) { showToast('You already have Premium ✓'); return; }
    await beginCheckout();          // → Stripe hosted checkout
  })(); }, 0);
}
// A pending checkout guard + an instant loading overlay: the moment Get Premium
// starts a session the user sees "Redirecting to payment…" and can't double-click
// (the overlay blocks input; this guard also ignores repeat calls) — so we never
// create duplicate Checkout Sessions. On failure/timeout the overlay clears and a
// retryable error toast shows; on success the overlay stays through the redirect.
let checkoutStarting = false;
function setPayLoading(on: boolean) {
  const el = document.getElementById('pay-loading');
  if (el) el.hidden = !on;
}
// beginCheckout() no longer goes straight to Stripe — it first opens the CONSENT
// modal (digital content delivered immediately → the buyer waives the 14-day EU
// right of withdrawal). Only after the box is ticked + Continue do we create the
// Checkout Session, sending the recorded consent so the server stores it in the
// session metadata. This makes the non-refundable Refund Policy fair + enforceable.
const buyConsentEl = document.getElementById('buy-consent') as HTMLElement | null;
function resetBuyConsent() {
  const cb = document.getElementById('consent-agree') as HTMLInputElement | null;
  const go = document.getElementById('consent-go') as HTMLButtonElement | null;
  if (cb) cb.checked = false;
  if (go) go.disabled = true;
}
function closeBuyConsent() { if (buyConsentEl) buyConsentEl.hidden = true; resetBuyConsent(); }

async function beginCheckout() {
  if (checkoutStarting) return;                       // a session is already being created
  if (!buyConsentEl) { await createCheckoutSession(true, new Date().toISOString()); return; }
  resetBuyConsent();
  buyConsentEl.hidden = false;                         // → Continue calls createCheckoutSession()
}
document.getElementById('consent-agree')?.addEventListener('change', (e) => {
  const go = document.getElementById('consent-go') as HTMLButtonElement | null;
  if (go) go.disabled = !(e.target as HTMLInputElement).checked;
});
document.getElementById('consent-cancel')?.addEventListener('click', closeBuyConsent);
buyConsentEl?.addEventListener('click', (e) => { if (e.target === buyConsentEl) closeBuyConsent(); });
document.getElementById('consent-go')?.addEventListener('click', () => {
  const cb = document.getElementById('consent-agree') as HTMLInputElement | null;
  if (!cb?.checked) return;                            // must be ticked to proceed
  const consentAt = new Date().toISOString();
  closeBuyConsent();
  void createCheckoutSession(true, consentAt);
});

async function createCheckoutSession(consent: boolean, consentAt: string) {
  if (checkoutStarting) return;   // already creating a session → ignore repeat clicks
  checkoutStarting = true;
  setPayLoading(true);            // INSTANT feedback, before any network work
  const stop = (msg?: string) => { setPayLoading(false); checkoutStarting = false; if (msg) showToast(msg, true); };
  const token = await getAccessToken();
  if (!token) { setPayLoading(false); checkoutStarting = false; authMode = 'login'; openAuthModal('form'); return; }
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 15000);   // don't hang forever
  try {
    const r = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // The consent is recorded server-side in the Checkout Session metadata.
      body: JSON.stringify({ acceptWithdrawalWaiver: consent, consentAt }),
      signal: ctrl.signal,
    });
    window.clearTimeout(timer);
    if (r.status === 401) { setPayLoading(false); checkoutStarting = false; authMode = 'login'; openAuthModal('form'); return; }
    const data = await r.json().catch(() => ({} as { url?: string }));
    if (!r.ok || !data.url) { stop('Something went wrong — please try again.'); return; }
    window.location.href = data.url;   // success → Stripe hosted checkout (page unloads; keep the overlay + guard)
  } catch {
    window.clearTimeout(timer);
    stop('Something went wrong — please try again.');
  }
}

// On return from Stripe: the FALLBACK for a missed/late webhook. Confirms the
// session is paid + belongs to this user (server retrieves it from Stripe) and
// upgrades if needed, then re-reads the entitlement so the UI flips to PREMIUM.
async function handleCheckoutReturn(s: AuthState) {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('checkout');
  if (!outcome) return;
  const sessionId = params.get('session_id') || '';
  history.replaceState(null, '', location.pathname + location.hash);   // clean the URL
  if (outcome === 'cancel') { showToast('Checkout canceled — no charge made.'); return; }
  if (outcome !== 'success') return;
  const token = s.user ? await getAccessToken() : null;
  if (token && /^cs_/.test(sessionId)) {
    try { await fetch(`/api/verify-session?session_id=${encodeURIComponent(sessionId)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); }
    catch { /* the webhook is the primary path; ignore a transient verify error */ }
  }
  await checkEntitlement();
  showToast(getAuthState().isPremium ? '★ Premium unlocked — thanks for the support!' : 'Payment received — unlocking Premium…');
}

// Minimal on-brand toast (auto-dismiss). Created on demand; no markup needed.
let toastTimer = 0;
function showToast(text: string, isError = false) {
  let el = document.getElementById('app-toast');
  if (!el) { el = document.createElement('div'); el.id = 'app-toast'; document.body.appendChild(el); }
  el.textContent = text;
  el.classList.toggle('is-error', isError);
  el.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove('show'), 5000);
}

// ---- Wire the controls ----
// Logged-out entry points open the auth modal on the right tab; the chip (logged in)
// opens the account panel.
document.getElementById('account-signup')?.addEventListener('click', () => {
  authMode = 'signup'; openAuthModal('form');
});
document.getElementById('account-login')?.addEventListener('click', () => {
  authMode = 'login'; openAuthModal('form');
});
document.getElementById('account-btn')?.addEventListener('click', () => {
  openAuthModal(getAuthState().user ? 'account' : 'form');
});
document.getElementById('btn-get-premium')?.addEventListener('click', startPremiumPurchase);
document.getElementById('auth-close')?.addEventListener('click', closeAuthModal);
authModalEl?.addEventListener('click', (e) => { if (e.target === authModalEl) closeAuthModal(); });
document.getElementById('auth-toggle')?.addEventListener('click', () => {
  authMode = authMode === 'login' ? 'signup' : 'login'; applyAuthMode();
  signupNick.reset();      // clear any stale nickname-availability hint on mode switch
  setAuthMsg('', false);   // drop any stale (e.g. "passwords don't match") message
});
// Live feedback: clear the mismatch error the moment the two signup passwords agree.
document.getElementById('auth-password2')?.addEventListener('input', () => {
  if (authMode !== 'signup') return;
  const pw = (document.getElementById('auth-password') as HTMLInputElement).value;
  const pw2 = (document.getElementById('auth-password2') as HTMLInputElement).value;
  if (pw2 && pw === pw2) setAuthMsg('', false);
});
document.getElementById('auth-forgot')?.addEventListener('click', () => authSection('forgot'));
document.getElementById('forgot-back')?.addEventListener('click', () => authSection('form'));

document.getElementById('auth-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = (document.getElementById('auth-email') as HTMLInputElement).value.trim();
  const pw = (document.getElementById('auth-password') as HTMLInputElement).value;
  const submit = document.getElementById('auth-submit') as HTMLButtonElement;
  // SIGN UP: the two passwords must match + the nickname must be valid before we submit.
  if (authMode === 'signup') {
    const pw2El = document.getElementById('auth-password2') as HTMLInputElement | null;
    if (pw2El && pw !== pw2El.value) {
      setAuthMsg('Passwords don\'t match.', true);
      pw2El.focus();
      return;
    }
    const nickEl = document.getElementById('auth-nickname') as HTMLInputElement | null;
    const fmt = nicknameFormatError(nickEl?.value || '');
    if (fmt) { setAuthMsg(fmt, true); nickEl?.focus(); return; }
  }
  submit.disabled = true; setAuthMsg('Working…', false);
  const done = (err?: string, ok?: string) => {
    submit.disabled = false;
    if (err) setAuthMsg(err, true); else if (ok) setAuthMsg(ok, false);
  };
  if (authMode === 'signup') {
    const nickInput = () => document.getElementById('auth-nickname') as HTMLInputElement | null;
    const nick = nickInput()?.value.trim() || '';
    // Authoritative availability + profanity check (DB) right before creating the
    // account, so the common "taken/profane" cases give a clean message; the signup
    // trigger is the final race guard.
    void checkNickname(nick).then((cr) => {
      if (!cr.ok || !cr.available) { done(nickReasonMsg(cr.reason)); nickInput()?.focus(); return; }
      void signUp(email, pw, nick).then((r) => {
        if (r.alreadyRegistered) {
          // The normalized email already has an account → switch to LOG IN (keeps
          // their email typed) with a clear message, buy-intent preserved.
          submit.disabled = false;
          authMode = 'login'; applyAuthMode();
          setAuthMsg('This email is already registered — log in instead.', true);
          return;
        }
        if (r.nicknameTaken) { done('That nickname was just taken — try another.'); nickInput()?.focus(); return; }
        if (r.error) return done(r.error);
        if (r.needsVerification) {
          // Intent (if any) stays in localStorage → checkout resumes after the email
          // link brings them back logged in.
          done(undefined, hasBuyIntent()
            ? 'Check your email to verify — then we\'ll take you straight to checkout.'
            : 'Check your email to verify your account, then log in.');
        } else { closeAuthModal(); done(); resumePurchaseIfIntended(); }   // instant session → resume
      });
    });
  } else {
    void signIn(email, pw).then((r) => {
      if (r.error) return done(r.error);
      closeAuthModal(); done();
      resumePurchaseIfIntended();   // ← the reported bug: continue to checkout, don't just stop
    });
  }
});
document.getElementById('forgot-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = (document.getElementById('forgot-email') as HTMLInputElement).value.trim();
  setAuthMsg('Sending…', false);
  void sendPasswordReset(email).then((r) => {
    if (r.error) setAuthMsg(r.error, true);
    else setAuthMsg('If that email has an account, a reset link is on its way.', false);
  });
});
document.getElementById('recovery-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = (document.getElementById('recovery-password') as HTMLInputElement).value;
  setAuthMsg('Saving…', false);
  void updatePassword(pw).then((r) => {
    if (r.error) setAuthMsg(r.error, true);
    else { setAuthMsg('Password updated — you\'re logged in.', false); setTimeout(closeAuthModal, 900); }
  });
});
document.getElementById('account-signout')?.addEventListener('click', () => {
  void signOut().then(closeAuthModal);
});
document.getElementById('account-upgrade')?.addEventListener('click', () => { closeAuthModal(); startPremiumPurchase(); });

// ---- Change-nickname editors: the auth-modal account panel AND the OPTIONS panel
// (the logged-in host reaches account via OPTIONS, so it needs its own copy). ----
wireNickEditor({ editId: 'account-nick-edit', editorId: 'account-nick-editor',
  fieldsId: 'account-nick-fields', cooldownId: 'account-nick-cooldown',
  inputId: 'account-nick-input', cancelId: 'account-nick-cancel', saveId: 'account-nick-save',
  validator: accountNick });
wireNickEditor({ editId: 'gm-nick-edit', editorId: 'gm-nick-editor',
  fieldsId: 'gm-nick-fields', cooldownId: 'gm-nick-cooldown',
  inputId: 'gm-nick-input', cancelId: 'gm-nick-cancel', saveId: 'gm-nick-save',
  validator: gmNick });

document.getElementById('upsell-close')?.addEventListener('click', closeUpsell);
upsellEl?.addEventListener('click', (e) => { if (e.target === upsellEl) closeUpsell(); });
const upsellAct = (btn: HTMLElement | null) => btn?.addEventListener('click', () => {
  const act = btn.dataset.act;
  closeUpsell();
  // The user clicked a locked map/mode and chose to authenticate from the premium
  // pitch → remember the buy intent so checkout auto-resumes once they're logged in
  // (the SAME reliable path as the Get Premium button). resumePurchaseIfIntended
  // re-reads entitlement first, so an already-premium account is never charged again.
  if (act === 'signup') { setBuyIntent(true); authMode = 'signup'; openAuthModal('form'); }
  else if (act === 'login') { setBuyIntent(true); authMode = 'login'; openAuthModal('form'); }
  else if (act === 'buy') { startPremiumPurchase(); }
  // 'close' → just closed above
});
upsellAct(document.getElementById('upsell-primary'));
upsellAct(document.getElementById('upsell-secondary'));

initAuth();
onAuthChange(renderAccount);
// Handle a return from Stripe Checkout exactly once, after auth first resolves
// (the fallback verify + entitlement refresh needs the restored session).
let checkoutReturnHandled = false;
onAuthChange((s) => {
  if (checkoutReturnHandled || s.loading) return;
  checkoutReturnHandled = true;
  void handleCheckoutReturn(s);
});
// Resume a pending purchase when the user lands back logged in via an email
// verification / magic-link redirect (the signup path). Gated on that redirect so
// it NEVER fires on an ordinary reload of a restored session.
let authRedirectResumeDone = false;
onAuthChange((s) => {
  if (authRedirectResumeDone || s.loading || !s.user) return;
  authRedirectResumeDone = true;
  if (openedViaAuthRedirect) resumePurchaseIfIntended();
});
// Manual entitlement check for the host to verify premium is recognised:
// run `steerCheckEntitlement()` in the browser console → logs what the client
// actually read from `profiles` and refreshes the FREE/PREMIUM chip.
(window as unknown as { steerCheckEntitlement: () => void }).steerCheckEntitlement =
  () => { void checkEntitlement(); };
// Billing self-diagnostic: run `await steerBillingDebug()` in the console (logged
// in) → hits /api/billing-debug with your token and logs which key/role is live +
// whether the service key can read/write your profile row. Paste the output here.
(window as unknown as { steerBillingDebug: () => Promise<unknown> }).steerBillingDebug = async () => {
  const token = await getAccessToken();
  if (!token) { console.log('[billing-debug] not logged in'); return null; }
  const r = await fetch('/api/billing-debug', { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({ error: 'bad json', status: r.status }));
  console.log('[billing-debug]', JSON.stringify(j, null, 2));
  return j;
};

goHome();   // landing (logged out) or game menu (logged in) — auth resolves via onAuthChange

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
  clearMarkLayers();
  for (const car of cars.values()) {
    const pose = currentMap.spawn(car.slot, world);
    car.state = makeCar(pose.x, pose.y, pose.heading);
    car.target = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    car.current = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    invalidateSkidTrails(car);
    car.lastInputAt = performance.now();
  }
  raceManager.reset();   // every car's laps/time/phase → zero
  armStandingStart();    // ...and line them up again for a fresh 3-2-1-GO
  resetRaceFeed();       // clear finish feed + podium + raceResultsOpen
  userPaused = false;
  refreshFreeze();
}
// EXIT TO MENU → back to the CAR & MAP SELECTION screen for the SAME mode (Arcade race
// → Arcade selection, Sim → Sim), with the mode and the last car/map pick kept, so the
// host can immediately pick something else and re-START. BACK from there still walks
// further out (selection → mode choice → main menu). Players stay connected (lobby/cars
// preserved); the game is held (menuOpen freeze, QR hidden) until a map is launched
// again, which respawns the cars via switchMap. No phone is dropped, no QR rescan.
function exitToSelection() {
  userPaused = false;
  resetRaceFeed();   // drop any finish feed / podium so it's clean next race
  openCarMapSelect();
}
document.getElementById('btn-resume')?.addEventListener('click', resumeGame);
document.getElementById('btn-restart')?.addEventListener('click', restartRace);
document.getElementById('btn-exit-menu')?.addEventListener('click', exitToSelection);
// Race results (podium): RACE AGAIN returns to the warm-up (cars drive freely, READY
// starts the next race — the same flow); EXIT goes back to the CAR & MAP selection.
// Both clear the podium + feed.
document.getElementById('btn-rematch')?.addEventListener('click', backToRaceWarmup);
document.getElementById('btn-results-menu')?.addEventListener('click', exitToSelection);
// READY (host) — line everyone up on the grid and start the 3-2-1-GO.
readyBtn?.addEventListener('click', startRaceFromWarmup);

// ---------- Canvases ----------
// Layered rendering (back to front):
//   wallpaper (static offscreen) → skid marks (persistent offscreen)
//   → overlay: icons + taskbar (static offscreen) → clock → car.
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const skidCanvas = document.createElement('canvas');
const skidCtx = skidCanvas.getContext('2d')!;
// TYRE-MARK MODE — one active system at a time.
//   'race'  (default): the SATURATION system (marks.ts) — threshold-gated, per-surface
//           capped, an offscreen accumulation layer. Clean laps leave nothing; a drift
//           lays a line that darkens toward a per-surface cap and then STOPS. It is now
//           the single active system on EVERY map (desktop + both ovals + circuit).
//   'paint' (future DRAWING MODE, wired but inactive): the old UNBOUNDED per-car skid
//           system (the legacy skidCanvas path below) — no threshold, ever-darkening,
//           tinted per car. Kept for a future paint-the-track mode; flip via
//           window.steerSetMarkMode('paint'). No per-frame cost while off (the inactive
//           system's layer is never written to nor blitted).
type MarkMode = 'race' | 'paint';
let markMode: MarkMode = 'race';
const tyreMarks = new TyreMarks();
let marksLive = false;
// The saturation system is active for every map whenever we're in 'race' mode.
const marksEnabled = () => markMode === 'race';
const wallpaperCanvas = document.createElement('canvas');
const wallpaperCtx = wallpaperCanvas.getContext('2d')!;
const overlayCanvas = document.createElement('canvas');
const overlayCtx = overlayCanvas.getContext('2d')!;

// The canvas art is a flat cartoon (no fine text — the HUD/menus are HTML DOM and
// stay crisp at the display's real DPR regardless). Rendering the game canvas at a
// full 2–3× retina backing store is pure fill-rate cost with no benefit for this
// style — and on a HiDPI Mac it's the whole-game stall (every full-canvas blit +
// fillRect + car/fx/shadow pass scales with dpr²). So CAP the backing store: at
// dpr>1.5 the scene is drawn at 1.5× and the browser upscales to the panel (a hair
// softer, still supersampled). dpr≤1.5 displays (the boss's non-retina panel = 1.0)
// are UNTOUCHED — Math.min(1, 1.5) = 1 ⇒ byte-identical. Fill cost at native 2.0 →
// 1.5 is ×(1.5/2)² = 0.56. Tunable in one place.
const MAX_BACKING_DPR = 1.5;
const backingDpr = () => Math.min(window.devicePixelRatio || 1, MAX_BACKING_DPR);

let dpr = backingDpr();

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
  dpr = backingDpr();
  const W = window.innerWidth, H = window.innerHeight;

  // Clamp the main canvas backing to safe limits (VERIFY + downscale) so a huge/high-DPI viewport
  // can't silently blank it. Drawing stays in CSS px; the backing scale just drops (softer) if
  // capped. On normal screens the scale equals dpr → identical.
  const canvasScale = sizeCanvasFitted(canvas, W, H, dpr);
  ctx.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const { wM, hM } = logicalMeters();
  const lpW = Math.max(1, Math.round(wM * CONFIG.pxPerMeter));
  const lpH = Math.max(1, Math.round(hM * CONFIG.pxPerMeter));

  if (currentMap.followCam) {
    // FOLLOW-CAM: render at the OVAL's scale so the car is the STANDARD on-screen
    // size (min(W/screen, H/screen) is exactly what the fixed oval uses at this
    // window). The world is bigger than the view; render() sets the camera offset
    // (viewOffX/Y) per-frame to keep the lead car centred.
    const sw = (window.screen && window.screen.width) || 1920;
    const sh = (window.screen && window.screen.height) || 1080;
    viewScale = Math.min(W / sw, H / sh);
    viewOffX = 0; viewOffY = 0;
  } else {
    // Uniform scale-to-fit + centre. Desktop: lpW=W, lpH=H ⇒ scale 1, offset 0.
    viewScale = Math.min(W / lpW, H / lpH);
    viewOffX = (W - lpW * viewScale) / 2;
    viewOffY = (H - lpH * viewScale) / 2;
  }

  // Follow-cam worlds are bigger than one screen; cap the offscreen backing-store
  // dpr so a pre-render layer never exceeds the ~4096 px canvas/texture limit (it
  // would blank on some GPUs). The blit scales the backing store to CSS px anyway,
  // so this touches only pre-render sharpness — the car/HUD keep full dpr (main
  // canvas). Non-follow-cam maps (oval/desktop) are UNCHANGED (layerDprEff = dpr).
  const layerDprEff = currentMap.followCam
    ? Math.min(dpr, 4096 / Math.max(lpW, lpH))
    : dpr;

  if (lpW === logicalPxW && lpH === logicalPxH && layerDprEff === layerDpr) return false;
  logicalPxW = lpW; logicalPxH = lpH; layerDpr = layerDprEff;
  const layers: Array<[HTMLCanvasElement, CanvasRenderingContext2D]> = [
    [skidCanvas, skidCtx],
    [wallpaperCanvas, wallpaperCtx], [overlayCanvas, overlayCtx],
  ];
  for (const [cv, cx] of layers) {
    // Clamp each layer's backing to safe canvas limits (VERIFY + downscale). Everything draws in
    // LOGICAL px and render() blits with an explicit dest size, so a capped backing is only
    // lower-res, never garbled. On normal screens the fitted scale equals layerDprEff → identical.
    const s = sizeCanvasFitted(cv, lpW, lpH, layerDprEff);
    cx.setTransform(s, 0, 0, s, 0, 0);
  }
  return true;
}

// The mark layers live at the LOGICAL pixel size — the same grid the track is pre-rendered
// at, so 1 layer px = 1 on-screen px at fullscreen and a 3 px rubber line is exactly as crisp
// as the skid line it replaces, with no resampling. (The surface MASK is a coarse 4 px/m
// because it only answers a yes/no question; marks are SEEN, so they need render resolution.)
// Two RGBA bitmaps ~= 2 x logicalPx x 4 B ~= 16 MB at 1920x1080 — FIXED (no per-frame growth),
// allocated for every map now that the saturation system is the active one in 'race' mode. Sized
// at `layerDpr` (= backingDpr(), the MAX_BACKING_DPR-capped ratio) so HiDPI can't inflate them.
function ensureMarkLayers() {
  if (marksLive || !marksEnabled()) return;   // marksEnabled = we're in 'race' mode
  tyreMarks.resize(logicalPxW, logicalPxH, layerDpr);
  marksLive = true;
}
function clearMarkLayers() { tyreMarks.clear(); }
/** Force a rebuild at the next map's logical size (map switch / resize). */
function releaseMarkLayers() { tyreMarks.clear(); marksLive = false; }

// Bake the current map's surface into the wallpaper layer, capping the WORKING resolution so no
// scratch/texture/mask canvas the surface bake allocates can exceed the safe canvas limits — a
// weak GPU can silently blank one of those and garble the whole composite (worst on the circuit,
// which allocates many screen-sized working canvases). When a cap is needed the surface is drawn
// into a fitted temp and blit-scaled up (a touch softer, never garbled). On normal screens the
// cap is 1 → drawn directly into the wallpaper, byte-identical to before.
let _wallpaperRetry = 0;   // one-shot re-bake scheduled after a failed bake (memory transient)
function bakeWallpaperRaw() {
  if (typeof document === 'undefined' || fitCanvasScale(logicalPxW, logicalPxH, 1) >= 1) {
    currentMap.drawBackground(wallpaperCtx, logicalPxW, logicalPxH);
    return;
  }
  const tmp = document.createElement('canvas');
  sizeCanvasFitted(tmp, logicalPxW, logicalPxH, 1);   // fitted (+ verified) working size
  const tcx = tmp.getContext('2d');
  if (!tcx) { currentMap.drawBackground(wallpaperCtx, logicalPxW, logicalPxH); return; }
  currentMap.drawBackground(tcx, tmp.width, tmp.height);   // whole surface at the capped resolution
  wallpaperCtx.save();
  wallpaperCtx.imageSmoothingEnabled = true;
  wallpaperCtx.drawImage(tmp, 0, 0, logicalPxW, logicalPxH);   // blit-scale to logical units
  wallpaperCtx.restore();
}
// DEFENSIVE: a surface-bake exception (a canvas allocation / getImageData failing under memory
// pressure) must NEVER leave the wallpaper cleared → a BLACK track. If drawBackground throws,
// we (1) fill a neutral ground tone so something sensible shows, (2) log, and (3) schedule ONE
// re-bake shortly after (by which point the churn we just fixed has usually freed the memory).
function bakeWallpaper() {
  try {
    noteStep(`bake:${currentMap.id}`, bakeWallpaperRaw);
  } catch (err) {
    noteError('wallpaper-bake', err);
    console.warn('[map] wallpaper bake failed — filling fallback ground + retrying:', err);
    try {
      wallpaperCtx.save();
      wallpaperCtx.setTransform(layerDpr, 0, 0, layerDpr, 0, 0);
      wallpaperCtx.fillStyle = '#141c12';   // dark grass/ground — never pure black
      wallpaperCtx.fillRect(0, 0, logicalPxW, logicalPxH);
      wallpaperCtx.restore();
    } catch { /* even the fallback fill failed — leave as-is */ }
    if (!_wallpaperRetry) {
      _wallpaperRetry = window.setTimeout(() => {
        _wallpaperRetry = 0;
        clearSurfaceCaches();   // drop any half-baked cached textures before retrying
        try { bakeWallpaperRaw(); } catch (e) { console.warn('[map] wallpaper re-bake failed:', e); }
      }, 250);
    }
  }
}

function resize() {
  // Layers are only rebuilt when their logical size/dpr changed: every time for
  // the desktop (logical = viewport), but for the fixed oval only on first build,
  // a map switch, or a dpr change — so a plain resize keeps its skids + race.
  if (syncCanvasesAndView()) {
    draggedObstacle = null;
    // The logical grid changed, so the mark layers are the wrong size: drop them and let
    // ensureMarkLayers() rebuild at the new one (same as every other layer being cleared).
    releaseMarkLayers();
    // Evict the surface texture caches — they key a full screen-sized canvas per (size, angle)
    // and would otherwise accumulate one per resize / map-switch (the leak behind the failing
    // allocations). The next bakeWallpaper re-bakes exactly the current size on demand.
    clearSurfaceCaches();
    const { wM, hM } = logicalMeters();
    world = currentMap.createWorld(wM, hM);
    bakeWallpaper();
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

// The surface fill bitmap is preloaded at startup (preloadSurfaceAssets, below) so it is normally
// already decoded before the circuit is ever reached → the first bake uses it, no grey→pop. This
// stays as a one-shot safety net: if the circuit is somehow reached before the decode lands, this
// repaints the (static) wallpaper once when it arrives (a clean full re-bake).
setCircuitSurfaceReady(() => {
  if (logicalPxW > 0 && logicalPxH > 0) {
    bakeWallpaper();
  }
});

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

// ---------- Clickable AD billboards (canvas hit-test) ----------
// Billboards with a configured ad are clickable AT ALL TIMES (incl. during a race — players use
// phones, the mouse is free). Hover shows a pointer cursor; a click opens the ad URL in a new tab.
// Hit-testing maps the screen point to WORLD metres and asks the map (adAt) for the ad on the
// billboard's oriented on-screen face. Maps without ads (adAt undefined) are unaffected.
canvas.addEventListener('pointermove', (e) => {
  if (editorMode || draggedObstacle || !currentMap.adAt) return;   // editor/drag own the cursor
  const { x, y } = screenToWorld(e.clientX, e.clientY);
  canvas.style.cursor = currentMap.adAt(x, y) ? 'pointer' : 'default';
});
canvas.addEventListener('click', (e) => {
  if (editorMode || !currentMap.adAt) return;
  const { x, y } = screenToWorld(e.clientX, e.clientY);
  const url = currentMap.adAt(x, y);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
});

// Start the async surface bitmap (asphalt) load+decode NOW, so it is decoded long before the
// circuit is navigated to — the first circuit bake then uses the real texture, deterministically,
// with no grey→pop and no reliance on the async re-bake.
preloadSurfaceAssets();

resize();
window.addEventListener('resize', resize);

// ---------- Cars — one per connected lobby slot (built for N) ----------
const PX = () => CONFIG.pxPerMeter;

// Half the car's rendered length, centre → nose. Bound to the same wheelbase × art-ratio
// drawCar builds the body from, so the point we time laps at is exactly the nose you see.
const CAR_NOSE_M = CONFIG.wheelbase * 0.865;   // m ≈ 2.22

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
  // GRASS dig tracks — one trail per wheel, in DESKTOP L/R order [fL, fR, rL, rR].
  // Only ever used on a map with a surface mask in physics4 (see wheelGrass).
  dig: WheelTrail[];
  lastInputAt: number;   // performance.now() of the last control packet (liveness)
  inputStale: boolean;   // currently RECONNECTING (ramping/neutral)? (for D-debug)
  coastInput: Inputs | null;  // snapshot of the last live input, taken at ramp
                              //   start so the ramp eases from it to neutral
  local?: boolean;       // keyboard-driven LOCAL test car (no phone) — exempt from
                         //   the lobby sweep / syncCars removal; fed by driveKeyboard()
  spec: VehicleSpec;     // the car's variant (Blitz RS or a Stee-Rex skin)
  liveryColor?: string;  // fixed body hex from the spec; drawCar uses it over the slot colour
  collisionRadius: number;  // per-vehicle wall/car collision radius (from its real dimensions)
  phys: Physics4Params;  // the car's physics4 params (sim = the shared PHYS4; arcade = a tuned clone)
  fxScale: number;       // off-track particle multiplier (render-only; 1 = Blitz default)
}

// Blitz RS's collision radius is CONFIG.carCollisionRadius (wheelbase-derived). A sprite
// car with its own dimensions gets a proportionally smaller radius — the SAME
// radius/length ratio as Blitz RS, so it collides at the right size for its footprint.
const BLITZ_LEN_M = CONFIG.wheelbase * 0.865 * 2;   // Blitz RS drawn length (the one ruler)
function collisionRadiusFor(spec: VehicleSpec): number {
  if (!spec.dims) return CONFIG.carCollisionRadius;   // Blitz RS → unchanged (0.0e+0)
  return CONFIG.carCollisionRadius * (spec.dims.lengthM / BLITZ_LEN_M);
}
// The car's VISUAL half-extents (metres) for the capsule wall collision — so the car's visible
// edge touches the wall exactly. Blitz RS = its drawn footprint (native 0.75×0.309 half-extents
// × the ART scale); a sprite car states its own dims.
function carHalfExtents(spec: VehicleSpec): { halfLen: number; halfWidth: number } {
  if (spec.dims) return { halfLen: spec.dims.lengthM / 2, halfWidth: spec.dims.widthM / 2 };
  const ART = CONFIG.wheelbase * 0.865 / 0.75;
  return { halfLen: 0.75 * ART, halfWidth: 0.309 * ART };   // ≈ 2.22 × 0.914
}

// The car's physics4 params for its handling branch. SIM (Blitz RS) = the SHARED PHYS4
// reference (so the D-tuner keeps working + it stays byte-identical). ARCADE (Stee-Rex) =
// a clone of PHYS4 with the arcade branch + the spec's per-car overrides (empty at Stage 1
// ⇒ numerically identical to PHYS4, i.e. still behaves like sim until the tune lands).
function physFor(spec: VehicleSpec): Physics4Params {
  if (spec.branch !== 'arcade') return PHYS4;
  return { ...PHYS4, ...(spec.arcade ?? {}), branch: 'arcade' };
}

// Resolve a spec to a car's livery + collision size + physics branch. Called at spawn /
// on a vehicle switch.
function applyVariant(car: Car, spec: VehicleSpec) {
  car.spec = spec;
  car.liveryColor = spec.liveryColor;
  car.collisionRadius = collisionRadiusFor(spec);
  car.phys = physFor(spec);
  car.fxScale = spec.fxScale ?? 1;
}

// Keyed by slot so routing/lookup is O(1) and nothing is hardcoded to 2 cars.
const cars = new Map<number, Car>();
const DEFAULT_CAR_COLOR = '#1d3fa0';

// The race MODE, chosen in the menu, IS the physics branch + car family for
// EVERY car: SIM → Blitz RS (sim branch, its colour palette); ARCADE → Stee-Rex
// (arcade branch, silver/black skins). Each phone then picks its own colour/skin.
// (`raceMode` itself is declared up by the join URL — it is encoded into the QR.)
// The colour palette offered for the current mode (sent to phones; the picker). ONE mapping
// (lobby.paletteForMode) shared with the phone's `?m=` first-paint hint so they can't drift.
function activePalette(): CarColor[] {
  return paletteForMode(raceMode) ?? BLITZ_RS_COLORS;
}
// Resolve a car's VehicleSpec from the mode + its chosen colour. SIM → always
// Blitz RS (colour tints the vector body). ARCADE → the Stee-Rex skin whose
// swatch matches the colour (Graphite → black, anything else → silver default).
function specForColor(hex: string): VehicleSpec {
  if (raceMode !== 'arcade') return ROAD_SPEC;
  return hex.toLowerCase() === STEEREX_SKIN_COLORS[1].hex.toLowerCase()
    ? STEEREX_BLACK : STEEREX_SILVER;
}
// Representative spec for the mode (both Stee-Rex skins share dims) — used for the
// car-car collision radius (all cars in a race share the mode's footprint).
function modeSpec(): VehicleSpec { return raceMode === 'arcade' ? STEEREX_SILVER : ROAD_SPEC; }
// Re-spec every live car to the current mode + its own colour (on mode launch).
function applyModeToAllCars() {
  for (const c of cars.values()) applyVariant(c, specForColor(c.color));
}
// Input behaviour through a packet gap is governed by the UNIFIED lifecycle —
// hold (coast) → ramp to neutral → parked-in-place — all keyed off RESILIENCE
// (lobby.ts), the single source of truth. See the per-frame block in the loop.
// Replaces the old standalone STALE_INPUT_MS hard-zero (de1f475/47319e6).

function makeManagedCar(slot: number, color: string): Car {
  const pose = currentMap.spawn(slot, world);   // per-map spawn layout
  const car: Car = {
    slot,
    state: makeCar(pose.x, pose.y, pose.heading),
    color,
    skidStyle: skidColorFor(color),
    target: { steer: 0, throttle: 0, brake: 0, handbrake: false },
    current: { steer: 0, throttle: 0, brake: 0, handbrake: false },
    dig: [0, 0, 0, 0].map(() => ({ px: 0, py: 0, active: false })),
    skidL: { px: 0, py: 0, active: false },
    skidR: { px: 0, py: 0, active: false },
    lastInputAt: performance.now(),
    inputStale: false,
    coastInput: null,
    spec: ROAD_SPEC,                            // overwritten by applyVariant below
    collisionRadius: CONFIG.carCollisionRadius, // ditto
    phys: PHYS4,                                // ditto
    fxScale: 1,                                 // ditto
  };
  applyVariant(car, specForColor(color));   // spawn in the mode's variant for this colour
  return car;
}

// The "primary" car drives the single HUD / engine sound / race timer — the
// lowest connected slot (slot 0 in the solo case, so nothing changes there).
function primaryCar(): Car | null {
  let best: Car | null = null;
  for (const c of cars.values()) if (!best || c.slot < best.slot) best = c;
  return best;
}

// LOCAL keyboard driving: set the slot-0 LOCAL car's target inputs from the keys,
// the SAME Inputs a phone would send (smoothed to `current` + stepped identically).
// Lazy-spawns the local car on the first key press in gameplay (so phone mode is
// untouched when unused); a paired phone owning slot 0 (not local) makes it inert.
function driveKeyboard() {
  if (menuOpen || userPaused || editorMode) return;   // gameplay only
  const active = keyDrive.up || keyDrive.down || keyDrive.left || keyDrive.right || keyDrive.hb;
  let kc = cars.get(0);
  if (!kc) {
    if (!active) return;                          // no car + no key → don't spawn a stray
    kc = makeManagedCar(0, DEFAULT_CAR_COLOR);
    kc.local = true;
    cars.set(0, kc);
  }
  if (!kc.local) return;                          // a phone owns slot 0 → keyboard inert
  kc.target.steer    = (keyDrive.right ? 1 : 0) - (keyDrive.left ? 1 : 0);
  kc.target.throttle = keyDrive.up ? 1 : 0;
  kc.target.brake    = keyDrive.down ? 1 : 0;
  kc.target.handbrake = keyDrive.hb;
  kc.lastInputAt = performance.now();             // local input is never "stale" → no ramp-to-neutral
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
      applyVariant(existing, specForColor(p.color));   // ARCADE: colour = skin, re-spec
    }
  }
  for (const slot of [...cars.keys()]) {
    if (!live.has(slot) && !cars.get(slot)?.local) {   // keep the local keyboard test car
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
  hideFinishTimeout();
}

// The display name for a slot — the single source of truth for the standings, the
// finish feed, the podium and the roster.
//   • HOST: the local (keyboard-driven) car is the logged-in desktop account. Its
//     name is the ACCOUNT NICKNAME, locked — a phone can never set it, because the
//     host isn't a lobby/phone slot (phones can only rename their own slot).
//   • GUESTS (phones): their self-chosen lobby name, or "Player N" if unset.
function playerName(slot: number): string {
  if (cars.get(slot)?.local) {
    const nick = getAuthState().nickname;
    if (nick && nick.trim()) return nick.trim();
  }
  const p = lobby.snapshot().find((q) => q.slot === slot);
  return (p?.name && p.name.trim()) || `Player ${slot + 1}`;
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

// LIVE STANDINGS (top-left) — every connected car ordered P1..PN by lap + progress,
// updated each frame. FINISHED cars lock at the top (✓); still-racing cars follow,
// re-ordering live as they overtake. Uses the same playerName resolver (host
// nickname / guest name / "Player N"). Only touches the DOM when the order/laps
// change. While it's up it OWNS the top-left corner, so the transient finish-feed
// notice is suppressed (finishers show here already) — the finishFeed data + the
// podium are untouched.
let liveStandingsSig = '';
// Throttle the (allocating) standings recompute to ~11 Hz — see updateLiveStandings.
let liveStandingsAt = -1e9;
const STANDINGS_RECOMPUTE_MS = 90;
function updateLiveStandings(now: number): void {
  if (!liveStandingsEl) return;
  const show = isRaceLive() && !menuOpen && !userPaused && !editorMode && !raceResultsOpen;
  // Hiding is a cheap check → keep it responsive every frame.
  if (!show) {
    if (!liveStandingsEl.hidden) { liveStandingsEl.hidden = true; liveStandingsSig = ''; }
    return;
  }
  // But liveOrder() allocates several arrays + per-slot lookups, and the position
  // labels change only rarely — recomputing 60×/s was wasted GC. Throttle to ~11Hz;
  // the DOM still only changes when the order actually does (sig guard below), and a
  // sub-100ms label refresh is imperceptible. (No behaviour/visual change.)
  if (now - liveStandingsAt < STANDINGS_RECOMPUTE_MS) return;
  liveStandingsAt = now;
  const order = raceManager.liveOrder(cars.keys(), now);
  if (!order.length) {
    if (!liveStandingsEl.hidden) { liveStandingsEl.hidden = true; liveStandingsSig = ''; }
    return;
  }
  if (finishFeedEl) finishFeedEl.hidden = true;   // the standings own the top-left corner
  const sig = order.map((o) => `${o.slot}.${o.position}.${o.lap}.${o.finished ? 1 : 0}`).join('|');
  if (sig === liveStandingsSig && !liveStandingsEl.hidden) return;   // unchanged → no DOM churn
  liveStandingsSig = sig;
  liveStandingsEl.hidden = false;
  liveStandingsEl.classList.toggle('compact', order.length > 6);
  liveStandingsEl.innerHTML = order.map((o) => {
    const color = cars.get(o.slot)?.color || DEFAULT_CAR_COLOR;
    const lap = o.finished ? '✓' : `L${o.lap}`;
    return `<div class="ls-row" style="--c:${color}">`
      + `<span class="ls-pos">P${o.position}</span>`
      + `<span class="ls-name">${escapeHtml(playerName(o.slot))}</span>`
      + `<span class="ls-lap">${lap}</span></div>`;
  }).join('');
}

// The race ended — either everyone finished, or the DNF timeout expired. Freeze +
// show the podium (top-3 FINISHERS) + a rest list of remaining finishers and DNF
// stragglers. `now` builds the final standings (finishers + ranked DNF).
function openRaceResults(now: number) {
  raceResultsOpen = true;
  refreshFreeze();
  if (finishFeedEl) finishFeedEl.hidden = true;
  hideFinishTimeout();

  // Full standings from the race manager: finishers first, then connected-but-unfinished
  // cars as DNF (ranked after them). Finisher name/colour come from the feed (captured at
  // finish, so a later disconnect can't corrupt it); a DNF car is still connected → live.
  const rows = raceManager.results(cars.keys(), now).map((r) => {
    const fed = finishFeed.find((f) => f.slot === r.slot);
    return {
      position: r.position, dnf: r.dnf,
      finishMs: r.dnf ? 0 : (fed?.finishMs ?? r.finishMs),
      name: fed?.name ?? playerName(r.slot),
      color: fed?.color ?? cars.get(r.slot)?.color ?? DEFAULT_CAR_COLOR,
    };
  });

  // Podium steps: P2 (left), P1 (centre, tallest), P3 (right) — FINISHERS only. A DNF
  // never takes a podium step; an empty step just means nobody earned that place.
  for (const pos of [1, 2, 3]) {
    const e = rows.find((x) => x.position === pos && !x.dnf);
    const pod = raceResultsEl?.querySelector(`.pod-${pos}`) as HTMLElement | null;
    if (!pod) continue;
    pod.hidden = !e;
    if (e) {
      (pod.querySelector('.pod-name') as HTMLElement).textContent = e.name;
      (pod.querySelector('.pod-time') as HTMLElement).textContent = formatRaceTime(e.finishMs);
      pod.style.setProperty('--c', e.color);
    }
  }
  // Below the podium: finishers 4th+ AND every DNF car, in rank order (DNF shows "DNF").
  if (resultsRestEl) {
    resultsRestEl.innerHTML = rows.filter((e) => e.dnf || e.position >= 4).map((e) =>
      `<div class="rr-row${e.dnf ? ' rr-dnf' : ''}"><span>P${e.position}</span>` +
      `<span class="rr-name" style="color:${e.color}">${escapeHtml(e.name)}</span>` +
      `<span>${e.dnf ? 'DNF' : formatRaceTime(e.finishMs)}</span></div>`).join('');
  }
  if (raceResultsEl) raceResultsEl.hidden = false;
  maybeShowPremiumPromo();   // promo on game END (free/anon, capped) — over the podium
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
    invalidateSkidTrails(car);
    car.lastInputAt = performance.now();
  }
  skidCtx.clearRect(0, 0, logicalPxW, logicalPxH);
  clearMarkLayers();
  if (xpEndEl) xpEndEl.hidden = true;
}

// End of a run: bank the score, beat-the-best check + persist, fill the end card.
function handleXpEnd() {
  xpEndHandled = true;
  const score = Math.floor(xpRun.xp);
  const isRecord = score > xpBest;
  if (isRecord) { xpBest = score; saveXpBest(score); }
  if (xpEndRecordEl) xpEndRecordEl.hidden = !isRecord;
  if (xpEndLabelEl) {
    xpEndLabelEl.textContent = xpRun.endReason === 'crash' ? 'CRASHED'
      : xpRun.endReason === 'offtrack' ? 'OFF TRACK' : 'TOO SLOW';
  }
  if (xpEndScoreEl)  xpEndScoreEl.textContent = formatXp(score);
  if (xpEndBestEl)   xpEndBestEl.textContent  = `BEST ${formatXp(xpBest)}`;
  if (xpEndEl) xpEndEl.hidden = false;
  maybeShowPremiumPromo();   // promo on game END (XP run over) — free/anon, capped
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
  // Defense-in-depth on the paywall: a RACE on the Desktop free map can ONLY come from
  // the E editor (premium-only). If the account isn't premium (e.g. logged out while the
  // editor was open), don't leave a paid race running — drop it back to free-roam.
  if (currentMap.id === 'desktop' && !isPremium()) raceElements.length = 0;
  raceManager = new RaceManager(raceElements, { ...RACE_CONFIG, laps: Math.max(1, editorLaps) });
  armStandingStart();
  resetRaceFeed();
}

// STANDING START: a lap race begins with the grid held for a 3-2-1-GO countdown, and the
// clock starts at GO. Only for a CIRCUIT-type track with a real lap race — free-roam
// (laps 0 ⇒ no elements) and sprint tracks (which keep their flying start off the first
// crossing) never arm it, so their behaviour is untouched.
// Armed here, STARTED on the next frame: the countdown must run on the pause-adjusted game
// clock (which only exists inside the loop, and freezes while paused so a pause can't burn
// the countdown), and restartRace can be called while still paused.
let pendingStandingStart = false;
function armStandingStart() {
  pendingStandingStart = isRaceLive() && isCircuitMap();
  if (!pendingStandingStart) hideCountdown();
}

// ---- RACE WARM-UP → READY → GO ------------------------------------------------
// A race doesn't start on load. The cars spawn on track and drive FREELY (the map
// sits in its free-roam state: no start line in the race logic ⇒ isRaceLive() false
// ⇒ no countdown, no lap counting, no HUD) while everyone joins and warms up. The
// host presses READY, which lines everyone up on the grid and runs the 3-2-1-GO.
function enterRaceWarmup(laps: number) {
  pendingRaceLaps = Math.max(1, laps);
  raceWarmup = true;
  circuitMode = 'laps';        // not XP
  editorLaps = 0;              // free roam: no start line ⇒ free driving, no counting
  document.body.classList.remove('circuit-xp');
  if (xpEndEl) xpEndEl.hidden = true;
  syncModeButtons();
  rebuildRace();               // builds NO elements at laps 0 ⇒ isRaceLive() false, cars free
  updateEditorStatus();
  updateReadyButton();
}
// READY: snap every car back to its grid slot (clean pose, zeroed velocity + inputs),
// commit the lap count, and arm the standing start → the 3-2-1-GO countdown begins,
// then the race proper (lap counting, positions) runs.
function startRaceFromWarmup() {
  if (!raceWarmup) return;
  raceWarmup = false;
  skidCtx.clearRect(0, 0, logicalPxW, logicalPxH);   // wipe warm-up skids/marks
  clearMarkLayers();
  for (const car of cars.values()) {
    const pose = currentMap.spawn(car.slot, world);
    car.state = makeCar(pose.x, pose.y, pose.heading);   // fresh state ⇒ velocity + yaw zeroed
    car.target = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    car.current = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    invalidateSkidTrails(car);
    car.lastInputAt = performance.now();
  }
  editorLaps = pendingRaceLaps;
  rebuildRace();               // builds the start line + arms the standing start (countdown)
  updateEditorStatus();
  updateReadyButton();
}
// After a race FINISHES the podium shows the result; its main action returns to the
// warm-up so cars can drive freely again and READY starts the next race — the same flow.
function backToRaceWarmup() {
  resetRaceFeed();             // close the podium (raceResultsOpen → false)
  enterRaceWarmup(pendingRaceLaps);
  userPaused = false;
  refreshFreeze();             // unfreeze now the podium is gone
}

// How long "GO!" lingers after the grid unlocks. Display only — the cars are already free
// (race.ts flipped to 'racing' at the GO instant, which is also when the clock started).
const GO_HOLD_MS = 800;
let countdownShown = '';
function hideCountdown() {
  if (countdownEl) countdownEl.hidden = true;
  countdownShown = '';
}

// DNF timeout banner: once the LEADER finishes, the still-racing cars see how long
// they have left to finish (M:SS) before they're marked DNF. Hidden until the leader
// crosses and while the podium is up. Only touches the DOM when the second changes.
let finishTimeoutShown = '';
function hideFinishTimeout() {
  if (finishTimeoutEl) finishTimeoutEl.hidden = true;
  finishTimeoutShown = '';
}
function updateFinishTimeout(now: number) {
  if (!finishTimeoutEl) return;
  const left = isRaceLive() && !raceResultsOpen ? raceManager.graceMsLeft(now) : null;
  if (left === null || left <= 0) { hideFinishTimeout(); return; }
  const s = Math.ceil(left / 1000);
  const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (label === finishTimeoutShown) return;   // DOM touch only on a second change
  finishTimeoutShown = label;
  finishTimeoutEl.hidden = false;
  finishTimeoutEl.innerHTML =
    `<span class="ft-label">RACE ENDS IN</span><span class="ft-time">${label}</span>`;
}
function updateCountdown(now: number) {
  if (!countdownEl || !countdownNEl) return;
  const left = isRaceLive() ? raceManager.countdownMs(now) : 0;
  let label = '';
  if (left > 0) label = String(Math.ceil(left / 1000));          // 3 → 2 → 1
  else if (isRaceLive() && raceManager.locked(now) === false) {
    // GO lingers briefly after unlock, then the HUD is clear for the race.
    const h = raceManager.hud(primaryCar()?.slot ?? -1, now);
    if (h.phase === 'racing' && h.elapsedMs < GO_HOLD_MS) label = 'GO!';
  }
  if (label === countdownShown) return;                          // only touch the DOM on a change
  countdownShown = label;
  if (!label) { countdownEl.hidden = true; return; }
  countdownEl.hidden = false;
  countdownEl.classList.toggle('go', label === 'GO!');
  // Re-trigger the punch animation for each new beat.
  countdownNEl.textContent = label;
  countdownNEl.style.animation = 'none';
  void countdownNEl.offsetWidth;
  countdownNEl.style.animation = '';
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
  // mode + palette ride along so each phone builds the RIGHT colour picker
  // (SIM → Blitz colours, ARCADE → Stee-Rex silver/black) and drives the right car.
  const payload = { players: lobby.snapshot(), cap: PLAYER_CAP, mode: raceMode, colors: activePalette() };
  // BOTH transports: Realtime for fallback/mid-pairing phones, the reliable
  // "state" DataChannel for P2P phones (they LEFT the Realtime channel).
  rc.send({ type: 'broadcast', event: EV.lobby, payload });
  rtcHost.broadcastState(EV.lobby, payload);
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
    const label = escapeHtml(playerName(p.slot));   // same name resolver as the standings/podium
    return `<div class="roster-row">` +
      `<span class="roster-dot" style="background:${p.color};box-shadow:0 0 8px ${p.color}"></span>` +
      `<span class="roster-name">${label}</span>` +
      `<span class="roster-color">${colorName(p.color)}</span>` +
      `<span class="roster-ok">●</span>` +
    `</div>`;
  }).join('');
}

// ---- phone → desktop handlers — TRANSPORT-AGNOSTIC (the seam) ----
// One function per event, called from BOTH transports: the Realtime channel
// (wireDesktop below) and the WebRTC DataChannels (rtcHost callbacks). The
// input pipeline, lobby, and RESILIENCE liveness behave identically either way.
function handleJoin(payload: unknown) {
  const p = payload as { id?: unknown; color?: string; name?: string };
  const id = String(p?.id ?? '');
  if (!id) return;
  const r = lobby.join(id, p?.color, Date.now(), p?.name);
  if (r.slot === null) {
    // lobby full — tell the phone on whichever transport reaches it
    rc.send({ type: 'broadcast', event: EV.full, payload: { id } });
    rtcHost.sendStateTo(id, EV.full, { id });
  } else if (r.changed) {
    broadcastLobby();
  }
}

function handleColor(payload: unknown) {
  const id = String((payload as { id?: unknown })?.id ?? '');
  const color = (payload as { color?: string })?.color;
  if (!id || !color) return;
  if (lobby.setColor(id, color, Date.now()).changed) broadcastLobby();
}

function handleName(payload: unknown) {
  const id = String((payload as { id?: unknown })?.id ?? '');
  const name = (payload as { name?: string })?.name;
  if (!id || name === undefined) return;
  if (lobby.setName(id, name, Date.now()).changed) broadcastLobby();
}

function handleLeave(payload: unknown) {
  const id = String((payload as { id?: unknown })?.id ?? '');
  if (id && lobby.leave(id).changed) broadcastLobby();
}

function handleControl(payload: unknown) {
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
}

// Route a phone→desktop one-shot arriving on the reliable "state" DataChannel
// (the phone leaves the Realtime channel once P2P is up, so join heartbeats,
// color, name, and leave arrive HERE for P2P phones).
function handleStateMessage(_id: string, msg: { ev: string; payload: unknown }) {
  switch (msg.ev) {
    case EV.join: handleJoin(msg.payload); break;
    case EV.color: handleColor(msg.payload); break;
    case EV.name: handleName(msg.payload); break;
    case EV.leave: handleLeave(msg.payload); break;
  }
}

// WebRTC host — one peer per phone (phone-initiated offers over the Realtime
// channel; the desktop's channel stays subscribed forever to serve signaling
// for new/reconnecting players). Control packets route through the SAME
// handleControl as Realtime ones.
const rtcHost = createRtcHost({
  signal: (event, payload) => rc.send({ type: 'broadcast', event, payload }),
  onControl: (_id, payload) => handleControl(payload),
  onStateMessage: handleStateMessage,
  // STEP 3: per-pairing connection-path log — the boss-visible split. 'relay'
  // = the TURN relay carried it; 'direct' = pure P2P; 'unknown' = stats absent.
  onPeerConnected: (id, pc) => {
    connectionInfoOf(pc).then((info) => {
      const label = info.path === 'relay' ? 'relay (TURN)' : info.path;
      // The candidate types are printed so the path is VERIFIABLE, not just asserted:
      // a relayed pairing shows `relay` on at least one end (a phone forced with
      // ?rtc=relay shows remote=relay while this desktop stays host/srflx).
      console.info(
        `[rtc] ${nowIso()} player ${id} connected via ${label}`
        + ` [local=${info.local ?? '?'} remote=${info.remote ?? '?'}]`,
      );
    });
  },
});

// STEP 3: phones still driving over Realtime with no RTC peer after 12 s are
// on the FALLBACK path — log once per id so the split is visible at a glance.
const rtcFallbackLog = createFallbackTracker(12000, (id) =>
  console.info(`[rtc] ${nowIso()} player ${id} connected via fallback (Realtime)`));

// ---- Realtime wiring (re-attached to every (re)created channel) ----
function wireDesktop(ch: RealtimeChannel) {
  ch.on('broadcast', { event: EV.join }, ({ payload }) => handleJoin(payload));
  ch.on('broadcast', { event: EV.color }, ({ payload }) => handleColor(payload));
  ch.on('broadcast', { event: EV.name }, ({ payload }) => handleName(payload));
  ch.on('broadcast', { event: EV.leave }, ({ payload }) => handleLeave(payload));
  ch.on('broadcast', { event: EV.control }, ({ payload }) => {
    // Realtime-wire only (DC control never reaches here): feed the fallback
    // detector so a phone stuck on Realtime gets its one-line path log.
    const fid = String((payload as { id?: unknown })?.id ?? '');
    if (fid) rtcFallbackLog.note(fid, rtcHost.hasPeer(fid), performance.now());
    handleControl(payload);
  });
  // WebRTC signaling (phone → desktop): offers + trickle ICE.
  ch.on('broadcast', { event: RTC_EV.offer }, ({ payload }) => rtcHost.handleSignal(RTC_EV.offer, payload));
  ch.on('broadcast', { event: RTC_EV.ice }, ({ payload }) => rtcHost.handleSignal(RTC_EV.ice, payload));
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

function frontWheelPositions(state: CarState) {
  const halfTrack = CONFIG.trackWidth / 2;
  const frontOffset = CONFIG.wheelbase / 2;
  const L = bodyToWorld(state, frontOffset, +halfTrack);
  const R = bodyToWorld(state, frontOffset, -halfTrack);
  return { L, R };
}

function drawSkidSegment(
  trail: WheelTrail, wx: number, wy: number, sliding: boolean, style: string,
  width = 3,
) {
  const px = wx * PX();
  const py = wy * PX();
  if (sliding) {
    if (trail.active) {
      // Don't draw across an edge-wrap jump.
      const dx = px - trail.px, dy = py - trail.py;
      if (dx * dx + dy * dy < 10000) {
        skidCtx.strokeStyle = style;
        skidCtx.lineWidth = width;
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

// ---------- SURFACE: per-wheel ground (physics4 + a masked map only) ----------
// physics4's wheel order is 0 FL 1 FR 2 RL 3 RR with ry = [−T/2, +T/2, −T/2, +T/2], and
// bodyToWorld's `by` IS ry — so desktop's L (by = +halfTrack) is physics4's +y index, i.e.
// its "R". Hence the crossed mapping below. Returns all-asphalt unless we're in physics4 on a
// map that has a surface mask ⇒ every off-road visual stays dead code elsewhere.
const ALL_ASPHALT: Surface[] = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
/** Ground under each wheel in DESKTOP L/R order: [fL, fR, rL, rR]. */
function wheelSurfaces(car: Car): Surface[] {
  if (!currentMap.surfaceAt) return ALL_ASPHALT;
  const g = wheelDebug(car.state)?.surface;
  return g ? [g[1], g[0], g[3], g[2]] : ALL_ASPHALT;
}
// Per-wheel LATERAL slip, same crossed mapping (front L/R, rear L/R).
function wheelSlips(car: Car): [number, number, number, number] {
  const sl = wheelDebug(car.state)?.slip;
  return sl ? [sl[1], sl[0], sl[3], sl[2]] : [0, 0, 0, 0];
}
// DIG TRACKS — gouged ground. Wider than the 3 px rubber skid, and the opacity is jittered
// per segment so the track reads as patchy dug material rather than a clean drawn line.
// GRAVEL gouges deeper than turf: darker (the stone's own shadow tone) and a touch wider. TUNE:
const DIG_TRACK_WIDTH = 5;         // px — grass (rubber skid is 3)
const DIG_TRACK_ALPHA = 0.5;       // mean opacity (jittered ×0.65–1.35 per segment)
const DIG_TRACK_RGB = '96,68,40';  // dug turf — brown
const GRAVEL_TRACK_WIDTH = 7;      // px — gravel gouges are wider
const GRAVEL_TRACK_ALPHA = 0.55;
const GRAVEL_TRACK_RGB = '74,70,60';   // gouged stone — the gravel's darker tone
const digStyle = (surf: Surface) => {
  const [rgb, al] = surf === 'gravel'
    ? [GRAVEL_TRACK_RGB, GRAVEL_TRACK_ALPHA] : [DIG_TRACK_RGB, DIG_TRACK_ALPHA];
  return `rgba(${rgb},${((al as number) * (0.65 + Math.random() * 0.7)).toFixed(3)})`;
};
// A wheel is DIGGING when it's spinning up or scrubbing sideways — the SAME thresholds the
// smoke uses. Rolling calmly over grass digs nothing (→ no track, no dust).
function digging(car: Car, slip: number, rear: boolean) {
  return (rear && car.state.wheelSpin > 0.2)
    || Math.abs(slip) > CONFIG.slipThresholdForSkid;
}

// Render-only mark class for the saturation system: circuit reads its per-point mask;
// desktop + ovals use the map's single markClass (rubber on asphalt, brown scuff on the
// dirt oval), defaulting to 'asphalt'. NEVER read by the physics.
function markClassFn(): (x: number, y: number) => MarkClass {
  // A map with a single constant markClass (both ovals, desktop) uses it directly — the DIRT
  // oval keeps its brown 'gravel' scuff. ONLY the circuit (per-point surface mask, no constant
  // markClass) reads markClassAt. (A constant surfaceAt like the dirt oval's is NOT the circuit,
  // so it must not fall into the per-point branch → it would wrongly read 'asphalt'.)
  const c = currentMap.markClass;
  if (c) return () => c;
  if (currentMap.surfaceAt) return (x, y) => markClassAt(currentMap, x, y);
  return () => 'asphalt';
}

function recordSkids(car: Car) {
  if (markMode === 'race') {
    // SATURATION system, EVERY map. All four wheels mark by slip energy, threshold-gated,
    // saturating per surface — see marks.ts. The legacy per-car trails stay idle.
    tyreMarks.record(car.state, wheelSurfaces(car), wheelSlips(car), markClassFn(), PX());
    car.skidL.active = car.skidR.active = false;
    for (const d of car.dig) d.active = false;
    return;
  }
  // ---- 'paint' DRAWING MODE — the legacy UNBOUNDED per-car skid system (every map) ----
  const s = car.state;
  const driftingRear =
    s.isRearSliding || Math.abs(s.rearSlip) > CONFIG.slipThresholdForSkid;
  const surf = wheelSurfaces(car);
  const { L, R } = rearWheelPositions(s);
  // Rubber skid — rear only, and only for a rear wheel actually ON asphalt (a wheel off the
  // tarmac gouges the ground, it doesn't lay rubber). Off a masked map every wheel is
  // 'asphalt' ⇒ identical to before.
  drawSkidSegment(car.skidL, L.x, L.y, driftingRear && surf[2] === 'asphalt', car.skidStyle);
  drawSkidSegment(car.skidR, R.x, R.y, driftingRear && surf[3] === 'asphalt', car.skidStyle);
  if (surf.every((v) => v === 'asphalt')) { for (const d of car.dig) d.active = false; return; }
  // DIG TRACKS — every wheel digging into grass/gravel, world-anchored like skids.
  const f = frontWheelPositions(s);
  const sl = wheelSlips(car);
  const pos = [f.L, f.R, L, R];
  for (let i = 0; i < 4; i++) {
    const off = surf[i] !== 'asphalt';
    const dug = off && digging(car, sl[i], i >= 2);
    drawSkidSegment(car.dig[i], pos[i].x, pos[i].y, dug, digStyle(surf[i]),
      surf[i] === 'gravel' ? GRAVEL_TRACK_WIDTH : DIG_TRACK_WIDTH);
  }
}


// ---------- World wrap (per car) — delegated to the active map ----------
// The map owns its bounds + wrap behaviour (the desktop wraps L/R/top and
// re-enters above the taskbar). Returns true when the car teleported, so we
// break its skid trail.
function wrap(car: Car) {
  if (currentMap.wrap(car.state, world)) invalidateSkidTrails(car);
}
function invalidateSkidTrails(car: Car) {
  // After wrapping/respawning we don't want a long streak across the screen.
  tyreMarks.cut(car.state);
  car.skidL.active = false;
  car.skidR.active = false;
  for (const d of car.dig) d.active = false;
}

// Tire smoke from one car's rear wheels while drifting or spinning — the visual
// twin of the squeal. state.rearSlip is speed-gated in physics, so a parked car
// (slip == 0) only smokes from genuine WSPIN (standing burnout), never atan2
// noise. Emission is capped globally by the shared Effects pool.
function emitCarSmoke(car: Car, realDt: number) {
  const s = car.state;
  const tint = currentMap.smokeColor;   // undefined ⇒ default white smoke
  const sizeScale = 0.55 + 0.45 * Math.min(1, s.speed / 6);
  const slideFull = CONFIG.slipThresholdForSkid * 2.5;   // lateral slip → full slide intensity
  const surf = wheelSurfaces(car);
  // A wheel digging OFF the tarmac throws the ground's own material instead of rubber smoke,
  // via the dirt-oval mechanism, world-anchored (inheritVel 0) so it marks where it dug:
  //   GRASS  → a small BROWN puff (turf doesn't billow like a flattrack)
  //   GRAVEL → a STONE SPRAY in the trap's light grey-beige, more pronounced than the dust
  //            (loose stone is genuinely thrown), and bigger/denser per gravelSpray*.
  // Per-car off-track intensity: an arcade car (Stee-Rex) cranks size + rate for a brutal,
  // dense throw; Blitz's fxScale is 1 → byte-identical to before.
  const fxs = car.fxScale;
  const spray = (x: number, y: number, intensity: number, ground: Surface) => {
    const gravel = ground === 'gravel';
    fx.emitSmoke(x, y, s.vx, s.vy, intensity, realDt,
      sizeScale * (gravel ? FX_CONFIG.gravelSpraySize : FX_CONFIG.grassDustSize) * fxs,
      gravel ? GRAVEL_SPRAY_RGB : GRASS_DUST_RGB, 0,
      gravel ? FX_CONFIG.gravelSprayAlpha : FX_CONFIG.grassDustAlpha,
      gravel ? FX_CONFIG.gravelSprayScale * fxs : FX_CONFIG.grassDustScale * fxs);
  };

  // ---- BURNOUT smoke — LONGITUDINAL wheelspin (launch / full throttle). Dense,
  // spawned slightly BEHIND the rear wheels and BILLOWS with the car (inheritVel
  // default) — the classic burnout plume. Unchanged.
  const burnoutInt = s.wheelSpin;
  if (burnoutInt > 0.2) {
    const back = 0.45;
    const bx = -Math.cos(s.heading) * back, by = -Math.sin(s.heading) * back;
    const { L, R } = rearWheelPositions(s);
    // a rear wheel spinning up OFF the tarmac digs the ground → its own spray, at the contact point
    if (surf[2] !== 'asphalt') spray(L.x, L.y, burnoutInt, surf[2]);
    else fx.emitSmoke(L.x + bx, L.y + by, s.vx, s.vy, burnoutInt, realDt, sizeScale, tint);
    if (surf[3] !== 'asphalt') spray(R.x, R.y, burnoutInt, surf[3]);
    else fx.emitSmoke(R.x + bx, R.y + by, s.vx, s.vy, burnoutInt, realDt, sizeScale, tint);
  }

  // ---- SLIDE smoke — LATERAL scrub (four-wheel slide / oversteer). Thinner, born
  // at the tyre CONTACT POINT and WORLD-ANCHORED (inheritVel 0 → the puff stays put
  // and the car slides AWAY from it, marking where the tyre ground the asphalt).
  // Emitted from EVERY scrubbing wheel — rear (rearSlip) AND front (frontSlip) =
  // the whole car sliding. Tuned: visible tyre-scrub wisp, not a drift cloud.
  const SL_INHERIT = 0, SL_ALPHA = 0.6, SL_RATE = 0.75;
  const rearSlide = Math.min(1, Math.abs(s.rearSlip) / slideFull);
  if (rearSlide > 0.4) {
    const { L, R } = rearWheelPositions(s);
    if (surf[2] !== 'asphalt') spray(L.x, L.y, rearSlide, surf[2]);
    else fx.emitSmoke(L.x, L.y, s.vx, s.vy, rearSlide, realDt, sizeScale, tint, SL_INHERIT, SL_ALPHA, SL_RATE);
    if (surf[3] !== 'asphalt') spray(R.x, R.y, rearSlide, surf[3]);
    else fx.emitSmoke(R.x, R.y, s.vx, s.vy, rearSlide, realDt, sizeScale, tint, SL_INHERIT, SL_ALPHA, SL_RATE);
  }
  const frontSlide = Math.min(1, Math.abs(s.frontSlip) / slideFull);
  if (frontSlide > 0.4) {
    const { L, R } = frontWheelPositions(s);
    if (surf[0] !== 'asphalt') spray(L.x, L.y, frontSlide, surf[0]);
    else fx.emitSmoke(L.x, L.y, s.vx, s.vy, frontSlide, realDt, sizeScale, tint, SL_INHERIT, SL_ALPHA, SL_RATE);
    if (surf[1] !== 'asphalt') spray(R.x, R.y, frontSlide, surf[1]);
    else fx.emitSmoke(R.x, R.y, s.vx, s.vy, frontSlide, realDt, sizeScale, tint, SL_INHERIT, SL_ALPHA, SL_RATE);
  }
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
    driveKeyboard();   // LOCAL TESTING: feed keyboard → slot-0 local car (no phone needed)
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
      // STANDING START: while the shared countdown runs, the grid is HELD. Phone inputs
      // keep arriving and keep updating car.target (so the connection lifecycle is
      // untouched) — they are simply not applied, and the car is pinned, so nobody can
      // creep or jump the start. On GO this goes false for every car in the same frame.
      if (pendingStandingStart) { raceManager.beginCountdown(gameNow); pendingStandingStart = false; }
      const gridLocked = isRaceLive() && raceManager.locked(gameNow);
      for (const car of cars.values()) {
        const { current, target } = car;
        if (gridLocked) {
          // Ignore inputs + pin the car exactly where it was spawned.
          current.steer = current.throttle = current.brake = 0;
          current.handbrake = false;
          car.state.vx = car.state.vy = 0;
          car.state.angularVel = 0;
          continue;   // the per-car raceManager.update below still runs (it ticks the countdown)
        }
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

        // physics4 (per-wheel sim) drives every car. The map's ground lookup ARMS the
        // per-wheel grass/gravel grip+drag; every map except the circuit passes undefined
        // → the off-asphalt branches never run (byte-identical on desktop + both ovals).
        step4(car.state, current, FIXED_DT, car.phys, currentMap.surfaceAt);
        const he = carHalfExtents(car.spec);
        let impact = collideWithRects(car.state, world.rects, CONFIG, he.halfLen, he.halfWidth);
        if (world.arcs) {
          impact = Math.max(impact,
            collideWithArcs(car.state, world.arcs, CONFIG, he.halfLen, he.halfWidth));
        }
        if (impact > 0.8) {
          fx.impact(car.state.x, car.state.y, impact);
        }
        if (car === lead && impact > XP_CONFIG.crashImpact) xpCrash = true;
      }

      // Cars bounce off EACH OTHER (arcade, clamped) after all have integrated.
      if (cars.size > 1) {
        // All cars share the mode's footprint, so one radius covers every pair.
        const carImpact = collideCars([...cars.values()].map((c) => c.state), collisionRadiusFor(modeSpec()));
        if (carImpact > 0.8 && lead) fx.impact(lead.state.x, lead.state.y, carImpact);
      }

      // Per-car trails + edge wrap; race detection PER CAR (multi-car race).
      for (const car of cars.values()) { recordSkids(car); wrap(car); }
      // Each car races independently — velocity drives the directional start-line
      // crossing (circuit anti-cheat). The manager records finishing order.
      //
      // TIMING IS ON THE NOSE, as a real transponder/beam is: what we feed the race is the
      // car's FRONT-MOST point, not its centre, so a lap trips the instant the nose reaches
      // the line. race.ts itself is untouched — armed/far-point/wrong-way all run exactly as
      // before, just on that point. (The far point is a whole track width across, so reading
      // it at the nose rather than the centre is nothing.)
      if (isRaceLive()) {
        for (const [slot, car] of cars) {
          const s = car.state;
          raceManager.update(slot, s.x + Math.cos(s.heading) * CAR_NOSE_M,
            s.y + Math.sin(s.heading) * CAR_NOSE_M, gameNow, s.vx, s.vy);
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
      // Complete when everyone's finished OR the DNF grace window (after the leader)
      // expired — so a stuck car can never hang the podium.
      if (!raceResultsOpen && raceManager.isComplete(cars.keys(), gameNow)) openRaceResults(gameNow);
    }

    // ---- XP MODE: read the SOLO car's speed + sideways slip + off-track wheels and
    // accrue score. Pure read — physics/drift untouched. Banks + shows the end card on end.
    if (isXpMode() && lead && xpRun.active) {
      // Off-track = a wheel on a surface that is NOT one of THIS map's racing surfaces
      // (per-map, not "asphalt = track" hardcoded — so the dirt oval, where dirt IS the
      // track, doesn't read as off-track). >2 off ends the run. Only bites where the map
      // has a surface mask (the circuit); the barrier-bounded ovals lean on their crash-end.
      const onTrack = currentMap.trackSurfaces ?? ['asphalt'];
      const off = wheelSurfaces(lead).filter((s) => !onTrack.includes(s)).length;
      updateXpRun(xpRun, realDt, lead.state.speed, lead.state.rearSlip, xpCrash, off);
      if (xpRun.ended && !xpEndHandled) handleXpEnd();
    }

    // (Engine sound removed — no audio; see the SOUND IS REMOVED note above.)

    // ---- Tire smoke — emitted PER CAR. The Effects pool is hard-capped
    // (FX_CONFIG.maxParticles) and shared, so N cars can't blow the budget.
    for (const car of cars.values()) emitCarSmoke(car, realDt);
    fx.update(realDt);
  }

  // Render ALWAYS (paused frame still draws the frozen car + overlay on top).
  render();
  updateRaceHud(raceManager.hud(primaryCar()?.slot ?? -1, gameNow));
  updateLiveStandings(gameNow);
  updateCountdown(gameNow);
  updateFinishTimeout(gameNow);
  updateXpHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Follow camera (world bigger than the screen) --------------------
// For a followCam map the world is bigger than the view and viewScale is fixed at
// the oval's scale (car = standard size). Each frame we set viewOffX/Y so the lead
// car sits centred, clamped to the world so we never scroll past its edges. All
// downstream render + screenToWorld math already reads viewOffX/Y, so nothing else
// changes. Non-follow-cam maps never call this (their offset is the letterbox).
function updateCamera() {
  const W = window.innerWidth, H = window.innerHeight;
  const vw = W / viewScale, vh = H / viewScale;        // visible area in LOGICAL px
  const lead = primaryCar();
  const cxPx = (lead ? lead.state.x : logicalPxW / CONFIG.pxPerMeter / 2) * CONFIG.pxPerMeter;
  const cyPx = (lead ? lead.state.y : logicalPxH / CONFIG.pxPerMeter / 2) * CONFIG.pxPerMeter;
  let camX = cxPx - vw / 2, camY = cyPx - vh / 2;
  camX = logicalPxW > vw ? Math.max(0, Math.min(logicalPxW - vw, camX)) : (logicalPxW - vw) / 2;
  camY = logicalPxH > vh ? Math.max(0, Math.min(logicalPxH - vh, camY)) : (logicalPxH - vh) / 2;
  viewOffX = -camX * viewScale;
  viewOffY = -camY * viewScale;
}

// ---------- Render ----------
function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  if (currentMap.followCam) updateCamera();
  ensureMarkLayers();   // sizes the saturation layers on first render of each map ('race' mode)

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
  // Exactly ONE mark system composites (the other's layer is never written, so this also
  // skips its blit → no per-frame cost for the inactive mode). RACE = the saturation layers
  // (dug turf, then a multiply darkening pass that keeps kerbs/gravel/racing-line legible);
  // PAINT = the legacy per-car skid canvas. Both sit under the cars.
  if (markMode === 'paint') ctx.drawImage(skidCanvas, viewOffX, viewOffY, dw, dh);
  else if (marksLive) tyreMarks.draw(ctx, viewOffX, viewOffY, dw, dh);
  ctx.drawImage(overlayCanvas, viewOffX, viewOffY, dw, dh);

  // Dynamic layers draw in LOGICAL pixel space; the same uniform scale + offset
  // fits them to the window, so cars/gates/fx track the world exactly.
  ctx.save();
  ctx.translate(viewOffX, viewOffY);
  ctx.scale(viewScale, viewScale);
  currentMap.drawForeground?.(ctx, world, CONFIG.pxPerMeter);
  drawRaceElements();
  for (const car of cars.values()) drawCar(car);  // paint every connected car
  currentMap.drawAboveCars?.(ctx, world, CONFIG.pxPerMeter);  // tall props occlude cars under them
  fx.draw(ctx, CONFIG.pxPerMeter);
  ctx.restore();

  ctx.restore();
  updateHud();
}

// The single gameplay HUD reflects the PRIMARY car (lowest slot). With no car
// connected it idles at zeros so nothing reads stale.
function updateHud() {
  // The whole speed/DRIFT/SLIP/WSPIN/pedals HUD lives in #hud-bl, which is HIDDEN
  // unless the D debug overlay is on (the default screen is just world + QR). So
  // during normal gameplay every write below (8 DOM props + string formatting) was
  // pure per-frame waste — skip it entirely while hidden. When D is pressed it
  // updates live again from the next frame. No visible change.
  if (!debugOn) return;

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
      `MODE: PHYSICS4 (per-wheel sim)\n` +
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
  const hasMult = xpRun.mult > 1.05;
  if (xpMultEl) {
    xpMultEl.hidden = !hasMult;
    if (hasMult) xpMultEl.textContent = '×' + xpRun.mult.toFixed(1);
  }
  // GRID combo indicator: a bar that's FULL while drifting (window re-armed each frame) and
  // DRAINS during the hold — the visible countdown pressure. Hidden with no combo.
  if (xpComboEl && xpComboFillEl) {
    const active = hasMult && xpRun.comboMs > 0;
    xpComboEl.hidden = !active;
    if (active) {
      const frac = Math.max(0, Math.min(1, xpRun.comboMs / XP_CONFIG.comboWindowMs));
      xpComboFillEl.style.width = (frac * 100).toFixed(1) + '%';
      // pulse red when the window is nearly gone (< ~0.8 s) so the pressure reads at a glance
      xpComboEl.classList.toggle('low', xpRun.comboMs < 800);
    }
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
// Blit the cached Stee-Rex sprite at its OWN real dimensions: the sprite's measured
// opaque WIDTH (over the tyres) is scaled to the vehicle's real widthM, so the length
// follows automatically at the sprite's aspect ratio (uniform scale, no distortion).
// Drawn about the opaque-bbox centre (the rotation pivot); the bitmap's nose points UP,
// so +90° aligns it with +x (heading) exactly like the Blitz RS vector.
function drawSteerex(car: Car, skin: SteerexSkin) {
  const cv = steerexSprite(skin);
  const op = steerexOpaque();
  if (!cv || !op) return;   // not decoded/measured yet — preloaded at startup, momentary
  const s = car.state;
  const widM = car.spec.dims?.widthM ?? CONFIG.trackWidth;   // real width over the tyres
  const scale = (widM * PX()) / op.widPx;   // opaque width px → widM metres (length follows)
  // The source bitmap is ~1776 px long but draws at ~40-140 px → a huge single-step downscale
  // that aliases into grain. Draw a MIP pre-scaled to ~2× the on-screen size instead (crisp).
  const m = ctx.getTransform();
  const ctxScale = Math.hypot(m.a, m.b) || 1;                // world-px → device-px (viewScale·dpr)
  const onScreenLenDev = op.lenPx * scale * ctxScale;        // the sprite's length in device px
  const mip = steerexScaled(skin, onScreenLenDev * 2)
    ?? { cv, widPx: op.widPx, cxPx: op.cxPx, cyPx: op.cyPx };
  const mipScale = (widM * PX()) / mip.widPx;                // same on-screen size, gentler draw
  const prevSmooth = ctx.imageSmoothingEnabled, prevQ = ctx.imageSmoothingQuality;
  ctx.save();
  ctx.translate(s.x * PX(), s.y * PX());
  ctx.rotate(s.heading + Math.PI / 2);
  ctx.scale(mipScale, mipScale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mip.cv, -mip.cxPx, -mip.cyPx);
  ctx.restore();
  ctx.imageSmoothingEnabled = prevSmooth; ctx.imageSmoothingQuality = prevQ;
}

function drawCar(car: Car) {
  const s = car.state;
  // Stee-Rex is a pre-rendered SVG sprite (VISUAL ONLY) — blit it instead of the
  // Blitz RS vector body. Everything else (physics, collision, HUD) is unchanged.
  if (car.spec.sprite?.car === 'steerex') { drawSteerex(car, car.spec.sprite.skin); return; }
  const base = car.liveryColor ?? car.color;   // rally livery overrides the slot colour
  const crown   = shadeHex(base, 1.28);   // lit spine
  const edge    = shadeHex(base, 0.52);   // dark flanks / AO
  const outline = shadeHex(base, 0.34);   // crisp body outline
  const roofCol = shadeHex(base, 1.12);   // roof panel
  const LOWER = '#24272e', CHROME = '#cdd2d9', TYRE = '#15161b';

  ctx.save();
  ctx.translate(s.x * PX(), s.y * PX());
  ctx.rotate(s.heading);
  ctx.scale(PX(), PX());

  // ONE uniform car-art scale (Stage-D fix) BOUND to the wheelbase, so the whole
  // car stays on the one ruler and can't drift. The art (blitzBody outline, every
  // interior detail, the tyre size) is authored at its NATIVE 1/3 footprint
  // (L = 0.75 m); ART maps that native art to the real CONFIG.wheelbase in ONE
  // transform — outline, shape, details and tyres all scale together (not 80
  // individual numbers). ART = real footprint (wheelbase × 0.865) ÷ native L (0.75);
  // no forbidden literal (0.865 is the existing art length-ratio).
  const ART = CONFIG.wheelbase * 0.865 / 0.75;   // ≈ 2.96
  ctx.scale(ART, ART);

  const L = 0.75, W = 0.309;   // native footprint half-extents (the shipped art)
  // Tyre positions = the REAL wheel corners (matching rearWheelPositions / the
  // skids / the physics), pulled back into native-art space (÷ ART) so under the
  // ART scale they land EXACTLY on the real corners. (Wheelbase cancels → a native
  // constant, but the form documents the intent + stays bound to the ruler.)
  const hw = CONFIG.wheelbase / 2 / ART, ht = CONFIG.trackWidth / 2 / ART;

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
  releaseMarkLayers();          // and its tyre marks (freed outright for an unmasked map)

  // Reset the (per-map) race track and leave the editor if it was open. Lap
  // default per type: OPEN → 1 lap (RACE_CONFIG); CIRCUIT → 0 = free-roam (just
  // cruise/drift the oval until the host sets a lap count). rebuildRace then
  // regenerates the circuit's built-in start line (or leaves it empty at 0).
  if (editorMode) { editorMode = false; refreshFreeze(); }
  clearElements(raceElements);
  editorLaps = currentMap.trackType === 'circuit' ? 0 : RACE_CONFIG.laps;
  // Every map starts in LAPS mode; the host opts into XP mode via the editor.
  circuitMode = 'laps';
  raceWarmup = false;   // a fresh map is free-roam until a RACE launch arms the warm-up
  updateReadyButton();
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
    invalidateSkidTrails(car);
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
// DEV hook for the future DRAWING MODE: flip the tyre-mark system between the default
// 'race' (saturation) and 'paint' (the legacy unbounded per-car skids). Clears both
// layers on the flip so the two systems' marks never mix, and re-arms the saturation
// layer when returning to 'race'. No UI yet — reachable only from the console.
(window as unknown as { steerSetMarkMode: (m: MarkMode) => MarkMode }).steerSetMarkMode =
  (m: MarkMode) => {
    markMode = m === 'paint' ? 'paint' : 'race';
    skidCtx.clearRect(0, 0, logicalPxW, logicalPxH);
    tyreMarks.clear();
    if (markMode === 'race') ensureMarkLayers();
    return markMode;
  };
// DEV hook: report live offscreen-canvas memory so a long session can be checked for a leak.
// `steerMemStats()` → surface-texture cache footprint + the fixed layer bytes. Should stay FLAT
// across map switches / resizes / races (the caches are now evicted + capped).
(window as unknown as { steerMemStats: () => object }).steerMemStats = () => {
  const s = surfaceCacheStats();
  const layerPx = logicalPxW * logicalPxH * (layerDpr * layerDpr);
  const layerBytes = layerPx * 4 * 3;   // skid + wallpaper + overlay
  const markBytes = marksLive ? layerPx * 4 * 2 : 0;   // two mark layers
  return {
    surfaceCache: { grass: s.grass, gravel: s.gravel, asphalt: s.asphalt, MB: +(s.bytes / 1e6).toFixed(2) },
    layersMB: +((layerBytes + markBytes) / 1e6).toFixed(2),
    totalMB: +((s.bytes + layerBytes + markBytes) / 1e6).toFixed(2),
  };
};
// DIAGNOSTICS: `steerDiag()` in the console, or load the page with ?diag=1, prints ONE
// copy-pasteable block (screen/aspect/DPI, GPU, real canvas limits, every canvas
// allocation requested-vs-actual, each bake step ok/threw, caught errors, memory). Built for
// "works on my machine" reports — the numbers that differ between machines.
(window as unknown as { steerDiag: () => string }).steerDiag = () => {
  let mem: Record<string, unknown> = {};
  try { mem = (window as unknown as { steerMemStats: () => Record<string, unknown> }).steerMemStats(); }
  catch (e) { noteError('memstats', e); }
  let fit: Record<string, unknown> = {};
  try { fit = circuitFitDebug() as unknown as Record<string, unknown>; }
  catch (e) { noteError('circuit-fit', e); }
  const report = collectDiag({
    'circuit fit (screen-aspect dependent)': fit,
    'render layers': {
      map: currentMap.id,
      logicalPx: `${logicalPxW} x ${logicalPxH}`,
      layerDpr,
      backingDprCap: MAX_BACKING_DPR,
      viewScale: +viewScale.toFixed(4),
      marksLive,
    },
    memory: mem,
  });
  console.log(report);
  return report;
};
try {
  if (new URLSearchParams(location.search).get('diag') === '1') {
    // Give the map a moment to build so the block includes the real bake results.
    setTimeout(() => {
      const r = (window as unknown as { steerDiag: () => string }).steerDiag();
      const box = document.createElement('textarea');
      box.value = r;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;inset:5% 5% auto 5%;height:82vh;z-index:99999;'
        + 'font:11px/1.4 ui-monospace,monospace;background:#0b0616;color:#d8ffd8;'
        + 'border:1px solid #ff2d95;border-radius:10px;padding:12px;white-space:pre;';
      box.addEventListener('click', () => box.select());
      document.body.appendChild(box);
      box.select();
    }, 2500);
  }
} catch (e) { noteError('diag-autorun', e); }

// Warm both Stee-Rex skins so the arcade car shows its sprite immediately (never blank).
preloadSteerex();
