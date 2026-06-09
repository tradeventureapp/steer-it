import { supabase, channelName } from './supabase';

// ---------- Tuning ----------
const TILT_SENSITIVITY_DEG = 35;   // tilt from neutral that maps to full ±1
const TILT_DEADZONE_DEG    = 3;
const SEND_HZ              = 30;
// Magnitude (m/s²) of (ax, ay) below which we treat the phone as "too flat"
// — a flat-on-table baseline has no in-plane gravity component so no
// well-defined steering direction. Below threshold we send neutral.
const FLAT_THRESHOLD       = 3.0;

// ---------- DOM ----------
const params = new URLSearchParams(window.location.search);
const code = (params.get('s') || '').toUpperCase();

const unlockBtn   = document.getElementById('unlock')         as HTMLButtonElement;
const pedalsEl    = document.getElementById('pedals')         as HTMLDivElement;
const brakeBtn    = document.getElementById('pedal-brake')    as HTMLButtonElement;
const throttleBtn = document.getElementById('pedal-throttle') as HTMLButtonElement;
const errorEl     = document.getElementById('error')          as HTMLDivElement;
const debugEl     = document.getElementById('debug')          as HTMLDivElement | null;

// ---------- State ----------
type Stage = 'before-unlock' | 'after-unlock' | 'error';
let stage: Stage = 'before-unlock';
let errorMsg = '';
let permState: 'unknown' | 'granted' | 'denied' | 'not-required' = 'unknown';

const landscapeMQ = window.matchMedia('(orientation: landscape)');

// Sensor readings.
// We listen to deviceorientation for beta/gamma (debug only) and to
// devicemotion for accelerationIncludingGravity, which is the real input
// to the steering math.
let lastBeta = 0;
let lastGamma = 0;
let hasOrientationReading = false;

let lastAx = 0;
let lastAy = 0;
let lastAz = 0;
let hasMotionReading = false;

// Calibration baseline (gravity vector projected into the screen plane).
// Captured at unlock AND on every orientation change, so neutral is always
// "however the user is holding the phone right now".
let calibAx = 0;
let calibAy = 0;
let calibrated = false;
let recalibrating = false;

const pedalPointers = {
  throttle: new Set<number>(),
  brake:    new Set<number>(),
};
function pedalDown(zone: 'throttle' | 'brake') {
  return pedalPointers[zone].size > 0;
}

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
// No orientation gating — CSS forces a landscape layout always, so the
// controller renders the same panel set whichever way the phone is held.
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
//  Steering math.
//
//  We compute the angle the device has rolled around its screen-perpendicular
//  axis (device Z), relative to the calibration baseline. This is the
//  natural "steering wheel" motion regardless of which way the phone is
//  oriented — the player rolls the device clockwise/counterclockwise.
//
//  How: accelerationIncludingGravity gives the gravity vector in the
//  device's own frame. The component in the screen plane is (ax, ay).
//  A roll around device Z rotates this 2D vector. The signed angle
//  between baseline (calibAx, calibAy) and current (lastAx, lastAy):
//
//      cross = calibAx * lastAy − calibAy * lastAx
//      dot   = calibAx * lastAx + calibAy * lastAy
//      tilt  = atan2(cross, dot)
//
//  The sign falls out naturally:
//    • Real landscape-primary  (gx0 > 0, gy0 ≈ 0):
//        tilt right → gy goes positive → cross > 0 → tilt > 0
//    • Real landscape-secondary (gx0 < 0, gy0 ≈ 0):
//        tilt right → gy goes negative → cross > 0 (gx0 was negative)
//        → tilt > 0
//    • Forced-rotated portrait  (gx0 ≈ 0, gy0 ≈ -g):
//        tilt right (wheel-rotation around device Z) → gx goes positive
//        → cross = gx0*lastAy − gy0*lastAx ≈ 0 − (−g)(gx>0) > 0 → tilt > 0
//
//  So "tilt right = positive steer" holds in every orientation, with no
//  orientation-API consultation needed. Beautiful.
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

// Best-effort label for how the phone is being held — purely for debug.
function physicalMode(): string {
  const mag = Math.hypot(lastAx, lastAy);
  if (mag < FLAT_THRESHOLD) return 'flat';
  if (Math.abs(lastAx) > Math.abs(lastAy)) {
    return lastAx > 0 ? 'land-L' : 'land-R';
  }
  return lastAy < 0 ? 'portrait' : 'port-down';
}

function updateDebug() {
  if (!debugEl) return;
  const so = (screen as unknown as { orientation?: { angle?: number; type?: string } }).orientation;
  const wo = (window as unknown as { orientation?: number }).orientation;
  const visualLandscape = landscapeMQ.matches;
  const forced = !visualLandscape; // we're applying CSS rotation
  const tilt = steeringTiltDeg();
  const steer = steerFromTilt();
  debugEl.textContent =
    `stage=${stage} perm=${permState} cal=${calibrated ? 'yes' : 'no'}${recalibrating ? ' RE' : ''}\n` +
    `view=${visualLandscape ? 'real-L' : 'force-L (rotated)'} ` +
    `phys=${physicalMode()} angle=so${so?.angle ?? 'n/a'}/wo${wo ?? 'n/a'}\n` +
    `ax=${lastAx.toFixed(1)} ay=${lastAy.toFixed(1)} az=${lastAz.toFixed(1)}\n` +
    `calAx=${calibAx.toFixed(1)} calAy=${calibAy.toFixed(1)}\n` +
    `beta=${lastBeta.toFixed(0)} gamma=${lastGamma.toFixed(0)}\n` +
    `tilt=${tilt.toFixed(1)}° steer=${steer.toFixed(2)} ` +
    `t=${pedalDown('throttle') ? 1 : 0} b=${pedalDown('brake') ? 1 : 0}`;
  void forced; // (already encoded in `view=`)
}

// ---------- Orientation watchers ----------
// matchMedia drives the CSS rotation, and we re-calibrate whenever the
// device flips between portrait and landscape so the player's new neutral
// hold becomes the new zero.
if (typeof landscapeMQ.addEventListener === 'function') {
  landscapeMQ.addEventListener('change', () => {
    renderUI();
    if (stage === 'after-unlock') {
      // Let the sensors settle for a moment before resampling.
      setTimeout(() => { void calibrate(); }, 250);
    }
  });
} else {
  (landscapeMQ as unknown as { addListener: (cb: () => void) => void }).addListener(renderUI);
}
window.addEventListener('resize', renderUI);
window.addEventListener('orientationchange', () => {
  renderUI();
  setTimeout(renderUI, 200);
  setTimeout(renderUI, 600);
  if (stage === 'after-unlock') {
    setTimeout(() => { void calibrate(); }, 400);
  }
});

// ---------- Unlock + permission ----------
unlockBtn.addEventListener('click', async () => {
  try {
    // iOS Safari: DeviceOrientationEvent.requestPermission() must be called
    // from a user gesture. DeviceMotionEvent may also have its own. We try
    // both; either granted is fine.
    const win = window as unknown as {
      DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
      DeviceMotionEvent?:      { requestPermission?: () => Promise<string> };
    };

    let needAny = false;
    if (typeof win.DeviceOrientationEvent?.requestPermission === 'function') {
      needAny = true;
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
      needAny = true;
      try {
        const r = await win.DeviceMotionEvent.requestPermission();
        if (r !== 'granted') {
          permState = 'denied';
          errorMsg = 'Motion permission denied (motion). Reload and tap again.';
          stage = 'error';
          renderUI();
          return;
        }
      } catch { /* some iOS versions bundle this with the orientation grant */ }
    }
    permState = needAny ? 'granted' : 'not-required';

    stage = 'after-unlock';
    attachSensorListeners();
    attachPedalListeners();
    startBroadcast();
    renderUI();
    void calibrate();
  } catch (err) {
    errorMsg = 'Could not enable motion: ' + (err as Error).message;
    stage = 'error';
    renderUI();
  }
});

// ---------- Sensor listeners ----------
function attachSensorListeners() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta  != null) lastBeta  = e.beta;
    if (e.gamma != null) lastGamma = e.gamma;
    if (e.beta != null || e.gamma != null) hasOrientationReading = true;
  });
  window.addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    if (a.x != null) lastAx = a.x;
    if (a.y != null) lastAy = a.y;
    if (a.z != null) lastAz = a.z;
    hasMotionReading = true;
  });
  // hasOrientationReading is unused in the steering math but useful for
  // diagnosing why a phone hasn't started reporting — keep referenced.
  void hasOrientationReading;
}

// ---------- Calibration ----------
// Capture the player's natural hold as steer=0 by averaging the first
// burst of motion samples. Re-runs on every orientation flip so neutral
// always matches the current hold.
async function calibrate() {
  recalibrating = true;

  // Wait for first sample (iOS can stall the first event 50-150ms).
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

// ---------- Pedals (multi-touch) ----------
function attachPedalListeners() {
  bindPedal(throttleBtn, 'throttle');
  bindPedal(brakeBtn,    'brake');
}

function bindPedal(el: HTMLElement, zone: 'throttle' | 'brake') {
  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    pedalPointers[zone].add(e.pointerId);
    el.classList.add('active');
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onUp = (e: PointerEvent) => {
    pedalPointers[zone].delete(e.pointerId);
    if (pedalPointers[zone].size === 0) el.classList.remove('active');
  };
  el.addEventListener('pointerdown',   onDown);
  el.addEventListener('pointerup',     onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave',  onUp);
  el.addEventListener('contextmenu',   (e) => e.preventDefault());
}

// ---------- Broadcast ----------
function startBroadcast() {
  const INTERVAL_MS = 1000 / SEND_HZ;
  setInterval(() => {
    const payload = {
      steer:    steerFromTilt(),
      throttle: pedalDown('throttle') ? 1 : 0,
      brake:    pedalDown('brake')    ? 1 : 0,
    };
    channel.send({ type: 'broadcast', event: 'control', payload });
  }, INTERVAL_MS);
}

// ---------- Debug polling ----------
setInterval(updateDebug, 250);

// ---------- Initial render ----------
renderUI();
