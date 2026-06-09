import { supabase, channelName } from './supabase';

// ---------- Tuning (phone side) ----------
const TILT_SENSITIVITY = 35; // deg of tilt from neutral that maps to full ±1
const TILT_DEADZONE    = 3;  // deg ignored around neutral
const SEND_HZ          = 30;
// Clamp baseline capture so even a wildly tilted starting hold still leaves
// enough headroom on each side to actually steer.
const CALIBRATION_CLAMP_DEG = 25;

// ---------- DOM ----------
const params = new URLSearchParams(window.location.search);
const code = (params.get('s') || '').toUpperCase();

const unlockBtn   = document.getElementById('unlock')         as HTMLButtonElement;
const pedalsEl    = document.getElementById('pedals')         as HTMLDivElement;
const brakeBtn    = document.getElementById('pedal-brake')    as HTMLButtonElement;
const throttleBtn = document.getElementById('pedal-throttle') as HTMLButtonElement;
const rotateHint  = document.getElementById('rotate-hint')    as HTMLDivElement;
const errorEl     = document.getElementById('error')          as HTMLDivElement;
const debugEl     = document.getElementById('debug')          as HTMLDivElement | null;

// ---------- State machine ----------
type Stage = 'before-unlock' | 'after-unlock' | 'error';
let stage: Stage = 'before-unlock';
let errorMsg = '';
let permState: 'unknown' | 'granted' | 'denied' | 'not-required' = 'unknown';

// ---------- Orientation ----------
const landscapeMQ = window.matchMedia('(orientation: landscape)');
function isLandscape(): boolean {
  return landscapeMQ.matches;
}
function currentAngle(): number {
  const so = (screen as unknown as { orientation?: { angle?: number } }).orientation;
  if (typeof so?.angle === 'number') return so.angle;
  const wo = (window as unknown as { orientation?: number }).orientation;
  if (typeof wo === 'number') return wo;
  return 0;
}

// ---------- Sensor state ----------
let lastBeta  = 0;
let lastGamma = 0;
let hasReading = false;

// Baseline captured from the user's natural hold at calibration time. We
// subtract this from raw sensor values so neutral hold == zero steer no
// matter which way the device thinks "0" is.
let calibrationBeta  = 0;
let calibrationGamma = 0;
let calibrated = false;

// ---------- Pedal input ----------
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
function renderUI() {
  unlockBtn.hidden  = true;
  pedalsEl.hidden   = true;
  rotateHint.hidden = true;
  errorEl.hidden    = true;

  if (stage === 'error') {
    errorEl.hidden = false;
    errorEl.textContent = errorMsg;
  } else if (!isLandscape()) {
    rotateHint.hidden = false;
  } else if (stage === 'before-unlock') {
    unlockBtn.hidden = false;
  } else {
    pedalsEl.hidden = false;
  }

  updateDebug();
}

// Compute axis + sign decision in one place so debug + steerFromTilt agree.
// Returns the centered (post-calibration), sign-corrected tilt in DEGREES.
// Positive == "steer right" by definition; sign mapping handled here.
function readTilt(): { axis: 'beta' | 'gamma'; signed: number; angle: number } {
  const angle = currentAngle();

  // -------- LANDSCAPE (the play orientation) --------
  // In landscape the device's long axis is horizontal, so gamma is pinned
  // near ±90 even when the screen is upright — useless as steering input.
  // The steering motion (roll the phone like a wheel) shows up on `beta`.
  //
  // Sign confirmed empirically on iOS Safari:
  //   landscape-primary  (angle 90):  tilting right edge of screen DOWN
  //                                   moves beta POSITIVE relative to the
  //                                   captured baseline. Use as-is.
  //   landscape-secondary(angle -90/270): mirrored — same physical motion
  //                                       moves beta NEGATIVE. Flip sign.
  if (angle === 90) {
    const centered = lastBeta - calibrationBeta;
    return { axis: 'beta', signed: +centered, angle };
  }
  if (angle === 270 || angle === -90) {
    const centered = lastBeta - calibrationBeta;
    return { axis: 'beta', signed: -centered, angle };
  }

  // -------- PORTRAIT (only reached if orientation flips during play) --------
  // gamma+ = tilt right edge of screen down in portrait. Upside-down portrait
  // inverts the sign.
  const centered = lastGamma - calibrationGamma;
  if (angle === 180) {
    return { axis: 'gamma', signed: -centered, angle };
  }
  return { axis: 'gamma', signed: +centered, angle };
}

function steerFromTilt(): number {
  if (!hasReading) return 0;
  const { signed } = readTilt();
  const sign = Math.sign(signed);
  const mag = Math.max(0, Math.abs(signed) - TILT_DEADZONE);
  const norm = Math.min(1, mag / (TILT_SENSITIVITY - TILT_DEADZONE));
  return sign * norm;
}

function updateDebug() {
  if (!debugEl) return;
  const so = (screen as unknown as { orientation?: { angle?: number; type?: string } }).orientation;
  const wo = (window as unknown as { orientation?: number }).orientation;
  const land = isLandscape();
  const t = readTilt();
  const steer = hasReading ? steerFromTilt() : 0;
  debugEl.textContent =
    `stage=${stage} perm=${permState} cal=${calibrated ? 'yes' : 'no'}\n` +
    `land=${land} angle=${t.angle} (so=${so?.angle ?? 'n/a'} wo=${wo ?? 'n/a'} type=${so?.type ?? 'n/a'})\n` +
    `beta=${lastBeta.toFixed(1)}  gamma=${lastGamma.toFixed(1)}\n` +
    `calB=${calibrationBeta.toFixed(1)}  calG=${calibrationGamma.toFixed(1)}\n` +
    `axis=${t.axis}  signed=${t.signed.toFixed(1)}  steer=${steer.toFixed(2)}\n` +
    `t=${pedalDown('throttle') ? 1 : 0}  b=${pedalDown('brake') ? 1 : 0}`;
}

// ---------- Orientation listeners ----------
if (typeof landscapeMQ.addEventListener === 'function') {
  landscapeMQ.addEventListener('change', renderUI);
} else {
  (landscapeMQ as unknown as { addListener: (cb: () => void) => void }).addListener(renderUI);
}
window.addEventListener('resize', renderUI);
window.addEventListener('orientationchange', () => {
  renderUI();
  setTimeout(renderUI, 200);
  setTimeout(renderUI, 600);
});

// ---------- Unlock ----------
unlockBtn.addEventListener('click', async () => {
  try {
    const DOE = (window as unknown as {
      DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
    }).DeviceOrientationEvent;

    if (DOE && typeof DOE.requestPermission === 'function') {
      const result = await DOE.requestPermission();
      permState = result === 'granted' ? 'granted' : 'denied';
      if (result !== 'granted') {
        errorMsg = 'Motion permission denied. Reload the page and tap again.';
        stage = 'error';
        renderUI();
        return;
      }
    } else {
      permState = 'not-required';
    }

    stage = 'after-unlock';
    attachTiltListener();
    attachPedalListeners();
    startBroadcast();
    renderUI();

    // Calibration runs after listeners are wired and a few sensor samples
    // have landed. Async so we don't block the UI.
    void calibrate();
  } catch (err) {
    errorMsg = 'Could not enable motion: ' + (err as Error).message;
    stage = 'error';
    renderUI();
  }
});

// ---------- Tilt listener ----------
function attachTiltListener() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta == null && e.gamma == null) return;
    if (e.beta  != null) lastBeta  = e.beta;
    if (e.gamma != null) lastGamma = e.gamma;
    hasReading = true;
  });
}

// ---------- Auto-calibration ----------
// Capture the user's natural hold as the steering zero. Averages a short
// burst of samples for stability, then clamps so a wild starting position
// can't put neutral past the sensitivity range (which would leave the car
// permanently stuck steering one way).
async function calibrate() {
  const samples: Array<{ b: number; g: number }> = [];
  const SAMPLE_COUNT = 8;
  const SAMPLE_GAP_MS = 40;

  // Wait for the first reading to land before starting (iOS sometimes
  // delays the first deviceorientation event by 50-150ms).
  const start = performance.now();
  while (!hasReading && performance.now() - start < 700) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // Burst-sample. If we never get a reading we leave calibration at 0.
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS));
    if (!hasReading) continue;
    samples.push({ b: lastBeta, g: lastGamma });
  }
  if (samples.length === 0) {
    calibrated = true; // still mark, with 0 baselines
    return;
  }

  const avgB = samples.reduce((s, x) => s + x.b, 0) / samples.length;
  const avgG = samples.reduce((s, x) => s + x.g, 0) / samples.length;

  calibrationBeta  = clamp(avgB, -CALIBRATION_CLAMP_DEG, CALIBRATION_CLAMP_DEG);
  calibrationGamma = clamp(avgG, -CALIBRATION_CLAMP_DEG, CALIBRATION_CLAMP_DEG);
  calibrated = true;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
// IMPORTANT: gate input on landscape. If the user rotates to portrait mid-game
// we DON'T want to ship a steer value computed from gamma against a beta
// calibration (or vice versa) — that produced phantom steering. Send neutral
// while portrait so the desktop car coasts.
function startBroadcast() {
  const INTERVAL_MS = 1000 / SEND_HZ;
  setInterval(() => {
    const payload = isLandscape()
      ? {
          steer:    steerFromTilt(),
          throttle: pedalDown('throttle') ? 1 : 0,
          brake:    pedalDown('brake')    ? 1 : 0,
        }
      : { steer: 0, throttle: 0, brake: 0 };
    channel.send({ type: 'broadcast', event: 'control', payload });
  }, INTERVAL_MS);
}

// ---------- Error UI ----------
// (No standalone helper; we set errorMsg + stage and let renderUI() decide.)

// ---------- Debug polling ----------
setInterval(updateDebug, 250);

// ---------- Initial render ----------
renderUI();
