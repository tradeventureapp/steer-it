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
  // Off-track effect multiplier (render-only): ×size + ×rate on this car's grass-dust / gravel-
  // spray particles. 1 = the shared default (Blitz RS → circuit visuals byte-identical); an
  // arcade car cranks it up for a brutal, dense off-road throw. NEVER touches physics.
  fxScale?: number;
  // A pre-authored SVG sprite instead of the vector-drawn Blitz RS body. When set,
  // drawCar blits the cached bitmap; the slot colour / livery are ignored (the skin
  // is a fixed design). VISUAL ONLY — the physics still uses the global PHYS4.
  sprite?: { car: 'steerex'; skin: SteerexSkin };
}

// ROAD — the base Blitz RS (grippy asphalt Sport-class coupe). NO overrides →
// its effective config IS CONFIG → byte-identical to the untouched car.
export const ROAD_SPEC: VehicleSpec = {
  name: 'Blitz RS',
  overrides: {},
};

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
const STEEREX_DIMS: VehicleDims = {
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
  weightDistFront: 0.55,   // 55% front (up from the inherited 0.53) — authentic rally/rallycross
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
  tireB: 8,                // lateral stiffness — LOWER than the slick's 10 → the peak sits at a higher slip angle = a broader, more planted grip build-up
  tireC: 1.30,             // lateral shape — LOWER than the slick's 1.45 → gentler post-peak fall-off = forgiving, holds over a wider slip range, doesn't snap
  tireEllipseLong: 1.05,   // LOWER than the slick's 1.3 — universals lack the slick's extreme longitudinal bite (also lets it rotate more willingly, for later drift phases)
  loadSensitivity: 0.06,   // ~Blitz's 0.05 — kept low so grip holds under load transfer = planted/forgiving (not dramatic)
  // per-surface μ — ALL-TERRAIN: keeps meaningful grip off-tarmac (Blitz slick collapses to 0.28/0.35)
  tire: { muScale: { asphalt: 1.0, grass: 0.60, gravel: 0.65 } },
  // NOTE: tireBx (12) + tireCx (1.6) NOT touched — 12 is already a broad longitudinal peak; the
  // universal's softer longitudinal bite comes from tireEllipseLong (1.3 → 1.05), not tireBx.
  // --- PHASE 2.5 (power first): OWN POWER + TOP SPEED. Grip is NOT touched (high grip killed
  //     drift); the 4WD 40/60 puts the launch down, full-throttle wheelspin is fine character. ---
  enginePower: 666000,     // 666 kW ≈ 893 hp (lore figure, real physics peak). At 900 kg = ~740 kW/t — sci-fi tier (~2× a real rallycross RX1e's 500 kW/1400 kg).
  peakThrust: 31000,       // N low-speed drive force — scaled ~2.4× from Blitz's 13000 (same ratio as the power 666/276) so the torque→power crossover stays ~76 km/h. 4WD 40/60 spreads it across 4 tyres, so more of it puts down; the excess spins the wheels (character).
  arcadeTopSpeed: 300 / 3.6,  // 300 km/h HARD limiter — top held by gearing/limiter, INDEPENDENT of power (666 kW would otherwise drag-limit ~340 km/h; the limiter caps it at 300).
  // --- PHASE 2.4: BRAKING — arcade rallycross, forgiving. Stronger stops + braking is DECOUPLED
  //     from drifting (plain braking stays plain; the handbrake stays the drift trigger). ---
  brakeForce: 20000,       // N — brutal, shorter stop (100→0 ~25 m vs ~32 m before). Stronger than a real rallycross car.
  brakeBiasFront: 0.62,    // slight front bias (Blitz 0.60)
  arcadeBrakeStability: 8,     // yaw damping under braking → the car HOLDS ITS LINE (fixes the bug where ~30% brake + any steer spun the car via the unloaded rear). Straight braking unaffected (no yaw to damp).
  arcadeBrakeStabilitySteer: 0.85,  // |steer| at which the stability has faded → a HARD brake + HARD steer still breaks loose (spin). Below it: controllable diagonal skid, not a spin.
  // --- HANDBRAKE as the PRIMARY DRIFT TOOL (not the sim's over-braking kinetic lock). Breaks the
  //     rear lateral grip loose so the tail steps out into a FLOWING drift that carries speed;
  //     pulling it mid-drift re-breaks the rear → swing through centre to the opposite lock (flick). ---
  arcadeHbLatGrip: 0.50,   // rear keeps 50% cornering grip under handbrake → breaks loose into a CONTROLLED ~40° drift (not the sim lock's violent 47°+ snap); lower = wilder/over-rotates, higher = shallower.
  arcadeHbBrake: 0.10,     // LIGHT longitudinal brake (10% of the rear grip) — a fraction of the main brake, so the drift FLOWS and carries speed (entry keeps ~47 km/h vs the sim lock scrubbing to ~36).
};
export const STEEREX_SILVER: VehicleSpec = {
  name: 'Stee-Rex Silver',
  overrides: {},
  dims: STEEREX_DIMS,
  branch: 'arcade',
  arcade: STEEREX_ARCADE,
  fxScale: 1.7,                // brutal, dense off-road throw (grass dust / gravel spray)
  sprite: { car: 'steerex', skin: 'silver' },
};
export const STEEREX_BLACK: VehicleSpec = {
  name: 'Stee-Rex Black',
  overrides: {},
  dims: STEEREX_DIMS,
  branch: 'arcade',
  arcade: STEEREX_ARCADE,
  fxScale: 1.7,                // brutal, dense off-road throw (grass dust / gravel spray)
  sprite: { car: 'steerex', skin: 'black' },
};

export const VEHICLE_SPECS: VehicleSpec[] = [ROAD_SPEC, STEEREX_SILVER, STEEREX_BLACK];
