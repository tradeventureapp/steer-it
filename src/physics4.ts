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
  engineForce: number;        // N — peak drive force at the rear AXLE (torque×gear/r) (9000)
  engineFadeSpeed: number;    // m/s — drive force fades to 0 by here (caps top speed) (62)
  rollRadius: number;         // m — wheel rolling radius (0.30)
  wheelInertia: number;       // kg·m² — rear wheel + engine/drivetrain reflected inertia (22 — big = stable, no launch spin-up oscillation)
  brakeForce: number;         // N — peak brake force (both axles combined) (14000)
  brakeBiasFront: number;     // 0..1 — front share of braking (0.6)
  tractionSpeed: number;      // m/s — below this, launch traction-control caps rear wheelspin (4)
  tractionSlipCap: number;    // slip-ratio cap under traction control (0.12 — clean launch)
  tireBx: number;             // Magic-Formula LONGITUDINAL stiffness (18)
  tireCx: number;             // Magic-Formula longitudinal shape (1.6)
  hbKineticMu: number;        // locked-rear kinetic-scrub fraction of the grip budget (0.9)
}

// D-tunable defaults (the boss tunes these live; mutated in place like CONFIG).
export const PHYS4: Physics4Params = {
  massKg: 1200,
  weightDistFront: 0.52,
  cgHeight: 0.5,
  yawInertiaK: 1.25,
  loadTransferLongGain: 1.0,
  loadTransferLatGain: 1.0,
  muNom: 1.5,
  loadSensitivity: 0.15,
  tireB: 11,
  tireC: 1.5,
  tireEllipseLong: 1.0,
  relaxLength: 0.5,
  lowSpeedBlend: 2.5,
  maxSteer: 0.52,
  // FASE 1 drive tools
  engineForce: 9000,
  engineFadeSpeed: 62,
  rollRadius: 0.30,
  wheelInertia: 22,
  brakeForce: 14000,
  brakeBiasFront: 0.6,
  tractionSpeed: 4,
  tractionSlipCap: 0.12,
  tireBx: 18,
  tireCx: 1.6,
  hbKineticMu: 0.9,
};

const MU_FLOOR = 0.3;         // μ never collapses to ≤0 under huge load
const SLIP_LONG_FLOOR = 0.5;  // m/s — |vlong| floor for the slip-angle atan (relaxation also guards)

// ---- per-car state (physics.ts untouched) ----
interface P4State {
  // relaxation-length filtered slip angle per wheel: FL, FR, RL, RR
  slip: [number, number, number, number];
  prevAx: number;   // prev-frame body-frame longitudinal accel (load transfer)
  prevAy: number;   // prev-frame body-frame lateral accel
  // rear wheel angular velocity (rad/s): RL, RR — drive/brake/handbrake act here
  rearOmega: [number, number];
  initd: boolean;   // rear omega seeded to free-rolling on the first step
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

  const steer = clamp(input.steer, -1, 1);
  const delta = [steer * p.maxSteer, steer * p.maxSteer, 0, 0]; // fronts steer, rears fixed

  // ---- body-frame velocity ----
  const h = car.heading, cos = Math.cos(h), sin = Math.sin(h);
  const vbx = car.vx * cos + car.vy * sin;    // body longitudinal
  const vby = -car.vx * sin + car.vy * cos;   // body lateral (right +)
  const v = Math.hypot(car.vx, car.vy);
  const w = car.angularVel;

  // ---- LOAD TRANSFER (from PREV-frame body accel — no algebraic loop) ----
  // ΔFz_long = m·ax·h/WB (accel → rear, brake → front). ΔFz_lat = m·ay·h/T
  // (→ outer wheels). Clamped to ±static so a cold-start accel spike can't
  // invert the load; per-wheel Fz clamped ≥ 0 (a lifted wheel carries nothing).
  const dLong = clamp(m * st.prevAx * p.cgHeight / WB * p.loadTransferLongGain,
    -(FzF + FzR), (FzF + FzR));
  const dLat = m * st.prevAy * p.cgHeight / T * p.loadTransferLatGain;

  const throttle = clamp(input.throttle, 0, 1);
  const brake = clamp(input.brake, 0, 1);
  const hb = input.handbrake;
  const rr = p.rollRadius;

  // seed rear wheel speed to free-rolling on the first step (a thrown/reclaimed
  // car isn't braking its own rear); afterwards the dynamics own it.
  if (!st.initd) { st.rearOmega = [vbx / rr, vbx / rr]; st.initd = true; }

  // drive force at the rear axle, faded with speed (caps top). Split per wheel;
  // becomes a wheel drive torque = force·r.
  const driveForceAxle = throttle * p.engineForce * clamp(1 - v / p.engineFadeSpeed, 0, 1);
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
      const fBrake = brake * p.brakeForce * p.brakeBiasFront / 2;
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
    } else {
      const ri = i - 2;   // 0=RL, 1=RR
      // longitudinal slip ratio (bounded denominator → no low-speed blow-up)
      const kappa = (st.rearOmega[ri] * rr - vlong) / Math.max(Math.abs(vlong), 3);
      st.slipRatio[ri] = kappa;
      Fx = D * Math.sin(p.tireCx * Math.atan(p.tireBx * kappa));
      // rear brake force adds into the longitudinal demand (also via the circle)
      Fx += -Math.sign(vlong) * brake * p.brakeForce * (1 - p.brakeBiasFront) / 2;
    }

    // ---- FRICTION ELLIPSE (the one principle): the tire's grip budget D is
    // shared between Fx and Fy. Generous longitudinal axis (tireEllipseLong) so
    // a deep drift keeps FORWARD BITE → the drift CARRIES speed (the sim-real
    // speed-bleed failure mode designed out). Over budget → both scale down:
    // throttle's Fx eats the circle → rear lateral drops → power-oversteer.
    // SKIPPED for the locked rear — it's already at the full budget by construction.
    let rearSat = lockedRear;
    if (!lockedRear) {
      const demand = Math.hypot(Fx / (D * p.tireEllipseLong || 1), Fy / (D || 1));
      if (demand > 1) { Fx /= demand; Fy /= demand; }
      rearSat = demand > 0.98;
    }

    if (!front) {
      rearFx[i - 2] = Fx; rearVlong[i - 2] = vlong;
      if (rearSat || Math.abs(alpha) > 0.15) rearSaturated = true;
    }

    // rotate wheel force back to body frame (+δ) and accumulate
    const fbx = Fx * cd - Fy * sd;
    const fby = Fx * sd + Fy * cd;
    Fbx += fbx; Fby += fby;
    Tz += rx[i] * fby - ry[i] * fbx;   // yaw torque about CoM
  }

  // ---- rear wheel dynamics: Iw·dω/dt = T_drive − Fx·r − T_brake ----
  // (handbrake keeps ω pinned to 0 → the lock owns the wheel; drive can't spin
  // it → the handbrake ALWAYS brakes.) A launch traction limit caps ω below
  // tractionSpeed so a standing-start can't spin up into a wheelspin lottery.
  for (let ri = 0; ri < 2; ri++) {
    if (hb) { st.rearOmega[ri] = 0; continue; }
    let omega = st.rearOmega[ri];
    const Tbrake = brake * p.brakeForce * (1 - p.brakeBiasFront) / 2 * rr;
    // SOFT launch traction control: below tractionSpeed, once the wheel reaches
    // the target slip, cut the drive torque to just BALANCE the tyre force (hold
    // the slip, don't spin more) → the tyre delivers its grip smoothly = strong,
    // clean, non-oscillating launch (a hard ω cap oscillated). Above the speed,
    // full drive torque → wheelspin is free (donuts / power-over).
    let Tdrive = driveTorquePerRear;
    if (v < p.tractionSpeed) {
      const targetSlipOmega = (rearVlong[ri] + p.tractionSlipCap * Math.max(Math.abs(rearVlong[ri]), 3)) / rr;
      if (omega >= targetSlipOmega) Tdrive = Math.min(Tdrive, rearFx[ri] * rr);
    }
    omega += (Tdrive - rearFx[ri] * rr - Math.sign(omega) * Tbrake) / p.wheelInertia * dt;
    if (omega < 0) omega = 0;   // brake can't drive the wheel backward (no reverse yet)
    st.rearOmega[ri] = omega;
  }

  // ---- integrate: net force → translation, net torque → yaw ----
  const abx = Fbx / m, aby = Fby / m;     // body-frame accel
  // store for NEXT frame's load transfer (prev-frame accel)
  st.prevAx = abx; st.prevAy = aby;

  // world-frame accel
  const awx = abx * cos - aby * sin;
  const awy = abx * sin + aby * cos;
  let vx = car.vx + awx * dt;
  let vy = car.vy + awy * dt;
  let omega = w + Tz / Iz * dt;

  // ---- low-speed KINEMATIC BLEND (< lowSpeedBlend): guarantees launch / donut
  // / parking stability. Below the threshold, blend ω toward the kinematic
  // bicycle yaw and nudge the velocity toward the heading, so the near-zero
  // slip-angle regime can't shake or shoot the car off.
  const blend = clamp((p.lowSpeedBlend - v) / p.lowSpeedBlend, 0, 1);
  if (blend > 0) {
    const omegaKin = v * Math.tan(delta[0]) / WB;
    omega = (1 - blend) * omega + blend * omegaKin;
    // rotate (vx,vy) toward the heading direction by `blend`
    const sp = Math.hypot(vx, vy);
    if (sp > 1e-4) {
      const cur = Math.atan2(vy, vx);
      const twd = h;
      let d = cur - twd;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const na = cur - d * blend * 0.5;
      vx = sp * Math.cos(na); vy = sp * Math.sin(na);
    }
  }

  // rest snap — fully parked below walking pace with no drive input
  if (v < 0.15 && throttle < 0.02) {
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
  // wheelSpin = rear longitudinal slip magnitude (0 grip … 1 full spin/lock) →
  // smoke intensity; rearWheelSpeed = |ω·r| → sound RPM proxy.
  const kappaMax = Math.max(Math.abs(st.slipRatio[0]), Math.abs(st.slipRatio[1]));
  car.wheelSpin = clamp(kappaMax, 0, 1);
  car.rearWheelSpeed = Math.abs((st.rearOmega[0] + st.rearOmega[1]) / 2 * p.rollRadius);
  car.driftActive = car.isRearSliding;
  car.spinTimer = 0;
  car.slipRatio = kappaMax;
}
