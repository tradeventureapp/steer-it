// =============================================================================
//  physics4.ts — FASE 0: the 4-wheel (per-wheel) vehicle FOUNDATION.
//
//  Replaces the 2-axle bicycle model's ceiling. Four contact patches, each with
//  its OWN load (static split + longitudinal & lateral transfer), its own
//  load-based grip WITH DIMINISHING RETURNS (tire load sensitivity), its own
//  slip angle (relaxation-length filtered), and a Magic-Formula lateral force
//  inside a friction ellipse. The forces sum to net translation + a yaw torque
//  about the CoM — so yaw now emerges from FRONT/REAR *and* LEFT/RIGHT grip
//  differences (the bicycle model could only do front/rear).
//
//  FASE 0 SCOPE: no drive, no brake, no handbrake (Fase 1), no forward thrust
//  (Fase 2). The car is THROWN at speed and you feel it corner with weight,
//  load transfer, and break-loose. Longitudinal wheel force Fx = 0 here; the
//  friction-ellipse structure is built (generous longitudinal axis) so Fase 1
//  drive/brake plugs straight in and the drift CARRIES speed (the sim-real
//  speed-bleed failure mode is designed out — fully verified in Fase 1).
//
//  Heading is an INDEPENDENT state integrated from yaw (θ += ω·dt) — NOT
//  re-derived from velocity — so a collision impulse into vx/vy cannot swap the
//  nose (the arcade model's 171° end-swap does NOT recur here).
//
//  Per-car state (relaxation slip + prev-frame accel for load transfer) lives
//  in a WeakMap keyed by the CarState object → physics.ts is UNTOUCHED, multi-
//  car safe, deterministic, respawn = fresh state.
// =============================================================================
import { CONFIG, type CarState, type Inputs } from './physics';

export interface Physics4Params {
  massKg: number;             // 1200
  weightDistFront: number;    // 0..1 static front-axle load fraction (0.52 = front-biased RWD)
  cgHeight: number;           // m — CoG height (load-transfer arm) (0.5)
  yawInertiaK: number;        // m — radius of gyration → Iz = mass·k² (1.25 → ~1875)
  loadTransferLongGain: number;  // × the physical longitudinal transfer (1.0)
  loadTransferLatGain: number;   // × the physical lateral transfer (1.0)
  muNom: number;              // nominal peak grip coefficient at static load (1.5 asphalt)
  loadSensitivity: number;    // μ falls by this × the relative load excess (0.15) — THE drama
  tireB: number;              // Magic-Formula stiffness (slope at 0) (~11)
  tireC: number;              // Magic-Formula shape (peak-then-falloff) (~1.5)
  tireEllipseLong: number;    // longitudinal friction-ellipse semi-axis scale (generous, 1.0)
  relaxLength: number;        // m — tire relaxation length (slip builds over this distance) (0.5)
  lowSpeedBlend: number;      // m/s — below this, blend toward a kinematic model (2.5)
  maxSteer: number;           // rad — physical front steer lock (0.52 ≈ 30°)
  // ---- FASE 1 drive tools (all through the per-wheel friction circle) ----
  // SHAPED accel curve (no gears): drive = throttle · min(peakThrust, enginePower/max(v,vFloor)).
  // Torque-limited (flat peakThrust) low → power-limited (∝1/v) high = punchy + flattening.
  peakThrust: number;         // N — max drive force at the rear axle (low-speed torque limit) (9000)
  enginePower: number;        // W — peak power (~172 kW ≈ 230 hp) → the ∝1/v taper (172000)
  powerFloorSpeed: number;    // m/s — v floor in enginePower/v so low speed = flat peakThrust (5)
  rollRadius: number;         // m — wheel rolling radius (0.30)
  wheelInertia: number;       // kg·m² — rear wheel + engine/drivetrain reflected inertia (22 — big = stable, no launch spin-up oscillation)
  brakeForce: number;         // N — peak brake force (both axles combined) (14000)
  brakeBiasFront: number;     // 0..1 — front share of braking (0.6)
  tireBx: number;             // Magic-Formula LONGITUDINAL stiffness (18)
  tireCx: number;             // Magic-Formula longitudinal shape (1.6)
  hbKineticMu: number;        // locked-rear kinetic-scrub fraction of the grip budget (0.9)
  // ---- coast forces (bleed speed at throttle 0) ----
  dragCoef: number;           // aero drag: Fdrag = dragCoef·v² (N per (m/s)²) (0.8)
  rollResist: number;         // rolling resistance: constant force opposing motion (N) (200)
  engineBrakeTorque: number;  // closed-throttle drag torque on the rear wheels (N·m) (500)
  // ---- DRIFT SUSTAIN: fade engine-braking + wheel inertia as the rear SLIDES
  // (gated on LATERAL slip → a straight-line launch burnout is NOT a slide) so
  // partial throttle gives progressive wheelspin = a held drift angle. ----
  engineBrakeSlideFade: number;   // 0..1 — how much engine-braking-the-CAR fades in a full slide (0.9)
  wheelInertiaSlideFactor: number;// 0..1 — fraction of wheel inertia kept in a full slide (0.55)
  wheelReturnRate: number;        // 1/s — at low throttle the wheel SPINS DOWN to rolling (κ→0 →
                                  // rear regrips → the drift WINDS DOWN on lift, NOT spins); this
                                  // spin-down is NOT faded in a slide (unlike car-braking) (10)
  driftYawDamp: number;           // N·m·s/rad — mild SLIDE-GATED yaw damping (widens the stable
                                  // hold band so a drift SETTLES at an angle instead of spinning;
                                  // physical = the tyres' relaxation resisting yaw; 0 = off) (500 — low-mid throttle + counter-steer HOLDS a drift, excess SPINS; a skill window)
  // ---- reverse (stopped + brake held) ----
  reverseSpeed: number;       // m/s — reverse speed cap (9 ≈ 32 km/h, brisk RWD-coupe reverse)
  reverseForce: number;       // N — reverse drive force (brake pedal = reverse throttle) (10000)
  reverseDelay: number;       // s — brake-held-while-stopped delay before reverse engages (0.5)
}

// D-tunable defaults (the boss tunes these live; mutated in place like CONFIG).
// GROUP A SIM (E30 M3 Group A / DTM ref — public name Blitz RS): a realistic
// early-90s circuit race special. High realistic slick grip, decisive breakaway,
// race brakes, ~1020 kg stripped weight, 370 hp. The honest per-wheel sim
// benchmark (a separate forgiving ARCADE car is built on top later).
export const PHYS4: Physics4Params = {
  massKg: 1020,            // Group A stripped race weight (was 1200)
  weightDistFront: 0.50,   // ~50/50 → neutral-mild-understeer at the limit
  cgHeight: 0.45,          // lowered race car → less load transfer → planted
  yawInertiaK: 1.20,       // Iz = 1020·1.20² ≈ 1469 (agile; was 1875)
  loadTransferLongGain: 1.0,
  loadTransferLatGain: 1.0,
  muNom: 1.90,             // race slicks: outer wheels hold ~1.6g → grips hard
  loadSensitivity: 0.12,   // slicks are more consistent under load (planted)
  tireB: 14,               // slick: sharper rise to peak (stiffer, peak ~5.7°)
  tireC: 1.65,             // slick: DECISIVE peak-then-falloff (a real edge, not padded)
  tireEllipseLong: 1.0,
  relaxLength: 0.5,
  lowSpeedBlend: 2.5,
  maxSteer: 0.52,
  // 370 hp RACE SPECIAL
  peakThrust: 13000,       // sharp low-end punch + willing power-over
  enginePower: 276000,     // 276 kW ≈ 370 hp
  powerFloorSpeed: 5,
  rollRadius: 0.30,
  wheelInertia: 22,
  brakeForce: 13500,       // race brakes @1020 kg — measured 1.21g (see note; 15000 = 1.34g)
  brakeBiasFront: 0.6,     // front-biased → trail-braking rotates (real load transfer)
  tireBx: 18,
  tireCx: 1.6,
  hbKineticMu: 0.9,
  dragCoef: 0.8,
  rollResist: 200,
  engineBrakeTorque: 500,
  engineBrakeSlideFade: 0.9,
  wheelInertiaSlideFactor: 0.55,
  wheelReturnRate: 10,
  driftYawDamp: 375,       // re-tuned 500→375 for the lower Iz (1469 vs 1875)
  reverseSpeed: 9,        // m/s ≈ 32 km/h — a real RWD coupe reverses briskly
  reverseForce: 10000,    // N → ~8.3 m/s² backward = quick pickup, not a crawl
  reverseDelay: 0.5,
};

const MU_FLOOR = 0.3;         // μ never collapses to ≤0 under huge load
const SLIP_LONG_FLOOR = 0.5;  // m/s — |vlong| floor for the slip-angle atan (relaxation also guards)
// DRIFT-SUSTAIN fade window on the rear LATERAL slip angle (rad): the fades ramp
// in SMOOTHLY between these (no jerk on entry/exit) and are keyed on LATERAL slip
// so a straight launch burnout (longitudinal slip, ~0 lateral) never triggers them.
const SLIDE_SLIP_LO = 0.15;  // ~9° — fade starts
const SLIDE_SLIP_HI = 0.40;  // ~23° — full slide (fades at max)

// ---- per-car state (physics.ts untouched) ----
interface P4State {
  // relaxation-length filtered slip angle per wheel: FL, FR, RL, RR
  slip: [number, number, number, number];
  prevAx: number;   // prev-frame body-frame longitudinal accel (load transfer)
  prevAy: number;   // prev-frame body-frame lateral accel
  // rear wheel angular velocity (rad/s): RL, RR — drive/brake/handbrake act here
  rearOmega: [number, number];
  initd: boolean;   // rear omega seeded to free-rolling on the first step
  reversing: boolean;    // low-speed reverse mode (stopped + brake held)
  brakeHoldT: number;    // s — brake held while stopped (arms reverse after reverseDelay)
  // last-frame debug for HUD / verification (per wheel)
  load: [number, number, number, number];
  slipRatio: [number, number];   // rear longitudinal slip ratio (wheelspin/lock)
}
const states = new WeakMap<CarState, P4State>();
function stateOf(car: CarState): P4State {
  let s = states.get(car);
  if (!s) {
    s = {
      slip: [0, 0, 0, 0], prevAx: 0, prevAy: 0,
      rearOmega: [0, 0], initd: false,
      reversing: false, brakeHoldT: 0,
      load: [0, 0, 0, 0], slipRatio: [0, 0],
    };
    states.set(car, s);
  }
  return s;
}
export function wheelDebug(car: CarState): P4State | undefined { return states.get(car); }

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

// wheel order: 0 FL, 1 FR, 2 RL, 3 RR
export function step4(car: CarState, input: Inputs, dt: number, p: Physics4Params = PHYS4) {
  const st = stateOf(car);
  const WB = CONFIG.wheelbase;      // one ruler
  const T = CONFIG.trackWidth;
  const m = p.massKg;
  const g = 9.81;
  const Iz = m * p.yawInertiaK * p.yawInertiaK;

  // ---- geometry: CoM→axle distances + the 4 body-frame contact points ----
  // front axle load fraction = lr/WB → lr = weightDistFront·WB (CoM sits toward
  // the heavier axle). lf = (1−weightDistFront)·WB.
  const lr = p.weightDistFront * WB;    // CoM → REAR axle
  const lf = (1 - p.weightDistFront) * WB;  // CoM → FRONT axle
  const rx = [lf, lf, -lr, -lr];        // body x (forward +)
  const ry = [-T / 2, T / 2, -T / 2, T / 2]; // body y (right +)

  // static per-wheel load
  const FzF = p.weightDistFront * m * g / 2;   // each front wheel
  const FzR = (1 - p.weightDistFront) * m * g / 2; // each rear wheel
  const FzStatic = [FzF, FzF, FzR, FzR];

  // ---- body-frame velocity ----
  const h = car.heading, cos = Math.cos(h), sin = Math.sin(h);
  const vbx = car.vx * cos + car.vy * sin;    // body longitudinal
  const vby = -car.vx * sin + car.vy * cos;   // body lateral (right +)
  const v = Math.hypot(car.vx, car.vy);
  const w = car.angularVel;

  const throttle = clamp(input.throttle, 0, 1);
  const brake = clamp(input.brake, 0, 1);
  const hb = input.handbrake;
  const rr = p.rollRadius;

  // ---- REVERSE gating: engages ONLY after the car is fully STOPPED and the
  // brake is HELD (no throttle, no handbrake) for reverseDelay (~0.5 s) → a
  // normal braking stop / a wall-bump-with-brake NEVER reverses (the timer only
  // runs while stopped and resets the instant the car moves or the brake lifts).
  if (!st.reversing) {
    if (v < 0.5 && brake > 0.5 && throttle < 0.05 && !hb) st.brakeHoldT += dt;
    else st.brakeHoldT = 0;
    if (st.brakeHoldT >= p.reverseDelay) { st.reversing = true; st.brakeHoldT = 0; }
  } else {
    // exit reverse: throttle applied → forward; or brake released near standstill
    if (throttle > 0.05 || (brake < 0.05 && v < 0.5)) st.reversing = false;
  }
  const reversing = st.reversing;
  // in reverse the brake pedal is the REVERSE throttle → it must NOT also brake
  const brakeEff = reversing ? 0 : brake;
  // steering mirrors in reverse so it feels natural backing up
  const steer = clamp(input.steer, -1, 1) * (reversing ? -1 : 1);
  const delta = [steer * p.maxSteer, steer * p.maxSteer, 0, 0]; // fronts steer, rears fixed

  // ---- LOAD TRANSFER (from PREV-frame body accel — no algebraic loop) ----
  // ΔFz_long = m·ax·h/WB (accel → rear, brake → front). ΔFz_lat = m·ay·h/T
  // (→ outer wheels). Clamped to ±static so a cold-start accel spike can't
  // invert the load; per-wheel Fz clamped ≥ 0 (a lifted wheel carries nothing).
  const dLong = clamp(m * st.prevAx * p.cgHeight / WB * p.loadTransferLongGain,
    -(FzF + FzR), (FzF + FzR));
  const dLat = m * st.prevAy * p.cgHeight / T * p.loadTransferLatGain;

  // seed rear wheel speed to free-rolling on the first step (a thrown/reclaimed
  // car isn't braking its own rear); afterwards the dynamics own it.
  if (!st.initd) { st.rearOmega = [vbx / rr, vbx / rr]; st.initd = true; }

  // ---- SHAPED accel curve (no gears): one smooth torque-vs-speed force —
  // torque-limited (flat peakThrust) at low speed = punchy pull, power-limited
  // (∝ enginePower/v) toward top = flattening. ANALOG: drive = throttle × curve
  // (throttle is 0..1, linear → half throttle = half force → feeds the drift
  // angle). Forward only; reverse is its own low-speed force below.
  const driveForceAxle = reversing ? 0
    : throttle * Math.min(p.peakThrust, p.enginePower / Math.max(v, p.powerFloorSpeed));
  const driveTorquePerRear = (driveForceAxle / 2) * rr;

  // ---- per-wheel forces (body frame) + accumulate net force & yaw torque ----
  let Fbx = 0, Fby = 0, Tz = 0;
  const slipOut: number[] = [0, 0, 0, 0];
  const loadOut: number[] = [0, 0, 0, 0];
  const rearFx: [number, number] = [0, 0];   // delivered longitudinal (for ω integration)
  const rearVlong: [number, number] = [0, 0];
  let rearSaturated = false;

  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    // longitudinal load transfer: fronts lose under accel, rears gain
    const dz = (front ? -dLong : dLong) / 2;
    // lateral load transfer: outer wheel loads. Outer side = sign opposite ay.
    const dzLat = -Math.sign(ry[i]) * (dLat) / 2 * (ry[i] === 0 ? 0 : 1);
    let Fz = FzStatic[i] + dz + dzLat;
    Fz = Math.max(0, Fz);
    loadOut[i] = Fz;

    // contact-point velocity (body): v_cm + ω × r
    const vwx = vbx - w * ry[i];
    const vwy = vby + w * rx[i];
    // rotate into wheel frame (−δ)
    const cd = Math.cos(delta[i]), sd = Math.sin(delta[i]);
    const vlong = vwx * cd + vwy * sd;
    const vlat = -vwx * sd + vwy * cd;

    // raw slip angle (opposes lateral velocity), relaxation-length filtered so
    // it can't spike at low speed (the classic per-wheel killer).
    const alphaRaw = Math.atan2(vlat, Math.max(Math.abs(vlong), SLIP_LONG_FLOOR));
    const relaxBlend = clamp(Math.abs(vlong) * dt / p.relaxLength, 0, 1);
    st.slip[i] += (alphaRaw - st.slip[i]) * relaxBlend;
    const alpha = st.slip[i];
    slipOut[i] = alpha;

    // grip = f(load) with DIMINISHING RETURNS (tire load sensitivity)
    const mu = Math.max(MU_FLOOR,
      p.muNom - p.loadSensitivity * (Fz - FzStatic[i]) / FzStatic[i]);
    const D = mu * Fz;   // this wheel's grip budget

    // Magic-Formula lateral (peak-then-falloff = the kinetic/drift regime).
    // OVERRIDDEN for a LOCKED rear below (a locked wheel scrubs, it doesn't roll).
    let Fy = -D * Math.sin(p.tireC * Math.atan(p.tireB * alpha));
    let Fx = 0;
    const lockedRear = !front && hb;

    if (front) {
      // fronts: brake only (not driven). Brake force opposes motion, capped by
      // grip via the ellipse below → ABS-like (front locks only at full pedal).
      const fBrake = brakeEff * p.brakeForce * p.brakeBiasFront / 2;
      Fx = -Math.sign(vlong) * fBrake;
    } else if (lockedRear) {
      // HANDBRAKE = LOCKED rear: the whole contact patch SLIDES on the ground,
      // so the force is KINETIC friction = the full grip budget (× hbKineticMu)
      // directed OPPOSITE the contact slip velocity — NOT the rolling MF(κ),
      // which sat at only 0.66·D at full lock and left the rear gripping. This
      // consumes the ENTIRE circle → lateral COLLAPSES (drift entry / the tail
      // swings out) and Fx is the full along-motion brake (dv/dt<0, deeper).
      const slipMag = Math.max(Math.hypot(vlong, vlat), 1);
      const Dkin = D * p.hbKineticMu;
      Fx = -Dkin * vlong / slipMag;
      Fy = -Dkin * vlat / slipMag;                 // overrides the slip-angle lateral
      st.slipRatio[i - 2] = -Math.sign(vlong);     // full slip (smoke / HUD)
    } else if (reversing) {
      // REVERSE: the rear wheel free-rolls backward with the car (no drive,
      // ω clamped ≥0 would otherwise fight the reverse) → zero longitudinal tyre
      // force; the reverse BODY force provides the propulsion. Lateral (Fy) stays.
      Fx = 0;
      st.slipRatio[i - 2] = 0;
    } else {
      const ri = i - 2;   // 0=RL, 1=RR
      // longitudinal slip ratio (bounded denominator → no low-speed blow-up)
      const kappa = (st.rearOmega[ri] * rr - vlong) / Math.max(Math.abs(vlong), 3);
      st.slipRatio[ri] = kappa;
      Fx = D * Math.sin(p.tireCx * Math.atan(p.tireBx * kappa));
      // rear brake force adds into the longitudinal demand (also via the circle)
      Fx += -Math.sign(vlong) * brakeEff * p.brakeForce * (1 - p.brakeBiasFront) / 2;
    }

    // ---- FRICTION ELLIPSE (the one principle): the tire's grip budget D is
    // shared between Fx and Fy. Generous longitudinal axis (tireEllipseLong) so
    // a deep drift keeps FORWARD BITE → the drift CARRIES speed (the sim-real
    // speed-bleed failure mode designed out). Over budget → both scale down:
    // throttle's Fx eats the circle → rear lateral drops → power-oversteer.
    // SKIPPED for the locked rear — it's already at the full budget by construction.
    // A LOCKED rear only counts as "sliding" (smoke/skid) when it is actually
    // SCRUBBING across the ground (v above a small threshold) — a stationary
    // handbrake has zero contact slip → no scrub → no smoke.
    let rearSat = lockedRear && v > 0.6;
    if (!lockedRear) {
      const demand = Math.hypot(Fx / (D * p.tireEllipseLong || 1), Fy / (D || 1));
      if (demand > 1) { Fx /= demand; Fy /= demand; }
      // "sliding" (smoke/skid) only when the tyre is GENUINELY over its budget
      // (demand > 1.1) — a car cornering near the limit (demand ~1.0, β ~1°) is
      // still GRIPPING and must NOT smoke (the eager 0.98 flagged a gripped 1.3g
      // corner as a slide → looked like "losing grip at 50 km/h").
      rearSat = demand > 1.1;
    }

    if (!front) {
      rearFx[i - 2] = Fx; rearVlong[i - 2] = vlong;
      // real slide = over budget OR past the MF peak slip angle (kinetic regime)
      if (rearSat || Math.abs(alpha) > 0.20) rearSaturated = true;
    }

    // rotate wheel force back to body frame (+δ) and accumulate
    const fbx = Fx * cd - Fy * sd;
    const fby = Fx * sd + Fy * cd;
    Fbx += fbx; Fby += fby;
    Tz += rx[i] * fby - ry[i] * fbx;   // yaw torque about CoM
  }

  // ---- rear wheel dynamics: Iw·dω/dt = T_drive − Fx·r − T_brake ----
  // (handbrake keeps ω pinned to 0 → the lock owns the wheel; drive can't spin
  // it → the handbrake ALWAYS brakes.) NO traction control — raw power (race
  // special); the big wheelInertia keeps launch wheelspin stable, not oscillating.
  for (let ri = 0; ri < 2; ri++) {
    if (hb) { st.rearOmega[ri] = 0; continue; }
    let omega = st.rearOmega[ri];
    const Tbrake = brakeEff * p.brakeForce * (1 - p.brakeBiasFront) / 2 * rr;
    // DRIFT-SUSTAIN fade: how deep this rear wheel is SLIDING, by its LATERAL
    // slip angle (relaxation-filtered → smooth ramp, no entry/exit jerk). A
    // straight launch burnout has ~0 lateral slip → slideFrac 0 → no fade →
    // launch stays protected (distinguished from a real lateral drift).
    const slideFrac = clamp((Math.abs(st.slip[ri + 2]) - SLIDE_SLIP_LO)
      / (SLIDE_SLIP_HI - SLIDE_SLIP_LO), 0, 1);
    // (B) LOWER effective wheel inertia as it slides → partial throttle gives a
    // proportional, controllable wheelspin (a held angle), not a sluggish step.
    const IwEff = p.wheelInertia * (1 - (1 - p.wheelInertiaSlideFactor) * slideFrac);
    // NO TRACTION CONTROL (race drift special): the drive torque is applied RAW —
    // the wheel spins up on launch, standing burnouts work, power-over is raw. The
    // big `wheelInertia` (22) keeps that launch wheelspin STABLE (no oscillation/
    // shudder) without any TC masking it. The car fights its own power = character.
    const Tdrive = driveTorquePerRear;
    // ENGINE BRAKING the CAR: closed-throttle compression drag pulls the wheel
    // BELOW rolling (κ<0) → the tyre brakes the car (coast decel on the straight).
    // (A) FADED OFF as the rear slides so it doesn't brake a drifting rear.
    const Tengine = (1 - throttle) * p.engineBrakeTorque * (1 - p.engineBrakeSlideFade * slideFrac);
    omega += (Tdrive - rearFx[ri] * rr - Math.sign(omega) * (Tbrake + Tengine)) / IwEff * dt;
    if (omega < 0) omega = 0;   // brake can't drive the wheel backward (no reverse yet)
    // FIX 1 — WHEEL SPIN-DOWN to rolling (NOT faded in a slide): at low throttle
    // the wheel relaxes toward the rolling speed (vlong/rr) so κ→0 → the rear
    // REGAINS grip → the drift WINDS DOWN on lift (instead of spinning out) and
    // the burnout smoke stops. This is separate from engine-braking-the-CAR: it
    // only removes EXCESS spin (ω > rolling), never pushes ω below rolling (so it
    // can't fight the car-brake or the drive). throttleOff gates it off as soon
    // as the player feeds throttle → then drive spins the rear freely (feed).
    const throttleOff = clamp(1 - throttle / 0.2, 0, 1);   // 1 at 0 throttle, 0 by 0.2
    const rollTarget = rearVlong[ri] / rr;
    if (throttleOff > 0 && omega > rollTarget) {
      omega += (rollTarget - omega) * clamp(p.wheelReturnRate * throttleOff * dt, 0, 1);
    }
    st.rearOmega[ri] = omega;
  }

  // ---- REVERSE drive (low-speed mode): the brake pedal is the reverse throttle
  // → a backward body force, capped at reverseSpeed, un-sticks a nosed-in car.
  if (reversing && vbx > -p.reverseSpeed) {
    Fbx -= brake * p.reverseForce;   // −body-x = backward
  }

  // ---- COAST forces: aero drag (∝v²) + rolling resistance (constant), both
  // opposing the velocity vector → the car visibly SLOWS when coasting. Tapered
  // to 0 near rest so they can't push a parked car backward.
  if (v > 0.05) {
    const coastMag = p.dragCoef * v * v + p.rollResist * Math.min(1, v);
    Fbx -= coastMag * (vbx / v);
    Fby -= coastMag * (vby / v);
  }

  // ---- integrate: net force → translation, net torque → yaw ----
  const abx = Fbx / m, aby = Fby / m;     // body-frame accel
  // store for NEXT frame's load transfer (prev-frame accel)
  st.prevAx = abx; st.prevAy = aby;

  // world-frame accel
  const awx = abx * cos - aby * sin;
  const awy = abx * sin + aby * cos;
  let vx = car.vx + awx * dt;
  // (C) MILD SLIDE-GATED YAW DAMPING: a drift is a marginally-stable equilibrium
  // → without damping the yaw oscillates/runs away (spin). A yaw-rate damping
  // torque, gated on the REAR lateral slide depth (smooth, so normal driving is
  // untouched), lets the drift SETTLE at a held angle and widens the throttle
  // band. Physical (the tyres' relaxation/aligning resisting yaw), not a motion
  // source — it only opposes existing yaw.
  const rearSlideFrac = clamp((Math.max(Math.abs(st.slip[2]), Math.abs(st.slip[3])) - SLIDE_SLIP_LO)
    / (SLIDE_SLIP_HI - SLIDE_SLIP_LO), 0, 1);
  const Tyaw = Tz - p.driftYawDamp * w * rearSlideFrac;
  let vy = car.vy + awy * dt;
  let omega = w + Tyaw / Iz * dt;

  // ---- low-speed KINEMATIC BLEND (< lowSpeedBlend): guarantees launch / donut
  // / parking stability. Below the threshold, blend ω toward the kinematic
  // bicycle yaw and nudge the velocity toward the heading, so the near-zero
  // slip-angle regime can't shake or shoot the car off.
  const blend = clamp((p.lowSpeedBlend - v) / p.lowSpeedBlend, 0, 1);
  if (blend > 0) {
    // in reverse the motion side is the BACK of the car → align to heading+π
    const omegaKin = (reversing ? -v : v) * Math.tan(delta[0]) / WB;
    omega = (1 - blend) * omega + blend * omegaKin;
    // rotate (vx,vy) toward the (reverse-aware) heading direction by `blend`
    const sp = Math.hypot(vx, vy);
    if (sp > 1e-4) {
      const cur = Math.atan2(vy, vx);
      const twd = reversing ? h + Math.PI : h;   // d is normalised below
      let d = cur - twd;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const na = cur - d * blend * 0.5;
      vx = sp * Math.cos(na); vy = sp * Math.sin(na);
    }
  }

  // rest snap — fully parked below walking pace with no drive input (NOT in
  // reverse, where the brake pedal is the reverse throttle driving it backward)
  if (v < 0.15 && throttle < 0.02 && !reversing) {
    vx = 0; vy = 0; omega = 0; st.rearOmega = [0, 0];
  }

  // ---- integrate pose ----
  car.vx = vx; car.vy = vy;
  car.angularVel = omega;
  car.heading = car.heading + omega * dt;   // heading is an INDEPENDENT state
  car.x += vx * dt;
  car.y += vy * dt;

  st.load = [loadOut[0], loadOut[1], loadOut[2], loadOut[3]];

  // ---- CarState effects mapping (smoke / skids / XP / sound / HUD) ----
  const rearSlipMax = Math.max(Math.abs(slipOut[2]), Math.abs(slipOut[3]));
  const frontSlipMax = Math.max(Math.abs(slipOut[0]), Math.abs(slipOut[1]));
  car.speed = Math.hypot(vx, vy);
  car.forwardSpeed = vbx;
  car.steerAngle = steer * p.maxSteer;
  car.rearSlip = rearSlipMax;               // skids / smoke / XP read this
  car.frontSlip = frontSlipMax;
  car.isRearSliding = rearSaturated || rearSlipMax > 0.15;
  // wheelSpin = ACTUAL driven over-spin (how much the rear wheel's surface speed
  // ω·r exceeds the true ground speed) → burnout smoke ONLY. NOT the raw vlong
  // slip-ratio (which blows up when vlong collapses in a sideways drift and
  // faked burnout smoke). A drift's smoke comes from isRearSliding (lateral
  // slip); this stays ~0 in a pure slide because ω·r ≈ the wheel's rolling speed.
  const wheelSurf = hb ? 0 : Math.max(st.rearOmega[0], st.rearOmega[1]) * p.rollRadius;
  // A locked (handbrake) rear scrubs ONLY when the car is actually moving —
  // smoke scales with the real contact slip speed (car.speed), ramping in over
  // ~0.6→2 m/s, so a stationary handbrake makes NO smoke.
  const overspin = hb
    ? clamp((car.speed - 0.6) / 1.4, 0, 1)
    : clamp((wheelSurf - car.speed) / Math.max(car.speed, 3), 0, 1);
  car.wheelSpin = overspin;                 // burnout / locked-scrub smoke (real slip only)
  // engine-RPM proxy for the motor sound: the rear-wheel SURFACE speed (∝ revs,
  // no gears → smooth + monotonic, no sawtooth), floored by car speed so it
  // rises cleanly with velocity; a wheelspin lifts it (engine revs up). The
  // sound engine maps this m/s value to pitch (idle → redline).
  car.rearWheelSpeed = Math.max(Math.abs((st.rearOmega[0] + st.rearOmega[1]) / 2 * p.rollRadius), v);
  car.driftActive = car.isRearSliding;
  car.spinTimer = 0;
  car.slipRatio = overspin;
}
