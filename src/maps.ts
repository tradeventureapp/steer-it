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
import type { RaceElement } from './race';
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

// 'open'    — a free surface; the full place-elements editor builds the track
//             (start/finish/checkpoints), e.g. the desktop.
// 'circuit' — a bounded loop with a BUILT-IN start/finish line; the editor shows
//             only a LAPS panel (0 = free-roam, N = N-lap race), e.g. the oval.
export type TrackType = 'open' | 'circuit';

export interface MapDefinition {
  id: string;
  name: string;
  trackType: TrackType;

  // Circuit maps only: the built-in start/finish line as a race START element
  // (acts as start AND finish in circuit mode). Open maps omit it.
  startLine?(world: MapWorld): RaceElement;

  // Optional tire-smoke/dust tint [r,g,b] for this surface. Omitted ⇒ the
  // default whitish rubber smoke (the desktop). The dirt oval, say, kicks up
  // brown dust. Only the COLOUR changes — emission/cap/growth/fade are shared.
  smokeColor?: [number, number, number];

  // FIXED logical world size (METRES). When set, the map is ALWAYS built at this
  // exact size regardless of the window, and rendered with a SINGLE UNIFORM scale
  // that fits it into the viewport (letterbox/pillarbox) — so its shape never
  // deforms and a lap is the same effort at any window size. When omitted, the
  // world is sized to the viewport (the desktop, which fills the screen + wraps).
  fixedWorld?: { widthM: number; heightM: number };

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
  trackType: 'open',   // free surface → full place-elements editor

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
//  STADIUM OVALS — a family of 90s short-track / Outrun-vibe maps that share
//  ONE geometry + decor source of truth (the builders below + the makeStadiumMap
//  factory) and differ ONLY in the racing-ring surface + smoke colour:
//    • flatTrackMap    (id 'flat')    — warm-brown DIRT ring, brown dust
//    • asphaltTrackMap (id 'asphalt') — dark tarmac ASPHALT ring, white smoke
//
//  An oval ring (drivable) sits between a dark night infield and the outside
//  ground, bounded by tyre-wall barriers (FIXED — draggableObstacles: false)
//  tessellated into many small AABB rects so the arcade collision keeps cars on
//  the track. Decor (grandstands, floodlights) is non-collidable. Cars spawn in
//  a 2-wide grid behind the start/finish line.
//
//  All geometry derives deterministically from the world size via
//  computeStadium() so createWorld (rects/spawn) and drawBackground (which gets
//  no world) agree, and every map built by the factory is mathematically
//  identical except for the surface visuals. NO per-map physics/grip override.
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

// A floodlight pole + lamp head. `dir` is the OUTWARD vertical direction (away
// from the track): -1 for the TOP row (pole rises up, lamp above → shines down
// onto the track), +1 for the BOTTOM row (mirrored: pole drops down, lamp below
// → shines up onto the track). So every lamp faces inward at the racing surface.
function drawFloodlight(ctx: CanvasRenderingContext2D, x: number, y: number, dir: number) {
  const tip = y + dir * 28;             // pole tip (outer end)
  const boxY = dir < 0 ? tip - 9 : tip; // lamp head sits at the outer end
  ctx.save();
  ctx.strokeStyle = '#3a3a48'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, tip); ctx.stroke();
  ctx.fillStyle = '#fdf6c8';
  ctx.shadowColor = 'rgba(255,245,180,0.9)'; ctx.shadowBlur = 16;
  frr(ctx, x - 9, boxY, 18, 9, 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

// FIXED logical world for the oval — sized to the ACTUAL fullscreen (the screen's
// CSS resolution), NOT a hardcoded 1920×1080. This is the fix for "car too small
// relative to the oval": the world is what the oval filled BEFORE the scaling
// work (the viewport at fullscreen), so AT FULLSCREEN viewScale ≈ 1 → the oval
// fills the screen and the car renders at its ORIGINAL on-screen size — exactly
// the pre-scaling tuned look the drift was built on. A smaller window then
// uniformly scales the WHOLE scene (oval + car together) down to fit (letterbox/
// pillarbox, never crop, never squash), so the car-to-oval RATIO stays constant
// and equals the original fullscreen ratio on ANY display / OS-scaling, with no
// per-machine tuning. (A 1920 panel at 125% Windows scaling reports 1536 CSS px,
// which is why a hardcoded 1920 made the fixed oval ~25% too big → car ~80%.)
// computeStadium() builds the oval from whatever size this is, so the wide
// stadium shape is preserved. Falls back to 1920×1080 off-DOM (unit tests).
const SCREEN_W = (typeof window !== 'undefined' && window.screen?.width)  || 1920;
const SCREEN_H = (typeof window !== 'undefined' && window.screen?.height) || 1080;
const FLAT_LOGICAL = {
  widthM:  SCREEN_W / CONFIG.pxPerMeter,
  heightM: SCREEN_H / CONFIG.pxPerMeter,
};

// ---- Racing-ring SURFACE styles -----------------------------------------------
// The ONE thing that differs between the stadium twins: the ring fill + groove
// tints (and, paired with it, the smoke colour, which lives on the map). The
// DIRT style is the original warm-brown look (unchanged); the ASPHALT style is
// clean dark tarmac grey with a subtle rubbered-in racing line — NO lane
// markings, NO kerbs. Everything else (night ground, infield, start/finish
// stripe, geometry, barriers, decor) is identical, so the rings can never
// diverge. Per-surface GRIP is NOT here — that comes later, on the dirt side;
// asphalt is the grippy baseline and inherits the locked physics tune as-is.
export type TrackSurfaceStyle = 'dirt' | 'asphalt';
interface SurfaceStyle {
  ringInner: string;    // racing-ring radial gradient — inner stop
  ringOuter: string;    // racing-ring radial gradient — outer stop
  lineStroke: string;   // worn racing-line band at mid radius
  grooveStroke: string; // faint concentric surface grooves
}
const SURFACE_STYLES: Record<TrackSurfaceStyle, SurfaceStyle> = {
  dirt: {
    ringInner: '#8a5226', ringOuter: '#693d1b',
    lineStroke: 'rgba(176,124,72,0.45)',
    grooveStroke: 'rgba(80,48,22,0.5)',
  },
  asphalt: {
    // Dark tarmac grey; the "worn line" reads as a faint rubbered-in darker
    // band rather than a lighter dirt groove. Subtle texture only.
    ringInner: '#3b3e44', ringOuter: '#2a2c31',
    lineStroke: 'rgba(24,26,30,0.38)',
    grooveStroke: 'rgba(18,19,22,0.5)',
  },
};

// Surface layer (UNDER the skids): night ground, racing ring (style-tinted),
// racing-line grooves, infield, start/finish stripe. Recomputed from the pixel
// size. SHARED by every stadium map — only the `style` fill/tint differs, so the
// dirt and asphalt rings are guaranteed to be the same shape down to the pixel.
function drawStadiumSurface(
  ctx: CanvasRenderingContext2D, wPx: number, hPx: number, style: TrackSurfaceStyle,
) {
  const s = SURFACE_STYLES[style];
  const px = CONFIG.pxPerMeter;
  const g = computeStadium(wPx / px, hPx / px);
  const cx = g.cx * px, cy = g.cy * px, sx = g.sx * px;
  const OYh = g.OYh * px, IYh = g.IYh * px, midYh = (OYh + IYh) / 2;

  const bg = ctx.createLinearGradient(0, 0, 0, hPx);
  bg.addColorStop(0, '#241a33'); bg.addColorStop(1, '#130d1d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, wPx, hPx);

  // Racing ring — fill the outer stadium with the surface gradient.
  const ring = ctx.createRadialGradient(cx, cy, IYh, cx, cy, sx + OYh);
  ring.addColorStop(0, s.ringInner); ring.addColorStop(1, s.ringOuter);
  ctx.fillStyle = ring;
  stadiumPath(ctx, cx, cy, sx, OYh); ctx.fill();

  // Worn racing line (band at mid) + faint grooves.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.lineStroke;
  ctx.lineWidth = (OYh - IYh) * 0.32;
  stadiumPath(ctx, cx, cy, sx, midYh); ctx.stroke();
  ctx.strokeStyle = s.grooveStroke; ctx.lineWidth = 2;
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
}

// Decor + barriers (ABOVE the skids): grandstands (crowd only), floodlights,
// tyre walls. SHARED by every stadium map — identical for dirt and asphalt. NO
// ads/banners; real ad surfaces come later (beside the stands + infield).
function drawStadiumDecor(ctx: CanvasRenderingContext2D, world: MapWorld, px: number) {
  const g = (world as FlatWorld).geom;
  const cx = g.cx * px, cy = g.cy * px, sx = g.sx * px;
  const OYh = g.OYh * px, IYh = g.IYh * px;
  const barrierPx = Math.max(3, g.bandW * px * 0.16);

  // Grandstands (crowd only): along the top straight + behind each turn.
  // ~20% SHORTER than the track span (the 0.8 factor) so the corners stay open
  // for ad billboards later.
  const standH = Math.min(48, OYh * 0.36);
  drawStand(ctx, cx, cy - OYh - 7, 0, (sx * 2 + OYh) * 0.8, standH);
  drawStand(ctx, cx - sx - OYh - 7, cy, -Math.PI / 2, OYh * 1.6 * 0.8, standH);
  drawStand(ctx, cx + sx + OYh + 7, cy, Math.PI / 2, OYh * 1.6 * 0.8, standH);

  // Floodlights at the four outside corners. `gy` is the outward direction, so
  // top lights (gy=-1) face down onto the track and bottom lights (gy=+1) are
  // MIRRORED to face up onto it — every lamp points inward at the surface.
  for (const [gx, gy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    drawFloodlight(ctx, cx + gx * (sx + OYh * 0.55), cy + gy * (OYh + 9), gy);
  }

  // Barriers (tyre walls) on the inner + outer edges — match the collision.
  drawStadiumWall(ctx, cx, cy, sx, OYh, barrierPx);
  drawStadiumWall(ctx, cx, cy, sx, IYh, barrierPx);
}

// =============================================================================
//  Stadium-map FACTORY. Every stadium oval (the dirt original + the asphalt
//  twin, and any future surface) is built here, so they share ONE source of
//  truth for geometry, barriers, spawn grid, bounds, fixedWorld scaling,
//  start/finish line, and decor. The ONLY per-map inputs are id/name, the
//  racing-ring surface STYLE, and the smoke colour — i.e. visuals only. NO
//  physics/grip override is taken or applied: every stadium map inherits the
//  single locked physics tune identically (per-surface grip comes later).
// =============================================================================
function makeStadiumMap(opts: {
  id: string;
  name: string;
  surface: TrackSurfaceStyle;
  smokeColor: [number, number, number];
}): MapDefinition {
  return {
    id: opts.id,
    name: opts.name,
    trackType: 'circuit',   // bounded oval → laps-only editor; built-in start line

    smokeColor: opts.smokeColor,

    // Fixed-shape world: built at FLAT_LOGICAL metres regardless of the window
    // and rendered with a uniform scale-to-fit, so the oval never squashes.
    fixedWorld: FLAT_LOGICAL,

    // Built-in start/finish: a START gate centred on the checkered line across
    // the bottom straight (x = cx), with a trigger spanning the band so a car
    // always trips it. In circuit mode this single gate is start AND finish.
    startLine(world) {
      const g = (world as FlatWorld).geom;
      const mid = (g.IYh + g.OYh) / 2;   // band centre radius
      return {
        type: 'start',
        x: g.cx,
        y: g.cy + mid,                   // band centre on the BOTTOM straight
        radius: g.bandW / 2,             // covers the band width
        angle: Math.PI / 2,              // vertical (across the straight)
        // Cars race +x across the bottom straight (spawn heading 0). Only a
        // +x crossing counts; reversing (−x) over the line does not.
        forward: 0,
        // Far point = the TOP straight (opposite side of the oval). The lap arms
        // only once the car gets near there, so back-and-forth / tiny circles at
        // the start line never complete a lap. Generous radius (one band width).
        farX: g.cx,
        farY: g.cy - mid,
        farRadius: g.bandW,
      };
    },

    createWorld(widthM, heightM) {
      const g = computeStadium(widthM, heightM);
      // Barriers ONLY on the inner + outer edges; the band between is rect-free.
      const world: FlatWorld = {
        width: widthM, height: heightM, rects: stadiumBarriers(g), geom: g,
      };
      return world;
    },

    drawBackground(ctx, wPx, hPx) {
      drawStadiumSurface(ctx, wPx, hPx, opts.surface);
    },

    drawObstacles(ctx, world, px, _dragged) {
      drawStadiumDecor(ctx, world, px);
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
}

// MAP 2 — the original DIRT stadium oval (warm brown ring, brown DUST smoke).
export const flatTrackMap: MapDefinition = makeStadiumMap({
  id: 'flat',
  name: 'Flat Track',
  surface: 'dirt',
  smokeColor: [170, 126, 84],   // warm brown/tan dust
});

// MAP 3 — the ASPHALT twin: byte-for-byte the same stadium (geometry, barriers,
// spawn, bounds, decor) via the shared factory, differing ONLY in the ring
// surface (dark tarmac grey) and the smoke (white rubber). No physics override —
// it inherits the locked tune exactly; per-surface grip is deferred to the dirt
// side. A hover/asphalt↔dirt toggle is deferred — for now it's its own tile.
export const asphaltTrackMap: MapDefinition = makeStadiumMap({
  id: 'asphalt',
  name: 'Asphalt Oval',
  surface: 'asphalt',
  smokeColor: [248, 248, 251], // white rubber smoke (the default tyre-smoke tint)
});

// Register the built-in maps. The desktop is FIRST (the default).
registerMap(desktopMap);
registerMap(flatTrackMap);
registerMap(asphaltTrackMap);
