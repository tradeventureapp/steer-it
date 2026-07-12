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
  deltaMax: number;      // rad — full-lock STEER-set drift angle (the drift envelope)
  kDelta: number;        // 1/s — how fast δ chases the steer-set target
  omegaDriftBase: number;// rad/s — drift path turn rate at neutral-ish steer
  omegaDriftGain: number;// rad/s — added path turn rate at full steer-into
  driftBleed: number;    // m/s² — every slide bleeds energy
  driftFeedCap: number;  // 0..0.95 — throttle offsets AT MOST this fraction of the
                         //   bleed (dv/dt < 0 in drift ALWAYS — a slide can't boost)
  vMinDrift: number;     // m/s — below this the drift force-exits
  kExit: number;         // 1/s — δ→0 rate on exit (quick clean straighten)
  tauBody: number;       // s — heading lag toward φ+δ (collision snap softener)
  driftExitSteer: number; // |steer| below which a ROLLING slide exits (regrips)
  // handbrake = LOCKED REAR WHEELS (the mechanism — everything follows from it):
  // held ⇒ strong friction braking ALWAYS (straight+slow+lever = the car brakes,
  // THE test) + the rear loses lateral hold ⇒ moving with any turn, the rear
  // SWINGS OUT (the angle closes/tightens) — drift is a CONSEQUENCE, not a state
  // you "enter". Throttle can't spin stopped wheels: the lock DOMINATES throttle.
  hbDecel: number;       // m/s² — locked-wheel friction braking (always while held)
  hbSwingRate: number;   // rad/s — how fast the locked rear swings the angle out
  // SPINOUT — overrotation exists: tighten past deltaSpin and the car spins out
  deltaSpin: number;     // rad — past this the drift breaks into a spin-out
  spinYaw: number;       // rad/s — spin-out initial rotation rate
  spinDecay: number;     // 1/s — exponential ω decay → TOTAL rotation = spinYaw/spinDecay (finite)
  spinBleed: number;     // m/s² — a spin scrubs speed hard
  // L6 reverse
  vRevMax: number;       // m/s
}

// The live-tunable defaults (D-tuner mutates THIS object, like CONFIG).
// Starting values from the approved map-fit envelope, re-fit to the pxm-7.5
// world (256 m, F = 1.333 vs the old 192 m / pxm 10). The LINEAR knobs (speeds
// m/s, accels m/s²) are scaled × F so the on-screen tempo / corner px·s / drift
// & donut px / launch are IDENTICAL to the pxm-10 build — only the car is
// smaller (33 px). The ANGULAR / RATE knobs (ωMax, τ_steer, kGrip, kDelta, the
// δ angles, hbSwingRate, ωDrift*, spin rates, sMax) are UNCHANGED (rotation is
// scale-free — scaling them would change the tempo). Model LAWS unchanged.
// oval corner ~25.7 m/s @ R41, desktop 13.3 m gap: grip ≤ 14.6 m/s or drift R ≈ 7.3 m.
export const ARCADE: ArcadeParams = {
  vTop: 60, aMax: 11.33, aBrake: 16, coastDecel: 3.33,   // × F (linear)
  omegaMax: 1.7, vRef: 5.33, tauSteer: 0.28,             // vRef × F; ωMax/τ unchanged
  kGrip: 6, aLatMax: 16, sMax: 0.157,                    // aLatMax × F; kGrip/sMax unchanged (9°)
  deltaMin: 0.26, deltaMax: 0.87, kDelta: 5,             // angles/rate unchanged (15° … 50°)
  omegaDriftBase: 0.9, omegaDriftGain: 1.3,              // rad/s — unchanged
  driftBleed: 4.67, driftFeedCap: 0.7,                   // driftBleed × F; cap unitless
  vMinDrift: 8, kExit: 8, tauBody: 0.10,                 // vMinDrift × F; kExit/τ unchanged
  driftExitSteer: 0.15,
  hbDecel: 8, hbSwingRate: 0.9,                          // hbDecel × F; swing rate unchanged
  deltaSpin: 1.05, spinYaw: 4.5, spinDecay: 0.8, spinBleed: 8,  // spinBleed × F; angles/rates unchanged
  vRevMax: 9.33,                                         // × F
};

export function makeArcadeParams(over?: Partial<ArcadeParams>): ArcadeParams {
  return { ...ARCADE, ...(over ?? {}) };
}

// ---- per-car model state (outside CarState → physics.ts untouched) ----
type Mode = 'grip' | 'drift' | 'spinout' | 'exit';
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
const EXIT_RATE_CAP = 3.5;   // rad/s — max δ unwind rate on exit (spin-like, no snap)
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
  if (v > 0.4) st.phi = Math.atan2(car.vy, car.vx);   // low-speed gates × F (pxm-7.5 world)
  let phi = st.phi;
  let theta = car.heading;

  // reversing = actually moving against the heading — evaluated ONLY in grip/exit
  // (a drift/spin-out body legitimately points >90° off the path; that's the
  // slide, not reverse — detecting it as reverse would kill the spin mid-way).
  if (st.mode === 'grip') {
    st.rev = v > 0.4 ? Math.cos(angDiff(phi, theta)) < 0 : st.rev && brake > 0.05;
  }
  const rev = st.rev;
  if (rev && st.mode !== 'grip') { st.mode = 'grip'; st.delta = 0; }  // no drift in reverse

  // ---- L6 REVERSE entry: brake held at ~standstill → back out ----
  if (!rev && v < 0.53 && brake > 0.1 && throttle < 0.05) {
    st.rev = true;
    phi = st.phi = norm(theta + Math.PI);
  }

  // ---- L1 THRUST (speed magnitude; bounded [0, vTop] / [0, vRevMax]) ----
  if (st.rev) {
    // brake pedal = reverse throttle; gas brakes the reverse (then hooks forward)
    v += (brake * 0.5 * p.aMax - throttle * p.aBrake) * dt;
    if (v <= 0.067 && throttle > 0.05) { st.rev = false; phi = st.phi = theta; v = 0; }
    v = clamp(v, 0, p.vRevMax);
  } else if (st.mode === 'spinout') {
    // a spin scrubs speed hard; throttle does nothing while spinning
    v = clamp(v - p.spinBleed * dt, 0, p.vTop);
  } else if (st.mode === 'drift') {
    // L4 speed INVARIANT: dv/dt < 0 in a slide ALWAYS. REGIME decides the terms:
    // LOCKED (lever held) DOMINATES throttle — stopped wheels can't be driven →
    // feed = 0 + locked-wheel braking. SPINNING (throttle, no lever): the drive
    // FEEDS the slide, capped at driftFeedCap (<1) of the bleed — a slide is
    // sustained, never accelerated.
    const feed = input.handbrake ? 0
      : throttle * clamp(p.driftFeedCap, 0, 0.95) * p.driftBleed;
    const hb = input.handbrake ? p.hbDecel : 0;
    v = clamp(v + (-p.driftBleed + feed - hb) * dt, 0, p.vTop);
  } else {
    const accel = throttle * p.aMax * (1 - Math.min(1, (v / p.vTop) ** 2));
    const decel = brake * p.aBrake + (throttle < 0.05 && brake < 0.05 ? p.coastDecel : 0)
      + (input.handbrake ? p.hbDecel : 0);   // e-brake BRAKES in grip too (locked wheels)
    v = clamp(v + (accel - decel) * dt, 0, p.vTop);
  }

  // ---- REAR-WHEEL REGIME → thin state machine (drift = a CONSEQUENCE) ----
  // LOCKED (lever held): the rear has no lateral hold. Moving with ANY turn
  // intent (steer OR existing yaw), the rear SWINGS OUT → the slide begins as
  // a consequence — no steer threshold, no speed gate. STRAIGHT + lever = the
  // car just BRAKES (the boss's test): no turn direction → nothing to swing.
  if (st.mode === 'grip' && !st.rev && input.handbrake && v > 2.0) {
    const dir = Math.abs(steer) > 0.05 ? Math.sign(steer)
      : Math.abs(car.angularVel) > 0.25 ? Math.sign(car.angularVel) : 0;
    if (dir !== 0) {
      st.mode = 'drift';
      st.dir = dir;
      st.delta = st.dir * 0.06;   // the swing STARTS small and GROWS (mechanism, not a jump)
    }
  }
  if (st.mode === 'drift') {
    // OVERROTATION: swung past the envelope → SPIN-OUT (finite by construction:
    // ω decays exponentially → total rotation = spinYaw/spinDecay rad; speed
    // scrubs at spinBleed → the spin always terminates).
    if (Math.abs(st.delta) >= p.deltaSpin) {
      st.mode = 'spinout';
      const w0 = st.dir * p.spinYaw;
      car.angularVel = Math.abs(car.angularVel) > Math.abs(w0) ? car.angularVel : w0;
    } else if (!input.handbrake && (Math.abs(steer) < p.driftExitSteer || v < p.vMinDrift)) {
      st.mode = 'exit';   // rolling rear + steer to centre / slide spent → regrips
    } else if (input.handbrake && v < 1.33) {
      st.mode = 'exit';   // locked down to a crawl → parked, not sliding
    }
  }

  // ---- rotation + path per mode ----
  const alignHead = st.rev ? norm(theta + Math.PI) : theta;   // motion-side heading

  if (st.mode === 'grip' || st.mode === 'exit') {
    if (st.mode === 'exit') {
      // δ decays quickly; RATE-CAPPED so a big spin residual unwinds at a
      // spin-like rate instead of snapping (exponential kExit alone would pull
      // 16 rad/s on a 120° residual). Hand over to grip inside the slip bound.
      const dRate = Math.min(p.kExit * Math.abs(st.delta), EXIT_RATE_CAP);
      st.delta -= Math.sign(st.delta) * Math.min(Math.abs(st.delta), dRate * dt);
      if (Math.abs(st.delta) < p.sMax) { st.mode = 'grip'; st.delta = 0; }
    }
    // L2: weighted steering (reverse mirrors)
    const wCmd = steer * p.omegaMax * Math.min(1, v / p.vRef) * (st.rev ? -1 : 1);
    car.angularVel += (wCmd - car.angularVel) * Math.min(1, dt / p.tauSteer);
    theta = norm(theta + car.angularVel * dt);

    // L3: the path chases the heading, capped by the cornering limit
    const align = st.rev ? norm(theta + Math.PI) : theta;
    const dphi = clamp(p.kGrip * Math.sin(angDiff(align, phi)),
      -p.aLatMax / Math.max(v, 1.33), p.aLatMax / Math.max(v, 1.33));   // speed floor × F
    phi = norm(phi + dphi * dt);

    // FIX 1 — THE PROJECTION (slip invariant): |heading − path| ≤ sMax + |δ_exit|.
    // In pure grip the bound is sMax; during exit it shrinks with δ so the
    // handover is seamless (no snap).
    const bound = p.sMax + Math.abs(st.delta);
    const slip = angDiff(st.rev ? norm(theta + Math.PI) : theta, phi);
    const clipped = clamp(slip, -bound, bound);
    if (clipped !== slip) theta = norm(theta - (slip - clipped));
  } else if (st.mode === 'spinout') {
    // ---- SPIN-OUT: the body spins free of the path; ω decays exponentially
    // (total rotation FINITE = spinYaw/spinDecay), speed scrubs hard (L1), the
    // path keeps its momentum direction. Recover: ω spent → hand over to exit.
    car.angularVel -= car.angularVel * Math.min(1, p.spinDecay * dt);
    theta = norm(theta + car.angularVel * dt);
    if (Math.abs(car.angularVel) < 0.8 || v < 1) {
      // hand the FULL residual angle to exit (no clamp — clamping would make the
      // grip projection snap the body by the difference = a rotation teleport);
      // kExit relaxes it to zero smoothly, the projection bound follows |δ|.
      st.delta = angDiff(theta, phi);
      st.mode = 'exit';
    }
  } else {
    // ---- L4 SLIDE — the body angle is driven by the rear-wheel REGIME ----
    const into = clamp(steer * st.dir, 0, 1);          // steer INTO the drift 0..1
    if (input.handbrake) {
      // LOCKED: no lateral hold at the rear — it keeps SWINGING OUT (the angle
      // closes/tightens) while the lever brakes (L1). The unbounded growth IS
      // the risk: crossing deltaSpin breaks into the spin-out.
      st.delta += st.dir * p.hbSwingRate * Math.min(1, v / 10.67) * dt;
    } else {
      // ROLLING/SPINNING: steering AIMS the angle (throttle feeds the slide in
      // L1); the target is hard-bounded by the drift envelope.
      const target = st.dir * (p.deltaMin + into * (p.deltaMax - p.deltaMin));
      st.delta += (target - st.delta) * Math.min(1, p.kDelta * dt);
    }
    st.delta = clamp(st.delta, -p.deltaSpin - 0.05, p.deltaSpin + 0.05);

    // the PATH carves in the drift direction; steering-into tightens the arc
    // (and the hb speed-scrub shrinks R = v/ω geometrically — the felt tighten)
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
  if (v < 0.2 && throttle < 0.05 && brake < 0.05 && !input.handbrake) {
    v = 0; car.vx = 0; car.vy = 0; car.angularVel = 0; st.rev = false;
  }

  // ---- synthesize the consumer fields (render / effects / HUD / sound / XP) ----
  const sliding = st.mode === 'drift' || st.mode === 'spinout';
  car.speed = v;
  car.forwardSpeed = st.rev ? -v : v;
  car.steerAngle = steer * 0.6;                       // front-tyre draw angle
  const slipNow = v > 0.5 ? angDiff(alignHead, phi) : 0;
  car.rearSlip = sliding ? angDiff(theta, phi) : slipNow;   // skids/smoke/XP read this
  car.frontSlip = car.rearSlip;
  car.isRearSliding = sliding;
  car.wheelSpin = st.mode === 'drift' ? throttle * 0.8
    : st.mode === 'spinout' ? 0.6 : 0;                // smoke blazes in a spin; launch = 0
  car.rearWheelSpeed = v * (1 + 0.3 * car.wheelSpin); // sound rpm proxy
  car.driftActive = sliding;
  car.spinTimer = st.mode === 'spinout' ? 1 : 0;      // HUD: the spin is visible state
  car.slipRatio = car.wheelSpin;
}
