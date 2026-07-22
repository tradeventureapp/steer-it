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

import { CONFIG, type CarState, type ObstacleRect, type ObstacleArc } from './vehicle-core';
import { spawnPose } from './cars';
import type { RaceElement } from './race';
import {
  SURFACES, onSurfaceAssetsReady, GRASS_LOOK,
  type SurfaceRC, type SurfaceShape,
} from './surfaces';
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
  arcs?: ObstacleArc[];   // curved collision walls (oval corners) fed to collideWithArcs
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

// Ground under a world point. Drives PER-WHEEL grip + drag in physics4: the tyre profile
// (PHYS4.tire.muScale) keys its μ off this, and each surface adds its own resistance.
export type Surface = 'asphalt' | 'grass' | 'gravel' | 'dirt';

export interface MapDefinition {
  id: string;
  name: string;
  trackType: TrackType;

  // See SurfaceGroup — optional map-select grouping metadata (presentation only).
  surfaceGroup?: SurfaceGroup;

  // O(1) ground lookup for a world point (metres). ABSENT ⇒ the map is asphalt
  // everywhere (the desktop + both ovals) — and physics4 is then handed `undefined`,
  // so the whole grass path is dead code and those maps stay byte-identical.
  surfaceAt?(x: number, y: number): Surface;

  // RENDER-ONLY tyre-mark class for a map with NO per-point mask (desktop, ovals).
  // The saturation mark system stamps the whole map in this class (rubber on
  // asphalt, a brown dirt scuff on the flat oval). Default 'asphalt'. NEVER read
  // by the physics — a mark is a surface's look, not its grip.
  markClass?: MarkClass;

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
  // Optional layer drawn AFTER the cars — for tall props whose raised parts should occlude a
  // car passing UNDER them (the circuit's standing billboards: drive under → hide behind it).
  drawAboveCars?(ctx: CanvasRenderingContext2D, world: MapWorld, px: number): void;
  // Optional AD hit-test: the click URL of a clickable ad billboard whose on-screen face contains
  // the WORLD point (xM,yM), else null. The host uses it for a pointer cursor + click-to-open.
  adAt?(xM: number, yM: number): string | null;

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
  // Collision rects are CENTRED on the band edge (OYh / IYh) to match drawStadiumWall's
  // centred strokes → the collision wall IS the drawn black tyre-wall strip: the whole strip
  // is solid and the car bounces off its band-side edge (was offset outside/inside the edge,
  // leaving ~sq/2 of each strip drivable). The bounce (collideWithRects, restitution 0.35) is
  // unchanged.
  // STRAIGHTS = thin rects centred on the band edge (match drawStadiumWall's centred strokes).
  return [
    { x: cx - sx - ext, y: cy - OYh - sq / 2, w: 2 * sx + 2 * ext, h: sq }, // outer top
    { x: cx - sx - ext, y: cy + OYh - sq / 2, w: 2 * sx + 2 * ext, h: sq }, // outer bottom
    { x: cx - sx - ext, y: cy - IYh - sq / 2, w: 2 * sx + 2 * ext, h: sq }, // inner top
    { x: cx - sx - ext, y: cy + IYh - sq / 2, w: 2 * sx + 2 * ext, h: sq }, // inner bottom
  ];
}

// The oval CORNER walls as curved (arc) collision boundaries — the car (capsule) contacts the
// smooth drawn curve EXACTLY (the old arc-of-axis-aligned-squares scalloped it → a ~0.1-0.2 m
// nose-on gap in the corners). `r` is the strip's BAND-SIDE edge radius (OYh − sq/2 outer /
// IYh + sq/2 inner), so the visible edge is what the car touches. A small angular pad overlaps
// the straight rects at the four junctions so there's no seam. Inner + outer, both turns.
function stadiumArcs(g: StadiumGeom): ObstacleArc[] {
  const { cx, cy, sx, OYh, IYh } = g;
  const sq = Math.max(3.0, g.bandW * 0.16);
  const half = sq / 2, pad = 0.16;
  return [
    // outer walls — the car stays INSIDE radius OYh − half
    { cx: cx + sx, cy, r: OYh - half, a0: -Math.PI / 2 - pad, a1: Math.PI / 2 + pad, inside: true },
    { cx: cx - sx, cy, r: OYh - half, a0: Math.PI / 2 - pad, a1: Math.PI * 1.5 + pad, inside: true },
    // inner walls — the car stays OUTSIDE radius IYh + half
    { cx: cx + sx, cy, r: IYh + half, a0: -Math.PI / 2 - pad, a1: Math.PI / 2 + pad, inside: false },
    { cx: cx - sx, cy, r: IYh + half, a0: Math.PI / 2 - pad, a1: Math.PI * 1.5 + pad, inside: false },
  ];
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
  thickness: number, part: 'all' | 'base' | 'dash' = 'all',
) {
  ctx.save();
  ctx.lineJoin = 'round';
  if (part !== 'dash') {
    ctx.lineWidth = thickness;
    ctx.strokeStyle = '#0e1116';
    stadiumPath(ctx, cx, cy, sx, Yh); ctx.stroke();
  }
  if (part !== 'base') {
    ctx.lineWidth = Math.max(2, thickness * 0.32);
    ctx.setLineDash([14, 11]);
    ctx.strokeStyle = 'rgba(255,45,149,0.8)';
    stadiumPath(ctx, cx, cy, sx, Yh); ctx.stroke();
    ctx.lineDashOffset = 12.5;
    ctx.strokeStyle = 'rgba(45,226,230,0.7)';
    stadiumPath(ctx, cx, cy, sx, Yh); ctx.stroke();
    ctx.setLineDash([]);
  }
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

// ---- Packed-dirt texture (flat-track look) ----------------------------------
// A cached, deterministic, brightness-NEUTRAL mottle: two scales (coarse tonal
// patches + fine grain) baked OPAQUE around a mid dirt tone, tinted brown, so
// overlaying it never shifts the ring's mean colour (the lesson from the asphalt/
// gravel grain passes). Built ONCE, reused as a repeating pattern → zero per-frame
// cost. off-DOM (unit tests) → null → the flat gradient fallback is used instead.
let _dirtTile: HTMLCanvasElement | null = null;
let _dirtTried = false;
function dirtTile(): HTMLCanvasElement | null {
  if (_dirtTried) return _dirtTile;
  _dirtTried = true;
  if (typeof document === 'undefined') return null;
  const N = 256;
  const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
  const c = cv.getContext('2d'); if (!c) return null;
  const cl = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : x | 0);
  const hsh = (a: number, b: number) => {
    let h = (Math.imul(a, 374761393) ^ Math.imul(b, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const sm = (a: number, b: number, t: number) => a + (b - a) * (t * t * (3 - 2 * t));
  // value noise (smoothed lattice). CELL=32 divides the 256px tile into exactly 8 lattice
  // cells, and the lattice index wraps mod 8 → the tile repeats SEAMLESSLY (no visible seam
  // when createPattern('repeat') tiles it across the ring).
  const CELL = 64, PER = N / CELL;   // 4 large, soft tonal patches
  const vn = (x: number, y: number) => {
    const gx = x / CELL, gy = y / CELL, ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy, m = (n: number) => ((n % PER) + PER) % PER;
    const t = sm(hsh(m(ix), m(iy)), hsh(m(ix + 1), m(iy)), fx);
    const b = sm(hsh(m(ix), m(iy + 1)), hsh(m(ix + 1), m(iy + 1)), fx);
    return sm(t, b, fy);
  };
  const img = c.createImageData(N, N), d = img.data;
  const base = [92, 56, 29];   // deep raced-in chocolate-brown dirt (damp, not beige)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // symmetric (mean-0) shift, gentle on the darker base: coarse patches ±6 + fine grain ±3.5
    const shift = (vn(x, y) - 0.5) * 12 + (hsh(x, y) - 0.5) * 7;
    const i = (y * N + x) * 4;
    d[i] = cl(base[0] + shift);            // brown keeps R > G > B as it shifts
    d[i + 1] = cl(base[1] + shift * 0.82);
    d[i + 2] = cl(base[2] + shift * 0.6);
    d[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  _dirtTile = cv;
  return cv;
}

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

  // Racing ring. DIRT → a mottled packed-dirt texture + a gentle radial shade
  // (keeps inner/outer depth) so it reads as real raced-in dirt, not a flat brown.
  // ASPHALT (or dirt off-DOM) → the original surface gradient, byte-identical.
  stadiumPath(ctx, cx, cy, sx, OYh);
  ctx.lineJoin = 'round';
  const tile = style === 'dirt' ? dirtTile() : null;
  const bandW = OYh - IYh;
  if (tile) {
    ctx.save(); ctx.clip();
    const pat = ctx.createPattern(tile, 'repeat');
    if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, wPx, hPx); }   // base packed-dirt mottle

    // Very subtle radial depth.
    const shade = ctx.createRadialGradient(cx, cy, IYh, cx, cy, sx + OYh);
    shade.addColorStop(0, 'rgba(120,80,44,0.10)');
    shade.addColorStop(1, 'rgba(40,24,11,0.30)');
    ctx.fillStyle = shade; ctx.fillRect(0, 0, wPx, hPx);

    // GROOMED / RAKED DIRT — the whole ring, uniformly: fine, regular concentric rake grooves
    // (a graded/prepared track), each with RELIEF from a paired dark groove + light crest-
    // highlight just inside it, so they read as raked ridges, not flat lines. No racing line.
    const nRake = Math.max(12, Math.round(bandW / 7)), step = bandW / nRake;
    ctx.lineWidth = 1;
    for (let i = 1; i < nRake; i++) {
      const r = IYh + step * i;
      ctx.strokeStyle = 'rgba(26,15,7,0.14)';      // groove (shadow)
      stadiumPath(ctx, cx, cy, sx, r); ctx.stroke();
      ctx.strokeStyle = 'rgba(160,124,84,0.11)';   // ridge crest (highlight)
      stadiumPath(ctx, cx, cy, sx, r - step * 0.4); ctx.stroke();
    }

    // Looser/dustier LIGHT dirt at the very inner apex + outer wall (blurred edge bands).
    const ovalBand = (rCf: number, lwF: number, rgb: string, a: number) => {
      ctx.save();
      ctx.filter = `blur(${(bandW * 0.13).toFixed(1)}px)`;
      ctx.strokeStyle = `rgba(${rgb},${a})`;
      ctx.lineWidth = bandW * lwF;
      stadiumPath(ctx, cx, cy, sx, IYh + bandW * rCf); ctx.stroke();
      ctx.restore();
    };
    ovalBand(0.98, 0.26, '150,114,74', 0.18);   // outer wall
    ovalBand(0.02, 0.22, '150,114,74', 0.15);   // inner apex
    ctx.restore();
  } else {
    const ring = ctx.createRadialGradient(cx, cy, IYh, cx, cy, sx + OYh);
    ring.addColorStop(0, s.ringInner); ring.addColorStop(1, s.ringOuter);
    ctx.fillStyle = ring; ctx.fill();
    // Asphalt (and dirt off-DOM fallback): the original worn line + faint grooves.
    ctx.strokeStyle = s.lineStroke;
    ctx.lineWidth = bandW * 0.32;
    stadiumPath(ctx, cx, cy, sx, midYh); ctx.stroke();
    ctx.strokeStyle = s.grooveStroke; ctx.lineWidth = 2;
    for (const f of [0.72, 0.5, 0.28]) {
      stadiumPath(ctx, cx, cy, sx, IYh + bandW * f); ctx.stroke();
    }
  }

  // Infield — a tidy MOWN stadium pitch (our circuit-grass style), but DARKER for the
  // night scene: deep night-turf greens, mower stripes running PERPENDICULAR to the
  // straights (vertical bands across the long axis), + a subtle floodlight falloff
  // (brighter centre where the floods hit, darker to the edges).
  drawStadiumInfield(ctx, cx, cy, sx, IYh, px);

  // (The inner-edge DRIVE-OVER kerb is drawn in drawStadiumDecor — interleaved between the
  // barrier's black base and its neon dashes so it REPLACES the black strip adjoining the track.)

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
  // Inner edge: track → red/white DRIVE-OVER kerb → NARROW black barrier strip (the wall).
  // The black strip is the solid wall (existing springy collision, just restyled — NO neon on
  // the inner edge). It's drawn NARROWER than the collision body and pulled toward the kerb: its
  // TRACK-side edge stays on the collision/kerb face (IYh + barrierPx/2) so the car still crashes
  // there, while its infield edge is drawn back toward the kerb — freeing the infield for grass.
  const innerT = barrierPx * 0.5;
  drawStadiumWall(ctx, cx, cy, sx, IYh + (barrierPx - innerT) / 2, innerT, 'base');
  drawOvalInnerKerb(ctx, g, px);
}

// MOWN night-turf infield (our circuit-grass style, DARKER for the lit-oval-in-the-dark look).
// Mower stripes run PERPENDICULAR to the straights (vertical bands across the long axis) with a
// soft-edged square-wave profile (crisp bands, no gradient look — like the circuit grass), then a
// subtle radial floodlight falloff (brighter centre, darker edges). Clipped to the infield.
function drawStadiumInfield(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, sx: number, IYh: number, px: number,
) {
  // Night-turf palette: DARK green base with a slightly lit mown stripe — same light/dark ratio
  // as the circuit grass (GRASS_LOOK) but scaled down into the dark for the night scene.
  const dark: [number, number, number] = [26, 46, 34];
  const light: [number, number, number] = [38, 60, 44];
  const bandPx = Math.max(6, GRASS_LOOK.bandM * px);   // METRES/band (world-scaled) × 2 = light+dark
  const soft = Math.max(0.02, GRASS_LOOK.edgeSoft);
  const x0 = cx - sx - IYh, x1 = cx + sx + IYh, y0 = cy - IYh, y1 = cy + IYh;

  ctx.save();
  stadiumPath(ctx, cx, cy, sx, IYh); ctx.clip();
  // Vertical mown bands: sharpen a sine (in the x phase) into a soft-edged square wave and paint
  // thin columns — flat bands, clean transitions. Anchored at cx so the pattern is symmetric.
  const period = bandPx * 2, colW = Math.max(1, Math.round(bandPx / 6));
  for (let x = x0; x < x1; x += colW) {
    const ph = (((x - cx) / period) % 1 + 1) % 1;
    const m = Math.min(1, Math.max(0, Math.sin(2 * Math.PI * ph) / soft * 0.5 + 0.5));
    ctx.fillStyle = `rgb(${Math.round(dark[0] + (light[0] - dark[0]) * m)},${Math.round(dark[1] + (light[1] - dark[1]) * m)},${Math.round(dark[2] + (light[2] - dark[2]) * m)})`;
    ctx.fillRect(x, y0, colW + 1, y1 - y0);
  }
  // Subtle floodlight falloff — brighter centre, darker at the edges.
  const fall = ctx.createRadialGradient(cx, cy, IYh * 0.15, cx, cy, sx + IYh);
  fall.addColorStop(0, 'rgba(232,240,210,0.07)');
  fall.addColorStop(0.65, 'rgba(0,0,0,0)');
  fall.addColorStop(1, 'rgba(0,0,0,0.24)');
  ctx.fillStyle = fall; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

// Draw the inner-edge DRIVE-OVER kerb from the render's own geometry (metres → ×px):
// FILL + a light same-colour stroke to soften the edges, exactly like the circuit kerbs.
function drawOvalInnerKerb(ctx: CanvasRenderingContext2D, g: StadiumGeom, px: number) {
  const kSoft = kerbSoftPx(g.bandW * px);
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const q of ovalInnerKerb(g)) {
    ctx.beginPath();
    ctx.moveTo(q.a[0] * px, q.a[1] * px);
    ctx.lineTo(q.b[0] * px, q.b[1] * px);
    ctx.lineTo(q.c[0] * px, q.c[1] * px);
    ctx.lineTo(q.d[0] * px, q.d[1] * px);
    ctx.closePath();
    ctx.fillStyle = q.fill; ctx.fill();
    ctx.strokeStyle = q.fill; ctx.lineWidth = kSoft; ctx.stroke();
  }
  ctx.restore();
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
  // PHYSICS ground for the whole oval (per-wheel grip + drag in physics4). Given only for the
  // DIRT oval → its band drives on 'dirt' physics; omitted (the asphalt oval) → no sampler →
  // surfaceAt() returns 'asphalt' as before → asphalt physics, byte-identical. The band is
  // barrier-bounded (inner+outer walls), so a constant is equivalent to a point-in-band test.
  physicsSurface?: Surface;
}): MapDefinition {
  return {
    id: opts.id,
    name: opts.name,
    trackType: 'circuit',   // bounded oval → laps-only editor; built-in start line

    surfaceGroup: opts.surfaceGroup,

    smokeColor: opts.smokeColor,

    ...(opts.physicsSurface
      ? { surfaceAt: (_x: number, _y: number): Surface => opts.physicsSurface! }
      : {}),

    // Tyre-mark look (render-only): the asphalt ring lays grey rubber; the DIRT ring
    // lays a brown gouged scuff (the 'gravel' cap — a darkening multiply that keeps the
    // dirt grain, not a grey line on brown). NOT read by the physics.
    markClass: opts.surface === 'dirt' ? 'gravel' : 'asphalt',

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
      // Barriers on the inner + outer edges: STRAIGHTS as rects, CORNERS as curved arcs (exact
      // contact, no square scalloping). The band between is clear.
      const world: FlatWorld = {
        width: widthM, height: heightM,
        rects: stadiumBarriers(g), arcs: stadiumArcs(g), geom: g,
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
  physicsSurface: 'dirt',       // the WHOLE band drives on dirt physics (grip + drag)
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

// The lap's FAR POINT: the "must reach" that ARMS a lap (see the startLine below). DERIVED
// from the ribbon, not eyeballed, so it stays right if the shape is ever re-drawn.
//
// It is NOT simply the half-lap-by-arc point. This circuit has NO BARRIERS — you can cut
// straight across the grass — so what a lap-farmer actually pays to reach an arming point is
// min(the arc along the track, the straight line across the grass), there and back. On this
// layout the arc-midpoint lands in the middle dip, which hangs back DOWN toward the finish:
// 319 m by arc but only 38 m in a straight line, so a lap could be farmed by nipping 38 m
// onto the infield and back (~77 m vs a real 639 m lap). So the point is chosen to MAXIMISE
// min(arc, straight-line) — the criterion that actually bounds the shortcut. On this layout
// that is the top of the right-hand upper sweep: 181 m by arc, 135 m straight, so the
// cheapest possible fake lap costs ~269 m (3.5× better than the arc-midpoint's ~77 m).
const CIRCUIT_FAR = ((): { x: number; y: number } => {
  const N = CIRCUIT_PATH.length;
  // index of the finish on the (evenly-resampled) path
  let fi = 0, fd = Infinity;
  CIRCUIT_PATH.forEach((p, i) => {
    const d = (p[0] - CIRCUIT_FINISH.x) ** 2 + (p[1] - CIRCUIT_FINISH.y) ** 2;
    if (d < fd) { fd = d; fi = i; }
  });
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const d = Math.hypot(CIRCUIT_PATH[j][0] - CIRCUIT_PATH[i][0], CIRCUIT_PATH[j][1] - CIRCUIT_PATH[i][1]);
    seg.push(d); total += d;
  }
  let best = { score: -1, p: CIRCUIT_PATH[fi] };
  let run = 0;
  for (let k = 0; k < N; k++) {
    const i = (fi + k) % N;
    const arc = Math.min(run, total - run);          // shorter way round to this point
    const straight = Math.hypot(CIRCUIT_PATH[i][0] - CIRCUIT_FINISH.x, CIRCUIT_PATH[i][1] - CIRCUIT_FINISH.y);
    const score = Math.min(arc, straight);
    if (score > best.score) best = { score, p: CIRCUIT_PATH[i] };
    run += seg[i];
  }
  return { x: best.p[0], y: best.p[1] };
})();

// ---- Apex KERBS — red/white striped curbs on the INSIDE edge of the corners -----
// Real circuits line the apex (inside) of corners with red/white striped kerbs. We
// find the high-curvature arcs (the corners) of the smooth 1000-pt ribbon and lay a
// striped band along the CONCAVE inner edge, hugging the asphalt just inside the edge
// and tapering to a point at each end. Purely visual (baked into the surface layer) —
// drivable, no physics this pass. Each quad is a perpendicular slice → clean stripes.
const KERB_TURN_TH = 0.5;             // smoothed turn (deg/pt) above which it's a corner
const KERB_MIN_PTS = 30;              // ignore bends shorter than this (straights, blips)
const KERB_BLUE_TAIL = 35;            // arc-length (sketch u, ~3.5 stripe blocks): the BLUE
                                      //   continues PAST each stripe end as a WEDGE — the full
                                      //   kerb+blue band at the cut, its grass-side edge tapering
                                      //   STEADILY inward to the asphalt edge until it vanishes
// The kerbs reach 1/3 LESS toward the grass than they used to. Both bands scale together, so
// stripes and blue keep their proportions and the whole band is 2/3 of its old reach. The INNER
// edge does NOT move — it is pinned to the asphalt edge by KERB_SEAM, which is untouched; only the
// grass-side reach shrinks. Everything else (lengths, merges, wedge arc-lengths, KERB_STRIPE)
// is independent of these, and the wedge/tip-trim maths is all relative to FULL_W, so the wedge
// keeps its shape at 2/3 scale.
//   NOTE the gravel abutment depends on this: carveGap relies on a kerb reaching FURTHER past the
//   ribbon than the gap-dilated ribbon does (GRAVEL_GRASS_GAP = 1.83 m), so the kerb's own edge is
//   what stops a trap. FULL_W is 2.84 m here — still clear of 1.83, so traps still abut directly.
//   Narrow these much further and that flips, leaving an orphan grass strip between kerb and trap.
const KERB_NARROW = 2 / 3;
const KERB_WIDTH = CS_BAND * 0.11 * KERB_NARROW;      // red/white reach into the grass ≈2.0 m (was ≈3.0)
const KERB_BLUE_WIDTH = CS_BAND * 0.045 * KERB_NARROW; // solid BLUE border beyond it ≈0.83 m (was ≈1.24)
/** The kerb band's TOTAL reach past the asphalt edge (sketch u) — the fixed grass edge. */
const KERB_FULL_W = KERB_WIDTH + KERB_BLUE_WIDTH;
// TIP TRIM — THE ONE TUNABLE (boss's black mark): the wedge is ENDED EARLY, where its reach
// from the asphalt edge has fallen to this fraction of KERB_BLUE_WIDTH, and closed with a
// ROUNDED nose instead of running out to a needle point. Everything before the clip is
// untouched. HIGHER = trims more / blunter nose · LOWER = longer, finer tip (0 = no trim).
const KERB_TIP_CLIP = 0.40;
const KERB_STRIPE = 10;               // stripe length in KERB-EDGE arc (sketch units ≈2.2 m,
                                      //   CONSTANT physical size on gentle + sharp corners)
const KERB_RED = '#c9382f', KERB_WHITE = '#e8e8ee', KERB_BLUE = '#2f6fca';
// Seam overlap (sketch u, ≈1 render px): bands are extended UNDER their neighbour and
// drawn back-to-front (asphalt rim → blue → stripes) so no background sliver can show at
// a seam, on straights OR through curves where per-point normals round differently.
const KERB_SEAM = 0.8;

// BLUE-ONLY zone on the OUTER-perimeter run (boss's blue marks): over this fraction
// of the run — the bottom section (corners + straight) — the red/white stripes are
// REMOVED (they end with a HARD CUT snapped to a whole stripe block, no shrink/taper)
// while the blue strip continues at FULL width. Only the blue eases (its end-taper).
const KERB_BLUE_ONLY = { start: 0.15, end: 0.85 };

// Two kerbs the boss shortened (orange marks): trim a fraction off the region END
// nearest each reference sketch point — the new end then tapers out like any other.
const KERB_CUTS: Array<{ near: Pt; removeFrac: number }> = [
  { near: [626, 526], removeFrac: 0.40 },   // LEFT hairpin — drop the descending-left leg
  { near: [1547, 415], removeFrac: 0.30 },  // LOWER-RIGHT corner — drop the upper part
];
// Two kerbs the boss lengthened (blue marks): grow the region END nearest each ref
// point by addPts, extending it along the bottom straight; the new end tapers out.
const KERB_EXTENDS: Array<{ near: Pt; addPts: number }> = [
  { near: [780, 620], addPts: 24 },    // BOTTOM-LEFT — extend right along the straight
  { near: [1345, 620], addPts: 30 },   // BOTTOM-RIGHT — extend left along the straight
];
// The four INNER kerbs merge into TWO continuous ones (the boss marked the two gaps). Each
// entry joins the region ENDING near `from` to the one STARTING near `to` into a SINGLE
// region, so the bridge is emitted by the same run as the rest — that is what keeps the
// stripes arc-length-perfect across the join and the blue one unbroken band, and it leaves
// wedges only at the merged kerb's two extreme ends. Refs are the regions' own post-cut/
// extend endpoints, so they match exactly (and clear every KERB_CUTS/KERB_EXTENDS ref by
// well over nearRef's 55). All four share turnSign −1, so the normal cannot flip mid-run.
const KERB_MERGES: Array<{ from: Pt; to: Pt }> = [
  { from: [570, 299], to: [685, 581] },    // LEFT — hairpin → bottom-left, down the loop's inner edge
  { from: [1516, 501], to: [1553, 346] },  // RIGHT — bottom-right → right loop, up the inner edge
];

interface KerbQuad { a: Pt; b: Pt; c: Pt; d: Pt; fill: string; z: number; }  // z: 0 blue (under) · 1 stripes (over)
// Each kerb quad is FILLED and lightly STROKED in its own colour, so its VISIBLE inner edge sits
// half a stroke further onto the asphalt than its fill boundary. The white edge line has to abut
// exactly that, so both read it from here and can never drift apart.
function kerbSoftPx(twPx: number): number { return Math.max(0.8, twPx * 0.02); }

// Per path index + side: 0 where there is no kerb, 1 under one, ramping between over the wedges.
// It is the kerb's own outer reach normalised — the wedges taper, so this is the natural ramp for
// easing the white edge line between its kerb-free inset and its abutting one. Filled by the kerb
// builder below (the only thing that knows each kerb's true extent).
//   [0] = side +1 (normal (−ty, tx)) · [1] = side −1
const CIRCUIT_KERB_EASE: [Float32Array, Float32Array] = [
  new Float32Array(CIRCUIT_PATH.length), new Float32Array(CIRCUIT_PATH.length),
];
const CIRCUIT_KERBS: KerbQuad[] = ((): KerbQuad[] => {
  const N = CIRCUIT_PATH.length, idx = (i: number) => ((i % N) + N) % N;
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
  // Apply the boss's per-kerb edits: CUT trims removeFrac off the END nearest a ref
  // point; EXTEND grows the END nearest a ref point by addPts (along the straight).
  const nearRef = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 55;
  const cutRegions: Array<[number, number]> = regions.map(([s0, e0]) => {
    let s = s0, e = e0;
    const len = ((e0 - s0 + N) % N) + 1;
    for (const cut of KERB_CUTS) {
      if (nearRef(CIRCUIT_PATH[e0], cut.near)) { e = idx(s0 + Math.round((1 - cut.removeFrac) * (len - 1))); break; }
      if (nearRef(CIRCUIT_PATH[s0], cut.near)) { s = idx(s0 + Math.round(cut.removeFrac * (len - 1))); break; }
    }
    for (const ext of KERB_EXTENDS) {
      if (nearRef(CIRCUIT_PATH[e0], ext.near)) { e = idx(e + ext.addPts); break; }
      if (nearRef(CIRCUIT_PATH[s0], ext.near)) { s = idx(s - ext.addPts); break; }
    }
    return [s, e];
  });
  // …then MERGE the marked pairs into single regions (see KERB_MERGES). Each join swallows
  // the gap between the two kerbs into ONE index range, so the run that follows emits the
  // whole span — bridge included — as one kerb.
  const kerbRegions: Array<[number, number]> = cutRegions.map((r) => [r[0], r[1]]);
  for (const mg of KERB_MERGES) {
    const ai = kerbRegions.findIndex((r) => nearRef(CIRCUIT_PATH[r[1]], mg.from));
    const bi = kerbRegions.findIndex((r) => nearRef(CIRCUIT_PATH[r[0]], mg.to));
    if (ai < 0 || bi < 0 || ai === bi) continue;
    kerbRegions[ai] = [kerbRegions[ai][0], kerbRegions[bi][1]];   // span the gap
    kerbRegions.splice(bi, 1);
  }
  const quads: KerbQuad[] = [];
  const FULL_W = KERB_FULL_W;                    // full kerb reach → the FIXED grass edge
  const avgSeg = (() => { let s = 0; for (let i = 0; i < N; i++) s += Math.hypot(CIRCUIT_PATH[(i + 1) % N][0] - CIRCUIT_PATH[i][0], CIRCUIT_PATH[(i + 1) % N][1] - CIRCUIT_PATH[i][1]); return s / N; })();
  // The blue tail is ONE CANONICAL wedge measured in KERB_BLUE_TAIL of EDGE-ARC — NOT a
  // fixed point count. (A fixed count made fat stubs on tight concave ends and slim wedges
  // on straights, because the edge arc compresses on the concave side of a curve.) Each
  // side is walked out until its edge-arc reaches KERB_BLUE_TAIL → identical wedge (length
  // + profile) at every termination; TAIL_PTS_CAP bounds the walk (also the neighbour-clamp
  // headroom — the arc-length tail self-limits well short of any other kerb here).
  const TAIL_PTS_CAP = Math.ceil(KERB_BLUE_TAIL / (avgSeg * 0.1)) + 4;
  // Emit ONE kerb over the STRIPE index range [sStart, sEnd] with a side-normal `normFn`:
  //  - red/white = FULL-WIDTH blocks, HARD-CUT ends snapped to the stripe-block grid (no
  //    sliver), skipping an optional blue-only sub-range (outer run);
  //  - the BLUE runs one canonical edge-arc tail PAST each stripe end: inner edge = asphalt
  //    edge where there is NO stripe (else the stripe's outer edge), OUTER edge = the FIXED
  //    grass edge (band/2 + FULL_W) tapering to 0 over KERB_BLUE_TAIL edge-arc → past the
  //    stripes the blue slides onto the asphalt edge and dissolves (a smooth tail, no hard end).
  const emitKerb = (sStart: number, sEnd: number, normFn: (tx: number, ty: number) => Pt, blueOnly: { start: number; end: number } | null) => {
    // Edge point (band/2 along the LOCAL normal) at path index i — the tail follows it.
    const edgeAt = (i: number): Pt => {
      const a = CIRCUIT_PATH[idx(i - 1)], c = CIRCUIT_PATH[idx(i + 1)], p = CIRCUIT_PATH[i];
      let tx = c[0] - a[0], ty = c[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const n = normFn(tx, ty);
      return [p[0] + n[0] * (CS_BAND / 2), p[1] + n[1] * (CS_BAND / 2)];
    };
    // Points needed for the edge-arc from `from` (walking in `dir`) to reach KERB_BLUE_TAIL.
    const tailPts = (from: number, dir: number): number => {
      let pts = 0, acc = 0, pe = edgeAt(from);
      while (pts < TAIL_PTS_CAP && acc < KERB_BLUE_TAIL) {
        const q = edgeAt(idx(from + dir * (pts + 1)));
        acc += Math.hypot(q[0] - pe[0], q[1] - pe[1]); pe = q; pts++;
      }
      return pts;
    };
    const leftPts = tailPts(sStart, -1), rightPts = tailPts(sEnd, 1);
    const bStart = idx(sStart - leftPts);
    const blen = ((sEnd - sStart + N) % N) + 1 + leftPts + rightPts;
    const P: Pt[] = [], nrm: Pt[] = [], edge: Pt[] = [], arc: number[] = [0];
    for (let k = 0; k < blen; k++) {
      const i = idx(bStart + k), a = CIRCUIT_PATH[idx(i - 1)], c = CIRCUIT_PATH[idx(i + 1)], p = CIRCUIT_PATH[i];
      let tx = c[0] - a[0], ty = c[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const n = normFn(tx, ty);
      P.push(p); nrm.push(n);
      edge.push([p[0] + n[0] * (CS_BAND / 2), p[1] + n[1] * (CS_BAND / 2)]);
      if (k > 0) arc.push(arc[k - 1] + Math.hypot(edge[k][0] - edge[k - 1][0], edge[k][1] - edge[k - 1][1]));
    }
    const kSS = leftPts, kSE = blen - 1 - rightPts;                          // stripe range indices
    const stripeStartArc = Math.ceil(arc[kSS] / KERB_STRIPE) * KERB_STRIPE;   // snap to whole blocks
    const stripeEndArc = Math.floor(arc[kSE] / KERB_STRIPE) * KERB_STRIPE;    //   (no sliver at the edge)
    let boS = Infinity, boE = -Infinity;                                     // optional blue-only sub-range (arc)
    if (blueOnly) {
      const snap = (a: number) => Math.round(a / KERB_STRIPE) * KERB_STRIPE;
      boS = snap(arc[Math.round(kSS + blueOnly.start * (kSE - kSS))]);
      boE = snap(arc[Math.round(kSS + blueOnly.end * (kSE - kSS))]);
    }
    const stripeAt = (k: number) => arc[k] >= stripeStartArc && arc[k] < stripeEndArc && !(arc[k] >= boS && arc[k] < boE);
    const off = (k: number, d: number): Pt => [P[k][0] + nrm[k][0] * (CS_BAND / 2 + d), P[k][1] + nrm[k][1] * (CS_BAND / 2 + d)];
    // BLUE edges per point = [inner, outer] offsets from the asphalt edge (band/2):
    //  - kerb BODY (within the snapped stripe span): the width-fix blue — thin OUTSIDE the
    //    stripes (inner KERB_WIDTH → grass edge FULL_W), or full width in a blue-only sub-range;
    //  - TAIL (past a stripe end): a WEDGE — inner pinned to the asphalt edge (0) the whole way,
    //    outer = the FULL kerb+blue band (FULL_W) right AT the cut, its grass-side edge tapering
    //    STEADILY inward (linear 1−t, no plateau) to 0 at the tail end. So the last stripe block
    //    is immediately followed by a full-width solid blue block that wedges down to nothing.
    // BLUE inner edge is pulled KERB_SEAM UNDER its neighbour (the stripes where they exist,
    // else the asphalt edge) so the blue — drawn FIRST/underneath — is overlapped by the
    // stripes/asphalt on top → no background sliver at the seam, straight or curved.
    const blueEdges = (k: number): [number, number] => {
      if (arc[k] >= stripeStartArc && arc[k] < stripeEndArc) {
        const inStripe = !(arc[k] >= boS && arc[k] < boE);
        return [inStripe ? KERB_WIDTH - KERB_SEAM : -KERB_SEAM, FULL_W];
      }
      const dist = arc[k] < stripeStartArc ? stripeStartArc - arc[k] : arc[k] - stripeEndArc;
      const t = Math.min(1, dist / KERB_BLUE_TAIL);      // 0 at the cut → 1 at the tail end
      return [-KERB_SEAM, FULL_W * (1 - t)];             // full band at the cut, steady wedge to 0
    };
    // Hand the white edge line this kerb's presence, normalised off its own outer reach: 1 under
    // the body, tapering to 0 across the wedges. The side is read back out of the caller's normal:
    // normFn(1,0) = [0, side] ⇒ its y component IS the sign. Overlapping kerbs → the strongest wins.
    const ease = CIRCUIT_KERB_EASE[normFn(1, 0)[1] >= 0 ? 0 : 1];
    for (let k = 0; k < blen; k++) {
      const i = idx(bStart + k);
      ease[i] = Math.max(ease[i], Math.min(1, blueEdges(k)[1] / FULL_W));
    }
    // TIP TRIM — the wedge ENDS where its outer reach has fallen to W_CLIP, closed with a
    // rounded nose. outer(dist) = FULL_W·(1 − dist/L) ⇒ the clip sits at a CONSTANT arc past
    // each hard cut, so every end is trimmed identically (canonical, like the tail itself).
    const W_CLIP = KERB_TIP_CLIP * KERB_BLUE_WIDTH;                 // clip width (sketch u)
    const DIST_CLIP = KERB_BLUE_TAIL * (1 - W_CLIP / FULL_W);       // arc past the cut where outer == W_CLIP
    const tailDist = (k: number) => arc[k] < stripeStartArc ? stripeStartArc - arc[k]
      : (arc[k] >= stripeEndArc ? arc[k] - stripeEndArc : 0);       // 0 inside the body (never clipped)
    const lerpPt = (p: Pt, q: Pt, f: number): Pt => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
    // ROUNDED NOSE: a half-disc across the blue's end cross-section, bulging along `dir` (the
    // outward path direction) — a smooth convex arc from the outer edge round to the asphalt
    // edge, no sharp corner, no straight chop. Emitted as a triangle fan (degenerate quads).
    const CAP_SEGS = 12;
    const emitCap = (p: Pt, n: Pt, dir: Pt) => {
      const inner: Pt = [p[0] + n[0] * (CS_BAND / 2 - KERB_SEAM), p[1] + n[1] * (CS_BAND / 2 - KERB_SEAM)];
      const outer: Pt = [p[0] + n[0] * (CS_BAND / 2 + W_CLIP), p[1] + n[1] * (CS_BAND / 2 + W_CLIP)];
      const ctr: Pt = [(inner[0] + outer[0]) / 2, (inner[1] + outer[1]) / 2];
      const r = Math.hypot(outer[0] - ctr[0], outer[1] - ctr[1]) || 1e-6;
      const ux = (outer[0] - ctr[0]) / r, uy = (outer[1] - ctr[1]) / r;          // centre → outer
      const at = (th: number): Pt => [ctr[0] + r * (Math.cos(th) * ux + Math.sin(th) * dir[0]),
                                      ctr[1] + r * (Math.cos(th) * uy + Math.sin(th) * dir[1])];
      for (let j = 0; j < CAP_SEGS; j++) {   // θ 0→π sweeps outer → nose → asphalt edge
        const a = at((j / CAP_SEGS) * Math.PI), b = at(((j + 1) / CAP_SEGS) * Math.PI);
        quads.push({ a: ctr, b: a, c: b, d: ctr, fill: KERB_BLUE, z: 0 });
      }
    };
    for (let k = 0; k < blen - 1; k++) {
      const d0 = tailDist(k), d1 = tailDist(k + 1);
      const [bi0, bo0] = blueEdges(k), [bi1, bo1] = blueEdges(k + 1);
      if (d0 <= DIST_CLIP && d1 <= DIST_CLIP) {          // wholly inside → byte-identical quad
        quads.push({ a: off(k, bi0), b: off(k, bo0), c: off(k + 1, bo1), d: off(k + 1, bi1), fill: KERB_BLUE, z: 0 });
      } else if (d0 <= DIST_CLIP || d1 <= DIST_CLIP) {   // straddles the clip → part-quad + nose
        const kIn = d0 <= DIST_CLIP ? k : k + 1, kOut = d0 <= DIST_CLIP ? k + 1 : k;
        const dIn = Math.min(d0, d1), dOut = Math.max(d0, d1);
        const f = dOut > dIn ? (DIST_CLIP - dIn) / (dOut - dIn) : 0;
        const pc = lerpPt(P[kIn], P[kOut], f);
        let nx = nrm[kIn][0] + (nrm[kOut][0] - nrm[kIn][0]) * f, ny = nrm[kIn][1] + (nrm[kOut][1] - nrm[kIn][1]) * f;
        const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        const nc: Pt = [nx, ny];
        const cIn: Pt = [pc[0] + nx * (CS_BAND / 2 - KERB_SEAM), pc[1] + ny * (CS_BAND / 2 - KERB_SEAM)];
        const cOut: Pt = [pc[0] + nx * (CS_BAND / 2 + W_CLIP), pc[1] + ny * (CS_BAND / 2 + W_CLIP)];
        const [biI, boI] = blueEdges(kIn);
        quads.push({ a: off(kIn, biI), b: off(kIn, boI), c: cOut, d: cIn, fill: KERB_BLUE, z: 0 });
        let dx = P[kOut][0] - P[kIn][0], dy = P[kOut][1] - P[kIn][1];
        const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
        emitCap(pc, nc, [dx, dy]);
      }
      // else: wholly beyond the clip → TRIMMED (the old needle tip)
      if (stripeAt(k)) {   // red/white FULL-WIDTH block (hard cut; constant arc-length size),
        const rw = Math.floor(arc[k] / KERB_STRIPE) % 2 === 0 ? KERB_RED : KERB_WHITE;   // inner
        quads.push({ a: off(k, -KERB_SEAM), b: off(k, KERB_WIDTH), c: off(k + 1, KERB_WIDTH), d: off(k + 1, -KERB_SEAM), fill: rw, z: 1 });  // pulled under the asphalt rim
      }
    }
  };
  // APEX kerbs — concave (turnSign) normal (robust on the straight extensions).
  for (const [s, e] of kerbRegions) {
    const len = ((e - s + N) % N) + 1;
    let turnSum = 0; for (let k = 0; k < len; k++) turnSum += raw[idx(s + k)];
    const ts = turnSum >= 0 ? 1 : -1;
    emitKerb(s, e, (tx, ty) => [ts * -ty, ts * tx], null);
  }
  // OUTER-PERIMETER run — OUTWARD normal (opposite side to the apex kerbs) + the blue-only
  // zone. Runs on the arc between the far-left and far-right that passes the bottom-most pt.
  {
    let iL = 0, iR = 0, iB = 0;
    for (let i = 1; i < N; i++) {
      if (CIRCUIT_PATH[i][0] < CIRCUIT_PATH[iL][0]) iL = i;
      if (CIRCUIT_PATH[i][0] > CIRCUIT_PATH[iR][0]) iR = i;
      if (CIRCUIT_PATH[i][1] > CIRCUIT_PATH[iB][1]) iB = i;
    }
    const [rs, re] = ((iB - iL + N) % N) <= ((iR - iL + N) % N) ? [iL, iR] : [iR, iL];
    const bt = (() => { const a = CIRCUIT_PATH[idx(iB - 1)], c = CIRCUIT_PATH[idx(iB + 1)]; const tx = c[0] - a[0], ty = c[1] - a[1]; return tx / (Math.hypot(tx, ty) || 1); })();
    const oSign = bt >= 0 ? 1 : -1;
    emitKerb(rs, re, (tx, ty) => [oSign * -ty, oSign * tx], KERB_BLUE_ONLY);
  }
  quads.sort((p, q) => p.z - q.z);   // ALL blue first (underneath), then ALL stripes on top (stable)
  return quads;
})();

// ---- OVAL inner-edge DRIVE-OVER KERB — red/white striped (circuit kerb style, arc-length-constant
// stripes, NO blue) around the WHOLE inner perimeter (straights + corners). It sits on the inner
// TRACK edge, adjoining the (unchanged) magenta/cyan barrier on its inner side and the asphalt/dirt
// on its outer (track) side — a DRIVE-OVER kerb: the car drives onto it on the drivable band and
// bounces off the barrier behind it if it overshoots (no kerb collision; the barrier is untouched).
function ovalInnerKerb(g: StadiumGeom): KerbQuad[] {
  const quads: KerbQuad[] = [];
  const { cx, cy, sx, IYh, bandW } = g;
  const sq = Math.max(3.0, bandW * 0.16);
  const STRIPE = KERB_STRIPE * CS_SCALE;          // arc-length-constant stripe (~2.2 m)
  const SEAM = KERB_SEAM * CS_SCALE;
  const OUT = sq / 3;                              // NARROW kerb width (1/3 narrower than the old sq/2)
  const rIn = IYh + sq / 2;                        // loop on the WALL's track-side face — the DRIVE-OVER
                                                   // kerb sits on the drivable track just outside the
                                                   // thick black barrier and reaches OUT into the track
  // outward normal (increasing stadium offset = toward the track): ±y on the straights, radial
  // from the nearest turn centre on the corners.
  const outN = (px: number, py: number): Pt => {
    const dx = px - cx, dy = py - cy;
    if (Math.abs(dx) <= sx) return [0, Math.sign(dy) || 1];
    const tcx = cx + Math.sign(dx) * sx;
    let nx = px - tcx, ny = py - cy; const l = Math.hypot(nx, ny) || 1;
    return [nx / l, ny / l];
  };
  // sample the inner-edge stadium loop (top straight → right arc → bottom straight → left arc)
  const loop: Pt[] = [];
  const step = 1.2;
  const nStr = Math.max(2, Math.round(2 * sx / step)), nArc = Math.max(10, Math.round(Math.PI * rIn / step));
  for (let i = 0; i < nStr; i++) loop.push([cx - sx + 2 * sx * (i / nStr), cy - rIn]);
  for (let i = 0; i < nArc; i++) { const th = -Math.PI / 2 + Math.PI * (i / nArc); loop.push([cx + sx + rIn * Math.cos(th), cy + rIn * Math.sin(th)]); }
  for (let i = 0; i < nStr; i++) loop.push([cx + sx - 2 * sx * (i / nStr), cy + rIn]);
  for (let i = 0; i < nArc; i++) { const th = Math.PI / 2 + Math.PI * (i / nArc); loop.push([cx - sx + rIn * Math.cos(th), cy + rIn * Math.sin(th)]); }
  const N = loop.length;
  const arc = [0];
  for (let i = 1; i <= N; i++) arc.push(arc[i - 1] + Math.hypot(loop[i % N][0] - loop[i - 1][0], loop[i % N][1] - loop[i - 1][1]));
  const L = arc[N];
  // Point on the closed loop at arc-length s (linear interpolation between samples).
  const ptAt = (s: number): Pt => {
    s = ((s % L) + L) % L;
    let i = 0; while (i < N && arc[i + 1] < s) i++;
    const seg = (arc[i + 1] - arc[i]) || 1, t = (s - arc[i]) / seg;
    const p = loop[i], q = loop[(i + 1) % N];
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  // REGULAR stripes: an EVEN number of equal blocks tiling the whole loop exactly (so the
  // colours alternate cleanly across the seam), each block = L / nStripes long. Every red and
  // white piece is therefore identical in length. Each block is split into SUB curve-following
  // sub-quads so the stripe hugs the corner arcs.
  let nStripes = Math.max(2, Math.round(L / STRIPE));
  if (nStripes % 2) nStripes++;
  const SUB = 4, M = nStripes * SUB, ds = L / M;
  const pts: Pt[] = [];
  for (let j = 0; j < M; j++) pts.push(ptAt(j * ds));
  for (let j = 0; j < M; j++) {
    const p = pts[j], q = pts[(j + 1) % M];
    const np = outN(p[0], p[1]), nq = outN(q[0], q[1]);
    const rw = Math.floor(j / SUB) % 2 === 0 ? KERB_RED : KERB_WHITE;
    quads.push({
      a: [p[0] - np[0] * SEAM, p[1] - np[1] * SEAM],
      b: [p[0] + np[0] * OUT, p[1] + np[1] * OUT],
      c: [q[0] + nq[0] * OUT, q[1] + nq[1] * OUT],
      d: [q[0] - nq[0] * SEAM, q[1] - nq[1] * SEAM],
      fill: rw, z: 1,
    });
  }
  return quads;
}

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

// ---------- SURFACE MASK (circuit) ----------
// The ground lookup is a bitmap baked ONCE at first use: the track ribbon (the FULL-width
// stroked CIRCUIT_PATH band) + EVERY kerb quad (stripes + blue incl. the wedges — kerbs are
// rideable at full asphalt grip; no special kerb physics yet) are rasterised as ASPHALT,
// everything else is GRASS. Per-frame cost is then a plain array index — no geometry maths
// per wheel per frame. It reuses circuitToWorld, so mask and render agree by construction.
const CIRCUIT_MASK_PPM = 4;              // mask px per metre → 0.25 m resolution (kerb ≈3 m = 12 px)
// Mask class codes. The physics only distinguishes asphalt/gravel/grass (RIBBON and KERB are
// BOTH asphalt — a kerb is rideable at full grip); the split exists purely so the render can
// give kerbs their own rubber cap and never black out the stripes.
const MASK_GRASS = 0, MASK_ASPHALT = 1, MASK_KERB = 2;
/** Render-only surface class: 'kerb' is split out of 'asphalt'. Physics never sees this. */
export type MarkClass = 'asphalt' | 'kerb' | 'grass' | 'gravel';
let _circuitMask: Uint8Array | null | undefined;
let _maskW = 0, _maskH = 0;
function circuitMask(): Uint8Array | null {
  if (_circuitMask !== undefined) return _circuitMask;
  if (typeof document === 'undefined') { _circuitMask = null; return null; }   // off-DOM tests
  const W = Math.max(1, Math.round(CIRCUIT_LOGICAL.widthM * CIRCUIT_MASK_PPM));
  const H = Math.max(1, Math.round(CIRCUIT_LOGICAL.heightM * CIRCUIT_MASK_PPM));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  if (!c) { _circuitMask = null; return null; }
  const toMask = (sx: number, sy: number): Pt => {
    const w = circuitToWorld(sx, sy);
    return [w.x * CIRCUIT_MASK_PPM, w.y * CIRCUIT_MASK_PPM];
  };
  // Painted in three tones so ONE raster carries the class: grass 0, ribbon MID, kerb HIGH.
  // The PHYSICS only ever asks "is this asphalt" (RIBBON|KERB both → asphalt, exactly as
  // before); the RENDER asks for the class, to give kerbs their own rubber-scuff cap.
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);                 // grass everywhere
  c.strokeStyle = c.fillStyle = '#505050';                      // the ribbon = MID tone
  c.lineJoin = 'round'; c.lineCap = 'round';
  const pts = CIRCUIT_PATH.map((p) => toMask(p[0], p[1]));      // the ribbon, full band width
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
  c.lineWidth = CIRCUIT_TRACK_W * CIRCUIT_MASK_PPM;
  c.stroke();
  c.fillStyle = '#f0f0f0';                                      // every kerb quad = HIGH tone
  for (const q of CIRCUIT_KERBS) {                              // (rideable asphalt to physics)
    const a = toMask(q.a[0], q.a[1]), b = toMask(q.b[0], q.b[1]);
    const d = toMask(q.c[0], q.c[1]), e = toMask(q.d[0], q.d[1]);
    c.beginPath();
    c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineTo(d[0], d[1]); c.lineTo(e[0], e[1]);
    c.closePath(); c.fill();
  }
  const img = c.getImageData(0, 0, W, H).data;
  const mask = new Uint8Array(W * H);
  // Thresholds sit midway between the painted tones, so an anti-aliased edge resolves to
  // whichever side covers it more — the same half-coverage rule the single-tone mask used.
  for (let i = 0; i < W * H; i++) {
    const t = img[i * 4];
    mask[i] = t > 160 ? MASK_KERB : t > 40 ? MASK_ASPHALT : MASK_GRASS;
  }
  _maskW = W; _maskH = H;
  _circuitMask = mask;
  return mask;
}
// Ground lookup: ASPHALT (ribbon + kerbs) wins, else GRAVEL (the traps), else grass. Both
// masks are baked on the SAME grid (CIRCUIT_MASK_PPM === GRAVEL_MASK_PPM over the same world),
// so one index serves both — asserted below so a future ppm change can't silently desync them.
function circuitSurfaceAt(x: number, y: number): Surface {
  const c = circuitClassAt(x, y);
  return c === 'kerb' ? 'asphalt' : c;   // a kerb IS asphalt to the physics (rideable, full grip)
}
/** RENDER-ONLY: the same lookup, but with kerbs split out of asphalt. */
function circuitClassAt(x: number, y: number): MarkClass {
  const m = circuitMask();
  if (!m) return 'asphalt';        // no raster available (off-DOM) → never penalise
  const mx = (x * CIRCUIT_MASK_PPM) | 0, my = (y * CIRCUIT_MASK_PPM) | 0;
  if (mx < 0 || my < 0 || mx >= _maskW || my >= _maskH) return 'grass';   // outside the world = surround
  const i = my * _maskW + mx;
  if (m[i] === MASK_KERB) return 'kerb';
  if (m[i] === MASK_ASPHALT) return 'asphalt';
  const g = gravelMask();
  if (g && _gvW === _maskW && _gvH === _maskH && g[i]) return 'gravel';
  return 'grass';
}
/** Ground under a world point for `map`. Maps with no mask (desktop, ovals) are all asphalt. */
export function surfaceAt(map: MapDefinition, x: number, y: number): Surface {
  return map.surfaceAt ? map.surfaceAt(x, y) : 'asphalt';
}
/**
 * RENDER-ONLY mark class at a world point — 'kerb' split out of 'asphalt' so tyre marks can
 * cap kerb scuffing separately. Maps without a mask report 'asphalt' (their marks are the
 * untouched legacy skid path). NEVER read by the physics.
 */
export function markClassAt(map: MapDefinition, x: number, y: number): MarkClass {
  return map.surfaceAt === circuitSurfaceAt ? circuitClassAt(x, y) : 'asphalt';
}
/** Debug/verification: the baked mask + its dims (builds it on first call). */
export function circuitMaskDebug(): { mask: Uint8Array | null; w: number; h: number; ppm: number } {
  const mask = circuitMask();
  return { mask, w: _maskW, h: _maskH, ppm: CIRCUIT_MASK_PPM };
}
/** Debug/authoring: the sketch↔world mapping (lets a harness convert screen px → sketch coords). */
export function circuitDebugMapping() {
  return { bcx: CS_BCX, bcy: CS_BCY, scale: CS_SCALE, world: CIRCUIT_LOGICAL };
}
/** Debug: the circuit centreline in world METRES (lets a harness drive the real racing line). */
export function circuitCentreline(): Array<[number, number]> {
  return CIRCUIT_PATH.map((p) => {
    const w = circuitToWorld(p[0], p[1]);
    return [w.x, w.y] as [number, number];
  });
}

// ---------- GRAVEL TRAPS (circuit — VISUAL ONLY this pass) ----------
// Placement is authored as a union of overlapping DISCS in SKETCH coords: sketch space is the
// TRACK's own frame, so the traps stay locked to the corners on any display (the world's metre
// size follows window.screen, the track's does not). Discs give organic rounded blobs for free.
// The final shape is then built BY CONSTRUCTION, so the rules can't be violated by hand-authoring:
//   marked discs  −  ( dilate(ribbon, GRAVEL_GRASS_GAP)  ∪  kerbs )   → the ADJACENCY RULE
//   → smooth (box-blur + threshold)                                   → rounded organic boundaries
//   → re-carve                                                        → smoothing can't eat into it
//   → drop connected fragments under GRAVEL_MIN_AREA                  → narrow slivers vanish
// ADJACENCY RULE: gravel ABUTS a KERB directly (kerbs carved undilated), but keeps a car-width
// GRASS strip off BARE asphalt (the ribbon is carved dilated by GRAVEL_GRASS_GAP).
// NOTHING here is physics: surfaceAt / circuitMask / physics4 are untouched, gravel still reads
// 'grass' to the car. The gravel surface type comes in a follow-up once the look is approved.
//
// TUNE:
const CAR_WIDTH_M = CONFIG.wheelbase * (0.309 * 2) * 0.865 / 0.75;  // ≈1.83 m — the RENDERED car
                                      //   body width (drawCar's native half-width 0.309 × its ART
                                      //   scale wheelbase·0.865/0.75), bound to the one ruler.
const GRAVEL_GRASS_GAP = CAR_WIDTH_M; // m — grass strip between BARE ASPHALT and gravel (at a KERB
                                      //   the gravel abuts directly — see the adjacency rule above)
const GRAVEL_MIN_AREA = 70;           // m² — a fragment smaller than this doesn't read as a trap → dropped
const GRAVEL_SMOOTH_R = 5;            // mask px (@4 px/m ⇒ 1.25 m) — boundary rounding radius
const GRAVEL_MASK_PPM = 4;            // px/m for the trap raster
// The gravel LOOK lives in the surface library (GRAVEL_LOOK in surfaces.ts) — a map only says
// WHERE a trap is, never what one looks like. What stays here is the trap SHAPE's own tuning:
// Marked trap areas — [sketchX, sketchY, radius] discs, traced from the boss's marks
// (screen px → sketch = px·0.7509 + [482, 55]). Over-marking toward the track is SAFE: the
// inner boundary is carved off by construction (see carveGap). The narrow sliver between the
// bottom straights is deliberately NOT marked (and would be dropped anyway).
const GRAVEL_BLOBS: Array<[number, number, number]> = [
  // top-LEFT outer sweep + down the left perimeter — KEEP (boss's red = leave as-is)
  [572, 100, 98], [707, 96, 90], [820, 108, 68], [512, 220, 75], [505, 310, 64],
  // top-RIGHT outer sweep + down the right perimeter — KEEP (boss's red = leave as-is)
  [1270, 100, 90], [1420, 93, 98], [1571, 108, 83], [1608, 220, 68], [1612, 310, 56],
  // infield RIGHT — the boss X'd the bulk and drew a red line along the track's edge: ONLY the
  // strip between that line and the track survives (it hugs the track side); the far side is
  // grass again. Centres trail the infield's track edge as it runs diagonally down-left, spaced
  // FAR closer than 2r (≈22 vs 2r≈54) so the union is a smooth tube, not a row of lumps, and the
  // end radii taper down so it eases back into grass instead of stopping on a blunt disc.
  [1229, 333, 20], [1229, 355, 26], [1229, 378, 28], [1222, 400, 28],
  [1207, 423, 28], [1188, 445, 26], [1165, 468, 23], [1143, 491, 19],
  // REMOVED per the boss's black X marks:
  //   · the top-CENTRE trap above/inside the middle dip
  //   · the infield LEFT patch inside the hairpin
];

// Revision-2/3 additions are authored as STROKES — a centre polyline with a PER-POINT radius —
// rather than hand-placed discs, because hand-spacing them is exactly how you get a string of
// beads (get the spacing wrong by a few units and 2r < spacing => the discs stop touching).
// `strokeDiscs` expands each at rMin/2 spacing, which guarantees a smooth tube.
// The radius VARIES along the stroke, which is what lets ONE stroke both (a) swell to fill a
// corner wedge right out to the world edge and (b) start at a neighbouring trap's own local
// width so the two merge FLUSH (no step/shoulder), then taper away to nothing.
// The paths deliberately run OVER the kerb where they should ABUT it: the carve only ever
// REMOVES, so a shape that stops short of the kerb leaves grass between — to abut, it must
// overlap the kerb and let carveGap trim it back to the kerb's own edge. Over-reaching is
// always SAFE (the carve + the world bounds clip it); under-reaching is what leaves a gap.
const GRAVEL_STROKES: Array<Array<[number, number, number]>> = [
  // BOTTOM-LEFT (red hatch) — the FULL outer edge: down the left perimeter (closing the gap
  // between the top-left trap and the corner) and out into the bottom-left corner, the radius
  // SWELLING so the widening wedge is filled right out to the world edges (which clip it).
  // The last leg then runs the WHOLE bottom perimeter to meet the bottom-right stroke's end,
  // so the gravel abuts the bottom straight's kerb like everywhere else (it used to stop at
  // x=707 and leave a grass strip below the blue all the way along the straight). y=704 is the
  // world's bottom edge, so the tube is clipped there; the carve trims its other side back to
  // the kerb's outer edge — leaving exactly the strip between kerb and edge.
  [[490, 340, 34], [491, 408, 34], [497, 476, 38], [518, 543, 52],
   [548, 603, 76], [578, 656, 98], [598, 704, 124], [707, 704, 83], [1410, 704, 83]],
  // BOTTOM-RIGHT (red hatch) — the mirror.
  [[1628, 340, 34], [1626, 408, 34], [1620, 476, 38], [1599, 543, 52],
   [1569, 603, 76], [1539, 656, 98], [1519, 704, 124], [1410, 704, 83]],
  // TOP-MIDDLE-LEFT (red outline) — a tongue down the middle dip's left flank. It STARTS at the
  // top-left trap's own local radius (66) so the two merge flush instead of leaving a shoulder,
  // then tapers away down the flank.
  [[850, 134, 79], [869, 186, 66], [884, 235, 54], [899, 280, 41], [914, 322, 29]],
  // TOP-MIDDLE-RIGHT (red outline) — same, from the top-right sweep's trap toward the dip.
  [[1203, 74, 56], [1158, 115, 39], [1128, 153, 29], [1102, 190, 20]],
];
function strokeDiscs(): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const pts of GRAVEL_STROKES) {
    const seg: number[] = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      seg.push(L); total += L;
    }
    if (total <= 0) continue;
    const step = Math.max(1, Math.min(...pts.map((p) => p[2])) / 2);   // => a tube, never beads
    for (let t = 0; t <= total; t += step) {
      let d = t, i = 0;
      while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
      const f = seg[i] > 0 ? Math.min(1, d / seg[i]) : 0;
      const lerp = (a: number, b: number) => a + (b - a) * f;
      out.push([lerp(pts[i][0], pts[i + 1][0]), lerp(pts[i][1], pts[i + 1][1]),
        lerp(pts[i][2], pts[i + 1][2])]);
    }
  }
  return out;
}
/** Every marked disc: the hand-placed traps + the expanded revision-2 strokes. */
const GRAVEL_DISCS: Array<[number, number, number]> = [...GRAVEL_BLOBS, ...strokeDiscs()];

let _gravelMask: Uint8Array | null | undefined;
let _gvW = 0, _gvH = 0;
function gravelMask(): Uint8Array | null {
  if (_gravelMask !== undefined) return _gravelMask;
  if (typeof document === 'undefined') { _gravelMask = null; return null; }
  const P = GRAVEL_MASK_PPM;
  const W = Math.max(1, Math.round(CIRCUIT_LOGICAL.widthM * P));
  const H = Math.max(1, Math.round(CIRCUIT_LOGICAL.heightM * P));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  if (!c) { _gravelMask = null; return null; }
  const toM = (sx: number, sy: number): Pt => {
    const w = circuitToWorld(sx, sy); return [w.x * P, w.y * P];
  };
  // 1. the MARKED areas — union of discs, GROWN back over whatever the kerbs vacated.
  //    Narrowing the kerbs (KERB_NARROW) frees a strip of what used to be kerb. A trap that
  //    ABUTTED a kerb must follow it in — but the discs were hand-marked to the OLD kerb edge,
  //    so on their own they'd leave an orphan grass strip between kerb and trap. So grow every
  //    disc by the vacated width first. Dilating a UNION of discs is EXACTLY the union of the
  //    grown discs (Minkowski sum distributes over union), so this needs no raster dilation.
  //    The carve below then trims the growth back to the true boundary — the kerb's NEW edge,
  //    or the car-width grass strip off bare asphalt — so this can only ever fill what the
  //    narrowing vacated, never overrun a rule.
  const REGROW_U = KERB_FULL_W * (1 / KERB_NARROW - 1);   // sketch u the narrowing freed up
  c.fillStyle = '#fff';
  for (const [sx, sy, r] of GRAVEL_DISCS) {
    const [x, y] = toM(sx, sy);
    c.beginPath(); c.arc(x, y, (r + REGROW_U) * CS_SCALE * P, 0, Math.PI * 2); c.fill();
  }
  // 1b. …but CLIP that growth to the track's old-kerb neighbourhood, so the traps' OUTER
  //     (grass-side) silhouettes — the boss's marks — cannot move. Allowed = the ORIGINAL
  //     discs ∪ the ribbon dilated by the kerbs' pre-narrowing reach. Away from the track the
  //     growth is clipped straight back to the marked shape.
  {
    const allow = document.createElement('canvas'); allow.width = W; allow.height = H;
    const ac = allow.getContext('2d');
    if (ac) {
      ac.fillStyle = '#fff'; ac.strokeStyle = '#fff';
      ac.lineJoin = 'round'; ac.lineCap = 'round';
      for (const [sx, sy, r] of GRAVEL_DISCS) {
        const [x, y] = toM(sx, sy);
        ac.beginPath(); ac.arc(x, y, r * CS_SCALE * P, 0, Math.PI * 2); ac.fill();
      }
      const oldReachM = (KERB_FULL_W / KERB_NARROW) * CS_SCALE;   // what a kerb used to reach
      const rp = CIRCUIT_PATH.map((p) => toM(p[0], p[1]));
      ac.lineWidth = (CIRCUIT_TRACK_W + 2 * oldReachM) * P;
      ac.beginPath(); ac.moveTo(rp[0][0], rp[0][1]);
      for (let i = 1; i < rp.length; i++) ac.lineTo(rp[i][0], rp[i][1]);
      ac.closePath(); ac.stroke();
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(allow, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
  }
  // 2. carve the MANDATORY grass gap = erase asphalt+kerbs DILATED by GRAVEL_GRASS_GAP.
  //    (A stroke of width 2·gap around a shape IS its dilation by gap — round joins/caps.)
  const carveGap = () => {
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = '#000'; c.fillStyle = '#000';
    c.lineJoin = 'round'; c.lineCap = 'round';
    // RIBBON, dilated by the gap → where the edge is BARE ASPHALT the gravel is held a full
    // car width away (the grass strip).
    const pts = CIRCUIT_PATH.map((p) => toM(p[0], p[1]));
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    c.lineWidth = (CIRCUIT_TRACK_W + 2 * GRAVEL_GRASS_GAP) * P;
    c.stroke();
    // KERBS, carved UNDILATED → the gravel ABUTS a kerb DIRECTLY (no grass between them).
    // The rule falls straight out of the union: a kerb reaches FULL_W (≈4.3 m) past the ribbon
    // edge, FURTHER than the gap-dilated ribbon (1.83 m), so on a kerbed stretch the kerb's own
    // grass edge is what stops the gravel; on a bare stretch the dilated ribbon is. At a wedge
    // tip the kerb thins away and the dilated ribbon takes over ⇒ the transition from
    // abutting-the-kerb to grass-strip is automatic and smooth. `KERB_SEAL` only closes the
    // hairline seams between adjacent kerb quads (they are separate slices) — it is a
    // quarter-metre, not a gap.
    const KERB_SEAL = 1;   // mask px
    for (const q of CIRCUIT_KERBS) {
      const a = toM(q.a[0], q.a[1]), b = toM(q.b[0], q.b[1]);
      const d = toM(q.c[0], q.c[1]), e = toM(q.d[0], q.d[1]);
      c.beginPath();
      c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineTo(d[0], d[1]); c.lineTo(e[0], e[1]);
      c.closePath();
      c.fill();
      c.lineWidth = KERB_SEAL; c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
  };
  carveGap();
  // 3. read the alpha out
  const px = c.getImageData(0, 0, W, H).data;
  let m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  // 4. SMOOTH — separable box blur + threshold ⇒ rounded organic boundaries, thin necks pinched off
  const blurThreshold = (src: Uint8Array, r: number) => {
    const tmp = new Float32Array(W * H), dst = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {         // horizontal
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * W + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = acc / (2 * r + 1);
        acc -= src[y * W + Math.min(W - 1, Math.max(0, x - r))];
        acc += src[y * W + Math.min(W - 1, Math.max(0, x + r + 1))];
      }
    }
    for (let x = 0; x < W; x++) {         // vertical
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        dst[y * W + x] = acc / (2 * r + 1) >= 0.5 ? 1 : 0;
        acc -= tmp[Math.min(H - 1, Math.max(0, y - r)) * W + x];
        acc += tmp[Math.min(H - 1, Math.max(0, y + r + 1)) * W + x];
      }
    }
    return dst;
  };
  m = blurThreshold(m, GRAVEL_SMOOTH_R);
  // 5. re-carve the gap (smoothing must never eat into the mandatory strip), via the canvas
  const img = c.createImageData(W, H);
  for (let i = 0; i < W * H; i++) if (m[i]) { img.data[i * 4 + 3] = 255; img.data[i * 4] = 255; }
  c.globalCompositeOperation = 'copy'; c.putImageData(img, 0, 0);
  c.globalCompositeOperation = 'source-over';
  carveGap();
  const px2 = c.getImageData(0, 0, W, H).data;
  for (let i = 0; i < W * H; i++) m[i] = px2[i * 4 + 3] > 127 ? 1 : 0;
  // 6. DROP small fragments — flood-fill connected components, keep only real traps
  const minPx = GRAVEL_MIN_AREA * P * P;
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let i0 = 0; i0 < W * H; i0++) {
    if (!m[i0] || seen[i0]) continue;
    stack.length = 0; stack.push(i0); seen[i0] = 1;
    const comp: number[] = [];
    while (stack.length) {
      const i = stack.pop()!; comp.push(i);
      const x = i % W, y = (i / W) | 0;
      if (x > 0 && m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < W - 1 && m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && m[i - W] && !seen[i - W]) { seen[i - W] = 1; stack.push(i - W); }
      if (y < H - 1 && m[i + W] && !seen[i + W]) { seen[i + W] = 1; stack.push(i + W); }
    }
    if (comp.length < minPx) for (const i of comp) m[i] = 0;
  }
  _gvW = W; _gvH = H; _gravelMask = m;
  return m;
}

// GRAVEL TRAP SHAPE — the trap geometry, handed to the gravel SURFACE (surfaces.ts) to fill.
// It comes from the physics mask, so what you SEE is exactly where the car plows — but that
// mask is a 4 px/m raster, and blowing it up to the screen would show its staircase (the old
// "chewed" edge). Cured by BLUR + THRESHOLD, the same rounding the mask itself is built with:
// blur wide enough to average the steps into the curve they approximate, then re-sharpen that
// curve back to a vector-clean AA edge. Reads like the asphalt's stroke; the physics mask is
// only READ (never modified), and the blur is symmetric so the mandatory car-width grass gap
// survives untouched.
const GRAVEL_EDGE_SMOOTH_PX = 6;   // screen px — blur that averages the raster's step away
const GRAVEL_EDGE_AA_PX = 1.4;     // screen px — the AA ramp left on the re-sharpened curve

const gravelShape: SurfaceShape = (m, rc) => {
  const mask = gravelMask();
  if (!mask || typeof document === 'undefined') return;
  const mc = document.createElement('canvas'); mc.width = _gvW; mc.height = _gvH;
  const mcx = mc.getContext('2d'); if (!mcx) return;
  const img = mcx.createImageData(_gvW, _gvH);
  for (let i = 0; i < _gvW * _gvH; i++) if (mask[i]) img.data[i * 4 + 3] = 255;
  mcx.putImageData(img, 0, 0);

  m.filter = `blur(${GRAVEL_EDGE_SMOOTH_PX}px)`;             // destination px
  m.drawImage(mc, 0, 0, rc.wPx, rc.hPx);
  m.filter = 'none';

  // Re-sharpen: smoothstep the blurred alpha about 0.5 over a band narrow enough to leave
  // ~GRAVEL_EDGE_AA_PX of ramp (the blur's ramp spans ≈GRAVEL_EDGE_SMOOTH_PX, so the band
  // is that ratio of it). Alpha only — the fill is composited in later, source-in.
  const big = m.getImageData(0, 0, rc.wPx, rc.hPx), d = big.data;
  const w = Math.max(0.01, 0.5 * GRAVEL_EDGE_AA_PX / GRAVEL_EDGE_SMOOTH_PX);
  for (let i = 3; i < d.length; i += 4) {
    let t = (d[i] / 255 - (0.5 - w)) / (2 * w);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    d[i] = 255 * t * t * (3 - 2 * t);
  }
  m.putImageData(big, 0, 0);
};

// One surface (asphalt) fills from an image asset, which arrives async. Re-export the library's
// hook so desktop.ts can repaint the static wallpaper layer once it lands (one-shot, cheap).
// Until then the asphalt surface fills with its own preload tone — a texture fallback, NOT a
// second render path (the layer stack below is the only one).
export function setCircuitSurfaceReady(cb: () => void): void { onSurfaceAssetsReady(cb); }

// WHITE TRACK EDGE LINES — a thin off-white line inside BOTH asphalt edges, real-circuit style.
// Soft alpha so it never glares. It is TRACK PAINT and it is VISIBLE THE WHOLE LAP: one continuous
// closed polyline per side, never hidden and never gapped. Two states, eased between:
//   · no kerb  → WHITE_LINE_INSET_M from the grass edge, leaving a strip of asphalt outside it;
//   · a kerb   → its OUTER edge lands EXACTLY on the kerb's VISIBLE inner edge (the fill boundary
//     at KERB_SEAM plus half the soft stroke that feathers it), so the two abut with no asphalt
//     sliver between them and no white lost beneath — the line reads as bordered by the kerb, its
//     full width still on the asphalt.
// CIRCUIT_KERB_EASE ramps between the two across the wedges, so no join needs a special case.
// Drawn UNDER the kerbs (it is paint): at exact abutment only the kerb's AA edge laps the line's.
// Skid marks composite on top (rubber covers paint).
const WHITE_LINE_INSET_M = 0.55;   // m — kerb-free: from the grass edge inward to the line's centre
const WHITE_LINE_W_M = 0.34;       // m — line width
const WHITE_LINE_RGB = '238,240,242';
const WHITE_LINE_ALPHA = 0.7;

/**
 * The line's polyline for one side, in SKETCH space (closed). ci 0 = side +1, 1 = side −1.
 * Depends on `s` because the kerb's soft stroke — which the abutment has to clear — is authored
 * in pixels; at any normal zoom it works out to a constant CS_BAND·0.02 of sketch.
 */
function circuitEdgeLinePts(ci: 0 | 1, s: number): Pt[] {
  const N = CIRCUIT_PATH.length, idx = (i: number) => ((i % N) + N) % N;
  const side = ci === 0 ? 1 : -1;
  const ease = CIRCUIT_KERB_EASE[ci];
  const halfW = (WHITE_LINE_W_M / CS_SCALE) / 2;
  const freeInset = WHITE_LINE_INSET_M / CS_SCALE;                  // no kerb: the original look
  const softU = kerbSoftPx(CS_BAND * s) / s;                        // the kerb's feather, in sketch
  const kerbInset = KERB_SEAM + softU / 2 + halfW;                  // outer edge ON the kerb's edge
  const pts: Pt[] = [];
  for (let i = 0; i < N; i++) {
    const a = CIRCUIT_PATH[idx(i - 1)], c = CIRCUIT_PATH[idx(i + 1)], p = CIRCUIT_PATH[i];
    let tx = c[0] - a[0], ty = c[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const d = CS_BAND / 2 - (freeInset + (kerbInset - freeInset) * ease[i]);
    pts.push([p[0] + side * -ty * d, p[1] + side * tx * d]);
  }
  return pts;
}

function drawCircuitEdgeLines(ctx: CanvasRenderingContext2D, offX: number, offY: number,
  s: number, pxPerM: number) {
  ctx.save();
  ctx.strokeStyle = `rgba(${WHITE_LINE_RGB},${WHITE_LINE_ALPHA})`;
  ctx.lineWidth = Math.max(1, WHITE_LINE_W_M * pxPerM);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const ci of [0, 1] as const) {
    const pts = circuitEdgeLinePts(ci, s).map(
      (p) => [offX + p[0] * s, offY + p[1] * s] as Pt,
    );
    tracePolyline(ctx, pts);   // closed — the loop is a loop
    ctx.stroke();
  }
  ctx.restore();
}

// THE CIRCUIT SURFACE — an ordered stack of independent baked layers. Every boundary is cut by
// GEOMETRY (the spline ribbon / the disc-union trap shape), and each layer's own anti-aliased
// path IS its edge — that is what makes every transition oval-grade. The surfaces themselves
// (look + grip + marks + dust) come from the game-wide library; this map only says WHERE.
// Fits the sketch into whatever canvas it is given (game world OR the map-select preview),
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
  const rc: SurfaceRC = { wPx, hPx, pxPerM };

  // 1. GRASS — the whole field (everything else is laid on top of it).
  SURFACES.grass.paint(ctx, (m, r) => { m.fillRect(0, 0, r.wPx, r.hPx); }, rc);

  // 2. GRAVEL — the trap shapes (disc union, carved a car-width off the track, soft edge).
  SURFACES.gravel.paint(ctx, gravelShape, rc);

  // 3. ASPHALT — the ribbon. The GEOMETRY cuts (a CIRCUIT_PATH stroke at the band width);
  //    the surface's approved tarmac fill (light tone + worn ideal line) fills it.
  SURFACES.asphalt.paint(ctx, (m) => {
    tracePolyline(m, ptsPx);
    m.lineWidth = twPx;
    m.stroke();
  }, rc);

  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // 4. WHITE EDGE LINES + the painted starting grid — track paint, so they go under the
  //    kerbs (which lap over them) and under the cars/skids.
  drawCircuitEdgeLines(ctx, offX, offY, s, pxPerM);
  drawCircuitGrid(ctx, offX, offY, s, pxPerM);

  // 5. KERBS — red/white striped curbs + blue border, drawn ON TOP of the asphalt (each
  // quad is a perpendicular slice). Blue first (underneath), stripes over (CIRCUIT_KERBS is
  // z-sorted). Each quad is FILLED and lightly STROKED in its own colour (round joins,
  // ~1 px) → subtly softened edges (not knife-edged) + the stroke overlaps neighbours so no
  // seam sliver shows. Purely visual + drivable (no collision). Scale-agnostic (sketch → px).
  const softPx = kerbSoftPx(twPx);   // ~1 px edge feather; the edge line abuts what this paints
  for (const q of CIRCUIT_KERBS) {
    ctx.beginPath();
    ctx.moveTo(offX + q.a[0] * s, offY + q.a[1] * s);
    ctx.lineTo(offX + q.b[0] * s, offY + q.b[1] * s);
    ctx.lineTo(offX + q.c[0] * s, offY + q.c[1] * s);
    ctx.lineTo(offX + q.d[0] * s, offY + q.d[1] * s);
    ctx.closePath();
    ctx.fillStyle = q.fill; ctx.fill();
    ctx.strokeStyle = q.fill; ctx.lineWidth = softPx; ctx.stroke();
  }

  // 6. START LINE. (7. the SKID layer composites on top of all of this, in desktop.ts.)
  drawCircuitStartLine(ctx, offX, offY, s, twPx, pxPerM);
}

// START/FINISH — one plain white line across the bottom straight at CIRCUIT_FINISH, in the
// same paint family and weight as the edge lines and the grid boxes.
function drawCircuitStartLine(
  ctx: CanvasRenderingContext2D, offX: number, offY: number, s: number, twPx: number, pxPerM: number,
) {
  const fx = offX + CIRCUIT_FINISH.x * s, fy = offY + CIRCUIT_FINISH.y * s;
  ctx.save();
  ctx.strokeStyle = `rgba(${WHITE_LINE_RGB},${WHITE_LINE_ALPHA})`;
  ctx.lineWidth = Math.max(1, WHITE_LINE_W_M * pxPerM);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(fx, fy - twPx / 2);
  ctx.lineTo(fx, fy + twPx / 2);
  ctx.stroke();
  ctx.restore();
}

// ---------- PAINTED STARTING GRID ----------
// 12 boxes, 3 rows × 4 columns, behind the line (+x) on the flat bottom straight, which is
// driven −x. P1 = row 1 on the INNER side (the infield/kerb side = −y here, the side the apex
// kerbs point to); P2..P4 step OUTWARD; row 2 = P5..P8, row 3 = P9..P12. Every distance is
// wheelbase-derived, so the grid stays on the one ruler and 12 cars fit with no overlap.
const GRID_COLS = 3;
const GRID_ROWS = 4;                              // painted boxes = COLS × ROWS = 12
const GRID_ROW_PITCH = CONFIG.wheelbase * 3.0;    // m ≈ 7.70 — box is 5.13 long ⇒ 2.6 m between rows
const GRID_STAGGER = CONFIG.wheelbase * 1.0;      // m ≈ 2.57 — echelon: each column sits this far back
const GRID_FRONT_GAP = CONFIG.wheelbase * 1.73;   // m ≈ 4.44 — line → P1 (one car length)
const GRID_BOX_W = CONFIG.wheelbase * 1.44;       // m ≈ 3.69 — box across (car is 1.83 wide)
const GRID_BOX_L = CONFIG.wheelbase * 2.0;        // m ≈ 5.13 — box along (car is 4.44 long)
const GRID_BOX_ARM = CONFIG.wheelbase * 1.5;      // m ≈ 3.85 — arms run alongside ~¾ of the car
const GRID_EDGE_CLEAR = CAR_WIDTH_M / 2;          // m ≈ 0.92 — required: outer ARM → edge line
// How far in from the band's edge the white edge line's INNER face can reach — the worse of its
// two states, the kerbed side, where it sits a little further in. Mirrors circuitEdgeLinePts'
// own offsets (KERB_SEAM + half the kerb's soft stroke + half the line), so the two can't drift.
const WHITE_LINE_REACH_M = Math.max(
  WHITE_LINE_INSET_M,
  (KERB_SEAM + CS_BAND * 0.01) * CS_SCALE + WHITE_LINE_W_M / 2,
) + WHITE_LINE_W_M / 2;
// Lateral pitch, DERIVED FROM THE BAND — never a fixed metre value. CIRCUIT_TRACK_W comes from the
// host's SCREEN (via FLAT_LOGICAL), so a pitch hardcoded to suit a 1920-wide screen pushes the arms
// clean off the asphalt on a narrower one. Only the clearance is absolute, because the car is
// 1.83 m on every screen.
//   · the ceiling is where each outer ARM would stop exactly GRID_EDGE_CLEAR short of its edge line
//   · GRID_COL_TIGHTEN then squeezes the columns back toward the centre (so the real gap to the
//     lines is larger than the minimum — "alespoň ½ šířky auta" is a floor, not a target)
//   · floored so the boxes can never overlap each other on a very small display
const GRID_COL_TIGHTEN = 0.75;                    // 1 = out at the lines · lower = tighter cluster
const GRID_COL_PITCH = Math.max(
  GRID_BOX_W * 1.1,
  (CIRCUIT_TRACK_W / 2 - WHITE_LINE_REACH_M - GRID_EDGE_CLEAR - GRID_BOX_W / 2) * GRID_COL_TIGHTEN,
);
// Which way the half-frame opens. +1 = arms forward with the bar behind the car (the real-grid
// convention); −1 = MIRRORED — bar ahead of the nose, open end facing backward. −1 is the boss's
// call, matching his original sketch; he confirmed it knowing the bar lands in front of the nose.
const GRID_BOX_OPEN_FORWARD = -1;

/**
 * Where a 0-based slot starts, relative to the line: `back` = metres AGAINST the racing
 * direction (+x), `lane` = metres across (+y = OUTWARD, so slot 0 is the inner-most).
 * Rows are unbounded on purpose — see circuitMap.spawn for what happens past the 12th box.
 */
function circuitGridPose(slot: number): { back: number; lane: number } {
  const col = slot % GRID_COLS;
  const row = Math.floor(slot / GRID_COLS);
  return {
    back: GRID_FRONT_GAP + row * GRID_ROW_PITCH + col * GRID_STAGGER,
    lane: (col - (GRID_COLS - 1) / 2) * GRID_COL_PITCH,
  };
}

// The 12 painted positions: a half-frame per box, OPEN toward the racing direction (−x) —
// closed bar at the back, two arms reaching forward alongside the car, so the nose sits at
// the open end. Paint, so it uses the edge line's colour/alpha/weight and goes under the
// cars + skids. (The boss's sketch drew the bracket mirrored; the spec's "open toward racing
// direction" wins, and it is what a real grid box does — flip ARM's sign to mirror it.)
function drawCircuitGrid(ctx: CanvasRenderingContext2D, offX: number, offY: number,
  s: number, pxPerM: number) {
  const u = (m: number) => m / CS_SCALE;   // metres → sketch units (the straight is flat + horizontal)
  ctx.save();
  ctx.strokeStyle = `rgba(${WHITE_LINE_RGB},${WHITE_LINE_ALPHA})`;
  ctx.lineWidth = Math.max(1, WHITE_LINE_W_M * pxPerM);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
    const g = circuitGridPose(i);
    const cx = CIRCUIT_FINISH.x + u(g.back), cy = CIRCUIT_FINISH.y + u(g.lane);
    const o = GRID_BOX_OPEN_FORWARD;           // +1 opens −x (racing dir), −1 mirrors it
    const bx = cx + o * u(GRID_BOX_L / 2);     // the closed back bar
    const ax = bx - o * u(GRID_BOX_ARM);       // …arms reach this far toward the open end
    const hy = u(GRID_BOX_W / 2);
    const px = (x: number) => offX + x * s, py = (y: number) => offY + y * s;
    ctx.beginPath();
    ctx.moveTo(px(ax), py(cy - hy));
    ctx.lineTo(px(bx), py(cy - hy));
    ctx.lineTo(px(bx), py(cy + hy));
    ctx.lineTo(px(ax), py(cy + hy));
    ctx.stroke();
  }
  ctx.restore();
}

// ---- CIRCUIT BILLBOARDS ----------------------------------------------------------------------
// Two placeholder "YOUR AD HERE" billboards standing on the inner grass infield, stacked
// vertically (upper-middle + lower-middle). Each is a SOLID obstacle (its base footprint feeds
// world.rects → the existing capsule-vs-rect springy collision, restitution 0.35). Positions are
// SKETCH coords (track-relative, so they stay put on any screen), like CIRCUIT_FINISH.
// ============================================================================================
//  BILLBOARDS = AD SLOTS.  Each billboard is a stand-on-the-grass ad slot.
//
//  HOW TO PUT AN AD IN A SLOT (no DB, no admin — just edit this list):
//    add an `ad` to the entry, e.g.
//      { sx: 988, sy: 195, scale: 1.333, ad: { img: '/ads/steerit.png', url: 'https://steerit.app' } }
//    • `img`  = the artwork/logo. Drop the file in `public/ads/` and reference it as
//               '/ads/<file>' (Vite serves public/ at the site root), or use a full https URL.
//    • `url`  = where clicking the billboard sends the player (opens in a NEW TAB).
//    No `ad` ⇒ the slot shows the "YOUR AD HERE" placeholder and is NOT clickable.
//
//  Positions are SKETCH coords (track-relative → stable on any screen); scale 1 = the reference
//  size of the two originals. This plain list maps 1:1 to a future Supabase row
//  (map_id, sx, sy, scale, ad_img, ad_url) — moving it there is a data-source swap, not a rewrite.
// ============================================================================================
export interface AdSlot {
  readonly img: string;   // '/ads/<file>' (in public/ads/) or a full https URL — the ad artwork
  readonly url: string;   // click-through target, opened in a new tab
}
interface Billboard { sx: number; sy: number; scale: number; ad?: AdSlot; }
const CIRCUIT_BILLBOARDS: Billboard[] = [
  { sx: 1351, sy: 369, scale: 1 },       // UPPER-right pocket
  { sx: 1291, sy: 494, scale: 1 },       // below-left
  { sx: 988,  sy: 195, scale: 1.333 },   // top-centre, 1.33×
  // Example live ad (add `ad: {...}` to any entry above):
  //   { sx: 988, sy: 195, scale: 1.333, ad: { img: '/ads/example.png', url: 'https://example.com' } }
];
const BILLBOARD_W_M = 26.1;      // board width (metres) at scale 1 — sized so it reads big top-down
const BILLBOARD_BOARD_H_M = 10.5; // panel height (metres) at scale 1
const BILLBOARD_POST_H_M = 5.6;   // legs lift the panel this far above the base (metres) at scale 1
const BILLBOARD_LEG_DX_M = BILLBOARD_W_M * 0.33;   // each leg's offset from centre (matches drawBillboard)
const BILLBOARD_LEG_R = BILLBOARD_W_M * 0.045 / 2; // collision radius = the drawn leg's (post) radius

// Collision: a small CIRCLE the diameter of the leg (post) at EACH leg's exact ground-contact point
// — a solid round obstacle (full-circle arc, car stays outside), NOT a base plate. One per leg, and
// the whole billboard (legs + reach) scales with its per-billboard `scale`.
function circuitBillboardArcs(): ObstacleArc[] {
  const out: ObstacleArc[] = [];
  for (const bb of CIRCUIT_BILLBOARDS) {
    const w = circuitToWorld(bb.sx, bb.sy);
    for (const dx of [-BILLBOARD_LEG_DX_M * bb.scale, BILLBOARD_LEG_DX_M * bb.scale]) {
      out.push({ cx: w.x + dx, cy: w.y, r: BILLBOARD_LEG_R * bb.scale, a0: 0, a1: Math.PI * 2, inside: false });
    }
  }
  return out;
}

// An ad's click URL if a WORLD point falls on a configured billboard's clickable PANEL FACE, else
// null (placeholders and non-face points are not clickable). Face rect = the drawn panel, in world
// metres — kept in sync with drawBillboardBody via the shared BILLBOARD_*_M constants.
function circuitAdAt(xM: number, yM: number): string | null {
  for (let i = CIRCUIT_BILLBOARDS.length - 1; i >= 0; i--) {   // topmost (last-drawn) first
    const bb = CIRCUIT_BILLBOARDS[i];
    if (!bb.ad) continue;
    const w = circuitToWorld(bb.sx, bb.sy);
    const halfW = BILLBOARD_W_M * bb.scale / 2;
    const panelBottom = w.y - BILLBOARD_POST_H_M * bb.scale;
    const panelTop = panelBottom - BILLBOARD_BOARD_H_M * bb.scale;
    if (xM >= w.x - halfW && xM <= w.x + halfW && yM >= panelTop && yM <= panelBottom) return bb.ad.url;
  }
  return null;
}

// Ad images load async; a billboard BODY is redrawn every frame (drawAboveCars), so once an image
// decodes it simply appears next frame — no re-bake needed. Returns the image only once decoded
// (else null → the "YOUR AD HERE" placeholder shows meanwhile / if there is no ad).
const _adImgs = new Map<string, { img: HTMLImageElement; ready: boolean }>();
function adImage(src: string): HTMLImageElement | null {
  let e = _adImgs.get(src);
  if (!e) {
    if (typeof Image === 'undefined') return null;
    const img = new Image();
    e = { img, ready: false };
    _adImgs.set(src, e);
    img.src = src;
    const done = () => { e!.ready = true; };
    if (typeof img.decode === 'function') img.decode().then(done).catch(() => { /* keep placeholder */ });
    else img.onload = () => { if (img.naturalWidth > 0) done(); };
  }
  return e.ready ? e.img : null;
}

// A standing billboard is drawn in TWO passes so a car can drive UNDER it and hide behind it:
//   • the SHADOW sits on the grass (drawObstacles → under the cars);
//   • the BODY (posts + raised panel) is drawn AFTER the cars (drawAboveCars → occludes a car
//     passing under the panel). cxPx,cyPx = the ground/base centre in px.
function drawBillboardShadow(ctx: CanvasRenderingContext2D, cxPx: number, cyPx: number, px: number) {
  const W = BILLBOARD_W_M * px, halfW = W / 2, postH = 4.0 * px, depth = Math.max(3, W * 0.05);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  ctx.ellipse(cxPx + depth * 0.6, cyPx + depth * 0.5, halfW * 1.02, Math.max(4, postH * 0.34), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBillboardBody(
  ctx: CanvasRenderingContext2D, cxPx: number, cyPx: number, px: number, ad?: AdSlot,
) {
  const W = BILLBOARD_W_M * px;
  const boardH = BILLBOARD_BOARD_H_M * px;   // panel height on screen
  const postH = BILLBOARD_POST_H_M * px;     // legs lift the panel above the base
  const panelBottom = cyPx - postH;
  const panelTop = panelBottom - boardH;
  const halfW = W / 2;
  const legX1 = cxPx - BILLBOARD_LEG_DX_M * px, legX2 = cxPx + BILLBOARD_LEG_DX_M * px;   // = the collision feet
  const depth = Math.max(2, W * 0.0333); // extruded thickness (down/right) for the 3D read (2/3 = thinner)

  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // Posts (legs) from the base up to the panel.
  ctx.strokeStyle = '#2c2f38';
  ctx.lineWidth = Math.max(2, W * 0.045);
  ctx.beginPath();
  ctx.moveTo(legX1, cyPx); ctx.lineTo(legX1, panelBottom);
  ctx.moveTo(legX2, cyPx); ctx.lineTo(legX2, panelBottom);
  ctx.stroke();
  // little feet
  ctx.fillStyle = '#23252c';
  ctx.fillRect(legX1 - W * 0.03, cyPx - Math.max(2, W * 0.02), W * 0.06, Math.max(3, W * 0.03));
  ctx.fillRect(legX2 - W * 0.03, cyPx - Math.max(2, W * 0.02), W * 0.06, Math.max(3, W * 0.03));

  // Extruded thickness behind the panel (bottom + right) → depth.
  ctx.fillStyle = '#1b1d23';
  ctx.beginPath();
  ctx.moveTo(cxPx - halfW, panelBottom);
  ctx.lineTo(cxPx - halfW + depth, panelBottom + depth);
  ctx.lineTo(cxPx + halfW + depth, panelBottom + depth);
  ctx.lineTo(cxPx + halfW + depth, panelTop + depth);
  ctx.lineTo(cxPx + halfW, panelTop);
  ctx.lineTo(cxPx + halfW, panelBottom);
  ctx.closePath();
  ctx.fill();

  // Panel frame (dark) + face (light) — the readable ad surface, upright toward the camera.
  const fr = Math.max(1.5, W * 0.02);   // panel frame width (2/3 = thinner)
  ctx.fillStyle = '#14161c';
  ctx.fillRect(cxPx - halfW, panelTop, W, boardH);
  const faceGrad = ctx.createLinearGradient(0, panelTop, 0, panelBottom);
  faceGrad.addColorStop(0, '#fbfaf5'); faceGrad.addColorStop(1, '#e6e3d8');
  ctx.fillStyle = faceGrad;
  ctx.fillRect(cxPx - halfW + fr, panelTop + fr, W - 2 * fr, boardH - 2 * fr);

  // Face content: a configured AD image (fitted + centred, "printed" on the upright face), else
  // the "YOUR AD HERE" placeholder. The face is a flat upright rectangle = the player-facing
  // orientation, so the ad follows the same look as the text did.
  const faceX = cxPx - halfW + fr, faceY = panelTop + fr, faceW = W - 2 * fr, faceH = boardH - 2 * fr;
  const img = ad ? adImage(ad.img) : null;
  if (img) {
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
    const sc = Math.min(faceW / iw, faceH / ih);   // contain: whole artwork visible, aspect kept
    const dw = iw * sc, dh = ih * sc;
    ctx.save();
    ctx.beginPath(); ctx.rect(faceX, faceY, faceW, faceH); ctx.clip();
    ctx.drawImage(img, faceX + (faceW - dw) / 2, faceY + (faceH - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    // Placeholder text: "YOUR AD" / "HERE", centred, bold, dark — clear from top-down.
    const cyText = (panelTop + panelBottom) / 2;
    ctx.fillStyle = '#20222a';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = boardH * 0.30;
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.fillText('YOUR AD', cxPx, cyText - fs * 0.6);
    ctx.fillText('HERE', cxPx, cyText + fs * 0.6);
    // a thin brand-warm accent bar under the text
    ctx.fillStyle = 'rgba(232,120,60,0.9)';
    ctx.fillRect(cxPx - halfW + fr * 1.5, panelBottom - fr * 1.5 - Math.max(2, boardH * 0.04), W - 3 * fr, Math.max(2, boardH * 0.04));
  }
  ctx.restore();
}

// Shadows on the grass (under the cars). The base sits at (w.x,w.y)·px; the billboard is drawn at
// px·scale so every dimension scales with its per-billboard `scale` (position stays put).
function drawCircuitBillboardShadows(ctx: CanvasRenderingContext2D, px: number) {
  for (const bb of CIRCUIT_BILLBOARDS) {
    const w = circuitToWorld(bb.sx, bb.sy);
    drawBillboardShadow(ctx, w.x * px, w.y * px, px * bb.scale);
  }
}
// Bodies (posts + panel + ad/placeholder) over the cars — a car under a panel hides behind it.
function drawCircuitBillboardsAbove(ctx: CanvasRenderingContext2D, px: number) {
  for (const bb of CIRCUIT_BILLBOARDS) {
    const w = circuitToWorld(bb.sx, bb.sy);
    drawBillboardBody(ctx, w.x * px, w.y * px, px * bb.scale, bb.ad);
  }
}

export const circuitMap: MapDefinition = {
  id: 'circuit',
  name: 'Circuit',
  // CIRCUIT: the built-in start/finish below is start AND finish, so the editor shows the
  // LAPS panel (0 = free-roam, N = an N-lap race) instead of the place-elements palette —
  // exactly like the ovals.
  trackType: 'circuit',
  smokeColor: [248, 248, 251],    // white rubber smoke (asphalt), matching the oval
  fixedWorld: CIRCUIT_LOGICAL,    // = one screen ⇒ oval-style render (car standard size)

  // Ribbon + kerbs = asphalt, the rest = grass (baked bitmap, O(1) lookup). Supplying this
  // is what ARMS the per-wheel grass grip/drag in physics4 — no other map defines it.
  surfaceAt: circuitSurfaceAt,

  // OPEN track: NO edge barriers — drive off onto the grass freely. The only collision is the
  // infield BILLBOARD LEGS — a small solid circle (leg diameter) at each grass leg's ground point.
  createWorld(widthM, heightM) {
    return { width: widthM, height: heightM, rects: [], arcs: circuitBillboardArcs() };
  },

  drawBackground(ctx, wPx, hPx) { drawCircuitSurface(ctx, wPx, hPx); },
  // Under the cars: the billboards' ground shadows only.
  drawObstacles(ctx, _world, px) { drawCircuitBillboardShadows(ctx, px); },
  // Over the cars: the raised billboard bodies (posts + panel + ad) — a car driving under a
  // panel passes UNDER it and hides behind it.
  drawAboveCars(ctx, _world, px) { drawCircuitBillboardsAbove(ctx, px); },
  // Ad click hit-test (billboard faces) — for the pointer cursor + click-to-open in desktop.ts.
  adAt(xM, yM) { return circuitAdAt(xM, yM); },

  // Built-in start/finish: a START gate on the flat bottom straight, spanning the track
  // width so a car always trips it. In circuit mode this single gate is start AND finish,
  // and the ARMED full-lap mechanism is the oval's, unchanged (race.ts is not touched).
  startLine(world) {
    void world;
    const c = circuitToWorld(CIRCUIT_FINISH.x, CIRCUIT_FINISH.y);
    const far = circuitToWorld(CIRCUIT_FAR.x, CIRCUIT_FAR.y);
    return {
      type: 'start',
      x: c.x,
      y: c.y,
      radius: CIRCUIT_TRACK_W / 2,     // spans the band → can't be driven around
      angle: Math.PI / 2,              // the gate lies ACROSS the horizontal straight
      // CLOCKWISE: cars cross the bottom straight RIGHT→LEFT, so only a −x crossing
      // counts. Reversing (+x) back over the line does not.
      forward: Math.PI,
      // The lap ARMS only once the car reaches the far point (see CIRCUIT_FAR — the point
      // that maximises the shortcut a farmer would have to drive), so back-and-forth over
      // the line, or circling at it, never complete a lap. Generous radius (one track
      // width), as on the oval.
      farX: far.x,
      farY: far.y,
      farRadius: CIRCUIT_TRACK_W,
    };
  },

  // Grid spawn on the flat finish straight (the nearest-to-bottom, levelled run), facing
  // −x: the circuit runs CLOCKWISE, so the bottom straight is driven right→left.
  //
  // The grid sits BEFORE the line in the racing direction (its +x side), where a real grid
  // is: the line is a few metres AHEAD of P1 and the rows stack back from it. It is a
  // STANDING start, so those grid-to-line metres are simply part of lap 1. The crossing a
  // few seconds after GO does NOT complete a lap — completion needs an ARMED forward
  // crossing, and the lap only arms at the far point, half a track away.
  // Slot i starts on P(i+1), so join order fills P1 → P12 (see circuitGridPose /
  // drawCircuitGrid — the same function places the car and paints its box, so they cannot
  // disagree). PLAYER_CAP is 8, so only P1..P8 are reachable today; the 12 boxes are painted
  // regardless. Past the 12th box the row index simply keeps counting, as it always has:
  // slot 12 lands on a 4th (unpainted) row, still correctly spaced and non-overlapping.
  spawn(slot, world) {
    void world;
    const c = circuitToWorld(CIRCUIT_FINISH.x, CIRCUIT_FINISH.y);
    const g = circuitGridPose(slot);
    return { x: c.x + g.back, y: c.y + g.lane, heading: Math.PI };   // heading π ⇒ +y is outward
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
