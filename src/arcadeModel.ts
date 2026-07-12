// =============================================================================
//  NEW ARCADE DRIVING MODEL — a kinematic arcade CONTROLLER, not a simulation.
//
//  Six simple, direct laws; the feel IS the equation. Speed (translation) and
//  rotation are INDEPENDENT laws, drift is an EXPLICIT state machine, and every
//  law is self-restoring: first-order relaxations toward HARD-CLAMPED targets +
//  one projection invariant — so endless slides, endless spins, and
//  can't-get-out states are impossible BY CONSTRUCTION, not by patches.
//
//  The model owns (v, φ, θ): speed magnitude, motion direction, body heading.
//  CarState.vx/vy stay the source of truth across steps — collisions
//  (cars.ts pair bounces, collideWithRects walls) mutate them freely and the
//  next step absorbs the impulse into (v, φ), where the laws decay it.
//
//  LAWS (feel parameter → stability argument):
//   L1 THRUST     dv/dt = th·aMax·(1−(v/vTop)²) − brakes/coast.
//                 v ∈ [0, vTop] hard-clamped, monotone → bounded, always rests.
//   L2 STEERING   ω_cmd = steer·ωMax·min(1, v/vRef);  dω = (ω_cmd−ω)/τ_steer.
//                 τ_steer IS the rotation weight (rise-time as a parameter).
//                 First-order lag to a clamped target → no overshoot, ω ≤ ωMax;
//                 a collision ω-impulse decays back to command within ~τ.
//   L3 GRIP       dφ/dt = clamp(kGrip·sin(θ−φ), ±aLatMax/v)  (path follows
//                 heading, lateral shove decays), THEN the PROJECTION:
//                 θ := φ + clamp(θ−φ, ±sMax)  — the slip invariant. |θ−φ| can
//                 NEVER exceed sMax in grip (a projection onto a bounded set is
//                 an invariant by construction) → no unbounded body-vs-path
//                 angle at full lock; excess steering just widens the arc
//                 (arcade understeer-lite).
//   L4 DRIFT      explicit state: heading chases (φ + δ) through a τ_body lag;
//                 steer SETS δ (δ_target hard-clamped [δMin, δMax]); the path
//                 turns at ω_path = dir·(base + |steer|·gain) (bounded); speed
//                 bleeds (−driftBleed + th·driftFeed ≤ 0) → every slide loses
//                 energy and resolves; v < vMinDrift force-exits. No positive
//                 feedback anywhere → the drift cannot spiral.
//   L5 COLLISION  impulses enter vx/vy/angularVel only — quantities the laws
//                 above relax to clamped targets → a bump is a shove that
//                 decays (grip: kGrip + projection; drift: the τ_body lag eats
//                 heading jumps smoothly — no rotation teleport).
//   L6 REVERSE    brake at ~standstill = reverse (existing convention), up to
//                 vRevMax, steering mirrored; drift disallowed in reverse.
//
//  Deterministic (no RNG/time), fixed-dt, per-car state in a WeakMap keyed by
//  the CarState object (a respawn creates a new object → fresh state).
//  physics.ts is UNTOUCHED — sim-real-2 stays byte-identical.
// =============================================================================
import type { CarState, Inputs } from './physics';

export interface ArcadeParams {
  // L1 thrust
  vTop: number;          // m/s — aspirational top (not reached on the oval)
  aMax: number;          // m/s² — launch punch (~0.87 g)
  aBrake: number;        // m/s² — brake decel
  coastDecel: number;    // m/s² — off-throttle bleed
  // L2 steering (rotation tempo — independent of speed law)
  omegaMax: number;      // rad/s — yaw authority
  vRef: number;          // m/s — below this, rotation scales with speed (no tank-turn)
  tauSteer: number;      // s — steering rise-time = the WEIGHT
  // L3 grip
  kGrip: number;         // 1/s — how fast the path re-aligns (shove decay)
  aLatMax: number;       // m/s² — cornering limit (beyond → the arc widens)
  sMax: number;          // rad — HARD visual slip bound in grip (the projection)
  // L4 drift
  deltaMin: number;      // rad — entry/minimum drift angle
  deltaMax: number;      // rad — full-lock drift angle (hard clamp)
  kDelta: number;        // 1/s — how fast δ chases the steer-set target
  omegaDriftBase: number;// rad/s — drift path turn rate at neutral-ish steer
  omegaDriftGain: number;// rad/s — added path turn rate at full steer-into
  driftBleed: number;    // m/s² — every slide bleeds energy
  driftFeed: number;     // m/s² — full throttle counteracts (≤ bleed → no gain)
  vMinDrift: number;     // m/s — below this the drift force-exits
  kExit: number;         // 1/s — δ→0 rate on exit (quick clean straighten)
  tauBody: number;       // s — heading lag toward φ+δ (collision snap softener)
  driftEnterSteer: number;// |steer| needed (with the e-brake) to enter
  driftExitSteer: number; // |steer| below which the drift exits
  vMinEnter: number;     // m/s — minimum speed to enter a drift
  // L6 reverse
  vRevMax: number;       // m/s
}

// The live-tunable defaults (D-tuner mutates THIS object, like CONFIG).
// Starting values from the approved map-fit envelope (oval corner 19 m/s,
// desktop 10 m gap: grip ≤ 11 m/s or drift through at R ≈ 5.5 m).
export const ARCADE: ArcadeParams = {
  vTop: 45, aMax: 8.5, aBrake: 12, coastDecel: 2.5,
  omegaMax: 1.7, vRef: 4, tauSteer: 0.28,
  kGrip: 6, aLatMax: 12, sMax: 0.157,          // 9°
  deltaMin: 0.26, deltaMax: 0.87, kDelta: 5,   // 15° … 50°
  omegaDriftBase: 0.9, omegaDriftGain: 1.3,
  driftBleed: 3.5, driftFeed: 3.5, vMinDrift: 6, kExit: 8, tauBody: 0.10,
  driftEnterSteer: 0.25, driftExitSteer: 0.15, vMinEnter: 8,
  vRevMax: 7,
};

export function makeArcadeParams(over?: Partial<ArcadeParams>): ArcadeParams {
  return { ...ARCADE, ...(over ?? {}) };
}

// ---- per-car model state (outside CarState → physics.ts untouched) ----
type Mode = 'grip' | 'drift' | 'exit';
interface ArcState {
  mode: Mode;
  delta: number;   // current drift body offset (rad, signed)
  dir: number;     // drift direction (+1/−1)
  phi: number;     // last motion direction (kept through standstill)
  rev: boolean;    // reversing
}
const states = new WeakMap<CarState, ArcState>();
function stateOf(car: CarState): ArcState {
  let s = states.get(car);
  if (!s) {
    s = { mode: 'grip', delta: 0, dir: 1, phi: car.heading, rev: false };
    states.set(car, s);
  }
  return s;
}

const TAU = Math.PI * 2;
function norm(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}
function angDiff(a: number, b: number): number { return norm(a - b); }
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function stepArcade(car: CarState, input: Inputs, dt: number, p: ArcadeParams) {
  const st = stateOf(car);
  const steer = clamp(input.steer, -1, 1);
  const throttle = input.handbrake ? clamp(input.throttle, 0, 1) : clamp(input.throttle, 0, 1);
  const brake = clamp(input.brake, 0, 1);

  // ---- absorb the velocity vector (collisions may have changed it) ----
  let v = Math.hypot(car.vx, car.vy);
  if (v > 0.3) st.phi = Math.atan2(car.vy, car.vx);
  let phi = st.phi;
  let theta = car.heading;

  // reversing = actually moving against the heading
  st.rev = v > 0.3 ? Math.cos(angDiff(phi, theta)) < 0 : st.rev && brake > 0.05;
  const rev = st.rev;
  if (rev && st.mode !== 'grip') { st.mode = 'grip'; st.delta = 0; }  // no drift in reverse

  // ---- L6 REVERSE entry: brake held at ~standstill → back out ----
  if (!rev && v < 0.4 && brake > 0.1 && throttle < 0.05) {
    st.rev = true;
    phi = st.phi = norm(theta + Math.PI);
  }

  // ---- L1 THRUST (speed magnitude; bounded [0, vTop] / [0, vRevMax]) ----
  if (st.rev) {
    // brake pedal = reverse throttle; gas brakes the reverse (then hooks forward)
    v += (brake * 0.5 * p.aMax - throttle * p.aBrake) * dt;
    if (v <= 0.05 && throttle > 0.05) { st.rev = false; phi = st.phi = theta; v = 0; }
    v = clamp(v, 0, p.vRevMax);
  } else if (st.mode === 'drift') {
    // L4 speed: every slide bleeds; throttle feeds but never gains
    v += (-p.driftBleed + throttle * p.driftFeed) * dt;
    v = clamp(v, 0, p.vTop);
  } else {
    const accel = throttle * p.aMax * (1 - Math.min(1, (v / p.vTop) ** 2));
    const decel = brake * p.aBrake + (throttle < 0.05 && brake < 0.05 ? p.coastDecel : 0);
    v = clamp(v + (accel - decel) * dt, 0, p.vTop);
  }

  // ---- state machine: drift enter / exit ----
  if (st.mode === 'grip' && !st.rev
      && input.handbrake && Math.abs(steer) >= p.driftEnterSteer && v >= p.vMinEnter) {
    st.mode = 'drift';
    st.dir = steer >= 0 ? 1 : -1;
    st.delta = st.dir * p.deltaMin;
  }
  if (st.mode === 'drift' && (Math.abs(steer) < p.driftExitSteer || v < p.vMinDrift)) {
    st.mode = 'exit';
  }

  // ---- rotation + path per mode ----
  const alignHead = st.rev ? norm(theta + Math.PI) : theta;   // motion-side heading

  if (st.mode === 'grip' || st.mode === 'exit') {
    if (st.mode === 'exit') {
      // δ decays quickly; hand over to grip once inside the slip bound
      st.delta += (0 - st.delta) * Math.min(1, p.kExit * dt);
      if (Math.abs(st.delta) < p.sMax) { st.mode = 'grip'; st.delta = 0; }
    }
    // L2: weighted steering (reverse mirrors)
    const wCmd = steer * p.omegaMax * Math.min(1, v / p.vRef) * (st.rev ? -1 : 1);
    car.angularVel += (wCmd - car.angularVel) * Math.min(1, dt / p.tauSteer);
    theta = norm(theta + car.angularVel * dt);

    // L3: the path chases the heading, capped by the cornering limit
    const align = st.rev ? norm(theta + Math.PI) : theta;
    const dphi = clamp(p.kGrip * Math.sin(angDiff(align, phi)),
      -p.aLatMax / Math.max(v, 1), p.aLatMax / Math.max(v, 1));
    phi = norm(phi + dphi * dt);

    // FIX 1 — THE PROJECTION (slip invariant): |heading − path| ≤ sMax + |δ_exit|.
    // In pure grip the bound is sMax; during exit it shrinks with δ so the
    // handover is seamless (no snap).
    const bound = p.sMax + Math.abs(st.delta);
    const slip = angDiff(st.rev ? norm(theta + Math.PI) : theta, phi);
    const clipped = clamp(slip, -bound, bound);
    if (clipped !== slip) theta = norm(theta - (slip - clipped));
  } else {
    // ---- L4 DRIFT ----
    const into = clamp(steer * st.dir, 0, 1);          // steer INTO the drift 0..1
    const target = st.dir * (p.deltaMin + into * (p.deltaMax - p.deltaMin));
    st.delta += (target - st.delta) * Math.min(1, p.kDelta * dt);
    st.delta = clamp(st.delta, -p.deltaMax, p.deltaMax);   // hard envelope

    // the PATH carves in the drift direction; steering-into tightens the arc
    const wPath = st.dir * (p.omegaDriftBase + into * p.omegaDriftGain);
    phi = norm(phi + wPath * dt);

    // FIX 3 — body lag: heading CHASES φ+δ (τ_body); collision ω-impulses live
    // in car.angularVel and decay through this same relaxation — big hits turn
    // the body smoothly instead of teleporting it.
    const rateDes = angDiff(norm(phi + st.delta), theta) / p.tauBody;
    car.angularVel += (rateDes - car.angularVel) * Math.min(1, dt / p.tauBody);
    theta = norm(theta + car.angularVel * dt);
  }

  // ---- integrate translation ----
  const mx = Math.cos(phi), my = Math.sin(phi);
  car.vx = v * mx;
  car.vy = v * my;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.heading = theta;
  st.phi = phi;

  // rest snap: everything idle below walking pace → truly parked
  if (v < 0.15 && throttle < 0.05 && brake < 0.05 && !input.handbrake) {
    v = 0; car.vx = 0; car.vy = 0; car.angularVel = 0; st.rev = false;
  }

  // ---- synthesize the consumer fields (render / effects / HUD / sound / XP) ----
  const drifting = st.mode === 'drift';
  car.speed = v;
  car.forwardSpeed = st.rev ? -v : v;
  car.steerAngle = steer * 0.6;                       // front-tyre draw angle
  const slipNow = v > 0.5 ? angDiff(alignHead, phi) : 0;
  car.rearSlip = drifting ? angDiff(theta, phi) : slipNow;  // skids/smoke/XP read this
  car.frontSlip = car.rearSlip;
  car.isRearSliding = drifting;
  car.wheelSpin = drifting ? throttle * 0.8 : 0;      // smoke intensity; launch = 0 (no lottery)
  car.rearWheelSpeed = v * (1 + 0.3 * car.wheelSpin); // sound rpm proxy
  car.driftActive = drifting;
  car.spinTimer = 0;
  car.slipRatio = car.wheelSpin;
}
