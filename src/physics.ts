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

  // ---------- Engine / brakes ----------
  // p7: the engine is now a POWER CURVE, not a constant force:
  //   drive = throttle · min(enginePower, enginePeakPowerW / |wheelSpeed|)
  // enginePower caps the low-speed force (launch punch); above the
  // crossover (~12.5 m/s wheel speed) force falls off as P/v. Because the
  // curve runs on WHEEL speed, a spinning wheel bleeds its own engine
  // force — wheelspin is self-limiting and full throttle at speed HOOKS UP
  // instead of burning forever (the p6 perma-spin bug: constant 8800 N vs
  // 8964 N kinetic reaction left a 136 N recovery margin ≈ never).
  enginePower: 8800,                // N — low-speed force cap (unchanged)
  // 125 kW (not 110): a held drift runs the wheel at ~14 m/s contact speed
  // where thrust = P/wv — at 110 kW the drift starved (~6.8 kN vs its own
  // drag) and speed decayed until the slide collapsed. 125 kW sustains it.
  enginePeakPowerW: 125000,         // NEW (p7)  W
  brakeForce: 14000,                // N at full brake (unchanged)

  // ---------- Resistance (unchanged) ----------
  dragCoeff: 2.5,                   // air drag, force = dragCoeff * v * |v|
  rollingResistance: 50,            // rolling drag, force = rollingResistance * v

  // ---------- Steering ----------
  // More lock and higher high-speed authority so countersteer can actually
  // CATCH a slide. With the old falloff a drift at speed had ~55% of full
  // lock available — not enough to point the fronts into the slide.
  // p7: real drift cars run 50-65° of lock precisely to HOLD big angles —
  // at 40° the fronts ran out of countersteer long before a 50° drift
  // could balance. steerSpeed up so full lock arrives in ~0.15 s.
  maxSteerAngle: 1.0,               // p6 0.70 → 1.0  ↑  ~57° lock for deep drifts
  steerSpeed: 7.0,                  // p6 5.5  → 7.0  ↑  rad/s, faster actuation
  steerSpeedFalloff: 0.70,          // (unchanged)  less lock loss at speed
  speedForFullFalloff: 50,          // (unchanged)  m/s, full falloff applies higher

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
  // (10800 × 0.83 ≈ 8964 N) must EXCEED the engine's force CAP (8800 N),
  // or a spinning wheel can never decelerate back to grip. p7's power
  // curve makes this much easier to satisfy: above ~12.5 m/s of wheel
  // speed the drive force falls off as P/v, so a spinning wheel bleeds
  // its own torque and recovery is fast everywhere.
  tireGripBudgetRear: 10800,        // p4 9200 → 10800  ↑ proportional to enginePower (p5)
  // Slip ratio at which longitudinal traction peaks. Below = linear
  // traction (wheel ~matches ground). Above = the wheel is SPINNING
  // (kinetic regime). Lower = wheelspin starts at smaller overspeed.
  slipRatioPeak: 0.15,              // NEW (p4)
  // m/s floor for the slip-ratio denominator — keeps the math sane near
  // standstill. Lower = more violent low-speed wheelspin behavior.
  slipDenomFloor: 3.0,              // NEW (p4)
  // p7: extra cut on the rear LATERAL force while the wheel is POWER-
  // SPINNING (slip ratio past peak under throttle). The friction circle
  // already rotates the force vector longitudinal, but the residual
  // lateral (≈ half the kinetic budget at a 50° slide) generated enough
  // straightening torque that deep drift angles collapsed back to a
  // shallow donut. With the cut, throttle truly holds the rear out and
  // 45-60° angles balance on countersteer. Raise toward 1 for less effect.
  // 0.25: higher values leave enough rear lateral while spinning that its
  // restoring torque + drag starve a held drift (tested 0.55 and 0.35 —
  // both eventually collapsed the angle). At 0.25 a full-throttle drift
  // sustains its angle AND its speed.
  spinLatGripFactor: 0.25,          // NEW (p7)
  // Effective inertia of wheel + drivetrain at the contact patch (kg).
  // Lower = wheels spin up on throttle / grip up on lift FASTER.
  wheelSpinInertia: 15,             // NEW (p4)
  // Cap on |slip ratio| via wheel overspeed: wv is clamped within
  // ±maxSlipRatio·denom of ground speed. Force already saturates past
  // rho = 1, so extra wheel speed adds nothing except lag when the player
  // lifts — this keeps throttle-lift hookup near-instant (~2 frames).
  maxSlipRatio: 2.5,                // NEW (p4)
  // Launch punch: extra drive force at standstill, fading linearly to zero
  // by torqueBoostFadeSpeed. Full throttle from rest: 8800 × 1.6 = 14080 N
  // > 10800 N budget → the rear lights up (burnout + squirm) instead of
  // cleanly hooking up. Doesn't touch cruise feel or top speed. 0 disables.
  lowSpeedTorqueBoost: 0.6,         // (p4, unchanged)
  // p7: boost fades sooner so launch wheelspin ends by ~30-40 km/h instead
  // of dragging on — launch lights up, then cleanly hooks.
  torqueBoostFadeSpeed: 8,          // p4 12 → 8  ↓  m/s (~29 km/h) where boost = 0
  // Fraction of the pedal brake that acts on the rear WHEEL (through the
  // friction circle — hard braking can lock the rear and slide it, brake-
  // drift style). The rest acts on the front/body directly.
  brakeRearShare: 0.35,             // NEW (p4)

  // ---------- Handbrake — wheel lock (p4), more bite (p5) ----------
  // A strong brake force on the rear WHEEL. Locks it within a couple of
  // frames → slip ratio goes hard negative → the friction circle collapses
  // lateral grip → the rear slides. Release → the wheel spins back up →
  // grip returns → catch on throttle + countersteer.
  //
  // SIZING: the locked tire's kinetic reaction (budget × driftFriction ≈
  // 8964 N) constantly tries to spin the wheel BACK UP — the handbrake's
  // bite is the MARGIN above that, not the raw number. p4's 9000 left only
  // ~36 N of margin after the p5 budget raise (near-dead handbrake); 14000
  // gives ~5000 N of lock authority → decisive slide entry, still well
  // short of the p1 instant-spin (yaw inertia + damping unchanged).
  handbrakeLockForce: 14000,        // p4 9000 → 14000  ↑ decisive lock (p5)
  // While the handbrake is held the rear LATERAL force is additionally
  // scaled by this factor — a locking/locked wheel has almost no lateral
  // grip. The friction circle covers the fully-locked steady state, but is
  // too forgiving during the ~0.2s lock transition (which is most of what
  // the player feels); this applies the collapse from the instant the
  // lever is pulled → turn-in + handbrake = the rear SNAPS out instead of
  // the car just slowing down. Raise toward 1 for a milder handbrake.
  handbrakeLatGripFactor: 0.30,     // NEW (p6)

  // ---------- Reverse (p6) ----------
  // Arcade reverse: holding BRAKE at (near) standstill backs the car up.
  // While moving forward the pedal is a normal brake; once stopped, keep
  // holding to reverse smoothly. Release while reversing → ease to a stop.
  // The handbrake never reverses (it's a lock, not a drive).
  reverseForce: 4000,               // NEW (p6)  N of reverse drive (and ease-to-stop force)
  maxReverseSpeed: 6,               // NEW (p6)  m/s (~22 km/h) reverse cap

  // ---------- Yaw damping / rate limit ----------
  // Damping is the yaw-rate DECAY constant (its effect in rad/s² is
  // -angularDamping * angularVel, independent of inertia). p7: eased back
  // down — 3.0 ate so much yaw headroom that big drift angles couldn't
  // develop. Inertia (8.0) + the soft yaw limit below keep entries
  // progressive and catchable.
  angularDamping: 1.7,              // p3 3.0 → p7 1.7  ↓  deep angles need yaw headroom
  // Drift stability assist (p7) — the key to HOLDING big angles. While the
  // rear is sliding, a corrective yaw term drives the body's rotation to
  // TRACK the rotation of the velocity vector, so the current slide angle
  // tends to hold instead of self-straightening (the raw dynamics are
  // unstable around deep angles with a ~0.3 s divergence time — fine for
  // a sim with a wheel, hopeless on phone tilt). Steering and throttle
  // then SHIFT the balanced angle rather than fight the instability:
  // throttle deepens, lift shallows, countersteer trims. Gated by the
  // countersteer gesture (see step 9) so initiation stays free. 1/s;
  // higher = stickier drift angle, 0 = raw physics (assist off).
  driftStabilityAssist: 8.0,        // NEW (p7)
  // Yaw-rate limit (rad/s). p7: now a SOFT limit — yaw above maxYawRate
  // is damped back hard (softYawClampRate per second) instead of
  // hard-clipped. The hard clip froze rotation exactly when a big entry
  // needed it most; the soft limit still stops runaway spins.
  maxYawRate: 3.2,                  // p3 2.8 → 3.2  ↑  more rotation for deep entries
  softYawClampRate: 10,             // NEW (p7)  1/s decay applied to yaw above the limit

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

  // Engine drive force at the rear contact patch (p7: power curve).
  // Force = min(enginePower, P/|wheelSpeed|): full punch at low wheel
  // speed, falling off as the WHEEL spins faster — so wheelspin bleeds
  // its own drive force and is self-limiting. The low-speed torque boost
  // (burnout launches) fades out by torqueBoostFadeSpeed of CAR speed.
  const driveBoost = 1 + c.lowSpeedTorqueBoost *
    Math.max(0, 1 - speed / c.torqueBoostFadeSpeed);
  const powerLimitedForce = Math.min(
    c.enginePower,
    c.enginePeakPowerW / Math.max(1, Math.abs(car.rearWheelSpeed)),
  );
  const drive = input.throttle * powerLimitedForce * driveBoost;

  // Arcade reverse mode (p6): brake held at/below walking pace with the
  // handbrake off — the pedal's meaning flips from "brake" to "reverse".
  // In this mode the pedal share is removed from the wheel (the wheel must
  // roll freely backwards) and the body gets a reverse force in section 6.
  const reverseMode = input.brake > 0.1 && !input.handbrake && forwardVel < 0.2;

  // Brake torque on the rear wheel: rear share of the pedal + handbrake.
  // The handbrake LOCKS the wheel, which drives the slip ratio hard
  // negative and — through the circle — collapses lateral grip. That IS
  // the handbrake-drift mechanic.
  const rearBrakeF = (reverseMode ? 0 : input.brake * c.brakeForce * c.brakeRearShare) +
    (input.handbrake ? c.handbrakeLockForce : 0);

  const vg = rearLong;                                   // ground speed at rear patch
  const sDenom = Math.max(c.slipDenomFloor, Math.abs(vg));
  const mw = c.wheelSpinInertia;

  // Brake torque OPPOSES wheel rotation and clamps at zero — a brake can
  // stop the wheel but never spin it the other way. (p6 fix: the old code
  // applied the brake as a signed constant force inside the implicit
  // solve, which drove wheel speed NEGATIVE at standstill; the locked-
  // wheel slip then physically THRUST the car backwards — the "handbrake
  // reverses the car" bug.) The wheel may still legitimately roll
  // backwards when the GROUND drags it there (reverse driving).
  const dWvBrake = (dt / mw) * rearBrakeF;
  const brakeClamp = (w: number) =>
    w > 0 ? Math.max(0, w - dWvBrake) : w < 0 ? Math.min(0, w + dWvBrake) : 0;

  // Wheel-speed update, stage 1: drive + traction. The linear traction
  // region is numerically STIFF (tiny wheel inertia against a steep
  // force-vs-slip slope), so it's integrated IMPLICITLY — unconditionally
  // stable at any dt:
  //   wv' = (drive − k·(wv − vg)) / mw,   k = budget/(slipPeak·denom)
  //   wvNew = (wv + dt/mw·(drive + k·vg)) / (1 + dt·k/mw)
  // Stage 2: the zero-clamped brake torque above.
  const kSlip = budget / (c.slipRatioPeak * sDenom);
  const wv0 = car.rearWheelSpeed;
  let wv = (wv0 + (dt / mw) * (drive + kSlip * vg)) / (1 + (dt * kSlip) / mw);
  wv = brakeClamp(wv);

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
    // force, so re-integrate the wheel explicitly against it (same
    // two stages: traction, then the zero-clamped brake). This is the
    // branch where the wheel actually SPINS UP under power.
    wv = wv0 + (dt / mw) * (drive - rearLongForce);
    // The ground reaction drags the wheel TOWARD ground speed and
    // vanishes at zero slip — it can never push the wheel PAST it.
    // Clamp the crossing, else the one-frame overshoot makes the wheel
    // oscillate locked/overspun on alternate frames under hard braking.
    if ((wv0 - vg) * (wv - vg) < 0) wv = vg;
    wv = brakeClamp(wv);
  }

  // Handbrake kills rear lateral grip from the instant it's pulled — a
  // locking wheel has almost no lateral authority. The friction circle
  // covers the fully-locked steady state; this factor covers the lock
  // TRANSITION, so turn-in + handbrake snaps the rear out instead of
  // merely slowing the car. (p6)
  if (input.handbrake) rearLatForce *= c.handbrakeLatGripFactor;
  // Power-spin lateral cut (p7): while the rear is spinning UP under
  // throttle (positive slip past peak), cut its lateral force further so
  // the residual restoring torque can't straighten a deep drift. The cut
  // blends in CONTINUOUSLY with spin depth (full effect by 3× peak slip) —
  // a hard on/off switch at the threshold made the torque balance jump and
  // drove limit-cycle oscillation in held drifts. Lift → slip collapses →
  // lateral returns smoothly.
  else if (isRearSliding && s > c.slipRatioPeak) {
    const spinDepth = Math.min(1, (s - c.slipRatioPeak) / (0.5 * c.slipRatioPeak));
    rearLatForce *= 1 - (1 - c.spinLatGripFactor) * spinDepth;
  }

  // Clamp wheel overspeed to ±maxSlipRatio (force saturates past rho = 1
  // anyway; unbounded wheel speed would only add throttle-lift lag).
  wv = clamp(wv, vg - c.maxSlipRatio * sDenom, vg + c.maxSlipRatio * sDenom);
  s = (wv - vg) / sDenom;
  car.rearWheelSpeed = wv;

  // How deep into the slide the rear is (0 = grip, 1 = fully saturated) —
  // smooth ramp over rho ∈ [1, 1.5]. Gates the drift stability assist.
  const rearSlideBlend = clamp((rho - 1) / 0.5, 0, 1);

  // ---- 6. Body longitudinal forces (engine lives at the rear wheel) ----
  // Pedal logic (p6): moving forward → normal brake (front share on the
  // body; the rear share went through the wheel). At (near) standstill,
  // holding the pedal becomes arcade REVERSE, capped at maxReverseSpeed.
  // Rolling backwards with the pedal released → ease back to a stop.
  let pedalBodyForce = 0;
  if (reverseMode) {
    if (forwardVel > -c.maxReverseSpeed) {
      pedalBodyForce = -input.brake * c.reverseForce;
    }
  } else if (forwardVel > 0.1) {
    pedalBodyForce = -input.brake * c.brakeForce * (1 - c.brakeRearShare);
  } else if (forwardVel < -0.1) {
    // Scale down near zero so the stop is smooth, not a jolt.
    pedalBodyForce = c.reverseForce * Math.min(1, -forwardVel);
  }

  const dragForce = c.dragCoeff * forwardVel * Math.abs(forwardVel);
  const rollingForce = c.rollingResistance * forwardVel;
  const longitudinalForce = pedalBodyForce - dragForce - rollingForce;

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
  // Soft yaw-rate limit (p7): yaw above maxYawRate is damped back hard
  // instead of hard-clipped — the hard clip froze rotation exactly when
  // a deep drift entry needed it. Still a firm backstop against runaway.
  const yawExcess = Math.abs(car.angularVel) - c.maxYawRate;
  if (yawExcess > 0) {
    car.angularVel -= Math.sign(car.angularVel) *
      yawExcess * Math.min(1, c.softYawClampRate * dt);
  }
  car.heading    += car.angularVel * dt;

  // ---- 9. Integrate translation (body force -> world force -> velocity) ----
  const worldForceX = bodyForceX * cosH - bodyForceY * sinH;
  const worldForceY = bodyForceX * sinH + bodyForceY * cosH;

  // Drift stability assist (p7): while the rear slides AND the player is
  // countersteering, nudge the yaw rate toward the rotation rate of the
  // VELOCITY vector (dphi, from this step's net force). dβ/dt = dphi − ω,
  // so this damps the slide angle's drift — the angle holds where the
  // player put it instead of self-straightening or diverging (the raw
  // dynamics are unstable with ~0.3 s divergence — hopeless on phone
  // tilt). The countersteer GATE keeps initiation free: steering INTO the
  // turn (same side as the rotation) disables the assist so flicks and
  // power-overs swing out unhindered; the moment the player countersteers
  // — the universal "hold it here" gesture — the assist locks the angle.
  const v2 = car.vx * car.vx + car.vy * car.vy;
  if (rearSlideBlend > 0 && v2 > 4) {
    const steerNorm = car.steerAngle / c.maxSteerAngle;
    const assistGate = clamp(0.5 + 1.5 * steerNorm * Math.sign(lateralVel || 0), 0, 1);
    const dphi = (car.vx * worldForceY - car.vy * worldForceX) / (c.mass * v2);
    car.angularVel += c.driftStabilityAssist * rearSlideBlend * assistGate *
      (dphi - car.angularVel) * dt;
  }

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
  // WSPIN reads 0 while the tire grips (linear traction slip is normal and
  // not "wheelspin"); only a saturated/sliding rear registers. (p7)
  car.wheelSpin = isRearSliding ? Math.min(1, Math.abs(s)) : 0;
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
