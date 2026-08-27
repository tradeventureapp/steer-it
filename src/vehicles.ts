// =============================================================================
//  VEHICLE IDENTITY — the public-facing spec sheet, SEPARATE from physics.
// -----------------------------------------------------------------------------
//  This is pure DISPLAY DATA: the name + stats the player, UI, and marketing
//  see. It is deliberately DECOUPLED from the physics (physics.ts `CONFIG`):
//
//    • physics.ts is the FEEL — tuned freely; its numbers (mass, enginePower,
//      maxSteerAngle, friction, loadTransferGain, …) exist only to make the car
//      drive well and CHANGE whenever we tune handling.
//    • this file is the IDENTITY — a stable, branded spec sheet that does NOT
//      have to equal the physics 1:1 and does NOT change when we tune physics.
//
//  So `power: '~230 hp'` here is the car's stated character, independent of
//  whatever `enginePower` happens to be in the sim today.
//
//  No UI is wired to this yet — it's just the data, ready to be displayed when
//  we build the garage / car-select / HUD later. Nothing imports it for now.
//
//  EXTENDING TO MORE CARS: add another `VehicleIdentity` to `VEHICLES`. Each car
//  = an identity spec (this) + a `physicsProfile` reference (the link to feel),
//  kept separate so identity and physics never entangle. Today there is one
//  physics profile (the single physics.ts `CONFIG`), referenced as 'default';
//  when we add per-car physics profiles, `physicsProfile` is the key that
//  resolves to one — without identity ever reaching into the force model.
// =============================================================================

export type Drivetrain = 'RWD' | 'FWD' | 'AWD';

// A selectable car colour: a display name + the body hex the renderer recolours
// from. Pure data. (`lobby.ts` re-exports this as the lobby's `CAR_COLORS`, so
// it drives the phone colour picker, the per-slot default colours, and the
// roster colour names — all from this one list.)
export interface CarColor { name: string; hex: string; }

// ---- Blitz RS colour set — ONE unified muted retro/90s palette ----------------
// Period car-paint tones, deliberately NOT glowing neon. 12 distinct hues so an
// 8-player lobby has more choices than slots; ordered so the first slots default
// to maximally-distinct colours for at-a-glance multiplayer readability. All our
// own paint names.
export const BLITZ_RS_COLORS: CarColor[] = [
  { name: 'Rallye Red',     hex: '#c4202a' },
  { name: 'Marine Blue',    hex: '#23427e' },
  { name: 'Sunbeam Yellow', hex: '#e0b23c' },
  { name: 'Pine Green',     hex: '#2f6e54' },
  { name: 'Burnt Orange',   hex: '#d4682c' },
  { name: 'Plum Purple',    hex: '#6e5091' },
  { name: 'Lagoon Teal',    hex: '#2c7d83' },
  { name: 'Dusty Rose',     hex: '#c2738a' },
  { name: 'Alpine White',   hex: '#e7e9e4' },
  { name: 'Onyx Black',     hex: '#1d1f24' },
  { name: 'Oxblood Maroon', hex: '#7c2731' },
  { name: 'Sky Blue',       hex: '#5b8cb3' },
];

// ---- Stee-Rex skin "colours" (the ARCADE car has two fixed liveries) -----------
// The phone colour picker in ARCADE mode offers these; each maps to a sprite skin
// (Silver → STEEREX_SILVER, Graphite → STEEREX_BLACK) via desktop.ts specForColor().
// Hexes are just swatch tones for the picker — the sprite skin is what actually draws.
// 8 Stee-Rex skins. The swatch hex is the phone-picker chip + the specForColor lookup key; the
// SPRITE draws the full metallic gradient (steerex-sprite SKIN_DEFS), not this flat hex. Order =
// picker order (Silver default first). All 8 hexes are distinct → cars are told apart at a glance.
export const STEEREX_SKIN_COLORS: CarColor[] = [
  { name: 'Silver',   hex: '#c9ced6' },
  { name: 'Graphite', hex: '#2a2d34' },
  { name: 'Blue',     hex: '#2f6ccb' },
  { name: 'Red',      hex: '#cc2b38' },
  { name: 'Purple',   hex: '#7c4bc6' },
  { name: 'White',    hex: '#f2f0ec' },
  { name: 'Orange',   hex: '#e06a1c' },
  { name: 'Yellow',   hex: '#eab61c' },
];
// Parallel to STEEREX_SKIN_COLORS (same order) — the sprite skin each swatch selects.
const STEEREX_SKINS: SteerexSkin[] = ['silver', 'black', 'blue', 'red', 'purple', 'white', 'orange', 'yellow'];

// One car's public spec sheet. Pure data — no physics, no behaviour, no DOM.
export interface VehicleIdentity {
  /** Stable internal key (URLs / save data / registry lookups). */
  id: string;
  /** Public display name — what the player and marketing see. */
  name: string;
  /** Short category, e.g. 'RWD drift coupe'. */
  type: string;
  /** Era label, e.g. 'Early 1990s'. */
  era: string;
  /** Power as a DISPLAY string (character, not the sim's enginePower). */
  power: string;
  /** Engine description, e.g. 'Inline-six'. */
  engine: string;
  /** Driven wheels. */
  drivetrain: Drivetrain;
  /** Stated kerb weight (kg) — display figure, not necessarily physics mass. */
  weightKg: number;
  /**
   * Reference to the PHYSICS profile that gives this car its feel — the ONLY
   * link between identity and physics, and it's a one-way string key so tuning
   * physics never touches identity. Today all cars use the single physics.ts
   * CONFIG, referenced as 'default'.
   */
  physicsProfile: string;
  /** The car's selectable colour set (the lobby/picker reads this). */
  colors: CarColor[];
}

// ---- Blitz RS — the launch car -------------------------------------------------
// Early-90s RWD drift coupe. (Internal feel-reference only, NEVER public: tuned
// to drive in the spirit of a period engine-swapped RWD coupe drift build. The
// public identity is ALWAYS "Blitz RS" — no real make/model appears anywhere a
// player can see.)
export const BLITZ_RS: VehicleIdentity = {
  id: 'blitz-rs',
  name: 'Blitz RS',
  type: 'RWD drift coupe',
  era: 'Early 1990s',
  power: '~230 hp',
  engine: 'Inline-six',
  drivetrain: 'RWD',
  weightKg: 1200,
  physicsProfile: 'default',
  colors: BLITZ_RS_COLORS,
};

// ---- Registry (extensible) -----------------------------------------------------
export const VEHICLES: Record<string, VehicleIdentity> = {
  [BLITZ_RS.id]: BLITZ_RS,
};

export const DEFAULT_VEHICLE_ID = BLITZ_RS.id;

export function getVehicle(id: string): VehicleIdentity | undefined {
  return VEHICLES[id];
}

export function listVehicles(): VehicleIdentity[] {
  return Object.values(VEHICLES);
}

// =============================================================================
//  VEHICLE SPEC — the per-car PHYSICS profile (the `physicsProfile` hook above
//  made concrete). A spec is a NAME + an optional livery colour + a PARTIAL
//  override of the physics `CONFIG`. The car's effective config is
//  `{ ...CONFIG, ...spec.overrides }`, so every car shares the ONE sim-real-2
//  model and differs only by its numbers — no forked physics.
//
//  ⚠️ Overrides MUST NOT touch the SCALE (`wheelbase` / `pxPerMeter`): every car
//  stays on the one real-metre ruler and draws the same size. A new car only
//  changes feel parameters (mass, torque, grip, gearing) + livery.
//
//  Type-only import of `Config` → no runtime dependency on physics (no cycle).
// =============================================================================
import type { Config } from './vehicle-core';
import type { SteerexSkin } from './steerex-sprite';
import type { FurySkin } from './fury-sprite';
import type { BlitzSkin } from './blitz-sprite';
import type { ScrappySkin } from './scrappy-sprite';
import type { VoltSkin } from './volt-sprite';
import type { Physics4Params } from './physics4';

// A vehicle's REAL-WORLD dimensions (metres). The source of truth for how big the car
// is in the world — the sprite is scaled to `lengthM` and the collision radius derives
// from it (later, so does the physics tune). Blitz RS's dimensions come from CONFIG
// (wheelbase-derived), so ROAD_SPEC omits this; a sprite car states its own.
export interface VehicleDims {
  lengthM: number;      // nose→tail
  widthM: number;       // across the (flared) tyres — the widest point
  wheelbaseM: number;   // front axle → rear axle
  bodyWidthM: number;   // body only, excluding the flared wheels
}

export interface VehicleSpec {
  name: string;                    // internal codename (NO real brand strings)
  liveryColor?: string;            // fixed body hex; falls back to the slot colour
  overrides: Partial<Config>;      // partial CONFIG override (physics4 per-car feel, NOT scale)
  dims?: VehicleDims;              // real-world size (source of truth for sprite scale + collision)
  // HANDLING BRANCH — which physics4 path this car drives (default 'sim' = Blitz RS's
  // honest per-wheel model, byte-identical). 'arcade' = the same engine with a forgiving
  // tune (Stee-Rex). `arcade` = the per-car physics4 knob overrides applied on top of the
  // global PHYS4 (empty for now = behaves like sim until the arcade tune lands).
  branch?: 'sim' | 'arcade';
  arcade?: Partial<Physics4Params>;
  // PER-CAR SIM PHYSICS — physics4 param overrides applied on top of the global PHYS4
  // for a SIM car (any branch). This is the sim analogue of `arcade`: it lets a sim car
  // (e.g. the Fury) carry its OWN mass / inertia / geometry / drivetrain (AWD split) /
  // tyre / engine without an arcade tune. Blitz RS omits it → its effective params ARE
  // PHYS4 → byte-identical. NEVER touched for the arcade branch (that uses `arcade`).
  phys4?: Partial<Physics4Params>;
  // Off-track effect multiplier (render-only): ×size + ×rate on this car's grass-dust / gravel-
  // spray particles. 1 = the shared default (Blitz RS → circuit visuals byte-identical); an
  // arcade car cranks it up for a brutal, dense off-road throw. NEVER touches physics.
  fxScale?: number;
  // A pre-authored SVG sprite instead of the vector-drawn Blitz RS body. When set,
  // drawCar blits the cached bitmap; the slot colour / livery are ignored (the skin
  // is a fixed design). VISUAL ONLY — the physics still uses the global PHYS4.
  sprite?: { car: 'steerex'; skin: SteerexSkin } | { car: 'fury'; skin: FurySkin }
    | { car: 'blitz'; skin: BlitzSkin } | { car: 'scrappy'; skin: ScrappySkin }
    | { car: 'volt'; skin: VoltSkin };
}

// ROAD — the base Blitz RS (grippy asphalt Sport-class coupe). NO physics overrides →
// its effective config IS CONFIG → byte-identical golden. The `sprite` is VISUAL ONLY
// (drawCar blits public/BlitzRS.png — white body + our sunset stripe — instead of the
// vector body); physics/phys4/collision are untouched (no `dims`, so the radius is the
// same golden value).
export const ROAD_SPEC: VehicleSpec = {
  name: 'Blitz RS',
  overrides: {},
  sprite: { car: 'blitz', skin: 'white' },   // default / fallback = the iconic near-white body
};

// The Blitz RS shares the 8-colour palette (STEEREX_SKIN_COLORS) with the Stee-Rex — the phone
// picks any of the 8 and the body renders in that colour (a masked multiply on the PNG's white
// body panels; the sunset stripe / glass / wheels / lights are untouched — see blitz-sprite.ts).
// Every skin is the SAME Blitz RS: no `dims`, no `phys4` ⇒ physFor returns the exact PHYS4
// reference and the collision radius is the golden value for ALL 8 ⇒ byte-identical golden.
const BLITZ_SKINS: BlitzSkin[] = ['silver', 'black', 'blue', 'red', 'purple', 'white', 'orange', 'yellow'];
function blitzSpec(skin: BlitzSkin): VehicleSpec {
  return { ...ROAD_SPEC, sprite: { car: 'blitz', skin } };
}
export const BLITZ_SPECS: Record<BlitzSkin, VehicleSpec> = {
  silver: blitzSpec('silver'), black: blitzSpec('black'), blue: blitzSpec('blue'),
  red: blitzSpec('red'), purple: blitzSpec('purple'), white: ROAD_SPEC,
  orange: blitzSpec('orange'), yellow: blitzSpec('yellow'),
};
// The Blitz skin a picked swatch hex resolves to (matched against STEEREX_SKIN_COLORS — the
// shared palette). Unknown → 'white' (the iconic Blitz), mirroring steerexSkinForColor.
export function blitzSkinForColor(hex: string): BlitzSkin {
  const h = hex.trim().toLowerCase();
  const i = STEEREX_SKIN_COLORS.findIndex((c) => c.hex.toLowerCase() === h);
  return i >= 0 ? BLITZ_SKINS[i] : 'white';
}

// RALLY variant RETIRED (Fase-0 cleanup — it depended on sim-real-2 grip
// overrides which are also retired). The spec lives in git; re-add a VehicleSpec
// here (with physics4 overrides once Fase 0+ exposes per-car params) to bring a
// second car back.

// STEE-REX — the designer's arcade widebody (working title "Rascal RX"). VISUAL ONLY:
// a sprite skin with NO physics tune yet, so it borrows Blitz RS's physics4 params
// (the global PHYS4) as a placeholder — clearly to be replaced with the real arcade
// tune next. Two fixed skins.
// Real dimensions (measured from the designer's NEW narrower render, sprite ratio
// L/W = 2.0137 kept exactly, width anchored to a clean 2.000 m): wide but realistic —
// vs Blitz RS (4.35×1.68) = ~same length, a touch wider.
export const STEEREX_DIMS: VehicleDims = {
  lengthM: 4.027, widthM: 2.000, wheelbaseM: 2.571, bodyWidthM: 1.672,
};
// STEE-REX arcade tune (physics4 knob overrides on top of PHYS4, arcade branch).
// Each target is a DECOUPLED lever (top speed / accel / drift / surface).
// EMPTY = the pre-acceleration state (Stage 1). The whole "0-100 / 0-200 / 300 max" tuning
// (Stage 2b onward) raised muNom to 3.0 for a fast launch — and that high grip is exactly what
// KILLED the drift (the rear could no longer break loose; a handbrake tap barely reached ~10°).
// With NO overrides, Stee-Rex runs the sim physics (muNom 1.90), which DRIFTS: a handbrake tap
// slides it to ~37° and it recovers (proven in the harness). This is the state the car drove
// well in, before the acceleration work. arcade branch + empty overrides = sim behaviour.
// Stee-Rex's OWN driving profile — built deliberately, phase by phase (physics4 is per-car).
// PHASE 2.1: geometry + mass + 4WD only. Everything else (tyres/grip, CoG, weight distribution,
// drift/brake/launch tuning) is deliberately INHERITED from Blitz this phase, so we can isolate
// what mass + geometry + 4WD alone do. Later phases give it its own tyres, grip, drift, etc.
const STEEREX_ARCADE: Partial<Physics4Params> = {
  // --- PHASE 2.1: geometry + mass + 4WD ---
  wheelbase: 2.571,        // m — its own rovor (Blitz 2.565)
  trackWidth: 1.74,        // m — wide track matching its 2.0 m body (Blitz 1.46)
  massKg: 900,             // kg — light sci-fi car (Blitz 1020)
  driveSplitFront: 0.4,    // 4WD, 40% front / 60% rear (Blitz is RWD = 0)
  maxSteer: 0.52,          // 30° front lock (down from the inherited 32°/0.56) — calms the twitchy,
                           // over-sensitive turn-in slightly. The universal tyre peaks at ~19° slip,
                           // so 30° still covers full grip + counter-steer (the handbrake drift stays
                           // catchable) while a tad less near-centre gain than 32°. Radius @30 km/h
                           // ~4.45 m (vs 4.1 at 32°). LINEAR mapping unchanged (no expo curve).
  weightDistFront: 0.54,   // 54% front (nudged 0.55→0.54, tiny shift toward neutral) — authentic rally/rallycross
                           // AWD bias (real cars run 55-61% front); 0.55 = the low end. CALMS the
                           // lift-off oversteer (more front = more directionally stable, so the rear
                           // won't step out so willingly on throttle-lift + turn) while staying
                           // drift-capable. Also sets the CoM longitudinal position (lr = 0.55·WB) —
                           // one value, no separate CoG-longitudinal to mismatch. cgHeight (0.45,
                           // vertical) unchanged — weight distribution only.
  // --- PHASE 2.2: OWN TIRES — universal all-terrain (vs Blitz's specialised slicks). STARTING
  //     values for drive-testing, not final. Character: strong but BROAD/forgiving on tarmac
  //     (planted, no razor peak, doesn't snap) + keeps far more grip off-track. ---
  muNom: 1.90,             // SAME peak grip magnitude as the slick — NOT higher (high grip killed drift). The universal feel comes from a BROADER curve, not more grip.
  tireB: 8,                // lateral stiffness — LOWER than the slick's 10 → the peak sits at a higher slip angle = a broader, more planted grip build-up. (Tried 10 to stiffen cornering — it barely helped the corner and WORSENED the drift feel, so reverted to the universal 8.)
  tireC: 1.30,             // lateral shape — LOWER than the slick's 1.45 → gentler post-peak fall-off = forgiving, holds over a wider slip range, doesn't snap. (Reverted from 1.45 with tireB — kept the universal drift feel.)
  tireEllipseLong: 1.3,    // NORMAL-CORNER FIX (raised 1.05→1.3, = Blitz's slick value). At 1.05 the
                           // friction ellipse was too round → maintenance throttle in a corner ATE the
                           // rear's lateral grip → the rear smeared/stepped out in EVERY normal corner
                           // (164 slide-frames across the envelope). 1.3 elongates the ellipse
                           // longitudinally so throttle no longer crushes the rear's cornering grip →
                           // rear PLANTED (smear 164→~20 frames, the single biggest cornering fix).
                           // The drift is now handbrake/arcadeDriftGrip-driven, not ellipse-driven, so
                           // this doesn't cost the drift (verified). Trade: less throttle-induced
                           // rotation = the intended stable feel.
  loadSensitivity: 0.06,   // ~Blitz's 0.05 — kept low so grip holds under load transfer = planted/forgiving (not dramatic)
  // --- WEIGHT-TRANSFER SENSITIVITY. ---
  loadTransferLatGain: 0.6,   // 1.0→0.6 — LATERAL transfer to the outer wheels was hair-trigger:
                              // the rear broke loose (isRearSliding) in every throttle-on corner
                              // (65+ frames, 20-70 km/h). 0.6 plants it; 60% of the shift is retained
                              // (felt). Handbrake is a direct grip-cut, independent → still provokes.
  loadTransferLongGain: 0.8,  // 1.5→0.8 — LONGITUDINAL transfer under lift-off/coast unloaded the rear
                              // → a high-speed COAST corner (60 km/h) SPUN (β 149°). 0.8 kills the
                              // lift-off spin (β 149°→8°) without touching braking feel (brakes are a
                              // separate force path). Trail-brake rotation is slightly softer (fine —
                              // Stee-Rex drifts on the handbrake, not the brake).
  // per-surface μ — ALL-TERRAIN: keeps meaningful grip off-tarmac (Blitz slick collapses to 0.28/0.35).
  // dirt 0.85 (near-asphalt): packed flat-track dirt is Stee-Rex's PLAYGROUND — terrain tyres grip
  // hard and drift beautifully on it (vs the Blitz slick's 0.50 struggle).
  tire: { muScale: { asphalt: 1.0, grass: 0.60, gravel: 0.65, dirt: 0.85 } },
  // NOTE: tireBx (12) + tireCx (1.6) NOT touched — 12 is already a broad longitudinal peak; the
  // universal's softer longitudinal bite comes from tireEllipseLong (1.3 → 1.05), not tireBx.
  // --- PHASE 2.5 (power first): OWN POWER + TOP SPEED. Grip is NOT touched (high grip killed
  //     drift); the 4WD 40/60 puts the launch down, full-throttle wheelspin is fine character. ---
  enginePower: 666000,     // 666 kW ≈ 893 hp (lore figure, real physics peak). At 900 kg = ~740 kW/t — sci-fi tier (~2× a real rallycross RX1e's 500 kW/1400 kg).
  peakThrust: 31000,       // N low-speed drive force — scaled ~2.4× from Blitz's 13000 (same ratio as the power 666/276) so the torque→power crossover stays ~76 km/h. 4WD 40/60 spreads it across 4 tyres, so more of it puts down; the excess spins the wheels (character).
  arcadeTopSpeed: 300 / 3.6,  // 300 km/h HARD limiter — top held by gearing/limiter, INDEPENDENT of power (666 kW would otherwise drag-limit ~340 km/h; the limiter caps it at 300).
  // --- PHASE 2.4: BRAKING — arcade rallycross, forgiving. Stronger stops + braking is DECOUPLED
  //     from drifting (plain braking stays plain; the handbrake stays the drift trigger). ---
  brakeForce: 22000,       // N — raised 20000→22000 so hard braking exceeds the grip budget a bit sooner = the wheels LOCK / break into a skid slightly earlier.
  brakeBiasFront: 0.62,    // slight front bias (Blitz 0.60)
  arcadeBrakeStability: 6,     // yaw damping under braking — LOWERED 8→6 so brake+steer swings the tail more willingly (less yaw damp). Straight braking still stable (no yaw to damp when steer≈0).
  arcadeBrakeStabilitySteer: 0.85,  // |steer| at which the stability has faded → a HARD brake + HARD steer still breaks loose (spin). Below it: controllable diagonal skid, not a spin.
  arcadeBrakeTransfer: 1.0,    // under braking, DOUBLE the longitudinal transfer at full pedal (0.8→1.6 effective)
                               // → the rear unloads → trail-brake OVERSTEER = the car swings sideways on brake+
                               // steer. Brake-gated → coast (off-throttle high-speed) keeps its grip, unchanged.
  // --- HANDBRAKE as the PRIMARY DRIFT TOOL (not the sim's over-braking kinetic lock). Breaks the
  //     rear lateral grip loose so the tail steps out into a FLOWING drift that carries speed;
  //     pulling it mid-drift re-breaks the rear → swing through centre to the opposite lock (flick). ---
  arcadeHbLatGrip: 0.50,   // rear keeps 50% cornering grip under handbrake → breaks loose into a CONTROLLED ~40° drift (not the sim lock's violent 47°+ snap); lower = wilder/over-rotates, higher = shallower.
  arcadeHbBrake: 0.40,     // rear-axle handbrake braking — NOTICEABLE deceleration (hb-only stop ~31 m from 50, vs the old 0.10's 88 m), but well short of the 4-wheel main brake (~6 m). Still light enough that the drift FLOWS (entry ~36° keeping ~47 km/h) and the flick works. (0.55 → ~25 m / shallower drift if more braking wanted.)
  // --- SELF-SUSTAINING DRIFT: without this the rear re-grips on its own once the slide shallows,
  //     so the car AUTO-STRAIGHTENED back to grip with NO counter-steer (a drift you don't have to
  //     hold). This cuts the sliding rear's lateral grip so it STAYS loose once provoked — the slide
  //     holds, counter-steer becomes REQUIRED to balance it, and the deliberate exit is to LIFT the
  //     throttle (the cut is throttle-gated → lift releases it → the rear re-grips → straightens).
  arcadeDriftGrip: 0.25,   // 0..1 rear-grip cut once sliding. RAISED 0.15→0.25: the normal-corner fix
                           // above (planting the rear) also made a provoked drift re-grip faster, so
                           // the cut is deepened to RESTORE the self-sustain (provoke → holds ~70° for
                           // ~1.5 s, verified). Still β-gated above corner β → does NOT bleed into
                           // normal corners. MEASURED: no-input + held
                           // throttle now SUSTAINS a deep ~60-70° drift for ~2 s (vs the old snap
                           // straight back to 0°); counter-steer TOWARD the velocity catches it
                           // cleanly (required — nothing catches it for you); lift → exits. Kept mild
                           // (0.15) so it's holdable, not an uncatchable spin — over-driving into the
                           // slide still spins (the punish). Higher = holds looser/longer but spinnier.
  arcadeDriftGate: 0.12,   // rad ≈ 7° body-sideslip onset for the cut — above a normal corner's β
                           // (4-8°), so grip cornering isn't tripped; the cut only engages once
                           // genuinely drifting.
  arcadeDriftThrottleGate: 1.8, // throttle at which the drift-grip cut reaches FULL. PROGRESSIVE onset:
                           // at the old 0.3 the cut was full by ~30% throttle, so a moderate-throttle
                           // corner slide got AMPLIFIED into a 110°+ SPIN (grip→snap cliff). Raised to
                           // 1.8 so light/moderate throttle → little cut → the rear GRIPS (a corner
                           // slide settles to a controllable angle, not a spin); the cut feeds in as
                           // throttle rises → drift builds with MORE throttle. MEASURED (trail-brake
                           // maxβ): 0.5→19° (grips), 0.6→53°, full→56° controllable — vs the old
                           // 0.5→110° snap-spin. Higher = grippier / needs more throttle to drift;
                           // lower = drifts on less throttle. Handbrake path is !hb-gated → still
                           // triggers instantly regardless.
  // --- THROTTLE-DEPENDENT GRIP: off/light throttle = PLANTED (no accidental slide), hard throttle
  //     = can power-over, already-drifting = stays drifting (boost fades with β past arcadeDriftGate). ---
  arcadeThrottleGrip: 0.6,     // +60% rear grip at zero throttle → keeps the rear planted at speed. It's
                               // SPEED-FADED (below) so it does NOT apply at low/moderate speed → the car
                               // turns in freely there (a rear boost at low speed = understeer/on-rails).
  arcadeThrottleGripSpeed: 16, // m/s (~58 km/h) — the boost only fades IN above here (full by ~86 km/h),
                               // exactly where the base rear washes out. Below it: no boost = free turn-in.
  arcadeThrottleGripFade: 0.6, // boost gone by 60% throttle → floor it (>0.6) and the rear can break
                               // loose for a power-over; light throttle (≤~0.3) still keeps it glued.
  arcadeThrottleCut: 0.5,      // past 60% throttle WHILE turning, cut the rear grip up to 50% at full
                               // → flooring it in a corner breaks the tail loose (power-over). Steer-
                               // gated → a straight-line full-throttle pull still grips/accelerates.
  arcadeThrottleYaw: 10,       // rad/s² — gentle throttle in a GRIPPING corner rotates the NOSE IN
                               // (tightens the line) instead of understeering wide. Scaled by throttle ×
                               // steer, gripping-gated (never a drift). Mild = agile, not snap-oversteer.
  reverseSpeed: 19.44,         // m/s = 70 km/h — Stee-Rex's own reverse top (value only, no physics change).
  arcadeReverseGrip: 0.6,      // front (trailing axle) keeps 60% grip while REVERSING → the tail breaks loose and the car
                               // swings/spins willingly from a hard steer even at LOW reverse speed (loose,
                               // tail-happy). Counter-steer still catches it (the front keeps its grip).
  // --- STAGE 3: SUBTLE DRIFT ASSIST (feel like a master, NOT autopilot). ONLY while drifting. ---
  arcadeDriftAssist: 2.0,      // gentle β̇ damping → less twitchy: slightly wider holdable band + smoother
                               // catch + a touch more sustain. Kept low so a held drift still winds down.
  arcadeDriftAssistBand: 1.1,  // rad ≈ 63° — beyond this the assist fades to 0 → over-angle STILL SPINS.
  arcadeDriftAssistCatch: 0.15,// counter-steer threshold: a light corrective flick (≥0.15) already earns the
                               // full assist (forgiving). Below it / no counter / steering INTO the slide → OFF.
};
// Every Stee-Rex skin is the SAME arcade car — only the sprite skin + display name differ. One spec
// per skin, all built from the single arcade tune (STEEREX_ARCADE) + dims, so the 8 colours share
// byte-identical physics; only the metallic livery changes.
const STEEREX_SKIN_NAMES: Record<SteerexSkin, string> = {
  silver: 'Stee-Rex Silver', black: 'Stee-Rex Graphite', blue: 'Stee-Rex Blue', red: 'Stee-Rex Red',
  purple: 'Stee-Rex Purple', white: 'Stee-Rex White', orange: 'Stee-Rex Orange', yellow: 'Stee-Rex Yellow',
};
function steerexSpec(skin: SteerexSkin): VehicleSpec {
  return {
    name: STEEREX_SKIN_NAMES[skin], overrides: {}, dims: STEEREX_DIMS,
    branch: 'arcade', arcade: STEEREX_ARCADE,
    fxScale: 1.7,                // brutal, dense off-road throw (grass dust / gravel spray)
    sprite: { car: 'steerex', skin },
  };
}
export const STEEREX_SPECS: Record<SteerexSkin, VehicleSpec> = {
  silver: steerexSpec('silver'), black: steerexSpec('black'), blue: steerexSpec('blue'),
  red: steerexSpec('red'), purple: steerexSpec('purple'), white: steerexSpec('white'),
  orange: steerexSpec('orange'), yellow: steerexSpec('yellow'),
};
export const STEEREX_SILVER = STEEREX_SPECS.silver;   // kept for modeSpec / the car-tile preview
export const STEEREX_BLACK = STEEREX_SPECS.black;
// The skin a picked swatch hex resolves to (matched against STEEREX_SKIN_COLORS). Unknown → silver.
export function steerexSkinForColor(hex: string): SteerexSkin {
  const h = hex.trim().toLowerCase();
  const i = STEEREX_SKIN_COLORS.findIndex((c) => c.hex.toLowerCase() === h);
  return i >= 0 ? STEEREX_SKINS[i] : 'silver';
}

// ---- FURY 200 EVO — DEV-ONLY WIP test vehicle ---------------------------------
// A Group-B rallycross special (sprite car, white/blue rally livery). GATED to the
// dev host in desktop.ts (`isDev`) — never selectable or visible for a normal free/
// premium/anonymous user. It is DELIBERATELY kept OUT of `VEHICLE_SPECS` below so no
// generic listing can surface it. Physics is a PLACEHOLDER: it borrows the shared
// sim model (Blitz RS's PHYS4) — no Fury handling tune exists yet.
// Real-world dimensions (the physics anchor): 4000 × 1785 mm, wheelbase 2530,
// track ~1500. The sprite is width-anchored to `widthM`, so the length follows.
export const FURY_DIMS: VehicleDims = {
  lengthM: 4.0, widthM: 1.785, wheelbaseM: 2.53, bodyWidthM: 1.60,
};
// FURY physics4 profile — REAL numbers from the Ford RS200 Evolution in rallycross
// trim (Schanche 1991 title car); the behaviour EMERGES, it is not tuned to a feel.
// Every field maps to the anchor data (see the running log in CLAUDE.md). Only the
// fields that DIFFER from PHYS4 (the Blitz sim) are listed — the rest are inherited,
// so the Fury shares the same honest per-wheel model, differing only by its numbers.
const FURY_PHYS4: Partial<Physics4Params> = {
  // GEOMETRY (real) — the physics reads these, not CONFIG
  wheelbase: 2.53,            // 2530 mm (anchor / FURY_DIMS)
  trackWidth: 1.50,           // 1501 front / 1496 rear ≈ 1.50 (anchor)
  // DRIVETRAIN — permanent 4WD, centre torque split 37% front / 63% rear (anchor).
  // The existing per-wheel drive path deploys it; each axle already splits torque
  // equally L/R (locked/LSD-like), so the viscous LSDs map onto that split — no diff
  // term is added. 0.37 = the rear-leaning AWD character (traction on all four, rear bias).
  driveSplitFront: 0.37,
  // MASS + BALANCE
  massKg: 1100,               // ~1100 kg (anchor)
  weightDistFront: 0.50,      // 50/50 (anchor: gearbox-front balances the mid-rear engine)
  cgHeight: 0.48,             // low mid-engine rally car (a touch above the Blitz coupe's 0.45)
  yawInertiaK: 1.02,          // LOW polar moment (masses near centre) → Iz = 1100·1.02² ≈ 1144
                              // (< Blitz's 1469) → rotates EAGERLY; combined with 50/50 + power,
                              // a slide starts fast and is tricky to gather (authentic to this car)
  // TYRE — rallycross UNIVERSAL compound: a COMPROMISE. Lower tarmac peak than the
  // Blitz's slicks + broader/more forgiving, and FAR more grip off-tarmac.
  muNom: 1.55,                // tarmac peak ~1.5g (vs the slick's 1.90 ≈ 1.86g) — less outright grip
  tireB: 9,                   // broader peak build-up (softer than the slick's 10)
  tireC: 1.35,                // gentle post-peak falloff = forgiving (slick 1.45 sharper)
  tireEllipseLong: 1.35,      // AWD corner-exit: throttle keeps the lateral grip → superior drive out
  loadSensitivity: 0.06,
  tire: { muScale: { asphalt: 1.0, grass: 0.60, gravel: 0.70, dirt: 0.85 } },  // universal: keeps grip off-tarmac (the slick collapses to 0.28/0.35/0.50)
  // STEERING — a touch more lock than the race coupe
  maxSteer: 0.58,             // ~33°
  // ENGINE — ~650 hp / ~600 Nm, no turbo lag (direct throttle; lag model deliberately skipped)
  peakThrust: 21000,          // big low-speed drive force (~1.6× the Blitz's 13000, per the torque
                              // advantage) = violent punch; AWD deploys most of it (≈590 hp/tonne)
  enginePower: 485000,        // 485 kW ≈ 650 hp (the ∝1/v power taper)
  // BRAKES — heavier car, strong rally brakes
  brakeForce: 14000,          // ~1.3g at 1100 kg
  brakeBiasFront: 0.58,       // slightly less front bias than the Blitz (AWD)
};
export const FURY_SPEC: VehicleSpec = {
  name: 'Fury 200 EVO',
  overrides: {},                          // (legacy CONFIG field, unused by physics4)
  phys4: FURY_PHYS4,                       // its OWN real per-wheel sim physics (AWD rallycross)
  dims: FURY_DIMS,
  fxScale: 1.4,                           // rallycross → a bigger off-road throw
  sprite: { car: 'fury', skin: 'white' },   // default / fallback = the original white livery
};

// The Fury shares the SAME 8-colour palette as the other two cars — the phone picker already
// sends one of these hexes. Recolouring is a masked multiply on the body region declared by
// public/Fury-mask.png; the glass, chevrons, logo tile and taillights are excluded there.
// Every skin is the SAME car: it spreads FURY_SPEC, so `phys4`/`dims` are byte-identical
// across all 8 and only the livery differs. Blitz has no `phys4` at all ⇒ its golden is
// untouched by any of this.
const FURY_SKINS: FurySkin[] = ['silver', 'black', 'blue', 'red', 'purple', 'white', 'orange', 'yellow'];
function furySpec(skin: FurySkin): VehicleSpec {
  return { ...FURY_SPEC, sprite: { car: 'fury', skin } };
}
export const FURY_SPECS: Record<FurySkin, VehicleSpec> = {
  silver: furySpec('silver'), black: furySpec('black'), blue: furySpec('blue'),
  red: furySpec('red'), purple: furySpec('purple'), white: FURY_SPEC,
  orange: furySpec('orange'), yellow: furySpec('yellow'),
};
/** The Fury skin a picked swatch hex resolves to (unknown → 'white', the original livery). */
export function furySkinForColor(hex: string): FurySkin {
  const h = hex.trim().toLowerCase();
  const i = STEEREX_SKIN_COLORS.findIndex((c) => c.hex.toLowerCase() === h);
  return i >= 0 ? FURY_SKINS[i] : 'white';
}

// ---- SCRAPPY GT — DEV-ONLY WIP: the BEGINNER arcade car ------------------------
// A small, compact FRONT-WHEEL-DRIVE hatch (a modern hot-hatch silhouette; public name
// "Scrappy GT"). GATED to the dev host in desktop.ts (`isDev`) while it's WIP — never
// selectable or visible for a normal user. It sits in the ARCADE section alongside
// Stee-Rex (NOT with the SIM cars). The whole point is FORGIVENESS: FWD so a beginner
// who enters a corner too fast pushes WIDE (understeer) instead of snapping into a spin.
//
// DIMENSIONS — the sprite is WIDTH-anchored, so lengthM:widthM MUST equal the sprite's opaque
// aspect or the drawn car won't match its collision box. The sprite is the TOP-DOWN view extracted
// from the Mini-JCW multi-view blueprint (nose-up, cleaned of the other views + dimension text).
// Measured opaque bbox of that sprite (after the game's standard near-black flood-fill) = 446 wide ×
// 969 long ⇒ L/W 2.1726; anchored on the reference length 3.874 m ⇒ widthM = 3.874 / 2.1726 = 1.783.
// (The dark side mirrors fall outside the flood, so the opaque width is the body-with-valance width,
// not the across-mirrors 1.9675 m the blueprint annotates.) Wheelbase = the real 2.495 m (physics
// wheelbase is set equal to dims.wheelbaseM). So the drawn car (3.874 × 1.783) EXACTLY fills its
// collision capsule — the point of this re-extraction.
export const SCRAPPY_DIMS: VehicleDims = {
  lengthM: 3.874, widthM: 1.783, wheelbaseM: 2.495, bodyWidthM: 1.62,
};
// SCRAPPY GT arcade tune — deliberately CALMER than Stee-Rex (the beginner car). The drift-
// provocation knobs (arcadeDriftGrip / arcadeThrottleCut / arcadeThrottleGrip / arcadeThrottleYaw
// / arcadeDriftAssist / arcadeBrakeTransfer / arcadeBrakeStability …) are all OMITTED, so they
// default OFF — no self-sustaining drift, no power-break-loose, no trail-brake oversteer. What is
// left is a grippy, front-heavy, front-wheel-drive car that UNDERSTEERS (pushes wide) at the limit
// and is very hard to spin. Mass 1080 kg (real Mini JCW is 1290; a heavy car accelerates/stops
// slower + pushes wider — using less keeps it nimble and planted, between Blitz 1020 and Fury 1100).
const SCRAPPY_ARCADE: Partial<Physics4Params> = {
  // --- geometry + mass + FRONT-WHEEL DRIVE (the defining trait) ---
  wheelbase: 2.495,        // m — the real Mini JCW wheelbase (= SCRAPPY_DIMS.wheelbaseM)
  trackWidth: 1.50,        // m — narrow (small car), a touch of width for lateral stability
  massKg: 1080,            // kg — lighter than the real 1290 (nimble + planted), not the heaviest
  driveSplitFront: 1.0,    // 100% FRONT drive = pure FWD. Under power the FRONT tyres reach their
                           // grip limit first → the nose washes WIDE (understeer); the rear is never
                           // driven, so it can't be kicked out with the throttle. THE beginner trait.
  weightDistFront: 0.62,   // front-heavy (real FWD hatch ~62% front) → the front is load-limited =
                           // understeer-biased, and the neutral-steer point sits well BEHIND the CoM
                           // = very directionally stable (resists the tail stepping out).
  maxSteer: 0.46,          // ~26° lock — LOWER than Stee-Rex (0.52) and Blitz (0.56). Calmer turn-in,
                           // far less sensitive to a clumsy input or a sudden phone tilt. The short
                           // 2.495 m wheelbase still gives a tight radius, so it stays nimble.
  // --- tyres: MORE grip than Stee-Rex + a GENTLER limit (forgiving, doesn't snap) ---
  muNom: 2.0,              // peak grip a touch above Stee-Rex's 1.90 → holds the track better.
  tireB: 8,                // broad, planted lateral build-up (same as Stee-Rex's universal tyre).
  tireC: 1.2,              // LOWER than Stee-Rex's 1.30 → gentler post-peak fall-off: past the limit
                           // it washes out SOFTLY and progressively instead of snapping = forgiving.
  tireEllipseLong: 1.3,    // throttle doesn't crush the tyre's lateral grip (matters for the driven
                           // FRONT axle — keeps corner-exit grip so a beginner isn't punished).
  loadSensitivity: 0.05,   // grip holds under load transfer → planted, undramatic.
  // --- weight transfer: CALMER than Stee-Rex → stable, unflappable ---
  loadTransferLatGain: 0.5,   // less lateral shift than Stee-Rex (0.6) → the outer tyres don't
                              // overload as fast → the car stays stable through a rushed corner.
  loadTransferLongGain: 0.7,  // damps rear-unload under lift-off/brake (Stee-Rex 0.8) → KILLS the
                              // lift-off oversteer that spins beginners when they panic-lift.
  // per-surface μ — a ROAD car: strong on tarmac, weaker (but not lethal) off it.
  tire: { muScale: { asphalt: 1.0, grass: 0.5, gravel: 0.55, dirt: 0.65 } },
  // --- power + top speed: a peppy hot-hatch, NOT a monster. FWD front tyres put it down cleanly. ---
  enginePower: 195000,     // 195 kW ≈ 260 hp — nimble, quick off the line, but no wheelspin drama.
  peakThrust: 13000,       // N low-speed drive (~Blitz's) — enough punch, front tyres cope.
  arcadeTopSpeed: 220 / 3.6,  // 220 km/h limiter (rarely reached on our short maps).
  // --- brakes: strong + STABLE (front-biased so the rear stays planted under braking) ---
  brakeForce: 15000,       // N — strong, confident stops so a beginner can scrub speed for a corner.
  brakeBiasFront: 0.65,    // front-biased (FWD front-heavy) → braking keeps the rear planted (no
                           // trail-brake tail-out). arcadeBrakeTransfer is OMITTED = no brake oversteer.
  // --- handbrake: GENTLE. Kept mild so a beginner can't accidentally spin it. ---
  arcadeHbLatGrip: 0.7,    // rear keeps 70% cornering grip under handbrake → a controllable little
                           // slide if pulled, never the violent lock/spin (Stee-Rex is 0.50).
  arcadeHbBrake: 0.3,      // moderate handbrake braking.
};
// Every Scrappy GT skin is the SAME arcade car — only the sprite skin + display name differ.
const SCRAPPY_SKIN_NAMES: Record<ScrappySkin, string> = {
  silver: 'Scrappy GT Silver', black: 'Scrappy GT Graphite', blue: 'Scrappy GT Blue', red: 'Scrappy GT Red',
  purple: 'Scrappy GT Purple', white: 'Scrappy GT White', orange: 'Scrappy GT Orange', yellow: 'Scrappy GT Yellow',
};
const SCRAPPY_SKINS: ScrappySkin[] = ['silver', 'black', 'blue', 'red', 'purple', 'white', 'orange', 'yellow'];
function scrappySpec(skin: ScrappySkin): VehicleSpec {
  return {
    name: SCRAPPY_SKIN_NAMES[skin], overrides: {}, dims: SCRAPPY_DIMS,
    branch: 'arcade', arcade: SCRAPPY_ARCADE,
    fxScale: 1.0,                // a road car → a modest off-road throw (not Stee-Rex's brutal 1.7)
    sprite: { car: 'scrappy', skin },
  };
}
export const SCRAPPY_SPECS: Record<ScrappySkin, VehicleSpec> = {
  silver: scrappySpec('silver'), black: scrappySpec('black'), blue: scrappySpec('blue'),
  red: scrappySpec('red'), purple: scrappySpec('purple'), white: scrappySpec('white'),
  orange: scrappySpec('orange'), yellow: scrappySpec('yellow'),
};
export const SCRAPPY_SILVER = SCRAPPY_SPECS.silver;   // kept for modeSpec / the car-tile preview
/** The Scrappy skin a picked swatch hex resolves to (unknown → 'silver'). */
export function scrappySkinForColor(hex: string): ScrappySkin {
  const h = hex.trim().toLowerCase();
  const i = STEEREX_SKIN_COLORS.findIndex((c) => c.hex.toLowerCase() === h);
  return i >= 0 ? SCRAPPY_SKINS[i] : 'silver';
}

// ---- VOLT R — PUBLIC + FREE: the FAST-FRIENDLY MIDDLE arcade car ----------------
// An all-wheel-drive sport hatchback (a modern Golf R silhouette; public name "Volt R").
// ARCADE section, sitting BETWEEN Scrappy GT and Stee-Rex: markedly quicker than Scrappy, far
// easier than Stee-Rex — but, by design, SLOWER around a lap than Stee-Rex/the sim cars in good
// hands (see the tune below). Free for everyone (arcade has no lock; only SIM is gated).
//
// DIMENSIONS — WIDTH-anchored (the draw path scales opaque WIDTH → widthM, length follows the sprite
// aspect), so lengthM:widthM MUST equal the sprite's opaque aspect or the drawn car won't fill its
// collision box. Measured opaque bbox of public/VoltR.png after the game's near-black flood-fill =
// 564 wide × 1342 long ⇒ aspect 2.3794. Anchored on widthM 1.802 ⇒ lengthM = 1.802 × 2.3794 = 4.288
// (the real Golf R length; the brief's 4.29 corrected to 4.288 so dims + sprite agree exactly).
// Wheelbase = 2.63 m (real; physics wheelbase is set equal to dims.wheelbaseM). bodyWidthM 1.64 is
// proportional to Scrappy's body/opaque ratio.
export const VOLT_DIMS: VehicleDims = {
  lengthM: 4.288, widthM: 1.802, wheelbaseM: 2.63, bodyWidthM: 1.64,
};
// VOLT R arcade tune — the FAST-FRIENDLY MIDDLE. Between Scrappy (pure-FWD beginner) and Stee-Rex
// (wild AWD). The trade-off "easy must cost something" is built from THREE independent levers:
//   (1) STRAIGHT-LINE: 245 kW / 1150 kg = 290 hp/tonne + 250 km/h top — clearly quicker than Scrappy
//       (241 hp/t, 220), well below Stee-Rex (992 hp/t, 300) and the sim cars.
//   (2) CAN'T ROTATE: AWD with a FRONT bias (0.6) + front weight + ALL drift-provocation knobs
//       OMITTED (like Scrappy) → it UNDERSTEERS (pushes wide), you can't provoke it into a
//       rotation. Stee-Rex's arcade drift/yaw/assist knobs let a skilled driver rotate + carry
//       more mid-corner/exit speed; the sim cars rotate on RWD. Volt can't → wider lines, more
//       braking → SLOWER lap despite the grip.
//   (3) GRIP CEILING: muNom 1.85 sits just UNDER Stee-Rex/sim (1.90), so even its peak lateral g is
//       a touch lower.
// Net: fast + forgiving, but a good driver laps it slower than Stee-Rex — the friendly middle option.
const VOLT_ARCADE: Partial<Physics4Params> = {
  // --- geometry + mass + AWD (front-biased) ---
  wheelbase: 2.63,         // m — real Golf R (= VOLT_DIMS.wheelbaseM)
  trackWidth: 1.55,        // m — wider than Scrappy (1.50), narrower than Stee-Rex (1.74): planted hatch
  massKg: 1150,            // kg (brief) — heavier than Scrappy (1080), lighter than Fury (1100 is sim)
  driveSplitFront: 0.6,    // AWD, 60% front / 40% rear. The Golf R's 4Motion is front-based, sending
                           // torque rearward only when needed → the car pushes WIDE rather than
                           // snapping into oversteer. More neutral than Scrappy's pure FWD (1.0), still
                           // front-biased for approachability (Stee-Rex is rear-biased 0.4).
  weightDistFront: 0.58,   // front-heavy (transverse engine) but less than Scrappy (0.62) — the AWD
                           // rear axle lets it be a touch more balanced while staying stable.
  maxSteer: 0.48,          // ~27° lock — between Scrappy (0.46) and Stee-Rex (0.52). Calm turn-in,
                           // unbothered by a clumsy input / sudden phone tilt.
  // --- tyres: grippy + forgiving (a proper sports hatch, clearly a step up from Scrappy) ---
  muNom: 1.90,             // peak grip at the wild-car level (Stee-Rex/sim 1.90; Scrappy the planted
                           // beginner is 2.0) → grippy + planted. The lap-time cost vs Stee-Rex is NOT
                           // grip — it's that Volt CAN'T ROTATE (front-bias AWD + no drift knobs) and
                           // has less power/top, so it can't carry Stee-Rex's mid-corner/exit speed.
  tireB: 8,                // broad, planted lateral build-up (universal-tyre feel).
  tireC: 1.25,             // between Scrappy (1.2) and Stee-Rex (1.30) — washes out softly, won't snap.
  tireEllipseLong: 1.3,    // throttle keeps corner-exit lateral grip (matters for the driven axles).
  loadSensitivity: 0.06,   // grip holds under load transfer → planted, undramatic.
  // --- weight transfer: calm → stable, forgiving ---
  loadTransferLatGain: 0.55,   // between Scrappy (0.5) and Stee-Rex (0.6) — outer tyres don't overload fast.
  loadTransferLongGain: 0.75,  // damps rear-unload under lift/brake (Scrappy 0.7 / Stee-Rex 0.8) → kills
                               // lift-off oversteer = forgiving under panic-lift.
  // per-surface μ — a ROAD car: strong on tarmac, weaker (not lethal) off it (same as Scrappy).
  tire: { muScale: { asphalt: 1.0, grass: 0.5, gravel: 0.55, dirt: 0.65 } },
  // --- power + top speed: markedly quicker than Scrappy, nowhere near the wild cars ---
  enginePower: 245000,     // 245 kW ≈ 333 hp (brief). AWD puts it down cleanly (no FWD wheelspin plough).
  peakThrust: 16000,       // N low-speed drive — more punch than Scrappy (13000), AWD traction copes;
                           // far below Stee-Rex (31000).
  arcadeTopSpeed: 250 / 3.6,  // 250 km/h limiter — above Scrappy (220), below Stee-Rex (300).
  // --- brakes: strong + STABLE (front-biased, no trail-brake oversteer) ---
  brakeForce: 15500,       // N — strong, confident stops.
  brakeBiasFront: 0.62,    // front-biased → braking keeps the rear planted. arcadeBrakeTransfer OMITTED.
  // --- handbrake: mild, controllable (a little more playful than Scrappy, nowhere near Stee-Rex) ---
  arcadeHbLatGrip: 0.6,    // rear keeps 60% cornering grip under handbrake (Scrappy 0.7 / Stee-Rex 0.50).
  arcadeHbBrake: 0.3,      // moderate handbrake braking.
  // ALL drift-provocation knobs (arcadeDriftGrip / arcadeThrottleCut / arcadeThrottleGrip /
  // arcadeThrottleYaw / arcadeDriftAssist / arcadeBrakeTransfer / arcadeBrakeStability) are OMITTED —
  // they default OFF, so there is NO self-sustaining drift, no power-break-loose, no rotation aid.
  // This is the core of "can't rotate → slower lap than Stee-Rex" while staying easy to drive.
};
// Every Volt R skin is the SAME arcade car — only the sprite skin + display name differ.
const VOLT_SKIN_NAMES: Record<VoltSkin, string> = {
  silver: 'Volt R Silver', black: 'Volt R Graphite', blue: 'Volt R Blue', red: 'Volt R Red',
  purple: 'Volt R Purple', white: 'Volt R White', orange: 'Volt R Orange', yellow: 'Volt R Yellow',
};
const VOLT_SKINS: VoltSkin[] = ['silver', 'black', 'blue', 'red', 'purple', 'white', 'orange', 'yellow'];
function voltSpec(skin: VoltSkin): VehicleSpec {
  return {
    name: VOLT_SKIN_NAMES[skin], overrides: {}, dims: VOLT_DIMS,
    branch: 'arcade', arcade: VOLT_ARCADE,
    fxScale: 1.0,                // a road car → a modest off-road throw (like Scrappy)
    sprite: { car: 'volt', skin },
  };
}
export const VOLT_SPECS: Record<VoltSkin, VehicleSpec> = {
  silver: voltSpec('silver'), black: voltSpec('black'), blue: voltSpec('blue'),
  red: voltSpec('red'), purple: voltSpec('purple'), white: voltSpec('white'),
  orange: voltSpec('orange'), yellow: voltSpec('yellow'),
};
export const VOLT_SILVER = VOLT_SPECS.silver;   // kept for modeSpec / the car-tile preview
/** The Volt skin a picked swatch hex resolves to (unknown → 'silver'). Shared by the arcade + sim Volt. */
export function voltSkinForColor(hex: string): VoltSkin {
  const h = hex.trim().toLowerCase();
  const i = STEEREX_SKIN_COLORS.findIndex((c) => c.hex.toLowerCase() === h);
  return i >= 0 ? VOLT_SKINS[i] : 'silver';
}

// ---- VOLT R (SIM) — PREMIUM: the APPROACHABLE sim car ---------------------------
// The SAME car as the arcade Volt R (same sprite/recolour module + VOLT_DIMS) but a SEPARATE entry
// in the SIM section, running the honest per-wheel model (branch:'sim' + a `phys4` override, exactly
// like the Fury) — NO arcade assists. Positioned as the MOST APPROACHABLE of the three sim cars (the
// one to learn the sim model on): Blitz RS is RWD/raw, Fury is an AWD rallycross machine; the sim Volt
// is a fast, planted road car that UNDERSTEERS rather than biting. Premium like Blitz/Fury (SIM section
// inherits the sim lock).
// Real anchor: modern Golf R — 245 kW / 333 hp, ~1150 kg, front-based 4Motion AWD.
// VOLT_SIM_PHYS4 lists ONLY the fields that DIFFER from PHYS4 (the Blitz sim); the rest are inherited,
// so it shares the same honest model and Blitz's golden 0.0e+0 is untouched (Blitz has no phys4).
const VOLT_SIM_PHYS4: Partial<Physics4Params> = {
  // GEOMETRY (= VOLT_DIMS)
  wheelbase: 2.63,            // m — real Golf R
  trackWidth: 1.55,           // m — planted road hatch (Blitz 1.46 / Fury 1.50)
  // DRIVETRAIN — front-based 4Motion: AWD, 60% front. Torque goes rearward only when needed, so under
  // power the FRONT reaches its limit first → the nose washes WIDE (understeer). The forgiving,
  // approachable trait — the opposite of Blitz's RWD tail and Fury's eager rear-biased rotation.
  driveSplitFront: 0.6,
  // MASS + BALANCE — front-heavy transverse engine → understeer-leaning + very directionally stable.
  massKg: 1150,               // kg (anchor)
  weightDistFront: 0.60,      // 60% front (real hot hatch ~61%) — the most front-biased of the sim
                              // cars (Blitz 0.53 / Fury 0.50) → neutral-steer point well behind the
                              // CoM = resists the tail stepping out = approachable.
  cgHeight: 0.48,             // a road hatch sits a touch higher than the Blitz race coupe (0.45).
  yawInertiaK: 1.18,          // moderate-high polar moment (engine over the front axle) → STABLE,
                              // slow to rotate (Blitz 1.20; Fury's LOW 1.02 makes it twitchy/eager).
  // TYRE — a performance ROAD tyre: less ultimate grip than the Blitz's slicks, but a BROAD, gentle
  // limit that washes out progressively instead of snapping = forgiving.
  muNom: 1.70,                // tarmac peak ~1.67g (Blitz slick 1.90 ≈ 1.86g; Fury universal 1.55) — middle.
  tireB: 9,                   // broad build-up (Blitz's slick 14 is sharp; Fury 9) = planted, predictable.
  tireC: 1.30,                // GENTLE post-peak falloff (Blitz 1.65 sharp; Fury 1.35) → forgiving washout.
  tireEllipseLong: 1.30,      // AWD corner-exit: throttle keeps the lateral grip (both axles driven).
  loadSensitivity: 0.08,      // grip holds under load transfer → planted, undramatic.
  tire: { muScale: { asphalt: 1.0, grass: 0.45, gravel: 0.50, dirt: 0.62 } },  // road: between the slick + the rallycross universal
  // STEERING — a road car, moderate lock
  maxSteer: 0.54,             // ~31° (Blitz 0.56 / Fury 0.58)
  // ENGINE — 245 kW / 333 hp, AWD deploys it cleanly (the ∝1/v power taper, no arcade top-speed cap)
  peakThrust: 14000,          // N low-speed drive — a touch above Blitz's 13000 (AWD traction), far
                              // below Fury's 21000. The least powerful sim car = least intimidating.
  enginePower: 245000,        // 245 kW ≈ 333 hp
  // BRAKES — strong + STABLE (front-biased → the rear stays planted, no trail-brake oversteer)
  brakeForce: 14500,          // ~1.28g at 1150 kg — confident stops.
  brakeBiasFront: 0.62,       // more front bias than Blitz (0.60) / Fury (0.58) → stable under braking.
};
export const VOLT_SIM_SPEC: VehicleSpec = {
  name: 'Volt R',
  overrides: {},                          // (legacy CONFIG field, unused by physics4)
  phys4: VOLT_SIM_PHYS4,                   // its OWN honest per-wheel sim physics (AWD road car)
  dims: VOLT_DIMS,
  fxScale: 1.0,                            // a road car → a modest off-road throw
  sprite: { car: 'volt', skin: 'white' },   // REUSES the Volt sprite + recolour (no new artwork)
};
function voltSimSpec(skin: VoltSkin): VehicleSpec {
  return { ...VOLT_SIM_SPEC, sprite: { car: 'volt', skin } };
}
export const VOLT_SIM_SPECS: Record<VoltSkin, VehicleSpec> = {
  silver: voltSimSpec('silver'), black: voltSimSpec('black'), blue: voltSimSpec('blue'),
  red: voltSimSpec('red'), purple: voltSimSpec('purple'), white: VOLT_SIM_SPEC,
  orange: voltSimSpec('orange'), yellow: voltSimSpec('yellow'),
};
export const VOLT_SIM_SILVER = VOLT_SIM_SPECS.silver;   // kept for modeSpec / the car-tile preview

export const VEHICLE_SPECS: VehicleSpec[] = [ROAD_SPEC, STEEREX_SILVER, STEEREX_BLACK];
