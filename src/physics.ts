// =============================================================================
//  Steer It — 2D car physics (GRID-style arcade-sim)
// -----------------------------------------------------------------------------
//  Bicycle model with separate longitudinal & lateral tire forces.
//
//   - Longitudinal: engine, brake, quadratic air drag, linear rolling drag.
//     The car has MASS, accelerates gradually, coasts on inertia.
//
//   - Lateral: slip-angle tire model with a peak grip cap.
//     Inside the linear region the car holds the line.
//     Past the cap, the wheel breaks loose -> velocity keeps momentum while
//     the chassis rotates -> DRIFT.
//
//   - Rear axle is biased to break loose first (lower peak grip + higher
//     stiffness vs front) -> GRID-style throttle-on oversteer that's
//     countersteer-catchable.
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

  // ---------- Tire / grip — the core of the oversteer bias ----------
  // PASS 2: pass-1 overshot into "ice" — rear let go at the slightest
  // input and the slide had no grip to recover with. Pull the rear grip
  // partway back up (still below front for oversteer bias, but a much
  // less extreme margin) and — most importantly — raise driftFriction so
  // a sliding tire keeps enough grip to respond to countersteer.
  corneringStiffnessFront: 180000,  // (p1, unchanged)  snappy front turn-in & catch
  corneringStiffnessRear:  110000,  // p1 90000  → 110000  ↑  rear less floppy, holds longer
  peakLatGripFront:  13500,         // (p1, unchanged)  strong front for catch authority
  peakLatGripRear:    8200,         // p1 6500   →   8200  ↑  rear doesn't give up at a touch
  // driftFriction = kinetic/static friction ratio once past peak. THE key
  // "on ice" fix: 0.70 left the slide gripless and unrecoverable. 0.83
  // keeps real grip in the slide so countersteer + throttle can settle it.
  driftFriction: 0.83,              // p1 0.70   →   0.83  ↑  grip-in-slide, recoverable

  // ---------- Power-on oversteer ----------
  // At higher throttle inputs we scale the rear's effective peak lateral
  // grip down — a single-knob approximation of the friction-circle effect
  // (longitudinal force at the driven axle steals from its lateral budget).
  // PASS 2: 0.35 snapped the rear loose almost instantly on throttle.
  // 0.20 makes throttle add rotation PROGRESSIVELY so it's a modulation
  // tool, not an on/off switch. Lift off → grip recovers → drift catches.
  rwdPowerOversteerStrength: 0.20,  // p1 0.35   →   0.20  ↓  progressive, not instant

  // ---------- Handbrake (controllable snap-loose) ----------
  // PASS 2: 0.18 was a violent instant spin. 0.35 still clearly breaks the
  // rear loose for a drift ENTRY, but as a controllable slide you can hold
  // and catch, not a gyro.
  handbrakeRearGripMultiplier:      0.35, // p1 0.18 → 0.35  ↑  breaks loose but holdable
  handbrakeRearStiffnessMultiplier: 0.45, // p1 0.30 → 0.45  ↑  less violent rear collapse
  handbrakeBrakeForce:              5500, // unchanged

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

  // Derived, updated every step (for HUD / skid logic).
  speed: number;
  forwardSpeed: number;
  frontSlip: number;
  rearSlip: number;
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
    speed: 0, forwardSpeed: 0,
    frontSlip: 0, rearSlip: 0,
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

  // ---- 5. Lateral forces (linear, clamped at peak) ----
  // Linear region (sub-grip): F = -stiffness * slip. Negative because positive
  // slip means the tire is dragged sideways and the tire pushes BACK.
  //
  // Rear-grip scaling priority:
  //   1. HANDBRAKE engaged → use the handbrake multipliers (deliberate
  //      snap-loose). Throttle effect is ignored here so the two don't
  //      compound into "no grip at all".
  //   2. Otherwise → peak grip is scaled DOWN by throttle via
  //      rwdPowerOversteerStrength to fake power-on oversteer:
  //         rearPeakGrip = peakLatGripRear * (1 - throttle * strength)
  //      Easing off throttle restores grip → drift catches.
  //   Stiffness scales with handbrake only (throttle doesn't change how
  //   quickly the rear builds force, just how soon it saturates).
  const rearStiff = c.corneringStiffnessRear *
    (input.handbrake ? c.handbrakeRearStiffnessMultiplier : 1);
  const rearGripScale = input.handbrake
    ? c.handbrakeRearGripMultiplier
    : (1 - input.throttle * c.rwdPowerOversteerStrength);
  const rearPeakGrip = c.peakLatGripRear * rearGripScale;

  let frontLatForce = -c.corneringStiffnessFront * frontSlip;
  let rearLatForce  = -rearStiff                * rearSlip;

  const isFrontSliding = Math.abs(frontLatForce) > c.peakLatGripFront;
  const isRearSliding  = Math.abs(rearLatForce)  > rearPeakGrip;

  // Past peak grip the tire slides. Apply driftFriction to bleed energy and
  // keep the slide controllable rather than catastrophic.
  if (isFrontSliding) {
    frontLatForce = Math.sign(frontLatForce) * c.peakLatGripFront * c.driftFriction;
  }
  if (isRearSliding) {
    rearLatForce = Math.sign(rearLatForce) * rearPeakGrip * c.driftFriction;
  }

  // ---- 6. Longitudinal forces ----
  let engineForce = input.throttle * c.enginePower;
  let brakingForce = 0;

  // Brake decelerates whichever way the car is moving, never accelerates the
  // other direction (no reverse this slice). HANDBRAKE adds a fixed
  // longitudinal drag on top of any pedal brake input.
  if (forwardVel > 0.1) {
    brakingForce = input.brake * c.brakeForce;
    if (input.handbrake) brakingForce += c.handbrakeBrakeForce;
  } else if (forwardVel < -0.1) {
    brakingForce = -input.brake * c.brakeForce;
    if (input.handbrake) brakingForce -= c.handbrakeBrakeForce;
  } else {
    // At rest with brake OR handbrake held, lock the engine too.
    if (input.brake > 0.05 || input.handbrake) engineForce = 0;
  }

  const dragForce = c.dragCoeff * forwardVel * Math.abs(forwardVel);
  const rollingForce = c.rollingResistance * forwardVel;
  const longitudinalForce = engineForce - brakingForce - dragForce - rollingForce;

  // ---- 7. Assemble body-frame forces ----
  // Front tire force expressed in the WHEEL frame: longitudinal ~ 0 (we model
  // engine at CG / rear axle; front tire only generates lateral), lateral =
  // frontLatForce. Rotate that vector by steerAngle to land in BODY frame.
  const frontForceBodyX = -frontLatForce * fs;
  const frontForceBodyY =  frontLatForce * fc;
  const rearForceBodyX  = 0;
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
