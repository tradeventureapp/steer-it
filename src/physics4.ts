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
import { CONFIG, type CarState, type Inputs } from './vehicle-core';
import type { Surface } from './maps';

export interface Physics4Params {
  // HANDLING BRANCH (declared once per car, like the tyre profile). 'sim' = the honest
  // per-wheel model exactly as written (Blitz RS). 'arcade' = the same engine tuned for a
  // forgiving arcade car (Stee-Rex). step4's SIM path is literally the existing code; any
  // arcade divergence is gated behind `branch === 'arcade'`, so a sim car is byte-identical.
  branch: 'sim' | 'arcade';
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
  // ---- SELF-ALIGNING TORQUE (pneumatic trail) — the REAL always-on restoring
  // yaw moment every tire produces (Mz = -Fy·t). Trail t is max at center and
  // COLLAPSES to ~0 (then slightly negative) as slip passes peak → progressive,
  // catchable breakaway + the "steering goes light at the limit" cue. Replaces
  // the old slide-gated arcade yaw damper (which gate-fed a yaw limit-cycle). ----
  pneumaticTrail: number;     // m — trail at zero slip (× Fy = the aligning moment arm)
  trailPeakSlip: number;      // rad — slip angle where the trail collapses to 0 (just past the force peak)
  yawDampConst: number;       // N·m·s/rad — TINY non-gated yaw-rate damping (numerical hygiene only; NOT slide-gated)
  // ---- FASE 1 drive tools (all through the per-wheel friction circle) ----
  // SHAPED accel curve (no gears): drive = throttle · min(peakThrust, enginePower/max(v,vFloor)).
  // Torque-limited (flat peakThrust) low → power-limited (∝1/v) high = punchy + flattening.
  peakThrust: number;         // N — max drive force at the rear axle (low-speed torque limit) (9000)
  enginePower: number;        // W — peak power (~172 kW ≈ 230 hp) → the ∝1/v taper (172000)
  powerFloorSpeed: number;    // m/s — v floor in enginePower/v so low speed = flat peakThrust (5)
  rollRadius: number;         // m — wheel rolling radius (0.30)
  wheelInertia: number;       // kg·m² — base rear-wheel inertia for BRAKING/COAST (22 — keeps those dynamics as tuned)
  wheelInertiaDrive: number;  // kg·m² — REAL reflected inertia for the on-throttle spin-up (~5 → live κ∝1/v speed-dependent wheelspin)
  wheelSubsteps: number;      // internal ω-ODE sub-steps/frame for the drive spin-up (stiff low-inertia wheel stays stable; body stays 60Hz)
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
  // ---- reverse (stopped + brake held) ----
  reverseSpeed: number;       // m/s — reverse speed cap (9 ≈ 32 km/h, brisk RWD-coupe reverse)
  reverseForce: number;       // N — reverse drive force (brake pedal = reverse throttle) (10000)
  reverseDelay: number;       // s — brake-held-while-stopped delay before reverse engages (0.5)
  // ---- SURFACE. ONLY reached when the active map supplies a surface sampler (the circuit);
  // every other map passes undefined → these are dead code and it stays byte-identical.
  // All applied PER WHEEL, never as a car-level multiplier.
  //
  // The TYRE owns μ-per-ground (see TireProfile) — it is a property of the compound, not of
  // the world, so a future gravel-shod rallycross car is a DIFFERENT PROFILE and needs ZERO
  // physics change: per-wheel drive + the friction circle already make AWD-on-loose emerge.
  tire: TireProfile;
  grassDragPerWheel: number;  // N·s/m — GRASS: linear drag on this wheel's CONTACT-POINT velocity
  // GRAVEL is deep loose stone. Two PHYSICALLY DISTINCT effects, deliberately decoupled — one
  // number could not serve both (braking and exit fight over it):
  //   • STATIC DIGGING — the constant. Speed-independent, so it still bites at walking pace.
  //     This is the term the driver fights when crawling OUT, so it alone sets exit difficulty.
  //   • MOMENTUM TRANSFER to displaced stones — the quadratic. Plowing at speed throws mass
  //     aside, and the rate you shovel it scales with v²; this owns the high-speed BRAKING.
  // So: raise quad to brake harder, lower const to make the exit easier — independently.
  gravelDragConst: number;    // N per wheel, opposing the contact-velocity DIRECTION
  gravelDragLin: number;      // N·s/m per wheel, on top of the constant
  gravelDragQuad: number;     // N·s²/m² per wheel — the v² stone-displacement term
  // A SPINNING wheel EXCAVATES: it throws stone out behind it, sinks into the hole it digs,
  // and the deeper it sits the more stone it has to plow. So the static digging term scales
  // with how hard that wheel is spinning. This is what separates the last coupled pair —
  // a FEATHERED exit (no spin) fights only the light constant, while MASHING the throttle
  // buries the car. Driven (rear) wheels only: an unspun wheel digs no hole.
  gravelDigGain: number;      // × extra constant drag at 100% wheelspin

  // ================= ARCADE KNOBS (read ONLY when branch === 'arcade') =================
  // Optional so the sim car (PHYS4) omits them entirely and every sim step is byte-
  // identical; a Stee-Rex-style car supplies them via VehicleSpec.arcade. Each is a
  // DECOUPLED lever (top speed / accel via the existing power+grip fields / drift feel /
  // surface forgiveness) so tuning one never drags another off target.
  arcadeTopSpeed?: number;    // m/s — HARD top-speed limiter (gearing/limiter). The top is
                              // fixed HERE, independent of engine power, so raising power
                              // for the launch can't push the top off target.
}

// How one tyre compound behaves on each ground: a ×scale on that wheel's μ. This lives with
// the CAR's physics profile (PHYS4) and NOT in vehicles.ts on purpose — vehicles.ts is
// documented as the pure DISPLAY identity that must never reach into the force model, whereas
// PHYS4 *is* the car's physics profile (the `physicsProfile` link vehicles.ts anticipates).
export interface TireProfile {
  muScale: Record<Surface, number>;
}

// D-tunable defaults (the boss tunes these live; mutated in place like CONFIG).
// THE SIM CAR (Blitz RS): a realistic early-90s circuit race special, built to the
// touring-car racing homologation spec this car is anchored to. High realistic slick
// grip, decisive breakaway, race brakes, ~1020 kg stripped weight, 370 hp. The honest
// per-wheel sim benchmark (a separate forgiving ARCADE car is built on top later).
export const PHYS4: Physics4Params = {
  branch: 'sim',           // Blitz RS = the honest sim; step4 runs the existing path verbatim
  massKg: 1020,            // stripped homologation-spec race weight (was 1200)
  weightDistFront: 0.53,   // a real road-going coupe of this layout sits ~52/48 front; race setup adds a touch → the STABILITY MARGIN (neutral-steer-point BEHIND the CoM = directionally stable under throttle, no power-oversteer divergence)
  cgHeight: 0.45,          // lowered race car → less load transfer → planted
  yawInertiaK: 1.20,       // Iz = 1020·1.20² ≈ 1469 (agile; was 1875)
  loadTransferLongGain: 1.5,  // the stable-margin balance plants the rear → trail-braking needs this transfer for the rear to become mobile (subtle real rotation; a dramatic one would need an oversized ~1.65 or a less-stable balance)
  loadTransferLatGain: 1.0,
  muNom: 1.90,             // race slicks → grip ~1.86g (also the rear grip that keeps it stable under power; lower → oversteer-prone)
  loadSensitivity: 0.05,   // kept LOW for oval stability (raising it → stronger trail-brake but the oval limit-cycle returns — a real 3-way coupling; see notes)
  tireB: 10,               // real slick: BROAD peak (~10.8°) → the fronts work over a wide slip range → no premature washout at the 32° lock
  tireC: 1.45,             // real slick: gentle, broad post-peak (not a narrow cliff)
  tireEllipseLong: 1.3,    // REAL slick: μ_long ≈ 1.3× μ_lat → the ellipse is elongated longitudinally so throttle on a fast-corner exit doesn't crush the rear's lateral grip to 0 (the power-oversteer spin-out). Normal exit GRIPS, full-throttle-at-the-limit is a CATCHABLE slide (not an uncatchable spin)
  relaxLength: 0.5,
  lowSpeedBlend: 2.5,
  maxSteer: 0.56,          // 32° front wheel lock — the real lock of the period race coupe this is built to (washout solved by the broad slick peak, not by cutting the lock)
  pneumaticTrail: 0.06,    // m — REAL pneumatic trail (~10-15% of the contact patch); the 0.22 band-aid is GONE (stability now comes from the weight-distribution margin, real physics)
  trailPeakSlip: 0.19,     // rad ≈ 11° — trail collapses at the broad-slick force peak (steering goes light at the limit)
  yawDampConst: 150,       // SMALL, physically-legitimate yaw-rate damping = real suspension ROLL DAMPING a point-model omits (NOT the 1100 band-aid)
  // 370 hp RACE SPECIAL
  peakThrust: 13000,       // sharp low-end punch + willing power-over
  enginePower: 276000,     // 276 kW ≈ 370 hp
  powerFloorSpeed: 5,
  rollRadius: 0.30,
  wheelInertia: 22,        // base — braking/coast unchanged (as tuned)
  wheelInertiaDrive: 8,    // RACE SLICK: hooks up VERY quickly (brief ~0.08s chirp then BITE); iw 5 spun 2.65s (worn-tyre behaviour, wrong for slicks — bistable runaway past the tyre peak). 8 sits above the runaway threshold (iw 6→2.6s / iw 7-8→0.08s)
  wheelSubsteps: 6,        // sub-step the stiff drive-spin ODE → stable, no oscillation
  brakeForce: 13500,       // race brakes @1020 kg — measured 1.21g (see note; 15000 = 1.34g)
  brakeBiasFront: 0.6,     // front-biased → trail-braking rotates (real load transfer)
  tireBx: 12,              // longitudinal peak at κ≈0.12 (realistic slick; broader than the old stiff 18) → the spin→grip hook-up is a gentler surge, not a jerk
  tireCx: 1.6,
  hbKineticMu: 0.9,
  dragCoef: 0.8,
  rollResist: 200,
  engineBrakeTorque: 500,
  engineBrakeSlideFade: 0.9,
  wheelInertiaSlideFactor: 0.55,
  wheelReturnRate: 10,
  reverseSpeed: 14,       // m/s ≈ 50 km/h — boss's practical choice for reversing out on the oval (a period racing gearbox's reverse ceiling is ~40 km/h; slightly above, deliberately, still close to real not arcade)
  reverseForce: 10000,    // N → ~8.3 m/s² backward = quick pickup, not a crawl
  reverseDelay: 0.5,
  // Blitz RS = race SLICKS: superb on tarmac, hopeless off it. asphalt 1.0 is EXACT so every
  // on-asphalt step stays byte-identical. grass 0.28 (μ→0.53) is the shipped value, unchanged.
  // gravel 0.35 (μ→0.67): loose stone gives a slick slightly more bite than turf, still weak.
  tire: { muScale: { asphalt: 1.0, grass: 0.28, gravel: 0.35 } },
  // N·s/m PER WHEEL (×4 = 40 total). ~10 ≈ 1.2 kN at 30 m/s ≈ a real grass rolling resistance
  // (Crr ≈ 0.1 · mg). MEASURED SWEEP (flat-out grass top vs asphalt's 246 km/h | lift-off loss
  // over 1 s from 108 km/h, asphalt = −9.6):
  //     0 → 143 (0.58) −8.0 | 2 → 127 (0.51) −8.6 | 5 → 106 (0.43) −9.6 | 10 → 80 (0.33) −11.1
  //    20 →  51 (0.21) −14.1 | 90 →  13 (0.05) −33.5   ← the suggested 90 makes grass undrivable
  // The brief's two targets CANNOT both hold: a LINEAR drag scales with v, so the value that
  // visibly scrubs at 30 m/s is exactly the value that dominates the top-speed equilibrium.
  // Worse, grass LOSES ~840 N of engine braking (it is transmitted through the tyre, capped by
  // the low μ) — so below ~7 N·s/m grass actually coasts FURTHER than asphalt. 10 is the
  // balance: it swallows the car (top a third of asphalt, never ice-like) and scrubs slightly
  // more than asphalt on lift-off; 2 would hit "half top speed" exactly but read as ice.
  grassDragPerWheel: 10,
  // GRAVEL — the CONSTANT term is the essence: it bleeds speed hard even when slow and brings
  // the car to an actual STOP, and because it is applied along the FULL contact-velocity vector
  // it also plows a sideways slide to a halt (no ice).
  // TUNED to 600 (NOT the suggested 1800). MEASURED SWEEP — stop from 150 km/h (trap = 55 m) |
  // best feathered exit in 5 s | full throttle | sideways-20 m/s die (grass = 4.32 s):
  //    300 → 189 m 3.4t | 17.2 m 23 km/h | 7.1 m | 2.70 s      450 → 174 m 3.2t | 12.2 m | 2.42 s
  //   *600 → 160 m 2.9t |  7.2 m  9 km/h | 1.8 m | 2.20 s*     700 → 153 m 2.8t |  2.5 m | 2.08 s
  //    800 → 146 m 2.7t |  1.7 m (stuck) | 1.4 m | 1.98 s     1800 →  94 m 1.7t |  0.8 m | 1.40 s
  // 1800 FAILS target (b): drag 4·1800 = 7200 N exceeds ANY drive the rear can make on gravel
  // (grip budget μ·Fz = (1.90·0.35)·4703 ≈ 3128 N; ~4066 N through the ellipse at best; only
  // ~1839 N once the wheel is past the MF peak i.e. spinning) ⇒ truly stuck at every throttle,
  // and it also overshoots (a) at 1.7 traps. At 600 the drag is 2400 N: feathering (κ near the
  // MF peak → ~3128 N) MOVES it, full throttle (spun → ~1839 N) digs a hole ⇒ exactly the
  // throttle-sensitive escape the brief asks for, and it lands inside the 2–3 trap band.
  gravelDragConst: 300,
  gravelDragLin: 15,
  gravelDragQuad: 4.0,
  gravelDigGain: 2,
};

const GRAVEL_EPS = 0.5;       // m/s — taper the constant plow drag below this (no rest jitter)
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
  // last-frame ground under each wheel (all false unless the map supplies a sampler) —
  // read by the render layer for the grass dig tracks / dust. NOT read by the physics.
  surface: [Surface, Surface, Surface, Surface];
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
      surface: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
    };
    states.set(car, s);
  }
  return s;
}
export function wheelDebug(car: CarState): P4State | undefined { return states.get(car); }

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

// wheel order: 0 FL, 1 FR, 2 RL, 3 RR
//
// `surfaceAt` — the ACTIVE MAP's O(1) ground lookup (world metres). Omitted (desktop, both
// ovals, and every arcade-mode call) ⇒ the grass branches never run and the step is
// byte-identical. Sampled UNDER EACH WHEEL separately, so two wheels on grass + two on
// asphalt produce the real asymmetric pull/oversteer emergently — never a car-level fudge.
export function step4(
  car: CarState, input: Inputs, dt: number, p: Physics4Params = PHYS4,
  surfaceAt?: (x: number, y: number) => Surface,
) {
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
  // steer angle follows the input the SAME way forward or reverse (front wheels
  // point where you steer) — the reverse direction falls out of the physics (the
  // low-speed kinematic yaw uses −v when reversing). NO explicit mirror: a mirror
  // double-flipped it → steer left backed the car RIGHT. Now: steer left → the
  // front wheels point left → the car reverses to the LEFT, like a real car.
  const steer = clamp(input.steer, -1, 1);
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
  const rearD: [number, number] = [0, 0];        // rear grip budget (sub-step ω integration)
  const rearFyRaw: [number, number] = [0, 0];    // rear pre-ellipse lateral (sub-step ellipse)
  const surfOut: Surface[] = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
  let rearSaturated = false;

  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    // ---- GROUND under THIS wheel's contact point (world) ----
    let ground: Surface = 'asphalt';
    if (surfaceAt) {
      const wx = car.x + rx[i] * cos - ry[i] * sin;
      const wy = car.y + rx[i] * sin + ry[i] * cos;
      ground = surfaceAt(wx, wy);
    }
    surfOut[i] = ground;
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

    // grip = f(load) with DIMINISHING RETURNS (tire load sensitivity), then scaled by the
    // GROUND under this wheel. On asphalt the scale is exactly 1 → byte-identical.
    const mu = Math.max(MU_FLOOR,
      p.muNom - p.loadSensitivity * (Fz - FzStatic[i]) / FzStatic[i])
      * p.tire.muScale[ground];   // the TYRE decides what this ground costs it
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
    if (!front) { rearD[i - 2] = D; rearFyRaw[i - 2] = Fy; }
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

    // ---- SELF-ALIGNING TORQUE (pneumatic trail): Mz = -Fy·t. A real tyre's
    // lateral force acts a distance t (the pneumatic trail) BEHIND the contact
    // centre → a restoring moment that tries to align the wheel with its
    // velocity. The trail is MAX at centre and COLLAPSES to 0 (then slightly
    // negative) as the slip angle passes the peak — so the moment BUILDS with
    // slip (progressive warning + directional stability, always on, not gated),
    // then EASES right at the grip limit (the "steering goes light" cue). Trail
    // scales with the contact patch (∝ load).
    // ONLY the REAR wheels feed it into the CHASSIS yaw: a real front tyre's
    // aligning moment reacts through the STEERING system (self-centring the wheel
    // = steering feel), not the chassis — and here steering is a kinematic input
    // (fixed wheel angle), so a front Mz on the chassis would be spurious understeer.
    // The REAR aligning moment has no steering DOF → it genuinely acts on the
    // chassis = the real directional stability that kills the yaw limit-cycle.
    let Mz = 0;
    if (!front && !lockedRear && !reversing) {
      const trailFrac = clamp(1 - Math.abs(alpha) / p.trailPeakSlip, -0.15, 1);
      const loadScale = clamp(Fz / FzStatic[i], 0, 1.5);   // trail ∝ contact patch ∝ load
      Mz = -Fy * p.pneumaticTrail * trailFrac * loadScale;
    }

    // rotate wheel force back to body frame (+δ) and accumulate
    let fbx = Fx * cd - Fy * sd;
    let fby = Fx * sd + Fy * cd;
    // ---- GRASS ROLLING DRAG (grass ≠ ice): a linear resistance opposing THIS wheel's
    // contact-point velocity — the turf swallows the wheel. It is a separate rolling
    // resistance, NOT a tyre force, so it does not go through the friction circle. It acts
    // at the contact point, so it feeds the yaw torque below too (a wheel dropping onto the
    // grass drags that corner back = the real pull, emergently).
    if (ground === 'grass') {
      fbx -= p.grassDragPerWheel * vwx;
      fby -= p.grassDragPerWheel * vwy;
    } else if (ground === 'gravel') {
      // DEEP LOOSE STONE — the wheel digs in. Three terms opposing the contact velocity's
      // DIRECTION: the CONSTANT static digging (bites at walking pace → sets how hard it is to
      // crawl OUT), a small linear term, and the QUADRATIC stone-displacement term (owns the
      // high-speed braking). All three use the FULL contact velocity vector, so a sideways
      // slide plows stones exactly as hard as a forward one and dies — no separate lateral
      // term. The whole magnitude is tapered below GRAVEL_EPS so a parked car can't jitter:
      // the taper covers the quad term too, which matters because v² alone would leave a
      // stiff force gradient at the rest boundary.
      const vc = Math.hypot(vwx, vwy);
      if (vc > 1e-6) {
        // How hard THIS wheel is spinning, 0..1 — the same over-spin measure that gates the
        // spray/smoke, read per wheel. st.rearOmega still holds the PREVIOUS step's value here
        // (it is integrated further down), so this is prev-frame by construction — no
        // algebraic loop, the same pattern the load transfer already uses for body accel.
        // Fronts are undriven and a locked (handbrake) rear has ω pinned to 0 → both give 0:
        // neither excavates, they only plow, which the constant already covers.
        const spin = i >= 2 && !hb
          ? clamp((st.rearOmega[i - 2] * rr - v) / Math.max(v, 3), 0, 1)
          : 0;
        const dig = p.gravelDragConst * (1 + p.gravelDigGain * spin);
        const taper = Math.min(1, vc / GRAVEL_EPS);
        const mag = (dig + p.gravelDragLin * vc + p.gravelDragQuad * vc * vc) * taper;
        fbx -= mag * (vwx / vc);
        fby -= mag * (vwy / vc);
      }
    }
    Fbx += fbx; Fby += fby;
    Tz += rx[i] * fby - ry[i] * fbx + Mz;   // yaw torque about CoM + self-aligning
  }

  // ---- rear wheel dynamics: Iw·dω/dt = T_drive − Fx(κ)·r − T_brake ----
  // (handbrake keeps ω pinned to 0 → the lock owns the wheel; drive can't spin
  // it → the handbrake ALWAYS brakes.) NO traction control — raw power (race
  // special). The wheel carries a REALISTIC reflected inertia (~5 kg·m²), so the
  // κ∝1/v longitudinal-slip dynamics are LIVE: at low speed a given wheel-speed
  // excess is a HUGE slip ratio → the rear breaks loose easily (traction-limited);
  // at high speed the same excess is a small κ → it grips (grip-limited). The
  // stiff low-inertia wheel ODE is SUB-STEPPED (recomputing Fx(κ) each sub-step,
  // body forces stay at the frame rate) so it integrates stably WITHOUT the old
  // big-inertia band-aid that masked the whole effect. This is correct
  // integration, not a feel tweak.
  const nSub = Math.max(1, p.wheelSubsteps | 0);
  const subDt = dt / nSub;
  // ON THROTTLE (not braking/coasting/reversing) the drive spin-up runs at the REAL
  // low reflected inertia + sub-stepped → live κ∝1/v traction (easy slow spin, grips
  // fast) that stays numerically stable. Braking / coast / engine-braking keep the
  // OLD single-step at the base inertia (so braking + coast are UNCHANGED — no false
  // rear lock, the drive-only change is isolated).
  const onThrottle = throttle > 0.01 && brakeEff <= 0.001 && !reversing;
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
    const baseIw = onThrottle ? p.wheelInertiaDrive : p.wheelInertia;
    const IwEff = baseIw * (1 - (1 - p.wheelInertiaSlideFactor) * slideFrac);
    const Tdrive = driveTorquePerRear;
    // ENGINE BRAKING the CAR: closed-throttle compression drag pulls the wheel
    // BELOW rolling (κ<0) → the tyre brakes the car (coast decel on the straight).
    // (A) FADED OFF as the rear slides so it doesn't brake a drifting rear.
    const Tengine = (1 - throttle) * p.engineBrakeTorque * (1 - p.engineBrakeSlideFade * slideFrac);
    if (onThrottle) {
      // SUB-STEP the drive ω ODE: recompute the longitudinal tyre force from the
      // evolving κ each sub-step (the stiff nonlinearity), through the same friction
      // ellipse the body sees (combined slip: a laterally-loaded rear spins up more).
      const vlong = rearVlong[ri];
      const D = rearD[ri] || 1;
      const denom = Math.max(Math.abs(vlong), 3);
      const ellLong = D * (p.tireEllipseLong || 1);
      const FyRaw = rearFyRaw[ri];
      for (let s = 0; s < nSub; s++) {
        const kappa = (omega * rr - vlong) / denom;
        let FxLong = D * Math.sin(p.tireCx * Math.atan(p.tireBx * kappa));
        const demand = Math.hypot(FxLong / ellLong, FyRaw / D);
        if (demand > 1) FxLong /= demand;
        // ENGINE REVS WITH THE WHEEL: the power limit is set by the ENGINE RPM,
        // which tracks the driven wheel's surface speed (ω·r) through the drivetrain
        // — NOT the ground speed. When the wheel spins up (ω·r ≫ v) the engine revs
        // into the power taper → the drive torque DROPS → the spin self-limits and
        // HOOKS UP (a real car can't hold infinite wheelspin — power caps it). The
        // frame-level `driveTorquePerRear` used car speed, which kept feeding a
        // runaway spin on the falling tyre curve; recomputing it here at the wheel
        // speed each sub-step breaks that trap. Below rolling (ω·r ≤ v) this equals
        // the car-speed value → launch/low-speed wheelspin (κ∝1/v) is unchanged.
        const wheelSurf = Math.abs(omega) * rr;
        const driveForceW = throttle * Math.min(p.peakThrust,
          p.enginePower / Math.max(v, wheelSurf, p.powerFloorSpeed));
        const TdriveW = (driveForceW / 2) * rr;
        omega += (TdriveW - FxLong * rr - Math.sign(omega) * Tengine) / IwEff * subDt;
        if (omega < 0) omega = 0;
      }
    } else {
      // BRAKING / COAST / REVERSE: the ORIGINAL single-step (base inertia, the
      // frame's rearFx incl. brake) → braking + coast dynamics byte-identical.
      omega += (Tdrive - rearFx[ri] * rr - Math.sign(omega) * (Tbrake + Tengine)) / IwEff * dt;
      if (omega < 0) omega = 0;   // brake can't drive the wheel backward (no reverse yet)
    }
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
  // YAW: the self-aligning torque (Mz, summed into Tz in the wheel loop) is the
  // real, always-on restoring/damping moment now — the slide-gated arcade damper
  // is GONE (its on/off gating fed the yaw limit-cycle). A tiny NON-gated yaw-rate
  // damping remains for numerical hygiene only (no slide trigger, no on/off edge).
  const Tyaw = Tz - p.yawDampConst * w;
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

  // ---- ARCADE top-speed limiter: a hard cap on the forward speed (the "gearing/
  // limiter" top), gated on the arcade branch so SIM is byte-identical. Decoupled
  // from engine power → raising power for the launch cannot push the top off target.
  if (p.branch === 'arcade' && p.arcadeTopSpeed) {
    const sp = Math.hypot(vx, vy);
    if (sp > p.arcadeTopSpeed) { const k = p.arcadeTopSpeed / sp; vx *= k; vy *= k; }
  }

  // ---- integrate pose ----
  car.vx = vx; car.vy = vy;
  car.angularVel = omega;
  car.heading = car.heading + omega * dt;   // heading is an INDEPENDENT state
  car.x += vx * dt;
  car.y += vy * dt;

  st.load = [loadOut[0], loadOut[1], loadOut[2], loadOut[3]];
  st.surface = [surfOut[0], surfOut[1], surfOut[2], surfOut[3]];

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
