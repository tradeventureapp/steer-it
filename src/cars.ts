// =============================================================================
//  Multiplayer cars (STEP 2) — spawn layout, car-vs-car collision, and input
//  routing. PURE math: no DOM, no transport. The desktop owns the live Car
//  objects (physics state + colour + smoothed inputs + skid trails) and the
//  per-frame wiring; this module holds only the parts that must be provably
//  correct, so they're unit-testable:
//    • a non-overlapping spawn grid that scales to N players,
//    • a stable arcade bounce between two cars (clamped so pile-ups can't
//      explode),
//    • input clamping/merge shared by the control router and its test.
// =============================================================================
import { CONFIG, type CarState, type Inputs } from './physics';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Spacing between spawn cells (metres). Must exceed 2× the car collision radius
// so freshly-spawned cars never overlap — the unit test asserts exactly this.
export const SPAWN_GAP = 2.4;
const SPAWN_PER_ROW = 4;

// Deterministic spawn offset (metres, relative to the map centre) as a pure
// function of slot index, so it scales to N. Slot 0 sits dead-centre (the solo
// car is unchanged); slots 1+ fill a centred grid just below it.
export function spawnOffset(slot: number): { dx: number; dy: number } {
  if (slot <= 0) return { dx: 0, dy: 0 };
  const i = slot - 1;
  const col = i % SPAWN_PER_ROW;
  const row = Math.floor(i / SPAWN_PER_ROW);
  const dx = (col - (SPAWN_PER_ROW - 1) / 2) * SPAWN_GAP; // centred row
  const dy = (row + 1) * SPAWN_GAP;                       // first extra row below centre
  return { dx, dy };
}

// World spawn pose for a slot given the map centre (metres). Heading "up"
// (−π/2) matches the canvas convention the solo car always used.
export function spawnPose(
  slot: number, cx: number, cy: number,
): { x: number; y: number; heading: number } {
  const { dx, dy } = spawnOffset(slot);
  return { x: cx + dx, y: cy + dy, heading: -Math.PI / 2 };
}

// Clamp + merge a raw control packet into a car's target inputs (the same path
// the desktop's control router uses). Ignores non-finite fields so a malformed
// packet can't NaN-poison the physics. Exported so the router and its test
// share one definition.
export function applyInputs(
  target: Inputs,
  p: { steer?: unknown; throttle?: unknown; brake?: unknown; handbrake?: unknown },
): void {
  const s = Number(p?.steer);
  const t = Number(p?.throttle);
  const b = Number(p?.brake);
  if (Number.isFinite(s)) target.steer = clamp(s, -1, 1);
  if (Number.isFinite(t)) target.throttle = clamp(t, 0, 1);
  if (Number.isFinite(b)) target.brake = clamp(b, 0, 1);
  target.handbrake = !!p?.handbrake;
}

// Arcade car-vs-car collision: equal-mass circles. Positional push-out split
// between the pair, normal-velocity exchange with restitution, impulse clamped
// so a multi-car pile-up can never explode. Mutates both states in place and
// returns the closing speed (0 = not colliding / separating) for feedback.
export function collidePairCars(
  a: CarState, b: CarState,
  R: number = CONFIG.carCollisionRadius,
  restitution = 0.35,
  maxImpulse = 6,
): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const minD = 2 * R;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minD * minD) return 0;

  let nx: number, ny: number, d: number;
  if (d2 > 1e-9) { d = Math.sqrt(d2); nx = dx / d; ny = dy / d; }
  else { d = 0; nx = 1; ny = 0; }   // exactly coincident → pick an axis

  // Positional push-out, split equally so neither car "wins" the overlap.
  const pen = minD - d;
  const push = pen / 2 + 0.001;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;

  // Normal-velocity exchange — only if the pair is actually closing.
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn < 0) {
    // Equal masses: 1/ma + 1/mb = 2 ⇒ j = −(1+e)·vn / 2. Clamp for stability.
    let j = (-(1 + restitution) * vn) / 2;
    if (j > maxImpulse) j = maxImpulse;
    a.vx -= j * nx; a.vy -= j * ny;
    b.vx += j * nx; b.vy += j * ny;
    // Settle the spin a touch on solid hits so cars don't pirouette off each other.
    a.angularVel *= 0.92;
    b.angularVel *= 0.92;
    return -vn;
  }
  return 0;
}

// Resolve every unordered car pair. A couple of relaxation passes keep a
// pile-up stable (later pairs fix overlaps an earlier push introduced) without
// the cost of a real solver. Returns the strongest closing speed seen.
export function collideCars(
  states: CarState[],
  R: number = CONFIG.carCollisionRadius,
  iterations = 2,
): number {
  let strongest = 0;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < states.length; i++) {
      for (let k = i + 1; k < states.length; k++) {
        const s = collidePairCars(states[i], states[k], R);
        if (s > strongest) strongest = s;
      }
    }
  }
  return strongest;
}
