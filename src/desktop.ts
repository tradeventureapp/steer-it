import QRCode from 'qrcode';
import { supabase, channelName } from './supabase';
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
  PLAYER_CAP, LOBBY_SYNC_MS, EV, colorName, LobbyState,
} from './lobby';
import {
  RaceState, RACE_CONFIG, formatRaceTime,
  placeElement, removeElementAt, clearElements, findElementIndexAt,
  countCheckpoints, isCircuitTrack,
  type RaceElement, type RaceHud, type RaceType,
} from './race';

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
const raceFinishTimeEl = document.getElementById('race-finish-time') as HTMLDivElement | null;
const speedEl = document.getElementById('speed') as HTMLDivElement;
const driftEl = document.getElementById('drift') as HTMLDivElement;
const throttleBarEl  = document.getElementById('throttle-bar')  as HTMLDivElement;
const brakeBarEl     = document.getElementById('brake-bar')     as HTMLDivElement;
const handbrakeHudEl = document.getElementById('handbrake-hud') as HTMLDivElement;
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
let isPaused = false;    // = userPaused || editorMode || menuOpen (loop gate)
let pausedAccumMs = 0;   // total frozen time, subtracted from the game clock
let pauseStartedAt = 0;  // performance.now() when the current freeze began

function refreshFreeze() {
  const want = userPaused || editorMode || menuOpen;
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
    if (hudBlEl) hudBlEl.style.display = debugOn ? 'flex' : 'none';
  }
  if (e.key === 'q' || e.key === 'Q') {
    qrOn = !qrOn;
    updateQrVisibility();
  }
  if (e.key === 'p' || e.key === 'P') {
    if (!editorMode) { userPaused = !userPaused; refreshFreeze(); }  // P is a no-op in the editor
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
  switchMap(id);          // load the map + respawn any connected cars
  closeMenusIntoGame();
}

// Build the map-select tiles from the registry (so new maps appear here
// automatically). Each tile renders a REAL mini-preview of the map.
function buildMapTiles() {
  if (!mapTilesEl) return;
  mapTilesEl.innerHTML = '';
  const dpr = window.devicePixelRatio || 1;
  const RW = 440, RH = 240, DW = 220, DH = 120;   // render 2×, display 1× (crisp)
  for (const { id, name } of listMaps()) {
    const def = getMap(id);
    if (!def) continue;
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'map-tile';

    const thumb = document.createElement('span');
    thumb.className = 'map-thumb';
    const cvs = document.createElement('canvas');
    cvs.width = Math.floor(RW * dpr); cvs.height = Math.floor(RH * dpr);
    cvs.style.width = DW + 'px'; cvs.style.height = DH + 'px';
    const c = cvs.getContext('2d');
    if (c) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      try {
        const w = def.createWorld(RW / CONFIG.pxPerMeter, RH / CONFIG.pxPerMeter);
        def.drawBackground(c, RW, RH);
        def.drawObstacles(c, w, CONFIG.pxPerMeter, null);
      } catch { /* a preview must never break the menu */ }
    }
    thumb.appendChild(cvs);

    const label = document.createElement('span');
    label.className = 'map-name';
    label.textContent = name;

    tile.appendChild(thumb);
    tile.appendChild(label);
    tile.addEventListener('click', () => chooseMap(id));
    mapTilesEl.appendChild(tile);
  }
}

document.getElementById('btn-start-race')?.addEventListener('click', openMapSelect);
document.getElementById('btn-map-back')?.addEventListener('click', openMainMenu);
openMainMenu();   // show the host menu at startup

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

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;

  for (const [cv, cx] of [
    [canvas, ctx], [skidCanvas, skidCtx],
    [wallpaperCanvas, wallpaperCtx], [overlayCanvas, overlayCtx],
  ] as Array<[HTMLCanvasElement, CanvasRenderingContext2D]>) {
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  // Re-lay-out the active map for the new window and re-render the static
  // layers. (Naive: previous skids are cleared on resize, and dragged
  // obstacles return to the default layout.)
  draggedObstacle = null;
  world = currentMap.createWorld(w / CONFIG.pxPerMeter, h / CONFIG.pxPerMeter);
  currentMap.drawBackground(wallpaperCtx, w, h);
  redrawOverlay();
}

// ---------- Obstacle dragging (mouse builds the track; phone drives) --------
// Only active for maps whose obstacles are draggable (the desktop). Handlers
// route through the active map's drag API, which mutates obstacle data +
// collision rects — the game loop and the phone input path are untouched.
let draggedObstacle: MapObstacle | null = null;

function redrawOverlay() {
  overlayCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  currentMap.drawObstacles(overlayCtx, world, CONFIG.pxPerMeter, draggedObstacle);
}

canvas.addEventListener('pointerdown', (e) => {
  if (editorMode) { editorPointerDown(e); return; }  // editor owns the mouse
  if (!currentMap.draggableObstacles) return;
  const mx = e.clientX / PX(), my = e.clientY / PX();
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
  const mx = e.clientX / PX(), my = e.clientY / PX();
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
}

// Keyed by slot so routing/lookup is O(1) and nothing is hardcoded to 2 cars.
const cars = new Map<number, Car>();
const DEFAULT_CAR_COLOR = '#1d3fa0';

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
  for (const slot of [...cars.keys()]) if (!live.has(slot)) cars.delete(slot);
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
// The desktop starts EMPTY — free-drift sandbox. The track editor (key E)
// mutates this RaceElement[] (world metres) in place; RaceState is rebuilt from
// it whenever the structure changes. No START/FINISH ⇒ no active race.
const raceElements: RaceElement[] = [];
// Lap count is an editor setting (1..10, default from RACE_CONFIG). The built
// track uses it; the race HUD shows LAP n/m off it.
let editorLaps = RACE_CONFIG.laps;
let raceState = new RaceState(raceElements, { ...RACE_CONFIG, laps: editorLaps });
function rebuildRace() {
  raceState = new RaceState(raceElements, { ...RACE_CONFIG, laps: editorLaps });
}

// ---------- Track editor (key E) — place/drag/delete into raceElements ----------
type EditorTool = RaceType | 'delete';
let editorTool: EditorTool = 'start';
let editorDragIdx: number | null = null;
let editorDragOff = { x: 0, y: 0 };
const EDITOR_GRAB_R = 1.8;  // metres — generous hit radius for drag/delete
const EDITOR_DEFAULT_HINT = 'click to place · drag to move · E to exit';

function editorPointerDown(e: PointerEvent) {
  e.preventDefault();
  const mx = e.clientX / PX(), my = e.clientY / PX();
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
  const mx = e.clientX / PX(), my = e.clientY / PX();
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
  if (editorStatusEl) {
    const hasStart = raceElements.some((el) => el.type === 'start');
    const hasFinish = raceElements.some((el) => el.type === 'finish');
    const circuit = isCircuitTrack(raceElements);
    const cp = countCheckpoints(raceElements);
    // Mode: SPRINT (a finish exists), CIRCUIT (only a start), or — (no start yet).
    const mode = hasFinish ? 'SPRINT' : hasStart ? 'CIRCUIT' : '—';
    const sep = `<span class="sep">·</span>`;
    let html = `<span class="mode">${mode}</span>` + sep +
      `<span class="${hasStart ? 'ok' : 'no'}">START ${hasStart ? '✓' : '·'}</span>`;
    // Sprint shows FINISH; circuit's start IS the finish, so it's implied.
    if (!circuit) {
      html += sep +
        `<span class="${hasFinish ? 'ok' : 'no'}">FINISH ${hasFinish ? '✓' : '·'}</span>`;
    }
    html += sep + `<span class="cp">CP ${cp}/${RACE_CONFIG.maxCheckpoints}</span>` +
      sep + `<span class="laps">LAPS ${editorLaps}</span>`;
    editorStatusEl.innerHTML = html;
  }
  for (const b of Array.from(document.querySelectorAll('#editor-palette .etool')) as HTMLElement[]) {
    b.classList.toggle('sel', b.dataset.tool === editorTool);
  }
  if (lapsValEl) lapsValEl.textContent = String(editorLaps);
}

// Palette buttons (exist in index.html). Selecting a tool never touches the map.
for (const b of Array.from(document.querySelectorAll('#editor-palette .etool')) as HTMLElement[]) {
  b.addEventListener('click', () => { editorTool = b.dataset.tool as EditorTool; updateEditorStatus(); });
}
document.getElementById('editor-clear')?.addEventListener('click', () => {
  clearElements(raceElements);
  updateEditorStatus();
});

// Lap-count stepper (1..10). Changing laps only updates the editor setting; the
// race rebuilds with it when the editor is exited (E).
const lapsValEl = document.getElementById('laps-val') as HTMLSpanElement | null;
function setEditorLaps(n: number) {
  editorLaps = Math.max(1, Math.min(10, n));
  updateEditorStatus();
}
document.getElementById('laps-dec')?.addEventListener('click', () => setEditorLaps(editorLaps - 1));
document.getElementById('laps-inc')?.addEventListener('click', () => setEditorLaps(editorLaps + 1));

// ---------- Supabase channel ----------
const channel = supabase.channel(channelName(code), {
  config: { broadcast: { self: false } },
});

// ================= LOBBY — the desktop is the authority =================
// The desktop owns the ONLY LobbyState; phones never self-assign slots (no
// races — Supabase delivers to this single JS thread, processed in order).
// Built for N: the cap lives in lobby.ts (PLAYER_CAP).
const lobby = new LobbyState(PLAYER_CAP);

function broadcastLobby() {
  channel.send({
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

// ---- phone → desktop handlers ----
channel.on('broadcast', { event: EV.join }, ({ payload }) => {
  const p = payload as { id?: unknown; color?: string; name?: string };
  const id = String(p?.id ?? '');
  if (!id) return;
  const r = lobby.join(id, p?.color, Date.now(), p?.name);
  if (r.slot === null) {
    channel.send({ type: 'broadcast', event: EV.full, payload: { id } }); // lobby full
  } else if (r.changed) {
    broadcastLobby();
  }
});

channel.on('broadcast', { event: EV.color }, ({ payload }) => {
  const id = String((payload as { id?: unknown })?.id ?? '');
  const color = (payload as { color?: string })?.color;
  if (!id || !color) return;
  if (lobby.setColor(id, color, Date.now()).changed) broadcastLobby();
});

channel.on('broadcast', { event: EV.name }, ({ payload }) => {
  const id = String((payload as { id?: unknown })?.id ?? '');
  const name = (payload as { name?: string })?.name;
  if (!id || name === undefined) return;
  if (lobby.setName(id, name, Date.now()).changed) broadcastLobby();
});

channel.on('broadcast', { event: EV.leave }, ({ payload }) => {
  const id = String((payload as { id?: unknown })?.id ?? '');
  if (id && lobby.leave(id).changed) broadcastLobby();
});

channel.on('broadcast', { event: EV.control }, ({ payload }) => {
  const id = String((payload as { id?: unknown })?.id ?? '');
  // STEP 2: every connected slot drives its OWN car. Route by the desktop's
  // authoritative id→slot map (never trust the phone's self-reported slot).
  if (!id) {                                       // legacy id-less → drive slot 0
    const c0 = cars.get(0);
    if (c0) applyInputs(c0.target, payload as Inputs);
    return;
  }
  const r = lobby.join(id, undefined, Date.now()); // lazy-join if join was missed
  if (r.changed) broadcastLobby();                 // → syncCars spawns the car
  if (r.slot === null) return;                     // lobby full
  const car = cars.get(r.slot);
  if (car) applyInputs(car.target, payload as Inputs);
});

// ---- disconnect sweep + periodic lobby re-sync ----
setInterval(() => { if (lobby.sweep(Date.now()).changed) broadcastLobby(); }, 1000);
setInterval(() => { if (lobby.size()) broadcastLobby(); }, LOBBY_SYNC_MS);

channel.subscribe();
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
      }

      // Cars bounce off EACH OTHER (arcade, clamped) after all have integrated.
      if (cars.size > 1) {
        const carImpact = collideCars([...cars.values()].map((c) => c.state));
        if (carImpact > 0.8 && lead) fx.impact(lead.state.x, lead.state.y, carImpact);
      }

      // Per-car trails + edge wrap; race detection on the primary car only.
      for (const car of cars.values()) { recordSkids(car); wrap(car); }
      if (lead) raceState.update(lead.state.x, lead.state.y, gameNow);

      accumulator -= FIXED_DT;
      steps++;
    }
    // Drop accumulated time if we fell way behind (prevents spiral of death).
    if (steps === MAX_SUBSTEPS) accumulator = 0;

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
  updateRaceHud(raceState.hud(gameNow));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Render ----------
function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  // Screen shake wraps every world layer (HUD is HTML, unaffected).
  const shake = fx.shakeOffset();
  ctx.save();
  ctx.translate(shake.x, shake.y);

  // Layered: background → skids → obstacles → dynamic foreground → cars → fx.
  ctx.drawImage(wallpaperCanvas, 0, 0, W, H);
  ctx.drawImage(skidCanvas, 0, 0, W, H);
  ctx.drawImage(overlayCanvas, 0, 0, W, H);
  currentMap.drawForeground?.(ctx, world, CONFIG.pxPerMeter);

  drawRaceElements();
  for (const car of cars.values()) drawCar(car);  // paint every connected car
  fx.draw(ctx, CONFIG.pxPerMeter);

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

  if (debugOn && s && cur) {
    // Mirror the physics gates so the screen shows WHY a burnout/spin did or
    // didn't fire from the real commanded values.
    const boostGate = Math.max(0, Math.min(1,
      (cur.throttle - CONFIG.burnoutThrottle) / (1 - CONFIG.burnoutThrottle)));
    const armT = cur.handbrake
      ? CONFIG.spinReleaseThresholdHB : CONFIG.spinReleaseThreshold;
    debugEl.textContent =
      `slot ${lead!.slot}   steer ${cur.steer.toFixed(2)}   (spin-arm ≥ ${armT.toFixed(2)}${cur.handbrake ? ' HB' : ''})\n` +
      `throttle ${cur.throttle.toFixed(2)}  brake ${cur.brake.toFixed(2)}  hb ${cur.handbrake ? 'ON' : 'off'}\n` +
      `burnout boost ${(boostGate * 100).toFixed(0)}%   (ignites ≥ ${CONFIG.burnoutThrottle.toFixed(2)})\n` +
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
  const px = PX();
  const collected = raceState.collectedElementIndices();
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
  if (editorMode) {  // editor shows its own status; race HUD hidden
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
  if (raceFinishEl) {
    raceFinishEl.hidden = !h.finished;
    if (h.finished && raceFinishTimeEl) raceFinishTimeEl.textContent = formatRaceTime(h.finishMs);
  }
}

// ---------- Drawing: top-down rally car ----------
// Evokes a 2000s WRC hatchback — deep blue body, gold wheels, white
// stripes, roof roundel and a rear wing — with zero trademarked marks.
// The footprint matches the old placeholder (1.5 m × 0.617 m, the 1/3 of
// the original 4.5/1.85 sprite) so physics dimensions are untouched.
// Bold shapes over fine detail: it must read as a rally car at ~35 px.

function drawCar(car: Car) {
  // Draw centered at the car's world position, rotated by heading.
  // Inner coordinates are METERS (ctx scaled by pxPerMeter); +x = front.
  // ALL shading derives from the slot's base colour (shadeHex lightens >1 /
  // darkens <1, clamped) so every player's car reads as a polished 3D body.
  const s = car.state;
  const base = car.color;
  const edge    = shadeHex(base, 0.58);   // dark flanks / ambient occlusion
  const outline = shadeHex(base, 0.42);   // crisp body outline
  const crown   = shadeHex(base, 1.22);   // top-down highlight along the spine
  const roofCol = shadeHex(base, 1.34);   // roof panel (brightest)
  const roofLip = shadeHex(base, 0.80);   // AO lip around the roof
  const hood    = shadeHex(base, 0.90);   // hood panel (slightly recessed)
  const wingCol = shadeHex(base, 0.72);   // wing endplates
  const archCol = shadeHex(base, 0.40);   // wheel-arch recesses

  ctx.save();
  ctx.translate(s.x * PX(), s.y * PX());
  ctx.rotate(s.heading);
  ctx.scale(PX(), PX());

  const halfL = 0.75;   // 1.5 m long
  const halfW = 0.309;  // 0.617 m wide

  // ---- 1. Ground drop shadow. Cast from the body silhouette; offsets are in
  // SCREEN space (shadow* ignores the transform) so the light direction stays
  // fixed as the car rotates and the body sits ON the surface, not floating. --
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.40)';
  ctx.shadowBlur = 13;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 7;
  ctx.fillStyle = '#000';
  roundRect(ctx, -halfL, -halfW, halfL * 2, halfW * 2, 0.14);
  ctx.fill();
  ctx.restore();   // clears the shadow state (body is drawn over the black fill)

  // ---- 2. Body shell — cross-width gradient: bright crown down the centre,
  // darker toward both flanks = a rounded, lit 3D form. ----
  const bodyGrad = ctx.createLinearGradient(0, -halfW, 0, halfW);
  bodyGrad.addColorStop(0.00, edge);
  bodyGrad.addColorStop(0.32, base);
  bodyGrad.addColorStop(0.50, crown);
  bodyGrad.addColorStop(0.68, base);
  bodyGrad.addColorStop(1.00, edge);
  ctx.fillStyle = bodyGrad;
  roundRect(ctx, -halfL, -halfW, halfL * 2, halfW * 2, 0.13);
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 0.025;
  ctx.stroke();

  // Soft specular sheen down the spine.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  roundRect(ctx, -halfL + 0.12, -0.085, halfL * 2 - 0.24, 0.17, 0.07);
  ctx.fill();

  // ---- 3. Bumpers (dark caps), front + rear ----
  ctx.fillStyle = '#1b1e26';
  roundRect(ctx, halfL - 0.10, -0.27, 0.10, 0.54, 0.05); ctx.fill();
  roundRect(ctx, -halfL, -0.27, 0.09, 0.54, 0.05); ctx.fill();

  // ---- 4. Hood — recessed panel + centre scoop + a hood panel line ----
  ctx.fillStyle = hood;
  roundRect(ctx, 0.30, -0.215, 0.33, 0.43, 0.05); ctx.fill();
  ctx.fillStyle = shadeHex(base, 0.5);
  roundRect(ctx, 0.40, -0.075, 0.15, 0.15, 0.03); ctx.fill();   // scoop bezel
  ctx.fillStyle = '#10131b';
  roundRect(ctx, 0.43, -0.05, 0.09, 0.10, 0.02); ctx.fill();    // scoop mouth
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)'; ctx.lineWidth = 0.012;
  ctx.beginPath(); ctx.moveTo(0.30, -0.215); ctx.lineTo(0.30, 0.215); ctx.stroke();

  // ---- 5. Headlights (warm glow) + taillights (soft red glow) ----
  ctx.save();
  ctx.shadowColor = 'rgba(255, 238, 190, 0.95)'; ctx.shadowBlur = 6;
  ctx.fillStyle = '#fff7df';
  ctx.beginPath();
  ctx.arc(0.635, -0.185, 0.05, 0, Math.PI * 2);
  ctx.arc(0.635,  0.185, 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.shadowColor = 'rgba(255, 45, 45, 0.9)'; ctx.shadowBlur = 6;
  ctx.fillStyle = '#ff3b34';
  roundRect(ctx, -0.715, -0.25, 0.055, 0.10, 0.02); ctx.fill();
  roundRect(ctx, -0.715,  0.15, 0.055, 0.10, 0.02); ctx.fill();
  ctx.restore();

  // ---- 6. Wheel arches (dark recesses) then wheels ON TOP (fronts steer) ----
  const wheelPts: Array<[number, number, number]> = [
    [+CONFIG.wheelbase / 2, -CONFIG.trackWidth / 2, s.steerAngle],
    [+CONFIG.wheelbase / 2, +CONFIG.trackWidth / 2, s.steerAngle],
    [-CONFIG.wheelbase / 2, -CONFIG.trackWidth / 2, 0],
    [-CONFIG.wheelbase / 2, +CONFIG.trackWidth / 2, 0],
  ];
  ctx.fillStyle = archCol;
  for (const [ax, ay] of wheelPts) {
    roundRect(ctx, ax - 0.15, ay - 0.072, 0.30, 0.144, 0.05);
    ctx.fill();
  }
  for (const [ax, ay, ang] of wheelPts) drawWheel(ax, ay, ang);

  // ---- 7. Greenhouse — windshield, roof panel, rear window (tinted glass
  // with a reflection sheen + AO lip around the roof) ----
  drawGlass([[0.34, -0.21], [0.34, 0.21], [0.15, 0.255], [0.15, -0.255]]);
  ctx.fillStyle = roofLip;
  roundRect(ctx, -0.30, -0.265, 0.47, 0.53, 0.08); ctx.fill();
  ctx.fillStyle = roofCol;
  roundRect(ctx, -0.275, -0.24, 0.43, 0.48, 0.07); ctx.fill();
  drawGlass([[-0.275, -0.235], [-0.275, 0.235], [-0.45, 0.195], [-0.45, -0.195]]);

  // ---- 8. Roof roundel + slot number ----
  ctx.fillStyle = '#f4f6fa';
  ctx.beginPath(); ctx.arc(-0.06, 0, 0.15, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)'; ctx.lineWidth = 0.012;
  ctx.beginPath(); ctx.arc(-0.06, 0, 0.15, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#1a1d24';
  ctx.font = 'bold 0.23px Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(car.slot + 1), -0.06, 0.012);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

  // ---- 9. Side mirrors at the windshield base ----
  ctx.fillStyle = edge;
  roundRect(ctx, 0.235, -halfW - 0.05, 0.085, 0.055, 0.02); ctx.fill();
  roundRect(ctx, 0.235,  halfW - 0.005, 0.085, 0.055, 0.02); ctx.fill();

  // ---- 10. Rear wing — endplates + a lit plank, with its own drop shadow on
  // the body beneath it (so it reads as raised). ----
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'; ctx.shadowBlur = 5;
  ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 4;
  ctx.fillStyle = wingCol;
  roundRect(ctx, -0.82, -0.40, 0.17, 0.06, 0.02); ctx.fill();   // endplates
  roundRect(ctx, -0.82,  0.34, 0.17, 0.06, 0.02); ctx.fill();
  const wg = ctx.createLinearGradient(0, -0.37, 0, 0.37);
  wg.addColorStop(0, '#ccd3e2'); wg.addColorStop(0.5, '#eef1f7'); wg.addColorStop(1, '#ccd3e2');
  ctx.fillStyle = wg;
  roundRect(ctx, -0.80, -0.37, 0.13, 0.74, 0.03); ctx.fill();    // plank
  ctx.restore();
  ctx.strokeStyle = '#9aa6bd'; ctx.lineWidth = 0.018;
  roundRect(ctx, -0.80, -0.37, 0.13, 0.74, 0.03); ctx.stroke();

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

function drawWheel(bx: number, by: number, angle: number) {
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(angle);
  // Tyre — near-black with a faint sidewall sheen for roundness.
  ctx.fillStyle = '#0e0f12';
  roundRect(ctx, -0.125, -0.052, 0.25, 0.104, 0.03); ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  roundRect(ctx, -0.125, -0.052, 0.25, 0.032, 0.02); ctx.fill();
  // Gold rim — a vertical gradient gives it a machined, 3D sheen.
  const rg = ctx.createLinearGradient(0, -0.03, 0, 0.03);
  rg.addColorStop(0, '#f2d273');
  rg.addColorStop(0.5, '#d9b13b');
  rg.addColorStop(1, '#a8841f');
  ctx.fillStyle = rg;
  roundRect(ctx, -0.07, -0.03, 0.14, 0.06, 0.018); ctx.fill();
  // Hub cap.
  ctx.fillStyle = '#7a5e16';
  ctx.beginPath(); ctx.arc(0, 0, 0.017, 0, Math.PI * 2); ctx.fill();
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

  const w = window.innerWidth, h = window.innerHeight;
  world = currentMap.createWorld(w / CONFIG.pxPerMeter, h / CONFIG.pxPerMeter);
  draggedObstacle = null;
  currentMap.drawBackground(wallpaperCtx, w, h);
  redrawOverlay();
  skidCtx.clearRect(0, 0, w, h);                 // drop the previous map's skids

  // Reset the (per-map) race track and leave the editor if it was open.
  if (editorMode) { editorMode = false; refreshFreeze(); }
  clearElements(raceElements);
  editorLaps = RACE_CONFIG.laps;
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
