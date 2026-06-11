import QRCode from 'qrcode';
import { supabase, channelName } from './supabase';
import {
  CONFIG, makeCar, step, bodyToWorld, collideWithRects,
  type CarState, type Inputs,
} from './physics';
import {
  layoutDesktop, drawWallpaper, drawOverlay, drawClock,
  rebuildRects, iconAt, clampIconToBounds, resolveIconDrop,
  type DesktopWorld, type DesktopIcon,
} from './world';

// ---------- Session ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = Array.from(
  { length: 4 },
  () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
).join('');
const playUrl = `${window.location.origin}/play?s=${code}`;

const qrCanvas = document.getElementById('qr') as HTMLCanvasElement;
const codeText = document.getElementById('code-text') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const speedEl = document.getElementById('speed') as HTMLDivElement;
const driftEl = document.getElementById('drift') as HTMLDivElement;
const throttleBarEl  = document.getElementById('throttle-bar')  as HTMLDivElement;
const brakeBarEl     = document.getElementById('brake-bar')     as HTMLDivElement;
const handbrakeHudEl = document.getElementById('handbrake-hud') as HTMLDivElement;
const rearSlipValEl  = document.getElementById('rear-slip-val') as HTMLSpanElement | null;
const wspinValEl     = document.getElementById('wspin-val')     as HTMLSpanElement | null;

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
canvas.addEventListener('pointerup', endIconDrag);
canvas.addEventListener('pointercancel', endIconDrag);

resize();
window.addEventListener('resize', resize);

// ---------- Car ----------
const PX = () => CONFIG.pxPerMeter;
// Spawn at center of screen, heading "up" (matches canvas: -PI/2 = -y).
const car: CarState = makeCar(
  window.innerWidth  / 2 / PX(),
  window.innerHeight / 2 / PX(),
  -Math.PI / 2,
);

// ---------- Control input ----------
// target: latest from the phone. current: lerped toward target each frame for
// silky steering even when broadcast packets arrive choppy.
const target: Inputs = { steer: 0, throttle: 0, brake: 0, handbrake: false };
const current: Inputs = { steer: 0, throttle: 0, brake: 0, handbrake: false };

// ---------- Supabase channel ----------
const channel = supabase.channel(channelName(code), {
  config: { broadcast: { self: false } },
});

let connected = false;
function markConnected() {
  if (connected) return;
  connected = true;
  statusEl.textContent = 'Connected';
  statusEl.classList.add('connected');
}

channel.on('broadcast', { event: 'control' }, ({ payload }) => {
  markConnected();
  const p = payload as {
    steer?: unknown; throttle?: unknown; brake?: unknown; handbrake?: unknown;
  };
  const s = Number(p?.steer);
  const t = Number(p?.throttle);
  const b = Number(p?.brake);
  if (Number.isFinite(s)) target.steer    = clamp(s, -1, 1);
  if (Number.isFinite(t)) target.throttle = clamp(t, 0, 1);
  if (Number.isFinite(b)) target.brake    = clamp(b, 0, 1);
  target.handbrake = !!p?.handbrake;
});

channel.subscribe();

// ---------- Skids ----------
// We draw skid lines straight onto the persistent skidCanvas every physics
// step. Each rear wheel keeps a "previous pixel position" so we can draw a
// continuous line while it's skidding.
type WheelTrail = { px: number; py: number; active: boolean };
const skidRearL: WheelTrail = { px: 0, py: 0, active: false };
const skidRearR: WheelTrail = { px: 0, py: 0, active: false };

function rearWheelPositions() {
  const halfTrack = CONFIG.trackWidth / 2;
  const rearOffset = -CONFIG.wheelbase / 2;
  const L = bodyToWorld(car, rearOffset, +halfTrack);
  const R = bodyToWorld(car, rearOffset, -halfTrack);
  return { L, R };
}

function drawSkidSegment(trail: WheelTrail, wx: number, wy: number, sliding: boolean) {
  const px = wx * PX();
  const py = wy * PX();
  if (sliding) {
    if (trail.active) {
      // Don't draw across an edge-wrap jump.
      const dx = px - trail.px, dy = py - trail.py;
      if (dx * dx + dy * dy < 10000) {
        skidCtx.strokeStyle = 'rgba(28, 28, 32, 0.45)';
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

function recordSkids() {
  const driftingRear =
    car.isRearSliding || Math.abs(car.rearSlip) > CONFIG.slipThresholdForSkid;
  const { L, R } = rearWheelPositions();
  drawSkidSegment(skidRearL, L.x, L.y, driftingRear);
  drawSkidSegment(skidRearR, R.x, R.y, driftingRear);
}

// ---------- World wrap ----------
// Wrap on left/right/top only — the bottom edge is the taskbar, a solid
// wall the car collides with (see world.rects).
function wrap() {
  const W = window.innerWidth / PX();
  const M = 2; // margin in meters
  if (car.x < -M)       { car.x = W + M; invalidateSkidTrails(); }
  else if (car.x > W + M) { car.x = -M;    invalidateSkidTrails(); }
  if (car.y < -M) {
    // Re-enter from the bottom, emerging from just above the taskbar wall.
    car.y = window.innerHeight / PX() - world.taskbarHeight -
      CONFIG.carCollisionRadius - 0.2;
    invalidateSkidTrails();
  }
}
function invalidateSkidTrails() {
  // After wrapping we don't want a long streak across the screen.
  skidRearL.active = false;
  skidRearR.active = false;
}

// ---------- Main loop with fixed-timestep accumulator ----------
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;
let lastTime = performance.now();
let accumulator = 0;

function frame(now: number) {
  const realDt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  accumulator += realDt;

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
    // Smooth incoming inputs inside the fixed step so the smoothing rate is
    // frame-rate independent. Steer gets the heaviest smoothing. Throttle /
    // brake get a light lerp so 30Hz network steps don't visibly jump the
    // 60Hz physics. Handbrake is binary — snap.
    current.steer    += (target.steer    - current.steer)    * CONFIG.inputLerp;
    current.throttle += (target.throttle - current.throttle) * 0.3;
    current.brake    += (target.brake    - current.brake)    * 0.3;
    current.handbrake = target.handbrake;

    step(car, current, FIXED_DT);
    collideWithRects(car, world.rects);
    recordSkids();
    wrap();

    accumulator -= FIXED_DT;
    steps++;
  }
  // Drop accumulated time if we fell way behind (prevents spiral of death).
  if (steps === MAX_SUBSTEPS) accumulator = 0;

  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Render ----------
function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  // Layered desktop: wallpaper → skids → icons/taskbar → clock → car.
  ctx.drawImage(wallpaperCanvas, 0, 0, W, H);
  ctx.drawImage(skidCanvas, 0, 0, W, H);
  ctx.drawImage(overlayCanvas, 0, 0, W, H);
  drawClock(ctx, world, CONFIG.pxPerMeter);

  drawCar();
  updateHud();
}

function updateHud() {
  // Fake "km/h" so it reads like a dashboard. 1 m/s ≈ 3.6 km/h.
  const kmh = Math.round(car.speed * 3.6);
  speedEl.textContent = String(kmh).padStart(3, '0');

  // GRIP / DRIFT badge — LATERAL sliding only (p9). A straight-line
  // burnout spins the wheels but isn't a drift; the badge keys off the
  // rear slip angle alone. (Skid marks still include pure wheelspin —
  // burnout stripes are a feature.)
  const drifting = Math.abs(car.rearSlip) > CONFIG.slipThresholdForSkid;
  driftEl.textContent = drifting ? 'DRIFT' : 'GRIP';
  driftEl.classList.toggle('on', drifting);

  // Live rear slip angle in degrees. Signed (+ = sliding one way, - the
  // other) so the tuner can see direction at a glance.
  if (rearSlipValEl) {
    const slipDeg = car.rearSlip * 180 / Math.PI;
    const sign = slipDeg >= 0 ? '+' : '';
    rearSlipValEl.textContent = sign + slipDeg.toFixed(1) + '°';
  }

  // Rear wheelspin as a percentage. 0% while the tire grips (even at full
  // throttle), >0% only when the rear is saturated — burnout, handbrake
  // lock, or power-over spin.
  if (wspinValEl) {
    wspinValEl.textContent = Math.round(car.wheelSpin * 100) + '%';
  }

  // Pedal bars — show smoothed (current) values, what the physics actually
  // sees, not the raw 30Hz packet. 0 = empty, 1 = full.
  if (throttleBarEl) throttleBarEl.style.height = (current.throttle * 100).toFixed(0) + '%';
  if (brakeBarEl)    brakeBarEl.style.height    = (current.brake    * 100).toFixed(0) + '%';
  if (handbrakeHudEl) handbrakeHudEl.classList.toggle('on', current.handbrake);
}

// ---------- Drawing ----------
// CAR_DRAW_SCALE applies uniformly to every visual dimension of the car
// (body, cabin, nose, wheel chrome). It tracks the same 1/3 reduction
// applied to CONFIG.wheelbase / CONFIG.trackWidth in physics.ts so the
// sprite and the physical footprint stay in proportion.
const CAR_DRAW_SCALE = 1 / 3;

function drawCar() {
  // Draw the car centered at its world position, rotated by heading.
  // All inner coordinates are in METERS, then scaled by pxPerMeter.
  const sx = car.x * PX();
  const sy = car.y * PX();

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(car.heading);
  ctx.scale(PX(), PX()); // now draw in meters

  const s = CAR_DRAW_SCALE;
  const len = 4.5 * s;
  const wid = 1.85 * s;
  const halfL = len / 2;
  const halfW = wid / 2;

  // Body
  ctx.fillStyle = '#e63946';
  roundRect(ctx, -halfL, -halfW, len, wid, 0.35 * s);
  ctx.fill();

  // Roof tint (windshield + cabin) — helps see orientation
  ctx.fillStyle = '#1d3557';
  roundRect(ctx, -0.6 * s, -halfW + 0.18 * s, 1.7 * s, wid - 0.36 * s, 0.2 * s);
  ctx.fill();

  // Nose marker (front)
  ctx.fillStyle = '#f1faee';
  ctx.beginPath();
  ctx.moveTo(halfL - 0.15 * s, -halfW + 0.25 * s);
  ctx.lineTo(halfL + 0.05 * s, 0);
  ctx.lineTo(halfL - 0.15 * s, halfW - 0.25 * s);
  ctx.closePath();
  ctx.fill();

  // Wheels (front wheels rotate by steerAngle). Positions come from
  // CONFIG.wheelbase / CONFIG.trackWidth which are already at the smaller
  // scale; the wheel chrome itself is scaled by CAR_DRAW_SCALE inside
  // drawWheel(). This is the same source used by the skid emitter, so
  // skid marks spawn exactly under these rear wheels.
  drawWheel(+CONFIG.wheelbase / 2, -CONFIG.trackWidth / 2, car.steerAngle);
  drawWheel(+CONFIG.wheelbase / 2, +CONFIG.trackWidth / 2, car.steerAngle);
  drawWheel(-CONFIG.wheelbase / 2, -CONFIG.trackWidth / 2, 0);
  drawWheel(-CONFIG.wheelbase / 2, +CONFIG.trackWidth / 2, 0);

  ctx.restore();
}

function drawWheel(bx: number, by: number, angle: number) {
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(angle);
  ctx.fillStyle = '#1c1c20';
  const s = CAR_DRAW_SCALE;
  roundRect(ctx, -0.32 * s, -0.13 * s, 0.64 * s, 0.26 * s, 0.06 * s);
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

// ---------- Util ----------
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
