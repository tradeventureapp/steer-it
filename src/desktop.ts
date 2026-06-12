import QRCode from 'qrcode';
import { supabase, channelName } from './supabase';
import {
  CONFIG, makeCar, step, bodyToWorld, collideWithRects,
  type CarState, type Inputs,
} from './physics';
import { spawnPose, collideCars, applyInputs } from './cars';
import {
  layoutDesktop, drawWallpaper, drawOverlay, drawClock,
  rebuildRects, iconAt, clampIconToBounds, resolveIconDrop,
  type DesktopWorld, type DesktopIcon,
} from './world';
import { SoundEngine } from './sound';
import { Effects } from './effects';
import {
  PLAYER_CAP, LOBBY_SYNC_MS, EV, colorName, LobbyState,
} from './lobby';
import {
  RaceState, RACE_CONFIG, formatRaceTime,
  placeElement, removeElementAt, clearElements, findElementIndexAt,
  countCheckpoints,
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

// ---------- Freeze: pause (P) OR editor (E) both halt the simulation + race
// timer (not the render). isPaused is the combined gate read by the loop. ----
let userPaused = false;  // toggled by P
let editorMode = false;  // toggled by E
let isPaused = false;    // = userPaused || editorMode (the frame-loop gate)
let pausedAccumMs = 0;   // total frozen time, subtracted from the game clock
let pauseStartedAt = 0;  // performance.now() when the current freeze began

function refreshFreeze() {
  const want = userPaused || editorMode;
  if (want !== isPaused) {
    isPaused = want;
    if (isPaused) pauseStartedAt = performance.now();
    else pausedAccumMs += performance.now() - pauseStartedAt;  // bank frozen time
  }
  // PAUSED overlay only for a manual pause (not while editing); editor UI only
  // while editing.
  if (pauseOverlayEl) pauseOverlayEl.hidden = !(userPaused && !editorMode);
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
window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') sound.toggleMute();
  if (e.key === 'd' || e.key === 'D') {
    debugOn = !debugOn;
    debugEl.style.display = debugOn ? 'block' : 'none';
    if (hudBlEl) hudBlEl.style.display = debugOn ? 'flex' : 'none';
  }
  if (e.key === 'q' || e.key === 'Q') {
    qrOn = !qrOn;
    if (hudTrEl) hudTrEl.style.display = qrOn ? 'block' : 'none';
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

// ---------- The desktop world (icons, taskbar, collision rects) ----------
let world: DesktopWorld = layoutDesktop(
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

  // Re-lay-out the desktop for the new window and re-render the static
  // layers. (Naive: previous skids are cleared on resize, and dragged
  // icons return to the default layout.)
  draggedIcon = null;
  world = layoutDesktop(w / CONFIG.pxPerMeter, h / CONFIG.pxPerMeter);
  drawWallpaper(wallpaperCtx, w, h);
  redrawOverlay();
}

// ---------- Icon dragging (mouse builds the track; phone drives) ----------
// Handlers only mutate icon data + collision rects — the game loop and
// the phone input path are untouched. Rects rebuild live during the drag
// so the car reacts to the icon's current position at all times.
let draggedIcon: DesktopIcon | null = null;
let dragOffX = 0, dragOffY = 0;

function redrawOverlay() {
  overlayCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawOverlay(overlayCtx, world, CONFIG.pxPerMeter, draggedIcon);
}

canvas.addEventListener('pointerdown', (e) => {
  if (editorMode) { editorPointerDown(e); return; }  // editor owns the mouse
  const mx = e.clientX / PX(), my = e.clientY / PX();
  const ic = iconAt(world, mx, my);
  if (!ic) return;
  e.preventDefault();
  draggedIcon = ic;
  dragOffX = mx - ic.x;
  dragOffY = my - ic.y;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  canvas.style.cursor = 'grabbing';
  redrawOverlay();
});

canvas.addEventListener('pointermove', (e) => {
  if (editorMode) { editorPointerMove(e); return; }
  const mx = e.clientX / PX(), my = e.clientY / PX();
  if (draggedIcon) {
    draggedIcon.x = mx - dragOffX;
    draggedIcon.y = my - dragOffY;
    clampIconToBounds(world, draggedIcon);
    rebuildRects(world);
    redrawOverlay();
  } else {
    canvas.style.cursor = iconAt(world, mx, my) ? 'grab' : 'default';
  }
});

function endIconDrag() {
  if (!draggedIcon) return;
  resolveIconDrop(world, draggedIcon);
  rebuildRects(world);
  draggedIcon = null;
  canvas.style.cursor = 'grab';
  redrawOverlay();
}
canvas.addEventListener('pointerup', (e) => {
  if (editorMode) { editorPointerUp(); return; }
  endIconDrag();
  void e;
});
canvas.addEventListener('pointercancel', (e) => {
  if (editorMode) { editorPointerUp(); return; }
  endIconDrag();
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
  const cx = window.innerWidth / 2 / PX();
  const cy = window.innerHeight / 2 / PX();
  const pose = spawnPose(slot, cx, cy);
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
let raceState = new RaceState(raceElements, RACE_CONFIG);
function rebuildRace() { raceState = new RaceState(raceElements, RACE_CONFIG); }

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
    const cp = countCheckpoints(raceElements);
    editorStatusEl.innerHTML =
      `<span class="${hasStart ? 'ok' : 'no'}">START ${hasStart ? '✓' : '·'}</span>` +
      `<span class="${hasFinish ? 'ok' : 'no'}">FINISH ${hasFinish ? '✓' : '·'}</span>` +
      `<span class="cp">CP ${cp}/${RACE_CONFIG.maxCheckpoints}</span>`;
  }
  for (const b of Array.from(document.querySelectorAll('#editor-palette .etool')) as HTMLElement[]) {
    b.classList.toggle('sel', b.dataset.tool === editorTool);
  }
}

// Palette buttons (exist in index.html). Selecting a tool never touches the map.
for (const b of Array.from(document.querySelectorAll('#editor-palette .etool')) as HTMLElement[]) {
  b.addEventListener('click', () => { editorTool = b.dataset.tool as EditorTool; updateEditorStatus(); });
}
document.getElementById('editor-clear')?.addEventListener('click', () => {
  clearElements(raceElements);
  updateEditorStatus();
});

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

// ---------- World wrap (per car) ----------
// Wrap on left/right/top only — the bottom edge is the taskbar, a solid
// wall the car collides with (see world.rects).
function wrap(car: Car) {
  const s = car.state;
  const W = window.innerWidth / PX();
  const M = 2; // margin in meters
  if (s.x < -M)       { s.x = W + M; invalidateSkidTrails(car); }
  else if (s.x > W + M) { s.x = -M;    invalidateSkidTrails(car); }
  if (s.y < -M) {
    // Re-enter from the bottom, emerging from just above the taskbar wall.
    s.y = window.innerHeight / PX() - world.taskbarHeight -
      CONFIG.carCollisionRadius - 0.2;
    invalidateSkidTrails(car);
  }
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
  const { L, R } = rearWheelPositions(s);
  fx.emitSmoke(L.x + bx, L.y + by, s.vx, s.vy, smokeIntensity, realDt, sizeScale);
  fx.emitSmoke(R.x + bx, R.y + by, s.vx, s.vy, smokeIntensity, realDt, sizeScale);
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

  // Layered desktop: wallpaper → skids → icons/taskbar → clock → car → fx.
  ctx.drawImage(wallpaperCanvas, 0, 0, W, H);
  ctx.drawImage(skidCanvas, 0, 0, W, H);
  ctx.drawImage(overlayCanvas, 0, 0, W, H);
  drawClock(ctx, world, CONFIG.pxPerMeter);

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

function drawRaceElements() {
  const px = PX();
  const collected = raceState.collectedElementIndices();
  raceElements.forEach((e, i) => {
    const sx = e.x * px, sy = e.y * px;
    const rPx = (e.radius ?? RACE_CONFIG.gateRadius) * px;
    if (e.type === 'checkpoint') {
      drawCheckpoint(sx, sy, rPx, e.index ?? 0, !editorMode && collected.has(i));
    } else {
      drawGate(sx, sy, rPx, e.angle ?? 0, e.type === 'start');
    }
  });
}

function drawGate(sx: number, sy: number, rPx: number, angle: number, isStart: boolean) {
  const color = isStart ? RACE_GREEN : RACE_MAGENTA;
  const half = rPx;            // bar half-width ≈ the trigger zone
  ctx.save();
  // faint trigger-zone wash
  ctx.fillStyle = isStart ? 'rgba(57,255,106,0.06)' : 'rgba(255,45,149,0.06)';
  ctx.beginPath(); ctx.arc(sx, sy, rPx, 0, Math.PI * 2); ctx.fill();

  ctx.translate(sx, sy);
  ctx.rotate(angle);
  ctx.lineCap = 'round';
  if (isStart) {
    ctx.shadowColor = color; ctx.shadowBlur = 16;
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-half, 0); ctx.lineTo(half, 0); ctx.stroke();
  } else {
    // FINISH — checkered bar.
    ctx.shadowColor = color; ctx.shadowBlur = 12;
    const n = 8, sw = (half * 2) / n;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 === 0 ? RACE_MAGENTA : '#ffffff';
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
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 10;
  ctx.fillStyle = color;
  ctx.font = '700 13px Orbitron, ui-monospace, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(isStart ? 'START' : 'FINISH', sx, sy - rPx - 9);
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
  const s = car.state;
  const sx = s.x * PX();
  const sy = s.y * PX();

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(s.heading);
  ctx.scale(PX(), PX());

  const halfL = 0.75;   // 1.5 m long
  const halfW = 0.309;  // 0.617 m wide

  // Body — this slot's chosen colour, with a darker outline.
  const bodyOutline = shadeHex(car.color, 0.55);
  ctx.fillStyle = car.color;
  roundRect(ctx, -halfL, -halfW, halfL * 2, halfW * 2, 0.12);
  ctx.fill();
  ctx.strokeStyle = bodyOutline;
  ctx.lineWidth = 0.03;
  ctx.stroke();

  // Bumpers — dark caps front and rear.
  ctx.fillStyle = '#1a1d24';
  roundRect(ctx, halfL - 0.09, -0.28, 0.09, 0.56, 0.04); ctx.fill();
  roundRect(ctx, -halfL, -0.28, 0.08, 0.56, 0.04); ctx.fill();

  // Livery — twin white stripes down the hood and tail (the cabin glass
  // overdraws them mid-car, which reads as stripes passing the roofline).
  ctx.fillStyle = 'rgba(244, 246, 250, 0.95)';
  ctx.fillRect(-0.62, -0.10, 1.24, 0.055);
  ctx.fillRect(-0.62,  0.045, 1.24, 0.055);

  // Headlights (pale) + taillights (red).
  ctx.fillStyle = '#f3f0d8';
  ctx.beginPath();
  ctx.arc(0.69, -0.19, 0.047, 0, Math.PI * 2);
  ctx.arc(0.69,  0.19, 0.047, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d23b2f';
  ctx.fillRect(-0.72, -0.24, 0.05, 0.09);
  ctx.fillRect(-0.72,  0.15, 0.05, 0.09);

  // Wheels — gold rims on dark tires; fronts steer with steerAngle.
  // Positions come from CONFIG (same source as the skid emitter).
  drawWheel(+CONFIG.wheelbase / 2, -CONFIG.trackWidth / 2, s.steerAngle);
  drawWheel(+CONFIG.wheelbase / 2, +CONFIG.trackWidth / 2, s.steerAngle);
  drawWheel(-CONFIG.wheelbase / 2, -CONFIG.trackWidth / 2, 0);
  drawWheel(-CONFIG.wheelbase / 2, +CONFIG.trackWidth / 2, 0);

  // Windshield — dark glass, wider at the roofline.
  ctx.fillStyle = '#141c2e';
  ctx.beginPath();
  ctx.moveTo(0.36, -0.21);
  ctx.lineTo(0.36,  0.21);
  ctx.lineTo(0.16,  0.26);
  ctx.lineTo(0.16, -0.26);
  ctx.closePath();
  ctx.fill();

  // Roof panel — a brighter tint of the body colour.
  ctx.fillStyle = shadeHex(car.color, 1.3);
  roundRect(ctx, -0.28, -0.26, 0.44, 0.52, 0.07);
  ctx.fill();

  // Rear window.
  ctx.fillStyle = '#141c2e';
  ctx.beginPath();
  ctx.moveTo(-0.28, -0.25);
  ctx.lineTo(-0.28,  0.25);
  ctx.lineTo(-0.44,  0.21);
  ctx.lineTo(-0.44, -0.21);
  ctx.closePath();
  ctx.fill();

  // Roof scoop hint at the windshield edge.
  ctx.fillStyle = '#0f1524';
  roundRect(ctx, 0.06, -0.07, 0.10, 0.14, 0.02);
  ctx.fill();

  // Racing roundel + number on the roof.
  ctx.fillStyle = '#f4f6fa';
  ctx.beginPath();
  ctx.arc(-0.07, 0, 0.155, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1d24';
  ctx.font = 'bold 0.24px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Roof number = the player's slot (1-based) so cars are tellable apart.
  ctx.fillText(String(car.slot + 1), -0.07, 0.015);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Side mirrors at the windshield base.
  ctx.fillStyle = bodyOutline;
  ctx.fillRect(0.27, -halfW - 0.045, 0.08, 0.05);
  ctx.fillRect(0.27,  halfW - 0.005, 0.08, 0.05);

  // Rear wing — wider than the body, white plank with body-colour endplates.
  // Drawn last: it sits above everything in top-down view.
  ctx.fillStyle = shadeHex(car.color, 0.7);
  ctx.fillRect(-0.80, -0.385, 0.16, 0.055);
  ctx.fillRect(-0.80,  0.330, 0.16, 0.055);
  ctx.fillStyle = '#e8ecf4';
  roundRect(ctx, -0.78, -0.36, 0.12, 0.72, 0.03);
  ctx.fill();
  ctx.strokeStyle = '#9aa6bd';
  ctx.lineWidth = 0.02;
  ctx.stroke();

  ctx.restore();
}

function drawWheel(bx: number, by: number, angle: number) {
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(angle);
  // Tire
  ctx.fillStyle = '#15161a';
  roundRect(ctx, -0.12, -0.05, 0.24, 0.10, 0.025);
  ctx.fill();
  // Gold rim
  ctx.fillStyle = '#d9b13b';
  roundRect(ctx, -0.065, -0.028, 0.13, 0.056, 0.015);
  ctx.fill();
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
