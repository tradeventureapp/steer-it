import { supabase, channelName } from './supabase';

// ---------- Tuning (phone side) ----------
// Tilt sensitivity here mirrors the desktop CONFIG; we normalize to [-1, 1]
// here so the wire payload stays platform-independent.
const TILT_SENSITIVITY = 35; // deg of tilt that maps to full ±1
const TILT_DEADZONE    = 3;  // deg ignored around level
const SEND_HZ          = 30;

// ---------- DOM ----------
const params = new URLSearchParams(window.location.search);
const code = (params.get('s') || '').toUpperCase();

const unlockBtn   = document.getElementById('unlock')        as HTMLButtonElement;
const pedalsEl    = document.getElementById('pedals')        as HTMLDivElement;
const brakeBtn    = document.getElementById('pedal-brake')   as HTMLButtonElement;
const throttleBtn = document.getElementById('pedal-throttle') as HTMLButtonElement;
const rotateHint  = document.getElementById('rotate-hint')   as HTMLDivElement;
const errorEl     = document.getElementById('error')         as HTMLDivElement;

if (!code) {
  showError('No session code in URL. Scan the QR on the desktop screen.');
}

// ---------- Channel ----------
const channel = supabase.channel(channelName(code), {
  config: { broadcast: { self: false } },
});
channel.subscribe();

// ---------- State ----------
let latestGamma = 0;
let hasReading = false;
let unlocked = false;

const pedalPointers = {
  throttle: new Set<number>(),
  brake:    new Set<number>(),
};
function pedalDown(zone: 'throttle' | 'brake') {
  return pedalPointers[zone].size > 0;
}

// ---------- Unlock flow ----------
unlockBtn.addEventListener('click', async () => {
  try {
    const DOE = (window as unknown as {
      DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
    }).DeviceOrientationEvent;

    if (DOE && typeof DOE.requestPermission === 'function') {
      const result = await DOE.requestPermission();
      if (result !== 'granted') {
        showError('Motion permission denied. Reload and tap again.');
        return;
      }
    }
    enterPedalMode();
  } catch (err) {
    showError('Could not enable motion: ' + (err as Error).message);
  }
});

function enterPedalMode() {
  unlocked = true;
  unlockBtn.hidden = true;
  pedalsEl.hidden = false;
  updateOrientationHint();
  attachPedalListeners();
  attachTiltListener();
  startBroadcast();
}

// ---------- Orientation handling ----------
function isLandscape(): boolean {
  const so = (screen as any).orientation;
  if (so && typeof so.type === 'string') return so.type.startsWith('landscape');
  if (typeof (window as any).orientation === 'number') {
    return Math.abs((window as any).orientation) === 90;
  }
  return window.innerWidth > window.innerHeight;
}

function updateOrientationHint() {
  if (!unlocked) return;
  if (isLandscape()) {
    rotateHint.hidden = true;
    pedalsEl.hidden = false;
  } else {
    rotateHint.hidden = false;
    pedalsEl.hidden = true;
  }
}
window.addEventListener('resize', updateOrientationHint);
window.addEventListener('orientationchange', updateOrientationHint);

// ---------- Tilt ----------
// We use gamma as requested by the spec. Sign is corrected per current
// screen orientation so "tilt the visible right edge down" always means
// "steer right" no matter which landscape direction the phone is held.
function attachTiltListener() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null) return;
    latestGamma = e.gamma;
    hasReading = true;
  });
}

function steerFromTilt(): number {
  if (!hasReading) return 0;

  // Orientation-aware sign. In portrait, gamma+ = tilt right = steer right.
  // When the phone is rotated 90° clockwise (top of phone faces LEFT,
  // screen.orientation.angle === -90 or 270), the user's "tilt right" still
  // looks like gamma+ to the device, so we keep the sign.
  // When rotated 90° counterclockwise (top of phone faces RIGHT,
  // screen.orientation.angle === 90), the user's "tilt right" comes through
  // as gamma−, so we flip.
  const so = (screen as any).orientation;
  const angle = typeof so?.angle === 'number'
    ? so.angle
    : (typeof (window as any).orientation === 'number' ? (window as any).orientation : 0);

  let g = latestGamma;
  if (angle === 90) g = -g;
  else if (angle === 180) g = -g;

  // Deadzone + linear ramp to ±1 at TILT_SENSITIVITY degrees.
  const sign = Math.sign(g);
  const mag = Math.max(0, Math.abs(g) - TILT_DEADZONE);
  const norm = Math.min(1, mag / (TILT_SENSITIVITY - TILT_DEADZONE));
  return sign * norm;
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
  // Block iOS double-tap zoom / long-press menus.
  el.addEventListener('contextmenu',   (e) => e.preventDefault());
}

// ---------- Broadcast loop ----------
function startBroadcast() {
  const INTERVAL_MS = 1000 / SEND_HZ;
  setInterval(() => {
    const payload = {
      steer: steerFromTilt(),
      throttle: pedalDown('throttle') ? 1 : 0,
      brake:    pedalDown('brake')    ? 1 : 0,
    };
    channel.send({ type: 'broadcast', event: 'control', payload });
  }, INTERVAL_MS);
}

// ---------- Error UI ----------
function showError(msg: string) {
  errorEl.hidden = false;
  errorEl.textContent = msg;
  unlockBtn.hidden = true;
  pedalsEl.hidden = true;
  rotateHint.hidden = true;
}
