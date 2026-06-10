import QRCode from 'qrcode';
import { supabase, channelName } from './supabase';
import { CONFIG, makeCar, step, bodyToWorld, type CarState, type Inputs } from './physics';

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
// Main canvas: cleared every frame, draws car + HUD overlay.
// Skid canvas: persistent — accumulates tire skid lines.
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const skidCanvas = document.createElement('canvas');
const skidCtx = skidCanvas.getContext('2d')!;

let dpr = window.devicePixelRatio || 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;

  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Resize the skid buffer too. (Naive: previous skids are cleared on resize.)
  skidCanvas.width = Math.floor(w * dpr);
  skidCanvas.height = Math.floor(h * dpr);
  skidCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
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
function wrap() {
  const W = window.innerWidth / PX();
  const H = window.innerHeight / PX();
  const M = 2; // margin in meters
  if (car.x < -M)       { car.x = W + M; invalidateSkidTrails(); }
  else if (car.x > W + M) { car.x = -M;    invalidateSkidTrails(); }
  if (car.y < -M)       { car.y = H + M; invalidateSkidTrails(); }
  else if (car.y > H + M) { car.y = -M;    invalidateSkidTrails(); }
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

  // Clear with white background, then composite the skid buffer on top.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(skidCanvas, 0, 0, W, H);

  drawCar();
  updateHud();
}

function updateHud() {
  // Fake "km/h" so it reads like a dashboard. 1 m/s ≈ 3.6 km/h.
  const kmh = Math.round(car.speed * 3.6);
  speedEl.textContent = String(kmh).padStart(3, '0');

  // GRIP / DRIFT state — drives the badge text + amber styling. Drifting
  // when the physics has flagged a rear slide OR the rear slip angle is
  // past the visual threshold (so we see the badge flip the moment the
  // tuning starts producing slip, even if force-clamp hasn't kicked in).
  const drifting = car.isRearSliding ||
    Math.abs(car.rearSlip) > CONFIG.slipThresholdForSkid;
  driftEl.textContent = drifting ? 'DRIFT' : 'GRIP';
  driftEl.classList.toggle('on', drifting);

  // Live rear slip angle in degrees. Signed (+ = sliding one way, - the
  // other) so the tuner can see direction at a glance.
  if (rearSlipValEl) {
    const slipDeg = car.rearSlip * 180 / Math.PI;
    const sign = slipDeg >= 0 ? '+' : '';
    rearSlipValEl.textContent = sign + slipDeg.toFixed(1) + '°';
  }

  // Rear wheelspin as a percentage (|slip ratio| clamped to 1). ~13% under
  // clean full-throttle acceleration, 100% during a burnout/lock.
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
