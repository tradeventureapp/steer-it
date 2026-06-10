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
  enginePower: 8400,                // p5 8800 → 8400 ↓ (p9): below the curve crossover
                                    // the cap is the recovery margin vs the 8964 N tire
                                    // reaction — 164 N took forever to hook; 564 N is crisp
  // p9: 125k → 110k. Crisp hookup needs the curve to bite at the pinned
  // wheel speed (at 125k the recovery margin was a sluggish 164 N);
  // drifts no longer need the curve — the p8 drift gate bypasses it.
  enginePeakPowerW: 110000,         // p7 125000 → 110000  ↓ (p9)
  // ---------- Governed drift mode (p9 — replaces the p8/p9 patch stack) ----------
  // Layered emergent fixes (drift-gated power, scrub cancel, stability
  // assist, soft ceiling) fought each other: sims showed the drift either
  // starved to a pirouette, overshot to ~86°, or ran away to 140 km/h
  // depending on which patch won. Arcade drift games solve this with a
  // GOVERNED drift state, and so do we now: while sliding WITH power on,
  // yaw is driven so the slip angle tracks an explicit target set by the
  // STEERING (into the drift = deeper, countersteer = shallower), and
  // speed is driven toward a target set by the THROTTLE. Raw tire physics
  // still rules grip driving, initiation, and lift-off recovery; the
  // governor blends in over driftModeStart→Full and out the moment the
  // player lifts. Predictable by construction: floor it + steer = swing
  // out and PARK in the 40-60° band at a held speed.
  driftModeStart: 0.30,             // NEW (p9)  rad (~17°) body slip — governor blends in
  driftModeFull: 0.52,              // NEW (p9)  rad (~30°) — fully governed
  driftBaseAngle: 0.70,             // NEW (p9)  rad (~40°) slip target at neutral steer
  driftSteerAngleGain: 0.35,        // NEW (p9)  rad (~20°) steer bias: into = up to ~60°,
                                    //           full countersteer = down to ~20°
  driftAngleRate: 4.0,              // NEW (p9)  1/s — slip-angle tracking stiffness
  driftYawRelax: 8.0,               // NEW (p9)  1/s — yaw relax rate toward the law
  driftTargetSpeedMin: 5,           // NEW (p9)  m/s drift speed at light throttle
  driftTargetSpeedMax: 10,          // NEW (p9)  m/s at full throttle (~36 km/h)
  driftSpeedGain: 2.5,              // NEW (p9)  1/s accel toward the target speed
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
  // ---------- Auto-countersteer (p9) ----------
  // During a deep slide the EFFECTIVE front-wheel angle blends toward the
  // velocity direction — the alignment a real drifter holds. Without it, a
  // binary tilt player holding steer INTO the turn at 50° of slip turns
  // the front tire into a plow: it kills the yaw, drags the angle through
  // the band to ~85°, and scrubs the car to a stop (traced in sim). The
  // player's input still trims around the alignment (autoCounterTrim of
  // stick authority), so steering stays expressive mid-drift.
  autoCounterStart: 0.35,           // NEW (p9)  rad (~20°) body slip — blend begins
  autoCounterFull: 0.70,            // NEW (p9)  rad (~40°) — fully engaged
  autoCounterStrength: 0.85,        // NEW (p9)  0..1, how strongly fronts align
  autoCounterTrim: 0.3,             // NEW (p9)  player authority around alignment

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
  // p9: the cut is additionally gated by LATERAL slip — wheelspin while
  // traveling STRAIGHT must not collapse rear lateral grip, or the car
  // crabs/shuffles sideways during a straight-line burnout (video-
  // confirmed at 13 km/h). No cut below slipStart, full cut by slipFull.
  spinLatCutSlipStart: 0.08,        // NEW (p9)  rad (~4.6°)
  spinLatCutSlipFull: 0.30,         // NEW (p9)  rad (~17°)
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
  // p9: binary-throttle players live at 100% — the burnout window must be
  // SHORT. Boost down and fading by 4 m/s puts full-throttle hookup at
  // ~16-18 km/h (was ~33). Drifts are unaffected: the governed drift mode
  // paces the car through slides independently of engine drive.
  lowSpeedTorqueBoost: 0.5,         // p4 0.6 → 0.5  ↓ (p9)
  torqueBoostFadeSpeed: 4,          // p7 8 → 4  ↓  m/s (~14 km/h) where boost = 0
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
  // (The p7 drift-stability assist and the p9 soft angle ceiling were
  //  replaced by the governed drift mode above — one law instead of three
  //  fighting correctors.)
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
  // ---- 1. Body-frame velocity (forward = +x_body, lateral = +y_body) ----
  // (computed first — the steering auto-align needs the slip direction)
  const cosH = Math.cos(car.heading);
  const sinH = Math.sin(car.heading);
  const forwardVel =  car.vx * cosH + car.vy * sinH;
  const lateralVel = -car.vx * sinH + car.vy * cosH;

  // ---- 2. Steering: ease front wheel toward target lock ----
  const targetSteer = clamp(input.steer, -1, 1) * c.maxSteerAngle;
  const maxStep = c.steerSpeed * dt;
  car.steerAngle += clamp(targetSteer - car.steerAngle, -maxStep, maxStep);

  const speed = Math.hypot(car.vx, car.vy);
  // High-speed steering falloff: at speed >= speedForFullFalloff, lock is
  // reduced to steerSpeedFalloff * actual. Keeps high-speed inputs sane.
  const falloff = 1 - (1 - c.steerSpeedFalloff) *
    Math.min(1, speed / c.speedForFullFalloff);
  const playerSteer = car.steerAngle * falloff;

  // Auto-countersteer (p9): in a deep slide, blend the EFFECTIVE wheel
  // angle toward the velocity direction (a drifter's alignment); the
  // player's input trims around it. Gate by body slip angle AND speed
  // (the slip direction is noise near standstill).
  const bodyBeta = Math.atan2(lateralVel, Math.max(0.5, Math.abs(forwardVel)));
  const alignGate = clamp(
      (Math.abs(bodyBeta) - c.autoCounterStart) /
      (c.autoCounterFull - c.autoCounterStart), 0, 1) *
    c.autoCounterStrength *
    clamp((speed - 2) / 2, 0, 1);
  const alignAngle = clamp(bodyBeta, -c.maxSteerAngle, c.maxSteerAngle);
  const effectiveSteer =
    playerSteer * (1 - alignGate) +
    (alignAngle + playerSteer * c.autoCounterTrim) * alignGate;

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

  // Engine drive force at the rear contact patch (p7 power curve):
  // force = min(enginePower, P/|wheelSpeed|) — wheelspin bleeds its own
  // drive force, so burnouts self-resolve. The governed drift mode (step 9)
  // sustains the car THROUGH a slide, so the curve no longer needs a
  // drift bypass. The low-speed torque boost (burnout launches) fades out
  // by torqueBoostFadeSpeed of CAR speed.
  const driveBoost = 1 + c.lowSpeedTorqueBoost *
    Math.max(0, 1 - speed / c.torqueBoostFadeSpeed);
  const powerLimitedForce = Math.min(
    c.enginePower,
    c.enginePeakPowerW / Math.max(1, Math.abs(car.rearWheelSpeed)),
  );
  // Handbrake cuts drive to the rear wheel (p9) — the arcade clutch-kick.
  // Binary-throttle players hold full gas while jabbing the handbrake;
  // with drive flowing, engine force + ground reaction overpowers the
  // 14000 N lock and the wheel never locks, so the slide never initiates.
  // Cut the drive and the lock is decisive regardless of throttle;
  // release → full power resumes instantly into the drift.
  const drive = input.handbrake
    ? 0
    : input.throttle * powerLimitedForce * driveBoost;

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
    // p9: gate the cut by LATERAL slip — a straight-line burnout
    // (slip ≈ 0) keeps full rear lateral grip and tracks straight
    // instead of crabbing sideways; the cut blends in as the car
    // actually steps out.
    const latGate = clamp(
      (Math.abs(rearSlip) - c.spinLatCutSlipStart) /
      (c.spinLatCutSlipFull - c.spinLatCutSlipStart), 0, 1);
    rearLatForce *= 1 - (1 - c.spinLatGripFactor) * spinDepth * latGate;
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
  const bodyForceY = frontForceBodyY + rearForceBodyY;

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

  // Governed drift mode (p9): while sliding WITH power on, drive the slip
  // angle toward an explicit target set by the steering, and the speed
  // toward a target set by the throttle. dβ/dt = dphi − ω, so commanding
  //   ω_des = dphi + driftAngleRate · (β − β_target)
  // tracks the angle; the yaw relaxes toward ω_des at driftYawRelax.
  // Replaces the p7 stability assist, the p9 soft ceiling, the p8 drift
  // power gate and the p9 scrub cancel — one law, predictable: floor it +
  // steer = swing out and PARK in the band. Lift → the governor fades and
  // raw tire physics straightens the car.
  const v2 = car.vx * car.vx + car.vy * car.vy;
  const driftIntent = Math.max(input.throttle, input.handbrake ? 1 : 0);
  const driftMode = clamp(
      (Math.abs(bodyBeta) - c.driftModeStart) /
      (c.driftModeFull - c.driftModeStart), 0, 1) *
    driftIntent * rearSlideBlend;
  if (driftMode > 0 && v2 > 4) {
    const sgn = Math.sign(bodyBeta);
    // Steering INTO the drift (opposite sign of beta) deepens the target;
    // countersteer shallows it.
    const steerBias = clamp(input.steer, -1, 1) * -sgn;
    const betaTarget = sgn * clamp(
      c.driftBaseAngle + c.driftSteerAngleGain * steerBias, 0.30, 1.10);
    const dphi = (car.vx * worldForceY - car.vy * worldForceX) / (c.mass * v2);
    const omegaDes = dphi + c.driftAngleRate * (bodyBeta - betaTarget);
    car.angularVel += (omegaDes - car.angularVel) *
      Math.min(1, c.driftYawRelax * dt) * driftMode;

    // Speed governor: throttle sets the drift's pace; the correction acts
    // along the velocity so it never bends the path, only paces it.
    const vTarget = c.driftTargetSpeedMin +
      (c.driftTargetSpeedMax - c.driftTargetSpeedMin) * input.throttle;
    const vNow = Math.sqrt(v2);
    const accel = c.driftSpeedGain * (vTarget - vNow) * driftMode;
    car.vx += (car.vx / vNow) * accel * dt;
    car.vy += (car.vy / vNow) * accel * dt;
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
