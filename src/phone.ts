import type { RealtimeChannel } from '@supabase/supabase-js';
import { channelName, createResilientChannel } from './supabase';
import {
  getClientId, CAR_COLORS, EV, PHONE_HEARTBEAT_MS, sanitizeName,
  type LobbyPlayer,
} from './lobby';
import { inject } from '@vercel/analytics';

// Vercel Web Analytics — framework-agnostic vanilla init (NOT the React
// <Analytics/> component). Injects the tracking script for the phone controller
// page (play.html) so phone joins are counted too.
inject();

// ---------- Tuning ----------
// Steering response (PHONE INPUT MAPPING ONLY — nothing downstream changes;
// maxSteerAngle, the front-slip limiter, and countersteer all live in the
// physics and are untouched).
// THE tilt-sensitivity knob: the physical tilt (deg, after the deadzone) that
// maps to FULL steering lock. RAISE it to make the player tilt MORE for full
// lock (less sensitive), LOWER it for a flick-ier wheel. The map is a pure
// LINEAR scale of this range (steer = clamp(tilt/this)), so half the range =
// half steer, etc. — uniform, no easing. Was 35° (too sensitive — a small tilt
// hit full lock); 55° stretches it so full lock needs a noticeably larger tilt.
const TILT_RANGE_DEG = 55;   // ← tune by feel: higher = must tilt more for full lock
const TILT_DEADZONE_DEG = 3;  // deg ignored around level
// Response curve exponent: steer = sign(t)·|t|^STEER_EXPO. 1.0 = perfectly
// LINEAR (steer grows evenly/proportionally with tilt — half tilt = half steer).
// (Was 1.7, a gentle-near-center curve that ramped up to full lock; removed per
// the linear-steering request so the response is uniform across the whole range.)
const STEER_EXPO = 1.0;
// Global steer sign. Steering is the gravity component along the device's long
// (left-right) axis, whose sign depends on which way the player turned the phone
// into landscape, so ONE constant flips left/right for the whole app if a real
// device reads mirrored. +1 = roll right → +steer, roll left → −steer.
const STEER_SIGN = 1;
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
const lobbySlotEl   = document.getElementById('lobby-slot')   as HTMLDivElement | null;
const lobbyColorsEl = document.getElementById('lobby-colors') as HTMLDivElement | null;
const lobbyNameEl   = document.getElementById('lobby-name')   as HTMLInputElement | null;

// ---------- Lobby (this phone's slot + colour + name) ----------
const clientId = getClientId();
let mySlot: number | null = null;     // assigned by the desktop authority
let selectedColor = '';                // '' until picked / adopted from server
let selectedName = '';                 // '' → desktop shows "PLAYER n"
let lobbyFull = false;

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

// (No steering baseline/neutral snapshot anymore. Steering is a pitch-invariant
// roll angle measured directly from gravity — see steeringRollDeg — so it needs
// no per-user calibration and never depends on how the phone was held earlier.)

// Current physical orientation (from smoothed gravity) — used ONLY for the
// debug readout now. The force-landscape rotation is pure CSS (see below).
type Phys = 'L-pri' | 'L-sec' | 'portrait' | 'port-down' | 'flat';
let currentPhys: Phys = 'flat';

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
// ---------- Lobby messaging (desktop is the authority) ----------
// We never self-assign a slot — we announce ourselves (join, doubling as a
// keepalive heartbeat) and adopt whatever slot/colour the desktop broadcasts.
// All sends go through the resilient channel `rc` (no-op while reconnecting,
// resumes automatically — the heartbeat re-announces us by id so the desktop
// reclaims our slot WITHOUT a QR rescan).
function sendJoin() {
  rc.send({
    type: 'broadcast', event: EV.join,
    payload: {
      id: clientId,
      color: selectedColor || undefined,
      name: selectedName || undefined,
    },
  });
}
function sendName() {
  rc.send({ type: 'broadcast', event: EV.name, payload: { id: clientId, name: selectedName } });
}
function sendLeave() {
  try {
    rc.send({ type: 'broadcast', event: EV.leave, payload: { id: clientId } });
  } catch { /* best-effort */ }
}

let lobbyStarted = false;
function startLobby() {
  if (lobbyStarted || !code) return;
  lobbyStarted = true;
  sendJoin();
  setInterval(sendJoin, PHONE_HEARTBEAT_MS);
}

// Desktop → phone handlers (re-attached to every (re)created channel).
function wirePhone(ch: RealtimeChannel) {
  ch.on('broadcast', { event: EV.lobby }, ({ payload }) => {
    const list = ((payload as { players?: LobbyPlayer[] })?.players ?? []) as LobbyPlayer[];
    const me = list.find((p) => p.id === clientId);
    if (me) {
      lobbyFull = false;
      mySlot = me.slot;
      if (!selectedColor) { selectedColor = me.color; highlightSwatch(); }
      // Adopt a server-side name we haven't locally typed (restores on reclaim).
      if (!selectedName && me.name) {
        selectedName = me.name;
        if (lobbyNameEl && document.activeElement !== lobbyNameEl) lobbyNameEl.value = me.name;
      }
    }
    renderLobby();
  });
  ch.on('broadcast', { event: EV.full }, ({ payload }) => {
    if ((payload as { id?: string })?.id === clientId && mySlot === null) {
      lobbyFull = true;
      renderLobby();
    }
  });
}

// Resilient channel: reconnects after a blip so input resumes without a rescan.
const rc = createResilientChannel(
  channelName(code), { broadcast: { self: false } }, wirePhone,
  {
    label: 'phone',
    onReady: () => { startLobby(); sendJoin(); },  // re-announce on every (re)connect
  },
);
window.addEventListener('pagehide', sendLeave);

// ---------- Colour picker (on the TAP TO STEER screen) ----------
function buildColorPicker() {
  if (!lobbyColorsEl || lobbyColorsEl.childElementCount > 0) return;
  for (const c of CAR_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.hex = c.hex;
    b.style.setProperty('--sw', c.hex);
    b.setAttribute('aria-label', c.name);
    b.addEventListener('click', (e) => { e.preventDefault(); pickColor(c.hex); });
    lobbyColorsEl.appendChild(b);
  }
}
function pickColor(hex: string) {
  selectedColor = hex;
  highlightSwatch();
  // Immediate colour message + refresh the join payload so it sticks.
  rc.send({ type: 'broadcast', event: EV.color, payload: { id: clientId, color: hex } });
  sendJoin();
}
function highlightSwatch() {
  if (!lobbyColorsEl) return;
  for (const el of Array.from(lobbyColorsEl.children) as HTMLElement[]) {
    el.classList.toggle('selected', el.dataset.hex === selectedColor);
  }
}
function renderLobby() {
  if (lobbySlotEl) {
    lobbySlotEl.textContent = lobbyFull ? 'GAME FULL'
      : mySlot === null ? 'JOINING…'
      : 'PLAYER ' + (mySlot + 1);
    lobbySlotEl.classList.toggle('full', lobbyFull);
  }
  // Placeholder mirrors the default slot label so the field reads "PLAYER n".
  if (lobbyNameEl) {
    lobbyNameEl.placeholder = mySlot === null ? 'YOUR NAME' : 'PLAYER ' + (mySlot + 1);
  }
}

// ---------- Name input ----------
if (lobbyNameEl) {
  const onName = () => {
    const clean = sanitizeName(lobbyNameEl.value);
    if (clean === selectedName) return;
    selectedName = clean;
    sendName();   // immediate; the join heartbeat also carries it
  };
  lobbyNameEl.addEventListener('input', onName);
  lobbyNameEl.addEventListener('change', onName);
  // Tapping the field must not bubble to the unlock button behind it.
  lobbyNameEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  lobbyNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') lobbyNameEl.blur();
  });
}

buildColorPicker();

// ---------- Render ----------
function renderUI() {
  unlockBtn.hidden = true;
  pedalsEl.hidden  = true;
  errorEl.hidden   = true;

  // The slot label + colour picker live on the TAP TO STEER screen only.
  const showLobby = stage === 'before-unlock';
  if (lobbySlotEl)   lobbySlotEl.hidden   = !showLobby;
  if (lobbyColorsEl) lobbyColorsEl.hidden = !showLobby;
  if (lobbyNameEl)   lobbyNameEl.hidden   = !showLobby;

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
// The force-landscape rotation is now PURE CSS — a `@media (orientation: portrait)`
// rule sets `--rot` (see style.css). That is gravity- and permission-INDEPENDENT
// and viewport-driven, so the controller is ALWAYS landscape (or rotated to
// prompt a turn) and NEVER a broken portrait layout. The old JS mapping returned
// 0° for the physically-portrait case (leaving the landscape-sized stage
// overflowing → the reported bug) and also did nothing without motion
// permission. Here we only keep the gravity-derived orientation for the debug
// readout; it no longer touches the layout.
function applyTransform() {
  if (!hasMotionReading) return;
  currentPhys = classifyOrientation(smoothedAx, smoothedAy, currentPhys);
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
//  Steering — PITCH-INVARIANT left/right ROLL angle (degrees).
//
//  The steering axis is the device's LONG axis (device Y = the screen's
//  horizontal / left-right axis in the landscape hold). `lastAy` is the gravity
//  component along that axis: it is 0 when the phone is level (no roll) and
//  grows toward ±g as you roll it like a steering wheel.
//
//  Crucially it is INVARIANT TO PITCH: tilting the phone toward/away from you
//  is a rotation ABOUT this same long axis, and a rotation about an axis cannot
//  change that axis's own gravity component. So pure pitch leaves `ay` (and thus
//  steer) at its current value — pitch contributes ZERO steering. Only true
//  left/right roll moves `ay`. asin(ay / |g|) turns it into a real roll angle,
//  symmetric about level, with NO baseline / no per-user neutral snapshot. The
//  full 3-axis magnitude normalises it so the value is a true angle regardless of
//  how far the phone is pitched (which only bleeds gravity into the Z axis).
// ----------------------------------------------------------------------
function steeringRollDeg(): number {
  if (!hasMotionReading) return 0;
  const g = Math.hypot(lastAx, lastAy, lastAz);
  if (g < 1) return 0;                                   // free-fall / no signal
  const ratio = Math.max(-1, Math.min(1, lastAy / g));   // sin(roll), clamped
  return Math.asin(ratio) * 180 / Math.PI;
}

function steerFromTilt(): number {
  const rollDeg = steeringRollDeg();
  const sign = Math.sign(rollDeg);
  // Small DEADZONE around level so a near-level hold doesn't creep and hand
  // jitter doesn't twitch the wheel; range + expo unchanged so the feel at
  // larger roll angles (and full lock) is exactly as before.
  const mag = Math.max(0, Math.abs(rollDeg) - TILT_DEADZONE_DEG);
  const norm = Math.min(1, mag / (TILT_RANGE_DEG - TILT_DEADZONE_DEG));
  return STEER_SIGN * sign * Math.pow(norm, STEER_EXPO);
}

// ----------------------------------------------------------------------
//  Debug strip
// ----------------------------------------------------------------------
function updateDebug() {
  if (!debugEl) return;
  const browserLandscape = window.innerWidth > window.innerHeight;
  // The applied rotation is now CSS-driven (the --rot var). Read it back so the
  // strip shows EXACTLY what the layout is using on the device.
  const cssRot = getComputedStyle(document.documentElement).getPropertyValue('--rot').trim() || '0deg';
  const roll = steeringRollDeg();
  const steer = steerFromTilt();
  debugEl.textContent =
    `stage=${stage} perm=${permState}\n` +
    `phys=${currentPhys}  viewport=${browserLandscape ? 'L' : 'P'}  rot=${cssRot}\n` +
    `ax=${lastAx.toFixed(1)} ay=${lastAy.toFixed(1)} az=${lastAz.toFixed(1)}  ` +
    `sm=(${smoothedAx.toFixed(1)},${smoothedAy.toFixed(1)})\n` +
    `beta=${lastBeta.toFixed(0)} gamma=${lastGamma.toFixed(0)}\n` +
    `roll=${roll.toFixed(1)}° steer=${steer.toFixed(2)}  ` +
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
    // No steering calibration needed: steer is a pitch-invariant roll angle read
    // directly from gravity (steeringRollDeg), level = 0 for everyone.
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
//  STUCK-INPUT SAFETY (p8): a missed pointerup left the pedal pinned at
//  its last value (stuck full throttle, twice in testing). Defenses:
//    - release on pointerup, pointercancel, pointerleave AND
//      lostpointercapture (any one zeroes that pointer's contribution;
//      with healthy pointer capture, pointerleave doesn't fire mid-press,
//      so sliding off the strip still clamps rather than cancels)
//    - visibilitychange/pagehide → zero ALL inputs immediately
//    - watchdog: a tracked pointer that hasn't been seen for >2 s and no
//      longer holds pointer capture is presumed dead and dropped
//    - every reset broadcasts a control message IMMEDIATELY rather than
//      waiting for the next 30 Hz tick
// ----------------------------------------------------------------------
function attachControlListeners() {
  bindAnalogPedal(throttleBtn, 'throttle');
  bindAnalogPedal(brakeBtn,    'brake');
  bindHandbrake(handbrakeBtn);

  // Zero everything the moment the page loses foreground — a backgrounded
  // tab will never see the finger lift.
  const zeroAll = () => resetAllControls('page hidden');
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') zeroAll();
  });
  window.addEventListener('pagehide', zeroAll);
  window.addEventListener('blur', zeroAll);

  // Watchdog for ghost pointers (pointerup that never arrived).
  setInterval(watchdogSweep, 500);
}

// Last time each tracked pointer was seen alive, per control.
const pointerLastSeen: Record<Zone | 'handbrake', Map<number, number>> = {
  throttle: new Map(), brake: new Map(), handbrake: new Map(),
};
const POINTER_STALE_MS = 2000;

function markSeen(zone: Zone | 'handbrake', pointerId: number) {
  pointerLastSeen[zone].set(pointerId, performance.now());
}

// Drop pointers that are stale AND no longer captured. A finger resting
// motionless on a pedal emits no events, but it keeps pointer capture —
// hasPointerCapture() refreshes its lease each sweep, so it's never
// falsely dropped. A ghost pointer has lost capture and goes quiet → cut.
function watchdogSweep() {
  const now = performance.now();
  let changed = false;

  const sweep = (
    el: HTMLElement, ids: Iterable<number>, zone: Zone | 'handbrake',
    drop: (pid: number) => void,
  ) => {
    for (const pid of [...ids]) {
      let captured = false;
      try { captured = el.hasPointerCapture(pid); } catch { /* ignore */ }
      if (captured) { markSeen(zone, pid); continue; }
      const seen = pointerLastSeen[zone].get(pid) ?? 0;
      if (now - seen > POINTER_STALE_MS) {
        drop(pid);
        pointerLastSeen[zone].delete(pid);
        changed = true;
      }
    }
  };

  sweep(throttleBtn, pedalValues.throttle.keys(), 'throttle',
    (pid) => pedalValues.throttle.delete(pid));
  sweep(brakeBtn, pedalValues.brake.keys(), 'brake',
    (pid) => pedalValues.brake.delete(pid));
  sweep(handbrakeBtn, handbrakePointers, 'handbrake',
    (pid) => handbrakePointers.delete(pid));

  if (changed) {
    refreshControlVisuals();
    sendControlNow();
  }
}

function resetAllControls(_reason: string) {
  pedalValues.throttle.clear();
  pedalValues.brake.clear();
  handbrakePointers.clear();
  pointerLastSeen.throttle.clear();
  pointerLastSeen.brake.clear();
  pointerLastSeen.handbrake.clear();
  refreshControlVisuals();
  sendControlNow();
}

function refreshControlVisuals() {
  updatePedalFill(throttleBtn, 'throttle');
  updatePedalFill(brakeBtn, 'brake');
  throttleBtn.classList.toggle('active', pedalValues.throttle.size > 0);
  brakeBtn.classList.toggle('active', pedalValues.brake.size > 0);
  handbrakeBtn.classList.toggle('active', handbrakePointers.size > 0);
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
    markSeen(zone, e.pointerId);
    el.classList.add('active');
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    updatePedalFill(el, zone);
  });
  el.addEventListener('pointermove', (e) => {
    if (!pedalValues[zone].has(e.pointerId)) return;
    const v = pedalValueFromEvent(e, el);
    pedalValues[zone].set(e.pointerId, v);
    markSeen(zone, e.pointerId);
    updatePedalFill(el, zone);
  });
  const release = (e: PointerEvent) => {
    if (!pedalValues[zone].has(e.pointerId)) return;
    pedalValues[zone].delete(e.pointerId);
    pointerLastSeen[zone].delete(e.pointerId);
    if (pedalValues[zone].size === 0) el.classList.remove('active');
    updatePedalFill(el, zone);
    sendControlNow();
  };
  el.addEventListener('pointerup',          release);
  el.addEventListener('pointercancel',      release);
  el.addEventListener('pointerleave',       release);
  el.addEventListener('lostpointercapture', release);
  el.addEventListener('contextmenu',        (e) => e.preventDefault());
}

function bindHandbrake(el: HTMLElement) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handbrakePointers.add(e.pointerId);
    markSeen('handbrake', e.pointerId);
    el.classList.add('active');
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  const release = (e: PointerEvent) => {
    if (!handbrakePointers.has(e.pointerId)) return;
    handbrakePointers.delete(e.pointerId);
    pointerLastSeen.handbrake.delete(e.pointerId);
    if (handbrakePointers.size === 0) el.classList.remove('active');
    sendControlNow();
  };
  el.addEventListener('pointerup',          release);
  el.addEventListener('pointercancel',      release);
  el.addEventListener('pointerleave',       release);
  el.addEventListener('lostpointercapture', release);
  el.addEventListener('contextmenu',        (e) => e.preventDefault());
}

// ----------------------------------------------------------------------
//  Broadcast
// ----------------------------------------------------------------------
let broadcastStarted = false;

function sendControlNow() {
  if (!broadcastStarted) return;
  const payload = {
    id:        clientId,
    slot:      mySlot ?? 0,
    steer:     steerFromTilt(),
    throttle:  pedalValue('throttle'),
    brake:     pedalValue('brake'),
    handbrake: handbrakeOn(),
  };
  rc.send({ type: 'broadcast', event: EV.control, payload });
}

function startBroadcast() {
  broadcastStarted = true;
  const INTERVAL_MS = 1000 / SEND_HZ;
  setInterval(sendControlNow, INTERVAL_MS);
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

// TEMPORARY debug toggle: a 3-finger tap shows/hides the orientation readout
// (hidden by default). 3 fingers so it never fires during 1–2-finger pedal play.
window.addEventListener('touchstart', (e) => {
  if (e.touches.length === 3) debugEl?.classList.toggle('on');
}, { passive: true });

// stageEl is referenced for future tweaks; the force-landscape rotation is
// handled purely in CSS now (the --rot custom property, set by a media query).
void stageEl;

// ---------- Initial render ----------
renderUI();
