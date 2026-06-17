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
  inertiaScale: 8.0,                // p19b reverted 9.3 → 8.0 (feel-test: keep pre-p19 rotation)
  // Verze 3 Stage ii — REAL-SIZE yaw/slip wheelbase, used ONLY in driftMode==='sim-real' (the
  // physics yaw torque arm + axle slip velocities + inertia). Restores the yaw↔slide coupling
  // the 1/3 arm (0.867) broke → lateral velocity scrubs ~6× slower → a deep drift can hold.
  // PHYSICS-ONLY: render/collision/skid keep the small CONFIG.wheelbase (car looks identical).
  // Inertia in sim-real = mass·simRealWheelbase²/12 = 676 (no inertiaScale hack).
  simRealWheelbase: 2.6,            // m (vs the 1/3 visual wheelbase 0.867)

  // ---------- Engine / brakes ----------
  // Honest two-region torque curve (function of throttle & WHEEL speed):
  //   drive = throttle · min(enginePower, enginePeakPowerW / |wheelSpeed|)
  // Below the crossover (peakPowerW/enginePower ≈ 19 m/s wheel speed) the
  // engine makes flat peak torque; above it, constant-power falloff P/v.
  //
  // p12 KEY RATIO: enginePower is held DELIBERATELY LOW relative to the
  // race-tire STATIC grip budget so that full-throttle NORMAL cornering stays
  // in GRIP (the drive doesn't saturate the rear at part throttle / cruise) —
  // slides need real provocation (handbrake, sustained wheelspin). The launch
  // lights up off the line because lowSpeedTorqueBoost briefly multiplies it
  // (9000 × 2.2 = 19800 > 16200 budget → ignites).
  // p18c: the rear KINETIC reaction is budget·rearDriftFriction = 16200·0.65 ≈
  // 10530, ABOVE the steady cap (9000) — so a spinning rear always decelerates
  // back to grip (no perma-burnout), while the LOW-ish rear friction still lets a
  // PROVOKED slide run long. Re-grip is guaranteed at part throttle, at cruise
  // (power-curve drive P/v falls below it) and off-throttle. No slip gate.
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
  // p18 HYBRID — MASTER ASSIST LEVEL (the future Arcade↔Sim drift toggle, and
  // the SINGLE SOURCE OF TRUTH for governor strength). 1 = full arcade assist
  // (the fine-control governor on, the default); 0 = pure EMERGENT sim drift
  // (governor fully off → raw friction-circle physics, the ~60° free slide).
  // It SCALES every governor term — the angle-hold AND the speed governor — so
  // they collapse cleanly to the emergent model at 0, with no other change.
  // The DELIBERATE SPIN ("hodiny") and the Fix-2 reversed-thrust gate are
  // applied INDEPENDENTLY of this and keep working at EVERY level. Expose this
  // later as a player setting (Arcade↔Sim / difficulty) with no further rework.
  driftAssist: 1.0,                 // p18 — 1 = arcade (default) … 0 = pure sim
  // p18 — deepest governed drift angle, rad (~51°). betaTarget is now
  // PROPORTIONAL to steer-into and ZERO at neutral/countersteer (replaces the
  // old driftBaseAngle floor): steering SETS the drift angle (fine control) and
  // straightening commands β→0 (the recovery fix — no more pinning β on held
  // throttle). Raise for deeper max drifts, lower for a tighter envelope.
  driftAngleMax: 0.90,              // p18  rad (~51°) — full steer-into target
  // p12: race-tire grip raised the natural slide speed; bump the governor
  // targets so drifts live at a cinematic 30-50 km/h (was ~25-40).
  // p16 SIZE-BY-ENTRY-SPEED: the old strong gain YANKED speed to vTarget, so a
  // 52-88 km/h entry collapsed to a fixed ~33 km/h every time → one donut size
  // (R = v/ω, v pinned ⇒ R pinned). Gain dropped + the ceiling raised so the
  // governor only GENTLY shapes speed: entry speed largely persists (mild bleed),
  // a fast entry ⇒ a big/long drift, a slow one ⇒ tight. Easy to feel-tune.
  driftTargetSpeedMin: 9,           // p16 7 → 9   m/s (~32 km/h) light-throttle floor
  driftTargetSpeedMax: 22,          // p16 13 → 22  m/s — raised ceiling so a fast entry isn't capped to a slow donut
  driftSpeedGain: 1.0,              // p16 3.5 → 1.0  1/s — STEP 1 (conservative): dampened, not
                                    //   zeroed. Was pinning every drift to ~33 km/h (one donut);
                                    //   at 1.0 entry speed clearly carries (R ~13→22 m over a
                                    //   20→100 km/h entry) yet the drift still holds. Push lower
                                    //   (0.8/0.6) in step 2 after the feel-test for a fuller continuum.
  driftFlipDuration: 0.5,           // NEW (p14)  s — a hard counter flick keeps the
                                    //   governor driving the side-to-side transition
                                    //   through center for this long
  driftFlipThreshold: 0.65,         // NEW (p14)  countersteer amount that triggers a flip
  spinReleaseThreshold: 0.78,       // p14b — steer-INTO INTENT (post-expo command, pre-limiter)
                                    //   above which a HELD tilt arms the spin. Kept ABOVE the
                                    //   holdable-donut steer (~0.7) so only a near-max, decisive
                                    //   tilt (≈32°+) spins. What made the old 0.82 "never fire"
                                    //   was the MECHANISM — a weak magnitude ramp over an inert
                                    //   release — not the number; the debounce + active spin-
                                    //   drive below fire reliably the instant a real commit lands.
  spinReleaseHold: 0.15,            // NEW (p14b)  s — the steer-into must be HELD this long to
                                    //   fully arm the spin (deliberate, not an accidental flick).
                                    //   Re-cages at 2× this rate when the player backs off.
  spinReleaseThresholdHB: 0.90,     // p16 0.25 → 0.90 — steer COMMAND needed to arm a spin
                                    //   WHILE THE HANDBRAKE IS HELD. DRIFT-FEEL FIX: the old 0.25
                                    //   (p15b) sat INSIDE the normal handbrake-drift steer range
                                    //   (~0.3-0.7), so an ordinary drift tilt armed the additive
                                    //   spin yaw — the car over-rotated, the governor re-caged, β
                                    //   collapsed, and it re-armed: a donut↔spin LIMIT CYCLE that
                                    //   made the slide feel locked to a couple of discrete "donut
                                    //   sizes" with nothing in between (sim: β ping-ponged 0°↔87°).
                                    //   At 0.90 a normal tilt + handbrake now HOLDS a steady,
                                    //   steerable drift; only a deliberate near-full tilt (command
                                    //   ≥0.90 ≈ 33° after the 1.7 expo) + handbrake still spins.
                                    //   (Reads raw |steer|, not the β-relative "into": a locked
                                    //   rear gives β the SAME sign as the steer.)
  spinYawRate: 4.0,                 // NEW (p14b)  rad/s — when armed, ADD this much yaw (in the
                                    //   tilt direction) ON TOP of the natural drift rotation so
                                    //   the car genuinely over-rotates into a spin. The honest
                                    //   tyre model is stable ~44°, so merely releasing won't spin
                                    //   it, and a yaw-rate TARGET would CAP rotation — additive
                                    //   always rotates further than the donut would.
  slideBlendSmoothRate: 20,         // NEW (p15b)  1/s low-pass rate on rearSlideBlend (kills the
                                    //   handbrake locked-wheel per-frame flicker that stalled the
                                    //   spin arm). Fast enough to engage promptly, slow enough to
                                    //   bridge the 1-frame dropouts.
  driftLatchRelease: 0.16,          // NEW (p14)  rad (~9°) — once the governor has LATCHED
                                    //   onto an established drift it stays engaged until β
                                    //   falls below this (hysteresis), so a held drift never
                                    //   collapses to grip but a gentle corner never trips it
  brakeForce: 38000,                // p21 21000 → 30000 → 38000 BAKED (feel-test) — the foot
                                    //   brake is GRIP-RELATIVE (force-proportional target-slip),
                                    //   weaker/linear, so raised to keep stopping power. Near-full
                                    //   rear demand 0.35·38000 = 13300 N sits at the breakaway
                                    //   boundary (≈0.85·budget = 13770 N straight), so a near-full
                                    //   pedal breaks the rear loose → skid under any steering (where
                                    //   longHeadroom < 1 lowers it). Still LIVE-TUNED on the PC 'D' HUD.
  // p21 — foot-brake grip-relative breakaway: the rear keeps grip while the brake
  // FORCE DEMAND stays within this fraction of the friction-circle longitudinal
  // grip; a near-full pedal exceeds it and the rear breaks loose into a skid (NO
  // ABS). <1 = can lock on asphalt; 1.0 = foot brake never locks. LIVE-TUNED.
  brakeGripFraction: 0.85,          // p21 BAKED (near-full pedal breaks loose)

  // ---------- Resistance (unchanged) ----------
  dragCoeff: 2.5,                   // air drag, force = dragCoeff * v * |v|
  rollingResistance: 50,            // rolling drag, force = rollingResistance * v

  // ---------- Rest threshold (static-friction style HARD PARK) ----------
  // Resistance only asymptotes toward zero, AND rolling resistance is weak, so a
  // coasting/just-braked car drifts at ~0.4-0.5 m/s for 10+ s before resting —
  // a visible creep of several metres. restSpeed must sit ABOVE that coast tail
  // (it was 0.35, BELOW it → the snap never caught it). With NO drive input
  // (throttle + brake + handbrake all off) below restSpeed we HARD-LOCK linear
  // AND angular velocity to 0 every frame — a true parked state nothing can
  // re-inject. Gated on idle + low-speed: the instant any input returns, full
  // physics resumes, so driving / slow throttle crawls / drifting are untouched.
  restSpeed: 0.6,                   // m/s (~2.2 km/h) — below this (idle) → parked

  // ---------- Steering ----------
  // More lock and higher high-speed authority so countersteer can actually
  // CATCH a slide. With the old falloff a drift at speed had ~55% of full
  // lock available — not enough to point the fronts into the slide.
  // p7: real drift cars run 50-65° of lock precisely to HOLD big angles —
  // at 40° the fronts ran out of countersteer long before a 50° drift
  // could balance. steerSpeed up so full lock arrives in ~0.15 s.
  maxSteerAngle: 0.873,             // p19 1.0 → 0.873 (57° → 50°) PROTOTYPE — tunable, revert to 1.0
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
  // Kinetic/static friction ratio once a tire is past peak — the grip a tyre
  // keeps once it's SLIDING (static grip while gripping = the full budget, never
  // touched, so cornering grip is unchanged). p18c SPLIT into FRONT and REAR
  // because the single value pulled turn-in and drift in OPPOSITE directions:
  //   - the FRONT cap governs TURN-IN: high front = the front bites in a hard
  //     corner (sharp turn-in, no understeer); low front = it washes out wide.
  //   - the REAR circle's saturated magnitude governs DRIFT: lower rear = the
  //     rear slips more (stronger, longer-sustaining slides); high rear hooks
  //     back up (little drift). A SINGLE value at 0.83 gave sharp turn-in but
  //     too little drift; at 0.50 gave strong drift but understeer. The split
  //     wins both. (sim-verified vs 8f2a69f: front 0.83 restores turn-in EXACTLY
  //     at any rear; rear 0.65 = strong drift that still catches cleanly ~0.8 s.)
  // FRONT — TURN-IN authority. Keep HIGH. 0.83 = the OLD tuned turn-in/launch.
  frontDriftFriction: 0.83,         // p18c (was the shared driftFriction) ↑ turn-in
  // REAR — DRIFT slip / throttle-sustain. LOWER = looser, stronger, longer slides.
  // 0.65 = strong drift + clean ~0.8 s catch. Feel-tune: 0.60 looser (deeper,
  // ~1.0 s catch) … 0.70 more catchable (a touch less deep). Note the rear
  // wheelspin/hook-up relationship below now reads budget·rearDriftFriction.
  rearDriftFriction: 0.65,          // p18c (was the shared driftFriction) ↓ drift

  // ---------- Throttle REAR-RE-GRIP (p19b — ACCEL-ONLY half of the load transfer) ----------
  // p19 added a symmetric load transfer; the feel-test kept ONLY the throttle →
  // rear-re-grip half (the clean STRAIGHTEN+THROTTLE drift EXIT, incl. at full
  // throttle) and REJECTED the lift/brake → rear-lighten half (lift-off oversteer,
  // trail-brake entry, moderate-steer eagerness). So this is now ACCEL-ONLY and
  // REAR-ONLY: while ACCELERATING, the rear's LATERAL grip is scaled UP (re-loads
  // the rear → pulls a straightened car back to grip); lift/brake do NOTHING (the
  // ax term is clamped ≥ 0), so there is no lift-off / trail-brake / scrub-
  // breakaway — fine control + cornering match the pre-p19 (d2fd2e1) model. Pure
  // multiplicative trim on the final rear lateral force; friction circle + rear
  // wheelspin reaction untouched (power-over/sustain intact). 0 = OFF (= d2fd2e1).
  loadTransferGain: 0.35,           // 0..1 — rear-grip BOOST under throttle (exit aid). 0.25 milder
  loadTransferRefAccel: 6.0,        // m/s² of forward accel mapping to the FULL boost
  loadTransferSmooth: 12.0,         // 1/s low-pass on measured ax (kills per-frame noise)
  // Engine/compression braking (p19) was only there to feed lift-off; with the
  // lift/brake half removed it serves no purpose, so it's OFF (matches pre-p19
  // coast feel). Left as a tunable knob in case we want coast-down later.
  engineBraking: 0,                 // N of coast-down decel (0 = off, pre-p19)

  // ---------- Rear wheelspin / friction circle — PASS 4, the drift core ----------
  // The rear tire has ONE total grip budget (N) shared between longitudinal
  // force (wheelspin / braking) and lateral force (cornering). Wheelspin
  // consumes the budget → lateral grip collapses → THROTTLE STEERS THE
  // DRIFT ANGLE. Replaces the rwdPowerOversteerStrength hack (p2 0.20,
  // removed) and the separate peakLatGripRear cap (p2 8200, removed —
  // lateral-only peak is now the full budget when the wheel isn't spinning).
  // IMPORTANT relationship: kinetic reaction = budget × rearDriftFriction
  // (16200 × 0.65 ≈ 10530 N) must EXCEED the engine's force CAP (9000 N),
  // or a spinning wheel can never decelerate back to grip (margin 1530 N).
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
  lowSpeedTorqueBoost: 2.0,         // p20
  torqueBoostFadeSpeed: 14,         // p20
  boostSteerDead: 0.10,             // p20 |steer| below = straight = no spin boost
  boostSteerFull: 0.45,             // p20 |steer| at/above = full spin boost
  burnoutThrottle: 0.9,             // p15 0.9 (p15b: ramp retuned). The launch torque-boost (the
                                    //   wheelspin ignition off the line) ramps in over
                                    //   [this, 1.0] — i.e. only the TOP of the pedal lights up.
                                    //   The phone's analog pedal maps a finger at half-strip to
                                    //   ~0.67 throttle (the top quarter is a 1.0 saturation zone),
                                    //   so the old [0.8,0.9] ramp ignited at a ~60% finger. Now
                                    //   the boost needs a near-pinned pedal (value ≥ ~0.9, the top
                                    //   ~third of the strip) — a true half-pedal launches on grip.
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
  // SIZING: the locked tire's kinetic reaction (budget × rearDriftFriction ≈
  // 10530 N) constantly tries to spin the wheel BACK UP — the handbrake's
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
  handbrakeLatGripFactor: 0.10,     // p6 0.30 → 0.10 ↓ (p15) the handbrake is THE slide tool:
                                    //   a locked rear has almost no lateral grip, so turn-in +
                                    //   handbrake instantly throws the rear into a big slide.
  // p16 — DESTABILISE > BRAKE. The locked rear's LONGITUDINAL force is a huge
  // scrub (~13 kN ≈ 11 m/s²) that braked every handbrake drift down to a fixed
  // ~33 km/h regardless of entry speed (the "handbrake brakes too much" feel —
  // and the reason every donut was the same size). This scales the rear
  // longitudinal force WHILE THE HANDBRAKE IS HELD (the longitudinal twin of
  // handbrakeLatGripFactor), so yanking the lever mainly breaks the rear loose +
  // rotates the car without washing the speed off → entry speed carries into the
  // slide and the drift size scales with it. handbrakeLockForce can't do this
  // (the wheel locks in ~1 frame at any value); this is the targeted knob. Lower
  // = the handbrake brakes even less (carries more speed); 1.0 = full scrub (old).
  // p17 Fix1b: the scrub is now RAMPED BY THROTTLE so the handbrake only PROVOKES
  // — it doesn't self-sustain a no-throttle slide. handbrakeLongScrubFactor is the
  // FULL-THROTTLE value (low → entry speed carries, the Step-1 size win); at ZERO
  // throttle the scrub rises to handbrakeLongScrubIdle (≈full braking) so a
  // handbrake slide with no gas DECELERATES and WASHES OUT in ~1 s. Only THROTTLE
  // sustains a drift; the handbrake just breaks the rear loose + rotates it.
  handbrakeLongScrubFactor: 0.35,   // p16 — scrub at FULL throttle (carries speed)
  handbrakeLongScrubIdle: 1.0,      // NEW (p17 Fix1b) — scrub at ZERO throttle (washes out)
  handbrakeYawKick: 6.0,            // NEW (p17 Fix1) rad/s^2 — handbrake+steer rotates into the slide

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
  maxYawRate: 3.2,                  // p19b reverted 2.5 → 3.2 (feel-test: keep pre-p19 rotation)
  softYawClampRate: 10,             // NEW (p7)  1/s decay applied to yaw above the limit
  // Verze 3 Stage iv — sim-real HELD-DRIFT yaw ceiling (rad/s). The real 1.3 m arm makes the
  // held drift over-rotate (measured peak ω 4.8 ≈ 2× the physical path-bound ceiling a_lat/v ≈
  // 2.5 at 20 km/h). Applied ONLY in sim-real while the spin-arm is NOT armed (spinRelease<0.5)
  // → a held drift is controllable, not twitchy. A COMMITTED spin (spinRelease≥0.5) keeps the
  // higher maxYawRate 3.2 → the deliberate hodiny is unchanged. Caps the spin-RATE, NOT β (the
  // drift ANGLE is never clamped → a deep drift stays reachable via active countersteer).
  driftSimDriftYawCeiling: 2.6,     // rad/s (sim-real held drift; arcade/sim use maxYawRate)

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
  standingPivot: 0,            // p20 0 = neutralised (governed drift owns low speed)
  powerOverSpeed: 16,          // p20
  powerOverWheelspin: 0.25,    // p20
  powerOverThrottle: 0.45,     // p20

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

  // ---------- p23 — DRIFT MODEL BRANCH (dev switch) ----------
  // 'arcade' = the frozen governed-drift model (byte-identical to HEAD, the working
  // drift). 'sim' = the new front-carve physics drift (WORK IN PROGRESS — currently
  // mirrors arcade). Toggled live on the PC 'D' tuner. No player-facing menu yet.
  driftMode: 'arcade' as 'arcade' | 'sim' | 'sim-real',

  // ---------- p24 — SIM-BRANCH drift (RAW emergent front-carve) ----------
  // Only used when driftMode==='sim'. The sim drift is PURE PHYSICS (no assists):
  // inside a drift the front wheels are UN-NEUTERED so their lateral force carves
  // the path and the radius EMERGES (R = v²/a_lat). Knobs default to RAW.
  driftFrontCarve: 1.0,        // 0 = front neutered (arcade-like) … 1 = full front authority (raw carve)
  driftScrubRate: 0.0,         // EXTRA along-velocity drag while sliding; 0 = pure physical scrub only
  driftSpeedSensitivity: 1.0,  // RESERVED (arcade tuning): 1 = full physical v² (raw, default); <1 would soften — NOT wired in raw Pass 1
  // SIM rear KINETIC friction (replaces rearDriftFriction in the rear force ONLY
  // when driftMode==='sim' && car.driftActive). Lower than arcade's 0.65 so the
  // kinetic reaction (budget·thisGrip) drops BELOW engine drive (~9000 N) → under
  // throttle the rear wheel STAYS spun → rho>1 → rear lateral grip stays collapsed
  // → the slide SUSTAINS at moderate steer, throttle-driven (no β-target/assist).
  // Default = middle of the measured sustaining-without-spinning window (check b).
  driftSimRearGrip: 0.50,
  // SIM catch-assist (p26): re-applies a tunable FRACTION of the existing auto-
  // countersteer (alignGate) inside a sim drift, so the sustained slide HOLDS a
  // controllable angle instead of spinning. alignGate *= (1 − driftFrontCarve·(1 −
  // driftSimCatch)). 0 = raw floor (collapses to the p24 full removal → spins);
  // 1 = full countersteer restored (arcade-like, won't spin). β-gated (the alignGate
  // ramp wakes 20°→40°), so turn-in/radius stay front-carve-driven and only the
  // runaway yaw is damped — β stays EMERGENT (points the front at the MEASURED slip,
  // does NOT command a β target; no governor). Usable window ~0.4–0.6.
  driftSimCatch: 0.45,
  // SIM speed-hold (p27, the β-faded WAVE): a throttle-driven, handbrake-excluded,
  // entry-capped correction along VELOCITY that acts only in DEEP β (open drift) so
  // the drift TRAVELS instead of donuting in place — which raises speed enough to
  // un-gate the catch. As the drift CLOSES (β shrinks 40°→20°) it FADES to 0 and hands
  // back to normal UNCAPPED engine drive, which accelerates the car out past entry on
  // exit (real returning traction, NOT this term). One-sided cap at car.driftEntrySpeed
  // → retains/refills toward entry, never net-gains (no boost-donut). 0 = raw (collapses
  // to donut); window ~0.4–0.7.
  // p32: REMOVED (default 0). MEASURED: betaFactor gates the wave to deep β, i.e. ONLY the
  // SPIN regime — there it pumps speed back to entry → the "rocket donut" (held 70 km/h vs
  // bled to 6 with it off). p28's drift-build power makes the normal drift sustain on HONEST
  // DRIVE (16–17 km/h @ β10–14, the wave wasn't acting at β<20° anyway), and a spin BLEEDS
  // correctly without it. Drift speed is now honest throttle-vs-scrub: aligned drive carries
  // speed (shallow drift / straighten-throttle exit), misaligned deep drive bleeds (spin).
  // Block kept (no-op at 0) → reversible via the D tuner.
  driftSimSpeedHold: 0,

  // ---------- p28 — SIM drift-build POWER-TO-GRIP (drift-build reference) ----------
  // The SIM car is given a drift-build engine: steady drive ABOVE the rear kinetic
  // reaction so throttle WILLINGLY spins the rear and holds a power-slide. Used ONLY
  // when driftMode==='sim' (always, as a car PARAMETER — not a drift-only assist);
  // arcade keeps enginePower 9000 / torqueBoostFadeSpeed 14 → byte-identical.
  //   reaction (default grip) = budget·rearDriftFriction = 16200·0.65 = 10530 N
  //   reaction (in a sim drift) = budget·driftSimRearGrip = 16200·0.50 =  8100 N
  // driftSimEnginePower 12500 sits +1970 N over the 10530 reaction (willing wheelspin,
  // STAYS spun) yet 3700 N UNDER the 16200 static budget → straight-line still GRIPS
  // (clean launch, no rocket); only a TURNED throttle (the steer-gated boost) breaks
  // the rear loose. Raised fade speed keeps that break-loose alive at mid/high speed.
  driftSimEnginePower: 12500,       // N — sim steady drive (arcade stays 9000)
  driftSimBoostFadeSpeed: 40,       // m/s — sim launch-boost fade (arcade stays 14)

  // ---------- p29 — SIM drift two-gap close (multiplicative scales on EXISTING forces) ----
  // (a) LOW-SPEED FRONT AUTHORITY: a sim+driftActive scale on the EXISTING frontLatForce,
  // faded IN at low speed (×1 by ~8 m/s), so moderate lock (0.5–0.7) reaches enough front
  // turn-in force to break the rear loose at low speed instead of burning out straight.
  // Pure multiplier on a force that already exists — NOT a new force/yaw term. (Measured a
  // MODEST help: steer 0.7 @ 15 km/h β 8°→14°; steer 0.5 stays shallow — low speed still
  // favours more lock. Honest.)
  driftSimFrontAuthority: 1.5,      // low-speed front-force ×scale (1 = off)
  // (b) DEEPEN: a sim+driftActive scale on the EXISTING front lateral force (≈ the
  // peakLatGripFront·frontDriftFriction sliding cap that STEP 0's sweep proved is the ONE
  // lever that moves equilibrium β: ×0.7→β67°, everything else inert). LOWER = deeper β.
  // Mild 0.9 (no cliff — the sweep cliffs at ~0.78 for steer 0.6). The DOMINANT depth lever
  // is the speed-hold below (travel → β already ~38° at speed); this is the fine-deepen knob.
  driftSimFrontSlide: 0.9,          // front sliding-grip ×scale (1 = off; <0.8 cliffs)
  // ---------- p30 — SIM spin-arm arm thresholds (make the drift HOLDABLE) ----------
  // The spin-arm (the deliberate-360 yaw injector) was arming during EVERY normal
  // moderate-lock drift, which zeroed alignGate (killed the auto-catch) AND injected
  // spinYawRate the player couldn't overcome → β ran away (−76→+87°, ω 5.5). Raising
  // the arm threshold (sim-only) so it ONLY arms on a COMMITTED near-full-lock keeps it
  // OFF in a normal drift → spinRelease stays 0 → alignGate + countersteer regain
  // authority → the drift HOLDS (ω ~1.5). 360° preserved: committed full lock (≈1.0)
  // still clears these. Threshold value change only — NO new force term. Arcade reads
  // spinReleaseThreshold (0.78) / spinReleaseThresholdHB (0.90) → byte-identical.
  driftSimSpinArm:   0.95,          // throttle arm (vs arcade spinReleaseThreshold 0.78)
  driftSimSpinArmHB: 0.97,          // handbrake arm (vs arcade spinReleaseThresholdHB 0.90)
  // ---------- p31 — SIM throttle→grip cleanup (no inversion, no false low-speed burnout) ----
  // (A) rearLoadFactor (p19b loadTransferGain) ADDS rear lateral grip under throttle (accel) →
  // more throttle = MORE grip, INVERTING the player's principle (throttle modulates grip via the
  // force-vs-grip ratio). Zero it in SIM → throttle ONLY removes grip via the friction circle
  // (monotonic less-throttle = more-grip at all speeds). Arcade keeps loadTransferGain 0.35.
  driftSimLoadTransferGain: 0,
  // (B) REAR low-speed slip-angle floor (sim-only, REAR ONLY — front MIN_LONG untouched). At low
  // speed a hair of lateral reads as a HUGE slip angle (small forwardVel denom) → false sliding
  // → drive spins the wheel UNOPPOSED → false burnout + skids. Raising the rear denominator floor
  // is MAGNITUDE-SENSITIVE: atan2(0.3, 4)=4° (hair → grips) but atan2(3, 4)=37° (full lock → still
  // slides) → the false burnout dies while the real full-lock low-speed drift (p29/p30) SURVIVES.
  // Only acts below ~floor m/s of forwardVel (max(floor,|fwd|)); above it |fwd| dominates = no-op.
  driftSimRearSlipFloor: 4.0,       // m/s (vs the shared MIN_LONG 0.5; raised for the REAR in sim)
  // ---------- p33 — SIM front longitudinal-brake cut (deep drift SUSTAINS) ----------
  // FREE-RUN measured: the spinning rear propels +8000 N along velocity (constant), but the
  // front cornering force projected to body-X (−frontLatForce·sin(steer)) brakes −6600 N
  // (shallow β) to −15000 N (deep β) → cancels/exceeds the rear → the drift crawls. This scales
  // DOWN that front along-heading brake ONLY in a sim drift, so the countersteered front ROLLS
  // (corners but doesn't brake along heading) → the rear's drive sustains a full-throttle DEEP
  // drift. frontForceBodyY (lateral/cornering = radius/turn-in/yaw) is UNTOUCHED. A spin still
  // bleeds (rear propulsion misaligned at deep β, cosβ→0). 1 = off (no cut); value measured.
  driftSimFrontLongDrag: 1.0,       // 0..1 ×scale on the front body-X brake (measured below)
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

  // Low-passed rearSlideBlend (p15b) — kills the handbrake locked-wheel
  // per-frame flicker so the drift governor engagement (govMode) is steady.
  slideBlendSmooth: number;

  // Spin-release debounce (p14b, seconds). Accumulates while the player HOLDS
  // a decisive steer-INTO (intent past spinReleaseThreshold) in a drift; once
  // it reaches spinReleaseHold the angle governor's cage is fully lifted and
  // the car over-rotates into a free spin ("hodiny"). Decays (faster) the
  // moment they back off, re-caging so the spin can be caught.
  spinTimer: number;

  // Load transfer (p19): the previous frame's forward velocity + a low-passed
  // longitudinal acceleration, so accel/brake can trim each axle's lateral grip.
  prevForwardVel: number;
  axLong: number;

  // Sim speed-hold (p27): the speed at the instant a sim drift latched. The
  // one-sided anti-boost ceiling for the deep-β retain correction. Written only
  // in the sim branch (simDriftSustain); unused/0 in arcade.
  driftEntrySpeed: number;

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
    slideBlendSmooth: 0,
    spinTimer: 0,
    prevForwardVel: 0, axLong: 0,
    driftEntrySpeed: 0,
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
//                  rho > 1 slide: F = budget·rearDriftFriction·(nLong,−nLat)/rho
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
//              kinetic reaction (budget·rearDriftFriction ≈ 10530), so the
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
// =============================================================================
//  DRIFT SUSTAIN — SELECTABLE BRANCH (CONFIG.driftMode), p23.
//  The drift model is split into two paths so the working ARCADE drift can be
//  FROZEN (untouched) while the new physics-based SIM drift is built alongside it
//  pass-by-pass (CLAUDE.md §3 — freeze the locked core rather than rewrite it).
//  Both are pure functions: they touch only the per-car CarState + read-only CONFIG
//  + locals (no module state, no time/random) → per-car safe + deterministic.
// =============================================================================

// ARCADE drift — the governed-drift model, FROZEN byte-identical to HEAD. Frozen FOR
// NOW (so sim work can't regress it), NOT permanently locked — revisitable by choice.
function arcadeDriftSustain(car: CarState, input: Inputs, dt: number, c: Config, forwardVel: number, bodyBeta: number, worldForceX: number, worldForceY: number, rearSlideBlend: number) {
    // Governed drift mode (p9): the single declared drift-stability assist —
    // while sliding WITH power on, nudge YAW toward a steering-set angle and
    // SPEED toward a throttle-set target. Changes no tire force.
    const v2 = car.vx * car.vx + car.vy * car.vy;
    const vNow = Math.sqrt(v2);
    const driftIntent = input.throttle;  // p17 Fix1: throttle sustains; handbrake only provokes (below)
    // ENGAGEMENT (p14) — a HYSTERESIS LATCH, not an instantaneous gate. The
    // governor only ENGAGES once a slide is clearly established (β past the
    // driftModeFull angle while the rear slides under power/handbrake), and it
    // STAYS engaged as a countersteer shallows the angle, releasing only when
    // β collapses below driftLatchRelease or the rear regrips. This solves the
    // old dilemma in one stroke: a gentle grip-corner (marginal slip, shallow
    // β) never trips the latch, yet a deliberately held shallow drift doesn't
    // fall out of governed mode the instant it dips under the entry threshold.
    const sliding = car.slideBlendSmooth > 0.05 && driftIntent > 0;
    // PROVOCATION: a slide counts as a deliberate drift (vs a gentle grip-
    // corner that marginally breaks the rear loose) when the player is clearly
    // committing — handbrake, a real steering input, the rear well loose, or
    // the angle already deep. Engaging on provocation (not waiting for β to
    // build) lets the speed governor hold pace through the ENTRY, instead of
    // the entry scrubbing all the speed and dropping the car into pivot mode.
    const provoke = input.handbrake ||
      Math.abs(input.steer) > 0.45 ||
      Math.abs(bodyBeta) >= c.driftModeFull ||
      (forwardVel < c.powerOverSpeed && car.slideBlendSmooth > c.powerOverWheelspin &&
       input.throttle > c.powerOverThrottle);
    // FIX 2 (p17): a SPUN-AROUND car — velocity anti-aligned with heading
    // (forwardVel < 0, i.e. true slip past ~90°) — must DROP OUT of governed
    // mode. Otherwise the speed governor's along-velocity thrust (below) keeps
    // accelerating it along its BACKWARD velocity → it "rockets backward"; and
    // bodyBeta reads ~0 (it uses |forwardVel|) so the governor can't even see the
    // reversal. Disengaged, raw physics (the spinning rear + drag) resolves the
    // spin, and the deliberate spin still completes via yaw momentum — it just no
    // longer powers backward. Only affects spun cars; any real drift is < 90°
    // (forwardVel > 0), so forward-drift behaviour is unchanged.
    // p17 Fix1: only an UNARMED reversal (accidental spin-around, spinTimer == 0)
    // drops out — a DELIBERATE spin (armed) STAYS engaged so it rotates past 90°
    // and completes the hodiny; the forwardVel>0 thrust gate below still blocks
    // the rocket either way, so an armed spin rotates WITHOUT powering backward.
    const reversedSpin = forwardVel < -0.5 && car.spinTimer === 0;
    if (!car.driftActive) {
      if (sliding && provoke && !reversedSpin) car.driftActive = true;
    } else if (reversedSpin ||
               ((!sliding ||
                (Math.abs(bodyBeta) < c.driftLatchRelease && !provoke)) &&
               car.flipTimer <= 0)) {
      // Release only when the rear has regripped, or β has collapsed AND the
      // player is no longer provoking. The `&& !provoke` is essential (p15b):
      // a handbrake slide rides at a SHALLOW β (the locked rear scrubs speed
      // before β deepens), so without it the latch released every frame on the
      // low β and re-engaged on the handbrake provocation — flickering govMode
      // and the spin arm to nothing. Holding the handbrake holds the latch.
      car.driftActive = false;
    }
    const govMode = car.driftActive ? driftIntent * car.slideBlendSmooth : 0;
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
      // p18: scaled by the master assist — at driftAssist 0 the speed governor
      // (the size-pinner + the old rocket source) is fully OFF, speed is pure
      // physics. The Fix-2 forwardVel>0 gate below still blocks any rocket.
      let accel = c.driftSpeedGain * c.driftAssist * (vTarget - vNow) * govMode;
      if (accel > 0) accel *= input.throttle;
      // FIX 2 (p17): only thrust while the car is actually moving FORWARD. The
      // thrust is applied along the velocity vector; a reversed (spun) car would
      // otherwise be driven backward. (driftActive is already dropped above when
      // reversed, so govMode=0 there — this is belt-and-suspenders.)
      if (vNow > 0.3 && forwardVel > 0) {
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
      //   • steer HARD INTO and HOLD it (intent past spinReleaseThreshold for
      //     spinReleaseHold seconds) → authority ramps to ZERO: the cage is
      //     lifted, raw physics over-rotates past 90° into a full 360° spin
      //     ("hodiny"). The trigger reads the PLAYER'S COMMAND (input.steer,
      //     post-expo but pre-limiter/pre-auto-countersteer) — releasing the
      //     cage is about what the player ASKS for, not what the tyre is
      //     allowed to do — and is debounced so it's deliberate, not a flick.
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
          // crosses center. A flip is a counter action — clear any spin arming.
          car.spinTimer = 0;
          // p18: the flip-DRIVE is a governor term — scaled by the master assist
          // (at 0 the transition is pure physics: countersteer swings the rear).
          if (c.driftAssist > 0) {
            const betaTarget = -Math.sign(input.steer || 1) * c.driftBaseAngle;
            const omegaDes = dphi + c.driftAngleRate * (bodyBeta - betaTarget);
            car.angularVel += (omegaDes - car.angularVel) *
              Math.min(1, c.driftYawRelax * dt) * govMode * c.driftAssist;
          }
        } else {
          // DEBOUNCED RELEASE: a decisive steer-into HELD past spinReleaseHold
          // lifts the cage; backing off re-cages (decays 2× faster) so the
          // spin is catchable. The timer reads INTENT (intoAmount from the
          // player's command), gated on an active drift so holding lock while
          // straight-driving can't pre-arm a spin.
          // Spin arming. car.spinTimer is SIGNED: its sign LATCHES the spin
          // direction (the way the player first tilted in), its magnitude is
          // the debounce progress toward spinReleaseHold. It STARTS only on a
          // hard steer-INTO the slide, but once armed it SUSTAINS on the raw
          // tilt holding the same direction — because bodyBeta (and so the
          // into/counter sense) flips as the car spins, re-deriving "into"
          // every frame would disarm it mid-spin. The player disarms by easing
          // off or tilting the OTHER way (which then catches the spin).
          // The handbrake LOWERS the arm threshold (p15): pulling it is the
          // player asking to break the rear loose / spin, so handbrake + a
          // decent steer-in over-rotates far more readily than tilt alone.
          const armThreshold = input.handbrake
            ? c.spinReleaseThresholdHB
            : c.spinReleaseThreshold;
          // START signal: tilt-only reads intoAmount (steer OPPOSITE the slide,
          // a power drift's signature). A handbrake slide LOCKS the rear, so β
          // takes the SAME sign as the steer and intoAmount reads ~0 — there,
          // the lever-pull + steer IS the spin intent, so arm on raw |steer|.
          const startSignal = input.handbrake ? Math.abs(input.steer) : intoAmount;
          const armed = car.spinTimer !== 0;
          const sustain = armed
            ? (car.driftActive &&
               Math.abs(input.steer) >= armThreshold * 0.6 &&
               Math.sign(input.steer) === Math.sign(car.spinTimer))
            : (car.driftActive && startSignal >= armThreshold);
          const spinDir = armed
            ? Math.sign(car.spinTimer)
            : (Math.sign(input.steer) || -sgn);
          let spinMag = Math.abs(car.spinTimer);
          spinMag = sustain
            ? Math.min(c.spinReleaseHold, spinMag + dt)
            : Math.max(0, spinMag - dt * 2);
          car.spinTimer = spinDir * spinMag;
          const release = clamp(spinMag / c.spinReleaseHold, 0, 1);
          if (govMode > 0) {
            const relax = Math.min(1, c.driftYawRelax * dt) * govMode;
            // HOLD term (p18) — betaTarget is now PROPORTIONAL to steer-into and
            // ZERO at neutral/countersteer: the player's tilt SETS the drift
            // angle (fine control), and straightening commands β→0 so the car
            // RECOVERS even with throttle held (the old driftBaseAngle ~40° floor
            // was the recovery defect). Scaled by the master assist — at 0 this
            // term is OFF and the slip angle is pure friction-circle physics.
            if (c.driftAssist > 0) {
              const betaTarget = sgn * clamp(c.driftAngleMax * steerBias, 0, c.driftAngleMax);
              const omegaHold = dphi + c.driftAngleRate * (bodyBeta - betaTarget);
              car.angularVel += (omegaHold - car.angularVel) * relax * c.driftAssist;
            }
            // SPIN term (p18) — the deliberate "hodiny": when armed, AMPLIFY the
            // rotation in the steer direction so the car over-rotates (the tyre
            // model is stable, so it won't spin on its own). Applied INDEPENDENTLY
            // of driftAssist so it works at EVERY assist level (incl. pure sim).
            // ADDITIVE (not a target rate) — always rotates FURTHER than the donut
            // would; the soft yaw clamp upstream is the only backstop. At assist 1
            // this + the hold term above are algebraically identical to the prior
            // single relaxation toward (omegaHold + spinDir·spinYawRate·release).
            if (release > 0) {
              car.angularVel += spinDir * c.spinYawRate * release * relax;
            }
          }
        }
      } else {
        // Too slow for the governor — bleed any spin arming.
        car.spinTimer = Math.sign(car.spinTimer) *
          Math.max(0, Math.abs(car.spinTimer) - dt * 2);
      }
    } else if (!car.driftActive && car.spinTimer !== 0) {
      // The drift is genuinely OVER (the latch released — e.g. the player
      // CAUGHT the slide and the rear regripped). Bleed the spin arming so a
      // freshly re-entered drift is never pre-armed, and so releasing the
      // handbrake to catch doesn't leave a latent spin waiting to fire.
      // NB: gate on !driftActive, NOT govMode==0 — under the handbrake the
      // locked wheel makes rearSlideBlend (hence govMode) FLICKER to 0 between
      // frames; decaying on those flickers kept the handbrake spin from ever
      // arming (it bled away as fast as it built). driftActive is the stable
      // latch, so it only bleeds when the slide has actually ended.
      car.spinTimer = Math.sign(car.spinTimer) *
        Math.max(0, Math.abs(car.spinTimer) - dt * 2);
    }
}

// SIM drift — RAW EMERGENT FRONT-CARVE model (p24 Pass 1). PURE PHYSICS, no assists:
// the radius EMERGES from the un-neutered front wheel's force (the alignGate / front-slip-
// limiter relaxation in step 2/2b above, sim-gated), not from any governor. This function
// only (1) runs the LATCH (sets car.driftActive, which arms that front-carve relaxation),
// (2) SCRUBS honestly (NO held-speed thrust; driftScrubRate adds optional EXTRA drag), and
// (3) keeps the SPIN-ARM so a full-lock-held drift still reaches the deliberate 360°. There
// is NO β-target, NO speed-pinning, NO curvature controller, NO driftAssist scaling — β,
// radius and speed all fall out of the real tyre forces. The ONE non-physics term retained
// is the spin-arm's additive yaw (spinYawRate) — flagged. worldForceX/Y/rearSlideBlend are
// unused here (the raw model reads no governor inputs).
function simDriftSustain(car: CarState, input: Inputs, dt: number, c: Config, forwardVel: number, bodyBeta: number, worldForceX: number, worldForceY: number, rearSlideBlend: number) {
  void worldForceX; void worldForceY; void rearSlideBlend;
  const v2 = car.vx * car.vx + car.vy * car.vy;
  const vNow = Math.sqrt(v2);
  const driftIntent = input.throttle;
  // ENGAGEMENT LATCH — identical hysteresis to arcade, so the slide provokes/holds the same
  // way; its ONLY job here is to set car.driftActive, which gates the front-carve relaxation.
  const sliding = car.slideBlendSmooth > 0.05 && driftIntent > 0;
  const provoke = input.handbrake ||
    Math.abs(input.steer) > 0.45 ||
    Math.abs(bodyBeta) >= c.driftModeFull ||
    (forwardVel < c.powerOverSpeed && car.slideBlendSmooth > c.powerOverWheelspin &&
     input.throttle > c.powerOverThrottle);
  // p29 reversedSpin GUARD (the ONE allowed logic change, sim-gated): at deep β the car
  // momentarily points backward along its heading (forwardVel ≤ 0) WITHOUT actually
  // reversing — bodyBeta uses |forwardVel| so a real reverse reads |bodyBeta|≈0 while a deep
  // slide reads |bodyBeta|→90°. So in sim, only treat it as a true reversal (which drops the
  // drift latch) when |bodyBeta| is BELOW the deep-drift band — otherwise a deep slide's
  // forwardVel noise would spuriously un-latch the drift. Arcade latch byte-identical (gate off).
  const reversedSpin = forwardVel < -0.5 && car.spinTimer === 0 &&
    !(c.driftMode === 'sim' && Math.abs(bodyBeta) >= c.driftModeFull);
  if (!car.driftActive) {
    if (sliding && provoke && !reversedSpin) {
      car.driftActive = true;
      car.driftEntrySpeed = vNow;   // p27 speed-hold anti-boost ceiling (entry speed)
    }
  } else if (reversedSpin ||
             ((!sliding || (Math.abs(bodyBeta) < c.driftLatchRelease && !provoke)) &&
              car.flipTimer <= 0)) {
    car.driftActive = false;
  }
  const govMode = car.driftActive ? driftIntent * car.slideBlendSmooth : 0;
  // SPEED SCRUB — honest: the front-carve drag + rear slide already bleed speed (physics).
  // driftScrubRate adds OPTIONAL extra along-velocity drag (default 0 = pure physics). It
  // only REMOVES energy → no speed pinning, no boost-donut.
  if (govMode > 0 && vNow > 0.3 && c.driftScrubRate > 0) {
    const drag = Math.min(0.5, c.driftScrubRate * car.slideBlendSmooth * driftIntent * dt);
    car.vx -= car.vx * drag;
    car.vy -= car.vy * drag;
  }
  // SPEED-HOLD WAVE (p27) — a throttle-driven correction along VELOCITY that retains
  // the momentum the 2-DOF tyre model wastes at deep β, so the drift TRAVELS instead of
  // collapsing to an on-spot donut (which un-gates the catch). It is:
  //   - β-FADED: betaFactor = 1 in deep β (open), → 0 as β closes 40°→20°. When the drift
  //     closes, this vanishes and normal UNCAPPED engine drive (untouched) accelerates the
  //     car out PAST entry (real returning traction). The OPEN→CLOSE wave is continuous.
  //   - THROTTLE-DRIVEN (∝ driftIntent) and HANDBRAKE-EXCLUDED (the guardrail: zero under
  //     handbrake, so handbrake+throttle gets no retention → the old boost-donut can't return).
  //   - ANTI-BOOST: one-sided cap at car.driftEntrySpeed — refills toward entry, never net-
  //     gains. Speed exceeds entry ONLY at low β via normal drive (nose aligned = not a donut).
  // Acts along velocity (orthogonal to yaw) → cannot pin β; radius stays v/ω from the carve.
  if (govMode > 0 && vNow > 0.3 && c.driftSimSpeedHold > 0 && !input.handbrake) {
    const SPEEDHOLD_REF = 40;   // m/s² full-authority along-velocity retain (p29 26→40: holds ≥30 entries)
    const betaDeg = Math.abs(bodyBeta) * 180 / Math.PI;
    const betaFactor = clamp((betaDeg - 20) / (40 - 20), 0, 1);   // 1 deep (open) … 0 closed
    if (betaFactor > 0 && vNow < car.driftEntrySpeed) {
      const accel = c.driftSimSpeedHold * driftIntent * car.slideBlendSmooth * betaFactor * SPEEDHOLD_REF;
      // Refill toward entry along velocity; one-sided clamp so |v| can never exceed entry.
      const headroom = car.driftEntrySpeed - vNow;            // > 0 here
      const gain = Math.min(accel * dt, headroom);            // never overshoot the ceiling
      const k = gain / vNow;
      car.vx += car.vx * k;
      car.vy += car.vy * k;
    }
  }
  // SPIN ARM (kept) — the one retained non-physics term. A hard steer-INTO held past
  // spinReleaseHold ADDS yaw (spinYawRate) so a full-lock-held drift over-rotates into the
  // deliberate 360°. Same debounce as arcade; bleeds off when not governing.
  if (govMode > 0 && v2 > 1) {
    const sgn = Math.sign(bodyBeta) || 1;
    const steerBias = clamp(input.steer, -1, 1) * -sgn;
    const intoAmount = clamp(steerBias, 0, 1);
    // p30: sim-gated higher arm threshold so the spin-arm only fires on a COMMITTED
    // near-full-lock — NOT on a normal moderate-lock drift (which left alignGate zeroed
    // and the drift un-holdable). Arcade uses the originals → byte-identical.
    const sim = c.driftMode === 'sim';
    const armThreshold = input.handbrake
      ? (sim ? c.driftSimSpinArmHB : c.spinReleaseThresholdHB)
      : (sim ? c.driftSimSpinArm : c.spinReleaseThreshold);
    const startSignal = input.handbrake ? Math.abs(input.steer) : intoAmount;
    const armed = car.spinTimer !== 0;
    const sustain = armed
      ? (Math.abs(input.steer) >= armThreshold * 0.6 &&
         Math.sign(input.steer) === Math.sign(car.spinTimer))
      : (startSignal >= armThreshold);
    const spinDir = armed ? Math.sign(car.spinTimer) : (Math.sign(input.steer) || -sgn);
    let spinMag = Math.abs(car.spinTimer);
    spinMag = sustain ? Math.min(c.spinReleaseHold, spinMag + dt) : Math.max(0, spinMag - dt * 2);
    car.spinTimer = spinDir * spinMag;
    const release = clamp(spinMag / c.spinReleaseHold, 0, 1);
    if (release > 0) {
      car.angularVel += spinDir * c.spinYawRate * release * Math.min(1, c.driftYawRelax * dt) * govMode;
    }
  } else if (car.spinTimer !== 0) {
    car.spinTimer = Math.sign(car.spinTimer) * Math.max(0, Math.abs(car.spinTimer) - dt * 2);
  }
}

export function step(car: CarState, input: Inputs, dt: number, c: Config = CONFIG) {
  // ---- Verze 3 STAGE i — 'sim-real' is a BYTE-IDENTICAL ALIAS of 'sim' this stage.
  // Normalise it to 'sim' for the WHOLE step (a per-call shallow copy — CONFIG is NEVER
  // mutated, so it's multi-car safe and deterministic). Every driftMode gate, the dispatch,
  // simDriftSustain and inertia() then see 'sim' → sim-real behaves exactly like sim. Arcade
  // and sim are untouched (the if is false for them) → byte-identical. The real-size geometry
  // swap (Stage ii) will gate on the ORIGINAL mode, captured before this line.
  const isSimReal = c.driftMode === 'sim-real';   // Stage ii: capture BEFORE normalising (gates real-size geometry)
  if (c.driftMode === 'sim-real') c = { ...c, driftMode: 'sim' };
  // ---- 1. Body-frame velocity (forward = +x_body, lateral = +y_body) ----
  // (computed first — the steering auto-align needs the slip direction)
  const cosH = Math.cos(car.heading);
  const sinH = Math.sin(car.heading);
  const forwardVel =  car.vx * cosH + car.vy * sinH;
  const lateralVel = -car.vx * sinH + car.vy * cosH;

  // ---- 1b. Throttle REAR-RE-GRIP (p19b) — ACCEL-ONLY half of the load transfer.
  // axNorm is clamped to [0,1]: only FORWARD acceleration trims grip, so throttle
  // re-loads the rear (the clean straighten+throttle drift EXIT) while lift/brake
  // do nothing (NO lift-off / trail-brake / scrub-breakaway). Rear-only; the front
  // is untouched. Pure trim on the final rear lateral force; circle untouched.
  const axInstant = (forwardVel - car.prevForwardVel) / dt;
  car.axLong += (axInstant - car.axLong) * Math.min(1, c.loadTransferSmooth * dt);
  car.prevForwardVel = forwardVel;
  const axNorm = clamp(car.axLong / c.loadTransferRefAccel, 0, 1);   // accel-only
  // p31 (A): SIM zeroes loadTransferGain so throttle never ADDS rear grip (no inversion);
  // arcade keeps 0.35 → byte-identical.
  const ltGain = c.driftMode === 'sim' ? c.driftSimLoadTransferGain : c.loadTransferGain;
  const rearLoadFactor = 1 + ltGain * axNorm;   // throttle → rear grips → exit aid (arcade only now)

  // ---- 2. Steering: ease front wheel toward target lock ----
  const targetSteer = clamp(input.steer, -1, 1) * c.maxSteerAngle;
  const maxStep = c.steerSpeed * dt;
  car.steerAngle += clamp(targetSteer - car.steerAngle, -maxStep, maxStep);

  const speed = Math.hypot(car.vx, car.vy);
  // Stage ii: sim-real uses the REAL-SIZE yaw arm (1.3 m); arcade/sim keep 0.433 m → the else is
  // the exact current expression → byte-identical. This halfWB feeds the yaw torque, the axle
  // slip velocities (rearLat/frontLat = lateralVel ∓ ω·halfWB), frontVelAngle, and the pivot.
  const halfWB = (isSimReal ? c.simRealWheelbase : c.wheelbase) / 2;
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
  // Spin-release (p14b): once the player has committed to a spin (the debounce
  // below has armed car.spinTimer), the auto-countersteer must ALSO yield — it
  // is the catch-the-slide assist, and a committed driver is overriding it. We
  // fade alignGate to zero so the front points fully INTO the slide and raw
  // physics over-rotates past 90° into a real spin. (Uses last frame's timer;
  // the governor updates it later this step — a one-frame lag is immaterial.)
  const spinRelease = clamp(Math.abs(car.spinTimer) / c.spinReleaseHold, 0, 1);
  let alignGate = clamp(
      (Math.abs(bodyBeta) - c.autoCounterStart) /
      (c.autoCounterFull - c.autoCounterStart), 0, 1) *
    c.autoCounterStrength *
    clamp((speed - 2) / 2, 0, 1) *
    (1 - spinRelease);
  // p24 SIM front-carve: inside an established drift, UN-NEUTER the front so its
  // lateral force CARVES the path (the emergent radius) instead of being auto-
  // countersteered to the velocity direction. driftFrontCarve=1 removes the
  // auto-countersteer entirely. SIM-ONLY + driftActive-gated (last frame) → arcade
  // and grip cornering are byte-identical (the gate is off there).
  // p26 catch-assist: re-apply a tunable FRACTION of alignGate so the slide HOLDS
  // instead of spinning. driftSimCatch=0 → (1−driftFrontCarve) = the p24 full removal
  // (raw spinning floor); =1 → ×1 = full countersteer. The (1−spinRelease) factor is
  // already baked into alignGate above, so a committed spin still zeroes it regardless
  // of catch (the deliberate 360° survives). β-gated by the alignGate ramp → silent
  // through turn-in, wakes as β deepens. β stays emergent (points the front at the
  // measured slip; no β-target).
  if (c.driftMode === 'sim' && car.driftActive) {
    alignGate *= (1 - c.driftFrontCarve * (1 - c.driftSimCatch));
  }
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
    let slipCap = c.maxSteerAngle + (c.frontSlipLimitOptimal - c.maxSteerAngle) * t;
    // p24 SIM front-carve: relax the slip cap back toward full lock inside the drift
    // so the front keeps real carving authority at speed. The front force is still
    // bounded by peakLatGripFront (the physical p13 cap) so it can't anchor to zero.
    // SIM-ONLY + driftActive-gated → arcade byte-identical.
    if (c.driftMode === 'sim' && car.driftActive) slipCap += (c.maxSteerAngle - slipCap) * c.driftFrontCarve;
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
  // p31 (B): SIM raises the REAR slip-angle denominator floor only (front MIN_LONG untouched).
  // Magnitude-sensitive: a hair of lateral at low speed now reads as a SMALL angle (grips, no
  // false burnout) while a full-lock big lateral still reads large (real low-speed drift survives).
  // Acts only below ~floor m/s of |rearLong| (=|forwardVel|); above it |fwd| dominates → no-op.
  const rearSlipFloor = c.driftMode === 'sim' ? c.driftSimRearSlipFloor : MIN_LONG;
  const rearSlip  = Math.atan2(rearLat,       Math.max(rearSlipFloor, Math.abs(rearLong)));

  // ---- 5. Tire forces ----
  // FRONT (undriven): pure lateral, linear in slip angle, clamped at peak,
  // kinetic fraction once sliding — unchanged from earlier passes.
  let frontLatForce = -c.corneringStiffnessFront * frontSlip;
  const isFrontSliding = Math.abs(frontLatForce) > c.peakLatGripFront;
  if (isFrontSliding) {
    frontLatForce = Math.sign(frontLatForce) * c.peakLatGripFront * c.frontDriftFriction;
  }
  // p29 SIM front scale (multiplicative on the EXISTING frontLatForce; sim+driftActive-gated
  // so arcade/grip are byte-identical). TWO intents, handed off by SPEED so they don't fight:
  //   (a) low-speed AUTHORITY — faded IN below ~8 m/s → boosts front turn-in so moderate lock
  //       breaks the rear loose at low speed (driftActive latches on the |steer|>0.45 provoke,
  //       so this acts during initiation);
  //   (b) DEEPEN — driftSimFrontSlide (<1) lowers the front sliding-grip the drift balances
  //       against → deeper equilibrium β (the ONE lever STEP 0's sweep moved).
  if (c.driftMode === 'sim' && car.driftActive) {
    const lowSpeedFade = clamp(1 - speed / 8, 0, 1);                 // 1 at rest → 0 by 8 m/s
    const authority = 1 + (c.driftSimFrontAuthority - 1) * lowSpeedFade;
    frontLatForce *= authority * c.driftSimFrontSlide;
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
  //   rho > 1 (sliding): total force = budget · rearDriftFriction, pointed along
  //                      the combined-slip direction:
  //                      F_long =  budget · rearDriftFriction · nLong/rho
  //                      F_lat  = −budget · rearDriftFriction · nLat /rho
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
  // STEER-GATED (p20): the boost — which is what tips the rear into wheelspin
  // at low speed — now ramps in over [boostSteerDead, boostSteerFull] of |steer|
  // and scales with throttle. STRAIGHT wheel (|steer| ≤ dead) → no boost → the
  // drive stays under the kinetic reaction → clean TRACTION (realistic launch,
  // and the straighten+throttle drift EXIT re-grips). TURNED wheel → boost →
  // drive exceeds reaction → wheelspin → a governed, MOVING power-over drift
  // whose size the steering sets — never a locked on-the-spot donut. This
  // replaced the old throttle-only [burnoutThrottle,1.0] gate (which span the
  // wheels straight off the line and, with the standing pivot, made the donut).
  // p28 SIM drift-build engine: a sim-gated higher steady drive + slower boost fade
  // (a car PARAMETER, applied whenever driftMode==='sim') so throttle willingly spins
  // the rear and the power-slide survives at speed. Arcade uses enginePower 9000 /
  // torqueBoostFadeSpeed 14 unchanged → byte-identical (the gate is off there).
  const simEngine = c.driftMode === 'sim' ? c.driftSimEnginePower : c.enginePower;
  const simFade   = c.driftMode === 'sim' ? c.driftSimBoostFadeSpeed : c.torqueBoostFadeSpeed;
  const boostSteer = clamp(
    (Math.abs(input.steer) - c.boostSteerDead) / (c.boostSteerFull - c.boostSteerDead), 0, 1);
  const driveBoost = 1 + c.lowSpeedTorqueBoost *
    Math.max(0, 1 - speed / simFade) * boostSteer * input.throttle;
  const powerLimitedForce = Math.min(
    simEngine,
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

  const vg = rearLong;                                   // ground speed at rear patch
  // p28 wheelspin-during-slide fix (SIM + driftActive only): the slip-ratio denominator
  // (and thus the traction stiffness kSlip + the wheel-overspeed clamp) normally uses
  // |vg| = |forwardVel|, which COLLAPSES toward 0 in a sideways slide → sDenom floors →
  // kSlip blows up → the wheel GLUES to the (near-zero) forward speed → s≈0, no wheelspin,
  // no longitudinal force ("wheels do nothing while sideways"). Inside a sim drift, use
  // TOTAL speed instead so the denominator stays large and the rear keeps spinning DURING
  // the slide. The slip NUMERATOR (wv − vg) keeps vg=forwardVel (the real rolling speed).
  // Arcade / launch / brake untouched (gate off) → byte-identical.
  const slipRef = (c.driftMode === 'sim' && car.driftActive)
    ? Math.sqrt(car.vx * car.vx + car.vy * car.vy)
    : Math.abs(vg);
  const sDenom = Math.max(c.slipDenomFloor, slipRef);
  const mw = c.wheelSpinInertia;
  const nLat = rearSlip / alphaPeakRear;                 // rear lateral grip usage

  // ---- FOOT BRAKE (p21) — GRIP-RELATIVE TARGET-SLIP, inside the friction circle.
  // The HANDBRAKE keeps its own lock-force decrement (unchanged). The FOOT brake
  // no longer subtracts a fixed wheel-speed step: that old explicit decrement
  // faked a low-speed lockup (a constant Δwheel-speed ÷ a shrinking sDenom blew
  // the slip ratio up below ~20 km/h). Instead the foot brake pulls the rear
  // wheel toward the slip that yields EXACTLY its demanded force, and breaks the
  // rear loose only when that demand exceeds the available rear longitudinal grip:
  //   Fbrake       = brake · brakeForce · brakeRearShare
  //   longHeadroom = sqrt(1 − nLat²)                     (friction-circle long capacity)
  //   grips  while  Fbrake ≤ brakeGripFraction · budget · longHeadroom
  //   sTarget      = −(Fbrake / budget) · slipRatioPeak  (∝ Fbrake, NO 1/sDenom → speed-independent)
  // Gated to the pure foot-brake case so handbrake / reverse / no-brake stay
  // byte-identical. GRIPPING → pull wv toward the target at the brake's own rate,
  // never past it (a light/medium pedal can't fake a lockup at any speed). BROKEN
  // LOOSE → add the demand to the wheel lock-force decrement so it locks AND
  // sustains via the same path the handbrake uses → the existing rho>1 kinetic-
  // scrub skid (no ABS). Because sTarget ∝ Fbrake (no 1/sDenom), the old low-speed
  // lockup artifact is gone — same slip at 5 and 50 km/h.
  const footActive = input.brake > 0 && !input.handbrake && !reverseMode;
  const footDemand = footActive ? input.brake * c.brakeForce * c.brakeRearShare : 0;
  const longHeadroom = Math.sqrt(Math.max(0, 1 - Math.min(1, nLat * nLat)));
  const footGrips = footActive && footDemand <= c.brakeGripFraction * budget * longHeadroom;
  const footTargetWv = vg - (footDemand / budget) * c.slipRatioPeak * sDenom;

  // Wheel lock-force decrement: handbrake (unchanged) + a BROKEN-LOOSE foot brake.
  // Clamps at zero — a brake can stop the wheel but never spin it the other way
  // (the p6 standstill-reverse fix); the wheel may still roll backwards when the
  // GROUND drags it there.
  const lockForceF = (input.handbrake ? c.handbrakeLockForce : 0) +
    (footActive && !footGrips ? footDemand : 0);
  const dWvBrake = (dt / mw) * lockForceF;
  const brakeClamp = (w: number) =>
    w > 0 ? Math.max(0, w - dWvBrake) : w < 0 ? Math.min(0, w + dWvBrake) : 0;

  // Wheel-speed update, stage 1: drive + traction (implicit, unconditionally
  // stable). Stage 2: the zero-clamped lock-force decrement. Stage 3 (foot grip):
  // the target-slip clamp.
  //   wv' = (drive − k·(wv − vg)) / mw,   k = budget/(slipPeak·denom)
  //   wvNew = (wv + dt/mw·(drive + k·vg)) / (1 + dt·k/mw)
  const kSlip = budget / (c.slipRatioPeak * sDenom);
  const wv0 = car.rearWheelSpeed;
  let wv = (wv0 + (dt / mw) * (drive + kSlip * vg)) / (1 + (dt * kSlip) / mw);
  wv = brakeClamp(wv);
  if (footGrips) {
    // Pull the wheel toward the force-proportional slip at the brake's own rate,
    // never past it → settles at sTarget (= demanded force), never locks.
    const dWvFoot = (dt / mw) * footDemand;
    wv = Math.max(footTargetWv, wv - dWvFoot);
  }

  let s = (wv - vg) / sDenom;
  let nLong = s / c.slipRatioPeak;
  let rho = Math.hypot(nLong, nLat);

  let rearLongForce: number;
  let rearLatForce: number;
  const isRearSliding = rho > 1;

  if (!isRearSliding) {
    rearLongForce =  budget * nLong;
    rearLatForce  = -budget * nLat;
  } else {
    // SIM branch: drop the rear KINETIC friction so the reaction (budget·grip)
    // falls below engine drive → the wheel stays spun → the slide sustains
    // (throttle-driven, no assist). Arcade uses rearDriftFriction unchanged →
    // byte-identical. Gated on last-frame driftActive (same gate as the front
    // carve), so grip/launch/arcade are untouched. This fk feeds BOTH the slide
    // force AND the wheel re-integration below (rearLongForce).
    const rearKineticFriction = (c.driftMode === 'sim' && car.driftActive)
      ? c.driftSimRearGrip
      : c.rearDriftFriction;
    const fk = budget * rearKineticFriction;
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
  rearLatForce *= rearLoadFactor;   // p19b: rear RE-GRIPS under throttle (clean straighten-exit);
                                    //   accel-only, so lift/brake do NOT lighten it (no lift-off)
  // p16/p17 Fix1b: scale the handbrake's longitudinal scrub by THROTTLE — full
  // braking at zero throttle (a no-gas handbrake slide scrubs speed and WASHES
  // OUT, so the lever only PROVOKES), ramping down to handbrakeLongScrubFactor at
  // full throttle (low scrub → entry speed carries, the Step-1 size win). This is
  // what actually stops the handbrake sustaining a slide on zero throttle — the
  // governed-drift assist is already off there (govMode = throttle·… = 0).
  if (input.handbrake) {
    const hbScrub = c.handbrakeLongScrubIdle +
      (c.handbrakeLongScrubFactor - c.handbrakeLongScrubIdle) * input.throttle;
    rearLongForce *= hbScrub;
  }

  // Clamp wheel overspeed to ±maxSlipRatio (force saturates past rho = 1
  // anyway; unbounded wheel speed would only add throttle-lift lag).
  wv = clamp(wv, vg - c.maxSlipRatio * sDenom, vg + c.maxSlipRatio * sDenom);
  s = (wv - vg) / sDenom;
  car.rearWheelSpeed = wv;

  // How deep into the slide the rear is (0 = grip, 1 = fully saturated) —
  // smooth ramp over rho ∈ [1, 1.5]. Gates the drift stability assist.
  const rearSlideBlend = clamp((rho - 1) / 0.5, 0, 1);
  // Low-passed copy (p15b). Under the handbrake the locked wheel oscillates
  // locked/overspun on alternate frames (see the crossing clamp above), so rho
  // — and rearSlideBlend — FLICKER to 0 between frames. The governor engagement
  // (govMode) keys off this; the flicker made the handbrake spin fail to arm
  // (it bled away as fast as it built). Smoothing kills the per-frame flicker
  // without changing the steady value, so govMode is stable.
  car.slideBlendSmooth += (rearSlideBlend - car.slideBlendSmooth) *
    Math.min(1, c.slideBlendSmoothRate * dt);

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
  // p19: mild engine/compression braking on a TRUE coast (no throttle, no brake)
  // → a lift actually decelerates → feeds the load transfer → lift-off oversteer.
  const engineBrakeForce =
    (input.throttle < 0.02 && input.brake < 0.02 && !input.handbrake && forwardVel > 0.5)
      ? c.engineBraking : 0;
  const longitudinalForce = pedalBodyForce - dragForce - rollingForce - engineBrakeForce;

  // ---- 7. Assemble body-frame forces ----
  // Front tire force lives in the steered-wheel frame (lateral only);
  // rotate by steerAngle into the BODY frame. The rear tire contributes
  // BOTH components now: longitudinal (engine/brake through the contact
  // patch) and lateral.
  // p33: scale DOWN the front's along-heading BRAKE in a sim drift (the countersteered front
  // ROLLS — corners but sheds the along-velocity drag). Body-Y (lateral cornering = radius/turn/
  // yaw) is UNTOUCHED. Body-X is NOT in the yaw torque (axles on body-x) so the turn is unaffected.
  // Arcade / non-drift untouched (gate off); steer→0 → fs→0 → no effect (exit/straight unaffected).
  const frontLongDrag = (c.driftMode === 'sim' && car.driftActive) ? c.driftSimFrontLongDrag : 1;
  const frontForceBodyX = -frontLatForce * fs * frontLongDrag;
  const frontForceBodyY =  frontLatForce * fc;
  const rearForceBodyX  = rearLongForce;
  const rearForceBodyY  = rearLatForce;

  const bodyForceX = longitudinalForce + frontForceBodyX + rearForceBodyX;
  const bodyForceY = frontForceBodyY + rearForceBodyY;

  // ---- 8. Yaw torque (front pushes one way at +L/2, rear at -L/2) ----
  // 2D torque from force at offset (rx, ry): rx*Fy - ry*Fx. Axles are on the
  // body x-axis (ry = 0) so torque = rx * Fy.
  // Stage ii: sim-real uses REAL inertia (mass·2.6²/12 = 676, no inertiaScale hack); arcade/sim
  // call inertia(c) unchanged → byte-identical.
  const I = isSimReal ? c.mass * c.simRealWheelbase * c.simRealWheelbase / 12 : inertia(c);
  const torque = halfWB * frontForceBodyY - halfWB * rearForceBodyY;
  const yawDamp = -c.angularDamping * I * car.angularVel;
  car.angularVel += (torque + yawDamp) / I * dt;

  // Soft yaw-rate limit (p7): yaw above maxYawRate is damped back hard
  // instead of hard-clipped — the hard clip froze rotation exactly when
  // a deep drift entry needed it. Still a firm backstop against runaway.
  // Stage iv: sim-real HELD drift (spin-arm NOT armed) is capped at the physical drift ceiling so
  // it can't over-rotate; a COMMITTED spin (spinRelease≥0.5) keeps the higher maxYawRate (full
  // hodiny). Arcade/sim → c.maxYawRate → byte-identical. Caps the spin-RATE, not β.
  const simRealDrift = isSimReal && spinRelease < 0.5;
  const yawCeiling = simRealDrift ? c.driftSimDriftYawCeiling : c.maxYawRate;
  const yawExcess = Math.abs(car.angularVel) - yawCeiling;
  if (yawExcess > 0) {
    // sim-real HELD drift: HARD clip to the physical path-bound ceiling (a held drift's yaw can't
    // exceed a_lat/v — the soft decay let the real-moment impulse overshoot to ~4.8). arcade/sim
    // and the committed SPIN keep the SOFT decay (entry headroom for the hodiny). β is NOT clamped
    // → a deep drift is still reachable, the entry just builds progressively (≤ceiling), not twitchy.
    const rate = simRealDrift ? 1 : Math.min(1, c.softYawClampRate * dt);
    car.angularVel -= Math.sign(car.angularVel) * yawExcess * rate;
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
  const pivotActive = c.standingPivot > 0 && pivotFade > 0 && spinNow > 0.3 &&
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

  // p17 Fix1: handbrake yaw kick — pull the lever while steering → ROTATE into the slide.
  if (input.handbrake && speed > 1 && Math.abs(input.steer) > 0.05) {
    car.angularVel += Math.sign(input.steer) * c.handbrakeYawKick * Math.abs(input.steer) * dt;
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
    car.spinTimer = 0;
    const pvx =  car.angularVel * halfWB * sinH;
    const pvy = -car.angularVel * halfWB * cosH;
    const b = Math.min(1, c.burnoutPivotVelBlend * dt) * pivotFade;
    car.vx += (pvx - car.vx) * b;
    car.vy += (pvy - car.vy) * b;
  } else if (c.driftMode === 'sim') {
    simDriftSustain(car, input, dt, c, forwardVel, bodyBeta, worldForceX, worldForceY, rearSlideBlend);
  } else {
    arcadeDriftSustain(car, input, dt, c, forwardVel, bodyBeta, worldForceX, worldForceY, rearSlideBlend);
  }

  // ---- 10. Rest snap (static-friction style) — BEFORE integrating position so
  // a resting car doesn't crawl another sub-pixel. With no drive input (throttle
  // off + handbrake off) and below restSpeed, bleed linear velocity hard to zero
  // and kill small residual yaw, so the car fully STOPS instead of creeping /
  // slowly rotating forever on asymptotic micro-velocity. The instant throttle
  // (or handbrake) returns, this is skipped and it drives normally; drifting and
  // throttle-feathered crawls keep throttle/handbrake on, so they're untouched.
  const idle = input.throttle < 0.02 && input.brake < 0.02 && !input.handbrake;
  if (idle && car.vx * car.vx + car.vy * car.vy < c.restSpeed * c.restSpeed) {
    car.vx = 0;
    car.vy = 0;
    car.angularVel = 0;   // hard park: kill ALL residual so it can't creep / rotate
  }
  // Tiny-snap safety (also covers the last sliver while braking/steering input).
  if (Math.abs(car.vx) < 0.01) car.vx = 0;
  if (Math.abs(car.vy) < 0.01) car.vy = 0;
  if (Math.abs(car.angularVel) < 0.005) car.angularVel = 0;

  car.x  += car.vx * dt;
  car.y  += car.vy * dt;
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
