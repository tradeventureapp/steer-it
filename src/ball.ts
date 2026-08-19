// =============================================================================
//  BALL (football mode, STEP 2) — a dynamic ball object for the arena.
//
//  PURE physics logic: no DOM, no transport, no render (desktop.ts owns the state,
//  the wiring, and the drawing — same split as xp.ts / race.ts / time-attack.ts).
//
//  ⚠️ ISOLATION FROM THE CAR PHYSICS (Blitz golden 0.0e+0):
//  The ball has its OWN tiny integrator (stepBall). It NEVER goes through step4 or
//  the shared force path. Wall bounces reuse the SAME collideWithRects/collideWithArcs
//  the cars use (with the ball's own restitution config). Car↔ball is resolved in the
//  post-step4 collision phase (beside collideCars), reading/writing only position +
//  velocity. physics4.ts / vehicle-core.ts are untouched → the golden stays intact.
// =============================================================================
import {
  CONFIG, collideWithRects, collideWithArcs,
  type CarState, type Config, type ObstacleRect, type ObstacleArc,
} from './vehicle-core';

// ─────────────────────────────────────────────────────────────────────────────
//  ★★★  BALL TUNING — EVERY knob, one place.  ★★★
//  Change these to change the feel. Each says which way makes it more/less lively.
// ─────────────────────────────────────────────────────────────────────────────
export const BALL = {
  RADIUS: 1.0,            // m — ball radius. Diameter 2.0 m ≈ HALF a Stee-Rex length (4.03 m).
                          //     BIGGER = easier to hit / harder to dribble past; smaller = nippier.
  MASS: 45,              // kg — ball mass vs a ~1020 kg car. LOWER = flies further off a hit AND the
                          //     car is slowed less (more "kick"); HIGHER = heavier, sluggish, shoves the car more.

  ROLL_DECEL: 3.2,       // m/s² — constant rolling resistance. HIGHER = comes to rest SOONER; LOWER = rolls longer.
  LINEAR_DAMP: 0.15,     // per s — extra speed-proportional slowing (air drag). HIGHER = fast balls bleed speed
                          //     quicker (less lively at speed); LOWER = keeps its pace.
  REST_SPEED: 0.25,      // m/s — below this the ball snaps to a dead stop (kills infinite creep).
  MAX_SPEED: 60,         // m/s — absolute speed clamp. HIGHER = the ball can travel faster.

  WALL_RESTITUTION: 0.6, // 0..1 — bounciness off the arena walls. HIGHER = bouncier walls / more rebound.
  WALL_FRICTION: 0.15,   // 0..1 — tangential scrub on a wall graze. HIGHER = more speed lost sliding along a wall.

  CAR_RESTITUTION: 0.45, // 0..1 — bounciness of a CAR→ball hit. HIGHER = the ball springs off the car harder.
  MAX_HIT_DV: 34,        // m/s — cap on the ball's speed CHANGE from a single car hit (anti-explosion).
                          //     HIGHER = harder shoves possible; lower = tamer max kick.

  PUSHOUT: 0.02,         // m — tiny extra separation so the ball never sinks into a car or wall.
};

// The ball is a CIRCLE collider. `heading`/`angularVel` exist ONLY so a BallState can be handed to
// the existing collideWithRects/collideWithArcs (typed for CarState); with halfLen=halfWidth=RADIUS
// those treat it as a pure circle, and heading is irrelevant (spine length 0). We never read them.
export interface BallState {
  x: number; y: number; vx: number; vy: number;
  heading: number; angularVel: number;
}

export function makeBall(cx: number, cy: number): BallState {
  return { x: cx, y: cy, vx: 0, vy: 0, heading: 0, angularVel: 0 };
}

// The ball's OWN wall-bounce config — the car path is untouched (cars keep CONFIG). Only the
// three collision responses differ; push-out is shared.
const BALL_WALL_CFG: Config = {
  ...CONFIG,
  collisionRestitution: BALL.WALL_RESTITUTION,
  collisionTangentFriction: BALL.WALL_FRICTION,
  collisionYawDamp: 0,   // a ball has no meaningful spin here
};

// Self-motion for one fixed step: rolling friction (constant decel + speed-proportional damp +
// rest snap), then integrate, then clamp top speed. NOTHING car-related happens here.
export function stepBall(ball: BallState, dt: number): void {
  let sp = Math.hypot(ball.vx, ball.vy);
  if (sp > 1e-6) {
    let ns = (sp - BALL.ROLL_DECEL * dt) * (1 - BALL.LINEAR_DAMP * dt);
    if (ns < BALL.REST_SPEED) ns = 0;
    if (ns > BALL.MAX_SPEED) ns = BALL.MAX_SPEED;
    const k = ns / sp;
    ball.vx *= k; ball.vy *= k;
  }
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
}

// Wall bounce — the SAME collideWithRects/collideWithArcs the cars use, ball radius, ball config.
// (The cast is safe: those functions only touch x/y/vx/vy/heading/angularVel, all present on BallState.)
export function collideBallWalls(ball: BallState, rects: ObstacleRect[], arcs?: ObstacleArc[]): number {
  const b = ball as unknown as CarState;
  let impact = collideWithRects(b, rects, BALL_WALL_CFG, BALL.RADIUS, BALL.RADIUS);
  if (arcs) impact = Math.max(impact, collideWithArcs(b, arcs, BALL_WALL_CFG, BALL.RADIUS, BALL.RADIUS));
  return impact;
}

// Backstop: keep the ball inside the world rect even if it ever slips a wall.
export function clampBallToWorld(ball: BallState, worldW: number, worldH: number): void {
  const r = BALL.RADIUS;
  if (ball.x < r) { ball.x = r; if (ball.vx < 0) ball.vx = -ball.vx * BALL.WALL_RESTITUTION; }
  else if (ball.x > worldW - r) { ball.x = worldW - r; if (ball.vx > 0) ball.vx = -ball.vx * BALL.WALL_RESTITUTION; }
  if (ball.y < r) { ball.y = r; if (ball.vy < 0) ball.vy = -ball.vy * BALL.WALL_RESTITUTION; }
  else if (ball.y > worldH - r) { ball.y = worldH - r; if (ball.vy > 0) ball.vy = -ball.vy * BALL.WALL_RESTITUTION; }
}

// CAR → BALL push. A MASS-AWARE variant of collidePairCars: the car is a CAPSULE (closest point on
// its spine, like the wall collision), the ball a circle; the impulse is the real 2-body form
// j = −(1+e)·vn / (1/mCar + 1/mBall), so a much lighter ball takes almost all the Δv and the car is
// barely slowed. Mutates carState + ball velocity/position ONLY — never re-enters step4. Returns the
// closing speed (for FX). `he` = the car's visual half-extents (carHalfExtents).
export function collideCarBall(
  carState: CarState,
  he: { halfLen: number; halfWidth: number },
  carMassKg: number,
  ball: BallState,
): number {
  const rCar = he.halfWidth;                    // capsule radius
  const spine = Math.max(0, he.halfLen - rCar); // spine half-length
  const ch = Math.cos(carState.heading), sh = Math.sin(carState.heading);
  const ax = carState.x - ch * spine, ay = carState.y - sh * spine;
  const bx = carState.x + ch * spine, by = carState.y + sh * spine;
  // Closest point P on the spine segment AB to the ball centre.
  const abx = bx - ax, aby = by - ay, abL2 = abx * abx + aby * aby;
  let t = abL2 > 0 ? ((ball.x - ax) * abx + (ball.y - ay) * aby) / abL2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + t * abx, py = ay + t * aby;

  let nx = ball.x - px, ny = ball.y - py;
  const d = Math.hypot(nx, ny);
  const minD = rCar + BALL.RADIUS;
  if (d >= minD) return 0;
  if (d > 1e-6) { nx /= d; ny /= d; } else { nx = ch; ny = sh; }   // coincident → shove off the nose

  const mCar = carMassKg > 0 ? carMassKg : 1000, mBall = BALL.MASS;
  const invSum = 1 / mCar + 1 / mBall;

  // Positional push-out split by mass (the ball, being light, takes almost all of it).
  const pen = minD - d + BALL.PUSHOUT;
  const carShare = (1 / mCar) / invSum, ballShare = (1 / mBall) / invSum;
  carState.x -= nx * pen * carShare; carState.y -= ny * pen * carShare;
  ball.x += nx * pen * ballShare;   ball.y += ny * pen * ballShare;

  // Normal-velocity 2-body impulse — only if closing.
  const vn = (ball.vx - carState.vx) * nx + (ball.vy - carState.vy) * ny;
  if (vn >= 0) return 0;
  let j = -(1 + BALL.CAR_RESTITUTION) * vn / invSum;
  // Cap by the ball's resulting speed change (anti-explosion).
  const maxJ = BALL.MAX_HIT_DV * mBall;
  if (j > maxJ) j = maxJ;
  ball.vx += (j / mBall) * nx;     ball.vy += (j / mBall) * ny;
  carState.vx -= (j / mCar) * nx;  carState.vy -= (j / mCar) * ny;   // tiny — car barely slowed
  return -vn;
}
