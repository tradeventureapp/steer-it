// =============================================================================
//  Steer It — 2D car physics (GRID-style arcade-sim)
// -----------------------------------------------------------------------------
//  Bicycle model with separate longitudinal & lateral tire forces.
//
//   - Longitudinal: the engine drives the REAR WHEEL, not the body. We track
//     rear wheel speed separately from ground speed; the tire transmits force
//     through friction. Plus quadratic air drag + linear rolling drag.
//     The car has MASS, accelerates gradually, coasts on inertia.
//
//   - Lateral: slip-angle tire model. Front: linear with a peak cap. Rear:
//     combined-slip FRICTION CIRCLE — one grip budget shared between
//     longitudinal (wheelspin/braking) and lateral (cornering) force.
//
//   - DRIFT = wheelspin: throttle spins the rear faster than the ground,
//     the spin consumes the friction budget, lateral grip collapses and the
//     rear steps out. Lift off -> the wheel grips up -> the budget swings
//     back to lateral -> the car straightens. Throttle steers the drift
//     angle; countersteer balances it. Handbrake locks the rear wheel for
//     slide entries via the same mechanism.
//
//  All units are SI: meters, seconds, kilograms, Newtons, radians.
//  Tunables live in one place: CONFIG. Tweak a number, see the change.
// =============================================================================

// =============================================================================
//  DRIFT-FEEL TUNING — PASS 1
//
//  Goal: Ken Block-style oversteer-biased handling. The rear should break
//  loose willingly on steering + throttle (and snap-loose on handbrake),
//  but slides must SUSTAIN long enough to feel expressive and be catchable
//  with countersteer + throttle modulation, not spin out.
//
//  Each CHANGED value below carries a ← comment showing the previous
//  setting and an arrow indicating the direction of the change, so the
//  next tuning pass can revert / nudge individual numbers without hunting.
// =============================================================================
export const CONFIG = {
  // ---------- Mass / geometry (size-pass output; unchanged here) ----------
  mass: 1200,                       // kg
  wheelbase: 2.6 / 3,               // m, distance between front and rear axles
  trackWidth: 1.6 / 3,              // m, distance between left and right wheels
  // PASS 3: yaw inertia = inertiaScale * m * L^2 / 12. The 1/3 wheelbase
  // made L^2 tiny (~1/9), so yaw inertia collapsed and the car spun the
  // instant the rear stepped out — too fast to catch. Raise inertiaScale
  // ~5.3× to give the rotation WEIGHT so a slide builds progressively
  // into a holdable angle instead of snapping around. (At 8.0 the yaw
  // inertia is ~600 kg·m², about 60% of the original full-size car.)
  inertiaScale: 8.0,                // p2 1.5 → 8.0  ↑  weighty rotation, progressive slide

  // ---------- Engine / brakes (unchanged — feel is punchy after size pass) ----------
  enginePower: 7500,                // N at full throttle
  brakeForce: 14000,                // N at full brake

  // ---------- Resistance (unchanged) ----------
  dragCoeff: 2.5,                   // air drag, force = dragCoeff * v * |v|
  rollingResistance: 50,            // rolling drag, force = rollingResistance * v

  // ---------- Steering ----------
  // More lock and higher high-speed authority so countersteer can actually
  // CATCH a slide. With the old falloff a drift at speed had ~55% of full
  // lock available — not enough to point the fronts into the slide.
  maxSteerAngle: 0.70,              // ← 0.55  ↑  ~40°, more counter-steer headroom
  steerSpeed: 5.5,                  // ← 4.5   ↑  rad/s, faster wheel actuation
  steerSpeedFalloff: 0.70,          // ← 0.55  ↑  less lock loss at speed
  speedForFullFalloff: 50,          // ← 40    ↑  m/s, full falloff applies higher

  // ---------- Tire / grip ----------
  // FRONT (undriven): pure lateral model — linear stiffness with a peak cap.
  corneringStiffnessFront: 180000,  // (unchanged)  snappy front turn-in & catch
  peakLatGripFront:  13500,         // (unchanged)  strong front for catch authority
  // REAR (driven): lateral stiffness still shapes how fast lateral force
  // builds with slip angle. The PEAK now comes from tireGripBudgetRear
  // below — lateral peak slip angle = budget / stiffness ≈ 4.4°.
  corneringStiffnessRear:  110000,  // (unchanged)
  // Kinetic/static friction ratio once a tire is past peak — used by the
  // front cap AND as the saturated-force magnitude of the rear circle.
  driftFriction: 0.83,              // (unchanged)  grip-in-slide, recoverable

  // ---------- Rear wheelspin / friction circle — PASS 4, the drift core ----------
  // The rear tire has ONE total grip budget (N) shared between longitudinal
  // force (wheelspin / braking) and lateral force (cornering). Wheelspin
  // consumes the budget → lateral grip collapses → THROTTLE STEERS THE
  // DRIFT ANGLE. Replaces the rwdPowerOversteerStrength hack (p2 0.20,
  // removed) and the separate peakLatGripRear cap (p2 8200, removed —
  // lateral-only peak is now the full budget when the wheel isn't spinning).
  // IMPORTANT relationship: kinetic reaction = budget × driftFriction
  // (9200 × 0.83 ≈ 7636 N) must EXCEED steady enginePower (7500 N), or a
  // spinning wheel can never decelerate back to grip and full throttle
  // becomes a permanent burnout. With the launch boost the drive force
  // does exceed it below ~12 m/s — so launches light up and then hook up.
  tireGripBudgetRear: 9200,         // N — friction-circle radius (was peakLatGripRear 8200)
  // Slip ratio at which longitudinal traction peaks. Below = linear
  // traction (wheel ~matches ground). Above = the wheel is SPINNING
  // (kinetic regime). Lower = wheelspin starts at smaller overspeed.
  slipRatioPeak: 0.15,              // NEW (p4)
  // m/s floor for the slip-ratio denominator — keeps the math sane near
  // standstill. Lower = more violent low-speed wheelspin behavior.
  slipDenomFloor: 3.0,              // NEW (p4)
  // Effective inertia of wheel + drivetrain at the contact patch (kg).
  // Lower = wheels spin up on throttle / grip up on lift FASTER.
  wheelSpinInertia: 15,             // NEW (p4)
  // Cap on |slip ratio| via wheel overspeed: wv is clamped within
  // ±maxSlipRatio·denom of ground speed. Force already saturates past
  // rho = 1, so extra wheel speed adds nothing except lag when the player
  // lifts — this keeps throttle-lift hookup near-instant (~2 frames).
  maxSlipRatio: 2.5,                // NEW (p4)
  // Launch punch: extra drive force at standstill, fading linearly to zero
  // by torqueBoostFadeSpeed. Full throttle from rest: 7500 × 1.6 = 12000 N
  // > 8500 N budget → the rear lights up (burnout + squirm) instead of
  // cleanly hooking up. Doesn't touch cruise feel or top speed. 0 disables.
  lowSpeedTorqueBoost: 0.6,         // NEW (p4)
  torqueBoostFadeSpeed: 12,         // NEW (p4)  m/s (~43 km/h) where boost = 0
  // Fraction of the pedal brake that acts on the rear WHEEL (through the
  // friction circle — hard braking can lock the rear and slide it, brake-
  // drift style). The rest acts on the front/body directly.
  brakeRearShare: 0.35,             // NEW (p4)

  // ---------- Handbrake — PASS 4: wheel lock, not grip multipliers ----------
  // The handbrake is now simply a strong brake force on the rear WHEEL. It
  // locks the wheel within a couple of frames → slip ratio goes hard
  // negative → the friction circle collapses lateral grip → the rear
  // slides. Release → the wheel spins back up to ground speed → grip
  // returns → the player catches the slide on throttle + countersteer.
  // Replaces handbrakeRearGripMultiplier (p2 0.35), handbrakeRearStiffness-
  // Multiplier (p2 0.45) and handbrakeBrakeForce (5500) — the same feel
  // now emerges from the wheel-lock physics. Lower = softer, slower lock.
  handbrakeLockForce: 9000,         // NEW (p4)  N at the rear contact patch

  // ---------- Yaw damping / rate limit ----------
  // PASS 3: damping is the yaw-rate DECAY constant (its effect in rad/s²
  // is -angularDamping * angularVel, independent of inertia). Raised so a
  // slide SETTLES into a held angle and gives countersteer time to work,
  // instead of the yaw running away. Front catch torque still dominates
  // at meaningful yaw rates, so the car isn't glued straight.
  angularDamping: 3.0,              // p2 1.5 → 3.0  ↑  settle into angle, catchable
  // Hard cap on |yaw rate| (rad/s). A pure backstop against runaway spin:
  // a loss of grip can't produce more than this much rotation speed, so
  // even a botched entry stays controllable. ~2.8 rad/s ≈ 160°/s, plenty
  // for an aggressive drift but short of an uncatchable gyro. Raise to
  // allow faster rotation, lower for more stability.
  maxYawRate: 2.8,                  // NEW (p3). clamp on |angularVel|

  // ---------- Drift detection / skids ----------
  // Visual indicator only — independent of the physics slide cap. Lower
  // so skids and the DRIFT badge show up as soon as the rear is past
  // peak, not only deep into a slide.
  slipThresholdForSkid: 0.12,       // ← 0.18  ↓  ~7° instead of ~10°, earlier visual

  // ---------- Input mapping (phone tilt) ----------
  tiltSensitivity: 35,              // unchanged
  tiltDeadzone: 3,                  // unchanged
  inputLerp: 0.18,                  // unchanged

  // ---------- Render scaling ----------
  pxPerMeter: 22,                   // unchanged
};

export type Config = typeof CONFIG;

export interface CarState {
  // World position (meters) and heading (rad, 0 = +x, +pi/2 = +y).
  x: number;
  y: number;
  heading: number;

  // World velocity (m/s) and yaw rate (rad/s).
  vx: number;
  vy: number;
  angularVel: number;

  // Current front-wheel angle (rad), eased toward target each step.
  steerAngle: number;

  // Rear wheel contact-patch speed (m/s) — the wheelspin state. Spun up by
  // engine torque, dragged toward ground speed by the tire's friction
  // reaction, slowed by rear brake / handbrake. Clamped >= 0 (no reverse).
  rearWheelSpeed: number;

  // Derived, updated every step (for HUD / skid logic).
  speed: number;
  forwardSpeed: number;
  frontSlip: number;
  rearSlip: number;
  slipRatio: number;       // rear longitudinal slip (+ = spinning, − = locking)
  wheelSpin: number;       // |slipRatio| clamped to 0..1 — HUD "WSPIN %"
  isFrontSliding: boolean;
  isRearSliding: boolean;
}

export interface Inputs {
  steer: number;      // -1..1, +1 = full right
  throttle: number;   // 0..1 (analog)
  brake: number;      // 0..1 (analog)
  handbrake: boolean; // on/off
}

export function makeCar(x: number, y: number, heading: number = -Math.PI / 2): CarState {
  return {
    x, y, heading,
    vx: 0, vy: 0, angularVel: 0,
    steerAngle: 0,
    rearWheelSpeed: 0,
    speed: 0, forwardSpeed: 0,
    frontSlip: 0, rearSlip: 0,
    slipRatio: 0, wheelSpin: 0,
    isFrontSliding: false, isRearSliding: false,
  };
}

// Yaw inertia, precomputed once.
function inertia(c: Config) {
  return c.inertiaScale * c.mass * c.wheelbase * c.wheelbase / 12;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// -----------------------------------------------------------------------------
//  step(): one fixed-timestep physics update.
//  Call this with a FIXED dt (e.g. 1/60). Render decoupled.
// -----------------------------------------------------------------------------
export function step(car: CarState, input: Inputs, dt: number, c: Config = CONFIG) {
  // ---- 1. Steering: ease front wheel toward target lock ----
  const targetSteer = clamp(input.steer, -1, 1) * c.maxSteerAngle;
  const maxStep = c.steerSpeed * dt;
  car.steerAngle += clamp(targetSteer - car.steerAngle, -maxStep, maxStep);

  const speed = Math.hypot(car.vx, car.vy);
  // High-speed steering falloff: at speed >= speedForFullFalloff, lock is
  // reduced to steerSpeedFalloff * actual. Keeps high-speed inputs sane.
  const falloff = 1 - (1 - c.steerSpeedFalloff) *
    Math.min(1, speed / c.speedForFullFalloff);
  const effectiveSteer = car.steerAngle * falloff;

  // ---- 2. Body-frame velocity (forward = +x_body, lateral = +y_body) ----
  const cosH = Math.cos(car.heading);
  const sinH = Math.sin(car.heading);
  const forwardVel =  car.vx * cosH + car.vy * sinH;
  const lateralVel = -car.vx * sinH + car.vy * cosH;

  // ---- 3. Velocities at each axle (include yaw contribution) ----
  // For a rigid body with angular velocity w, the velocity at a point r off
  // the CG (in body frame) is v_cg + (-w*ry, w*rx). The axles are on the body
  // x-axis, so r = (+L/2, 0) and r = (-L/2, 0).
  const halfWB = c.wheelbase / 2;

  const frontLong = forwardVel;
  const frontLat  = lateralVel + car.angularVel * halfWB;
  const rearLong  = forwardVel;
  const rearLat   = lateralVel - car.angularVel * halfWB;

  // Rotate front-axle velocity into the steered wheel frame.
  const fc = Math.cos(effectiveSteer);
  const fs = Math.sin(effectiveSteer);
  const frontWheelLong =  frontLong * fc + frontLat * fs;
  const frontWheelLat  = -frontLong * fs + frontLat * fc;

  // ---- 4. Slip angles ----
  // slip = atan2(lateral, |longitudinal|). The MIN_LONG floor prevents the
  // slip angle from exploding at very low speeds (would otherwise generate
  // huge phantom lateral forces from numerical noise).
  const MIN_LONG = 0.5;
  const frontSlip = Math.atan2(frontWheelLat, Math.max(MIN_LONG, Math.abs(frontWheelLong)));
  const rearSlip  = Math.atan2(rearLat,       Math.max(MIN_LONG, Math.abs(rearLong)));

  // ---- 5. Tire forces ----
  // FRONT (undriven): pure lateral, linear in slip angle, clamped at peak,
  // kinetic fraction once sliding — unchanged from earlier passes.
  let frontLatForce = -c.corneringStiffnessFront * frontSlip;
  const isFrontSliding = Math.abs(frontLatForce) > c.peakLatGripFront;
  if (isFrontSliding) {
    frontLatForce = Math.sign(frontLatForce) * c.peakLatGripFront * c.driftFriction;
  }

  // REAR (driven): combined-slip friction circle — PASS 4.
  //
  //   slip ratio  s     = (wheelSpeed − groundSpeed) / max(floor, |groundSpeed|)
  //   norm long   nLong = s / slipRatioPeak
  //   norm lat    nLat  = slipAngle / alphaPeak,   alphaPeak = budget/stiffness
  //   combined    rho   = hypot(nLong, nLat)
  //
  //   rho ≤ 1 (grip):    F_long =  budget · nLong
  //                      F_lat  = −budget · nLat
  //   rho > 1 (sliding): total force = budget · driftFriction, pointed along
  //                      the combined-slip direction:
  //                      F_long =  budget · driftFriction · nLong/rho
  //                      F_lat  = −budget · driftFriction · nLat /rho
  //
  // This is what makes throttle steer the drift: more throttle → the wheel
  // spins → nLong grows → the force vector rotates longitudinal → lateral
  // grip collapses → the rear steps out. Lift → the wheel grips up
  // (nLong → 0) → the budget swings back lateral → the rear hooks up.
  const budget = c.tireGripBudgetRear;
  const alphaPeakRear = budget / c.corneringStiffnessRear;

  // Engine drive force at the rear contact patch, with the low-speed
  // torque boost (burnout launches; fades out by torqueBoostFadeSpeed).
  const driveBoost = 1 + c.lowSpeedTorqueBoost *
    Math.max(0, 1 - speed / c.torqueBoostFadeSpeed);
  const drive = input.throttle * c.enginePower * driveBoost;

  // Brake torque on the rear wheel: rear share of the pedal + handbrake.
  // The handbrake LOCKS the wheel, which drives the slip ratio hard
  // negative and — through the circle — collapses lateral grip. That IS
  // the handbrake-drift mechanic.
  const rearBrakeF = input.brake * c.brakeForce * c.brakeRearShare +
    (input.handbrake ? c.handbrakeLockForce : 0);

  const vg = rearLong;                                   // ground speed at rear patch
  const sDenom = Math.max(c.slipDenomFloor, Math.abs(vg));
  const mw = c.wheelSpinInertia;

  // Wheel-speed update. The linear traction region is numerically STIFF
  // (tiny wheel inertia against a steep force-vs-slip slope), so it's
  // integrated IMPLICITLY — unconditionally stable at any dt:
  //   wv' = (drive − brake − k·(wv − vg)) / mw,   k = budget/(slipPeak·denom)
  //   wvNew = (wv + dt/mw·(drive − brake + k·vg)) / (1 + dt·k/mw)
  const kSlip = budget / (c.slipRatioPeak * sDenom);
  const wv0 = car.rearWheelSpeed;
  let wv = (wv0 + (dt / mw) * (drive - rearBrakeF + kSlip * vg)) /
           (1 + (dt * kSlip) / mw);

  let s = (wv - vg) / sDenom;
  let nLong = s / c.slipRatioPeak;
  const nLat = rearSlip / alphaPeakRear;
  let rho = Math.hypot(nLong, nLat);

  let rearLongForce: number;
  let rearLatForce: number;
  const isRearSliding = rho > 1;

  if (!isRearSliding) {
    rearLongForce =  budget * nLong;
    rearLatForce  = -budget * nLat;
  } else {
    const fk = budget * c.driftFriction;
    rearLongForce =  fk * (nLong / rho);
    rearLatForce  = -fk * (nLat  / rho);
    // The implicit predictor assumed the full linear reaction; while
    // saturated the real reaction is the (smaller, ~constant) kinetic
    // force, so re-integrate the wheel explicitly against it. This is
    // the branch where the wheel actually SPINS UP under power.
    wv = wv0 + (dt / mw) * (drive - rearBrakeF - rearLongForce);
  }

  // Clamp wheel overspeed to ±maxSlipRatio (force saturates past rho = 1
  // anyway; unbounded wheel speed would only add throttle-lift lag), and
  // no reverse drive this slice.
  wv = clamp(wv, vg - c.maxSlipRatio * sDenom, vg + c.maxSlipRatio * sDenom);
  wv = Math.max(0, wv);
  s = (wv - vg) / sDenom;
  car.rearWheelSpeed = wv;

  // ---- 6. Body longitudinal forces (engine lives at the rear wheel now) ----
  // Front share of the pedal brake acts on the body directly (front axle
  // has no longitudinal slip model); it never reverses the car.
  let frontBrakeForce = 0;
  const pedalFront = input.brake * c.brakeForce * (1 - c.brakeRearShare);
  if (forwardVel > 0.1)       frontBrakeForce =  pedalFront;
  else if (forwardVel < -0.1) frontBrakeForce = -pedalFront;

  const dragForce = c.dragCoeff * forwardVel * Math.abs(forwardVel);
  const rollingForce = c.rollingResistance * forwardVel;
  const longitudinalForce = -frontBrakeForce - dragForce - rollingForce;

  // ---- 7. Assemble body-frame forces ----
  // Front tire force lives in the steered-wheel frame (lateral only);
  // rotate by steerAngle into the BODY frame. The rear tire contributes
  // BOTH components now: longitudinal (engine/brake through the contact
  // patch) and lateral.
  const frontForceBodyX = -frontLatForce * fs;
  const frontForceBodyY =  frontLatForce * fc;
  const rearForceBodyX  = rearLongForce;
  const rearForceBodyY  = rearLatForce;

  const bodyForceX = longitudinalForce + frontForceBodyX + rearForceBodyX;
  const bodyForceY = frontForceBodyY  + rearForceBodyY;

  // ---- 8. Yaw torque (front pushes one way at +L/2, rear at -L/2) ----
  // 2D torque from force at offset (rx, ry): rx*Fy - ry*Fx. Axles are on the
  // body x-axis (ry = 0) so torque = rx * Fy.
  const I = inertia(c);
  const torque = halfWB * frontForceBodyY - halfWB * rearForceBodyY;
  const yawDamp = -c.angularDamping * I * car.angularVel;
  car.angularVel += (torque + yawDamp) / I * dt;
  // Hard backstop against an uncatchable spin: clamp the yaw rate so a
  // loss of grip can only ever produce a controllable rotation speed.
  car.angularVel = clamp(car.angularVel, -c.maxYawRate, c.maxYawRate);
  car.heading    += car.angularVel * dt;

  // ---- 9. Integrate translation (body force -> world force -> velocity) ----
  const worldForceX = bodyForceX * cosH - bodyForceY * sinH;
  const worldForceY = bodyForceX * sinH + bodyForceY * cosH;

  car.vx += worldForceX / c.mass * dt;
  car.vy += worldForceY / c.mass * dt;
  car.x  += car.vx * dt;
  car.y  += car.vy * dt;

  // ---- 10. Snap tiny velocities to zero (clean rest state) ----
  if (Math.abs(car.vx) < 0.01) car.vx = 0;
  if (Math.abs(car.vy) < 0.01) car.vy = 0;
  if (Math.abs(car.angularVel) < 0.005) car.angularVel = 0;

  // ---- 11. Derived state for HUD / skids ----
  car.speed = Math.hypot(car.vx, car.vy);
  car.forwardSpeed = forwardVel;
  car.frontSlip = frontSlip;
  car.rearSlip = rearSlip;
  car.slipRatio = s;
  car.wheelSpin = Math.min(1, Math.abs(s));
  car.isFrontSliding = isFrontSliding;
  car.isRearSliding = isRearSliding;
}

// -----------------------------------------------------------------------------
//  Body-to-world position helper (used for drawing wheel positions / skids).
// -----------------------------------------------------------------------------
export function bodyToWorld(car: CarState, bx: number, by: number): { x: number; y: number } {
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  return { x: car.x + bx * c - by * s, y: car.y + bx * s + by * c };
}
