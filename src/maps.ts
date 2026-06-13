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

interface OvalGeom {
  cx: number; cy: number;          // centre (metres)
  outerRx: number; outerRy: number;
  innerRx: number; innerRy: number;
  trackW: number;                  // dirt band width (metres)
}
interface FlatWorld extends MapWorld { geom: OvalGeom; }

function computeOval(wM: number, hM: number): OvalGeom {
  const cx = wM / 2, cy = hM / 2;
  const outerRx = wM / 2 - wM * 0.07;
  const outerRy = hM / 2 - hM * 0.08;
  const trackW = Math.min(outerRx, outerRy) * 0.36;   // dirt band width
  return {
    cx, cy, outerRx, outerRy,
    innerRx: Math.max(2, outerRx - trackW),
    innerRy: Math.max(2, outerRy - trackW),
    trackW,
  };
}

// Tessellate an ellipse perimeter into overlapping AABB squares (a curved wall
// the box-collision can handle). Squares are auto-sized to the widest sample
// gap × 1.5 so there are never holes a car could slip through.
function ellipseRects(
  cx: number, cy: number, rx: number, ry: number, minSize: number,
): ObstacleRect[] {
  const h = ((rx - ry) ** 2) / ((rx + ry) ** 2);
  const perim = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  const n = Math.max(24, Math.ceil(perim / 1.4));
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  let maxGap = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    maxGap = Math.max(maxGap, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  const s = Math.max(minSize, maxGap * 1.5);
  return pts.map(([x, y]) => ({ x: x - s / 2, y: y - s / 2, w: s, h: s }));
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

// On-brand placeholder ads (fake brands / jokes, like the desktop's folder
// names). A real ad system comes later.
const FLAT_ADS = [
  'DEFRAG ENERGY', 'BSOD INSURANCE', '404 TIRES', 'CTRL+ALT+DEFEAT',
  'NULL-POINTER OIL', 'YE OLDE DIAL-UP', 'SUS MOTORS', 'RANSOMWARE RACING',
  'CLIPPY OIL CO', 'TURBO.EXE', 'Y2K-READY FUEL', 'BIGCORP™',
];
const BANNER_COLORS = ['#2de2e6', '#ff2d95', '#ff8a3d', '#39ff6a'];
const CROWD = ['#ff6b6b', '#ffe23d', '#2de2e6', '#ff8a3d', '#b15cff', '#e8ecf4'];

function drawBanner(
  ctx: CanvasRenderingContext2D, x: number, y: number, angle: number,
  w: number, h: number, text: string, color: string,
) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = '#0d1020'; frr(ctx, -w / 2, -h / 2, w, h, 4); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 2.5;
  ctx.shadowColor = color; ctx.shadowBlur = 9; ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.font = `700 ${Math.min(h * 0.46, 14).toFixed(1)}px Orbitron, ui-monospace, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 1);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function drawBarrier(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number,
  thickness: number,
) {
  ctx.save();
  // Tyre wall base.
  ctx.lineWidth = thickness;
  ctx.strokeStyle = '#0e1116';
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  // Neon armco accents (magenta + cyan dashes offset against each other).
  ctx.lineWidth = Math.max(2, thickness * 0.32);
  ctx.setLineDash([14, 11]);
  ctx.strokeStyle = 'rgba(255,45,149,0.8)';
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.lineDashOffset = 12.5;
  ctx.strokeStyle = 'rgba(45,226,230,0.7)';
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
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

  createWorld(widthM, heightM) {
    const g = computeOval(widthM, heightM);
    // Barriers on the OUTER edge (push cars in) and INNER edge (push cars out).
    const rects = [
      ...ellipseRects(g.cx, g.cy, g.outerRx, g.outerRy, 1.2),
      ...ellipseRects(g.cx, g.cy, g.innerRx, g.innerRy, 1.2),
    ];
    const world: FlatWorld = { width: widthM, height: heightM, rects, geom: g };
    return world;
  },

  // Surface layer (UNDER the skids): night ground, dirt ring, racing-line
  // grooves, infield, start/finish stripe. Recomputed from the pixel size.
  drawBackground(ctx, wPx, hPx) {
    const px = CONFIG.pxPerMeter;
    const g = computeOval(wPx / px, hPx / px);
    const cx = g.cx * px, cy = g.cy * px;
    const oRx = g.outerRx * px, oRy = g.outerRy * px;
    const iRx = g.innerRx * px, iRy = g.innerRy * px;

    const bg = ctx.createLinearGradient(0, 0, 0, hPx);
    bg.addColorStop(0, '#241a33'); bg.addColorStop(1, '#130d1d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, wPx, hPx);

    // Dirt ring (warm brown radial).
    const dirt = ctx.createRadialGradient(cx, cy, Math.min(iRx, iRy), cx, cy, Math.max(oRx, oRy));
    dirt.addColorStop(0, '#8a5226'); dirt.addColorStop(1, '#693d1b');
    ctx.fillStyle = dirt;
    ctx.beginPath(); ctx.ellipse(cx, cy, oRx, oRy, 0, 0, Math.PI * 2); ctx.fill();

    // Worn racing line (lighter band at mid radius) + faint grooves.
    ctx.strokeStyle = 'rgba(176,124,72,0.45)';
    ctx.lineWidth = (oRx - iRx) * 0.32;
    ctx.beginPath();
    ctx.ellipse(cx, cy, (oRx + iRx) / 2, (oRy + iRy) / 2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(80,48,22,0.5)'; ctx.lineWidth = 2;
    for (const f of [0.72, 0.5, 0.28]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, iRx + (oRx - iRx) * f, iRy + (oRy - iRy) * f, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Infield (carve the dark-green centre).
    const inf = ctx.createLinearGradient(0, cy - iRy, 0, cy + iRy);
    inf.addColorStop(0, '#22382b'); inf.addColorStop(1, '#192c21');
    ctx.fillStyle = inf;
    ctx.beginPath(); ctx.ellipse(cx, cy, iRx, iRy, 0, 0, Math.PI * 2); ctx.fill();

    // Start/finish — checkered stripe across the bottom straight (x = cx).
    const yTop = cy + iRy, yBot = cy + oRy, segs = 9;
    const segH = (yBot - yTop) / segs, lw = 1.2 * px;
    for (let i = 0; i < segs; i++) {
      ctx.fillStyle = i % 2 ? '#0c0c0c' : '#eef0f2';
      ctx.fillRect(cx - lw / 2, yTop + i * segH, lw, segH);
    }
  },

  // Decor + barriers (ABOVE the skids).
  drawObstacles(ctx, world, px, _dragged) {
    const g = (world as FlatWorld).geom;
    const cx = g.cx * px, cy = g.cy * px;
    const oRx = g.outerRx * px, oRy = g.outerRy * px;
    const iRx = g.innerRx * px, iRy = g.innerRy * px;
    const barrierPx = g.trackW * px * 0.14;

    // Grandstands outside (top, left, right) — rise away from the track.
    const standH = Math.min(46, oRy * 0.3);
    drawStand(ctx, cx, cy - oRy - 6, 0, oRx * 0.9, standH);
    drawStand(ctx, cx - oRx - 6, cy, -Math.PI / 2, oRy * 0.9, standH);
    drawStand(ctx, cx + oRx + 6, cy, Math.PI / 2, oRy * 0.9, standH);

    // Floodlights at the four diagonal corners.
    for (const d of [-45, 45, 135, 225]) {
      const t = (d * Math.PI) / 180;
      drawFloodlight(ctx, cx + (oRx + 14) * Math.cos(t), cy + (oRy + 14) * Math.sin(t));
    }

    // Trackside ad banners around the outside (skip the bottom start area).
    const angles = [-62, -22, 22, 62, 118, 158, 202, 242];
    angles.forEach((deg, i) => {
      const t = (deg * Math.PI) / 180;
      const ex = cx + (oRx + barrierPx + 10) * Math.cos(t);
      const ey = cy + (oRy + barrierPx + 10) * Math.sin(t);
      // Tangent to the ellipse, normalised to [-90°,90°] so text never reads
      // upside-down on the lower half of the oval.
      let tang = Math.atan2(oRy * Math.cos(t), -oRx * Math.sin(t));
      if (tang > Math.PI / 2) tang -= Math.PI;
      else if (tang < -Math.PI / 2) tang += Math.PI;
      drawBanner(ctx, ex, ey, tang, Math.min(oRx, oRy) * 0.5, 26,
        FLAT_ADS[i % FLAT_ADS.length], BANNER_COLORS[i % BANNER_COLORS.length]);
    });

    // Barriers (tyre walls) on the inner + outer edges — match the collision.
    drawBarrier(ctx, cx, cy, oRx, oRy, barrierPx);
    drawBarrier(ctx, cx, cy, iRx, iRy, barrierPx);

    // Prominent infield banners (the headline ad space).
    drawBanner(ctx, cx, cy, 0, iRx * 1.05, 34, 'STEER IT SPEEDWAY', '#ff8a3d');
    drawBanner(ctx, cx, cy - iRy * 0.5, 0, iRx * 0.62, 24, 'DRIFT KING 9000', '#2de2e6');
    drawBanner(ctx, cx, cy + iRy * 0.5, 0, iRx * 0.62, 24, 'PIXELCO RACING', '#ff2d95');
  },

  // Grid spawn: 2-wide, lined up behind the start line (x = cx) on the bottom
  // straight, facing +x (along the track). Non-overlapping for N.
  spawn(slot, world) {
    const g = (world as FlatWorld).geom;
    const inner = g.cy + g.innerRy, outer = g.cy + g.outerRy;
    const lane0 = inner + (outer - inner) * 0.34;
    const lane1 = inner + (outer - inner) * 0.66;
    const col = slot % 2, row = Math.floor(slot / 2);
    return { x: g.cx - 1.5 - row * 3.0, y: col === 0 ? lane0 : lane1, heading: 0 };
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
