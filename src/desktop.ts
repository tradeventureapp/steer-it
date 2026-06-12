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
import { SoundEngine } from './sound';
import { Effects } from './effects';
import {
  PLAYER_CAP, LOBBY_SYNC_MS, EV, colorName, LobbyState,
} from './lobby';

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
const rosterEl = document.getElementById('lobby-roster') as HTMLDivElement | null;
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

function renderLobbyUI() {
  const n = lobby.size();
  statusEl.textContent = n === 0 ? 'Waiting for phone…' : `${n}/${PLAYER_CAP} connected`;
  statusEl.classList.toggle('connected', n > 0);
  if (!rosterEl) return;
  rosterEl.innerHTML = n === 0 ? '' : lobby.snapshot().map((p) =>
    `<div class="roster-row">` +
      `<span class="roster-dot" style="background:${p.color};box-shadow:0 0 8px ${p.color}"></span>` +
      `<span class="roster-name">PLAYER ${p.slot + 1}</span>` +
      `<span class="roster-color">${colorName(p.color)}</span>` +
      `<span class="roster-ok">●</span>` +
    `</div>`
  ).join('');
}

function applyControl(p: {
  steer?: unknown; throttle?: unknown; brake?: unknown; handbrake?: unknown;
}) {
  const s = Number(p?.steer);
  const t = Number(p?.throttle);
  const b = Number(p?.brake);
  if (Number.isFinite(s)) target.steer    = clamp(s, -1, 1);
  if (Number.isFinite(t)) target.throttle = clamp(t, 0, 1);
  if (Number.isFinite(b)) target.brake    = clamp(b, 0, 1);
  target.handbrake = !!p?.handbrake;
}

// ---- phone → desktop handlers ----
channel.on('broadcast', { event: EV.join }, ({ payload }) => {
  const id = String((payload as { id?: unknown })?.id ?? '');
  if (!id) return;
  const color = (payload as { color?: string })?.color;
  const r = lobby.join(id, color, Date.now());
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

channel.on('broadcast', { event: EV.leave }, ({ payload }) => {
  const id = String((payload as { id?: unknown })?.id ?? '');
  if (id && lobby.leave(id).changed) broadcastLobby();
});

channel.on('broadcast', { event: EV.control }, ({ payload }) => {
  const id = String((payload as { id?: unknown })?.id ?? '');
  // STEP 1: only slot 0 drives the existing single car. Other slots' control
  // is accepted (keeps them connected) but not yet simulated.
  if (!id) { applyControl(payload); return; }     // legacy id-less → drive car
  const r = lobby.join(id, undefined, Date.now()); // lazy-join if join was missed
  if (r.changed) broadcastLobby();
  if (r.slot === 0) applyControl(payload);
});

// ---- disconnect sweep + periodic lobby re-sync ----
setInterval(() => { if (lobby.sweep(Date.now()).changed) broadcastLobby(); }, 1000);
setInterval(() => { if (lobby.size()) broadcastLobby(); }, LOBBY_SYNC_MS);

channel.subscribe();
renderLobbyUI();

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
    // p15b: throttle lerp 0.3 → 0.5. A pinned pedal must reach near-full FAST,
    // before the standing car accelerates past the boost-fade window — at 0.3
    // the throttle ramp lagged so far that a full-pedal launch never lit the
    // burnout (the boost had already faded by the time throttle maxed).
    current.throttle += (target.throttle - current.throttle) * 0.5;
    current.brake    += (target.brake    - current.brake)    * 0.3;
    current.handbrake = target.handbrake;

    step(car, current, FIXED_DT);
    const impact = collideWithRects(car, world.rects);
    if (impact > 0.8) {
      sound.impact(impact);
      fx.impact(car.x, car.y, impact);
    }
    recordSkids();
    wrap();

    accumulator -= FIXED_DT;
    steps++;
  }
  // Drop accumulated time if we fell way behind (prevents spiral of death).
  if (steps === MAX_SUBSTEPS) accumulator = 0;

  // ---- Sound + effects (per render frame) ----
  sound.update({
    wheelSpeed: car.rearWheelSpeed,
    speed: car.speed,
    slipAngle: car.rearSlip,
    wheelSpin: car.wheelSpin,
    throttle: current.throttle,
  });
  // Tire smoke from the rear wheels while drifting or spinning — the
  // visual twin of the squeal. car.rearSlip is speed-gated in physics, so
  // a parked car (slip == 0) only smokes from genuine WSPIN (standing
  // burnout), never from atan2 noise.
  const slipNorm = Math.min(1,
    Math.abs(car.rearSlip) / (CONFIG.slipThresholdForSkid * 2.5));
  const smokeIntensity = Math.max(
    car.wheelSpin, slipNorm > 0.4 ? slipNorm : 0);
  if (smokeIntensity > 0.2) {
    // Spawn slightly BEHIND the rear wheels (along -heading) and keep puffs
    // modest near a slow car so a standing burnout never hides it.
    const back = 0.45;
    const bx = -Math.cos(car.heading) * back;
    const by = -Math.sin(car.heading) * back;
    const sizeScale = 0.55 + 0.45 * Math.min(1, car.speed / 6);
    const { L, R } = rearWheelPositions();
    fx.emitSmoke(L.x + bx, L.y + by, car.vx, car.vy, smokeIntensity, realDt, sizeScale);
    fx.emitSmoke(R.x + bx, R.y + by, car.vx, car.vy, smokeIntensity, realDt, sizeScale);
  }
  fx.update(realDt);

  render();
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

  drawCar();
  fx.draw(ctx, CONFIG.pxPerMeter);

  ctx.restore();
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

  if (debugOn) {
    // Mirror the physics gates so the screen shows WHY a burnout/spin did or
    // didn't fire from the real commanded values.
    const boostGate = Math.max(0, Math.min(1,
      (current.throttle - CONFIG.burnoutThrottle) / (1 - CONFIG.burnoutThrottle)));
    const armT = current.handbrake
      ? CONFIG.spinReleaseThresholdHB : CONFIG.spinReleaseThreshold;
    debugEl.textContent =
      `steer   ${current.steer.toFixed(2)}   (spin-arm ≥ ${armT.toFixed(2)}${current.handbrake ? ' HB' : ''})\n` +
      `throttle ${current.throttle.toFixed(2)}  brake ${current.brake.toFixed(2)}  hb ${current.handbrake ? 'ON' : 'off'}\n` +
      `burnout boost ${(boostGate * 100).toFixed(0)}%   (ignites ≥ ${CONFIG.burnoutThrottle.toFixed(2)})\n` +
      `spinTimer ${car.spinTimer.toFixed(2)}  drift ${car.driftActive ? 'Y' : 'n'}  wspin ${(car.wheelSpin * 100).toFixed(0)}%`;
  }
}

// ---------- Drawing: top-down rally car ----------
// Evokes a 2000s WRC hatchback — deep blue body, gold wheels, white
// stripes, roof roundel and a rear wing — with zero trademarked marks.
// The footprint matches the old placeholder (1.5 m × 0.617 m, the 1/3 of
// the original 4.5/1.85 sprite) so physics dimensions are untouched.
// Bold shapes over fine detail: it must read as a rally car at ~35 px.

function drawCar() {
  // Draw centered at the car's world position, rotated by heading.
  // Inner coordinates are METERS (ctx scaled by pxPerMeter); +x = front.
  const sx = car.x * PX();
  const sy = car.y * PX();

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(car.heading);
  ctx.scale(PX(), PX());

  const halfL = 0.75;   // 1.5 m long
  const halfW = 0.309;  // 0.617 m wide

  // Body — deep rally blue with a darker outline.
  ctx.fillStyle = '#1d3fa0';
  roundRect(ctx, -halfL, -halfW, halfL * 2, halfW * 2, 0.12);
  ctx.fill();
  ctx.strokeStyle = '#12265e';
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
  drawWheel(+CONFIG.wheelbase / 2, -CONFIG.trackWidth / 2, car.steerAngle);
  drawWheel(+CONFIG.wheelbase / 2, +CONFIG.trackWidth / 2, car.steerAngle);
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

  // Roof panel.
  ctx.fillStyle = '#2b54c4';
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
  ctx.fillText('7', -0.07, 0.015);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Side mirrors at the windshield base.
  ctx.fillStyle = '#12265e';
  ctx.fillRect(0.27, -halfW - 0.045, 0.08, 0.05);
  ctx.fillRect(0.27,  halfW - 0.005, 0.08, 0.05);

  // Rear wing — wider than the body, white plank with dark endplates.
  // Drawn last: it sits above everything in top-down view.
  ctx.fillStyle = '#142c73';
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

// ---------- Util ----------
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
