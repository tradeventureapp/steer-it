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

export const CONFIG = {
  // ---------- Mass / geometry ----------
  mass: 1200,                       // kg
  wheelbase: 2.6,                   // m, distance between front and rear axles
  trackWidth: 1.6,                  // m, distance between left and right wheels
  inertiaScale: 1.5,                // yaw inertia = scale * m * L^2 / 12

  // ---------- Engine / brakes ----------
  enginePower: 7500,                // N at full throttle (constant force model)
  brakeForce: 14000,                // N at full brake

  // ---------- Resistance ----------
  dragCoeff: 2.5,                   // air drag, force = dragCoeff * v * |v|
  rollingResistance: 50,            // rolling drag, force = rollingResistance * v

  // ---------- Steering ----------
  maxSteerAngle: 0.55,              // rad, front-wheel lock (~31 deg)
  steerSpeed: 4.5,                  // rad/s, how fast wheels swing toward target
  steerSpeedFalloff: 0.55,          // 1.0 = no falloff; <1 reduces lock at speed
  speedForFullFalloff: 40,          // m/s where falloff is fully applied

  // ---------- Tire / grip ----------
  // Linear cornering stiffness (slope of lateral force vs slip-angle, N/rad)
  corneringStiffnessFront: 140000,
  corneringStiffnessRear:  170000,
  // Peak lateral force per axle (N). Beyond this the tire SLIDES.
  // Rear < front -> rear lets go first -> oversteer / catchable drift.
  peakLatGripFront: 10500,
  peakLatGripRear:  9500,
  // Multiplier on lateral force while sliding (kinetic < static friction).
  driftFriction: 0.92,

  // ---------- Handbrake ----------
  // Engaging the handbrake drastically reduces rear lateral grip and adds a
  // fixed longitudinal drag, breaking the rear loose for handbrake-initiated
  // drifts. Releasing it lets grip return so the player can catch the slide.
  handbrakeRearGripMultiplier:      0.30, // fraction of normal rear peak lateral grip while engaged
  handbrakeRearStiffnessMultiplier: 0.40, // fraction of normal rear cornering stiffness while engaged
  handbrakeBrakeForce:              5500, // N, longitudinal drag added while engaged

  // ---------- Yaw damping ----------
  angularDamping: 0.7,              // 1/s, light damping on body rotation

  // ---------- Drift detection ----------
  // Slip-angle magnitude above which we treat the wheel as "skidding" for
  // visual feedback (skid marks). Independent of the physics slide cap.
  slipThresholdForSkid: 0.18,       // rad (~10 deg)

  // ---------- Input mapping (phone tilt) ----------
  tiltSensitivity: 35,              // deg of tilt that maps to full lock
  tiltDeadzone: 3,                  // deg ignored around level
  inputLerp: 0.18,                  // smoothing on incoming steer target

  // ---------- Render scaling ----------
  pxPerMeter: 22,                   // visual scale only; doesn't affect physics
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
  // HANDBRAKE: while engaged, the rear axle's effective peak grip AND
  // cornering stiffness are scaled down. The rear breaks loose almost
  // immediately into a kinetic-friction-only slide — the core drift tool.
  const rearStiff   = c.corneringStiffnessRear *
    (input.handbrake ? c.handbrakeRearStiffnessMultiplier : 1);
  const rearPeakGrip = c.peakLatGripRear *
    (input.handbrake ? c.handbrakeRearGripMultiplier : 1);

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
