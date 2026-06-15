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
