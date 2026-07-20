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
// =============================================================================
//  THE ONE RULER (Stage C1) — a single real-metre scale for the WHOLE game.
//  ONE wheelbase (2.565 m) + ONE px-per-metre (CONFIG.pxPerMeter) define the
//  metre-value of EVERYTHING: car, world, corners, collision, spawn, gate.
//  The old render-vs-physics SPLIT (a small 1/3-scale "render wheelbase" beside
//  the 2.565 m "physics wheelbase") is DELETED — there is physically ONE number
//  now, so the two can never drift apart again. Car dimensions are bound to WB
//  as multiples so they can't drift either. A new car just changes WB and the
//  ruler scales it; physics reads the SAME wheelbase the render/collision do.
// =============================================================================
const WB = 2.565;                   // m — THE wheelbase. The single source of car scale.

export const CONFIG = {
  // ---------- Mass / geometry (ALL real metres on the one ruler, bound to WB) ----------
  mass: 1200,                       // kg
  wheelbase: WB,                    // m, axle-to-axle — the ONE wheelbase (render = physics)
  trackWidth: WB * 0.569,           // m ≈ 1.46, left↔right wheels (bound to WB)
  // Real yaw inertia = mass·k² (k = radius of gyration ≈ 1.25 m → ≈1875 kg·m²), set in step().
  simRealCoGHeight2: 0.5,           // m — CoG height for longitudinal load transfer (Stage 3b)
  // sim-real-2 STAGE 2 — real longitudinal drivetrain (torque curve + automatic gearbox + wheel),
  // drag/aero, brakes (1 g + ABS), engine braking. All PHYSICS-ONLY, isSimReal2-gated. The engine
  // is a real torque curve through real gear ratios (NOT enginePeakPowerW P/v, NOT driftSimEnginePower).
  simReal2PeakTorque: 240,          // Nm engine peak (~4750–7000 rpm)
  simReal2IdleTorque: 160,          // Nm at idle (curve rises idle→peak by 4750 rpm)
  simReal2TorquePeakRpm: 4750,      // rpm where peak torque is reached (flat to redline)
  simReal2Idle: 800,                // rpm idle floor
  simReal2Redline: 7000,            // rpm redline (peak power ~175 kW @ 7000 by construction)
  simReal2CompressionTorque: 45,    // Nm engine-braking torque @ redline (∝ rpm), closed throttle
  simReal2GearR1: 3.72, simReal2GearR2: 2.02, simReal2GearR3: 1.32, simReal2GearR4: 1.00, simReal2GearR5: 0.80,
  simReal2FinalDrive: 3.15,         // : 1
  simReal2ReverseRatio: 3.50,       // : 1 (real reverse gear, replaces the reverseForce band-aid)
  simReal2RollingRadius: 0.30,      // m (tyre rolling radius — rpm↔speed + wheel force)
  simReal2DrivetrainEff: 0.88,      // gearbox+diff efficiency (~12% loss — audit addition; tops at ~245)
  simReal2UpshiftRpm: 6800,         // auto upshift
  simReal2DownshiftRpm: 3000,       // auto downshift (hysteresis gap vs upshift → no hunting)
  simReal2DragCoeff: 0.35,          // ½ρ·Cd·A (Cd~0.32, A~1.8) — real
  simReal2RollingResistConst: 200,  // N CONSTANT rolling resistance (Crr·m·g) — not ∝v (audit H#5)
  simReal2DownforceCoeff: 0.20,     // N per (m/s)² — modest splitter/spoiler; feeds axle LOAD (→grip)
  simReal2BrakeForce: 11800,        // N → ~1.0 g on 1200 kg (4-wheel disc)
  simReal2BrakeRearShare: 0.40,     // 40/60 rear/front bias (real front-biased)
  simReal2SlipRatioPeak: 0.12,      // real peak-traction slip ratio (vs arcade 0.15)
  // sim-real-2 STAGE 3a — REAL GRIP (μ_static ~1.3-1.5, front ≤ rear) via a Pacejka-lite curve, +
  // relaxation-length slip (proper low-speed fix). Axle load ~5886 N (50/50). The Pacejka peak D is
  // the static budget; its post-peak falloff (sin floor at large α, set by C) is the kinetic μ — so
  // NO separate kinetic fraction for the lateral force. C 1.6 → falloff floor 0.59·D → μ_kin ~0.59·μ.
  simReal2BudgetRear: 8800,         // N rear peak lateral (μ_static_rear ~1.49)
  simReal2PeakFront: 7600,          // N front peak lateral (μ_static_front ~1.29, < rear → un-inverted)
  simReal2PacejkaC: 1.6,            // Pacejka shape (peak then falloff; floor 0.59·D → μ_kin ~0.7-0.9)
  simReal2AlphaPeakFront: 0.105,    // rad (~6°) front slip angle at peak grip
  simReal2AlphaPeakRear: 0.122,     // rad (~7°) rear slip angle at peak grip
  simReal2StiffRear: 110000,        // N/rad rear cornering stiffness (the rho longitudinal coupling)
  simReal2RelaxLength: 0.5,         // m tyre relaxation length (slip ANGLE builds over this distance)
  simReal2RelaxVmin: 0.5,           // m/s floor for τ = relaxLength/max(v,vmin) (divide guard)
  // sim-real-2 STAGE 3c (FINAL) — real steering lock + NO artificial yaw terms (yaw emerges from the
  // real tyre torques × the real arm + load) + real handbrake. The handbrake's locked-rear kinetic
  // grip reuses rearDriftFriction (0.65). angularDamping → 0, maxYawRate clamp removed, spinYawRate
  // never runs (own dispatch) — all sim-real-2-gated.
  simReal2MaxSteer: 0.698,          // rad (40°) factory lock (vs 50°): keeps the front inside its
                                    // Pacejka peak at speed → fixes the 3b high-speed understeer.

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
  // ---------- Real-handbrake REBUILD (the REALISTIC-target handbrake; sim-real-2) ----------
  // Replaces the finished-build "ice + propeller" handbrake. TWO physical terms, both handbrake-gated
  // (so non-handbrake physics is byte-identical):
  //   (1) hbScrubBoost — the locked rear drags HARDER longitudinally → realistic decel → sensible stop
  //       (~22 m from 70 km/h vs the old 37 m ice-slide). Longitudinal-only (slightly exceeds the
  //       friction circle — accepted so stop distance tunes INDEPENDENTLY of rotation).
  //   (2) hbYawDamp* — the sliding tyres SCRUB rotational energy (real dissipation, NOT a clamp): a yaw
  //       resistance that SCALES with the slide speed, so a runaway spin (propeller) is bounded + BLEEDS
  //       OUT while a controlled drift still rotates. Removes rotational energy only → front grip /
  //       steering untouched. dampC = hbYawDampLin + hbYawDampSlide·min(1, slideSpeed/6).
  // ARCADE/SIM: these are the realistic-target values; a future arcade pass can override per-car (they
  // are plain CONFIG, so a VehicleSpec — e.g. rally — can dial its own stop distance / rotation).
  hbScrubBoost: 2.0,                // × on the locked-rear longitudinal scrub (stop distance)
  hbYawDampLin: 1.0,                // 1/s baseline yaw energy dissipation under handbrake (catchability)
  hbYawDampSlide: 3.0,              // 1/s extra dissipation scaled by slide speed (bounds the spin)

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
  // (The p7 drift-stability assist and the p9 soft angle ceiling were
  //  replaced by the governed drift mode above — one law instead of three
  //  fighting correctors.)
  // Yaw-rate limit (rad/s). p7: now a SOFT limit — yaw above maxYawRate
  // is damped back hard (softYawClampRate per second) instead of
  // hard-clipped. The hard clip froze rotation exactly when a big entry
  // needed it most; the soft limit still stops runaway spins.
  // Verze 3 Stage iv — sim-real HELD-DRIFT yaw ceiling (rad/s). The real 1.3 m arm makes the
  // held drift over-rotate (measured peak ω 4.8 ≈ 2× the physical path-bound ceiling a_lat/v ≈
  // 2.5 at 20 km/h). Applied ONLY in sim-real while the spin-arm is NOT armed (spinRelease<0.5)
  // → a held drift is controllable, not twitchy. A COMMITTED spin (spinRelease≥0.5) keeps the
  // higher maxYawRate 3.2 → the deliberate hodiny is unchanged. Caps the spin-RATE, NOT β (the
  // drift ANGLE is never clamped → a deep drift stays reachable via active countersteer).

  // Low-speed slide GATE (sim-real ONLY, fix #1). The real arm (halfWB 1.3 m, 3× the 1/3 arm)
  // makes the rear slip angle (atan2(lateralVel − ω·halfWB, …)) blow up at low speed — any
  // rotation inflates the rear-axle lateral velocity → rho>1 → a FALSE slide → smoke + driftActive
  // latch + the rear goes kinetic so the 12500 sim-engine spins the wheel on a hair of throttle
  // (the low-speed false BURNOUT). It's the flip side of what makes sim-real drift at 40 km/h, so
  // gate it by SPEED: below this, the ω·halfWB (yaw) contribution to the REAR slip is faded out so
  // the rear stays in GRIP (rho<1, no false slide). Longitudinal wheelspin (launch, handbrake
  // lock) is nLong-driven → UNTOUCHED. Above this → full real coupling → the drift is intact.

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
  powerOverSpeed: 16,          // p20
  powerOverWheelspin: 0.25,    // p20
  powerOverThrottle: 0.45,     // p20

  // ---------- Collision vs desktop obstacles (p10) ----------
  // The car is treated as a circle against axis-aligned obstacle rects
  // (icons, taskbar). Arcade bounce: reflect the normal velocity with
  // restitution, keep most of the tangential component, push the car out
  // so it never sinks in. Yaw is damped in proportion to impact strength
  // so a mid-drift wall thump doesn't explode the spin.
  carCollisionRadius: WB * 0.98,    // m ≈ 2.515 — real collision radius (bound to WB)
  collisionRestitution: 0.35,       // NEW (p10)  normal bounce kept (0..1)
  collisionTangentFriction: 0.12,   // NEW (p10)  tangential speed lost on hit
  collisionPushOut: 0.02,           // NEW (p10)  m extra separation after push-out
  collisionYawDamp: 0.35,           // NEW (p10)  yaw kill at full-strength impact

  // ---------- Input mapping (phone tilt) ----------
  tiltSensitivity: 35,              // unchanged
  tiltDeadzone: 3,                  // unchanged
  inputLerp: 0.18,                  // unchanged

  // ---------- The one ruler: px per real metre — THE tunable (Stage C/floaty) ----------
  // THIS ONE NUMBER scales the whole game (car draw, world metre-size, corners,
  // collision, spawn, gates — track AND desktop). HIGHER = car bigger on screen,
  // world fewer metres (screen/pxm), corners tighter, screen-pace faster (less
  // floaty). LOWER = smaller car, bigger world, more room. The car stays 2.565 m
  // physically and the speedometer stays honest at any value (step() never reads
  // this). Reference points (1920-px screen): 7.5 → world 256 m (floaty); 10 →
  // world 192 m; 15 → world 128 m; 22 → world 87 m. Iterate by changing JUST this number.
  pxPerMeter: 7.5,

  // ---------- DRIFT MODEL ----------
  // The ONLY physics model now: sim-real-2 (the real-car sim). The arcade / sim / sim-real
  // branches were deleted in the Stage-B cleanup. Kept as a named field so the `isSimReal2`
  // selectors that still pick the real-size geometry / drivetrain / grip read cleanly.
  driftMode: 'sim-real-2' as const,

  // ---------- p24 — SIM-BRANCH drift (RAW emergent front-carve) ----------
  // Only used when driftMode==='sim'. The sim drift is PURE PHYSICS (no assists):
  // inside a drift the front wheels are UN-NEUTERED so their lateral force carves
  // the path and the radius EMERGES (R = v²/a_lat). Knobs default to RAW.
  driftSpeedSensitivity: 1.0,  // RESERVED (arcade tuning): 1 = full physical v² (raw, default); <1 would soften — NOT wired in raw Pass 1
  // SIM rear KINETIC friction (replaces rearDriftFriction in the rear force ONLY
  // when driftMode==='sim' && car.driftActive). Lower than arcade's 0.65 so the
  // kinetic reaction (budget·thisGrip) drops BELOW engine drive (~9000 N) → under
  // throttle the rear wheel STAYS spun → rho>1 → rear lateral grip stays collapsed
  // → the slide SUSTAINS at moderate steer, throttle-driven (no β-target/assist).
  // Default = middle of the measured sustaining-without-spinning window (check b).
  // SIM catch-assist (p26): re-applies a tunable FRACTION of the existing auto-
  // countersteer (alignGate) inside a sim drift, so the sustained slide HOLDS a
  // controllable angle instead of spinning. alignGate *= (1 − driftFrontCarve·(1 −
  // driftSimCatch)). 0 = raw floor (collapses to the p24 full removal → spins);
  // 1 = full countersteer restored (arcade-like, won't spin). β-gated (the alignGate
  // ramp wakes 20°→40°), so turn-in/radius stay front-carve-driven and only the
  // runaway yaw is damped — β stays EMERGENT (points the front at the MEASURED slip,
  // does NOT command a β target; no governor). Usable window ~0.4–0.6.
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
  // SMART WAVE — now gated to SIM-REAL (the player drift branch), GENTLE. `spinRelease` is a CLEAN
  // binary discriminator (0 in a held drift, 1 in a committed spin), so the wave is gated by
  // ×(1−spinRelease) → fires in a drift, ZERO in a spin → algebraically CAN'T rocket (the p32
  // flaw). SIM-REAL ONLY via the `isSimReal` param (arcade never reaches simDriftSustain; plain
  // sim has isSimReal=false → excluded → plain-sim back to pre-wave, arcade byte-identical). On
  // sim-real's real-arm geometry the wave gives TRAVEL while the real arm gives the countersteer
  // CATCH → a controllable traveling drift (provoke → travel → hold/adjust → exit → re-enter).
  // Kept GENTLE: 0.20 (was 0.5 on plain sim, which rammed the drift to ~50 km/h). 0.20 lightly
  // compensates the scrub so the drift travels at a moderate, controllable speed. Window ~0.10–0.40.
  // SMART-WAVE betaFactor lower bound (deg). The wave fades in over [betaMin, 40°]. Relaxed
  // 20→10 so the traveling slide (settles ~β9°) stays in the wave's window longer; safe because
  // spinRelease now guards the spin. Revert to 20 if it destabilises. Live on the D tuner.

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

  // ---------- p29 — SIM drift two-gap close (multiplicative scales on EXISTING forces) ----
  // (a) LOW-SPEED FRONT AUTHORITY: a sim+driftActive scale on the EXISTING frontLatForce,
  // faded IN at low speed (×1 by ~8 m/s), so moderate lock (0.5–0.7) reaches enough front
  // turn-in force to break the rear loose at low speed instead of burning out straight.
  // Pure multiplier on a force that already exists — NOT a new force/yaw term. (Measured a
  // MODEST help: steer 0.7 @ 15 km/h β 8°→14°; steer 0.5 stays shallow — low speed still
  // favours more lock. Honest.)
  // (b) DEEPEN: a sim+driftActive scale on the EXISTING front lateral force (≈ the
  // peakLatGripFront·frontDriftFriction sliding cap that STEP 0's sweep proved is the ONE
  // lever that moves equilibrium β: ×0.7→β67°, everything else inert). LOWER = deeper β.
  // Mild 0.9 (no cliff — the sweep cliffs at ~0.78 for steer 0.6). The DOMINANT depth lever
  // is the speed-hold below (travel → β already ~38° at speed); this is the fine-deepen knob.
  // ---------- p30 — SIM spin-arm arm thresholds (make the drift HOLDABLE) ----------
  // The spin-arm (the deliberate-360 yaw injector) was arming during EVERY normal
  // moderate-lock drift, which zeroed alignGate (killed the auto-catch) AND injected
  // spinYawRate the player couldn't overcome → β ran away (−76→+87°, ω 5.5). Raising
  // the arm threshold (sim-only) so it ONLY arms on a COMMITTED near-full-lock keeps it
  // OFF in a normal drift → spinRelease stays 0 → alignGate + countersteer regain
  // authority → the drift HOLDS (ω ~1.5). 360° preserved: committed full lock (≈1.0)
  // still clears these. Threshold value change only — NO new force term. Arcade reads
  // spinReleaseThreshold (0.78) / spinReleaseThresholdHB (0.90) → byte-identical.
  // ---------- p31 — SIM throttle→grip cleanup (no inversion, no false low-speed burnout) ----
  // (A) rearLoadFactor (p19b loadTransferGain) ADDS rear lateral grip under throttle (accel) →
  // more throttle = MORE grip, INVERTING the player's principle (throttle modulates grip via the
  // force-vs-grip ratio). Zero it in SIM → throttle ONLY removes grip via the friction circle
  // (monotonic less-throttle = more-grip at all speeds). Arcade keeps loadTransferGain 0.35.
  // (B) REAR low-speed slip-angle floor (sim-only, REAR ONLY — front MIN_LONG untouched). At low
  // speed a hair of lateral reads as a HUGE slip angle (small forwardVel denom) → false sliding
  // → drive spins the wheel UNOPPOSED → false burnout + skids. Raising the rear denominator floor
  // is MAGNITUDE-SENSITIVE: atan2(0.3, 4)=4° (hair → grips) but atan2(3, 4)=37° (full lock → still
  // slides) → the false burnout dies while the real full-lock low-speed drift (p29/p30) SURVIVES.
  // Only acts below ~floor m/s of forwardVel (max(floor,|fwd|)); above it |fwd| dominates = no-op.
  // ---------- p33 — SIM front longitudinal-brake cut (deep drift SUSTAINS) ----------
  // FREE-RUN measured: the spinning rear propels +8000 N along velocity (constant), but the
  // front cornering force projected to body-X (−frontLatForce·sin(steer)) brakes −6600 N
  // (shallow β) to −15000 N (deep β) → cancels/exceeds the rear → the drift crawls. This scales
  // DOWN that front along-heading brake ONLY in a sim drift, so the countersteered front ROLLS
  // (corners but doesn't brake along heading) → the rear's drive sustains a full-throttle DEEP
  // drift. frontForceBodyY (lateral/cornering = radius/turn-in/yaw) is UNTOUCHED. A spin still
  // bleeds (rear propulsion misaligned at deep β, cosβ→0). 1 = off (no cut); value measured.

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
  // sim-real-2 automatic-gearbox current gear (1..5; reverse handled separately). Per-car.
  // Other modes never read/write it (gated) → init only, no effect on arcade/sim/sim-real.
  gear: number;
  // sim-real-2 relaxation-length slip ANGLES (rad). The raw slip angle is low-passed toward these
  // over the tyre relaxation length → lateral force builds over ~0.5 m of travel (kills the low-speed
  // atan2 spike WITHOUT a slip floor). Per-car; only sim-real-2 reads/writes them.
  frontSlipState: number;
  rearSlipState: number;

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
    gear: 1,
    frontSlipState: 0,
    rearSlipState: 0,
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
  halfLen?: number, halfWidth?: number,
): number {
  // CAPSULE collision (the car's rounded-rectangle footprint) instead of a fat circle:
  // a spine segment of half-length (halfLen − halfWidth) along the heading, thickened by
  // radius = halfWidth. So the flat SIDES contact at halfWidth and the NOSE/TAIL contact at
  // halfLen — the visible edge touches the wall exactly in every orientation (a bare circle of
  // radius ≈ halfLen bulged ~halfLen−halfWidth past the narrow sides → the early-stop gap).
  // Omitting the extents ⇒ a circle of the config radius (old behaviour) for any bare caller.
  const R = halfWidth ?? halfLen ?? c.carCollisionRadius;              // capsule radius
  const hl = Math.max(halfLen ?? c.carCollisionRadius, R);            // half-length ≥ radius
  const spine = hl - R;                                               // spine half-length
  const ch = Math.cos(car.heading), sh = Math.sin(car.heading);
  const ax = car.x - ch * spine, ay = car.y - sh * spine;            // rear spine end
  const bx = car.x + ch * spine, by = car.y + sh * spine;            // front spine end
  const abx = bx - ax, aby = by - ay, abL2 = abx * abx + aby * aby;

  let strongest = 0;
  for (const r of rects) {
    // Closest points between the spine segment AB and the AABB: candidates are each spine
    // endpoint clamped onto the rect + each rect corner projected onto the spine. In 2D the
    // segment↔box closest pair is always among these, so the min over them is exact.
    let bestD2 = Infinity, Px = 0, Py = 0, Qx = 0, Qy = 0;
    const consider = (px: number, py: number, qx: number, qy: number) => {
      const dx = px - qx, dy = py - qy, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; Px = px; Py = py; Qx = qx; Qy = qy; }
    };
    // spine endpoints → nearest point on the rect
    consider(ax, ay, clamp(ax, r.x, r.x + r.w), clamp(ay, r.y, r.y + r.h));
    consider(bx, by, clamp(bx, r.x, r.x + r.w), clamp(by, r.y, r.y + r.h));
    // rect corners → nearest point on the spine
    const corners = [r.x, r.y, r.x + r.w, r.y, r.x, r.y + r.h, r.x + r.w, r.y + r.h];
    for (let k = 0; k < 8; k += 2) {
      const cxk = corners[k], cyk = corners[k + 1];
      let t = abL2 > 0 ? ((cxk - ax) * abx + (cyk - ay) * aby) / abL2 : 0;
      t = clamp(t, 0, 1);
      consider(ax + t * abx, ay + t * aby, cxk, cyk);
    }
    if (bestD2 >= R * R) continue;

    // Contact normal + penetration at the closest spine point P vs rect point Q.
    let nx: number, ny: number, pen: number;
    if (bestD2 > 1e-9) {
      const d = Math.sqrt(bestD2);
      nx = (Px - Qx) / d; ny = (Py - Qy) / d;
      pen = R - d;
    } else {
      // Spine point inside the rect — exit along the shallowest face (from P).
      const left = Px - r.x, right = r.x + r.w - Px;
      const top = Py - r.y, bottom = r.y + r.h - Py;
      const m = Math.min(left, right, top, bottom);
      if (m === left)       { nx = -1; ny = 0; pen = R + left; }
      else if (m === right) { nx =  1; ny = 0; pen = R + right; }
      else if (m === top)   { nx = 0; ny = -1; pen = R + top; }
      else                  { nx = 0; ny =  1; pen = R + bottom; }
    }

    // Push the car CENTRE out along n (rigid translation of the whole capsule), then bounce:
    // reflect the inbound normal component with restitution, keep the tangential with light
    // friction.
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

// A CURVED collision boundary (a circular arc) — the oval CORNER walls. Represented as a
// circle (centre + radius) so the car (capsule) contacts the smooth arc EXACTLY, matching the
// drawn curved barrier — no axis-aligned-square scalloping (which left a ~0.1-0.2 m gap in the
// corners). The wall spans the angle range [a0, a1]. `inside: true`  → the car must stay INSIDE
// the circle (an outer wall); `inside: false` → the car must stay OUTSIDE it (the inner/infield
// wall). `r` is the strip's band-side edge radius, so the visible edge is what the car touches.
export interface ObstacleArc {
  cx: number; cy: number; r: number;
  a0: number; a1: number;
  inside: boolean;
}

export function collideWithArcs(
  car: CarState, arcs: ObstacleArc[], c: Config = CONFIG,
  halfLen?: number, halfWidth?: number,
): number {
  const R = halfWidth ?? halfLen ?? c.carCollisionRadius;   // capsule radius
  const hl = Math.max(halfLen ?? c.carCollisionRadius, R);  // half-length ≥ radius
  const spine = hl - R;
  const ch = Math.cos(car.heading), sh = Math.sin(car.heading);
  const ax = car.x - ch * spine, ay = car.y - sh * spine;
  const bx = car.x + ch * spine, by = car.y + sh * spine;
  let strongest = 0;
  for (const a of arcs) {
    // The spine point that most violates the boundary: for an INSIDE wall the FARTHEST spine
    // point from the centre (distance-to-a-point is convex → an endpoint); for an OUTSIDE wall
    // the CLOSEST spine point (project the centre onto the spine, clamped).
    let px: number, py: number;
    if (a.inside) {
      const da = (ax - a.cx) ** 2 + (ay - a.cy) ** 2;
      const db = (bx - a.cx) ** 2 + (by - a.cy) ** 2;
      if (da >= db) { px = ax; py = ay; } else { px = bx; py = by; }
    } else {
      const dbx = bx - ax, dby = by - ay, L2 = dbx * dbx + dby * dby;
      let t = L2 > 0 ? ((a.cx - ax) * dbx + (a.cy - ay) * dby) / L2 : 0;
      t = clamp(t, 0, 1);
      px = ax + t * dbx; py = ay + t * dby;
    }
    const dx = px - a.cx, dy = py - a.cy;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    // only the corner's angular span (the straights are handled by rects)
    let ang = Math.atan2(dy, dx);
    while (ang < a.a0) ang += Math.PI * 2;
    if (ang > a.a1) continue;
    // penetration + radial normal
    let nx: number, ny: number, pen: number;
    if (a.inside) {
      pen = (d + R) - a.r;               // capsule pokes past the inside radius
      if (pen <= 0) continue;
      nx = -dx / d; ny = -dy / d;        // push inward
    } else {
      pen = a.r - (d - R);              // capsule pokes inside the outside radius
      if (pen <= 0) continue;
      nx = dx / d; ny = dy / d;          // push outward
    }
    car.x += nx * (pen + c.collisionPushOut);
    car.y += ny * (pen + c.collisionPushOut);
    const vn = car.vx * nx + car.vy * ny;
    if (vn < 0) {
      const tx = car.vx - vn * nx, ty = car.vy - vn * ny;
      const tf = 1 - c.collisionTangentFriction * Math.min(1, -vn / 5);
      const bounce = -vn * c.collisionRestitution;
      car.vx = tx * tf + nx * bounce;
      car.vy = ty * tf + ny * bounce;
      const impact = Math.min(1, -vn / 10);
      car.angularVel *= 1 - c.collisionYawDamp * impact;
      strongest = Math.max(strongest, -vn);
    }
  }
  return strongest;
}
