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
// Real dimensions (measured from the designer's render, sprite ratio L/W = 1.61 kept
// exactly): near Blitz RS's length but DRAMATICALLY wider (sci-fi/NASA lore, wider than
// F1) — vs Blitz RS (4.35×1.68) = 0.92× length, 1.48× width. The width is intentional.
const STEEREX_DIMS: VehicleDims = {
  lengthM: 4.00, widthM: 2.49, wheelbaseM: 2.55, bodyWidthM: 2.08,
};
export const STEEREX_SILVER: VehicleSpec = {
  name: 'Stee-Rex Silver',
  overrides: {},
  dims: STEEREX_DIMS,
  sprite: { car: 'steerex', skin: 'silver' },
};
export const STEEREX_BLACK: VehicleSpec = {
  name: 'Stee-Rex Black',
  overrides: {},
  dims: STEEREX_DIMS,
  sprite: { car: 'steerex', skin: 'black' },
};

export const VEHICLE_SPECS: VehicleSpec[] = [ROAD_SPEC, STEEREX_SILVER, STEEREX_BLACK];
