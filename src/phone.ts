import type { RealtimeChannel } from '@supabase/supabase-js';
import { channelName, createResilientChannel } from './supabase';
import {
  connectPhoneRtc, fetchTurnServers, makePeerFactory, RTC_EV, RTC_ICE_SERVERS,
  peerConnectionCtor, rtcSupportReport,
  type PhoneRtc, type StateMsg,
} from './rtc';
import {
  getClientId, paletteForMode, EV, PHONE_HEARTBEAT_MS, sanitizeName,
  quantizeControl, shouldSendControl, MAX_TEAM,
  type LobbyPlayer, type ControlSample, type Team,
} from './lobby';
import { inject } from '@vercel/analytics';
import { trackOnce } from './analytics';
import { readingToQuat, relativeTwistDeg, QUAT_STEER_SIGN, type Quat } from './orientation';

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
// hit full lock); 70° = the baked value chosen by on-phone feel testing (full
// lock needs a comfortable wrist tilt; the temporary live range tuner is gone).
const TILT_RANGE_DEG = 70;    // ← higher = must tilt more for full lock
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
const STEER_SIGN = +1;   // +1: roll RIGHT → +steer on BOTH platforms. The iOS↔Android
                         // sensor difference (frame + sign) is normalised INSIDE
                         // steeringRollDeg, so this is one global flip; set -1 only if
                         // BOTH platforms ever read mirrored.
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

// PLATFORM SENSOR DIFFERENCE (the Android steering bug). iOS Safari (WebKit) reports
// DeviceMotion.accelerationIncludingGravity (a) NEGATED vs the W3C sign convention and
// (b) in the DEVICE (natural-portrait) frame — so in the landscape hold, device Y is
// the screen's HORIZONTAL axis = the steering roll (works). Android/Chromium report the
// W3C sign AND the reading ALREADY ROTATED to the SCREEN frame — so device Y there is
// the screen's VERTICAL = PITCH (wrong axis), and the opposite sign = INVERTED. Reading
// raw `lastAy` for everyone is why Android steers on pitch + reversed. We normalise this
// explicitly in steeringRollDeg() (iOS path kept byte-identical).
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);  // iPadOS

// ---------- DOM ----------
const params = new URLSearchParams(window.location.search);
const code = (params.get('s') || '').toUpperCase();
// ROOM SECRET from the QR (`&k=`). It is part of the Realtime TOPIC (see channelName), so
// a phone that reached this page WITHOUT it — an old QR, a hand-typed link, someone who
// merely read the 4-char code off the screen — lands on a different topic and simply never
// sees the room. That is the intent: the short code is a label, not a credential.
const roomKey = params.get('k') || '';
// FIRST-PAINT CAR HINT: the host encodes the chosen mode in the QR/join URL (?m=arcade|sim),
// so we know which car's colours to draw BEFORE the first lobby message arrives — no flash of
// the other car's palette. Unknown/absent (an old QR, a hand-typed link) → we render NO
// swatches at all and wait for the host's palette, which is still the authority either way.
const urlPalette = paletteForMode(params.get('m'));

// =============================================================================
//  FUNNEL DIAGNOSTICS — where does a scan die?
//
//  `qr-shown` counts hosts showing a QR; the phone-side events counted far fewer.
//  That gap could be "nobody scanned" OR "they scanned and the page died", and the
//  two need completely different fixes. These events split them apart.
//
//  All values are fixed enum strings — never the code, the key, an id or a name.
// =============================================================================
trackOnce('phone-boot', 'phone-boot');   // THE DENOMINATOR: this page actually ran

// A link that cannot possibly work: no `?s=` (nothing to join) or no `&k=` (the room
// secret is part of the Realtime TOPIC, so without it we subscribe somewhere the host
// isn't and wait forever).
//
// ⚠️ This only catches a MALFORMED link. A STALE one — a well-formed `s`+`k` from a
// session that has since ended — is indistinguishable from a good link here; the phone
// subscribes happily and simply never hears a host. That case shows up instead as
// `phone-failed {stage:'subscribed-no-lobby-msg'}` below.
// NOTE the split between KEY and NAME below (and at every other variant site): the key
// is CONSTANT so the once-guard covers all variants of the same fact, while the name
// carries the variant so it shows as its own row in a dashboard that only lists names.
if (!code) trackOnce('phone-bad-link', 'phone-bad-link-code', { missing: 'code' });
else if (!roomKey) trackOnce('phone-bad-link', 'phone-bad-link-key', { missing: 'key' });

// What the watchdog reports about HOW FAR the phone got (see JOIN_WATCHDOG_MS).
let everSubscribed = false;
let everGotLobbyMsg = false;

const stageEl     = document.getElementById('phone-stage')    as HTMLDivElement;
const unlockBtn   = document.getElementById('unlock')         as HTMLButtonElement;
const pedalsEl    = document.getElementById('pedals')         as HTMLDivElement;
const brakeBtn    = document.getElementById('pedal-brake')    as HTMLButtonElement;
const throttleBtn = document.getElementById('pedal-throttle') as HTMLButtonElement;
const handbrakeBtn = document.getElementById('handbrake')     as HTMLButtonElement;
const recenterBtn = document.getElementById('recenter')       as HTMLButtonElement | null;
const errorEl     = document.getElementById('error')          as HTMLDivElement;
const debugEl     = document.getElementById('debug')          as HTMLDivElement | null;
const lobbySlotEl   = document.getElementById('lobby-slot')   as HTMLDivElement | null;
const lobbyColorsEl = document.getElementById('lobby-colors') as HTMLDivElement | null;
const lobbyNameEl   = document.getElementById('lobby-name')   as HTMLInputElement | null;
// STEERBALL team UI.
const teamPickerEl   = document.getElementById('team-picker')       as HTMLDivElement | null;
const teamLeftBtn    = document.getElementById('team-left')         as HTMLButtonElement | null;
const teamRightBtn   = document.getElementById('team-right')        as HTMLButtonElement | null;
const teamPickerHint = document.getElementById('team-picker-hint')  as HTMLDivElement | null;
const teamIdentEl    = document.getElementById('team-ident')        as HTMLButtonElement | null;
const teamIdentBadge = document.getElementById('team-ident-badge')  as HTMLElement | null;
const teamIdentLabel = document.getElementById('team-ident-label')  as HTMLElement | null;

// ---------- Lobby (this phone's slot + colour + name) ----------
const clientId = getClientId();
let mySlot: number | null = null;     // assigned by the desktop authority
let selectedColor = '';                // '' until picked / adopted from server
let selectedName = '';                 // '' → desktop shows "PLAYER n"
let lobbyFull = false;

// ---------- STEERBALL (football) team state ----------
// Blue LEFT / orange RIGHT — must match desktop.ts STEERBALL_TEAM_COLORS.
const TEAM_COLORS: Record<Team, string> = { left: '#2f6ccb', right: '#e0552a' };
let steerballActive = false;                              // host says the mode is Steerball
let matchLocked = false;                                  // host says the match kicked off (teams locked)
let myTeam: Team | undefined;                             // this phone's chosen/assigned side
let teamCounts: { left: number; right: number } = { left: 0, right: 0 };
let controlsReady = false;                                // sensors/listeners attached (unlock done once)

// ---------- State ----------
type Stage = 'before-unlock' | 'after-unlock' | 'error';
let stage: Stage = 'before-unlock';
let errorMsg = '';
let permState: 'unknown' | 'granted' | 'denied' | 'not-required' = 'unknown';

// Raw sensor readings (device frame).
let lastAlpha = 0;
let lastBeta = 0;
let lastGamma = 0;
let lastAx = 0, lastAy = 0, lastAz = 0;
let hasMotionReading = false;
// A deviceorientation reading has arrived (beta/gamma present ⇒ enough for the RECENTER
// quaternion path; alpha may be absent on a device with no magnetometer — treated as 0).
let hasOrientationReading = false;

// ===================================================================================
//  RECENTER — an OPT-IN, per-session steering rescue (default path is UNTOUCHED).
//
//  Steering is the gravity-based pitch-invariant roll for EVERYONE by default (see
//  steeringRollDeg). A player whose device's default frame guess is wrong (offset zero
//  AND/OR a swapped/flipped axis — the Android device-frame mismatch) can tap RECENTER:
//  we capture the current orientation as a REFERENCE quaternion and, from then on THIS
//  SESSION, steer becomes the relative TWIST about the wheel axis from that reference
//  (orientation.ts). That fixes both failure modes at once and is device-agnostic (the
//  reference defines "straight"). Nothing is persisted — a new session starts on the
//  default path again, so a stale calibration can never silently affect a later session.
// ===================================================================================
let refQuat: Quat | null = null;      // reference orientation captured at the RECENTER tap
let useQuatSteering = false;          // has THIS session opted in? (false ⇒ default path)
// QUAT_STEER_SIGN (imported) aligns the quaternion path's direction with the default gravity
// path — device-independent, one flip everywhere. See orientation.ts for the derivation.

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
// TRANSPORT SEAM (WebRTC V1): one-shots + the join heartbeat ride the reliable
// "state" DataChannel once P2P is up (the phone LEAVES the Realtime channel
// then — nothing may depend on it being subscribed); otherwise Realtime.
function sendLobbyMsg(event: string, payload: unknown) {
  if (rtcUp && rtc?.sendState(event, payload)) return;
  rc.send({ type: 'broadcast', event, payload });
}

function sendJoin() {
  sendLobbyMsg(EV.join, {
    id: clientId,
    color: selectedColor || undefined,
    name: selectedName || undefined,
  });
}
function sendName() {
  sendLobbyMsg(EV.name, { id: clientId, name: selectedName });
}
function sendTeam(team: Team) {
  sendLobbyMsg(EV.team, { id: clientId, team });
}
function sendLeave() {
  try {
    sendLobbyMsg(EV.leave, { id: clientId });
  } catch { /* best-effort */ }
}

let lobbyStarted = false;
function startLobby() {
  if (lobbyStarted || !code) return;
  lobbyStarted = true;
  sendJoin();
  setInterval(sendJoin, PHONE_HEARTBEAT_MS);
}

// Desktop → phone handlers — TRANSPORT-AGNOSTIC (called from the Realtime
// channel AND the reliable "state" DataChannel).
// ---- FUNNEL: did this phone ever get control of a car? -----------------------------
// The number actually worth having: someone scanned the QR and never got to drive.
//
// ⚠️ Deliberately NOT wired to the P2P fallback. A phone on the Realtime transport is
// playing perfectly well — counting that as "failed" would invent a problem that isn't
// there and bury the real failures. P2P health is a SEPARATE signal (transport-fallback).
const JOIN_WATCHDOG_MS = 20000;   // generous: a slow network + a busy host still make it
let joinWatchdog: number | null = window.setTimeout(() => {
  joinWatchdog = null;
  // STAGE = how far the phone actually got before giving up. This is the property that
  // turns "2 phones failed" into an actionable cause:
  //   no-subscribe ............ Realtime never came up (network / Supabase / blocked WS)
  //   subscribed-no-lobby-msg . we're on a topic but NO host ever answered — a stale or
  //                             wrong-room link, or the host left the game screen
  //   lobby-msg-but-no-slot ... a host IS there and talking, but we're not in the roster
  const stage = !everSubscribed ? 'no-subscribe'
    : !everGotLobbyMsg ? 'subscribed-no-lobby-msg'
      : 'lobby-msg-but-no-slot';
  // KEY 'phone-failed' (constant) + NAME carrying the stage. The constant key is what
  // guarantees ONE failure per session: a phone that reports no-subscribe here can never
  // later also fire the lobby-full variant below, because both share this key.
  trackOnce('phone-failed', `phone-failed-${stage}`, { reason: 'timeout', stage });
}, JOIN_WATCHDOG_MS);
function clearJoinWatchdog() {
  if (joinWatchdog !== null) { clearTimeout(joinWatchdog); joinWatchdog = null; }
}

function handleLobby(payload: unknown) {
  // A host answered us — true on EITHER transport (Realtime or the state DataChannel).
  // Distinguishes "nobody is listening on this topic" from "we're just not in the roster".
  everGotLobbyMsg = true;
  const list = ((payload as { players?: LobbyPlayer[] })?.players ?? []) as LobbyPlayer[];
  // Rebuild the colour picker for the host's chosen mode's palette (if sent).
  const colors = (payload as { colors?: { name: string; hex: string }[] })?.colors;
  if (Array.isArray(colors) && colors.length) buildColorPicker(colors);
  // STEERBALL: the host rides the mode + kickoff flags on the lobby payload. Team counts come from
  // the roster (to disable a FULL side). In Steerball the colour picker is replaced by the team pick.
  steerballActive = (payload as { steerball?: boolean }).steerball === true;
  matchLocked = (payload as { matchStarted?: boolean }).matchStarted === true;
  let cl = 0, cr = 0;
  for (const p of list) { if (p.team === 'left') cl++; else if (p.team === 'right') cr++; }
  teamCounts = { left: cl, right: cr };
  const me = list.find((p) => p.id === clientId);
  if (me) {
    // Adopt / reconcile the server's view of our team. It's the authority: an auto-assignment at
    // kickoff arrives here, and a reclaim after a blip re-asserts what we picked (host kept it).
    if (me.team) { myTeam = me.team; }
    else if (steerballActive && myTeam && !matchLocked) { sendTeam(myTeam); }   // re-assert after reclaim
    // FUNNEL: holding a slot IS controlling a car — the honest "connected" moment, and
    // it covers BOTH transports (P2P and the Realtime fallback both get here). Fired
    // once: lobby messages arrive continuously and on every reclaim/reconnect.
    if (trackOnce('phone-connected', 'phone-connected')) clearJoinWatchdog();
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
  renderTeamUI();
  // The unlock gate depends on team state (Steerball requires a side first) → re-run it when the
  // stage screen is showing, so picking/being-assigned a team reveals TAP TO STEER without a tap.
  if (stage === 'before-unlock') renderUI();
}
function handleFull(payload: unknown) {
  if ((payload as { id?: string })?.id === clientId && mySlot === null) {
    // The other genuine "never got a car": the room was already full.
    trackOnce('phone-failed', 'phone-failed-lobby-full', { reason: 'lobby-full' });
    clearJoinWatchdog();
    lobbyFull = true;
    renderLobby();
  }
}

// Realtime wiring (re-attached to every (re)created channel).
function wirePhone(ch: RealtimeChannel) {
  ch.on('broadcast', { event: EV.lobby }, ({ payload }) => handleLobby(payload));
  ch.on('broadcast', { event: EV.full }, ({ payload }) => handleFull(payload));
  // WebRTC signaling (desktop → phone): the answer + trickle ICE.
  ch.on('broadcast', { event: RTC_EV.answer }, ({ payload }) => rtc?.handleSignal(RTC_EV.answer, payload));
  ch.on('broadcast', { event: RTC_EV.ice }, ({ payload }) => rtc?.handleSignal(RTC_EV.ice, payload));
}

// ---------- WebRTC transport (V1) ----------
// The phone initiates the P2P pairing over the Realtime channel. Once the
// control DataChannel is OPEN, tilt + one-shots migrate to P2P and the phone
// LEAVES the Realtime channel (rc.stop() — signaling is done, stop consuming
// quota). Fallback: not open within RTC_FALLBACK_MS → stay on Realtime
// (today's behavior, playable for everyone). Reconnect (P2P died / return
// from background): rc.resume() re-subscribes → onReady fires → startRtc()
// sends a FRESH offer; the desktop replaces the peer for this clientId and the
// same-car reclaim-by-id (RESILIENCE grace window) keeps the car.
let rtc: PhoneRtc | null = null;
let rtcUp = false;
let rtcStarting = false;   // creds fetch in flight — guard double-entry
// BOUNDED PAIRING RETRIES. A pairing used to get exactly ONE attempt per channel
// (re)connect: if that attempt failed for a transient reason — above all a lost
// offer — the phone stayed on the Realtime fallback for the WHOLE session, because
// nothing retried. Now a failed attempt is retried a couple of times before we
// concede. Bounded (and delayed) so a genuinely NAT-blocked phone still settles on
// Realtime quickly instead of looping offers forever.
const RTC_MAX_ATTEMPTS = 3;        // the initial attempt + 2 retries
const RTC_RETRY_DELAY_MS = 1200;   // brief pause so a re-subscribe can land first
let rtcAttempts = 0;
let rtcRetryTimer: number | null = null;

// ?rtc=relay → ICE may use ONLY relay candidates = the forced-TURN test switch
// (any network then MUST pair via the TURN relay or fall back).
const rtcRelayOnly = params.get('rtc') === 'relay';

function routeStateMsg(m: StateMsg) {
  if (m.ev === EV.lobby) handleLobby(m.payload);
  else if (m.ev === EV.full) handleFull(m.payload);
}

function startRtc() {
  if (!code || rtc || rtcStarting) return;        // an attempt is already live — no retry storm
  if (rtcAttempts >= RTC_MAX_ATTEMPTS) return;    // budget spent → settled on Realtime
  // No WebRTC on this engine at all — iOS LOCKDOWN MODE disables it outright, and some
  // in-app WKWebView browsers a QR scan can land in don't expose it either. P2P is
  // impossible, so say so ONCE and stay on Realtime (fully playable); burning the retry
  // budget on it would only delay the same outcome.
  if (!peerConnectionCtor()) {
    rtcAttempts = RTC_MAX_ATTEMPTS;
    // P2P HEALTH (not a failure — the player is fine on Realtime).
    trackOnce('transport-fallback', 'transport-fallback-no-webrtc', { reason: 'no-webrtc' });
    console.info(`[rtc] no WebRTC on this engine (Lockdown Mode / in-app browser) — using Realtime. ${rtcSupportReport()}`);
    return;
  }
  if (rtcRetryTimer !== null) { clearTimeout(rtcRetryTimer); rtcRetryTimer = null; }
  rtcAttempts++;
  rtcStarting = true;
  // STEP 3: fetch short-lived TURN creds (2 s timeout). null on ANY failure →
  // STUN-only (the V1 behavior) — TURN being down never blocks pairing.
  // The room code is REQUIRED: /api/turn now hard-gates on it (403 without a
  // well-formed one), so no unauthenticated caller can pull working relay creds.
  // Always present here — the guard above returns early when `code` is empty.
  const turnUrl = `/api/turn?s=${encodeURIComponent(code)}`;
  fetchTurnServers(fetch, 2000, turnUrl).then((turn) => {
    rtcStarting = false;
    if (rtc) return;
    rtc = connectPhoneRtc({
      clientId,
      // SIGNALING IS A ONE-SHOT → `sendQueued`, not `send`. If the channel is mid
      // re-create (the 0.3-2.5 s window after subscribing, while the TURN fetch runs)
      // the offer is HELD and flushed on the next SUBSCRIBED instead of vanishing.
      signal: (event, payload) => rc.sendQueued({ type: 'broadcast', event, payload }),
      pcFactory: makePeerFactory([...RTC_ICE_SERVERS, ...(turn ?? [])], rtcRelayOnly),
      onControlOpen: () => {
        rtcUp = true;
        rtcAttempts = 0;   // paired — restore the full budget for a later re-pair
        sendJoin();     // announce over the DataChannel FIRST (proves the path)
        rc.stop();      // then leave Realtime — signaling done, quota stops here
      },
      onStateMessage: routeStateMsg,
      onFallback: () => {
        // P2P didn't come up within RTC_FALLBACK_MS. Could be a genuinely blocked NAT
        // — or a transient loss (the offer that never arrived). RETRY a bounded number
        // of times with a fresh PC + fresh offer before conceding to Realtime; play
        // continues over Realtime throughout either way.
        rtc = null;
        if (rtcAttempts < RTC_MAX_ATTEMPTS) {
          rtcRetryTimer = window.setTimeout(() => { rtcRetryTimer = null; startRtc(); }, RTC_RETRY_DELAY_MS);
        } else {
          // P2P conceded after the full retry budget → the player continues on Realtime.
          // Separate from phone-failed ON PURPOSE: this is transport quality, not a lost player.
          trackOnce('transport-fallback', 'transport-fallback-pairing-timeout', { reason: 'pairing-timeout' });
        }
      },
      onDead: () => {
        // P2P WAS up and died (network change, backgrounded, host gone).
        rtcUp = false;
        rtc = null;
        rtcAttempts = 0;   // it worked once → a fresh budget for the re-pair
        rc.resume();    // re-subscribe → onReady → sendJoin + startRtc (fresh offer)
      },
    });
  }).catch((e) => {
    // MUST stay: without this, a throw in the chain (PC construction, createOffer, …)
    // is SWALLOWED — rtc stays null with no retry, a silent permanent fallback.
    rtcStarting = false;
    console.warn('[rtc] pairing failed to start', e);
  });
}

// Resilient channel: reconnects after a blip so input resumes without a rescan.
// Did the Realtime channel EVER come up? Reported once, on the first resolution, so later
// reconnect churn can't skew it. This is what separates "the transport never started"
// from "the transport was fine, nobody answered".
//
// Only two states, deliberately: `subscribed` or `timeout`. There is no 'error' state
// because the resilient channel only invokes onDrop for a channel that WAS ready
// (supabase.ts: `if (wasReady) hooks.onDrop?.()`), so a never-subscribing channel never
// reports one — it silently retries with backoff. `timeout` is therefore the only honest
// signal for "never came up", and wiring an unreachable 'error' would just be dead code.
const CHANNEL_REPORT_MS = 10000;
const reportChannel = (state: string) => trackOnce('phone-channel', `phone-channel-${state}`, { state });
window.setTimeout(() => reportChannel('timeout'), CHANNEL_REPORT_MS);

const rc = createResilientChannel(
  channelName(code, roomKey), { broadcast: { self: false } }, wirePhone,
  {
    label: 'phone',
    // Re-announce on every (re)connect + kick off the P2P pairing (fresh offer;
    // covers first load AND the resume() path after a dead P2P transport).
    onReady: () => {
      everSubscribed = true;
      reportChannel('subscribed');
      startLobby(); sendJoin(); startRtc();
    },
  },
);
window.addEventListener('pagehide', sendLeave);

// Screen-lock / backgrounding (iOS Safari kills WebRTC + sensors): best-effort
// NEUTRAL packet so the car parks instead of holding the last tilt — the
// desktop's RESILIENCE ramp covers the loss either way (grace window, car
// preserved in place). On return, retry P2P if it died while backgrounded.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    sendNeutralNow();
  } else if (!rtcUp) {
    rc.resume();   // no-op unless we had deliberately left (P2P was up)
    startRtc();    // no-op if an attempt is already in flight
  }
});

// ---------- Colour picker (on the TAP TO STEER screen) ----------
// The palette is MODE-dependent: the desktop sends it in the lobby payload
// (SIM → Blitz colours, ARCADE → Stee-Rex silver/black). Rebuilt when it changes.
let paletteSig = '';
function buildColorPicker(colors: { name: string; hex: string }[] | null = urlPalette) {
  if (!lobbyColorsEl || !colors) return;   // car unknown yet → draw nothing (no wrong-car flash)
  const sig = colors.map((c) => c.hex).join(',');
  if (sig === paletteSig && lobbyColorsEl.childElementCount > 0) return;
  paletteSig = sig;
  lobbyColorsEl.innerHTML = '';
  for (const c of colors) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.hex = c.hex;
    b.style.setProperty('--sw', c.hex);
    b.setAttribute('aria-label', c.name);
    b.addEventListener('click', (e) => { e.preventDefault(); pickColor(c.hex); });
    lobbyColorsEl.appendChild(b);
  }
  highlightSwatch();
}
function pickColor(hex: string) {
  selectedColor = hex;
  highlightSwatch();
  // Immediate colour message + refresh the join payload so it sticks.
  sendLobbyMsg(EV.color, { id: clientId, color: hex });
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

// ---------- STEERBALL team picker + identity chip ----------
// Choose a side. Rejected if the match has kicked off (locked) or the side is FULL (4). Sends the
// choice to the host (authority) and re-renders. Free to change until kickoff.
function pickTeam(team: Team) {
  if (matchLocked) return;
  if (team !== myTeam && teamCounts[team] >= MAX_TEAM) return;   // that side is full
  myTeam = team;
  sendTeam(team);
  sendJoin();          // keep the heartbeat payload fresh so a reclaim restores us
  renderTeamUI();
  if (stage === 'before-unlock') renderUI();   // reveal TAP TO STEER now a side is chosen
}
teamLeftBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); pickTeam('left'); });
teamRightBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); pickTeam('right'); });
// Tapping the identity chip on the driving screen (before kickoff) reopens the picker to switch sides.
teamIdentEl?.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  if (matchLocked) return;
  stage = 'before-unlock';
  renderUI();
});

// Paint the team picker (before-unlock, Steerball) and the identity chip (driving screen). Also gates
// the unlock button: in Steerball you must pick a side before TAP TO STEER appears.
function renderTeamUI() {
  const showPicker = steerballActive && stage === 'before-unlock';
  if (teamPickerEl) teamPickerEl.hidden = !showPicker;
  if (showPicker) {
    const paint = (btn: HTMLButtonElement | null, side: Team) => {
      if (!btn) return;
      const cnt = teamCounts[side];
      const full = cnt >= MAX_TEAM && myTeam !== side;
      btn.classList.toggle('selected', myTeam === side);
      btn.classList.toggle('full', full);
      btn.disabled = full || matchLocked;
      const c = btn.querySelector('.team-btn-count');
      if (c) c.textContent = `${cnt}/${MAX_TEAM}`;
    };
    paint(teamLeftBtn, 'left');
    paint(teamRightBtn, 'right');
    if (teamPickerHint) {
      teamPickerHint.textContent = matchLocked ? 'Match started — locked in.'
        : !myTeam ? 'Pick a side to start.'
        : 'Ready — tap TAP TO STEER.';
    }
  }
  // Identity chip (driving screen) — your TEAM COLOUR (a swatch, no number) so you can find your car
  // on the monitor. Cars are identified by colour alone; there are no on-screen numbers to match.
  const showIdent = steerballActive && stage === 'after-unlock' && !!myTeam;
  if (teamIdentEl) teamIdentEl.hidden = !showIdent;
  if (showIdent && myTeam) {
    if (teamIdentBadge) {
      teamIdentBadge.style.background = TEAM_COLORS[myTeam];
      teamIdentBadge.textContent = '';
    }
    if (teamIdentLabel) {
      teamIdentLabel.textContent = (myTeam === 'left' ? 'BLUE' : 'ORANGE') + (matchLocked ? '' : ' · tap to switch');
    }
  }
  // Unlock gate: Steerball requires a chosen side first.
  if (stage === 'before-unlock') unlockBtn.hidden = steerballActive && !myTeam;
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

// First paint: the URL's mode hint (?m=) gives us the RIGHT car's colours immediately.
// Without it nothing is drawn until the host's lobby message lands (a beat later) — either
// way the player never sees the wrong car's palette.
buildColorPicker();

// ---------- Render ----------
function renderUI() {
  unlockBtn.hidden = true;
  pedalsEl.hidden  = true;
  errorEl.hidden   = true;
  if (recenterBtn) recenterBtn.hidden = true;

  // The slot label + colour picker live on the TAP TO STEER screen only. In Steerball the car colour
  // IS the team colour (chosen by side, not swatch), so the colour picker is replaced by the team pick.
  const showLobby = stage === 'before-unlock';
  if (lobbySlotEl)   lobbySlotEl.hidden   = !showLobby;
  if (lobbyColorsEl) lobbyColorsEl.hidden = !showLobby || steerballActive;
  if (lobbyNameEl)   lobbyNameEl.hidden   = !showLobby;

  if (stage === 'error') {
    errorEl.hidden = false;
    errorEl.textContent = errorMsg;
  } else if (stage === 'before-unlock') {
    unlockBtn.hidden = false;   // renderTeamUI may re-hide it until a Steerball side is picked
  } else {
    pedalsEl.hidden = false;
    if (recenterBtn) recenterBtn.hidden = false;   // shown on the driving screen only
  }

  renderTeamUI();
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

// The extra rotation the CSS force-landscape applies: when the VIEWPORT is portrait
// the stage is rotated 90° to fake landscape (see style.css `--rot`), so the axis the
// PLAYER sees as horizontal is rotated by that much. 0 in the normal landscape hold.
function cssExtraRad(): number {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  return portrait ? Math.PI / 2 : 0;
}

// ----------------------------------------------------------------------
//  Steering — PITCH-INVARIANT left/right ROLL angle (degrees), PLATFORM-CORRECT.
//
//  The steering axis is ALWAYS the axis the player sees as HORIZONTAL (rolling the
//  phone like a steering wheel), on BOTH platforms and in any screen orientation.
//  We derive the gravity component along that view-horizontal axis, then
//  asin(component / |g|) gives a true roll angle — symmetric about level, PITCH-
//  INVARIANT (pitch is a rotation about the horizontal axis, so it can't change that
//  axis's own gravity component), and needing NO baseline / per-user calibration.
//
//  The platform difference is handled EXPLICITLY (see IS_IOS above):
//   • iOS  — accelerationIncludingGravity is in the DEVICE frame; the view-horizontal
//            is device Y. We use `-lastAy` (roll-right → positive). This is EXACTLY
//            the previous iOS computation (the −1 that used to live in STEER_SIGN is
//            folded in here), so iOS is unchanged.
//   • else — Android/Chromium report the reading ALREADY in the SCREEN frame with the
//            W3C sign, so the view-horizontal is the SCREEN's horizontal = `lastAx`
//            (device Y there is the screen VERTICAL = pitch — the bug). We rotate by
//            the CSS force-landscape extra so it stays the axis the player sees as
//            left/right even when holding the phone portrait.
//  Returns POSITIVE for a RIGHT roll on both platforms; STEER_SIGN (+1) is the single
//  global left/right flip.
// ----------------------------------------------------------------------
// The screen's rotation, for the RECENTER quaternion path (correct for all four angles +
// natural-landscape devices). screen.orientation.angle where available, else the legacy
// window.orientation, else 0. NOT used by the default gravity path.
function screenAngleDeg(): number {
  const so = (screen as Screen & { orientation?: { angle?: number } }).orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  const wo = (window as Window & { orientation?: number }).orientation;
  return typeof wo === 'number' ? (((wo % 360) + 360) % 360) : 0;
}
// The current orientation as a screen-normalised quaternion (RECENTER path only).
function currentQuatReading(): Quat {
  return readingToQuat(lastAlpha, lastBeta, lastGamma, screenAngleDeg());
}

// RECENTER tap: capture the current orientation as the reference and switch THIS session to
// the relative-twist steering path. Re-tapping re-captures (grip changed / got it wrong). If
// no deviceorientation reading is available (locked-down browser / no permission), we DON'T
// switch — steering stays on the working gravity path and the button reports it.
function recenter(): void {
  if (!hasOrientationReading) { flashRecenter('NOT AVAILABLE', false); return; }
  refQuat = currentQuatReading();
  useQuatSteering = true;
  flashRecenter('CENTERED ✓', true);
}
let recenterFlashUntil = 0;
function flashRecenter(text: string, okState: boolean): void {
  if (!recenterBtn) return;
  recenterBtn.textContent = text;
  recenterBtn.classList.toggle('ok', okState);
  recenterFlashUntil = performance.now() + 1100;
  window.setTimeout(() => {
    if (performance.now() >= recenterFlashUntil && recenterBtn) {
      recenterBtn.textContent = 'RECENTER';
      recenterBtn.classList.remove('ok');
    }
  }, 1150);
}

function steeringRollDeg(): number {
  // OPT-IN RECENTER path — ONLY after the player has tapped RECENTER (useQuatSteering set +
  // a reference captured + a live orientation reading). Every other player falls straight
  // through to the UNCHANGED gravity path below, byte-for-byte as before.
  if (useQuatSteering && refQuat && hasOrientationReading) {
    return QUAT_STEER_SIGN * relativeTwistDeg(refQuat, currentQuatReading());
  }
  // ---- DEFAULT gravity path (UNCHANGED) ----
  if (!hasMotionReading) return 0;
  const g = Math.hypot(lastAx, lastAy, lastAz);
  if (g < 1) return 0;                                   // free-fall / no signal
  let comp: number;
  if (IS_IOS) {
    comp = -lastAy;                                      // device frame — unchanged from before
  } else {
    const c = cssExtraRad();                             // screen frame → view horizontal
    comp = lastAx * Math.cos(c) + lastAy * Math.sin(c);
  }
  const ratio = Math.max(-1, Math.min(1, comp / g));     // sin(roll), clamped
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
    `stage=${stage} perm=${permState}  plat=${IS_IOS ? 'iOS' : 'Android'}\n` +
    `phys=${currentPhys}  viewport=${browserLandscape ? 'L' : 'P'}  rot=${cssRot}\n` +
    `ax=${lastAx.toFixed(1)} ay=${lastAy.toFixed(1)} az=${lastAz.toFixed(1)}  ` +
    `sm=(${smoothedAx.toFixed(1)},${smoothedAy.toFixed(1)})\n` +
    `a=${lastAlpha.toFixed(0)} beta=${lastBeta.toFixed(0)} gamma=${lastGamma.toFixed(0)} ` +
    `scr=${screenAngleDeg()} ori=${hasOrientationReading ? 'y' : 'n'}\n` +
    // RECENTER diagnostics (for improving the DEFAULT mapping later from real devices): the
    // live orientation quaternion, whether a reference is captured, and the relative twist.
    `q=${(() => { const q = hasOrientationReading ? currentQuatReading() : { w: 1, x: 0, y: 0, z: 0 }; return `${q.w.toFixed(2)},${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}`; })()}\n` +
    `recenter=${useQuatSteering ? 'ON' : 'off'} ref=${refQuat ? `${refQuat.w.toFixed(2)},${refQuat.x.toFixed(2)},${refQuat.y.toFixed(2)},${refQuat.z.toFixed(2)}` : '-'} ` +
    `twist=${refQuat && hasOrientationReading ? relativeTwistDeg(refQuat, currentQuatReading()).toFixed(1) : '-'}\n` +
    `roll=${roll.toFixed(1)}° steer=${steer.toFixed(2)} rng=${TILT_RANGE_DEG}°  ` +
    `t=${pedalValue('throttle').toFixed(2)} b=${pedalValue('brake').toFixed(2)} ` +
    `hb=${handbrakeOn() ? 'ON' : 'off'}`;
}

// ----------------------------------------------------------------------
//  Unlock + permission
// ----------------------------------------------------------------------
unlockBtn.addEventListener('click', async () => {
  // Already unlocked once (e.g. returning from a Steerball team switch) → just go back to driving.
  // Re-running the permission request + re-attaching listeners would double-bind every control.
  if (controlsReady) { stage = 'after-unlock'; renderUI(); return; }
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
    controlsReady = true;
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
    if (e.alpha != null) lastAlpha = e.alpha;   // absent (no magnetometer) → stays 0; RECENTER copes
    if (e.beta  != null) lastBeta  = e.beta;
    if (e.gamma != null) lastGamma = e.gamma;
    // beta/gamma are gravity-derived + present on essentially all devices → enough for the
    // RECENTER quaternion path. (The DEFAULT steering path does not read these at all.)
    if (e.beta != null || e.gamma != null) hasOrientationReading = true;
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
  // RECENTER — opt-in steering rescue (see recenter()). Not a driving control, so a plain
  // click; stopPropagation so it never leaks into the pedal/handbrake touch handling.
  recenterBtn?.addEventListener('click', (e) => { e.stopPropagation(); recenter(); });

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

// DEADBAND state (quota quick-win): the last SENT sample + when. The 30 Hz tick
// only sends when the quantized input changed, with a 5 Hz keepalive floor
// (shouldSendControl in lobby.ts — pure + unit-tested). Edge events (pedal
// press/release, watchdog resets) still FORCE a send via sendControlNow().
let lastSentSample: ControlSample | null = null;
let lastSentAt = 0;

function buildControlSample(): ControlSample {
  return {
    steer:     quantizeControl(steerFromTilt()),
    throttle:  quantizeControl(pedalValue('throttle')),
    brake:     quantizeControl(pedalValue('brake')),
    handbrake: handbrakeOn(),
  };
}

function sendSample(s: ControlSample) {
  lastSentSample = s;
  lastSentAt = performance.now();
  const payload = { id: clientId, slot: mySlot ?? 0, ...s };
  // TRANSPORT SEAM: P2P control DataChannel when up (same payload shape —
  // the desktop routes both transports through the same applyInputs path),
  // otherwise the Realtime channel (fallback / pre-pairing).
  if (rtcUp && rtc?.sendControl(payload)) return;
  rc.send({ type: 'broadcast', event: EV.control, payload });
}

// Best-effort neutral (screen-lock/backgrounding) — park the car cleanly.
function sendNeutralNow() {
  if (!broadcastStarted) return;
  sendSample({ steer: 0, throttle: 0, brake: 0, handbrake: false });
}

// FORCE send — pedal/handbrake edges + watchdog/reset paths call this so a
// state change is on the wire immediately (never waits for the next tick).
function sendControlNow() {
  if (!broadcastStarted) return;
  sendSample(buildControlSample());
}

// 30 Hz tick — deadband + keepalive: sends at full rate while the input is
// CHANGING (active tilting), drops to the 5 Hz keepalive when idle.
function sendControlTick() {
  if (!broadcastStarted) return;
  const s = buildControlSample();
  if (!shouldSendControl(lastSentSample, s, performance.now() - lastSentAt)) return;
  sendSample(s);
}

function startBroadcast() {
  broadcastStarted = true;
  const INTERVAL_MS = 1000 / SEND_HZ;
  setInterval(sendControlTick, INTERVAL_MS);
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
