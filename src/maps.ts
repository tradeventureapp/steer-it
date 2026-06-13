// =============================================================================
//  Map system (STEP 1 — architecture only).
//
//  A MAP is a switchable entity: it owns the background, the obstacle/collision
//  model, the spawn layout, and the world bounds + wrap behaviour. The desktop
//  (currently the only map) is registered here as the FIRST map; adding another
//  map later = registering another MapDefinition, and a menu later = calling
//  switchMap(id) in desktop.ts. Nothing in desktop.ts hardcodes the desktop any
//  more — it reads everything through the active MapDefinition.
//
//  Keeping the obstacle handle and concrete world OPAQUE (MapObstacle = unknown,
//  MapWorld = the minimal shape the game loop needs) lets each map use its own
//  internal world type (the desktop uses DesktopWorld) while desktop.ts stays
//  map-agnostic. Each MapDefinition's own methods know how to read their world.
// =============================================================================

import { CONFIG, type CarState, type ObstacleRect } from './physics';
import { spawnPose } from './cars';
import {
  layoutDesktop, drawWallpaper, drawOverlay, drawClock,
  rebuildRects, iconAt, clampIconToBounds, resolveIconDrop,
  type DesktopWorld, type DesktopIcon,
} from './world';

// The minimal world shape the shared game loop touches directly. Concrete maps
// return a richer object (e.g. DesktopWorld) that structurally satisfies this.
export interface MapWorld {
  width: number;          // metres
  height: number;         // metres
  rects: ObstacleRect[];  // collision rects fed to collideWithRects
}

export interface SpawnPose { x: number; y: number; heading: number; }

// Opaque handle for a draggable obstacle (the desktop uses DesktopIcon).
export type MapObstacle = unknown;

export interface MapDefinition {
  id: string;
  name: string;

  // Optional tire-smoke/dust tint [r,g,b] for this surface. Omitted ⇒ the
  // default whitish rubber smoke (the desktop). The dirt oval, say, kicks up
  // brown dust. Only the COLOUR changes — emission/cap/growth/fade are shared.
  smokeColor?: [number, number, number];

  // ---- World construction ----
  // Build the world state for a canvas of (widthM × heightM) METRES: obstacles,
  // collision rects, bounds. Called on load, on resize, and on switch.
  createWorld(widthM: number, heightM: number): MapWorld;

  // ---- Rendering (PIXEL space; ctx already DPR-scaled) ----
  drawBackground(ctx: CanvasRenderingContext2D, wPx: number, hPx: number): void;
  drawObstacles(
    ctx: CanvasRenderingContext2D, world: MapWorld, px: number,
    dragged: MapObstacle | null,
  ): void;
  // Optional dynamic foreground drawn every frame after the obstacle layer
  // (the desktop's live clock). Omit for maps without one.
  drawForeground?(ctx: CanvasRenderingContext2D, world: MapWorld, px: number): void;

  // ---- Spawn + bounds ----
  // Spawn pose for a slot index (per-map layout). Non-overlapping for N.
  spawn(slot: number, world: MapWorld): SpawnPose;
  // Contain/wrap a car at the world edges. Mutates the car; returns true if it
  // teleported (so the caller can break the skid trail).
  wrap(car: CarState, world: MapWorld): boolean;

  // ---- Obstacle dragging (mouse "builds the track") ----
  // draggableObstacles=false ⇒ the map's obstacles are fixed (walls/barriers)
  // and the drag hooks are never called.
  draggableObstacles: boolean;
  obstacleAt?(world: MapWorld, xM: number, yM: number): MapObstacle | null;
  beginDragObstacle?(world: MapWorld, obs: MapObstacle, xM: number, yM: number): void;
  dragObstacleTo?(world: MapWorld, obs: MapObstacle, xM: number, yM: number): void;
  dropObstacle?(world: MapWorld, obs: MapObstacle): void;
}

// =============================================================================
//  Registry — id → MapDefinition. Pure (no DOM), so it's unit-testable.
// =============================================================================
const MAPS = new Map<string, MapDefinition>();

export function registerMap(def: MapDefinition): void {
  MAPS.set(def.id, def);
}
export function getMap(id: string): MapDefinition | undefined {
  return MAPS.get(id);
}
export function hasMap(id: string): boolean {
  return MAPS.has(id);
}
export function listMaps(): Array<{ id: string; name: string }> {
  return [...MAPS.values()].map((m) => ({ id: m.id, name: m.name }));
}

// =============================================================================
//  MAP 1 — the desktop. Wraps the existing world.ts implementation so the game
//  looks and behaves EXACTLY as before when this map is active.
// =============================================================================
// One drag at a time → a single grab offset kept here (so the icon doesn't jump
// to the cursor when picked up). Lives with the map that owns the drag.
let desktopDragOffset = { x: 0, y: 0 };

export const DEFAULT_MAP_ID = 'desktop';

export const desktopMap: MapDefinition = {
  id: 'desktop',
  name: 'Desktop',

  createWorld(widthM, heightM) {
    return layoutDesktop(widthM, heightM);
  },

  drawBackground(ctx, wPx, hPx) {
    drawWallpaper(ctx, wPx, hPx);
  },
  drawObstacles(ctx, world, px, dragged) {
    drawOverlay(ctx, world as DesktopWorld, px, (dragged as DesktopIcon) ?? null);
  },
  drawForeground(ctx, world, px) {
    drawClock(ctx, world as DesktopWorld, px);
  },

  // Centre of the world, with the per-slot non-overlapping offset (slot 0 dead
  // centre) — unchanged from the single-map behaviour.
  spawn(slot, world) {
    return spawnPose(slot, world.width / 2, world.height / 2);
  },

  // Wrap on left/right/top; the bottom edge is the taskbar wall (a collision
  // rect), so re-enter from just above it. Identical to the old desktop wrap.
  wrap(car, world) {
    const W = world.width, H = world.height, M = 2;
    let wrapped = false;
    if (car.x < -M) { car.x = W + M; wrapped = true; }
    else if (car.x > W + M) { car.x = -M; wrapped = true; }
    if (car.y < -M) {
      const taskbar = (world as DesktopWorld).taskbarHeight;
      car.y = H - taskbar - CONFIG.carCollisionRadius - 0.2;
      wrapped = true;
    }
    return wrapped;
  },

  draggableObstacles: true,
  obstacleAt(world, xM, yM) {
    return iconAt(world as DesktopWorld, xM, yM);
  },
  beginDragObstacle(_world, obs, xM, yM) {
    const ic = obs as DesktopIcon;
    desktopDragOffset = { x: xM - ic.x, y: yM - ic.y };
  },
  dragObstacleTo(world, obs, xM, yM) {
    const ic = obs as DesktopIcon;
    ic.x = xM - desktopDragOffset.x;
    ic.y = yM - desktopDragOffset.y;
    clampIconToBounds(world as DesktopWorld, ic);
    rebuildRects(world as DesktopWorld);   // collision updates live during drag
  },
  dropObstacle(world, obs) {
    resolveIconDrop(world as DesktopWorld, obs as DesktopIcon);
    rebuildRects(world as DesktopWorld);
  },
};

// =============================================================================
//  MAP 2 — flat-track dirt oval (90s short-track / Outrun vibe).
//
//  A warm-brown dirt oval ring (drivable) between a dark night infield and the
//  outside ground, bounded by tyre-wall barriers (FIXED — draggableObstacles:
//  false) tessellated into many small AABB rects so the arcade collision keeps
//  cars on the track. Decor (grandstands, neon ad banners, floodlights) is
//  non-collidable. Cars spawn in a 2-wide grid behind the start/finish line.
//
//  All geometry derives deterministically from the world size via computeOval()
//  so createWorld (rects/spawn) and drawBackground (which gets no world) agree.
// =============================================================================

// STADIUM oval (rounded rectangle): top & bottom STRAIGHTS joined by left & right
// SEMICIRCULAR turns. Wider than tall (classic short-track). The inner boundary
// is the outer offset inward by the band width — under such an offset the arc
// CENTRES (cx±sx, cy) and the straight half-length `sx` are preserved, only the
// turn radius shrinks (OYh → IYh). The drivable dirt band is everything between.
interface StadiumGeom {
  cx: number; cy: number;
  sx: number;     // straight half-length (shared by inner & outer)
  OYh: number;    // outer half-height = outer turn radius
  IYh: number;    // inner half-height = inner turn radius (infield)
  bandW: number;  // track width = OYh - IYh
}
interface FlatWorld extends MapWorld { geom: StadiumGeom; }

function computeStadium(wM: number, hM: number): StadiumGeom {
  const cx = wM / 2, cy = hM / 2;
  const OXw = wM / 2 - wM * 0.05;        // outer half-width
  const OYh = hM / 2 - hM * 0.07;        // outer half-height = turn radius
  const sx = Math.max(2, OXw - OYh);     // straight half-length (landscape ⇒ > 0)
  // Generous, car-friendly band, ~33% WIDER than before — the OUTER edge (OYh)
  // stays put (grandstands have no room outside) and the band grows INWARD, so
  // the inner edge moves toward the centre and the green infield shrinks.
  // (×4/3 widening; capped so a sliver of infield always remains.)
  const bandW = Math.min(Math.max(OYh * 0.5, 3.2) * (4 / 3), Math.max(1.0, OYh - 0.6));
  return { cx, cy, sx, OYh, IYh: OYh - bandW, bandW };
}

// Trace a stadium outline (sx, Yh) in the ctx's current units; arc centres at
// (cx±sx, cy). Used for the dirt fill, grooves, and the neon barrier strokes.
function stadiumPath(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, sx: number, Yh: number,
) {
  ctx.beginPath();
  ctx.moveTo(cx - sx, cy - Yh);
  ctx.lineTo(cx + sx, cy - Yh);
  ctx.arc(cx + sx, cy, Yh, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(cx - sx, cy + Yh);
  ctx.arc(cx - sx, cy, Yh, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
}

// Barriers hug ONLY the inner + outer edges — the dirt band between is left
// completely rect-free so a car can drive it freely. Straights = one thin AABB
// each; turns = small overlapping squares pushed strictly OUTSIDE the outer
// radius / INSIDE the inner radius (so they never intrude onto the band).
function stadiumBarriers(g: StadiumGeom): ObstacleRect[] {
  const { cx, cy, sx, OYh, IYh } = g;
  const sq = Math.max(1.0, g.bandW * 0.16);   // wall thickness
  const ext = sq;                              // straight↔turn overlap
  const rects: ObstacleRect[] = [
    { x: cx - sx - ext, y: cy - OYh - sq, w: 2 * sx + 2 * ext, h: sq }, // outer top
    { x: cx - sx - ext, y: cy + OYh,      w: 2 * sx + 2 * ext, h: sq }, // outer bottom
    { x: cx - sx - ext, y: cy - IYh,      w: 2 * sx + 2 * ext, h: sq }, // inner top
    { x: cx - sx - ext, y: cy + IYh - sq, w: 2 * sx + 2 * ext, h: sq }, // inner bottom
  ];
  const arc = (ccx: number, ccy: number, R: number, a0: number, a1: number, side: number) => {
    const Rc = R + side * sq * 0.72;      // square corners stay clear of radius R
    const pad = 0.14;                      // overrun to meet the straight walls
    const span = a1 - a0 + pad * 2;
    const n = Math.max(6, Math.ceil((R * span) / (sq * 0.5)));
    for (let i = 0; i <= n; i++) {
      const t = a0 - pad + span * (i / n);
      rects.push({
        x: ccx + Rc * Math.cos(t) - sq / 2,
        y: ccy + Rc * Math.sin(t) - sq / 2,
        w: sq, h: sq,
      });
    }
  };
  arc(cx + sx, cy, OYh, -Math.PI / 2, Math.PI / 2, +1);    // outer right turn
  arc(cx - sx, cy, OYh, Math.PI / 2, Math.PI * 1.5, +1);   // outer left turn
  arc(cx + sx, cy, IYh, -Math.PI / 2, Math.PI / 2, -1);    // inner right turn
  arc(cx - sx, cy, IYh, Math.PI / 2, Math.PI * 1.5, -1);   // inner left turn
  return rects;
}

// Stable pseudo-random in [0,1) for deterministic crowd dots (no per-frame
// flicker — these are drawn to the static overlay, but keep them stable anyway).
function fhash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
function frr(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
) {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}

// Spectator colours for the grandstand crowd dots. (No ads anywhere yet — real
// ad surfaces will be added later beside the grandstands and in the infield.)
const CROWD = ['#ff6b6b', '#ffe23d', '#2de2e6', '#ff8a3d', '#b15cff', '#e8ecf4'];

// Neon tyre-wall along a stadium outline (sx, Yh): a dark base + offset
// magenta/cyan dashes (the retro armco look).
function drawStadiumWall(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, sx: number, Yh: number,
  thickness: number,
) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = thickness;
  ctx.strokeStyle = '#0e1116';
  stadiumPath(ctx, cx, cy, sx, Yh); ctx.stroke();
  ctx.lineWidth = Math.max(2, thickness * 0.32);
  ctx.setLineDash([14, 11]);
  ctx.strokeStyle = 'rgba(255,45,149,0.8)';
  stadiumPath(ctx, cx, cy, sx, Yh); ctx.stroke();
  ctx.lineDashOffset = 12.5;
  ctx.strokeStyle = 'rgba(45,226,230,0.7)';
  stadiumPath(ctx, cx, cy, sx, Yh); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawStand(
  ctx: CanvasRenderingContext2D, x: number, y: number, angle: number,
  w: number, h: number,
) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  // Trapezoid block (rises AWAY from the track = local -y).
  ctx.fillStyle = '#2a2440';
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0);
  ctx.lineTo(w * 0.58, -h); ctx.lineTo(-w * 0.58, -h);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(45,226,230,0.45)'; ctx.lineWidth = 2; ctx.stroke();
  // Crowd dots (stable jitter/colour per seat).
  const cols = Math.max(3, Math.floor(w / 7));
  const rows = Math.max(2, Math.floor(h / 7));
  for (let r = 0; r < rows; r++) {
    for (let cc = 0; cc < cols; cc++) {
      const k = r * cols + cc;
      ctx.fillStyle = CROWD[k % CROWD.length];
      const dx = -w / 2 + 5 + cc * 7 + (fhash(k) - 0.5) * 2.5;
      const dy = -7 - r * 7;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(dx, dy, 1.7, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawFloodlight(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.strokeStyle = '#3a3a48'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 28); ctx.stroke();
  ctx.fillStyle = '#fdf6c8';
  ctx.shadowColor = 'rgba(255,245,180,0.9)'; ctx.shadowBlur = 16;
  frr(ctx, x - 9, y - 37, 18, 9, 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

export const flatTrackMap: MapDefinition = {
  id: 'flat',
  name: 'Flat Track',

  // Dirt surface → warm brown/tan DUST instead of white rubber smoke.
  smokeColor: [170, 126, 84],

  createWorld(widthM, heightM) {
    const g = computeStadium(widthM, heightM);
    // Barriers ONLY on the inner + outer edges; the band between is rect-free.
    const world: FlatWorld = {
      width: widthM, height: heightM, rects: stadiumBarriers(g), geom: g,
    };
    return world;
  },

  // Surface layer (UNDER the skids): night ground, dirt band, racing-line
  // grooves, infield, start/finish stripe. Recomputed from the pixel size.
  drawBackground(ctx, wPx, hPx) {
    const px = CONFIG.pxPerMeter;
    const g = computeStadium(wPx / px, hPx / px);
    const cx = g.cx * px, cy = g.cy * px, sx = g.sx * px;
    const OYh = g.OYh * px, IYh = g.IYh * px, midYh = (OYh + IYh) / 2;

    const bg = ctx.createLinearGradient(0, 0, 0, hPx);
    bg.addColorStop(0, '#241a33'); bg.addColorStop(1, '#130d1d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, wPx, hPx);

    // Dirt band (warm brown) — fill the outer stadium.
    const dirt = ctx.createRadialGradient(cx, cy, IYh, cx, cy, sx + OYh);
    dirt.addColorStop(0, '#8a5226'); dirt.addColorStop(1, '#693d1b');
    ctx.fillStyle = dirt;
    stadiumPath(ctx, cx, cy, sx, OYh); ctx.fill();

    // Worn racing line (lighter band at mid) + faint grooves.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(176,124,72,0.45)';
    ctx.lineWidth = (OYh - IYh) * 0.32;
    stadiumPath(ctx, cx, cy, sx, midYh); ctx.stroke();
    ctx.strokeStyle = 'rgba(80,48,22,0.5)'; ctx.lineWidth = 2;
    for (const f of [0.72, 0.5, 0.28]) {
      stadiumPath(ctx, cx, cy, sx, IYh + (OYh - IYh) * f); ctx.stroke();
    }

    // Infield — carve the dark-green centre (inner stadium).
    const inf = ctx.createLinearGradient(0, cy - IYh, 0, cy + IYh);
    inf.addColorStop(0, '#22382b'); inf.addColorStop(1, '#192c21');
    ctx.fillStyle = inf;
    stadiumPath(ctx, cx, cy, sx, IYh); ctx.fill();

    // Start/finish — checkered stripe across the bottom straight (x = cx).
    const yTop = cy + IYh, yBot = cy + OYh, segs = 9;
    const segH = (yBot - yTop) / segs, lw = 1.2 * px;
    for (let i = 0; i < segs; i++) {
      ctx.fillStyle = i % 2 ? '#0c0c0c' : '#eef0f2';
      ctx.fillRect(cx - lw / 2, yTop + i * segH, lw, segH);
    }
  },

  // Decor + barriers (ABOVE the skids). NO ads/banners — grandstands hold
  // spectators only; real ad surfaces come later (beside the stands + infield).
  drawObstacles(ctx, world, px, _dragged) {
    const g = (world as FlatWorld).geom;
    const cx = g.cx * px, cy = g.cy * px, sx = g.sx * px;
    const OYh = g.OYh * px, IYh = g.IYh * px;
    const barrierPx = Math.max(3, g.bandW * px * 0.16);

    // Grandstands (crowd only): along the top straight + behind each turn.
    const standH = Math.min(48, OYh * 0.36);
    drawStand(ctx, cx, cy - OYh - 7, 0, sx * 2 + OYh, standH);
    drawStand(ctx, cx - sx - OYh - 7, cy, -Math.PI / 2, OYh * 1.6, standH);
    drawStand(ctx, cx + sx + OYh + 7, cy, Math.PI / 2, OYh * 1.6, standH);

    // Floodlights at the four outside corners.
    for (const [gx, gy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      drawFloodlight(ctx, cx + gx * (sx + OYh * 0.55), cy + gy * (OYh + 9));
    }

    // Barriers (tyre walls) on the inner + outer edges — match the collision.
    drawStadiumWall(ctx, cx, cy, sx, OYh, barrierPx);
    drawStadiumWall(ctx, cx, cy, sx, IYh, barrierPx);
  },

  // Grid spawn: 2-wide, lined up behind the start line (x = cx) on the bottom
  // straight, facing +x (along the track). Non-overlapping for N.
  spawn(slot, world) {
    const g = (world as FlatWorld).geom;
    const inner = g.cy + g.IYh, outer = g.cy + g.OYh;
    const lane0 = inner + (outer - inner) * 0.34;
    const lane1 = inner + (outer - inner) * 0.66;
    const col = slot % 2, row = Math.floor(slot / 2);
    return { x: g.cx - 1.5 - row * 2.6, y: col === 0 ? lane0 : lane1, heading: 0 };
  },

  // Closed track: the barriers do the real containment. wrap() just clamps a
  // car that somehow escaped the world rect (no torus wrap). true = teleported.
  wrap(car, world) {
    const m = 0.5;
    let clamped = false;
    if (car.x < m) { car.x = m; car.vx = 0; clamped = true; }
    else if (car.x > world.width - m) { car.x = world.width - m; car.vx = 0; clamped = true; }
    if (car.y < m) { car.y = m; car.vy = 0; clamped = true; }
    else if (car.y > world.height - m) { car.y = world.height - m; car.vy = 0; clamped = true; }
    return clamped;
  },

  draggableObstacles: false,   // fixed walls — the drag hooks are never called
};

// Register the built-in maps. The desktop is FIRST (the default).
registerMap(desktopMap);
registerMap(flatTrackMap);
