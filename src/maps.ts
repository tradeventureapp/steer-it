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

// Optional map-select GROUPING. Maps that share a `surfaceGroup.key` collapse
// into a SINGLE select tile (titled `title`) with an in-tile surface switcher;
// each member contributes one switcher option (`option`, shown in `order`), and
// the member flagged `isDefault` is the initially-selected surface. This is
// PURELY a map-select presentation concern — every member stays independently
// registered and is resolved by its own id at launch / in multiplayer.
export interface SurfaceGroup {
  key: string;        // shared key — members with the same key share one tile
  title: string;      // the merged tile's label (e.g. "Stadium Oval")
  option: string;     // this member's switcher label (e.g. "Asphalt")
  order: number;      // switcher order (ascending; lowest = leftmost)
  isDefault?: boolean; // this member is the group's default-selected surface
}

export interface MapDefinition {
  id: string;
  name: string;
  trackType: TrackType;

  // See SurfaceGroup — optional map-select grouping metadata (presentation only).
  surfaceGroup?: SurfaceGroup;

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

  // FOLLOW-CAMERA world. When true, the world may be BIGGER than the viewport and
  // is NOT scaled to fit — it is rendered at the SAME scale as the oval (so the car
  // is pixel-for-pixel the STANDARD size on every map), and a camera scrolls to
  // keep the lead car centred. The car size is a constant; the world is the thing
  // that's bigger than one screen. Requires fixedWorld (the world's true metres).
  followCam?: boolean;

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
    const W = world.width, H = world.height, M = CONFIG.wheelbase * 2.31;  // ≈ 5.9 m
    let wrapped = false;
    if (car.x < -M) { car.x = W + M; wrapped = true; }
    else if (car.x > W + M) { car.x = -M; wrapped = true; }
    if (car.y < -M) {
      const taskbar = (world as DesktopWorld).taskbarHeight;
      car.y = H - taskbar - CONFIG.carCollisionRadius - CONFIG.wheelbase * 0.23;
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
  const sx = Math.max(5.9, OXw - OYh);   // straight half-length (landscape ⇒ > 0); floor in real m
  // Generous, car-friendly band, ~33% WIDER than before — the OUTER edge (OYh)
  // stays put (grandstands have no room outside) and the band grows INWARD, so
  // the inner edge moves toward the centre and the green infield shrinks.
  // (×4/3 widening; capped so a sliver of infield always remains.)
  const bandW = Math.min(Math.max(OYh * 0.5, 9.5) * (4 / 3), Math.max(3.0, OYh - 1.8));
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
  const sq = Math.max(3.0, g.bandW * 0.16);   // wall thickness (floor in real m)
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
  surfaceGroup?: SurfaceGroup;
}): MapDefinition {
  return {
    id: opts.id,
    name: opts.name,
    trackType: 'circuit',   // bounded oval → laps-only editor; built-in start line

    surfaceGroup: opts.surfaceGroup,

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
      // Grid spacing BOUND to the wheelbase (Stage D) so cars never overlap as
      // the car scales: behind-line offset ≈ 1.73 WB, row pitch ≈ 3.0 WB.
      const back = CONFIG.wheelbase * 1.73, rowPitch = CONFIG.wheelbase * 3.0;
      return { x: g.cx - back - row * rowPitch, y: col === 0 ? lane0 : lane1, heading: 0 };
    },

    // Closed track: the barriers do the real containment. wrap() just clamps a
    // car that somehow escaped the world rect (no torus wrap). true = teleported.
    wrap(car, world) {
      const m = 1.5;   // edge clamp margin, real m on the ruler
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
  // Map-select grouping: shares the "Stadium Oval" tile; the "Flattrack" switcher
  // option (second, after Asphalt). Still registered + launched by id 'flat'.
  surfaceGroup: {
    key: 'stadium-oval', title: 'Stadium Oval', option: 'Flattrack', order: 1,
  },
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
  // Map-select grouping: shares the "Stadium Oval" tile; the "Asphalt" switcher
  // option (first) and the group's DEFAULT surface. Launched by id 'asphalt'.
  surfaceGroup: {
    key: 'stadium-oval', title: 'Stadium Oval', option: 'Asphalt', order: 0,
    isDefault: true,
  },
});

// =============================================================================
//  MAP 4 — WINDING CIRCUIT (from the hand-drawn sketch). A technical road course
//  (hairpins, esses, a long bottom straight) rendered in the ASPHALT-oval visual
//  style (the SAME tarmac tones + rubbered-in racing line), but OPEN: NO barriers,
//  NO collision walls — just an asphalt ribbon on GRASS you can drive off onto
//  freely. This first pass is surface + grass only (kerbs / run-off / start-finish
//  come later). Shape = the sketch control points, smoothed by a closed spline.
// =============================================================================

// Sketch centerline control points (viewBox 1760×780, clockwise). Band = 124
// sketch-units wide (the width the shape was designed at in the track editor).
// These are just the LAYOUT nodes — the actual driven ribbon is the resampled +
// low-pass-smoothed CIRCUIT_PATH built below (globally smooth, no per-node kinks).
// The bottom straight is levelled to y=620 so the finish run stays horizontal.
const CIRCUIT_SKETCH: Array<[number, number]> = [
  // bottom-right corner, then UP the right side to the top
  [1377,620],[1522,497],[1554,321],[1520,218],[1447,160],[1333,136],[1231,170],
  // inner section (the technical middle)
  [1154,260],[1114,419],[1000,469],[855,407],[789,212],
  // top-left bump + DOWN the left side
  [681,166],[584,246],[578,455],
  // BOTTOM STRAIGHT — levelled to y=620 (horizontal finish line), left→right
  [747,620],[980,620],[1180,620],
];
const CS_BAND = 124;

// Track width = 2/3 of the asphalt oval's band, in real metres. The band px value
// (124) only sets the SCALE — the width in metres is ALWAYS 2/3 of the oval.
const CIRCUIT_TRACK_W = computeStadium(FLAT_LOGICAL.widthM, FLAT_LOGICAL.heightM).bandW * (2 / 3);
const CS_SCALE = CIRCUIT_TRACK_W / CS_BAND;      // metres per sketch unit

// The shape was designed (in the editor's screen-frame) to FIT one screen at this
// width, so the world = one screen (FLAT_LOGICAL) and it renders exactly like the
// oval: uniform scale-to-fit ⇒ the car is the STANDARD size, the whole track is
// visible, grass fills the screen, NO camera scroll. (A future shape too big for
// one screen would switch on `followCam` instead.)
const CIRCUIT_LOGICAL = { widthM: FLAT_LOGICAL.widthM, heightM: FLAT_LOGICAL.heightM };

// ---- ONE globally-smooth centerline: dense spline → arc-length even → low-pass --
// Tweaking individual control points only RELOCATES kinks. Instead the whole closed
// curve is (1) sampled through a centripetal Catmull-Rom, (2) resampled to a high,
// UNIFORM (arc-length) resolution so spacing is even everywhere, (3) low-pass
// smoothed (circular box blur) so curvature can't spike at any node → the whole
// ribbon is evenly rounded with NO sharp point anywhere, (4) resampled again to stay
// even. Computed ONCE at load; the surface just strokes the resulting polyline.
type Pt = [number, number];

function sampleSpline(ctrl: Pt[], perSeg: number): Pt[] {
  const n = ctrl.length, out: Pt[] = [];
  const chord = (a: Pt, b: Pt) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    const d1 = chord(p0, p1), d2 = chord(p1, p2), d3 = chord(p2, p3);
    const c1: Pt = [0, 0], c2: Pt = [0, 0];
    for (let k = 0; k < 2; k++) {
      const m1 = (p1[k] - p0[k]) / d1 - (p2[k] - p0[k]) / (d1 + d2) + (p2[k] - p1[k]) / d2;
      const m2 = (p2[k] - p1[k]) / d2 - (p3[k] - p1[k]) / (d2 + d3) + (p3[k] - p2[k]) / d3;
      c1[k] = p1[k] + (d2 * m1) / 3;
      c2[k] = p2[k] - (d2 * m2) / 3;
    }
    for (let j = 0; j < perSeg; j++) {
      const t = j / perSeg, u = 1 - t;
      out.push([
        u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
        u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1],
      ]);
    }
  }
  return out;
}

// Uniform (arc-length) resample of a CLOSED polyline to N evenly-spaced points.
function resampleClosed(pts: Pt[], N: number): Pt[] {
  const m = pts.length, seg: number[] = [], cum: number[] = [0];
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(d); cum.push(cum[i] + d);
  }
  const L = cum[m], out: Pt[] = [];
  let si = 0;
  for (let k = 0; k < N; k++) {
    const target = (k * L) / N;
    while (si < m - 1 && cum[si + 1] < target) si++;
    const t = seg[si] > 1e-9 ? (target - cum[si]) / seg[si] : 0;
    const a = pts[si], b = pts[(si + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Circular box-blur over the closed loop — rounds EVERY corner uniformly. On dense,
// even points a small radius removes sharp bends without melting the overall shape.
function smoothClosed(pts: Pt[], radius: number, passes: number): Pt[] {
  const N = pts.length, w = 2 * radius + 1;
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const next: Pt[] = new Array(N);
    for (let i = 0; i < N; i++) {
      let sx = 0, sy = 0;
      for (let d = -radius; d <= radius; d++) {
        const q = cur[((i + d) % N + N) % N];
        sx += q[0]; sy += q[1];
      }
      next[i] = [sx / w, sy / w];
    }
    cur = next;
  }
  return cur;
}

const CIRCUIT_SAMPLES = 1000;

// The bottom control points sit at this y — the FLAT finish-straight level. The
// smoothed spline OVERSHOOTS below it entering/leaving the corners (a dip to ~630),
// which is the visible outward BULGE. Flattening clamps those dips back up to it.
const CIRCUIT_STRAIGHT_Y = Math.max(...CIRCUIT_SKETCH.map((p) => p[1]));

const CIRCUIT_PATH: Pt[] = ((): Pt[] => {
  let p = resampleClosed(
    smoothClosed(resampleClosed(sampleSpline(CIRCUIT_SKETCH, 48), CIRCUIT_SAMPLES), 14, 2),
    CIRCUIT_SAMPLES,
  );
  // FINISH-STRAIGHT FLATTEN — a dead-level, straight segment the WHOLE bottom length,
  // no bulge, smooth into the corners. Not a per-point tweak: (1) CLAMP every bottom
  // point that dips BELOW the straight line up onto it → the whole bottom is flat AND
  // nothing sits below the line (so no outward bulge — the corners rise UP from it);
  // (2) a light global re-smooth rounds the clamp junctions into the corners (no kink),
  // and — since averaging values that are all ≤ the line can NEVER produce one below it
  // — cannot re-create a bulge; (3) re-clamp so the middle stays dead-flat after the
  // smooth lifts the junction points up into the corners.
  const maxY = Math.max(...p.map((q) => q[1]));
  const flatten = (q: Pt): Pt =>
    q[1] > CIRCUIT_STRAIGHT_Y && q[1] > maxY - 45 ? [q[0], CIRCUIT_STRAIGHT_Y] : q;
  p = p.map(flatten);
  p = smoothClosed(p, 4, 3);
  p = p.map(flatten);
  return p;
})();

// Finish line = the centre of the dead-flat bottom straight (level, at straightY).
const CIRCUIT_FINISH = ((): { x: number; y: number } => {
  const fx = CIRCUIT_PATH
    .filter((p) => Math.abs(p[1] - CIRCUIT_STRAIGHT_Y) < 1e-6)
    .map((p) => p[0]);
  return { x: (Math.min(...fx) + Math.max(...fx)) / 2, y: CIRCUIT_STRAIGHT_Y };
})();

// ---- Apex KERBS — red/white striped curbs on the INSIDE edge of the corners -----
// Real circuits line the apex (inside) of corners with red/white striped kerbs. We
// find the high-curvature arcs (the corners) of the smooth 1000-pt ribbon and lay a
// striped band along the CONCAVE inner edge, hugging the asphalt just inside the edge
// and tapering to a point at each end. Purely visual (baked into the surface layer) —
// drivable, no physics this pass. Each quad is a perpendicular slice → clean stripes.
const KERB_TURN_TH = 0.5;             // smoothed turn (deg/pt) above which it's a corner
const KERB_MIN_PTS = 30;              // ignore bends shorter than this (straights, blips)
const KERB_END_TAPER = 10;            // pts over which width fades in/out at each end
const KERB_WIDTH = CS_BAND * 0.11;    // red/white kerb reach into the grass = track WIDENING (≈3 m)
const KERB_BLUE_WIDTH = CS_BAND * 0.045;  // solid BLUE border strip beyond it (grass side)
const KERB_STRIPE = 10;               // stripe length in KERB-EDGE arc (sketch units ≈2.2 m,
                                      //   CONSTANT physical size on gentle + sharp corners)
const KERB_RED = '#c9382f', KERB_WHITE = '#e8e8ee', KERB_BLUE = '#2f6fca';

interface KerbQuad { a: Pt; b: Pt; c: Pt; d: Pt; fill: string; }
const CIRCUIT_KERBS: KerbQuad[] = ((): KerbQuad[] => {
  const N = CIRCUIT_PATH.length, idx = (i: number) => ((i % N) + N) % N;
  const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  // smoothed per-point turn magnitude (deg) → "cornerness"
  const raw: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = CIRCUIT_PATH[idx(i - 1)], b = CIRCUIT_PATH[i], c = CIRCUIT_PATH[idx(i + 1)];
    const v1x = b[0] - a[0], v1y = b[1] - a[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
    let cr = (v1x * v2y - v1y * v2x) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y));
    raw.push(Math.asin(Math.max(-1, Math.min(1, cr))) * 180 / Math.PI);
  }
  const corner: number[] = [];
  for (let i = 0; i < N; i++) { let s = 0; for (let d = -6; d <= 6; d++) s += Math.abs(raw[idx(i + d)]); corner.push(s / 13); }
  // contiguous corner regions (start scanning at a non-corner point so none wraps index 0)
  let off = 0; while (off < N && corner[off] >= KERB_TURN_TH) off++;
  const regions: Array<[number, number]> = [];
  let st = -1;
  for (let k = 0; k <= N; k++) {
    const on = k < N && corner[idx(off + k)] >= KERB_TURN_TH;
    if (on && st < 0) st = k;
    else if (!on && st >= 0) { if (k - st >= KERB_MIN_PTS) regions.push([idx(off + st), idx(off + k - 1)]); st = -1; }
  }
  const quads: KerbQuad[] = [];
  for (const [s, e] of regions) {
    const len = ((e - s + N) % N) + 1;
    // three edges per point: asphalt edge → red/white outer → blue outer (deepest in grass)
    const edge: Pt[] = [], mid: Pt[] = [], out: Pt[] = [], arc: number[] = [0];
    for (let k = 0; k < len; k++) {
      const i = idx(s + k), a = CIRCUIT_PATH[idx(i - 1)], c = CIRCUIT_PATH[idx(i + 1)], P = CIRCUIT_PATH[i];
      // concave (inner/apex) unit normal: ⟂ to the tangent, pointing toward the chord midpoint
      let tx = c[0] - a[0], ty = c[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      let nx = -ty, ny = tx;
      if (nx * ((a[0] + c[0]) / 2 - P[0]) + ny * ((a[1] + c[1]) / 2 - P[1]) < 0) { nx = -nx; ny = -ny; }
      const taper = smoother(Math.min(Math.min(1, k / KERB_END_TAPER), Math.min(1, (len - 1 - k) / KERB_END_TAPER)));
      // red/white kerb = CONSTANT full width (crisp, defined ends). The gradual ease
      // in/out lives on the BLUE border instead — it fades from full to 0 at each end.
      const w = KERB_WIDTH, bw = KERB_BLUE_WIDTH * taper;
      // sits at the asphalt inner edge (CS_BAND/2) and extends OUTWARD into the infield
      // GRASS: red/white for `w`, then a solid BLUE border for `bw` — a track WIDENING.
      const o = (d: number): Pt => [P[0] + nx * (CS_BAND / 2 + d), P[1] + ny * (CS_BAND / 2 + d)];
      edge.push(o(0)); mid.push(o(w)); out.push(o(w + bw));
      // stripe bucket runs on the KERB-EDGE arc (not the centreline): the inside of a
      // tight corner has a much shorter radius, so centreline arc would COMPRESS the
      // blocks there — measuring along the kerb keeps every block a constant real size.
      if (k > 0) arc.push(arc[k - 1] + Math.hypot(edge[k][0] - edge[k - 1][0], edge[k][1] - edge[k - 1][1]));
    }
    for (let k = 0; k < len - 1; k++) {
      const rw = Math.floor(arc[k] / KERB_STRIPE) % 2 === 0 ? KERB_RED : KERB_WHITE;
      quads.push({ a: edge[k], b: mid[k], c: mid[k + 1], d: edge[k + 1], fill: rw });        // red/white stripe
      quads.push({ a: mid[k], b: out[k], c: out[k + 1], d: mid[k + 1], fill: KERB_BLUE });    // blue border
    }
  }
  return quads;
})();

// Track bbox centre (of the SMOOTH path) → centre the ribbon in the screen world.
const _cpx = CIRCUIT_PATH.map((p) => p[0]), _cpy = CIRCUIT_PATH.map((p) => p[1]);
const CS_BCX = (Math.min(..._cpx) + Math.max(..._cpx)) / 2;
const CS_BCY = (Math.min(..._cpy) + Math.max(..._cpy)) / 2;

// One sketch unit → world METRES (fixed 2/3-oval scale, bbox centred on the world).
function circuitToWorld(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - CS_BCX) * CS_SCALE + CIRCUIT_LOGICAL.widthM / 2,
    y: (sy - CS_BCY) * CS_SCALE + CIRCUIT_LOGICAL.heightM / 2,
  };
}

// Stroke the pre-mapped dense polyline (PIXEL space) — 1000 short segments + round
// joins render as a perfectly smooth ribbon.
function tracePolyline(ctx: CanvasRenderingContext2D, pxPts: Pt[]) {
  ctx.beginPath();
  ctx.moveTo(pxPts[0][0], pxPts[0][1]);
  for (let i = 1; i < pxPts.length; i++) ctx.lineTo(pxPts[i][0], pxPts[i][1]);
  ctx.closePath();
}

// Surface: GRASS (the oval's green) everywhere, then the ASPHALT ribbon (oval's
// tarmac tones) + a rubbered-in racing line down the middle. Fits the sketch into
// whatever canvas size it's given (game world OR the map-select mini-preview),
// preserving aspect + centring — so world coords and the render always agree.
function drawCircuitSurface(ctx: CanvasRenderingContext2D, wPx: number, hPx: number) {
  // Map the sketch at the FIXED 2/3-oval scale (never scale-to-fit — that would
  // change the track width), centred, for whatever canvas this is (game world OR
  // the map-select mini-preview — both share the world's aspect). px-per-metre =
  // wPx / world-width-in-metres, so the band renders at exactly 2/3 of the oval.
  const pxPerM = wPx / CIRCUIT_LOGICAL.widthM;
  const s = CS_SCALE * pxPerM;                          // canvas px per sketch unit
  const offX = wPx / 2 - CS_BCX * s, offY = hPx / 2 - CS_BCY * s;
  const ptsPx = CIRCUIT_PATH.map(
    (p) => [offX + p[0] * s, offY + p[1] * s] as [number, number],
  );
  const twPx = CS_BAND * s;                             // = CIRCUIT_TRACK_W · pxPerM
  const a = SURFACE_STYLES.asphalt;

  // Grass — the oval's infield green (day-grass), the whole field.
  const grass = ctx.createLinearGradient(0, 0, 0, hPx);
  grass.addColorStop(0, '#26402f'); grass.addColorStop(1, '#1b3223');
  ctx.fillStyle = grass; ctx.fillRect(0, 0, wPx, hPx);

  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // Dark asphalt EDGE — a thin darker rim so the track reads against the grass
  // (cosmetic only — there is NO wall / NO collision here).
  tracePolyline(ctx, ptsPx);
  ctx.strokeStyle = '#1d1f24'; ctx.lineWidth = twPx + Math.max(3, twPx * 0.06); ctx.stroke();
  // Asphalt SURFACE — the oval's tarmac gradient, applied vertically for depth.
  const asf = ctx.createLinearGradient(0, 0, 0, hPx);
  asf.addColorStop(0, a.ringInner); asf.addColorStop(1, a.ringOuter);
  tracePolyline(ctx, ptsPx);
  ctx.strokeStyle = asf; ctx.lineWidth = twPx; ctx.stroke();
  // Rubbered-in racing line down the middle (the oval's worn-line treatment).
  tracePolyline(ctx, ptsPx);
  ctx.strokeStyle = a.lineStroke; ctx.lineWidth = twPx * 0.3; ctx.stroke();

  // APEX KERBS — red/white striped curbs along the inside edge of each corner,
  // drawn ON TOP of the asphalt (each quad is a perpendicular stripe slice). Purely
  // visual + drivable (the surface has no collision). Scale-agnostic (sketch → px).
  for (const q of CIRCUIT_KERBS) {
    ctx.fillStyle = q.fill;
    ctx.beginPath();
    ctx.moveTo(offX + q.a[0] * s, offY + q.a[1] * s);
    ctx.lineTo(offX + q.b[0] * s, offY + q.b[1] * s);
    ctx.lineTo(offX + q.c[0] * s, offY + q.c[1] * s);
    ctx.lineTo(offX + q.d[0] * s, offY + q.d[1] * s);
    ctx.closePath();
    ctx.fill();
  }
}

export const circuitMap: MapDefinition = {
  id: 'circuit',
  name: 'Circuit',
  trackType: 'open',              // free surface (no built-in start line this pass)
  smokeColor: [248, 248, 251],    // white rubber smoke (asphalt), matching the oval
  fixedWorld: CIRCUIT_LOGICAL,    // = one screen ⇒ oval-style render (car standard size)

  // OPEN track: NO barriers, NO collision rects — drive off onto the grass freely.
  createWorld(widthM, heightM) {
    return { width: widthM, height: heightM, rects: [] };
  },

  drawBackground(ctx, wPx, hPx) { drawCircuitSurface(ctx, wPx, hPx); },
  drawObstacles() { /* no barriers / no decor this pass */ },

  // Grid spawn on the flat finish straight (the nearest-to-bottom, levelled run),
  // facing +x (the racing direction along the bottom = left→right).
  spawn(slot, world) {
    void world;
    const c = circuitToWorld(CIRCUIT_FINISH.x, CIRCUIT_FINISH.y);
    const col = slot % 2, row = Math.floor(slot / 2);
    const laneOff = (col === 0 ? -1 : 1) * CIRCUIT_TRACK_W * 0.18;   // heading 0 ⇒ perp is y
    const back = CONFIG.wheelbase * 1.73 + row * CONFIG.wheelbase * 3.0;
    return { x: c.x - back, y: c.y + laneOff, heading: 0 };
  },

  // No walls: just a soft clamp at the (far-out) world edge so a car can't leave
  // the world entirely. The grass extends to the edge; there is no track boundary.
  wrap(car, world) {
    const m = 1.5;
    let clamped = false;
    if (car.x < m) { car.x = m; car.vx = 0; clamped = true; }
    else if (car.x > world.width - m) { car.x = world.width - m; car.vx = 0; clamped = true; }
    if (car.y < m) { car.y = m; car.vy = 0; clamped = true; }
    else if (car.y > world.height - m) { car.y = world.height - m; car.vy = 0; clamped = true; }
    return clamped;
  },

  draggableObstacles: false,
};

// Register the built-in maps. The desktop is FIRST (the default).
registerMap(desktopMap);
registerMap(flatTrackMap);
registerMap(asphaltTrackMap);
registerMap(circuitMap);
