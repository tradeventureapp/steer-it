import { supabase, channelName } from './supabase';

// ---------- Tuning ----------
const TILT_SENSITIVITY_DEG = 35;
const TILT_DEADZONE_DEG    = 3;
const SEND_HZ              = 30;
// Analog pedal mapping: the top of the strip (player's visual outer edge,
// away from the handbrake) is a saturation zone — any touch there pins the
// value at 1.0. The active linear range covers the remaining bottom 3/4.
// This puts "full throttle / full brake" comfortably mid-strip instead of
// at the very screen edge where the player has to aim precisely.
const PEDAL_SATURATION_FRACTION = 0.25;
// Below this in-plane gravity magnitude, the phone is too flat for a
// well-defined steering or rotation direction. Send neutral.
const FLAT_THRESHOLD       = 3.0;
// Low-pass smoothing for the gravity vector used to drive the visual
// rotation. Raw devicemotion is noisy; we don't want the stage rotation
// to jitter on every steering twitch.
const ROT_SMOOTHING_ALPHA  = 0.12;
// Hysteresis: a new orientation classification has to dominate the other
// axis by this factor before we accept it. Prevents borderline tilts from
// flipping the visual frame mid-drive.
const ORIENTATION_HYSTERESIS = 1.6;

// ---------- DOM ----------
const params = new URLSearchParams(window.location.search);
const code = (params.get('s') || '').toUpperCase();

const stageEl     = document.getElementById('phone-stage')    as HTMLDivElement;
const unlockBtn   = document.getElementById('unlock')         as HTMLButtonElement;
const pedalsEl    = document.getElementById('pedals')         as HTMLDivElement;
const brakeBtn    = document.getElementById('pedal-brake')    as HTMLButtonElement;
const throttleBtn = document.getElementById('pedal-throttle') as HTMLButtonElement;
const handbrakeBtn = document.getElementById('handbrake')     as HTMLButtonElement;
const errorEl     = document.getElementById('error')          as HTMLDivElement;
const debugEl     = document.getElementById('debug')          as HTMLDivElement | null;

// ---------- State ----------
type Stage = 'before-unlock' | 'after-unlock' | 'error';
let stage: Stage = 'before-unlock';
let errorMsg = '';
let permState: 'unknown' | 'granted' | 'denied' | 'not-required' = 'unknown';

// Raw sensor readings (device frame).
let lastBeta = 0;
let lastGamma = 0;
let lastAx = 0, lastAy = 0, lastAz = 0;
let hasMotionReading = false;

// Smoothed (ax, ay) for the rotation classifier — driven from a low-pass
// of the raw motion so steering wobble doesn't flip the visual frame.
let smoothedAx = 0, smoothedAy = 0;

// Calibration baseline for steering — captured once on TAP TO STEER and
// never recalculated. The cross-dot steering math is orientation-
// agnostic so a single baseline carries through any way the player ends
// up holding the phone.
let calibAx = 0, calibAy = 0;
let calibrated = false;
let recalibrating = false;

// Current physical orientation (from smoothed gravity) and applied stage
// rotation in degrees. Cached so we only touch the DOM when they change.
type Phys = 'L-pri' | 'L-sec' | 'portrait' | 'port-down' | 'flat';
let currentPhys: Phys = 'flat';
let appliedRotDeg: number | null = null;

// Analog pedals: per-zone map of pointerId -> current 0..1 value. We take the
// MAX across active pointers so an aggressive second finger can pin the pedal
// at 100% even if the first finger is mid-strip.
type Zone = 'throttle' | 'brake';
const pedalValues: Record<Zone, Map<number, number>> = {
  throttle: new Map(),
  brake:    new Map(),
};
function pedalValue(zone: Zone): number {
  const m = pedalValues[zone];
  if (m.size === 0) return 0;
  let max = 0;
  for (const v of m.values()) if (v > max) max = v;
  return max;
}

// Handbrake: binary on/off, multi-touch tolerant.
const handbrakePointers = new Set<number>();
function handbrakeOn(): boolean { return handbrakePointers.size > 0; }

// ---------- Channel ----------
if (!code) {
  errorMsg = 'No session code in URL. Scan the QR on the desktop screen.';
  stage = 'error';
}
const channel = supabase.channel(channelName(code), {
  config: { broadcast: { self: false } },
});
channel.subscribe();

// ---------- Render ----------
function renderUI() {
  unlockBtn.hidden = true;
  pedalsEl.hidden  = true;
  errorEl.hidden   = true;

  if (stage === 'error') {
    errorEl.hidden = false;
    errorEl.textContent = errorMsg;
  } else if (stage === 'before-unlock') {
    unlockBtn.hidden = false;
  } else {
    pedalsEl.hidden = false;
  }

  updateDebug();
}

// ----------------------------------------------------------------------
//  Gravity → physical orientation, with hysteresis.
//
//  Device-frame conventions (W3C):
//    ax ≈ +g → device's +X edge points down → landscape-primary
//                (top-of-phone to player's right)
//    ax ≈ -g → landscape-secondary (top-of-phone to player's left)
//    ay ≈ -g → portrait (top-of-phone up)
//    ay ≈ +g → portrait upside-down (top-of-phone down)
//
//  Hysteresis: to switch into a new orientation, the new dominant axis
//  has to beat the other by ORIENTATION_HYSTERESIS. Once classified, a
//  borderline tilt won't flip us.
// ----------------------------------------------------------------------
function classifyOrientation(ax: number, ay: number, current: Phys): Phys {
  const mag = Math.hypot(ax, ay);
  if (mag < FLAT_THRESHOLD) return 'flat';

  const ax_abs = Math.abs(ax);
  const ay_abs = Math.abs(ay);

  // Strong dominance — always accept.
  const requiredFactor = current === 'flat' ? 1.0 : ORIENTATION_HYSTERESIS;

  if (ax_abs > ay_abs * requiredFactor) {
    return ax > 0 ? 'L-pri' : 'L-sec';
  }
  if (ay_abs > ax_abs * requiredFactor) {
    return ay > 0 ? 'port-down' : 'portrait';
  }
  // Ambiguous — keep current.
  return current;
}

// ----------------------------------------------------------------------
//  Compute the CSS rotation (degrees) needed to make the landscape
//  stage visually upright in the player's view.
//
//  Two inputs:
//    phys           — how the phone is physically held (from gravity)
//    browserLandscape — whether the browser is presenting the page in
//                       a landscape-aspect viewport right now
//                       (innerWidth > innerHeight)
//
//  Cases the player will hit (player always holds landscape):
//    phys=L-pri,  browser=landscape: browser auto-rotated to match → 0°
//    phys=L-pri,  browser=portrait:  rotation locked or pre-rotate    → -90°
//    phys=L-sec,  browser=landscape: browser auto-rotated to match → 0°
//    phys=L-sec,  browser=portrait:                                  → +90°
//
//  Edge cases (player accidentally portrait):
//    phys=portrait,  browser=portrait:    → 0°
//    phys=portrait,  browser=landscape:   → -90°  (best-effort)
//    phys=port-down, browser=portrait:    → 180°
//    phys=port-down, browser=landscape:   → +90°
//
//  flat → keep last applied rotation (don't flip when the phone is
//          briefly horizontal).
// ----------------------------------------------------------------------
function computeRot(phys: Phys, browserLandscape: boolean): number | null {
  if (phys === 'flat') return null;

  if (browserLandscape) {
    if (phys === 'L-pri' || phys === 'L-sec') return 0;
    if (phys === 'portrait')                  return -90;
    return 90; // port-down
  }
  // Browser portrait.
  if (phys === 'L-pri')      return -90;
  if (phys === 'L-sec')      return  90;
  if (phys === 'port-down')  return 180;
  return 0; // portrait
}

function applyTransform() {
  if (!hasMotionReading) return;

  const newPhys = classifyOrientation(smoothedAx, smoothedAy, currentPhys);
  currentPhys = newPhys;

  const browserLandscape = window.innerWidth > window.innerHeight;
  const desired = computeRot(newPhys, browserLandscape);
  if (desired == null) return; // flat: keep last rotation

  if (desired !== appliedRotDeg) {
    appliedRotDeg = desired;
    document.documentElement.style.setProperty('--rot', desired + 'deg');
  }
}

// rAF coalescer so per-event motion fires don't spam DOM writes.
let rafQueued = false;
function scheduleApplyTransform() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    applyTransform();
  });
}

// ----------------------------------------------------------------------
//  Steering — unchanged cross-dot on raw (ax, ay) vs baseline.
//
//  The angle the device has rolled around its screen-perpendicular axis
//  since calibration. Sign falls out correctly in every orientation
//  because the formula is purely geometric in the device frame.
// ----------------------------------------------------------------------
function steeringTiltDeg(): number {
  if (!hasMotionReading || !calibrated) return 0;
  const baseMag = Math.hypot(calibAx, calibAy);
  if (baseMag < FLAT_THRESHOLD) return 0;
  const cross = calibAx * lastAy - calibAy * lastAx;
  const dot   = calibAx * lastAx + calibAy * lastAy;
  return Math.atan2(cross, dot) * 180 / Math.PI;
}

function steerFromTilt(): number {
  if (recalibrating) return 0;
  const tiltDeg = steeringTiltDeg();
  const sign = Math.sign(tiltDeg);
  const mag = Math.max(0, Math.abs(tiltDeg) - TILT_DEADZONE_DEG);
  const norm = Math.min(1, mag / (TILT_SENSITIVITY_DEG - TILT_DEADZONE_DEG));
  return sign * norm;
}

// ----------------------------------------------------------------------
//  Debug strip
// ----------------------------------------------------------------------
function updateDebug() {
  if (!debugEl) return;
  const browserLandscape = window.innerWidth > window.innerHeight;
  const tilt = steeringTiltDeg();
  const steer = steerFromTilt();
  debugEl.textContent =
    `stage=${stage} perm=${permState} cal=${calibrated ? 'yes' : 'no'}${recalibrating ? ' RE' : ''}\n` +
    `phys=${currentPhys}  browser=${browserLandscape ? 'L' : 'P'}  rot=${appliedRotDeg ?? '—'}°\n` +
    `ax=${lastAx.toFixed(1)} ay=${lastAy.toFixed(1)} az=${lastAz.toFixed(1)}  ` +
    `sm=(${smoothedAx.toFixed(1)},${smoothedAy.toFixed(1)})\n` +
    `calAx=${calibAx.toFixed(1)} calAy=${calibAy.toFixed(1)}\n` +
    `beta=${lastBeta.toFixed(0)} gamma=${lastGamma.toFixed(0)}\n` +
    `tilt=${tilt.toFixed(1)}° steer=${steer.toFixed(2)}  ` +
    `t=${pedalValue('throttle').toFixed(2)} b=${pedalValue('brake').toFixed(2)} ` +
    `hb=${handbrakeOn() ? 'ON' : 'off'}`;
}

// ----------------------------------------------------------------------
//  Unlock + permission
// ----------------------------------------------------------------------
unlockBtn.addEventListener('click', async () => {
  try {
    const win = window as unknown as {
      DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
      DeviceMotionEvent?:      { requestPermission?: () => Promise<string> };
    };

    let neededAny = false;
    if (typeof win.DeviceOrientationEvent?.requestPermission === 'function') {
      neededAny = true;
      const r = await win.DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') {
        permState = 'denied';
        errorMsg = 'Motion permission denied. Reload and tap again.';
        stage = 'error';
        renderUI();
        return;
      }
    }
    if (typeof win.DeviceMotionEvent?.requestPermission === 'function') {
      neededAny = true;
      try {
        const r = await win.DeviceMotionEvent.requestPermission();
        if (r !== 'granted') {
          permState = 'denied';
          errorMsg = 'Motion permission denied (motion). Reload and tap again.';
          stage = 'error';
          renderUI();
          return;
        }
      } catch { /* older iOS bundles motion with orientation */ }
    }
    permState = neededAny ? 'granted' : 'not-required';

    stage = 'after-unlock';
    attachSensorListeners();
    attachControlListeners();
    startBroadcast();
    renderUI();
    void calibrate();
  } catch (err) {
    errorMsg = 'Could not enable motion: ' + (err as Error).message;
    stage = 'error';
    renderUI();
  }
});

// ----------------------------------------------------------------------
//  Sensor listeners
// ----------------------------------------------------------------------
function attachSensorListeners() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta  != null) lastBeta  = e.beta;
    if (e.gamma != null) lastGamma = e.gamma;
  });
  window.addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    if (a.x != null) lastAx = a.x;
    if (a.y != null) lastAy = a.y;
    if (a.z != null) lastAz = a.z;

    if (!hasMotionReading) {
      // Seed smoothing with the first sample so the rotation snaps to
      // the right value immediately rather than ramping from zero.
      smoothedAx = lastAx;
      smoothedAy = lastAy;
    } else {
      smoothedAx = smoothedAx * (1 - ROT_SMOOTHING_ALPHA) + lastAx * ROT_SMOOTHING_ALPHA;
      smoothedAy = smoothedAy * (1 - ROT_SMOOTHING_ALPHA) + lastAy * ROT_SMOOTHING_ALPHA;
    }
    hasMotionReading = true;
    scheduleApplyTransform();
  });
}

// ----------------------------------------------------------------------
//  Calibration — once on unlock, never again. The cross-dot steering
//  formula is orientation-agnostic so one baseline carries through any
//  physical hold the player ends up in.
// ----------------------------------------------------------------------
async function calibrate() {
  recalibrating = true;

  // Wait for the first sample (iOS sometimes stalls 50-150ms).
  const start = performance.now();
  while (!hasMotionReading && performance.now() - start < 700) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const samples: Array<{ x: number; y: number }> = [];
  const COUNT = 8;
  const GAP_MS = 40;
  for (let i = 0; i < COUNT; i++) {
    await new Promise((r) => setTimeout(r, GAP_MS));
    if (!hasMotionReading) continue;
    samples.push({ x: lastAx, y: lastAy });
  }
  if (samples.length === 0) {
    calibAx = 0; calibAy = 0;
  } else {
    calibAx = samples.reduce((s, p) => s + p.x, 0) / samples.length;
    calibAy = samples.reduce((s, p) => s + p.y, 0) / samples.length;
  }
  calibrated = true;
  recalibrating = false;
}

// ----------------------------------------------------------------------
//  Analog pedals + handbrake (multi-touch via pointer events).
//
//  Each pedal is a tall vertical strip. The finger's vertical position
//  within the strip's local frame is the input:
//      offsetY = 0           → top of strip → value = 1
//      offsetY = clientHeight → bottom      → value = 0
//
//  offsetY is reported in the element's PRE-TRANSFORM local frame, so it
//  works correctly even when #phone-stage is CSS-rotated for the
//  forced-landscape view. The value is clamped to [0, 1].
//
//  We deliberately DO NOT release on `pointerleave`: with pointer
//  capture, the finger can slide below or above the strip without
//  cancelling the input — value just clamps to 0 or 1 respectively.
// ----------------------------------------------------------------------
function attachControlListeners() {
  bindAnalogPedal(throttleBtn, 'throttle');
  bindAnalogPedal(brakeBtn,    'brake');
  bindHandbrake(handbrakeBtn);
}

// Map a pointer's offsetY within the strip to a 0..1 pedal value.
//
//   y ∈ [0, h * SAT_FRAC]         → 1.0  (saturation zone, top quarter)
//   y ∈ (h * SAT_FRAC, h]         → linear from 1.0 down to 0.0
//
// In offsetY coords the top of the strip (offsetY = 0) is the player's
// visual outer edge (away from the handbrake), and the bottom (offsetY = h)
// is the inner end nearest the handbrake. Hitting the FULL mark is now at
// 3/4 of the way up the strip — much easier to reach without aiming at
// the screen edge.
function pedalValueFromEvent(e: PointerEvent, el: HTMLElement): number {
  const h = el.clientHeight || 1;
  const y = e.offsetY;
  const satEdge = h * PEDAL_SATURATION_FRACTION;
  if (y <= satEdge) return 1;
  const activeRange = h - satEdge; // h * (1 - SAT_FRAC) = 0.75 * h
  const inRange = y - satEdge;
  const value = 1 - inRange / activeRange;
  return Math.max(0, Math.min(1, value));
}

// Drive the visual fill bar.
// Fill grows from the strip bottom upward and tops out at the FULL mark
// (= 1 - SAT_FRAC of strip height), so the visible fill scale matches the
// active-range mapping above. At value=1 we also flip on `at-max` so the
// saturation zone overlay brightens, signalling "pinned at max".
function updatePedalFill(el: HTMLElement, zone: Zone) {
  const fill = el.querySelector('.pedal-fill') as HTMLDivElement | null;
  const v = pedalValue(zone);
  if (fill) {
    const activeRangePct = (1 - PEDAL_SATURATION_FRACTION) * 100; // 75
    fill.style.height = (v * activeRangePct).toFixed(1) + '%';
  }
  el.classList.toggle('at-max', v >= 0.999);
}

function bindAnalogPedal(el: HTMLElement, zone: Zone) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const v = pedalValueFromEvent(e, el);
    pedalValues[zone].set(e.pointerId, v);
    el.classList.add('active');
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    updatePedalFill(el, zone);
  });
  el.addEventListener('pointermove', (e) => {
    if (!pedalValues[zone].has(e.pointerId)) return;
    const v = pedalValueFromEvent(e, el);
    pedalValues[zone].set(e.pointerId, v);
    updatePedalFill(el, zone);
  });
  const release = (e: PointerEvent) => {
    if (!pedalValues[zone].has(e.pointerId)) return;
    pedalValues[zone].delete(e.pointerId);
    if (pedalValues[zone].size === 0) el.classList.remove('active');
    updatePedalFill(el, zone);
  };
  el.addEventListener('pointerup',     release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('contextmenu',   (e) => e.preventDefault());
}

function bindHandbrake(el: HTMLElement) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handbrakePointers.add(e.pointerId);
    el.classList.add('active');
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  const release = (e: PointerEvent) => {
    if (!handbrakePointers.has(e.pointerId)) return;
    handbrakePointers.delete(e.pointerId);
    if (handbrakePointers.size === 0) el.classList.remove('active');
  };
  el.addEventListener('pointerup',     release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('contextmenu',   (e) => e.preventDefault());
}

// ----------------------------------------------------------------------
//  Broadcast
// ----------------------------------------------------------------------
function startBroadcast() {
  const INTERVAL_MS = 1000 / SEND_HZ;
  setInterval(() => {
    const payload = {
      steer:    steerFromTilt(),
      throttle:  pedalValue('throttle'),
      brake:     pedalValue('brake'),
      handbrake: handbrakeOn(),
    };
    channel.send({ type: 'broadcast', event: 'control', payload });
  }, INTERVAL_MS);
}

// ----------------------------------------------------------------------
//  Resize watcher — only purpose is to retrigger rotation computation
//  when the browser DOES reflow the viewport, so our rot value updates
//  to match the new innerWidth/innerHeight aspect. We do NOT recalibrate
//  steering on resize — that's what was causing flips before.
// ----------------------------------------------------------------------
window.addEventListener('resize', scheduleApplyTransform);

// Debug poll for live readouts between motion events.
setInterval(updateDebug, 250);

// stageEl is referenced for future tweaks; for now CSS handles the
// rotation via the --rot custom property on documentElement.
void stageEl;

// ---------- Initial render ----------
renderUI();
