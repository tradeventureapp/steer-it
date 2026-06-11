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
  // Honest two-region torque curve (function of throttle & WHEEL speed):
  //   drive = throttle · min(enginePower, enginePeakPowerW / |wheelSpeed|)
  // Below the crossover (peakPowerW/enginePower ≈ 19 m/s wheel speed) the
  // engine makes flat peak torque; above it, constant-power falloff P/v.
  //
  // p12 KEY RATIO: enginePower is held DELIBERATELY LOW relative to the
  // race-tire grip budget so that full-throttle NORMAL cornering stays in
  // GRIP (the drive doesn't saturate the rear) — slides need real
  // provocation (handbrake, sustained wheelspin). The launch still lights
  // up off the line because lowSpeedTorqueBoost briefly multiplies it
  // (9000 × 2.2 = 19800 > 16200 budget → ignites), and it HOOKS UP because
  // the steady cap (9000) is below the kinetic reaction (budget·
  // driftFriction = 16200·0.83 ≈ 13446), so a spinning wheel always
  // decelerates back to grip. No slip gate anywhere.
  enginePower: 9000,                // p11 8400 → 9000 ↑ (p12) low vs grip → grip corners
  enginePeakPowerW: 171000,         // p10 160000 → 171000 (p12) crossover 19 m/s (171k/9k)
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
  // governor LATCHES on once a slide is provoked past driftModeFull and stays
  // engaged (hysteresis) until β collapses below driftLatchRelease. Predictable
  // by construction: floor it + steer = swing out and hold a controlled drift;
  // commit to full lock = the cage lifts and it spins ("hodiny").
  driftModeFull: 0.52,              // p9; p14: drift-LATCH entry angle, rad (~30°)
  driftBaseAngle: 0.70,             // NEW (p9)  rad (~40°) slip target at neutral steer
  driftSteerAngleGain: 0.35,        // NEW (p9)  rad (~20°) steer bias: into = up to ~60°,
                                    //           full countersteer = down to ~20°
  driftAngleRate: 4.0,              // NEW (p9)  1/s — slip-angle tracking stiffness
  driftYawRelax: 8.0,               // NEW (p9)  1/s — yaw relax rate toward the law
  // p12: race-tire grip raised the natural slide speed; bump the governor
  // targets so drifts live at a cinematic 30-50 km/h (was ~25-40).
  driftTargetSpeedMin: 7,           // p9 5 → 7 (p12)  m/s at light throttle (~25 km/h)
  driftTargetSpeedMax: 13,          // p11 11 → 13 (p12)  m/s at full throttle (~47 km/h)
  driftSpeedGain: 3.5,              // p9 2.5 → 3.5 (p12)  1/s — pull speed up harder so
                                    //   slides hold a cinematic pace, not a crawl
  driftFlipDuration: 0.5,           // NEW (p14)  s — a hard counter flick keeps the
                                    //   governor driving the side-to-side transition
                                    //   through center for this long
  driftFlipThreshold: 0.65,         // NEW (p14)  countersteer amount that triggers a flip
  spinReleaseThreshold: 0.82,       // NEW (p14)  steer-INTO amount above which the angle
                                    //   governor releases (stops caging) and lets the car
                                    //   over-rotate into a full spin — full lock = "hodiny"
  driftLatchRelease: 0.16,          // NEW (p14)  rad (~9°) — once the governor has LATCHED
                                    //   onto an established drift it stays engaged until β
                                    //   falls below this (hysteresis), so a held drift never
                                    //   collapses to grip but a gentle corner never trips it
  brakeForce: 21000,                // p10 14000 → 21000 ↑ (p12) braking scaled with grip

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
  steerSpeedFalloff: 1.0,           // p7 0.70 → 1.0 (p13) — no-op now; the front-slip
                                    //   limiter below replaces the crude lock falloff
  speedForFullFalloff: 50,          // (unused since falloff = 1.0)
  // ---------- Speed-sensitive steering / front-slip limit (p13) ----------
  // Caps the commanded front SLIP angle as FORWARD speed rises so a steered
  // race-grip front stops acting as a backward anchor. See step 2b for the
  // full rationale (limit slip not steer → countersteer free; gate on
  // forward speed → deep-drift transitions free).
  frontSlipLimitOptimal: 0.20,      // NEW (p13)  rad (~11.5°) — front-slip cap at speed
  frontSlipLimitSpeedLow: 4.0,      // NEW (p13)  m/s (~14 km/h) — below: full lock
  frontSlipLimitSpeedHigh: 14.0,    // NEW (p13)  m/s (~50 km/h) — at/above: cap = optimal
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

  // ---------- Tire / grip — RACE-TIRE SCALE (p12) ----------
  // The arena is screen-sized: visible turns are ~6-15 m radius, which at
  // any watchable speed demands far more than a road car's ~0.8-1g. Road
  // grip meant EVERY turn saturated the tires and scrubbed speed to a
  // crawl (~16 km/h circles). Grip budgets are raised ~1.5× toward race
  // levels so screen-radius cornering is normal GRIP driving; the friction
  // circle still saturates when PROVOKED (handbrake, sustained wheelspin).
  // Cornering stiffness is scaled with the budgets so the peak-grip slip
  // angle (budget/stiffness) is unchanged (~5.6° rear) — same break-loose
  // feel, more grip.
  // FRONT (undriven): pure lateral model — linear stiffness with a peak cap.
  corneringStiffnessFront: 270000,  // p10 180000 → 270000 ↑ (p12, ~1.5×)
  peakLatGripFront:  20250,         // p10 13500 → 20250  ↑ (p12, ~1.5×) catch authority
  // REAR (driven): lateral stiffness still shapes how fast lateral force
  // builds with slip angle. The PEAK comes from tireGripBudgetRear below.
  corneringStiffnessRear:  165000,  // p10 110000 → 165000 ↑ (p12, ~1.5×)
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
  // (16200 × 0.83 ≈ 13446 N) must EXCEED the engine's force CAP (9000 N),
  // or a spinning wheel can never decelerate back to grip (margin 4446 N).
  tireGripBudgetRear: 16200,        // p5 10800 → 16200 ↑ (p12, ~1.5×) race-tire grip
  // Slip ratio at which longitudinal traction peaks. Below = linear
  // traction (wheel ~matches ground). Above = the wheel is SPINNING
  // (kinetic regime). Lower = wheelspin starts at smaller overspeed.
  slipRatioPeak: 0.15,              // NEW (p4)
  // m/s floor for the slip-ratio denominator — keeps the math sane near
  // standstill. Lower = more violent low-speed wheelspin behavior.
  slipDenomFloor: 3.0,              // NEW (p4)
  // p11 REMOVED: spinLatGripFactor / spinLatCutSlipStart / spinLatCutSlipFull.
  // Those were an EXTRA cut on the rear lateral force while the wheel spun —
  // a patch on top of the friction circle. The circle itself already
  // reduces lateral as the longitudinal slip grows (F_lat = −Fk·nLat/rho:
  // as nLong rises, rho rises, F_lat shrinks). The extra cut over-deepened
  // donuts (60° vs the 45-55° target) now that the governed drift mode
  // controls the angle directly. Pure friction circle is the honest model;
  // the governor handles angle stability.
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
  // p12: boost RAISED so the launch still lights up despite the low steady
  // enginePower (9000 × (1+1.2) = 19800 > 16200 budget → ignites), then
  // fades by torqueBoostFadeSpeed so at speed the drive is the grippy 9000.
  lowSpeedTorqueBoost: 1.2,         // p9 0.5 → 1.2 ↑ (p12) launch ignition vs low eP
  torqueBoostFadeSpeed: 5,          // p9 4 → 5 (p12)  m/s (~18 km/h) where boost = 0
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
  handbrakeLockForce: 19000,        // p5 14000 → 19000 ↑ (p12) must clear the bigger
                                    //   kinetic reaction (13446 N) to lock the rear
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
  // p10: EVIDENCE 1 — at 0-1 km/h the reported slip angle was numerical
  // garbage (atan2 of near-zero velocity), spawning smoke + DRIFT badge +
  // squeal + skids around a parked car. Below this speed the REPORTED
  // slip (car.rearSlip — what the HUD/smoke/squeal/skids consume) ramps
  // to 0. The PHYSICS slip used for forces is untouched (it has its own
  // MIN_LONG floor); WSPIN-driven smoke/skids stay active at any speed so
  // standing burnouts still smoke.
  slipReportSpeedGate: 1.5,         // NEW (p10)  m/s — slip reads 0 below
  slipReportRampWidth: 0.6,         // NEW (p10)  m/s — ramp band up to the gate

  // ---------- Standing pivot = real spin-out (p12, declared assist) ----------
  // At near-zero speed the tires make NO force (no slip → no force), so a
  // genuine spin-out cannot emerge from physics — this is a declared
  // assist, fenced off from the force model. When the rear is LIT
  // (wheelspin), the player STEERS, on THROTTLE, at low speed, the car
  // rotates ABOUT ITS FRONT AXLE: the front stays ~put while the rear
  // sweeps around it in smoke (a spin-out, NOT a driven circle — the p10
  // version drove a neat circle because it yawed about the CG and let the
  // rear drive translate it out). Implemented by (a) ramping yaw toward a
  // spin rate and (b) setting the body velocity to the rotation-about-front
  // solution v_cg = ω × (CG − frontAxle), so net translation stays tiny.
  // Fades out by burnoutPivotFadeSpeed; straighten → assist off → the
  // spinning rear launches the car forward via honest tire force.
  burnoutPivotMaxYaw: 4.5,          // NEW (p12)  rad/s spin rate at full lock + full spin
  // p14: the pivot now carries ANGULAR MOMENTUM — the yaw approaches the
  // target at a FIXED rate (rad/s²) instead of an exponential lerp, so a
  // steer-flip decays the spin THROUGH zero over ~0.4 s and rebuilds the
  // other way (no instantaneous, fake-looking reversal). 8 rad/s² → ~0.4 s
  // from a 3.2 rad/s spin to zero.
  // The pivot BUILDS with a strong proportional approach (overcomes the
  // opposing tire torque so it actually spins up), but a REVERSAL (steer
  // flip) is rate-limited to burnoutPivotAccel so the spin decays through
  // zero over ~0.4 s and rebuilds the other way — angular momentum, no
  // instant fake reversal.
  burnoutPivotBuildRate: 8.0,       // NEW (p14)  1/s proportional build toward spin rate
  burnoutPivotAccel: 8.0,           // p12 burnoutPivotRate (lerp) → 8.0 (rad/s² reversal, p14)
  burnoutPivotVelBlend: 12.0,       // NEW (p12)  1/s blend of velocity onto front-pivot
  burnoutPivotFadeSpeed: 4.0,       // p10 (unchanged)  m/s (~20 km/h) where assist = 0
  burnoutPivotSteerDead: 0.12,      // NEW (p12)  |steer| below this = no pivot (launch)

  // ---------- Collision vs desktop obstacles (p10) ----------
  // The car is treated as a circle against axis-aligned obstacle rects
  // (icons, taskbar). Arcade bounce: reflect the normal velocity with
  // restitution, keep most of the tangential component, push the car out
  // so it never sinks in. Yaw is damped in proportion to impact strength
  // so a mid-drift wall thump doesn't explode the spin.
  carCollisionRadius: 0.85,         // NEW (p10)  m
  collisionRestitution: 0.35,       // NEW (p10)  normal bounce kept (0..1)
  collisionTangentFriction: 0.12,   // NEW (p10)  tangential speed lost on hit
  collisionPushOut: 0.02,           // NEW (p10)  m extra separation after push-out
  collisionYawDamp: 0.35,           // NEW (p10)  yaw kill at full-strength impact

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

  // Drift-transition latch (p14, seconds). A hard counter flick sets this;
  // while it counts down the angle governor drives the flip THROUGH center
  // to the opposite side (else it would gate off at center and stall).
  flipTimer: number;

  // Drift-engagement latch (p14). The governor ENGAGES only when a slide is
  // clearly established (deep β + rear sliding under power) and STAYS engaged
  // with hysteresis as a countersteer shallows the angle — so a held drift
  // doesn't collapse to grip, while a gentle grip-corner never trips it.
  driftActive: boolean;

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
    flipTimer: 0,
    driftActive: false,
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

// =============================================================================
//  FORCE FLOW (read top to bottom — this is the honest model, p11).
//
//  throttle ──▶ ENGINE TORQUE CURVE  (function of throttle & WHEEL speed only,
//                                     NO slip-angle term anywhere)
//                  │ drive force at the rear contact patch
//                  ▼
//              REAR WHEEL  (own inertia; spins up on drive, dragged toward
//                           ground speed by tire friction, braked by pedal/
//                           handbrake) ──▶ slip ratio s = (wv − ground)/denom
//                  │
//                  ▼
//              FRICTION CIRCLE  (one grip budget shared long/lat):
//                  nLong = s/slipRatioPeak,  nLat = slipAngle/alphaPeak
//                  rho ≤ 1 grip:  F = (budget·nLong, −budget·nLat)
//                  rho > 1 slide: F = budget·driftFriction·(nLong,−nLat)/rho
//                  → a SPINNING wheel (nLong ≫ nLat) puts down a strong
//                    FORWARD force (F_long→Fk) and little lateral: that is
//                    how a powered drift both holds its angle AND keeps
//                    moving. Verified: net longitudinal ≥ 0 at every slip
//                    angle 5-45° (the slip-sweep table).
//                  │  + front tire lateral (linear, capped) for turn-in/catch
//                  ▼
//              BODY FORCES  →  translation (vx,vy) and yaw torque (ω)
//                  │
//                  ▼
//              ANTI-PERMA-BURNOUT is honest: the launch lights up because
//              boosted drive briefly exceeds kinetic reaction; it HOOKS UP
//              because the steady force CAP (enginePower 9000) is below the
//              kinetic reaction (budget·driftFriction ≈ 13446), so the
//              spinning wheel always decelerates back to grip. No gate.
//
//  THE ONE ASSIST: real drifting is an unstable equilibrium a driver
//  balances continuously; a phone-tilt binary player cannot. The raw model
//  above is self-stabilizing (it recovers to grip — realistic), so without
//  help it will not SUSTAIN a hands-off drift. The "governed drift mode"
//  (step 9 below) is therefore the single declared assist: while sliding on
//  power it nudges YAW toward a steering-set angle and SPEED toward a
//  throttle-set target. It changes no tire force — it is a stability
//  controller layered on the honest forces, exactly like every arcade
//  drift game. Auto-countersteer (step 2) is a steering aid in the same
//  spirit (it points the fronts where a drifter would). Everything else is
//  physics.
// =============================================================================

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
  const halfWB = c.wheelbase / 2;
  // High-speed steering falloff (p13: superseded by the slip limiter below,
  // steerSpeedFalloff set to 1.0 = no-op; left in place as a fallback knob).
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
  let effectiveSteer =
    playerSteer * (1 - alignGate) +
    (alignAngle + playerSteer * c.autoCounterTrim) * alignGate;

  // ---- 2b. Speed-sensitive steering (p13) — the front must not be a BRAKE.
  // A steered front at race grip and full 57° lock makes a tire force
  // pointing largely BACKWARD along velocity (~up to 17 kN vs the 9 kN
  // engine) — an anchor that collapsed speed the instant a tilt player
  // turned, even with the rear fully planted. Fix: cap the commanded front
  // SLIP angle (the wheel's deviation from the FRONT axle's own velocity
  // direction), tightening as FORWARD speed rises toward frontSlipLimit-
  // Optimal (peak lateral force, minimal induced drag).
  //   - Limiting SLIP (not raw steer) means COUNTERSTEER passes at full
  //     authority: pointing the wheel toward the front's velocity REDUCES
  //     slip, which the cap never restricts.
  //   - Gating on FORWARD speed (not total) means a deep drift — low
  //     forwardVel, high total speed — relaxes the cap, so drift-direction
  //     TRANSITION flicks swing the rear over instead of anchoring.
  //   - Below frontSlipLimitSpeedLow the full lock remains (parking,
  //     standing pivot).
  if (forwardVel > c.frontSlipLimitSpeedLow) {
    const t = clamp(
      (forwardVel - c.frontSlipLimitSpeedLow) /
      (c.frontSlipLimitSpeedHigh - c.frontSlipLimitSpeedLow), 0, 1);
    const slipCap = c.maxSteerAngle + (c.frontSlipLimitOptimal - c.maxSteerAngle) * t;
    const frontVelAngle = Math.atan2(lateralVel + car.angularVel * halfWB, forwardVel);
    effectiveSteer = clamp(effectiveSteer, frontVelAngle - slipCap, frontVelAngle + slipCap);
  }

  // ---- 3. Velocities at each axle (include yaw contribution) ----
  // For a rigid body with angular velocity w, the velocity at a point r off
  // the CG (in body frame) is v_cg + (-w*ry, w*rx). The axles are on the body
  // x-axis, so r = (+L/2, 0) and r = (-L/2, 0).

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

  // Engine drive force at the rear contact patch — an HONEST torque curve,
  // a function of THROTTLE and WHEEL SPEED ONLY (no slip-angle term; the
  // engine never "knows" the car is cornering). Two regions, like a real
  // engine through a fixed gear:
  //   - below the crossover wheel speed (enginePeakPowerW / enginePower ≈
  //     19 m/s) the engine makes flat PEAK TORQUE → force = enginePower;
  //   - above it, the CONSTANT-POWER region → force = P / wheelSpeed
  //     (torque falls with RPM, the high end of the curve). This also sets
  //     a natural top speed and is the honest reason a high-RPM wheelspin
  //     bleeds its own drive force.
  // The crossover is set high enough (~68 km/h of wheel speed) that the
  // whole normal driving + cornering-wheelspin range sits in the strong
  // peak-torque region — so cornering never starves the drive.
  // lowSpeedTorqueBoost is the launch end of the curve (gearing torque
  // multiplication off the line), fading out by torqueBoostFadeSpeed.
  const driveBoost = 1 + c.lowSpeedTorqueBoost *
    Math.max(0, 1 - speed / c.torqueBoostFadeSpeed);
  const powerLimitedForce = Math.min(
    c.enginePower,
    c.enginePeakPowerW / Math.max(1, Math.abs(car.rearWheelSpeed)),
  );
  // Handbrake cuts drive to the rear wheel (p9) — the arcade clutch-kick.
  // Binary-throttle players hold full gas while jabbing the handbrake;
  // with drive flowing, engine force + ground reaction overpowers the
  // lock force and the wheel never locks, so the slide never initiates.
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
  // merely slowing the car. (p6) — the ONLY lateral modifier on top of
  // the friction circle now (the p7 power-spin cut was removed in p11).
  if (input.handbrake) rearLatForce *= c.handbrakeLatGripFactor;

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

  // Standing-pivot YAW (p12, declared assist — paired with the front-axle
  // velocity coupling in step 9b). Computed here so it drives the heading
  // THIS frame (not a frame late). Active only when the rear is LIT, the
  // player STEERS on THROTTLE, slow. Ramped hard toward the spin rate so a
  // half-frame of damping can't bleed it. spinNow/pivotActive are reused
  // below for the velocity coupling.
  const spinNow = isRearSliding ? Math.min(1, Math.abs(s)) : 0;
  // PLATEAU fade (p12): FULL pivot strength below ~0.6·fadeSpeed, ramping
  // to 0 by fadeSpeed. A plain linear fade scaled the pivot's yaw with
  // speed, so lowering the cutoff to free the donut also weakened the spin
  // — the plateau keeps it strong right up to the cutoff, then drops fast
  // (the donut runs well above fadeSpeed, so it's never captured).
  const pivotFade = clamp(
    (c.burnoutPivotFadeSpeed - speed) / (c.burnoutPivotFadeSpeed * 0.4), 0, 1);
  const pivotActive = pivotFade > 0 && spinNow > 0.3 &&
    input.throttle > 0.05 && Math.abs(input.steer) > c.burnoutPivotSteerDead;
  if (pivotActive) {
    const targetYaw = Math.sign(input.steer) * c.burnoutPivotMaxYaw * spinNow * pivotFade;
    const reversing = targetYaw * car.angularVel < 0 && Math.abs(car.angularVel) > 0.1;
    if (reversing) {
      // Momentum: decelerate toward zero at a limited rate (steer-flip looks
      // real — the spin winds down through zero, ~0.4 s, before rebuilding).
      const maxDelta = c.burnoutPivotAccel * dt;
      car.angularVel += clamp(targetYaw - car.angularVel, -maxDelta, maxDelta);
    } else {
      // Build: a strong proportional approach overcomes the opposing tire
      // torque so the pivot actually reaches the spin rate.
      car.angularVel += (targetYaw - car.angularVel) * Math.min(1, c.burnoutPivotBuildRate * dt);
    }
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
  car.vx += worldForceX / c.mass * dt;
  car.vy += worldForceY / c.mass * dt;

  // ---- 9b. Standing pivot VELOCITY (p12, declared) — paired with the yaw
  // ramp in step 8. Rotation ABOUT THE FRONT AXLE so the rear sweeps around
  // a near-stationary front (a spin-out, not a driven circle): the front is
  // +halfWB ahead along heading, so v_cg = ω × (CG − front) =
  // ω·halfWB·(sinH, −cosH). Blending the body velocity onto this keeps the
  // front ~put and net translation tiny. Mutually exclusive with the
  // governed drift mode. Straighten → assist off → the rear launches it.
  if (pivotActive) {
    const pvx =  car.angularVel * halfWB * sinH;
    const pvy = -car.angularVel * halfWB * cosH;
    const b = Math.min(1, c.burnoutPivotVelBlend * dt) * pivotFade;
    car.vx += (pvx - car.vx) * b;
    car.vy += (pvy - car.vy) * b;
  } else {
    // Governed drift mode (p9): the single declared drift-stability assist —
    // while sliding WITH power on, nudge YAW toward a steering-set angle and
    // SPEED toward a throttle-set target. Changes no tire force.
    const v2 = car.vx * car.vx + car.vy * car.vy;
    const vNow = Math.sqrt(v2);
    const driftIntent = Math.max(input.throttle, input.handbrake ? 1 : 0);
    // ENGAGEMENT (p14) — a HYSTERESIS LATCH, not an instantaneous gate. The
    // governor only ENGAGES once a slide is clearly established (β past the
    // driftModeFull angle while the rear slides under power/handbrake), and it
    // STAYS engaged as a countersteer shallows the angle, releasing only when
    // β collapses below driftLatchRelease or the rear regrips. This solves the
    // old dilemma in one stroke: a gentle grip-corner (marginal slip, shallow
    // β) never trips the latch, yet a deliberately held shallow drift doesn't
    // fall out of governed mode the instant it dips under the entry threshold.
    const sliding = rearSlideBlend > 0 && driftIntent > 0;
    // PROVOCATION: a slide counts as a deliberate drift (vs a gentle grip-
    // corner that marginally breaks the rear loose) when the player is clearly
    // committing — handbrake, a real steering input, the rear well loose, or
    // the angle already deep. Engaging on provocation (not waiting for β to
    // build) lets the speed governor hold pace through the ENTRY, instead of
    // the entry scrubbing all the speed and dropping the car into pivot mode.
    const provoke = input.handbrake ||
      Math.abs(input.steer) > 0.45 ||
      Math.abs(bodyBeta) >= c.driftModeFull;
    if (!car.driftActive) {
      if (sliding && provoke) car.driftActive = true;
    } else if ((!sliding || Math.abs(bodyBeta) < c.driftLatchRelease) &&
               car.flipTimer <= 0) {
      car.driftActive = false;
    }
    const govMode = car.driftActive ? driftIntent * rearSlideBlend : 0;
    if (govMode > 0) {
      // SPEED governor — the THRUST term is GATED BY THROTTLE (p14). An assist
      // amplifies what the player commands; it must never be a second motor.
      // accel > 0 (push the drift up to pace) is scaled by input.throttle, so
      // zero throttle = zero thrust: a handbrake slide with no gas SCRUBS and
      // STOPS like a real locked-rear turn instead of self-sustaining a
      // perpetual donut. The accel < 0 (cap excess speed) term is ungated —
      // it only ever REMOVES energy, never adds. (Floored denominator so a
      // slow drift is still paced; carries speed through a transition.)
      const vTarget = c.driftTargetSpeedMin +
        (c.driftTargetSpeedMax - c.driftTargetSpeedMin) * input.throttle;
      let accel = c.driftSpeedGain * (vTarget - vNow) * govMode;
      if (accel > 0) accel *= input.throttle;
      if (vNow > 0.3) {
        car.vx += (car.vx / vNow) * accel * dt;
        car.vy += (car.vy / vNow) * accel * dt;
      }
      // ANGLE governor — STABILISE, DON'T CAGE (p14). The assist holds the
      // drift at a steering-set angle so a normal slide is catchable and
      // expressive — but it must yield the instant the player COMMITS to a
      // spin. Three regimes, by how the wheel relates to the slide:
      //
      //   • steer INTO / countersteer at normal amounts → HOLD the angle
      //     (betaTarget tracks the wheel: more lock = deeper drift). This is
      //     the holdable donut / sustained drift.
      //   • steer HARD INTO (steerBias > spinReleaseThreshold, i.e. full lock,
      //     or hard lock while the rear is deep/handbraked) → authority ramps
      //     to ZERO: the cage is lifted, raw physics over-rotates past 90°
      //     into a full 360° spin ("hodiny").
      //   • HARD COUNTER flick while sliding → latch a transition for
      //     driftFlipDuration, driving the flip THROUGH center to the other
      //     side (counterAmount collapses to 0 at the zero-crossing, so without
      //     the latch a side-to-side flick stalls mid-cross).
      //
      // Only engages above ~1 m/s (dphi divides by v2).
      if (v2 > 1) {
        const sgn = Math.sign(bodyBeta) || 1;
        const steerBias = clamp(input.steer, -1, 1) * -sgn;   // + into slide, − counter
        const counterAmount = clamp(-steerBias, 0, 1);        // 1 at full countersteer
        const intoAmount = clamp(steerBias, 0, 1);            // 1 at full steer-into
        // Latch a transition on a hard counter flick while the rear slides.
        if (counterAmount >= c.driftFlipThreshold && rearSlideBlend > 0.3) {
          car.flipTimer = c.driftFlipDuration;
        }
        const dphi = (car.vx * worldForceY - car.vy * worldForceX) / (c.mass * v2);
        if (car.flipTimer > 0) {
          // Drive toward the OPPOSITE drift (steer sign is opposite the
          // resulting β sign), full authority, bypassing the deadband so it
          // crosses center.
          const betaTarget = -Math.sign(input.steer || 1) * c.driftBaseAngle;
          const omegaDes = dphi + c.driftAngleRate * (bodyBeta - betaTarget);
          car.angularVel += (omegaDes - car.angularVel) *
            Math.min(1, c.driftYawRelax * dt) * govMode;
        } else {
          // RELEASE ramp: full authority up to spinReleaseThreshold of steer-
          // into, fading to zero at full lock so a committed spin runs free.
          const release = clamp(
            (intoAmount - c.spinReleaseThreshold) / (1 - c.spinReleaseThreshold), 0, 1);
          const authority = govMode * (1 - release);
          if (authority > 0) {
            // betaTarget tracks the wheel: steering into deepens the drift,
            // countersteering shallows it — the player sets the angle, the
            // governor just steadies the car to it.
            const betaTarget = sgn * clamp(
              c.driftBaseAngle + c.driftSteerAngleGain * steerBias, 0.30, 1.10);
            const omegaDes = dphi + c.driftAngleRate * (bodyBeta - betaTarget);
            car.angularVel += (omegaDes - car.angularVel) *
              Math.min(1, c.driftYawRelax * dt) * authority;
          }
        }
      }
    }
  }

  car.x  += car.vx * dt;
  car.y  += car.vy * dt;

  // ---- 10. Snap tiny velocities to zero (clean rest state) ----
  if (Math.abs(car.vx) < 0.01) car.vx = 0;
  if (Math.abs(car.vy) < 0.01) car.vy = 0;
  if (Math.abs(car.angularVel) < 0.005) car.angularVel = 0;
  if (car.flipTimer > 0) car.flipTimer = Math.max(0, car.flipTimer - dt);

  // ---- 11. Derived state for HUD / skids ----
  car.speed = Math.hypot(car.vx, car.vy);
  car.forwardSpeed = forwardVel;
  car.frontSlip = frontSlip;
  // p10: gate the REPORTED slip to 0 below slipReportSpeedGate so a parked
  // car shows no phantom slip — no smoke, DRIFT badge, squeal or skids from
  // atan2 noise at standstill. Ramps over slipReportRampWidth to avoid a
  // pop when a real drift crosses the gate. The physics slip (local
  // `rearSlip`) used for forces is untouched.
  const slipReport = clamp(
    (car.speed - (c.slipReportSpeedGate - c.slipReportRampWidth)) /
    c.slipReportRampWidth, 0, 1);
  car.rearSlip = rearSlip * slipReport;
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

// -----------------------------------------------------------------------------
//  Obstacle collision (p10) — car-as-circle vs axis-aligned rects.
//  Arcade bounce per CONFIG: restitution on the normal component, light
//  friction on the tangential one, positional push-out so the car never
//  sinks in or tunnels (speeds stay well under a radius per substep).
//  Returns the strongest normal impact speed this call (0 = no hit), so
//  the caller can drive feedback (sound/shake) later.
// -----------------------------------------------------------------------------
export interface ObstacleRect { x: number; y: number; w: number; h: number; }

export function collideWithRects(
  car: CarState, rects: ObstacleRect[], c: Config = CONFIG,
): number {
  const R = c.carCollisionRadius;
  let strongest = 0;
  for (const r of rects) {
    // Closest point on the rect to the car center.
    const px = clamp(car.x, r.x, r.x + r.w);
    const py = clamp(car.y, r.y, r.y + r.h);
    const dx = car.x - px;
    const dy = car.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) continue;

    // Contact normal + penetration depth.
    let nx: number, ny: number, pen: number;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      nx = dx / d; ny = dy / d;
      pen = R - d;
    } else {
      // Center inside the rect — exit along the shallowest face.
      const left = car.x - r.x, right = r.x + r.w - car.x;
      const top = car.y - r.y, bottom = r.y + r.h - car.y;
      const m = Math.min(left, right, top, bottom);
      if (m === left)       { nx = -1; ny = 0; pen = R + left; }
      else if (m === right) { nx =  1; ny = 0; pen = R + right; }
      else if (m === top)   { nx = 0; ny = -1; pen = R + top; }
      else                  { nx = 0; ny =  1; pen = R + bottom; }
    }

    // Push out, then bounce: reflect the inbound normal component with
    // restitution, keep the tangential with light friction.
    car.x += nx * (pen + c.collisionPushOut);
    car.y += ny * (pen + c.collisionPushOut);
    const vn = car.vx * nx + car.vy * ny;
    if (vn < 0) {
      const tx = car.vx - vn * nx;
      const ty = car.vy - vn * ny;
      // Tangential friction scales with impact strength (full effect at
      // ~5 m/s of normal speed). Resting/scraping contact repeats every
      // frame — a constant per-contact loss would glue the car to walls.
      const tf = 1 - c.collisionTangentFriction * Math.min(1, -vn / 5);
      const bounce = -vn * c.collisionRestitution;
      car.vx = tx * tf + nx * bounce;
      car.vy = ty * tf + ny * bounce;
      // Calm the spin in proportion to impact strength (full damp at
      // ~10 m/s of normal speed) — a mid-drift thump shouldn't pirouette.
      const impact = Math.min(1, -vn / 10);
      car.angularVel *= 1 - c.collisionYawDamp * impact;
      strongest = Math.max(strongest, -vn);
    }
  }
  return strongest;
}
