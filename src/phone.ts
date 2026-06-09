import { supabase, channelName } from './supabase';

// ---------- Tuning (phone side) ----------
const TILT_SENSITIVITY = 35; // deg of tilt that maps to full ±1
const TILT_DEADZONE    = 3;  // deg ignored around level
const SEND_HZ          = 30;

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
// Single source of truth. Whatever changes (orientation, permission, error),
// we run renderUI() and it decides which panel is visible. Anything else
// (a stale "hide the rotate hint after we already rendered the pedals" code
// path) is what bit us on iOS — keep it strict.
type Stage = 'before-unlock' | 'after-unlock' | 'error';
let stage: Stage = 'before-unlock';
let errorMsg = '';
let permState: 'unknown' | 'granted' | 'denied' | 'not-required' = 'unknown';

// ---------- Orientation ----------
// matchMedia is the most reliable orientation signal on iOS Safari.
// `screen.orientation` is missing in older iOS; `window.innerWidth > height`
// is flaky during the rotation animation. matchMedia fires `change` AFTER
// the viewport actually reflowed.
const landscapeMQ = window.matchMedia('(orientation: landscape)');
function isLandscape(): boolean {
  return landscapeMQ.matches;
}

// ---------- Tilt + pedal input state ----------
let latestGamma = 0;
let hasReading = false;
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

// ---------- The renderer ----------
function renderUI() {
  // Reset every panel first — never leave a stale panel visible.
  unlockBtn.hidden = true;
  pedalsEl.hidden  = true;
  rotateHint.hidden = true;
  errorEl.hidden   = true;

  if (stage === 'error') {
    errorEl.hidden = false;
    errorEl.textContent = errorMsg;
  } else if (!isLandscape()) {
    // Portrait at ANY stage = rotate hint. (Pedal physics needs landscape.)
    rotateHint.hidden = false;
  } else if (stage === 'before-unlock') {
    unlockBtn.hidden = false;
  } else {
    pedalsEl.hidden = false;
  }

  updateDebug();
}

function updateDebug() {
  if (!debugEl) return;
  const so = (screen as unknown as { orientation?: { angle?: number; type?: string } }).orientation;
  const wo = (window as unknown as { orientation?: number }).orientation;
  debugEl.textContent =
    `stage=${stage} perm=${permState}\n` +
    `land=${isLandscape()} mq=${landscapeMQ.matches} ` +
    `angle=${so?.angle ?? 'n/a'} type=${so?.type ?? 'n/a'} wo=${wo ?? 'n/a'}\n` +
    `view=${window.innerWidth}x${window.innerHeight} ` +
    `gamma=${hasReading ? latestGamma.toFixed(1) : 'no-reading'} ` +
    `t=${pedalDown('throttle') ? 1 : 0} b=${pedalDown('brake') ? 1 : 0}`;
}

// ---------- Orientation listeners (belt + braces for iOS) ----------
// matchMedia is the primary signal. The others are safety nets — iOS Safari
// has fired `orientationchange` before the viewport reflowed in some
// versions, so we re-render after a couple of delays to catch up.
if (typeof landscapeMQ.addEventListener === 'function') {
  landscapeMQ.addEventListener('change', renderUI);
} else {
  // Older Safari fallback.
  (landscapeMQ as unknown as { addListener: (cb: () => void) => void }).addListener(renderUI);
}
window.addEventListener('resize', renderUI);
window.addEventListener('orientationchange', () => {
  renderUI();
  setTimeout(renderUI, 200);
  setTimeout(renderUI, 600);
});

// ---------- Unlock click (REQUIRED user gesture for iOS) ----------
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
  } catch (err) {
    errorMsg = 'Could not enable motion: ' + (err as Error).message;
    stage = 'error';
    renderUI();
  }
});

// ---------- Tilt ----------
function attachTiltListener() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null) return;
    latestGamma = e.gamma;
    hasReading = true;
  });
}

function steerFromTilt(): number {
  if (!hasReading) return 0;

  // Sign correction for which way the phone is rotated into landscape.
  // - angle 0   (portrait):       gamma+ = tilt right → steer right (direct)
  // - angle 90  (landscape, top-of-phone faces RIGHT in world):
  //     user's "tilt right" comes in as gamma-, so we flip.
  // - angle -90/270 (landscape, top-of-phone faces LEFT in world):
  //     user's "tilt right" comes in as gamma+, direct.
  // - angle 180 (portrait upside-down): flip.
  const so = (screen as unknown as { orientation?: { angle?: number } }).orientation;
  const wo = (window as unknown as { orientation?: number }).orientation;
  const angle = typeof so?.angle === 'number'
    ? so.angle
    : (typeof wo === 'number' ? wo : 0);

  let g = latestGamma;
  if (angle === 90)  g = -g;
  if (angle === 180) g = -g;

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
  el.addEventListener('contextmenu',   (e) => e.preventDefault());
}

// ---------- Broadcast loop ----------
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

// ---------- Light debug polling ----------
// updateDebug() is also called inside renderUI(), but during normal driving
// nothing triggers renderUI(). Tick the debug strip a few times a second so
// gamma + pedal values stay live.
setInterval(updateDebug, 250);

// ---------- Initial render ----------
renderUI();
