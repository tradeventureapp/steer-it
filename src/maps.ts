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
import { noteError } from './diag';
import type { RaceElement } from './race';
import {
  SURFACES, onSurfaceAssetsReady, GRASS_LOOK, DIRT_LOOK,
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

  // Game modes this map supports, by key (the mode registry lives in the menu — desktop.ts —
  // so a NEW mode/map slots in by editing DATA only, never menu logic). Empty/omitted ⇒ the
  // map is FREE ROAM only (the desktop): the menu offers no mode choice and START just launches
  // it. The ovals + circuit list ['race','xp']. Keys are plain strings so maps stay decoupled
  // from the mode registry.
  gameModes?: readonly string[];

  // See SurfaceGroup — optional map-select grouping metadata (presentation only).
  surfaceGroup?: SurfaceGroup;

  // O(1) ground lookup for a world point (metres). ABSENT ⇒ the map is asphalt
  // everywhere (the desktop + both ovals) — and physics4 is then handed `undefined`,
  // so the whole grass path is dead code and those maps stay byte-identical.
  surfaceAt?(x: number, y: number): Surface;

  // IS THIS POINT ON THE TRACK? — pure TRACK GEOMETRY, deliberately SURFACE-AGNOSTIC.
  //
  // ⚠️ This replaced a per-map list of "racing surfaces". That whitelist was the root of a
  // recurring bug: every time a map gained a surface that wasn't on its list (the dirt oval,
  // then the rallycross dirt section) that surface read as OFF TRACK and ended XP runs on
  // the racing line. Asking "which material am I on?" is simply the wrong question — the
  // right one is "am I inside the drivable ribbon?".
  //
  // So: anything INSIDE the ribbon is on track whatever it is paved with (asphalt, dirt, and
  // any surface added later — no list to update, the bug cannot come back). Kerbs count as
  // ON track: they are drivable track extensions. Only leaving the ribbon — grass, gravel
  // run-off — is off track.
  //
  // ABSENT ⇒ the map has no ribbon geometry (the desktop, both barrier-bounded ovals) and
  // every point counts as on track; those maps lean on their crash-end instead.
  onTrackAt?(x: number, y: number): boolean;

  // RENDER-ONLY tyre-mark class for a map with NO per-point mask (desktop, ovals).
  // The saturation mark system stamps the whole map in this class (rubber on
  // asphalt, a brown dirt scuff on the flat oval). Default 'asphalt'. NEVER read
  // by the physics — a mark is a surface's look, not its grip.
  markClass?: MarkClass;

  // Circuit maps only: the built-in start/finish line as a race START element
  // (acts as start AND finish in circuit mode). Open maps omit it.
  startLine?(world: MapWorld): RaceElement;

  // LEADERBOARD ZONES (anti-cheat / proof-of-play; see zones.ts). The track's CENTRELINE as
  // a WORLD-space, arc-length-even, CLOSED polyline, ANCHORED so index 0 = the finish and
  // INCREASING index = the racing direction. zones.ts splits it into 6 equal arc-length
  // buckets. Present on every racing map (both ovals, Circuit, Circuit II, Rallycross);
  // absent on the desktop (no leaderboard). Geometry only — never affects render/physics.
  zonePath?(world: MapWorld): [number, number][];

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
  gameModes: ['free'], // FREE RIDE only — its own place-elements editor (E), no RACE/XP

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
export const FLAT_LOGICAL = {
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
    // Every mode a start/finish line supports: TIME ATTACK needs one, so it is listed
    // wherever RACE is (the desktop map, which has no line, stays FREE RIDE only).
    gameModes: ['free', 'race', 'timeattack', 'xp'],

    surfaceGroup: opts.surfaceGroup,

    smokeColor: opts.smokeColor,

    ...(opts.physicsSurface
      ? { surfaceAt: (_x: number, _y: number): Surface => opts.physicsSurface! }
      : {}),

    // NO `onTrackAt`: a stadium oval has no ribbon-vs-surround geometry — the whole
    // enclosed area IS the track, bounded by barriers, and its single surface covers all
    // of it. So every point is on track and the map leans on its crash-end. (This used to
    // declare a racing-surface whitelist, which is exactly the pattern that kept breaking.)

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
    // Leaderboard zones: the band-midline loop (finish-anchored at (cx, cy+mid), +x forward).
    zonePath(world) { return ovalZonePath((world as FlatWorld).geom); },

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

// The band-derived "natural" scale (metres per sketch unit): the size the track WANTS
// to be from the oval's band. It is the binding scale on a 16:9 screen. `_bandScale`,
// the aspect-ratio FIT cap, CS_SCALE and CIRCUIT_TRACK_W are ALL computed lower down —
// under "===== CIRCUIT FIT" — because the fit must measure the TRUE drawn bounding box
// (road ribbon + KERBS + GRAVEL run-off), and that geometry doesn't exist yet here. The
// first attempt fit only the road centreline + band, so kerbs still hung off the edges.

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
export type Pt = [number, number];

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

// THE circuit-family centreline builder, parameterised by the sketch so the dev
// track editor (track-editor.html) can run NEW layouts through the IDENTICAL code
// path. For CIRCUIT_SKETCH this computes exactly what the old inline builder did
// (straightY ≡ CIRCUIT_STRAIGHT_Y): dense centripetal Catmull-Rom → arc-length
// resample → circular box-blur → resample → finish-straight flatten.
export function buildCircuitPath(sketch: Pt[]): Pt[] {
  const straightY = Math.max(...sketch.map((q) => q[1]));
  let p = resampleClosed(
    smoothClosed(resampleClosed(sampleSpline(sketch, 48), CIRCUIT_SAMPLES), 14, 2),
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
    q[1] > straightY && q[1] > maxY - 45 ? [q[0], straightY] : q;
  p = p.map(flatten);
  p = smoothClosed(p, 4, 3);
  p = p.map(flatten);
  return p;
}

const CIRCUIT_PATH: Pt[] = buildCircuitPath(CIRCUIT_SKETCH);

// Finish line = the centre of the dead-flat bottom straight (level, at straightY).
// Parameterised (path + straightY) so an AUTHORED circuit-family map derives its
// finish through the identical rule; for CIRCUIT_PATH this is the old inline IIFE.
function flatFinishOf(path: Pt[], straightY: number): { x: number; y: number } {
  const fx = path
    .filter((p) => Math.abs(p[1] - straightY) < 1e-6)
    .map((p) => p[0]);
  return { x: (Math.min(...fx) + Math.max(...fx)) / 2, y: straightY };
}
const CIRCUIT_FINISH = flatFinishOf(CIRCUIT_PATH, CIRCUIT_STRAIGHT_Y);

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
// Parameterised for the same reason as flatFinishOf — identical maths, any path.
function lapFarPointOf(path: Pt[], finish: { x: number; y: number }): { x: number; y: number } {
  const N = path.length;
  // index of the finish on the (evenly-resampled) path
  let fi = 0, fd = Infinity;
  path.forEach((p, i) => {
    const d = (p[0] - finish.x) ** 2 + (p[1] - finish.y) ** 2;
    if (d < fd) { fd = d; fi = i; }
  });
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const d = Math.hypot(path[j][0] - path[i][0], path[j][1] - path[i][1]);
    seg.push(d); total += d;
  }
  let best = { score: -1, p: path[fi] };
  let run = 0;
  for (let k = 0; k < N; k++) {
    const i = (fi + k) % N;
    const arc = Math.min(run, total - run);          // shorter way round to this point
    const straight = Math.hypot(path[i][0] - finish.x, path[i][1] - finish.y);
    const score = Math.min(arc, straight);
    if (score > best.score) best = { score, p: path[i] };
    run += seg[i];
  }
  return { x: best.p[0], y: best.p[1] };
}
const CIRCUIT_FAR = lapFarPointOf(CIRCUIT_PATH, CIRCUIT_FINISH);

// =============================================================================
//  LEADERBOARD ZONE CENTRELINES (see MapDefinition.zonePath / zones.ts). Build a
//  WORLD-space centreline that is arc-length-even, closed, anchored so index 0 = the
//  finish, and oriented so INCREASING index = the racing direction. Pure geometry from
//  data the maps already own — nothing here touches render/physics. Built lazily +
//  cached (called once per Time Attack / XP run, never per frame).
// =============================================================================
// Circuit-family: rotate the (already arc-length-even) sketch path to the finish, map to
// world, and flip if the index order runs against the racing direction (forwardRad).
function buildCentrelineZonePath(
  sketchPath: Pt[], toWorld: (sx: number, sy: number) => { x: number; y: number },
  finishSketch: { x: number; y: number }, forwardRad: number,
): [number, number][] {
  const world: [number, number][] = sketchPath.map((p) => {
    const w = toWorld(p[0], p[1]); return [w.x, w.y];
  });
  const N = world.length;
  const fw = toWorld(finishSketch.x, finishSketch.y);
  let fi = 0, fd = Infinity;
  for (let i = 0; i < N; i++) {
    const dx = world[i][0] - fw.x, dy = world[i][1] - fw.y;
    const d = dx * dx + dy * dy;
    if (d < fd) { fd = d; fi = i; }
  }
  // Does the tangent at the finish (increasing index) point along the racing direction?
  const nxt = world[(fi + 1) % N], prv = world[(fi - 1 + N) % N];
  const forward = (nxt[0] - prv[0]) * Math.cos(forwardRad) + (nxt[1] - prv[1]) * Math.sin(forwardRad) >= 0;
  const ordered: [number, number][] = [];
  for (let k = 0; k < N; k++) ordered.push(world[forward ? (fi + k) % N : (fi - k + N) % N]);
  return ordered;
}
// Stadium band-midline as a world-space closed loop, arc-length-even, STARTING at the finish
// (cx, cy+mid) and going +x (the racing direction). Sampled densely then evenly resampled.
function ovalZonePath(g: StadiumGeom, samples = 240): [number, number][] {
  const mid = (g.IYh + g.OYh) / 2;
  const raw: Pt[] = [];
  const STEP = 1.5, DA = 3 * Math.PI / 180;
  for (let x = g.cx; x < g.cx + g.sx; x += STEP) raw.push([x, g.cy + mid]);                 // bottom: finish → right
  for (let a = Math.PI / 2; a > -Math.PI / 2; a -= DA)                                       // right corner (through 0)
    raw.push([g.cx + g.sx + mid * Math.cos(a), g.cy + mid * Math.sin(a)]);
  for (let x = g.cx + g.sx; x > g.cx - g.sx; x -= STEP) raw.push([x, g.cy - mid]);           // top: right → left
  for (let a = -Math.PI / 2; a > -3 * Math.PI / 2; a -= DA)                                  // left corner (through π)
    raw.push([g.cx - g.sx + mid * Math.cos(a), g.cy + mid * Math.sin(a)]);
  for (let x = g.cx - g.sx; x < g.cx; x += STEP) raw.push([x, g.cy + mid]);                  // bottom: left → finish
  return resampleClosed(raw, samples);
}
let _circuitZonePath: [number, number][] | null = null;
function circuitZonePath(): [number, number][] {
  if (!_circuitZonePath) _circuitZonePath = buildCentrelineZonePath(CIRCUIT_PATH, circuitToWorld, CIRCUIT_FINISH, Math.PI);
  return _circuitZonePath;
}
let _authoredZonePath: [number, number][] | null = null;
function authoredZonePath(): [number, number][] {
  if (!_authoredZonePath) _authoredZonePath = buildCentrelineZonePath(AUTHORED_PATH, authoredToWorld, AUTHORED_FINISH, AUTHORED_FORWARD);
  return _authoredZonePath;
}

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
/** An OPEN polyline (no closePath) — for a partial arc of the ribbon (the dirt section). */
function traceOpenPolyline(ctx: CanvasRenderingContext2D, pxPts: Pt[]) {
  if (!pxPts.length) return;
  ctx.beginPath();
  ctx.moveTo(pxPts[0][0], pxPts[0][1]);
  for (let i = 1; i < pxPts.length; i++) ctx.lineTo(pxPts[i][0], pxPts[i][1]);
}
// Reusable scratch canvases for the dirt worn-line overlay (region mask + colour layer + dirt mask).
const _sc: (HTMLCanvasElement | null)[] = [null, null, null, null, null];
function scratch(which: 0 | 1 | 2 | 3 | 4, w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  let c = _sc[which];
  if (!c) { c = document.createElement('canvas'); _sc[which] = c; }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
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
  // willReadFrequently: this canvas exists ONLY to be read back with getImageData below.
  // Without it the browser keeps it GPU-backed and each readback forces a GPU→CPU sync.
  const c = cv.getContext('2d', { willReadFrequently: true });
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
  try {
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
  } catch (err) {
    // getImageData failed (memory) — DON'T cache the failure; a later call retries when
    // memory frees. surfaceAt then reads null (asphalt-everywhere fallback), never crashes.
    noteError('circuit-mask', err); console.warn('[circuit] surface mask build failed (getImageData):', err);
    return null;
  }
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
/**
 * TRACK GEOMETRY for the circuit family (circuit + rallycross): on track = inside the
 * drivable ribbon, INCLUDING kerbs (a kerb is a track extension you may ride).
 *
 * Note WHAT THIS DOES NOT ASK: nothing about the material. The mask stores geometry —
 * MASK_ASPHALT is "ribbon", MASK_KERB is "kerb" — and a surface painted on top of the
 * ribbon (rallycross dirt) does not change the geometry underneath, so it is on track for
 * free. Off track is the mask's own outside: grass, plus the gravel run-off traps, which
 * are carved OUTSIDE the ribbon by construction.
 */
function circuitOnTrackAt(x: number, y: number): boolean {
  const c = circuitClassAt(x, y);
  return c === 'asphalt' || c === 'kerb';
}

/** Ground under a world point for `map`. Maps with no mask (desktop, ovals) are all asphalt. */
export function surfaceAt(map: MapDefinition, x: number, y: number): Surface {
  return map.surfaceAt ? map.surfaceAt(x, y) : 'asphalt';
}

/**
 * Is this world point on `map`'s drivable track? Maps with no ribbon geometry (desktop,
 * the barrier-bounded ovals) report TRUE everywhere — they have no outside to fall off into.
 */
export function onTrackAt(map: MapDefinition, x: number, y: number): boolean {
  return map.onTrackAt ? map.onTrackAt(x, y) : true;
}
/**
 * RENDER-ONLY mark class at a world point — 'kerb' split out of 'asphalt' so tyre marks can
 * cap kerb scuffing separately. Maps without a mask report 'asphalt' (their marks are the
 * untouched legacy skid path). NEVER read by the physics.
 */
export function markClassAt(map: MapDefinition, x: number, y: number): MarkClass {
  if (map.surfaceAt === circuitSurfaceAt) return circuitClassAt(x, y);
  if (map.surfaceAt === rallycrossSurfaceAt) return rallycrossClassAt(x, y);
  if (map.surfaceAt === authoredSurfaceAt) return authoredMarkClassAt(x, y);
  return 'asphalt';
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

/**
 * DIAGNOSTICS: does the circuit actually FIT this machine's screen? The track's size
 * derives from the screen HEIGHT (via the oval band) while the world's width comes from
 * the screen WIDTH, so a narrow aspect used to push the track off the world. `scaleCappedByFit`
 * true means this screen needed the fit cap (i.e. it is NOT a 16:9 machine).
 */
export function circuitFitDebug() {
  const extentW = _trueExtent.w * CS_SCALE, extentH = _trueExtent.h * CS_SCALE;
  const marginX = (FLAT_LOGICAL.widthM - extentW) / 2, marginY = (FLAT_LOGICAL.heightM - extentH) / 2;
  return {
    screenAspect: +(FLAT_LOGICAL.widthM / FLAT_LOGICAL.heightM).toFixed(3),
    worldM: `${FLAT_LOGICAL.widthM.toFixed(1)} x ${FLAT_LOGICAL.heightM.toFixed(1)}`,
    trackExtentM: `${extentW.toFixed(1)} x ${extentH.toFixed(1)}`,   // road + kerbs + gravel
    trackWidthM: +CIRCUIT_TRACK_W.toFixed(2),
    marginM: `${marginX.toFixed(1)} L/R · ${marginY.toFixed(1)} T/B`,
    scaleCappedByFit: CS_SCALE < _bandScale - 1e-9,
    fits: marginX >= 0 && marginY >= 0,
  };
}

/**
 * DIAGNOSTICS / HARNESS: the TRUE drawn bounding box vs the world, in METRES, per source,
 * so a test can assert a positive margin on all four sides for any screen aspect. This is
 * the ground truth the fit is built on — kerbs and gravel included, not just the road.
 */
export function circuitDrawnExtent() {
  const s = CS_SCALE;
  // per-source extents (sketch → metres), to prove which piece is the binding one
  const box = (pts: Array<[number, number]>) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of pts) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    return { minX: a, minY: b, maxX: c, maxY: d };
  };
  const half = CS_BAND / 2;
  const roadPts: Array<[number, number]> = [];
  for (const p of CIRCUIT_PATH) { roadPts.push([p[0] - half, p[1] - half], [p[0] + half, p[1] + half]); }
  const kerbPts: Array<[number, number]> = [];
  for (const q of CIRCUIT_KERBS) kerbPts.push(q.a, q.b, q.c, q.d);
  const gravPts: Array<[number, number]> = [];
  for (const [x, y, r] of GRAVEL_DISCS) gravPts.push([x - r, y - r], [x + r, y + r]);
  const toWorld = (bx: { minX: number; minY: number; maxX: number; maxY: number }) => ({
    minX: (bx.minX - CS_BCX) * s + CIRCUIT_LOGICAL.widthM / 2,
    maxX: (bx.maxX - CS_BCX) * s + CIRCUIT_LOGICAL.widthM / 2,
    minY: (bx.minY - CS_BCY) * s + CIRCUIT_LOGICAL.heightM / 2,
    maxY: (bx.maxY - CS_BCY) * s + CIRCUIT_LOGICAL.heightM / 2,
  });
  const all = toWorld(_trueExtent);
  return {
    world: { w: FLAT_LOGICAL.widthM, h: FLAT_LOGICAL.heightM },
    scaleCappedByFit: CS_SCALE < _bandScale - 1e-9,
    all,                                   // union bbox in world metres
    margins: {                             // >0 on every side ⇒ nothing cut off
      left: all.minX, right: FLAT_LOGICAL.widthM - all.maxX,
      top: all.minY, bottom: FLAT_LOGICAL.heightM - all.maxY,
    },
    perSource: {
      road: toWorld(box(roadPts)),
      kerbs: toWorld(box(kerbPts)),
      gravel: toWorld(box(gravPts)),
    },
  };
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

// ===== CIRCUIT FIT — scale the track so the WHOLE drawn thing fits the screen ======
// THE BUG (v1 fit): the fit measured only the road centreline + band width, so on any
// aspect narrower than 16:9 the KERBS (which reach KERB_FULL_W beyond the road edge) and
// the GRAVEL run-off still hung off the left/right edges.
//
// THE FIX: measure the TRUE bounding box of the TRACK — the road ribbon AND its kerbs —
// in sketch units, and fit THAT (v1 fit only the road centreline + band, which is why the
// kerbs, reaching KERB_FULL_W further out, still hung off the sides):
//   • road ribbon — every CIRCUIT_PATH point, inflated by CS_BAND/2 (the stroke half-width)
//   • kerbs       — every KerbQuad vertex (they extend band/2 + KERB_FULL_W outward)
// GRAVEL run-off is deliberately NOT in the binding box: the traps sit out in the grass and
// the bottom-straight trap already bleeds a touch past the bottom edge on 16:9 today (the
// shipped, accepted look). Fitting gravel would shrink the 16:9 track ~27 % and break the
// "16:9 unchanged" guarantee. `circuitDrawnExtent()` still reports gravel so a regression
// can be seen. The road+kerb box is what must never be cut — that IS the reported bug.
const _trueExtent = (() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  const half = CS_BAND / 2;
  for (const p of CIRCUIT_PATH) { acc(p[0] - half, p[1] - half); acc(p[0] + half, p[1] + half); }
  for (const q of CIRCUIT_KERBS) { acc(q.a[0], q.a[1]); acc(q.b[0], q.b[1]); acc(q.c[0], q.c[1]); acc(q.d[0], q.d[1]); }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
})();

// The band-derived "natural" scale (metres per sketch-unit) for a circuit-family band
// width — the SAME oval-derived formula CS_SCALE starts from, exported so the dev
// track editor previews a new layout at the true in-game scale.
export function circuitBandScale(band: number): number {
  return computeStadium(FLAT_LOGICAL.widthM, FLAT_LOGICAL.heightM).bandW * (2 / 3) / band;
}
const _bandScale = circuitBandScale(CS_BAND);
// Safety margin: the true extent must occupy at most this fraction of the world on each
// axis, so a strip of grass always frames the track and nothing can touch the edge. On a
// 16:9 screen `_bandScale` is still the binding (smaller) scale, so 16:9 stays EXACTLY as
// shipped; only narrower ratios hit the fit cap and scale down.
export const CIRCUIT_FIT = 0.988;                // 16:9 fills ~98.7%, so this keeps it band-bound (identical); narrower ratios scale down to fit
const CS_SCALE = Math.min(                       // metres per sketch unit
  _bandScale,
  (FLAT_LOGICAL.widthM * CIRCUIT_FIT) / _trueExtent.w,
  (FLAT_LOGICAL.heightM * CIRCUIT_FIT) / _trueExtent.h,
);
const CIRCUIT_TRACK_W = CS_SCALE * CS_BAND;

let _gravelMask: Uint8Array | null | undefined;
let _gvW = 0, _gvH = 0;
function gravelMask(): Uint8Array | null {
  if (_gravelMask !== undefined) return _gravelMask;
  if (typeof document === 'undefined') { _gravelMask = null; return null; }
  const P = GRAVEL_MASK_PPM;
  const W = Math.max(1, Math.round(CIRCUIT_LOGICAL.widthM * P));
  const H = Math.max(1, Math.round(CIRCUIT_LOGICAL.heightM * P));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d', { willReadFrequently: true });   // read back via getImageData
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
  // 3. read the alpha out. getImageData can throw under memory pressure — DON'T cache the
  //    failure (leave _gravelMask undefined so a later call retries); the circuit still renders
  //    (gravelShape sees null → no gravel this frame) rather than crashing the surface bake.
  let px: Uint8ClampedArray;
  try { px = c.getImageData(0, 0, W, H).data; }
  catch (err) { noteError('gravel-mask', err); console.warn('[circuit] gravel mask build failed (getImageData):', err); return null; }
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
  let px2: Uint8ClampedArray;
  try { px2 = c.getImageData(0, 0, W, H).data; }
  catch (err) { noteError('gravel-mask-2', err); console.warn('[circuit] gravel mask build failed (getImageData 2):', err); return null; }
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

// The mask → opaque-alpha bitmap depends ONLY on the (immutable, once-baked) gravel mask,
// so it is built ONCE and reused across every bake — instead of allocating a fresh
// _gvW×_gvH canvas + createImageData loop on every drawBackground (the old churn that,
// map-switch after map-switch, drove the canvas-memory pressure that made images fail).
let _gravelAlpha: HTMLCanvasElement | null = null;
function gravelAlphaCanvas(): HTMLCanvasElement | null {
  if (_gravelAlpha) return _gravelAlpha;
  const mask = gravelMask();
  if (!mask || typeof document === 'undefined') return null;
  const mc = document.createElement('canvas'); mc.width = _gvW; mc.height = _gvH;
  const mcx = mc.getContext('2d', { willReadFrequently: true }); if (!mcx) return null;   // read back
  const img = mcx.createImageData(_gvW, _gvH);
  for (let i = 0; i < _gvW * _gvH; i++) if (mask[i]) img.data[i * 4 + 3] = 255;
  mcx.putImageData(img, 0, 0);
  _gravelAlpha = mc;
  return mc;
}

const gravelShape: SurfaceShape = (m, rc) => {
  const alpha = gravelAlphaCanvas();
  if (!alpha) return;

  m.filter = `blur(${GRAVEL_EDGE_SMOOTH_PX}px)`;             // destination px
  m.drawImage(alpha, 0, 0, rc.wPx, rc.hPx);
  m.filter = 'none';

  // Re-sharpen: smoothstep the blurred alpha about 0.5 over a band narrow enough to leave
  // ~GRAVEL_EDGE_AA_PX of ramp (the blur's ramp spans ≈GRAVEL_EDGE_SMOOTH_PX, so the band
  // is that ratio of it). Alpha only — the fill is composited in later, source-in.
  // getImageData can THROW under memory pressure / on a huge or tainted canvas; if it does,
  // keep the (already-drawn) blurred gravel edge rather than throwing the whole surface bake
  // (which would abort drawBackground → a black track). A slightly softer kerb-side edge, not
  // a missing surface.
  try {
    const big = m.getImageData(0, 0, rc.wPx, rc.hPx), d = big.data;
    const w = Math.max(0.01, 0.5 * GRAVEL_EDGE_AA_PX / GRAVEL_EDGE_SMOOTH_PX);
    for (let i = 3; i < d.length; i += 4) {
      let t = (d[i] / 255 - (0.5 - w)) / (2 * w);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      d[i] = 255 * t * t * (3 - 2 * t);
    }
    m.putImageData(big, 0, 0);
  } catch (err) {
    noteError('gravel-edge', err); console.warn('[circuit] gravel edge re-sharpen skipped (getImageData failed):', err);
  }
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
export const WHITE_LINE_INSET_M = 0.55;   // m — kerb-free: from the grass edge inward to the line's centre
export const WHITE_LINE_W_M = 0.34;       // m — line width
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
function drawCircuitSurface(ctx: CanvasRenderingContext2D, wPx: number, hPx: number,
  dirt?: { i0: number; i1: number }) {
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

  // 3b. DIRT SECTION (rallycross only) — a darker packed-earth stretch laid OVER the asphalt on a
  //     contiguous arc [i0,i1] of the ribbon. Base = the band stroke (matches the grip mask's extent,
  //     RENDER-ONLY — the physics mask is untouched); the two tarmac↔dirt ENDS are then made IRREGULAR
  //     (carved bites + dirt tongues + scattered specks bleeding onto the tarmac), so the border reads
  //     ragged/organic, not a smooth arc. Omitted (the circuit) ⇒ never runs ⇒ circuit byte-identical.
  if (dirt) {
    const seg = ptsPx.slice(dirt.i0, dirt.i1 + 1);
    if (seg.length >= 2) {
      const halfW = twPx / 2;
      // Extend the band a little past each end along the true track, then CUT it to the designer's
      // HAND-DRAWN transition lines (RALLYCROSS_DIRT_EDGES) — the border is exactly the drawn curve.
      const N = ptsPx.length, wrap = (i: number) => ((i % N) + N) % N;
      const sub = (a: number[], b: number[]): [number, number] => [a[0] - b[0], a[1] - b[1]];
      const nrm = (v: number[]): [number, number] => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
      const addS = (a: number[], b: number[], s2: number): [number, number] => [a[0] + b[0] * s2, a[1] + b[1] * s2];
      const EXT = 12;
      const pre: Pt[] = [], post: Pt[] = [];
      for (let k = EXT; k >= 1; k--) pre.push(ptsPx[wrap(dirt.i0 - k)] as Pt);
      for (let k = 1; k <= EXT; k++) post.push(ptsPx[wrap(dirt.i1 + k)] as Pt);
      const extSeg = [...pre, ...seg, ...post];
      // smooth a polyline (box pass on interior points, endpoints fixed) — rounds the freehand wobble
      const smoothPts = (p: [number, number][], passes: number): [number, number][] => {
        let a = p.map((q) => [q[0], q[1]] as [number, number]);
        for (let it = 0; it < passes; it++) {
          const b = a.map((q) => [q[0], q[1]] as [number, number]);
          for (let i = 1; i < a.length - 1; i++) b[i] = [(a[i - 1][0] + 2 * a[i][0] + a[i + 1][0]) / 4, (a[i - 1][1] + 2 * a[i][1] + a[i + 1][1]) / 4];
          a = b;
        }
        return a;
      };
      // the drawn lines → px, extended past their ends (full-width cut) + heavily smoothed → round curve
      const edgesPx = RALLYCROSS_DIRT_EDGES.map((line) => {
        const e = line.map(([fx, fy]) => [fx * wPx, fy * hPx] as [number, number]);
        const d0 = nrm(sub(e[0], e[1])), dn = nrm(sub(e[e.length - 1], e[e.length - 2]));
        const ext = [addS(e[0], d0, halfW), ...e, addS(e[e.length - 1], dn, halfW)] as [number, number][];
        return smoothPts(ext, 8);
      });
      const back0 = nrm(sub(ptsPx[wrap(dirt.i0 - 10)], ptsPx[dirt.i0]));   // asphalt-side dir at i0
      const back1 = nrm(sub(ptsPx[wrap(dirt.i1 + 10)], ptsPx[dirt.i1]));   // asphalt-side dir at i1
      const d2 = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      const mid = (e: [number, number][]) => e[Math.floor(e.length / 2)];
      let edge0: [number, number][] | null = null, edge1: [number, number][] | null = null;
      for (const e of edgesPx) { if (d2(mid(e), ptsPx[dirt.i0]) < d2(mid(e), ptsPx[dirt.i1])) edge0 = e; else edge1 = e; }

      // The dirt SHAPE (band → cut to the drawn transition lines → connectors → clip to ribbon). Named
      // so it paints the dirt AND builds a mask to clip the worn line to (so the worn line reaches the
      // transition without smudging onto the tarmac).
      const paintDirtShape = (m: CanvasRenderingContext2D) => {
        traceOpenPolyline(m, extSeg); m.lineCap = 'round'; m.lineJoin = 'round'; m.lineWidth = twPx; m.stroke();
        // CUT the dirt to each hand-drawn line — remove the asphalt side. The drawn line is SMOOTHED
        // into a nice rounded curve (quadratic through segment midpoints) so the border reads clean.
        m.globalCompositeOperation = 'destination-out';
        for (const pair of [[edge0, back0], [edge1, back1]] as [[number, number][] | null, [number, number]][]) {
          const edge = pair[0], back = pair[1]; if (!edge) continue;
          const BIG = twPx * 4;
          m.beginPath(); m.moveTo(edge[0][0], edge[0][1]);
          for (let k = 1; k < edge.length - 1; k++) {                       // rounded: quadratic through midpoints
            const mx = (edge[k][0] + edge[k + 1][0]) / 2, my = (edge[k][1] + edge[k + 1][1]) / 2;
            m.quadraticCurveTo(edge[k][0], edge[k][1], mx, my);
          }
          const last = edge[edge.length - 1], first = edge[0];
          m.lineTo(last[0], last[1]);
          m.lineTo(last[0] + back[0] * BIG, last[1] + back[1] * BIG);
          m.lineTo(first[0] + back[0] * BIG, first[1] + back[1] * BIG);
          m.closePath(); m.fill();
        }
        m.globalCompositeOperation = 'source-over';
        // CONNECT the dirt to the kerb along each designer-marked line — a THIN clean strip (not a blob).
        for (const grp of RALLYCROSS_DIRT_FILL) {
          if (grp.length < 2) continue;
          const g = grp.map(([fx, fy]) => [fx * wPx, fy * hPx] as [number, number]);
          const dS = nrm(sub(g[0], g[1])), dE = nrm(sub(g[g.length - 1], g[g.length - 2]));
          const a = addS(g[0], dS, twPx * 0.7), b = addS(g[g.length - 1], dE, twPx * 0.7);
          m.lineCap = 'round'; m.lineJoin = 'round'; m.lineWidth = twPx * 0.3;
          m.beginPath(); m.moveTo(a[0], a[1]); m.lineTo(g[0][0], g[0][1]);
          for (let k = 1; k < g.length; k++) m.lineTo(g[k][0], g[k][1]);
          m.lineTo(b[0], b[1]); m.stroke();
        }
        // keep everything ON the ribbon so nothing spills past the kerb (band is fully inside → unchanged)
        m.globalCompositeOperation = 'destination-in';
        m.lineCap = 'round'; m.lineJoin = 'round'; m.lineWidth = twPx * 1.14;
        tracePolyline(m, ptsPx); m.stroke();
        m.globalCompositeOperation = 'source-over';
      };
      SURFACES.dirt.paint(ctx, paintDirtShape, rc);

      // HAND-DRAWN worn IDEAL LINE — the designer's own path (RALLYCROSS_IDEAL_LINE, drawn in draw.html),
      // rendered as a lighter worn stroke on the dark dirt. A vector path → resolution-INDEPENDENT (looks
      // identical at any bake size). Smoothed, and clipped to the dirt shape so it can't spill off.
      if (RALLYCROSS_IDEAL_LINE.length) {
        const IL = scratch(1, wPx, hPx), ilc = IL ? IL.getContext('2d') : null;
        if (IL && ilc) {
          ilc.setTransform(1, 0, 0, 1, 0, 0); ilc.clearRect(0, 0, wPx, hPx);
          ilc.lineCap = 'round'; ilc.lineJoin = 'round';
          const [lr, lg, lb] = DIRT_LOOK.line;
          ilc.strokeStyle = `rgb(${lr},${lg},${lb})`;                       // just LIGHTER — nothing fancy
          for (const st of RALLYCROSS_IDEAL_LINE) {
            const pts = st.pts; if (pts.length < 1) continue;
            ilc.lineWidth = Math.max(1, st.w * wPx);                         // EXACT drawn brush width
            ilc.beginPath(); ilc.moveTo(pts[0][0] * wPx, pts[0][1] * hPx);   // EXACT drawn points — no smoothing
            for (let k = 1; k < pts.length; k++) ilc.lineTo(pts[k][0] * wPx, pts[k][1] * hPx);
            if (pts.length === 1) ilc.lineTo(pts[0][0] * wPx + 0.01, pts[0][1] * hPx);
            ilc.stroke();
          }
          // clip to the dirt shape so it stays on the dirt (never on grass/asphalt; kerbs cover the rest)
          const dmask = scratch(2, wPx, hPx), dmc = dmask ? dmask.getContext('2d') : null;
          if (dmask && dmc) {
            dmc.setTransform(1, 0, 0, 1, 0, 0); dmc.clearRect(0, 0, wPx, hPx);
            dmc.fillStyle = '#fff'; dmc.strokeStyle = '#fff'; paintDirtShape(dmc);
            ilc.globalCompositeOperation = 'destination-in'; ilc.drawImage(dmask, 0, 0);
            ilc.globalCompositeOperation = 'source-over';
          }
          ctx.drawImage(IL, 0, 0);
        }
      }
    }
  }

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
  // How the artwork fills the face. 'contain' (default) = whole logo visible, aspect kept, small
  // margin (fully-transparent edges are auto-trimmed first so a padded logo still fills the face).
  // 'cover' = fill the face edge-to-edge (crop the overflow) — good for a full poster/card artwork.
  readonly fit?: 'contain' | 'cover';
  // Optional sub-rect of the (transparent-trimmed) artwork to actually use, as fractions 0..1
  // [x, y, w, h] — e.g. drop a fine subtitle band that can't survive being scaled to billboard
  // size. Default = the whole trimmed image.
  readonly crop?: readonly [number, number, number, number];
}
interface Billboard { sx: number; sy: number; scale: number; ad?: AdSlot; }
const CIRCUIT_BILLBOARDS: Billboard[] = [
  // UPPER-right pocket → STEER IT (transparent wordmark, contain-fitted after trimming its padding)
  { sx: 1351, sy: 369, scale: 1,
    ad: { img: '/ads/steer-it-logo.png', url: 'https://steerit.app/', crop: [0, 0, 1, 0.62] } },   // wordmark only (drop the fine subtitle)
  // below-left → placeholder ("YOUR AD HERE"), not clickable
  { sx: 1291, sy: 494, scale: 1 },
  // top-centre (biggest, 1.33×) → TRADEVENTURE (dark link-card poster, cover-fitted edge-to-edge)
  { sx: 988,  sy: 195, scale: 1.333,
    ad: { img: '/ads/tradeventure-link-card-1200x675.png', url: 'https://tradeventure.app/', fit: 'cover' } },
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

// Ad artwork is PRE-BAKED once (async) into a small, crisp canvas: trim transparent margins → apply
// the optional crop (drop e.g. an unreadable subtitle) → PROGRESSIVELY downscale (repeated halving
// with high-quality smoothing) to a sane max size. That fixes the "shrink a 3450 px image straight
// to ~200 px at draw time" smudge — the billboard then blits a canvas already near its on-screen
// size, so it stays sharp. Drawn every frame (drawAboveCars) → appears next frame once baked; null
// until then / on failure (→ the "YOUR AD HERE" placeholder, plus a console.warn — never silent).
interface AdArt { canvas: HTMLCanvasElement; ready: boolean; }
const AD_ART_MAX = 700;   // max baked artwork dimension (px) — headroom above any on-screen face size
const _adArt = new Map<string, AdArt>();
function adArt(ad: AdSlot): HTMLCanvasElement | null {
  let e = _adArt.get(ad.img);
  if (!e) {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
    const img = new Image();
    e = { canvas: document.createElement('canvas'), ready: false };
    _adArt.set(ad.img, e);
    img.src = ad.img;
    const fail = (why: unknown) => console.warn(`[ad] billboard image failed to load: "${ad.img}" —`, why);
    img.onerror = () => fail('404 / network / bad path');
    const done = () => { try { bakeAdArt(e!.canvas, img, ad.crop); e!.ready = true; } catch (err) { fail(err); } };
    if (typeof img.decode === 'function') img.decode().then(done).catch((err) => fail(err));
    else img.onload = () => { if (img.naturalWidth > 0) done(); };
  }
  return e.ready ? e.canvas : null;
}
function bakeAdArt(out: HTMLCanvasElement, img: HTMLImageElement, crop?: readonly [number, number, number, number]) {
  const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
  // Trim fully-transparent margins → the opaque content bbox (a padded logo still fills the face).
  let bx = 0, by = 0, bw = iw, bh = ih;
  const c = document.createElement('canvas'); c.width = iw; c.height = ih;
  const g = c.getContext('2d', { willReadFrequently: true });   // alpha readback below
  if (g) {
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, iw, ih).data;
    let x0 = iw, y0 = ih, x1 = -1, y1 = -1;
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
      if (d[(y * iw + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 >= x0 && y1 >= y0) { bx = x0; by = y0; bw = x1 - x0 + 1; bh = y1 - y0 + 1; }
  }
  // Optional crop (fractions of the trimmed bbox) — e.g. keep only the wordmark, drop the subtitle.
  let sx = bx, sy = by, sw = bw, sh = bh;
  if (crop) { sx = bx + crop[0] * bw; sy = by + crop[1] * bh; sw = crop[2] * bw; sh = crop[3] * bh; }
  sw = Math.max(1, sw); sh = Math.max(1, sh);
  // Extract the crop, then halve toward the target with high-quality smoothing (no one-step smudge).
  const scale = Math.min(1, AD_ART_MAX / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * scale)), th = Math.max(1, Math.round(sh * scale));
  let cur = document.createElement('canvas'); cur.width = Math.max(1, Math.round(sw)); cur.height = Math.max(1, Math.round(sh));
  let cg = cur.getContext('2d');
  if (cg) { cg.imageSmoothingEnabled = true; cg.imageSmoothingQuality = 'high'; cg.drawImage(img, sx, sy, sw, sh, 0, 0, cur.width, cur.height); }
  while (cur.width > tw * 2 && cur.height > th * 2) {
    const nw = Math.max(tw, Math.round(cur.width / 2)), nh = Math.max(th, Math.round(cur.height / 2));
    const nx = document.createElement('canvas'); nx.width = nw; nx.height = nh;
    const ng = nx.getContext('2d');
    if (!ng) break;
    ng.imageSmoothingEnabled = true; ng.imageSmoothingQuality = 'high';
    ng.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, nw, nh);
    cur = nx;
  }
  out.width = tw; out.height = th;
  const fg = out.getContext('2d');
  if (fg) { fg.imageSmoothingEnabled = true; fg.imageSmoothingQuality = 'high'; fg.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, tw, th); }
}

// A standing billboard is drawn in TWO passes so a car can drive UNDER it and hide behind it:
//   • the SHADOW sits on the grass (drawObstacles → under the cars);
//   • the BODY (posts + raised panel) is drawn AFTER the cars (drawAboveCars → occludes a car
//     passing under the panel). cxPx,cyPx = the ground/base centre in px.
// Billboard dimensions (metres, at scale 1) — exported so the track editor sizes and
// hit-tests placed billboards identically to how the map draws them.
export const BILLBOARD_DIMS = {
  W_M: 26.1, BOARD_H_M: 10.5, POST_H_M: 5.6,
  legDxM: 26.1 * 0.33, legR: 26.1 * 0.045 / 2,
};
export function drawBillboardShadow(ctx: CanvasRenderingContext2D, cxPx: number, cyPx: number, px: number) {
  const W = BILLBOARD_W_M * px, halfW = W / 2, postH = 4.0 * px, depth = Math.max(3, W * 0.05);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  ctx.ellipse(cxPx + depth * 0.6, cyPx + depth * 0.5, halfW * 1.02, Math.max(4, postH * 0.34), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawBillboardBody(
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
  const art = ad ? adArt(ad) : null;
  if (art) {
    const iw = art.width, ih = art.height;
    let sc: number;
    if (ad!.fit === 'cover') {
      sc = Math.max(faceW / iw, faceH / ih);          // fill edge-to-edge, crop the overflow
    } else {
      const pad = 0.04;                               // small breathing margin for 'contain'
      sc = Math.min(faceW * (1 - 2 * pad) / iw, faceH * (1 - 2 * pad) / ih);
    }
    const dw = iw * sc, dh = ih * sc;
    ctx.save();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.beginPath(); ctx.rect(faceX, faceY, faceW, faceH); ctx.clip();
    ctx.drawImage(art, faceX + (faceW - dw) / 2, faceY + (faceH - dh) / 2, dw, dh);
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
  // Map-select GROUP: Circuit collapses into ONE tile with an Asphalt | Rallycross switcher (like
  // the Stadium Oval's Asphalt | Flattrack). Asphalt = this plain circuit (the default). The
  // Rallycross member (dirt section) is dev-only, so for a normal user the group has a single
  // visible member and renders as a plain "Circuit" tile.
  surfaceGroup: { key: 'circuit', title: 'Circuit', option: 'Asphalt', order: 0, isDefault: true },
  gameModes: ['free', 'race', 'timeattack', 'xp'],   // TIME ATTACK rides the same start/finish line
  // CIRCUIT: the built-in start/finish below is start AND finish, so the editor shows the
  // LAPS panel (0 = free-roam, N = an N-lap race) instead of the place-elements palette —
  // exactly like the ovals.
  trackType: 'circuit',
  smokeColor: [248, 248, 251],    // white rubber smoke (asphalt), matching the oval
  fixedWorld: CIRCUIT_LOGICAL,    // = one screen ⇒ oval-style render (car standard size)

  // Ribbon + kerbs = asphalt, the rest = grass (baked bitmap, O(1) lookup). Supplying this
  // is what ARMS the per-wheel grass grip/drag in physics4 — no other map defines it.
  surfaceAt: circuitSurfaceAt,

  // TRACK GEOMETRY (ribbon + kerbs), independent of what the ribbon is paved with.
  // rallycrossMap spreads this map, so its dirt section inherits the SAME geometry and is
  // on track without declaring anything — which is the whole point of the change.
  onTrackAt: circuitOnTrackAt,

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
  // Leaderboard zones: the smooth CIRCUIT_PATH ribbon centreline (finish-anchored, forward).
  zonePath() { return circuitZonePath(); },

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

// =============================================================================
//  RALLYCROSS — the circuit layout with a DIRT SECTION mid-lap (for the Fury).
//
//  REUSES the circuit's exact geometry (CIRCUIT_PATH, kerbs, start/finish, laps,
//  fixed camera) and only ADDS a darker packed-earth stretch over a contiguous
//  arc [i0,i1] of the ribbon. The dirt binds to the EXISTING 'dirt' physics
//  (Fury muScale 0.85) — a darker LOOK with ZERO physics change; the tarmac↔dirt
//  grip change is emergent (per-wheel surface sampling). The existing circuit map
//  is untouched. The arc range is marked with the dev dirt-edit tool + locked here.
// =============================================================================

// The locked dirt arc (contiguous, i0<i1, non-wrapping). Marked on the live track with the dev
// dirt-edit tool (steerDirtEdit) — a big first-half dirt stretch (indices 0..494 of the 1000-pt path).
const RALLYCROSS_DIRT = { i0: 0, i1: 494 };

// The worn IDEAL LINE across the dirt — the designer's own hand-drawn path(s) (draw.html), as fractions
// (x/W, y/H) of the track box. Rendered as a lighter worn stroke on the dark dirt (see the dirt block),
// CLIPPED to the dirt (never on grass/asphalt; kerbs are drawn on top). Vector ⇒ resolution-independent.
const RALLYCROSS_IDEAL_LINE: { pts: [number, number][]; w: number }[] = [
  { w: 0.0786, pts: [[0.2514, 0.3187],[0.2541, 0.3234],[0.2567, 0.328],[0.2588, 0.3336],[0.2614, 0.3383],[0.2641, 0.343],[0.2662, 0.3486],[0.2683, 0.3542],[0.2704, 0.3608],[0.2714, 0.3673],[0.2735, 0.3729],[0.2762, 0.3776],[0.2783, 0.3832],[0.2804, 0.3897],[0.282, 0.3963],[0.2841, 0.4019],[0.2862, 0.4075],[0.2883, 0.4131],[0.2909, 0.4178],[0.293, 0.4234],[0.2956, 0.428],[0.2983, 0.4327],[0.3009, 0.4374],[0.3035, 0.4421],[0.3062, 0.4467],[0.3088, 0.4514],[0.3114, 0.4561],[0.314, 0.4608],[0.3167, 0.4654],[0.3188, 0.471],[0.3209, 0.4766],[0.3235, 0.4813],[0.3261, 0.486],[0.3288, 0.4916],[0.3309, 0.4972],[0.3335, 0.5019],[0.3356, 0.5075],[0.3382, 0.5122],[0.3409, 0.5168],[0.344, 0.5206],[0.3477, 0.5234],[0.3509, 0.5271],[0.3546, 0.5299],[0.3577, 0.5337],[0.3603, 0.5383],[0.3635, 0.543],[0.3672, 0.5458],[0.3703, 0.5495],[0.374, 0.5523],[0.3777, 0.5551],[0.3814, 0.557],[0.3851, 0.5589],[0.3887, 0.5617],[0.3919, 0.5654],[0.3961, 0.5673],[0.3998, 0.5692],[0.4035, 0.571],[0.4072, 0.572],[0.4108, 0.5729],[0.415, 0.5738],[0.4187, 0.5748],[0.4224, 0.5757],[0.4261, 0.5757],[0.4298, 0.5757],[0.4335, 0.5757],[0.4371, 0.5757],[0.4408, 0.5757],[0.4445, 0.5766],[0.4482, 0.5766],[0.4519, 0.5776],[0.4555, 0.5776],[0.4592, 0.5776],[0.4629, 0.5776],[0.4671, 0.5766],[0.4708, 0.5748],[0.4745, 0.5738],[0.4782, 0.571],[0.4819, 0.5682],[0.4855, 0.5664],[0.4892, 0.5645],[0.4929, 0.5608],[0.4966, 0.558],[0.5003, 0.5551],[0.5034, 0.5514],[0.5071, 0.5486],[0.5103, 0.5439],[0.5134, 0.5402],[0.5166, 0.5355],[0.5192, 0.5308],[0.5213, 0.5252],[0.5239, 0.5206],[0.5255, 0.514],[0.5276, 0.5075],[0.5297, 0.5019],[0.5324, 0.4963],[0.535, 0.4916],[0.5371, 0.486],[0.5397, 0.4813],[0.5423, 0.4748],[0.545, 0.4701],[0.5471, 0.4636],[0.5492, 0.458],[0.5513, 0.4523],[0.5534, 0.4449],[0.5555, 0.4393],[0.5576, 0.4337],[0.5597, 0.428],[0.5618, 0.4224],[0.5644, 0.4178],[0.5671, 0.4122],[0.5692, 0.4065],[0.5708, 0.4],[0.5734, 0.3944],[0.575, 0.3879],[0.5771, 0.3822],[0.5797, 0.3766],[0.5823, 0.3701],[0.585, 0.3654],[0.5871, 0.3598],[0.5897, 0.3551],[0.5918, 0.3495],[0.5939, 0.3439],[0.5965, 0.3393],[0.5992, 0.3336],[0.6013, 0.328],[0.6039, 0.3234],[0.606, 0.3178],[0.6086, 0.3131],[0.6107, 0.3075],[0.6134, 0.3019],[0.616, 0.2972],[0.6181, 0.2916],[0.6213, 0.286],[0.6239, 0.2804],[0.6265, 0.2757],[0.6291, 0.271],[0.6323, 0.2673],[0.6355, 0.2636],[0.6397, 0.2608],[0.6428, 0.2561],[0.6465, 0.2533],[0.6497, 0.2495],[0.6528, 0.2458],[0.6565, 0.2421],[0.6597, 0.2383],[0.6623, 0.2336],[0.6654, 0.2299],[0.6686, 0.2262],[0.6718, 0.2215],[0.6749, 0.2178],[0.6781, 0.2131],[0.6817, 0.2093],[0.6849, 0.2056],[0.6886, 0.2037],[0.6917, 0.2],[0.6949, 0.1963],[0.6986, 0.1935],[0.7023, 0.1907],[0.7059, 0.1879],[0.7096, 0.186],[0.7133, 0.1832],[0.717, 0.1813],[0.7207, 0.1785],[0.7244, 0.1766],[0.728, 0.1757],[0.7317, 0.1748],[0.7354, 0.1738],[0.7391, 0.1729],[0.7428, 0.172],[0.747, 0.172],[0.7507, 0.172],[0.7543, 0.171],[0.758, 0.171],[0.7617, 0.171],[0.7654, 0.171],[0.7696, 0.171],[0.7738, 0.171],[0.7775, 0.171],[0.7812, 0.171],[0.7849, 0.171],[0.7885, 0.172],[0.7922, 0.1729],[0.7959, 0.1738],[0.7996, 0.1757],[0.8033, 0.1776],[0.8069, 0.1804],[0.8112, 0.1841],[0.8148, 0.1869],[0.8185, 0.1897],[0.8222, 0.1916],[0.8259, 0.1935],[0.8296, 0.1953],[0.8332, 0.1981],[0.8369, 0.2009],[0.8406, 0.2047],[0.8443, 0.2075],[0.8474, 0.2122],[0.8506, 0.2159],[0.8543, 0.2196],[0.8574, 0.2243],[0.8606, 0.228],[0.8638, 0.2318],[0.8664, 0.2365],[0.8695, 0.2421],[0.8722, 0.2467],[0.8748, 0.2514],[0.8769, 0.257],[0.879, 0.2626],[0.8816, 0.2682],[0.8827, 0.2748],[0.8848, 0.2804],[0.8869, 0.286],[0.8895, 0.2907],[0.8916, 0.2963],[0.8937, 0.3019],[0.8958, 0.3075],[0.8979, 0.3131],[0.9001, 0.3196],[0.9022, 0.3252],[0.9037, 0.3318],[0.9048, 0.3383],[0.9053, 0.3449],[0.9064, 0.3514],[0.9064, 0.3589],[0.9074, 0.3654],[0.9079, 0.372],[0.909, 0.3785],[0.91, 0.3851],[0.9106, 0.3916],[0.9111, 0.3981],[0.9116, 0.4047],[0.9127, 0.4112],[0.9132, 0.4187],[0.9137, 0.4252],[0.9143, 0.4318],[0.9148, 0.4383],[0.9153, 0.4449],[0.9153, 0.4514],[0.9158, 0.458],[0.9164, 0.4645],[0.9164, 0.471],[0.9164, 0.4776],[0.9164, 0.4841],[0.9164, 0.4907],[0.9164, 0.4972],[0.9164, 0.5037],[0.9158, 0.5103],[0.9153, 0.5168],[0.9143, 0.5243],[0.9132, 0.5308],[0.9122, 0.5374],[0.9116, 0.5439],[0.9116, 0.5505],[0.9106, 0.557],[0.9106, 0.5636],[0.9095, 0.5701],[0.9085, 0.5766],[0.9079, 0.5832],[0.9069, 0.5897],[0.9053, 0.5963],[0.9043, 0.6028],[0.9027, 0.6094],[0.9006, 0.615],[0.899, 0.6215],[0.8979, 0.628],[0.8964, 0.6346],[0.8937, 0.6393],[0.8911, 0.6439],[0.8895, 0.6505],[0.8874, 0.6561],[0.8858, 0.6626],[0.8837, 0.6692],[0.8822, 0.6757],[0.8811, 0.6823],[0.8795, 0.6888],[0.878, 0.6953],[0.8759, 0.7009],[0.8738, 0.7066],[0.8716, 0.7122],[0.8695, 0.7178],[0.8669, 0.7224],[0.8643, 0.728],[0.8617, 0.7327],[0.859, 0.7383],[0.8564, 0.743],[0.8538, 0.7477],[0.8511, 0.7523],[0.8485, 0.757],[0.8459, 0.7617],[0.8432, 0.7664],[0.8406, 0.771],[0.838, 0.7757],[0.8353, 0.7804],[0.8327, 0.786],[0.8301, 0.7907],[0.8264, 0.7935],[0.8238, 0.7981],[0.8206, 0.8019],[0.8175, 0.8056],[0.8143, 0.8094],[0.8106, 0.8122],[0.8075, 0.8159],[0.8038, 0.8187],[0.8001, 0.8215],[0.7964, 0.8252],[0.7927, 0.828],[0.7901, 0.8327],[0.7864, 0.8355],[0.7833, 0.8393],[0.7796, 0.8421],[0.7764, 0.8458],[0.7733, 0.8495],[0.7696, 0.8523],[0.7654, 0.8561],[0.7617, 0.8608],[0.758, 0.8617],[0.7543, 0.8626],[0.7507, 0.8636],[0.747, 0.8645],[0.7433, 0.8654],[0.7396, 0.8673],[0.7359, 0.8692],[0.7322, 0.871],[0.7291, 0.8748],[0.7254, 0.8757],[0.7217, 0.8757],[0.718, 0.8757],[0.7144, 0.8757],[0.7107, 0.8757],[0.707, 0.8766],[0.7033, 0.8776],[0.6996, 0.8785],[0.6959, 0.8795],[0.6923, 0.8804],[0.6886, 0.8813],[0.6849, 0.8832],[0.6812, 0.8832],[0.6775, 0.8832],[0.6739, 0.8841],[0.6702, 0.8841],[0.6665, 0.8841],[0.6618, 0.8841],[0.6581, 0.8832],[0.6544, 0.8813],[0.6507, 0.8813],[0.647, 0.8804],[0.6433, 0.8804]] },
];

// The two tarmac↔dirt TRANSITION EDGES, hand-drawn by the designer (draw.html sketch tool) as
// fractions (x/W, y/H) of the track box — they map 1:1 onto the render canvas. The dirt is CUT to
// exactly these lines at each end, so the border is the real drawn curve (RENDER-ONLY).
const RALLYCROSS_DIRT_EDGES: [number, number][][] = [
  [[0.3426, 0.3647], [0.3391, 0.3622], [0.3341, 0.3597], [0.3298, 0.3584], [0.3256, 0.3572], [0.322, 0.3559], [0.3178, 0.3559], [0.3135, 0.3559], [0.31, 0.3572], [0.3064, 0.3584], [0.3029, 0.3609], [0.2993, 0.3635], [0.2958, 0.3647], [0.2922, 0.3685], [0.2887, 0.3723], [0.2851, 0.3748], [0.2816, 0.3761], [0.278, 0.3773], [0.2745, 0.3786], [0.2702, 0.3786], [0.2667, 0.3748], [0.2631, 0.371], [0.2596, 0.3698], [0.256, 0.3672], [0.2525, 0.3635], [0.2489, 0.3597], [0.2454, 0.3559], [0.2418, 0.3546], [0.2383, 0.3521]],
  [[0.7592, 0.7783], [0.7564, 0.7834], [0.755, 0.7897], [0.755, 0.7972], [0.755, 0.8048], [0.755, 0.8124], [0.7543, 0.8187], [0.7543, 0.8262], [0.7543, 0.8338], [0.7543, 0.8414], [0.755, 0.8477], [0.7557, 0.854], [0.7557, 0.8615], [0.755, 0.8678], [0.7535, 0.8741], [0.7507, 0.8792], [0.7479, 0.8842], [0.745, 0.8893], [0.7436, 0.8956], [0.7408, 0.9006], [0.7379, 0.9057], [0.7358, 0.912], [0.7337, 0.9183], [0.7315, 0.9246], [0.7287, 0.9296], [0.7259, 0.9347], [0.723, 0.9397], [0.7195, 0.9435], [0.7159, 0.9448], [0.7117, 0.9448], [0.7081, 0.946], [0.7046, 0.9485], [0.701, 0.9511], [0.6975, 0.9548], [0.6961, 0.9561]],
];

// Designer-marked lines (draw.html) — where the dirt should NEATLY connect to the edge/kerb at the
// two transition corners (small asphalt slivers). Dirt is added as a THIN strip along each line and
// clipped to the ribbon so it can't spill past the kerb. Fractions of the track box. RENDER-ONLY.
const RALLYCROSS_DIRT_FILL: [number, number][][] = [
  [[0.2448, 0.358], [0.2411, 0.357], [0.2374, 0.3598], [0.2369, 0.3598]],
  [[0.7134, 0.9461], [0.7107, 0.9508], [0.7107, 0.9574], [0.7086, 0.9593]],
];

// Dirt-zone raster (same grid as circuitMask): the ribbon stroked over ONLY [i0,i1] at band width.
let _rallyDirtMask: Uint8Array | null | undefined;
let _rdW = 0, _rdH = 0;
function rallyDirtMask(): Uint8Array | null {
  if (_rallyDirtMask !== undefined) return _rallyDirtMask;
  if (typeof document === 'undefined') { _rallyDirtMask = null; return null; }
  const W = Math.max(1, Math.round(CIRCUIT_LOGICAL.widthM * CIRCUIT_MASK_PPM));
  const H = Math.max(1, Math.round(CIRCUIT_LOGICAL.heightM * CIRCUIT_MASK_PPM));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d', { willReadFrequently: true });   // read back via getImageData
  if (!c) { _rallyDirtMask = null; return null; }
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  const seg = CIRCUIT_PATH.slice(RALLYCROSS_DIRT.i0, RALLYCROSS_DIRT.i1 + 1)
    .map((p) => circuitToWorld(p[0], p[1]));
  if (seg.length >= 2) {
    c.strokeStyle = '#fff'; c.lineJoin = 'round'; c.lineCap = 'round';
    c.lineWidth = CIRCUIT_TRACK_W * CIRCUIT_MASK_PPM;
    c.beginPath();
    c.moveTo(seg[0].x * CIRCUIT_MASK_PPM, seg[0].y * CIRCUIT_MASK_PPM);
    for (let i = 1; i < seg.length; i++) c.lineTo(seg[i].x * CIRCUIT_MASK_PPM, seg[i].y * CIRCUIT_MASK_PPM);
    c.stroke();
  }
  try {
    const img = c.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = img[i * 4] > 128 ? 1 : 0;
    _rdW = W; _rdH = H; _rallyDirtMask = mask;
    return mask;
  } catch (err) {
    noteError('rally-dirt-mask', err);
    return null;   // don't cache the failure — retry later; surfaceAt then reads no-dirt (asphalt)
  }
}
function rallyDirtAt(x: number, y: number): boolean {
  const m = rallyDirtMask(); if (!m) return false;
  const mx = (x * CIRCUIT_MASK_PPM) | 0, my = (y * CIRCUIT_MASK_PPM) | 0;
  if (mx < 0 || my < 0 || mx >= _rdW || my >= _rdH) return false;
  return m[my * _rdW + mx] !== 0;
}
// Ground lookup: the circuit's (asphalt/gravel/grass), but the ribbon on the dirt arc reads 'dirt'.
function rallycrossSurfaceAt(x: number, y: number): Surface {
  const c = circuitClassAt(x, y);
  if ((c === 'asphalt' || c === 'kerb') && rallyDirtAt(x, y)) return 'dirt';
  return c === 'kerb' ? 'asphalt' : c;
}
// RENDER-ONLY mark class: dirt takes the gravel (brown gouge) class.
function rallycrossClassAt(x: number, y: number): MarkClass {
  const c = circuitClassAt(x, y);
  if ((c === 'asphalt' || c === 'kerb') && rallyDirtAt(x, y)) return 'gravel';
  return c;
}

// ---- DEV dirt-edit tool support (arc-index picking + live range) ----
/** The circuit path in WORLD metres (for the dirt-edit overlay). */
export function rallycrossPathWorld(): Array<[number, number]> {
  return CIRCUIT_PATH.map((p) => { const w = circuitToWorld(p[0], p[1]); return [w.x, w.y] as [number, number]; });
}
/** Nearest CIRCUIT_PATH index to a world point (for click-to-mark). */
export function nearestRallycrossIndex(x: number, y: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < CIRCUIT_PATH.length; i++) {
    const w = circuitToWorld(CIRCUIT_PATH[i][0], CIRCUIT_PATH[i][1]);
    const d = (w.x - x) * (w.x - x) + (w.y - y) * (w.y - y);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
export const RALLYCROSS_PATH_LEN = CIRCUIT_PATH.length;
export function getRallycrossDirt(): { i0: number; i1: number } { return { ...RALLYCROSS_DIRT }; }
/** Set the dirt arc live (dev tool). Invalidates the physics mask so the next query re-bakes. */
export function setRallycrossDirt(i0: number, i1: number): void {
  const n = CIRCUIT_PATH.length;
  RALLYCROSS_DIRT.i0 = Math.max(0, Math.min(n - 1, Math.round(i0)));
  RALLYCROSS_DIRT.i1 = Math.max(0, Math.min(n - 1, Math.round(i1)));
  _rallyDirtMask = undefined;   // physics re-bakes on next surfaceAt; render rebuilds on switchMap
}

export const rallycrossMap: MapDefinition = {
  ...circuitMap,
  id: 'rallycross',
  name: 'Rallycross',
  surfaceAt: rallycrossSurfaceAt,
  // Its own switcher option in the shared 'circuit' group (override — the spread copied circuit's).
  surfaceGroup: { key: 'circuit', title: 'Circuit', option: 'Rallycross', order: 1 },
  // The circuit surface + the dirt section over the locked arc (SURFACES.dirt = darker packed look).
  drawBackground(ctx, wPx, hPx) { drawCircuitSurface(ctx, wPx, hPx, RALLYCROSS_DIRT); },
};

// Register the built-in maps. The desktop is FIRST (the default).
// =============================================================================
//  MAP 6 — CIRCUIT II (authored in track-editor.html, the boss's own layout).
//  The editor's export run through the SAME pipeline as the circuit: an asphalt
//  ribbon on grass and nothing else (no kerbs / gravel / billboards — v1 by
//  request: "asphalt, grass around"). Geometry, mask, finish, far point, spawn —
//  ALL derive from the two authored constants below, so a new export from the
//  editor drops in by replacing just them. Dev-gated in desktop.ts (DEV_MAP_IDS)
//  until the boss promotes it.
// =============================================================================
const AUTHORED_SKETCH: Array<[number, number]> = [
  [1089,712],[911,710],[822,710],[758,618],[787,519],[875,480],[890,377],
  [777,278],[634,304],[519,441],[438,607],[183,626],[91,505],[80,271],
  [196,179],[421,249],[652,77],[965,100],[1016,307],[1061,475],[1278,492],
  [1326,171],[1507,43],[1685,196],[1634,310],[1529,307],[1444,399],[1509,551],
  [1776,551],[1774,633],[1797,680],[1740,719],[1611,713],[1520,715],[1397,710],
  [1271,712],
];
const AUTHORED_BAND = 150;
// DIRT section — a contiguous arc [i0→i1] of the 1000-pt ribbon (forward, wrap
// allowed), marked in the editor; null = all-asphalt. Same model as RALLYCROSS_DIRT.
const AUTHORED_DIRT: { i0: number; i1: number } | null = { i0: 205, i1: 664 };
// DIRT transition EDGES — 0–2 hand-marked boundary polylines (sketch units), each
// spanning the band from one asphalt edge to the other at a dirt end. Points are
// connected STRAIGHT (the boss's spec: "just connect the dots"); each line is
// assigned to the NEARER dirt end by proximity, the band is extended a little past
// that end and CUT to the drawn line — so the tarmac↔dirt border is exactly the
// marked polyline. [] = both ends keep the plain straight cut.
const AUTHORED_DIRT_EDGES: Array<Array<[number, number]>> = [
  [[1407,188],[1408,171],[1406,167],[1397,163],[1390,161],[1386,161],[1377,155],[1376,147],[1365,140],[1361,140],[1349,136],[1346,127],[1344,115],[1343,106],[1332,100],[1332,92],[1329,87]],
  [[429,488],[440,492],[448,495],[457,498],[461,503],[473,505],[489,500],[500,499],[522,502],[529,502],[541,497],[548,490],[563,490],[571,490],[574,492]],
];
// GRAVEL run-off — FREEHAND strokes (sketch units + brush width `w`), painted like a
// drawn swath: each stroke is stroked at its brush width (smoothed). Laid UNDER the
// tarmac (circuit style: overlap with the ribbon hides beneath it) and baked into the
// mask as real 'gravel' physics; gravel is OFF TRACK (a run-off, outside the ribbon).
const AUTHORED_GRAVEL: Array<{ w: number; pts: Array<[number, number]> }> = [
  { w: 70, pts: [[1774,849],[1771,849],[1768,849],[1766,849],[1763,849],[1760,849],[1755,851],[1752,851],[1749,852],[1747,852],[1742,852],[1735,852],[1732,852],[1725,852],[1717,852],[1714,852],[1711,852],[1707,852],[1704,852],[1695,852],[1692,852],[1682,852],[1675,851],[1672,851],[1669,851],[1666,851],[1662,851],[1657,851],[1648,851],[1640,851],[1632,851],[1629,851],[1626,851],[1623,851],[1615,851],[1607,851],[1603,851],[1599,851],[1594,851],[1590,851],[1585,851],[1581,851],[1578,851],[1575,851],[1572,851],[1569,851],[1566,851],[1562,851],[1559,851],[1556,851],[1553,851],[1550,851],[1547,852],[1544,852],[1540,852],[1537,852],[1533,854],[1530,854],[1527,854],[1524,855],[1521,855],[1518,855],[1515,855],[1512,855],[1509,855],[1506,855],[1503,855],[1500,855],[1498,855],[1493,855],[1490,855],[1487,854],[1484,854],[1481,854],[1478,854],[1476,854],[1473,854],[1470,854]] },
  { w: 88, pts: [[1773,898],[1770,898],[1767,898],[1755,898],[1733,896],[1726,896],[1711,893],[1694,892],[1686,890],[1682,890],[1675,889],[1664,888],[1653,886],[1644,886],[1635,886],[1626,886],[1618,886],[1609,886],[1600,885],[1596,885],[1591,885],[1581,885],[1569,885],[1559,883],[1552,883],[1544,883],[1536,883],[1528,883],[1524,882],[1517,882],[1508,882],[1498,880],[1487,879],[1480,879],[1471,879],[1465,879],[1458,879],[1454,877],[1445,877],[1437,877],[1432,876],[1426,876],[1421,876],[1415,876],[1410,876],[1405,876],[1401,876],[1398,876],[1395,876],[1398,874],[1401,874],[1410,873],[1413,873],[1420,870],[1429,869],[1437,867],[1445,864],[1451,863],[1457,861],[1461,860],[1470,858],[1477,855],[1483,854],[1486,852],[1489,852],[1492,851],[1495,851],[1498,851],[1500,851],[1503,849],[1506,849],[1509,849],[1512,848],[1515,848],[1518,848],[1521,848],[1524,848],[1527,848],[1530,848],[1533,848],[1536,848],[1540,848],[1543,848],[1547,848],[1553,848],[1556,848],[1560,849],[1569,849],[1575,849],[1584,849],[1590,849],[1594,851],[1599,852],[1606,852],[1615,852],[1621,852],[1628,852],[1634,852],[1640,852],[1645,852],[1648,852],[1653,852],[1657,852],[1662,852],[1666,852],[1670,852],[1676,852],[1684,852],[1688,852],[1695,851],[1698,851],[1703,851],[1706,851],[1708,851],[1711,851],[1714,851],[1717,851],[1720,851],[1723,851],[1726,851],[1729,851],[1732,851],[1735,851],[1738,851],[1742,851],[1745,851],[1748,851],[1751,851],[1754,851],[1757,849],[1760,849],[1764,849],[1767,849],[1764,849],[1761,849],[1757,849],[1749,849],[1747,849],[1741,849],[1732,849],[1725,849],[1719,849],[1711,849],[1701,849],[1689,849],[1681,849],[1672,849],[1664,848],[1654,848],[1643,847],[1631,847],[1628,847],[1621,845],[1606,844],[1593,841],[1580,839],[1565,839],[1552,838],[1544,838],[1534,838],[1527,838],[1519,836],[1514,836],[1509,836],[1505,836],[1502,836],[1496,836],[1489,836],[1480,836],[1470,836],[1462,836],[1451,836],[1443,836],[1435,836],[1427,836],[1420,836],[1413,836],[1405,836],[1398,836],[1391,836],[1385,836],[1379,836],[1372,836],[1364,836],[1354,836],[1345,836],[1336,836],[1325,836],[1310,836],[1298,835],[1288,835],[1282,835],[1278,833],[1270,833],[1262,833],[1249,833],[1238,833],[1231,833],[1224,833],[1216,833],[1209,832],[1202,832],[1193,832],[1184,832],[1174,832],[1166,830],[1161,829],[1153,829],[1146,829],[1139,829],[1134,828],[1127,826],[1121,826],[1112,826],[1099,825],[1087,823],[1077,822],[1070,822],[1067,822],[1062,820],[1057,820],[1046,820],[1039,820],[1033,819],[1029,819],[1023,819],[1016,819],[1007,819],[997,819],[989,819],[982,819],[975,817],[970,817],[964,817],[957,817],[951,817],[942,817],[935,817],[931,817],[923,817],[915,817],[906,817],[898,817],[888,817],[884,817],[878,817],[874,817],[871,820],[871,825],[871,828],[871,830],[871,835],[874,839],[879,842],[884,845],[894,847],[904,849],[916,852],[926,852],[929,852],[938,855],[951,858],[963,861],[973,866],[986,869],[1002,873],[1021,877],[1058,883],[1080,886],[1098,886],[1115,889],[1131,889],[1149,890],[1165,892],[1181,892],[1196,892],[1210,892],[1224,892],[1235,892],[1247,892],[1260,892],[1275,892],[1291,892],[1310,893],[1326,893],[1342,893],[1358,896],[1372,896],[1383,898],[1389,899],[1396,899],[1405,899],[1417,901],[1423,901],[1420,901],[1402,901],[1399,901],[1392,901],[1376,901],[1350,901],[1325,901],[1301,901],[1279,901],[1254,901],[1231,901],[1210,901],[1193,901],[1180,901],[1164,901],[1149,901],[1136,901],[1123,901],[1111,901],[1102,901],[1093,901],[1084,901],[1074,901],[1061,901],[1049,901],[1039,901],[1029,901],[1020,901],[1010,901],[997,901],[982,901],[969,901],[960,901],[951,901],[942,901],[935,902],[926,902],[919,902],[912,902],[906,902],[901,902],[897,902],[894,902],[891,902],[888,902],[885,902],[882,902],[879,902],[876,899],[876,896],[874,895],[874,892],[874,889],[874,886],[872,883],[871,880],[868,880],[860,879],[857,879],[852,877],[849,877],[844,877],[841,877],[837,877],[834,876],[831,876],[827,874],[822,874],[819,873],[816,870],[812,869],[808,866],[805,864],[802,864],[802,861],[799,861],[797,858],[794,858],[790,854],[787,852],[783,848],[780,848],[778,845],[775,845],[772,844],[768,841],[765,841],[762,839],[759,838],[756,836],[753,836],[751,835],[748,833],[745,830],[742,829],[736,826],[730,822],[727,819],[721,817],[718,814],[717,811],[714,810],[711,807],[708,804],[705,803],[702,798],[699,795],[696,792],[693,788],[692,785],[689,782],[686,779],[685,776],[682,773],[679,769],[679,766],[677,763],[674,762],[673,759],[671,756],[668,754],[668,751],[666,750],[664,747],[664,744],[661,743],[661,740],[660,737],[657,734],[657,731],[655,728],[654,725],[652,722],[651,719],[649,716],[649,713],[648,711],[647,708],[647,705],[647,700],[645,697],[645,694],[645,691],[644,689],[644,686],[644,683],[644,680],[642,677],[642,674],[642,671],[642,668],[641,665],[641,662],[639,659],[639,656],[639,653],[639,651],[639,648],[639,645],[639,642],[639,639],[639,636],[639,633],[639,630],[639,627],[639,624],[641,621],[641,617],[642,614],[644,611],[644,608],[645,605],[645,602],[645,599],[647,596],[647,593],[648,591],[648,588],[648,585],[648,582],[648,579],[648,576],[648,573],[649,570],[651,567],[651,564],[652,561],[652,558],[654,555],[654,553],[654,550],[655,547],[657,544],[658,541],[660,538],[660,535],[663,533],[663,531],[664,528],[666,525],[668,523],[671,522],[674,520],[677,519],[679,516],[682,516],[685,513],[688,513],[689,510],[692,509],[695,509],[698,507],[701,506],[704,506],[707,506],[709,504],[712,503],[715,503],[718,501],[721,501],[724,501],[727,500],[730,498],[733,498],[736,498],[739,498],[740,495],[743,494],[746,494],[749,493],[752,491],[755,491],[758,490],[755,490],[751,490],[748,490],[743,491],[740,493],[737,493],[733,495],[729,497],[726,498],[723,500],[720,504],[717,507],[715,510],[712,512],[711,514],[709,517],[707,522],[704,525],[704,528],[701,531],[699,536],[696,539],[696,544],[695,547],[695,553],[693,558],[693,566],[693,572],[693,577],[693,583],[693,591],[693,601],[693,611],[693,618],[693,621],[693,629],[693,637],[693,648],[695,658],[695,667],[695,677],[698,686],[699,694],[702,702],[704,712],[707,718],[709,725],[712,731],[715,735],[717,740],[721,744],[727,750],[733,756],[740,763],[746,770],[753,776],[756,779],[762,782],[767,787],[771,788],[775,791],[781,794],[789,798],[796,803],[805,806],[816,810],[824,811],[828,813],[831,814],[834,814],[837,814],[846,817],[855,817],[857,817],[860,817],[863,819],[860,819],[856,819],[853,819],[850,819],[847,819],[844,819],[841,819],[837,819],[840,819],[843,819],[850,820],[853,820],[868,823],[891,828],[913,833],[929,838],[942,842],[950,844],[960,847],[975,849],[989,852],[1001,855],[1016,858],[1035,861],[1054,866],[1076,869],[1093,873],[1112,877],[1137,882],[1165,886],[1191,890],[1221,896],[1250,901],[1282,907],[1316,912],[1351,917],[1380,918],[1410,921],[1442,923],[1473,926],[1502,928],[1524,930],[1550,934],[1572,934],[1585,934],[1594,934],[1604,934],[1616,934],[1626,934],[1641,934],[1656,934],[1669,934],[1676,934],[1681,934],[1688,934],[1692,933],[1697,931],[1694,931],[1691,931],[1688,931],[1682,931],[1679,931],[1675,930],[1670,930],[1667,930],[1660,930],[1657,930],[1638,928],[1612,928],[1590,926],[1566,924],[1549,924],[1536,923],[1519,923],[1508,923],[1498,923],[1483,923],[1465,923],[1448,923],[1423,921],[1398,921],[1370,921],[1341,921],[1314,920],[1291,920],[1268,920],[1250,920],[1234,918],[1213,918],[1197,918],[1184,918],[1175,918],[1162,918],[1147,918],[1128,920],[1111,920],[1099,920],[1087,920],[1074,920],[1064,921],[1052,921],[1045,923],[1039,923],[1032,923],[1024,923],[1017,923],[1010,924],[1001,924],[992,924],[980,924],[973,924],[963,924],[956,923],[950,921],[945,921],[941,921],[938,921],[934,920],[929,920],[923,918],[917,917],[910,917],[904,914],[897,914],[891,914],[885,914],[878,912],[872,911],[869,911],[865,911],[862,911],[859,911],[853,909],[847,908],[844,907],[840,907],[837,907],[833,907],[830,905],[827,905],[824,904],[821,902],[818,899],[815,899],[812,896],[808,895],[806,892],[803,892],[800,889],[797,888],[796,885],[793,885],[790,883],[787,882],[786,879],[783,877],[780,876],[777,874],[775,871],[772,870],[772,867],[770,866],[767,864],[765,861],[762,860],[761,857],[759,854],[758,851],[755,849],[753,847],[751,845],[751,842],[748,841],[748,838],[746,835],[743,833],[743,830],[740,829],[739,826],[736,825],[739,825],[739,828],[740,830],[740,833],[740,836],[743,836],[746,838],[749,839],[751,842],[752,845],[755,845],[756,848],[759,849],[761,852],[762,855],[765,855],[765,858],[767,861],[771,866],[775,871],[781,880],[789,889],[794,895],[796,898],[799,899],[796,899],[793,899],[790,898],[787,896],[784,895],[783,892],[780,890],[777,889],[777,886],[774,885],[772,882],[770,880],[768,877],[765,876],[762,873],[761,870],[758,869],[755,867],[753,864],[751,864],[751,861],[748,860],[746,857],[743,857],[743,854],[740,852],[739,849],[736,848],[736,845],[734,842],[733,839],[730,838],[730,835],[729,832],[727,829],[726,826],[724,823],[723,820],[720,817],[720,814],[718,811],[715,810],[715,807],[714,804],[712,801],[711,797],[709,794],[708,791],[711,792],[712,795],[715,797],[717,800],[720,801],[720,804],[721,807],[723,810],[724,813],[726,816],[727,819],[730,820],[731,823],[734,825],[737,826],[737,829],[740,829],[745,832],[748,835],[751,838],[753,841],[756,841],[758,844],[762,847],[767,849],[772,852],[778,855],[784,857],[792,860],[802,861],[815,863],[828,864],[840,866],[843,866],[855,866],[868,867],[878,870],[891,870],[907,873],[926,873],[942,876],[960,876],[979,879],[1004,882],[1033,885],[1071,888],[1111,890],[1159,893],[1206,896],[1249,898],[1297,898],[1336,898],[1377,898],[1427,898],[1470,898],[1506,896],[1541,893],[1572,889],[1600,886],[1623,883],[1638,883],[1647,883],[1650,882],[1654,880],[1657,879],[1660,877],[1664,876],[1669,873],[1673,871],[1681,867],[1689,863],[1701,857],[1713,851],[1722,844],[1727,836],[1738,826],[1749,816],[1760,809],[1771,800],[1780,795],[1790,790],[1796,785],[1799,782],[1796,782],[1780,784],[1777,785],[1763,788],[1760,788],[1745,795],[1722,801],[1697,807],[1669,814],[1650,819],[1637,819],[1631,820],[1634,820],[1637,820],[1653,814],[1660,813],[1681,807],[1719,797],[1752,787],[1774,779],[1795,773],[1812,769],[1815,768],[1817,781],[1817,785],[1817,788],[1817,809],[1812,838],[1804,867],[1798,893],[1792,909],[1792,912],[1793,908],[1804,893],[1807,890],[1823,870],[1842,851],[1852,844],[1848,854],[1843,861],[1840,866],[1830,883],[1817,899],[1809,909],[1808,904],[1811,898],[1811,895],[1821,869],[1837,841],[1845,825],[1846,819],[1846,816],[1846,811],[1846,801],[1846,787],[1848,773],[1852,759],[1855,743],[1859,725],[1864,706],[1865,694],[1867,687],[1867,684],[1867,691],[1865,696],[1861,718],[1858,725],[1853,747],[1849,763],[1848,768],[1848,763],[1848,759],[1848,747],[1849,744],[1849,727],[1851,712],[1852,700],[1852,691],[1852,689],[1851,697],[1849,700],[1846,708],[1837,728],[1826,754],[1821,766],[1821,763],[1827,750],[1829,746],[1830,741],[1834,728],[1840,711],[1846,691],[1851,671],[1853,651],[1855,636],[1856,627],[1856,623],[1856,618],[1856,615],[1856,611],[1856,608],[1856,604],[1856,598],[1855,593],[1853,586],[1852,583],[1852,579],[1851,569],[1848,561],[1846,554],[1845,550],[1845,547],[1842,545],[1840,541],[1837,536],[1834,531],[1831,525],[1830,522],[1827,519],[1826,516],[1821,512],[1815,506],[1812,501],[1809,498],[1807,497],[1801,493],[1795,490],[1785,485],[1783,482],[1779,481],[1774,478],[1771,478],[1768,476],[1766,476],[1763,475],[1760,475],[1757,475],[1754,475],[1751,474],[1748,474],[1742,474],[1739,474],[1736,474],[1733,474],[1730,474],[1727,474],[1725,474],[1722,474],[1719,474],[1716,474],[1710,474],[1707,474],[1710,475],[1714,475],[1719,475],[1723,475],[1726,475],[1729,475],[1732,476],[1735,476],[1738,476],[1741,476],[1744,476],[1747,476],[1749,476],[1752,476],[1755,476],[1758,478],[1761,478],[1764,478],[1767,479],[1770,479],[1773,481],[1777,481],[1780,481],[1783,482],[1780,482],[1777,482],[1774,484],[1770,484],[1767,484],[1764,484],[1761,485],[1757,485],[1754,485],[1751,485],[1748,485],[1745,485],[1742,487],[1739,487],[1736,487],[1733,487],[1729,488],[1726,488],[1723,488],[1720,488],[1717,488],[1714,488],[1711,488],[1708,488],[1706,488],[1703,488],[1700,488],[1697,490],[1700,490],[1701,487],[1698,488],[1695,488],[1694,491],[1691,491],[1688,494],[1685,494],[1688,495],[1689,493],[1692,491],[1695,490],[1698,490],[1698,487],[1701,487],[1704,485],[1706,482],[1708,482],[1710,479],[1707,478],[1704,479],[1701,481],[1698,481]] },
  { w: 88, pts: [[503,608],[500,611],[497,617],[496,620],[491,623],[491,626],[488,626],[488,629],[487,632],[484,632],[484,634],[481,637],[478,640],[477,643],[474,646],[471,649],[469,652],[466,653],[465,656],[462,658],[462,661],[459,662],[459,665],[456,665],[456,668],[452,671],[449,674],[447,677],[444,678],[441,681],[439,684],[436,686],[434,689],[430,690],[428,693],[425,693],[422,696],[419,697],[419,700],[417,700],[415,703],[412,705],[411,708],[408,708],[405,709],[405,712],[402,712],[400,715],[398,715],[396,718],[393,719],[390,721],[387,722],[383,725],[378,727],[376,730],[373,730],[368,732],[365,735],[362,735],[358,738],[355,740],[352,740],[349,741],[345,744],[340,744],[335,746],[330,747],[327,747],[324,747],[321,749],[315,750],[311,751],[307,751],[302,751],[299,751],[295,751],[289,751],[286,751],[282,751],[274,751],[267,751],[261,751],[257,751],[253,751],[247,751],[242,751],[236,751],[231,751],[225,750],[219,750],[214,750],[207,749],[200,749],[194,747],[188,746],[181,746],[173,744],[168,743],[159,741],[153,740],[149,738],[146,738],[143,737],[135,735],[129,732],[125,731],[121,731],[118,728],[110,728],[105,725],[100,722],[96,721],[90,716],[87,713],[81,711],[77,706],[71,702],[66,697],[61,690],[56,684],[50,677],[47,674],[43,670],[40,664],[36,656],[33,651],[30,643],[25,636],[23,627],[18,623],[18,617],[15,612],[14,608],[12,602],[11,595],[9,591],[8,583],[8,580],[6,577],[5,574],[4,572],[2,566],[1,561],[1,555],[-2,550],[-2,541],[-4,532],[-5,526],[-5,522],[-7,517],[-7,514],[-7,512],[-7,506],[-8,503],[-10,497],[-11,490],[-11,484],[-11,481],[-11,478],[-11,475],[-11,472],[-11,468],[-11,462],[-10,457],[-8,453],[-8,447],[-8,444],[-5,447],[-5,452],[-2,459],[-2,462],[1,471],[2,482],[5,495],[6,507],[9,517],[11,525],[14,533],[17,542],[20,550],[24,557],[28,567],[34,577],[40,586],[47,596],[53,604],[61,612],[66,618],[71,624],[75,630],[81,634],[88,640],[96,646],[100,651],[106,655],[112,658],[118,662],[125,667],[132,671],[141,675],[144,678],[147,680],[151,683],[154,684],[157,686],[162,687],[165,687],[170,689],[176,690],[184,690],[190,691],[194,693],[198,694],[206,694],[214,696],[220,696],[226,697],[233,697],[238,697],[242,697],[251,697],[260,699],[269,699],[274,700],[283,700],[292,700],[299,702],[305,702],[311,702],[317,702],[323,702],[329,702],[337,702],[348,702],[355,702],[361,702],[368,702],[377,702],[383,702],[387,700],[390,700],[395,699],[398,699],[402,699],[405,697],[408,696],[412,694],[417,693],[421,691],[424,689],[421,690],[418,693],[415,694],[414,697],[409,697],[406,702],[403,703],[400,705],[398,708],[395,709],[393,712],[390,712],[390,715],[393,715],[396,713],[403,711],[408,706],[411,705],[408,706],[405,709],[402,712],[399,715],[396,716],[392,719],[389,721],[386,722],[383,724],[380,725],[377,727],[373,730],[370,731],[367,732],[364,734],[361,734],[361,737],[358,737],[355,740],[352,741],[349,743],[346,744],[343,746],[342,749],[339,749],[336,750],[333,750],[329,751],[326,753],[323,753],[318,754],[313,756],[308,756],[304,756],[298,756],[289,757],[285,759],[282,759],[279,759],[276,759],[272,759],[267,759],[261,759],[257,760],[251,762],[247,762],[238,762],[233,762],[228,762],[223,762],[219,762],[213,762],[207,762],[203,762],[197,762],[191,760],[187,760],[184,760],[179,759],[173,759],[166,757],[157,756],[150,754],[144,753],[138,753],[134,751],[129,750],[127,750],[121,749],[116,747],[112,746],[109,746],[106,744],[103,743],[99,743],[96,741],[91,738],[87,738],[84,737],[80,735],[77,732],[74,731],[71,730],[68,728],[65,727],[59,722],[55,721],[52,719],[50,716],[47,713],[45,712],[40,708],[37,706],[36,703],[33,700],[30,699],[28,696],[25,694],[23,691],[23,689],[20,686],[17,681],[14,678],[11,674],[11,671],[8,670],[8,667],[5,664],[5,661],[4,658],[4,655],[2,652],[2,649],[1,646],[1,643],[1,639],[-1,634],[-1,632],[-1,627],[-2,624],[-4,621],[-4,618],[-4,615],[-4,612],[-4,610],[-4,602]] },
  { w: 88, pts: [[-1,453],[-1,450],[-1,447],[-4,438],[-5,435],[-7,430],[-10,422],[-10,419],[-11,415],[-13,409],[-14,406],[-14,402],[-14,397],[-14,393],[-14,390],[-14,386],[-14,380],[-14,376],[-14,371],[-14,365],[-14,361],[-14,354],[-14,346],[-14,340],[-14,336],[-14,333],[-14,330],[-14,324],[-14,321],[-14,318],[-14,316],[-13,310],[-13,307],[-11,302],[-11,298],[-11,295],[-11,292],[-10,289],[-10,285],[-8,280],[-8,277],[-7,273],[-7,270],[-7,267],[-5,263],[-4,260],[-4,257],[-2,254],[-1,251],[-1,248],[1,245],[2,242],[4,239],[4,237],[5,234],[6,229],[6,226],[8,223],[9,220],[11,218],[12,215],[14,212],[14,209],[17,206],[18,203],[20,200],[21,197],[24,194],[25,191],[28,187],[30,184],[31,181],[34,179],[36,177],[37,174],[40,172],[43,169],[46,168],[46,165],[49,165],[50,162],[53,162],[56,159],[61,156],[64,153],[66,152],[68,149],[72,147],[75,146],[78,144],[81,143],[84,141],[87,140],[90,140],[93,139],[96,137],[99,137],[102,136],[105,136],[107,134],[110,133],[113,133],[116,131],[119,131],[122,130],[125,130],[128,130],[131,130],[134,130],[137,128],[140,128],[143,128],[146,128],[149,128],[151,128],[154,128],[157,128],[160,128],[163,128],[166,128],[169,128],[172,128],[175,128],[178,128],[181,128],[184,128],[187,128],[190,128],[192,128],[195,128],[198,128],[201,128],[204,128],[207,128],[210,128],[214,128],[217,128],[220,128],[223,128],[226,128],[229,128],[232,128],[235,128],[238,128],[241,130],[244,130],[247,130],[242,128],[239,125],[236,124],[233,122],[229,121],[226,118],[222,118],[219,115],[216,115],[213,114],[209,112],[204,111],[201,109],[195,108],[191,108],[185,106],[181,106],[173,106],[165,105],[160,105],[156,105],[151,103],[146,102],[141,102],[137,102],[134,102],[128,100],[124,100],[121,100],[116,100],[113,100],[110,100],[107,100],[105,100],[102,100],[99,100],[96,100],[93,100],[90,100],[87,100],[83,100],[80,100],[77,100],[74,102],[71,102],[68,102],[65,103],[62,103],[59,103],[56,105],[53,105],[50,106],[47,106],[45,106],[40,108],[37,109],[33,111],[30,111],[25,112],[23,114],[18,115],[14,117],[11,118],[8,121],[4,121],[2,124],[-1,124],[-4,127],[-7,128],[-8,131],[-11,133],[-13,136],[-16,137],[-18,139],[-20,141],[-23,143],[-24,146],[-27,147]] },
  { w: 88, pts: [[1262,228],[1262,225],[1262,220],[1262,218],[1262,215],[1262,212],[1262,209],[1262,206],[1262,201],[1262,198],[1262,196],[1265,188],[1265,184],[1265,181],[1266,178],[1268,175],[1268,172],[1269,166],[1270,162],[1272,158],[1272,155],[1273,150],[1275,146],[1275,143],[1276,139],[1278,136],[1278,133],[1279,130],[1279,127],[1281,124],[1281,121],[1282,118],[1282,115],[1284,112],[1285,109],[1285,106],[1285,102],[1288,99],[1288,95],[1290,92],[1290,87],[1291,84],[1292,80],[1294,77],[1295,73],[1297,70],[1297,67],[1300,64],[1301,60],[1304,55],[1306,52],[1309,49],[1309,46],[1311,42],[1313,39],[1314,36],[1316,33],[1319,29],[1320,24],[1322,21],[1323,19],[1326,14],[1329,13],[1329,10],[1332,5],[1333,2],[1336,0],[1339,-2],[1341,-5],[1344,-6],[1345,-9],[1348,-11],[1351,-14],[1355,-17],[1358,-19],[1361,-21],[1366,-24],[1369,-25],[1372,-28],[1374,-30],[1379,-33],[1382,-34],[1386,-37],[1389,-39],[1392,-40],[1395,-41],[1399,-43],[1402,-44],[1405,-46],[1408,-46],[1411,-47],[1414,-49],[1417,-49],[1420,-50],[1423,-52],[1426,-52],[1429,-53],[1432,-53],[1435,-53],[1437,-53],[1440,-53],[1443,-55],[1446,-56],[1451,-56],[1454,-56],[1458,-58],[1464,-59],[1467,-59],[1471,-60],[1477,-60],[1480,-60],[1484,-60],[1487,-62],[1492,-63],[1495,-63],[1499,-63],[1503,-63],[1509,-63],[1512,-63],[1515,-65],[1519,-65],[1524,-66],[1528,-66],[1534,-68],[1539,-68],[1543,-68],[1546,-68],[1549,-68],[1552,-68],[1556,-68],[1559,-68],[1562,-68],[1566,-68],[1569,-68],[1572,-68],[1577,-68],[1581,-68],[1584,-68],[1587,-68],[1590,-68],[1593,-68],[1596,-66],[1599,-65],[1602,-65],[1606,-63],[1610,-62],[1613,-62],[1618,-60],[1621,-59],[1623,-58],[1628,-56],[1632,-55],[1637,-52],[1640,-50],[1643,-50],[1647,-49],[1650,-47],[1653,-44],[1656,-43],[1659,-40],[1662,-39],[1664,-36],[1667,-34],[1670,-33],[1672,-30],[1675,-28],[1678,-25],[1682,-21],[1685,-19],[1688,-17],[1689,-14],[1694,-11],[1695,-8],[1697,-5],[1698,-2],[1700,1],[1703,4],[1704,7],[1707,8],[1710,13],[1713,17],[1714,20],[1717,21],[1719,24],[1720,27],[1722,30],[1723,33],[1725,36],[1726,39],[1729,43],[1729,46],[1729,49],[1732,51],[1732,54],[1733,58],[1733,61],[1735,64],[1736,67],[1736,70],[1738,74],[1739,77],[1741,80],[1741,83],[1741,86],[1744,86],[1744,90],[1744,93],[1744,96],[1745,99],[1747,102],[1748,105],[1748,108],[1749,112],[1751,115],[1751,118],[1751,122],[1751,125],[1752,128],[1752,133],[1752,136],[1752,140],[1752,143],[1752,146],[1752,149],[1752,152],[1752,155],[1754,158],[1754,160],[1754,163],[1754,166],[1754,169],[1754,172],[1754,175],[1754,178],[1754,181],[1754,185],[1754,188],[1754,191],[1754,194],[1752,197],[1752,200],[1752,204],[1749,207],[1749,212],[1748,215],[1747,218],[1745,220],[1745,225],[1742,226],[1742,229],[1741,232],[1739,235],[1738,238],[1736,241],[1735,244],[1735,247],[1732,251],[1730,256],[1729,258],[1727,261],[1727,264],[1725,269],[1723,272],[1722,275],[1720,277],[1717,280],[1714,285],[1711,288],[1711,291],[1708,292],[1706,297],[1701,301],[1697,305],[1692,310],[1689,311],[1685,316],[1681,318],[1678,320],[1675,323],[1672,326],[1667,327],[1664,330],[1662,332],[1659,332],[1656,333],[1653,333],[1650,335],[1647,335],[1644,335],[1641,335],[1637,336],[1634,337],[1628,339],[1623,339],[1621,339],[1616,340],[1612,342],[1609,342],[1606,342],[1602,343],[1596,343],[1593,343],[1588,343],[1585,345],[1588,345],[1596,342],[1603,340],[1606,340],[1610,339],[1616,336],[1621,336],[1625,335],[1631,333],[1635,330],[1640,329],[1643,327],[1647,326],[1650,321],[1654,320],[1657,318],[1663,316],[1669,311],[1675,307],[1678,307],[1684,302],[1694,298],[1700,294],[1706,289],[1708,285],[1711,280],[1716,276],[1720,269],[1723,263],[1727,256],[1732,247],[1735,239],[1736,232],[1738,225],[1741,216],[1741,209],[1741,200],[1741,188],[1741,178],[1741,163],[1738,152],[1736,140],[1732,131],[1727,119],[1722,112],[1716,102],[1708,93],[1703,84],[1691,73],[1684,64],[1676,58],[1669,52],[1660,46],[1651,42],[1643,38],[1632,30],[1622,27],[1612,24],[1604,21],[1594,19],[1587,17],[1575,14],[1563,11],[1552,8],[1537,5],[1525,2],[1515,1],[1508,0],[1492,-2],[1476,-2],[1459,-2],[1445,-2],[1435,-2],[1426,0],[1417,0],[1413,0],[1405,1],[1399,2],[1395,4],[1389,4],[1380,7],[1374,7],[1373,10],[1370,11],[1369,14],[1366,14],[1366,17],[1363,19],[1361,21],[1360,24],[1363,23],[1366,21],[1363,21],[1363,24],[1360,26],[1358,29]] },
  { w: 88, pts: [[736,14],[739,14],[745,13],[748,11],[751,10],[753,8],[756,8],[761,5],[765,4],[771,1],[775,-2],[778,-2],[783,-5],[787,-5],[793,-8],[799,-9],[806,-11],[812,-12],[816,-12],[821,-12],[824,-12],[827,-14],[830,-15],[833,-15],[835,-17],[840,-17],[843,-17],[846,-17],[849,-17],[853,-18],[857,-18],[860,-18],[865,-19],[869,-19],[874,-19],[878,-19],[881,-19],[885,-19],[888,-19],[893,-18],[900,-18],[906,-17],[909,-15],[912,-15],[916,-15],[919,-14],[922,-14],[925,-14],[931,-14],[934,-12],[937,-12],[939,-11],[942,-11],[945,-11],[950,-9],[954,-8],[958,-6],[963,-5],[966,-3],[970,-2],[973,0],[976,1],[979,2],[982,4],[986,7],[989,7],[991,10],[994,11],[997,13],[1000,16],[1004,20],[1007,21],[1008,24],[1010,27],[1013,29],[1014,32],[1017,35],[1019,38],[1020,40],[1023,43],[1024,46],[1027,49],[1030,54],[1032,57],[1035,58],[1035,61],[1038,64],[1039,67],[1042,70],[1043,74],[1046,77],[1049,83],[1052,87],[1054,90],[1057,93],[1057,96],[1058,99],[1060,102],[1061,105],[1062,109],[1062,112],[1062,118],[1064,124],[1064,127],[1064,131],[1064,134],[1065,137],[1067,141],[1067,146],[1068,150],[1068,153],[1070,156],[1070,159],[1071,162],[1071,165],[1071,169],[1073,172],[1073,175],[1073,178],[1074,181],[1074,184],[1074,187],[1074,190],[1074,193],[1074,196],[1074,198],[1074,201],[1074,204],[1074,207],[1073,210],[1073,213],[1070,218],[1068,220],[1068,223],[1065,223],[1065,226],[1064,229],[1062,232],[1061,235],[1061,238],[1060,241],[1060,244],[1058,247],[1058,250],[1058,253],[1058,250],[1062,247],[1065,241],[1067,238],[1070,235],[1073,229],[1077,222],[1082,218],[1083,212],[1084,207],[1086,204],[1087,200],[1089,194],[1089,190],[1090,185],[1090,179],[1092,175],[1092,168],[1092,163],[1092,160],[1092,155],[1092,149],[1092,144],[1092,139],[1092,133],[1092,128],[1090,122],[1090,118],[1090,115],[1089,111],[1086,105],[1086,99],[1083,93],[1083,90],[1080,84],[1077,79],[1074,74],[1073,68],[1068,64],[1065,58],[1062,52],[1060,45],[1057,42],[1055,38],[1054,35],[1049,30],[1046,27],[1045,23],[1042,20],[1038,14],[1035,11],[1032,8],[1029,4],[1026,2],[1021,0],[1019,-3],[1014,-5],[1011,-9],[1007,-11],[1001,-12],[997,-17],[989,-19],[985,-21],[979,-24],[975,-27],[972,-27],[967,-27],[964,-30],[958,-31],[953,-31],[945,-31],[941,-34],[935,-34],[925,-34],[917,-36],[912,-36],[906,-36],[900,-36],[894,-36],[888,-36],[885,-36],[881,-36],[872,-36],[866,-34],[863,-33],[859,-33],[852,-31],[849,-30],[846,-30],[841,-28],[838,-27],[835,-25],[833,-24],[830,-22],[827,-21],[824,-21],[821,-18],[816,-18],[815,-15],[812,-14],[809,-14],[806,-11],[802,-11],[797,-8],[794,-6],[792,-5],[789,-3],[786,-2],[783,0],[780,0],[783,0],[786,-2],[790,-2],[794,-5],[797,-5],[800,-6],[805,-9],[811,-11],[816,-12],[819,-14],[824,-15],[828,-17],[831,-17],[834,-17],[837,-17],[840,-18],[844,-18],[850,-18],[856,-18],[862,-18],[868,-18],[872,-19],[878,-19],[884,-19],[887,-19],[890,-19],[897,-19],[906,-19],[913,-19],[919,-18],[926,-18],[932,-18],[935,-18],[941,-18],[948,-17],[956,-17],[963,-15],[966,-14],[972,-12],[978,-12],[980,-11],[986,-11],[989,-9],[995,-8],[1002,-6],[1010,-3],[1013,-3],[1017,-2],[1020,0],[1023,1],[1026,4],[1030,4],[1033,5],[1036,7],[1039,7],[1042,8],[1045,11],[1048,13],[1051,14],[1052,17],[1055,17],[1058,20],[1061,21],[1062,24],[1065,27],[1068,29],[1071,32],[1073,35],[1076,36],[1077,39],[1077,42],[1080,46],[1082,49],[1084,54],[1084,57],[1086,60],[1087,62],[1087,65],[1089,68],[1089,71],[1090,74],[1092,77],[1092,80],[1092,83],[1093,86],[1093,89],[1093,92],[1093,95],[1093,98],[1093,100],[1093,103],[1093,106],[1093,109],[1093,112],[1093,115],[1093,118],[1093,121],[1095,124],[1095,127],[1095,130],[1095,133],[1095,136],[1095,139],[1095,141],[1093,144],[1092,147],[1090,150],[1089,153],[1086,155],[1084,158],[1083,160],[1080,162]] },
];
// FINISH — a path index marked in the editor (one click); null = derived from the
// lowest drawn point (the flatten straight), the original behaviour.
const AUTHORED_FINISH_I: number | null = 966;
// KERBS — arcs hugging ONE asphalt edge (side +1 = left of travel, −1 = right),
// each marked in the editor with two clicks on that edge.
export interface AuthoredKerb { i0: number; i1: number; side: -1 | 1 }
const AUTHORED_KERBS: AuthoredKerb[] = [
  { i0: 25, i1: 90, side: 1 },
  { i0: 84, i1: 184, side: -1 },
  { i0: 196, i1: 379, side: 1 },
  { i0: 376, i1: 428, side: -1 },
  { i0: 422, i1: 525, side: 1 },
  { i0: 545, i1: 632, side: -1 },
  { i0: 639, i1: 769, side: 1 },
  { i0: 761, i1: 843, side: -1 },
  { i0: 893, i1: 32, side: -1 },
  { i0: 855, i1: 888, side: 1 },
];

// BILLBOARDS — ad slots placed in the editor: sketch position + per-board `scale`.
// SAME machinery as the circuit's (drawBillboardBody / shadow / leg-collision arcs),
// so collision (a solid circle at each leg's ground point) and the drive-under-to-hide
// draw order are identical. `ad` is added by hand in maps.ts later (like the circuit) —
// the editor only places + sizes; a bare slot shows the "YOUR AD HERE" placeholder.
const AUTHORED_BILLBOARDS: Array<{ sx: number; sy: number; scale: number; ad?: AdSlot }> = [
  // top-centre → TRADEVENTURE (dark link-card poster, cover-fitted edge-to-edge)
  { sx: 1166, sy: 47, scale: 1,
    ad: { img: '/ads/tradeventure-link-card-1200x675.png', url: 'https://tradeventure.app/', fit: 'cover' } },
  // top-left → FREE ("YOUR AD HERE" placeholder, not clickable)
  { sx: 182, sy: 43, scale: 1 },
  // bottom → STEER IT (transparent wordmark, contain-fitted; crop drops the fine subtitle)
  { sx: 540, sy: 868, scale: 1,
    ad: { img: '/ads/steer-it-logo.png', url: 'https://steerit.app/', crop: [0, 0, 1, 0.62] } },
];

// IDEAL LINE — the boss's hand-drawn racing line (the editor's STOPA tool): freehand
// strokes in sketch units + brush width. RENDER-ONLY (no physics, no mask): a subtle
// darker rubbered band on the tarmac, the lighter worn tone on the dirt stretch —
// the rallycross worn-line language. [] = none.
const AUTHORED_LINE: Array<{ w: number; pts: Array<[number, number]> }> = [
  { w: 40, pts: [[1403,752],[1400,751],[1396,751],[1392,751],[1387,751],[1381,751],[1375,751],[1370,751],[1365,751],[1360,751],[1356,751],[1353,751],[1349,751],[1344,751],[1340,751],[1335,751],[1332,751],[1328,751],[1324,751],[1320,751],[1317,751],[1313,751],[1311,750],[1307,750],[1303,750],[1298,749],[1296,747],[1292,747],[1288,747],[1285,747],[1280,747],[1275,747],[1271,746],[1267,746],[1264,746],[1260,746],[1256,746],[1252,746],[1249,746],[1245,746],[1241,746],[1238,746],[1234,746],[1230,746],[1227,746],[1223,746],[1219,746],[1214,746],[1210,746],[1207,746],[1203,746],[1199,746],[1194,746],[1188,746],[1183,746],[1178,746],[1175,746],[1171,746],[1167,746],[1164,746],[1159,746],[1155,746],[1151,746],[1146,746],[1142,746],[1139,746],[1135,746],[1131,746],[1128,746],[1124,746],[1120,746],[1117,746],[1113,746],[1108,745],[1104,745],[1100,745],[1098,744],[1094,744],[1091,742],[1087,741],[1083,741],[1079,741],[1076,740],[1071,739],[1067,737],[1063,736],[1061,735],[1058,734],[1055,732],[1052,731],[1049,730],[1046,729],[1044,728],[1041,726],[1039,724],[1035,724],[1031,721],[1029,720],[1025,720],[1023,719],[1020,718],[1016,718],[1014,716],[1011,715],[1009,714],[1005,714],[1003,713],[999,711],[995,711],[993,710],[990,709],[988,708],[984,708],[982,707],[979,705],[976,705],[973,704],[971,703],[968,702],[965,702],[962,700],[960,699],[957,698],[955,697],[951,697],[948,695],[945,693],[940,692],[937,690],[934,690],[930,689],[927,688],[925,687],[921,687],[919,686],[916,684],[915,682],[913,681],[909,681],[906,678],[903,678],[901,676],[899,674],[897,673],[894,672],[892,671],[890,668],[888,667],[885,666],[883,665],[880,662],[878,661],[876,658],[873,657],[872,655],[869,653],[868,651],[866,650],[863,647],[862,645],[861,642],[858,641],[857,639],[856,636],[855,634],[852,631],[851,629],[851,625],[850,623],[850,619],[848,616],[848,613],[847,610],[846,608],[845,605],[845,602],[845,598],[843,595],[843,592],[842,588],[842,584],[841,582],[841,578],[840,576],[840,572],[840,568],[840,565],[840,561],[840,557],[840,553],[840,550],[840,546],[840,542],[840,539],[840,535],[840,531],[840,528],[840,523],[840,519],[840,514],[840,510],[840,505],[840,502],[840,498],[840,494],[838,492],[838,488],[838,484],[838,481],[838,477],[838,473],[837,471],[837,467],[837,463],[837,460],[836,457],[836,453],[836,450],[836,446],[836,442],[836,439],[836,435],[836,431],[836,427],[836,424],[836,420],[836,416],[835,414],[835,410],[834,408],[832,405],[832,402],[831,399],[830,397],[829,394],[827,390],[826,388],[825,386],[824,383],[822,381],[821,378],[819,377],[817,374],[816,372],[814,371],[811,368],[809,366],[806,363],[804,362],[803,360],[800,358],[799,356],[796,355],[793,352],[790,350],[788,348],[787,346],[784,345],[782,344],[778,342],[774,341],[769,340],[767,339],[764,337],[761,337],[756,336],[752,336],[749,335],[746,335],[742,335],[740,334],[736,334],[733,332],[730,332],[727,331],[724,331],[720,331],[716,331],[712,331],[709,331],[705,331],[701,331],[696,331],[693,331],[688,331],[684,331],[681,332],[678,334],[674,334],[672,335],[668,336],[664,336],[662,339],[659,340],[656,340],[653,341],[651,342],[647,342],[644,345],[639,345],[637,346],[635,348],[632,350],[630,351],[626,353],[623,355],[620,356],[616,358],[614,360],[611,361],[607,363],[604,365],[600,367],[596,369],[594,371],[590,373],[588,374],[585,377],[583,379],[580,382],[578,383],[574,386],[571,388],[569,390],[567,392],[565,394],[562,395],[559,399],[555,400],[554,403],[550,405],[548,408],[544,410],[541,414],[538,418],[533,420],[529,424],[527,426],[525,429],[522,430],[520,434],[516,436],[513,439],[511,441],[508,444],[505,447],[501,450],[499,452],[496,455],[494,457],[491,460],[487,462],[482,466],[480,469],[476,472],[473,476],[470,477],[468,479],[466,482],[464,483],[463,486],[461,488],[459,489],[457,492],[455,494],[454,497],[452,499],[449,502],[448,504],[445,507],[443,509],[440,511],[438,514],[434,516],[432,520],[428,523],[426,525],[424,528],[422,529],[419,531],[416,534],[413,536],[411,539],[408,540],[406,542],[403,544],[401,546],[398,548],[396,550],[394,552],[391,555],[387,557],[384,558],[381,561],[377,563],[375,565],[372,566],[370,567],[368,568],[364,569],[361,571],[355,572],[350,573],[345,574],[343,576],[339,576],[337,577],[333,577],[329,577],[324,577],[321,577],[317,578],[313,578],[309,578],[306,579],[302,579],[297,579],[293,579],[290,579],[286,579],[282,579],[279,579],[275,579],[271,579],[267,579],[264,579],[260,579],[255,579],[251,579],[249,578],[245,578],[240,576],[235,574],[232,574],[230,572],[227,572],[224,571],[222,569],[219,567],[216,566],[213,565],[211,562],[208,561],[206,558],[203,556],[201,555],[198,553],[197,551],[196,547],[193,545],[190,541],[187,539],[186,536],[185,534],[182,532],[181,530],[178,528],[176,526],[175,524],[172,523],[171,520],[170,518],[167,515],[165,513],[164,510],[161,509],[160,507],[159,504],[157,502],[155,500],[154,498],[151,494],[150,492],[149,489],[149,486],[148,483],[146,481],[145,478],[145,474],[144,471],[143,468],[141,465],[140,462],[139,458],[139,453],[138,450],[138,446],[138,442],[136,439],[136,435],[136,431],[136,427],[136,424],[135,421],[135,418],[135,414],[135,410],[134,408],[134,404],[134,400],[133,398],[133,394],[133,390],[133,387],[133,383],[133,379],[133,376],[133,372],[133,368],[131,366],[131,362],[131,358],[131,355],[131,351],[131,347],[131,344],[133,341],[133,337],[135,335],[135,331],[136,329],[138,325],[139,321],[140,319],[141,316],[144,315],[145,313],[148,310],[150,306],[151,304],[154,302],[155,299],[157,297],[159,294],[161,292],[164,289],[166,287],[169,286],[170,283],[172,282],[175,281],[177,279],[180,278],[183,277],[187,276],[190,274],[193,273],[197,271],[201,269],[204,268],[207,267],[209,266],[212,265],[214,263],[217,262],[219,261],[222,260],[224,258],[227,257],[229,256],[233,255],[235,253],[238,252],[241,252],[244,251],[248,250],[251,248],[255,246],[260,246],[262,245],[266,242],[270,241],[275,240],[277,239],[280,237],[284,236],[286,235],[288,234],[292,234],[295,232],[297,231],[301,231],[305,231],[306,229],[308,227],[312,227],[314,226],[317,225],[321,225],[323,224],[327,224],[330,224],[334,224],[338,224],[342,224],[345,224],[348,223],[350,221],[354,221],[356,220],[359,219],[363,216],[366,215],[369,214],[371,213],[374,210],[376,209],[380,208],[382,206],[385,205],[387,204],[390,203],[392,200],[396,199],[398,198],[401,194],[405,193],[407,192],[410,190],[412,188],[415,187],[417,185],[419,183],[423,182],[424,179],[427,178],[429,177],[432,176],[433,173],[436,172],[438,169],[440,167],[443,165],[445,163],[448,161],[450,160],[453,157],[454,155],[458,155],[459,152],[461,151],[464,150],[466,148],[470,146],[474,145],[475,142],[479,142],[480,140],[484,140],[486,137],[489,136],[491,135],[494,134],[497,132],[499,130],[502,130],[505,127],[510,126],[512,124],[516,124],[518,121],[523,121],[526,119],[529,119],[532,118],[534,116],[537,115],[541,115],[543,114],[546,113],[549,113],[553,113],[555,111],[559,111],[563,111],[565,110],[569,110],[573,109],[576,109],[580,109],[586,109],[592,109],[596,109],[600,109],[604,109],[607,109],[611,109],[616,109],[618,108],[622,108],[626,108],[630,108],[633,108],[639,108],[643,108],[647,108],[651,108],[656,108],[659,108],[663,108],[667,108],[669,106],[673,106],[677,106],[680,106],[684,106],[688,106],[691,106],[694,105],[698,105],[701,105],[705,105],[709,105],[712,105],[716,105],[720,105],[724,105],[730,105],[735,105],[738,105],[742,105],[746,105],[752,105],[757,105],[759,106],[763,106],[766,108],[769,108],[774,108],[782,109],[788,110],[791,111],[795,111],[799,111],[803,113],[808,114],[811,114],[814,115],[817,115],[821,115],[824,116],[826,118],[830,118],[835,120],[838,120],[842,123],[847,124],[850,125],[852,126],[855,129],[857,130],[859,132],[863,135],[867,136],[868,139],[871,140],[873,141],[874,144],[878,145],[879,147],[882,148],[884,150],[887,151],[889,153],[892,155],[893,157],[895,158],[899,160],[901,161],[904,162],[905,165],[908,166],[910,167],[913,171],[918,173],[920,177],[922,179],[924,182],[926,183],[927,185],[930,187],[930,190],[932,192],[935,193],[935,197],[937,198],[940,199],[941,202],[944,203],[945,205],[946,208],[948,209],[950,211],[953,211],[955,214],[957,215],[958,218],[961,219],[963,220],[966,221],[967,224],[969,225],[972,226],[974,229],[976,231],[978,232],[979,235],[982,236],[984,239],[986,241],[987,245],[989,247],[992,248],[993,251],[994,253],[997,256],[999,260],[1000,263],[1002,266],[1003,268],[1004,271],[1005,273],[1007,276],[1008,278],[1009,281],[1010,284],[1011,287],[1013,289],[1014,292],[1016,293],[1018,295],[1018,299],[1020,302],[1020,305],[1021,308],[1023,310],[1024,313],[1025,315],[1026,319],[1028,321],[1029,324],[1030,326],[1031,329],[1032,331],[1034,334],[1035,336],[1036,339],[1037,341],[1039,344],[1041,345],[1042,347],[1044,350],[1045,352],[1046,355],[1049,356],[1051,357],[1052,360],[1054,362],[1056,365],[1058,366],[1060,368],[1062,371],[1065,372],[1066,376],[1068,378],[1071,381],[1073,383],[1076,384],[1077,387],[1079,388],[1082,389],[1083,392],[1084,394],[1087,397],[1091,399],[1094,402],[1097,404],[1099,405],[1102,409],[1104,410],[1105,413],[1109,415],[1113,418],[1115,419],[1118,421],[1121,421],[1125,424],[1130,425],[1133,426],[1136,427],[1140,429],[1145,430],[1147,431],[1151,432],[1154,434],[1157,434],[1161,434],[1166,434],[1170,435],[1176,435],[1180,435],[1183,435],[1188,435],[1192,435],[1196,435],[1199,435],[1203,435],[1207,435],[1209,434],[1213,432],[1215,431],[1218,430],[1222,429],[1224,427],[1227,426],[1229,425],[1231,423],[1234,421],[1236,420],[1238,418],[1240,416],[1243,414],[1245,411],[1248,410],[1250,408],[1251,405],[1254,404],[1255,402],[1256,398],[1259,397],[1260,394],[1261,392],[1262,389],[1264,387],[1265,383],[1267,379],[1269,377],[1270,373],[1271,371],[1272,367],[1274,365],[1275,361],[1276,358],[1277,356],[1280,352],[1282,348],[1283,346],[1286,341],[1288,339],[1290,335],[1292,332],[1293,330],[1295,327],[1296,325],[1297,321],[1301,318],[1303,313],[1306,308],[1308,304],[1311,299],[1314,293],[1317,288],[1319,284],[1320,282],[1323,279],[1325,274],[1329,271],[1332,267],[1333,263],[1334,260],[1337,257],[1338,255],[1340,251],[1341,248],[1343,245],[1344,242],[1346,239],[1348,236],[1349,232],[1351,230],[1353,225],[1355,223],[1358,219],[1359,215],[1360,213],[1361,210],[1362,208],[1365,204],[1367,202],[1369,199],[1370,197],[1372,193],[1374,190],[1376,188],[1379,185],[1380,183],[1382,182],[1384,179],[1385,177],[1388,173],[1392,169],[1395,167],[1398,162],[1401,161],[1406,157],[1411,153],[1416,151],[1421,147],[1424,145],[1428,144],[1430,142],[1433,141],[1434,139],[1438,139],[1440,137],[1443,136],[1447,136],[1450,134],[1455,134],[1459,132],[1463,130],[1466,130],[1470,129],[1472,127],[1476,127],[1479,125],[1484,124],[1487,124],[1491,123],[1495,123],[1498,123],[1502,123],[1507,123],[1511,123],[1515,123],[1518,123],[1522,123],[1526,123],[1529,123],[1534,124],[1538,124],[1540,125],[1543,126],[1547,126],[1549,127],[1553,129],[1555,130],[1558,131],[1560,134],[1563,135],[1565,136],[1568,137],[1569,140],[1571,142],[1574,144],[1576,147],[1579,150],[1581,152],[1584,153],[1585,156],[1586,158],[1587,161],[1589,163],[1590,166],[1591,168],[1592,172],[1594,174],[1595,177],[1596,179],[1596,183],[1597,187],[1599,192],[1600,195],[1600,199],[1600,203],[1600,206],[1600,210],[1600,214],[1600,218],[1599,220],[1597,223],[1597,226],[1595,229],[1594,231],[1592,235],[1591,239],[1590,241],[1587,245],[1587,248],[1585,251],[1584,255],[1581,260],[1580,262],[1579,266],[1576,268],[1575,272],[1574,276],[1571,279],[1570,283],[1569,286],[1566,289],[1565,293],[1564,295],[1563,298],[1560,299],[1559,303],[1558,308],[1555,311],[1554,314],[1552,318],[1550,320],[1549,323],[1548,325],[1547,327],[1545,330],[1543,334],[1542,336],[1540,339],[1539,341],[1538,345],[1536,347],[1536,351],[1534,353],[1533,356],[1533,360],[1532,362],[1531,365],[1529,367],[1528,369],[1528,373],[1527,376],[1527,379],[1526,383],[1524,387],[1524,390],[1523,393],[1523,397],[1522,399],[1522,403],[1521,405],[1521,409],[1521,413],[1521,416],[1521,420],[1521,424],[1521,427],[1521,431],[1522,435],[1523,439],[1523,442],[1524,446],[1526,450],[1526,453],[1528,457],[1529,460],[1529,463],[1531,466],[1532,468],[1534,469],[1536,473],[1538,476],[1540,478],[1542,481],[1544,482],[1545,484],[1548,487],[1550,488],[1554,490],[1557,492],[1559,493],[1563,497],[1565,498],[1568,499],[1571,500],[1575,503],[1579,504],[1581,505],[1585,507],[1590,508],[1592,509],[1597,511],[1601,513],[1605,515],[1610,516],[1613,518],[1616,519],[1618,520],[1622,521],[1625,523],[1627,524],[1631,524],[1633,526],[1636,528],[1639,529],[1643,530],[1647,531],[1650,532],[1653,534],[1654,536],[1657,537],[1659,539],[1663,540],[1664,542],[1667,544],[1669,545],[1671,547],[1674,548],[1675,551],[1678,552],[1681,555],[1684,556],[1686,557],[1688,560],[1690,561],[1691,563],[1694,565],[1695,567],[1697,568],[1699,571],[1701,573],[1702,576],[1705,578],[1706,581],[1709,583],[1709,587],[1711,590],[1712,593],[1714,595],[1715,599],[1715,603],[1715,607],[1715,610],[1715,614],[1715,618],[1715,621],[1715,625],[1715,629],[1715,632],[1714,635],[1712,637],[1712,641],[1710,642],[1710,646],[1707,647],[1705,649],[1704,652],[1701,655],[1700,657],[1697,660],[1694,662],[1692,666],[1690,668],[1686,671],[1685,673],[1683,676],[1681,678],[1679,679],[1676,682],[1675,684],[1673,686],[1671,688],[1669,689],[1667,690],[1664,693],[1662,694],[1660,697],[1657,699],[1654,700],[1653,703],[1649,704],[1648,707],[1646,708],[1643,709],[1641,711],[1638,713],[1636,715],[1632,716],[1629,718],[1626,719],[1622,720],[1620,721],[1617,723],[1615,724],[1612,725],[1608,725],[1605,726],[1602,728],[1599,728],[1595,728],[1591,729],[1587,729],[1585,730],[1581,730],[1578,730],[1574,730],[1570,731],[1568,732],[1565,734],[1561,734],[1559,735],[1557,736],[1553,736],[1549,737],[1545,739],[1543,740],[1539,740],[1536,741],[1533,742],[1529,742],[1527,744],[1523,745],[1519,745],[1517,746],[1513,746],[1507,747],[1505,749],[1501,749],[1497,749],[1495,750],[1491,750],[1487,750],[1484,750],[1481,751],[1476,751],[1472,751],[1468,751],[1464,751],[1460,752],[1456,752],[1453,752],[1449,752],[1445,752],[1442,752],[1438,752],[1434,752],[1429,752],[1426,752],[1422,752],[1418,752],[1414,753],[1411,753],[1407,753],[1403,753],[1400,753],[1396,753],[1392,753],[1388,753],[1384,753],[1380,753],[1377,752],[1375,751]] },
  { w: 55, pts: [[1273,742],[1270,742],[1268,742],[1263,742],[1260,742],[1257,742],[1254,742],[1251,742],[1249,742],[1246,742],[1243,742],[1240,742],[1237,742],[1234,741],[1231,739],[1228,739],[1225,739],[1222,739],[1219,739],[1216,739],[1213,739],[1210,739],[1207,739],[1205,739],[1199,739],[1196,739],[1193,739],[1190,739],[1187,739],[1184,739],[1180,738],[1177,738],[1174,738],[1171,738],[1168,736],[1165,736],[1162,736],[1159,735],[1156,735],[1153,735],[1150,735],[1147,735],[1145,735],[1142,735],[1137,735],[1134,735],[1131,735],[1128,735],[1125,735],[1123,735],[1120,735],[1117,735],[1114,735],[1111,735],[1108,733],[1105,732],[1102,732],[1098,732],[1095,730],[1092,729],[1089,727],[1086,727],[1083,727],[1080,727],[1074,727],[1071,726],[1068,726],[1065,726],[1060,724],[1055,724],[1052,724],[1049,724],[1046,724],[1043,724],[1041,723],[1038,723],[1035,721],[1032,720],[1029,720],[1026,720],[1021,717],[1019,717],[1016,717],[1016,714],[1013,714],[1010,714],[1004,713],[1001,713],[998,711],[995,711],[989,710],[986,710],[983,710],[980,708],[975,707],[972,707],[969,707],[966,705],[963,704],[960,702],[956,702],[951,700],[948,700],[945,698],[942,695],[939,695],[935,692],[932,691],[929,689],[926,688],[925,685],[922,685],[919,682],[916,681],[913,678],[910,678],[910,675],[907,675],[906,672],[903,672],[900,670],[898,667],[896,666],[893,666],[891,663],[888,663],[885,662],[882,660],[881,657],[878,656],[876,653],[874,653],[872,650],[869,648],[868,645],[865,644],[863,641],[860,640],[860,637],[857,635],[856,632],[855,629],[853,626],[852,623],[850,621],[849,618],[847,613],[846,610],[844,607],[843,604],[841,600],[841,597],[841,594],[840,591],[840,588],[840,585],[840,580],[840,577],[840,574],[840,571],[838,568],[838,565],[838,562],[838,558],[838,555],[837,552],[837,549],[837,546],[837,543],[837,540],[837,537],[837,534],[837,531],[837,528],[837,525],[837,523],[837,520],[837,517],[837,514],[837,511],[837,508],[837,505],[837,502],[837,499],[837,496],[837,493],[837,490],[837,487],[837,484],[837,482],[837,479],[837,476],[837,473],[837,470],[837,467],[837,464],[837,461],[835,458],[835,455],[835,452],[835,449],[835,446],[835,444],[834,441],[834,438],[833,435],[831,432],[831,429],[831,426],[830,423],[828,420],[827,417],[827,414],[825,411],[824,408],[822,405],[821,403],[821,400],[819,397],[818,394],[816,391],[813,389],[813,385],[811,384],[809,381],[809,378],[808,375],[805,372],[802,370],[802,367],[799,366],[796,363],[794,360],[792,359],[789,357],[787,354],[784,353],[781,351],[778,350],[775,348],[772,346],[770,346],[767,346],[762,346],[759,346],[756,346],[751,344],[746,344],[743,344],[740,343],[737,343],[734,343],[729,343],[726,343],[723,343],[720,343],[717,343],[714,343],[711,343],[707,343],[702,343],[699,343],[695,343],[692,343],[688,344],[685,344],[682,346],[679,347],[676,348],[671,350],[667,351],[664,353],[661,354],[658,356],[654,359],[651,359],[647,362],[641,365],[638,366],[635,367],[630,370],[627,373],[625,373],[622,376],[619,378],[614,381],[610,384],[607,384],[606,386],[603,388],[600,389],[597,391],[594,394],[591,395],[586,398],[584,401],[581,403],[579,405],[575,405],[572,410],[567,411],[564,413],[564,416],[562,417],[559,417],[557,420],[553,422],[550,425],[545,427],[543,429],[540,432],[537,432],[535,435],[532,436],[528,439],[523,442],[519,444],[515,445],[510,449],[506,452],[503,454],[500,457],[496,460],[493,461],[491,464],[488,465],[485,467],[485,470],[481,471],[480,474],[477,476],[474,479],[472,482],[471,484],[468,486],[468,489],[465,490],[463,493],[460,495],[459,498],[456,499],[455,502],[452,504],[447,506],[443,509],[440,511],[439,514],[436,515],[431,518],[428,521],[427,524],[424,525],[421,528],[418,530],[415,531],[411,536],[408,536],[406,539],[403,539],[398,543],[392,544],[389,546],[386,549],[381,550],[378,552],[374,553],[370,556],[367,558],[362,561],[355,563],[352,565],[348,565],[345,566],[342,568],[339,568],[336,569],[333,571],[330,571],[324,574],[321,575],[318,577],[315,577],[310,578],[304,581],[301,583],[296,583],[294,584],[291,584],[288,584],[285,585],[282,585],[279,585],[276,585],[273,585],[270,585],[267,585],[264,585],[260,584],[253,583],[247,581],[244,581],[241,580],[236,578],[233,578],[229,577],[226,575],[223,574],[220,574],[217,572],[214,571],[210,569],[207,568],[204,566],[201,565],[197,562],[192,559],[190,558],[185,555],[182,553],[179,552],[176,550],[173,549],[170,547],[168,546],[165,544],[163,542],[160,540],[157,539],[154,536],[150,533],[147,530],[144,528],[143,525],[140,524],[135,521],[132,520],[131,517],[128,515],[128,512],[125,512],[124,509],[121,508],[118,506],[116,504],[113,502],[110,498],[106,495],[105,492],[103,489],[102,486],[100,483],[99,480],[97,477],[96,474],[96,471],[94,468],[93,465],[91,463],[91,460],[91,457],[90,454],[90,451],[88,446],[88,444],[88,439],[87,436],[87,432],[87,427],[86,423],[86,419],[86,414],[86,411],[86,408],[86,405],[86,403],[86,400],[86,395],[86,392],[86,389],[86,385],[86,382],[86,379],[86,376],[87,373],[87,369],[88,366],[90,363],[90,360],[91,357],[94,353],[97,350],[97,346],[102,343],[102,340],[103,337],[105,332],[106,329],[109,328],[109,325],[110,322],[112,319],[115,316],[115,313],[116,310],[119,310],[119,307],[122,305],[124,302],[127,300],[127,297],[129,296],[134,293],[137,290],[140,288],[141,286],[144,286],[146,283],[149,281],[151,280],[153,277],[156,277],[157,274],[160,274],[162,271],[165,271],[168,268],[170,267],[176,265],[181,262],[185,259],[188,259],[191,259],[194,258],[198,256],[203,256],[206,256],[209,255],[211,253],[214,252],[217,252],[220,252],[225,250],[228,250],[232,249],[238,247],[242,246],[247,245],[251,245],[254,245],[257,243],[260,242],[263,242],[266,242],[269,240],[272,239],[274,239],[277,239],[280,236],[283,234],[286,234],[289,234],[292,233],[296,231],[299,231],[302,230],[308,227],[311,227],[314,227],[320,224],[324,224],[329,223],[333,220],[336,220],[339,220],[343,218],[346,217],[351,217],[355,215],[358,215],[361,214],[368,212],[371,211],[376,209],[378,209],[383,208],[387,207],[396,205],[400,204],[408,201],[417,198],[421,196],[425,196],[430,193],[433,192],[437,192],[443,190],[449,188],[455,188],[458,185],[463,185],[468,183],[472,180],[477,180],[480,177],[485,177],[494,174],[499,173],[503,171],[506,170],[512,170],[518,167],[522,166],[525,164],[528,163],[531,163],[534,163],[535,160],[538,158],[544,157],[547,157],[550,155],[553,154],[556,154],[559,152],[562,151],[564,151],[567,149],[570,148],[573,148],[576,149],[579,149],[582,151],[585,151],[588,151],[594,151],[597,151],[601,149],[604,149],[608,148],[614,147],[617,147],[623,145],[626,144],[629,141],[632,141],[635,141],[636,138],[639,138],[642,136],[647,135],[649,133],[652,132],[655,132],[658,130],[661,129],[666,128],[668,126],[671,126],[674,125],[677,123],[680,123],[683,122],[686,120],[689,120],[692,119],[695,119],[698,117],[701,116],[704,116],[707,116],[709,114],[712,114],[715,114],[718,113],[721,113],[724,111],[727,111],[730,111],[733,111],[736,110],[739,110],[743,109],[746,109],[751,109],[753,109],[756,109],[759,109],[762,109],[765,109],[771,109],[774,109],[777,109],[780,109],[783,109],[786,109],[790,109],[793,109],[796,109],[802,110],[805,110],[811,110],[813,110],[816,110],[819,111],[822,111],[825,113],[828,114],[831,114],[834,114],[837,116],[840,117],[843,119],[847,120],[850,120],[853,122],[856,123],[859,125],[862,125],[863,128],[866,128],[869,129],[871,132],[874,133],[876,135],[879,136],[881,139],[885,141],[887,144],[890,145],[893,147],[894,149],[897,151],[898,154],[901,155],[904,157],[906,160],[907,163],[910,164],[912,167],[913,170],[916,171],[916,174],[919,176],[920,179],[923,180],[925,183],[928,185],[931,186],[932,190],[935,192],[938,193],[939,196],[941,199],[944,201],[945,204],[947,207],[950,209],[953,211],[953,214],[954,217],[956,220],[957,223],[958,226],[960,228],[961,231],[963,234],[963,237],[967,240],[967,243],[970,246],[972,249],[973,252],[975,255],[976,258],[978,261],[980,265],[983,269],[986,271],[988,274],[991,277],[992,280],[995,283],[997,286],[1000,287],[1000,290],[1002,294],[1005,297],[1007,302],[1008,305],[1010,309],[1011,312],[1014,315],[1014,318],[1017,321],[1019,324],[1020,326],[1023,331],[1024,337],[1027,340],[1030,341],[1032,344],[1033,347],[1036,351],[1041,356],[1041,359],[1043,362],[1046,366],[1046,369],[1049,370],[1049,373],[1052,376],[1054,379],[1055,382],[1058,385],[1061,388],[1061,391],[1062,394],[1065,397],[1067,400],[1070,401],[1073,404],[1074,407],[1077,408],[1079,411],[1082,413],[1086,417],[1089,420],[1092,420],[1096,423],[1101,427],[1104,430],[1106,432],[1111,435],[1114,438],[1117,438],[1120,441],[1125,442],[1128,444],[1133,445],[1137,446],[1146,449],[1155,449],[1158,451],[1164,451],[1168,452],[1178,452],[1181,452],[1187,452],[1191,452],[1197,452],[1205,452],[1212,452],[1215,452],[1219,452],[1222,452],[1225,452],[1229,451],[1237,448],[1243,446],[1251,444],[1256,441],[1259,439],[1262,436],[1263,433],[1266,432],[1266,429],[1269,426],[1272,423],[1275,419],[1276,416],[1279,414],[1281,411],[1284,408],[1281,408],[1278,410],[1275,410],[1272,410],[1268,413],[1263,414],[1260,414],[1257,417],[1254,417],[1250,420],[1246,423],[1243,425],[1240,426],[1237,426],[1232,429],[1228,430],[1225,432],[1222,433],[1219,435],[1216,436],[1219,438],[1222,438],[1227,436],[1229,435],[1234,432],[1238,430],[1243,426],[1247,425],[1251,422],[1253,419],[1257,414],[1260,411],[1262,408],[1265,405],[1266,403],[1269,400],[1270,397],[1273,394],[1276,392],[1276,389],[1279,386],[1282,384],[1285,381],[1288,378],[1288,375],[1291,373],[1292,370],[1294,367],[1295,365],[1297,362],[1298,359],[1300,356],[1300,359],[1297,363],[1292,367],[1292,370],[1290,372],[1288,375],[1285,378],[1285,381],[1282,384],[1281,388],[1278,392],[1275,395],[1273,398],[1270,403],[1269,405],[1268,408],[1270,410],[1273,410],[1278,408],[1281,407],[1284,405],[1287,404],[1288,401],[1291,398],[1292,395],[1294,392],[1295,389],[1295,386],[1297,384],[1298,381],[1298,378],[1298,375],[1300,372],[1301,369],[1301,366],[1301,363],[1303,360],[1303,357],[1304,353],[1304,350],[1304,347],[1304,344],[1306,340],[1306,335],[1306,332],[1307,328],[1309,325],[1309,321],[1311,316],[1313,312],[1313,309],[1314,303],[1316,299],[1317,296],[1319,293],[1320,290],[1322,286],[1322,283],[1323,278],[1328,271],[1329,267],[1331,264],[1331,261],[1333,259],[1335,253],[1338,249],[1341,245],[1342,242],[1345,236],[1348,231],[1350,228],[1353,224],[1355,218],[1360,212],[1363,207],[1366,202],[1367,198],[1370,196],[1374,190],[1377,188],[1379,185],[1382,180],[1385,176],[1389,171],[1392,167],[1396,163],[1399,158],[1402,155],[1407,152],[1410,149],[1414,147],[1417,144],[1421,141],[1424,136],[1429,133],[1432,132],[1436,130],[1439,129],[1442,128],[1445,126],[1452,125],[1455,123],[1462,123],[1468,119],[1473,119],[1476,117],[1478,116],[1481,116],[1484,116],[1487,116],[1493,114],[1496,114],[1502,111],[1506,111],[1509,111],[1512,111],[1517,111],[1519,111],[1527,111],[1533,111],[1536,111],[1539,111],[1541,111],[1544,111],[1547,111],[1550,111],[1552,114],[1555,114],[1558,116],[1560,117],[1563,120],[1566,122],[1569,125],[1572,126],[1574,129],[1577,129],[1580,132],[1582,135],[1584,138],[1587,139],[1591,145],[1594,147],[1597,149],[1600,151],[1602,154],[1602,157],[1604,158],[1604,161],[1607,164],[1609,168],[1612,174],[1616,180],[1618,185],[1619,188],[1619,190],[1619,193],[1619,196],[1619,199],[1619,205],[1619,209],[1619,214],[1619,218],[1618,223],[1615,230],[1613,233],[1610,237],[1610,240],[1609,243],[1607,246],[1603,250],[1602,255],[1597,259],[1596,262],[1593,265],[1591,268],[1588,269],[1588,272],[1585,277],[1584,280],[1581,284],[1578,287],[1575,293],[1571,300],[1569,305],[1566,310],[1563,313],[1563,316],[1559,322],[1559,326],[1556,331],[1552,337],[1550,340],[1549,343],[1549,346],[1546,351],[1544,359],[1541,367],[1539,375],[1539,381],[1537,384],[1536,389],[1536,392],[1536,397],[1534,403],[1534,405],[1534,410],[1534,413],[1534,417],[1534,420],[1534,425],[1534,429],[1534,433],[1534,436],[1536,439],[1536,444],[1537,446],[1537,449],[1539,454],[1540,460],[1543,464],[1543,467],[1544,470],[1549,474],[1553,479],[1558,483],[1560,487],[1563,490],[1569,496],[1572,499],[1575,502],[1578,505],[1587,512],[1594,518],[1597,521],[1602,524],[1609,531],[1616,536],[1621,539],[1625,543],[1629,546],[1634,550],[1640,555],[1647,561],[1654,566],[1659,571],[1663,574],[1666,575],[1669,577],[1673,580],[1678,583],[1681,583],[1682,585],[1686,587],[1691,590],[1695,591],[1698,593],[1703,596],[1706,597],[1711,600],[1716,603],[1719,604],[1722,606],[1725,607],[1725,610],[1727,612],[1730,615],[1735,618],[1735,621],[1738,625],[1739,628],[1742,632],[1742,637],[1745,640],[1745,642],[1745,645],[1745,650],[1745,653],[1745,656],[1745,659],[1742,662],[1738,664],[1736,667],[1732,670],[1729,672],[1727,675],[1723,678],[1720,681],[1719,683],[1716,683],[1713,686],[1710,689],[1707,691],[1704,694],[1700,698],[1697,700],[1694,701],[1689,705],[1688,708],[1685,708],[1682,710],[1681,713],[1678,716],[1675,716],[1672,719],[1667,720],[1664,721],[1662,723],[1657,724],[1654,726],[1651,726],[1648,727],[1643,730],[1635,732],[1632,733],[1628,735],[1621,738],[1615,738],[1610,739],[1602,741],[1596,741],[1593,742],[1587,743],[1578,743],[1574,743],[1571,743],[1568,745],[1562,745],[1552,745],[1547,745],[1541,746],[1536,748],[1530,748],[1521,748],[1512,748],[1508,748],[1502,749],[1492,749],[1480,749],[1473,751],[1465,751],[1459,751],[1455,752],[1448,752],[1439,752],[1433,752],[1426,752],[1415,754],[1405,754],[1396,755],[1392,755],[1380,755],[1369,755],[1363,755],[1354,755],[1344,755],[1339,755],[1332,755],[1317,754],[1311,754],[1306,754],[1294,754],[1278,752],[1269,752],[1263,752],[1259,752],[1247,751],[1238,749],[1231,749],[1224,749],[1216,748],[1213,746],[1209,746],[1206,746],[1203,746],[1200,746],[1193,746],[1181,745],[1178,745]] },
  { w: 55, pts: [[255,571],[253,571],[248,571],[245,569],[242,569],[239,569],[236,568],[233,566],[231,565],[228,565],[226,562],[223,562],[220,562],[216,561],[214,558],[211,556],[209,555],[207,552],[204,550],[201,547],[197,544],[191,540],[185,537],[182,537],[182,534],[179,533],[172,530],[168,525],[165,525],[162,523],[159,521],[157,518],[154,515],[153,512],[150,511],[149,506],[144,502],[143,498],[140,496],[140,493],[137,490],[135,487],[134,484],[132,482],[132,479],[129,476],[128,470],[128,467],[127,464],[127,461],[125,458],[125,454],[125,449],[125,446],[124,442],[124,439],[122,436],[122,432],[122,425],[122,417],[122,414],[122,411],[122,403],[122,397],[122,392],[122,389],[122,386],[124,384],[124,378],[125,375],[128,366],[129,360],[131,357],[132,353],[134,347],[134,344],[135,341],[135,338],[137,335],[138,332],[138,329],[141,324],[141,321],[144,316],[144,313],[146,310],[147,307],[149,305],[151,302],[153,299],[156,299],[157,296],[160,296],[163,294],[165,291],[168,291],[170,291],[173,290],[176,288]] },
  { w: 55, pts: [[182,262],[185,262],[188,262],[191,261],[194,259],[197,259],[200,258],[203,256],[206,255],[209,253],[211,252],[214,252],[217,250],[220,249],[223,249],[226,247],[229,246],[232,245],[235,245],[238,243],[241,243],[247,242],[250,242],[253,242],[255,242],[258,240],[261,240],[264,240],[267,239],[270,239],[273,239],[279,236],[283,234],[288,234],[292,233],[298,231],[302,231],[305,231],[308,230],[311,230],[314,230],[317,230],[321,228],[324,227],[327,227],[330,227],[333,227],[337,226],[340,224],[345,224],[351,223],[358,220],[361,220],[364,218],[367,217],[370,215],[373,214],[380,212],[386,212],[390,211],[395,209],[398,209],[400,209],[405,208],[408,208],[412,207],[417,207],[419,205],[425,205],[431,205],[434,205],[437,205],[441,204],[444,202],[449,202],[456,202],[459,202],[466,199],[472,198],[475,198],[478,196],[481,195],[485,195],[491,192],[494,192],[500,188],[504,186],[507,185],[510,185],[513,183],[516,182],[521,180],[528,179],[532,177],[537,176],[543,174],[545,173],[548,173],[551,171],[554,171],[559,170],[563,168],[566,168],[569,167],[572,166],[575,166],[578,164],[581,164],[585,163],[589,161],[592,160],[595,158],[598,158],[601,158],[604,155],[607,155],[611,155],[614,154],[617,154],[620,152],[623,152],[626,151],[629,151],[632,151],[635,149],[638,148],[641,148],[644,148],[647,147],[649,145],[652,145],[655,144],[658,142],[663,141],[666,141],[671,139],[676,138],[679,138],[682,136],[685,136],[688,136],[690,135],[698,133],[701,133],[704,133],[707,132],[709,132],[714,130],[720,130],[723,130],[727,129],[730,129],[734,129],[737,129],[740,129],[745,128],[748,128],[752,128],[755,128],[758,128],[762,126],[767,126],[770,126],[772,126],[775,126],[778,126],[781,126],[784,126],[787,125],[790,125],[793,125],[796,125],[799,125],[806,123],[813,123]] },
  { w: 55, pts: [[811,126],[813,126],[819,126],[822,126],[827,126],[830,126],[833,126],[835,128],[840,129],[849,133],[852,136],[856,139],[859,142],[862,145],[865,147],[866,149],[869,151],[874,154],[876,158],[879,158],[881,161],[887,166],[891,173],[896,176],[897,179],[898,182],[903,188],[906,190],[907,193],[910,196],[915,202],[919,205],[922,208],[925,214],[931,221],[935,227],[938,228],[942,234],[945,239],[950,243],[953,246],[956,249],[956,252],[960,255],[960,258],[964,262],[967,267],[969,269],[970,274],[975,280],[976,283],[978,287],[982,291],[982,294],[985,300],[988,303],[989,306],[991,309],[992,313],[994,316],[997,319],[997,322],[1000,325],[1001,329],[1002,332],[1004,335],[1008,343],[1011,346],[1013,350],[1014,354],[1019,360],[1020,363],[1021,366],[1023,369],[1024,372],[1026,375],[1029,376],[1029,379],[1032,381],[1032,384],[1035,385],[1036,388],[1039,389],[1041,392],[1043,392],[1045,395],[1046,398],[1049,400],[1051,403],[1054,405],[1058,408],[1061,410],[1062,413],[1065,414],[1070,417],[1073,419],[1076,420],[1079,422],[1082,425],[1084,425],[1086,427],[1089,427],[1092,429],[1095,430],[1098,432],[1101,433],[1104,435],[1108,436],[1112,439],[1115,439],[1118,441],[1121,442],[1124,444],[1127,444],[1130,445],[1133,446],[1136,446],[1139,448],[1142,448],[1145,448],[1149,448],[1152,449],[1155,449],[1158,449],[1161,449],[1164,449],[1166,449],[1169,449],[1172,449],[1177,449],[1180,449],[1188,449],[1191,449],[1196,449],[1199,449],[1202,448],[1206,448],[1209,448],[1210,445],[1215,444],[1219,442],[1222,441],[1227,436],[1231,436],[1232,433],[1235,432],[1238,430],[1240,427],[1243,426],[1244,423],[1247,422],[1249,419],[1250,416],[1251,413],[1254,411],[1256,408],[1259,407],[1259,404],[1260,401],[1262,398],[1263,395],[1266,392],[1266,389],[1269,386],[1270,384],[1272,381],[1273,378],[1276,373],[1278,370],[1278,367],[1281,363],[1282,360],[1285,357],[1285,354],[1287,351],[1288,348],[1288,346],[1291,341],[1292,338],[1292,335],[1292,332],[1292,329],[1294,326],[1295,324],[1295,321],[1298,316],[1298,313],[1300,310],[1303,306],[1304,302],[1307,297],[1310,293],[1313,286],[1314,283],[1317,278],[1320,275],[1320,272],[1323,269],[1325,267],[1328,261],[1331,256],[1333,252],[1335,247],[1336,245],[1339,243],[1339,239],[1342,237],[1342,234],[1345,231],[1347,228],[1350,227],[1353,224],[1353,221],[1357,220],[1357,217],[1360,215],[1363,214],[1364,211],[1367,209],[1367,207],[1370,207],[1372,204],[1372,201],[1374,199],[1374,196],[1377,195],[1377,192],[1379,189],[1382,188],[1383,185],[1386,183],[1389,180],[1392,177],[1395,174],[1398,173],[1401,168],[1404,167],[1405,164],[1408,163],[1411,160],[1417,155],[1418,152],[1421,152],[1426,149],[1429,148],[1433,145],[1436,144],[1439,142],[1442,142],[1446,139],[1449,138],[1452,138],[1455,138],[1458,138],[1461,136],[1465,135],[1473,135],[1476,133],[1478,133],[1481,132],[1486,130],[1489,130],[1493,130],[1496,130],[1502,130],[1506,130],[1511,130],[1515,130],[1518,130],[1527,132],[1530,132],[1534,133],[1537,135],[1540,136],[1543,136],[1546,138],[1549,139],[1552,141],[1555,142],[1558,144],[1560,145],[1562,148],[1565,148],[1566,151],[1569,154],[1571,157],[1572,160],[1574,163],[1574,166],[1575,170],[1577,173],[1577,176],[1577,179],[1577,182],[1577,185],[1577,188],[1575,190],[1575,193],[1575,196],[1575,199],[1575,202],[1574,205],[1574,208],[1574,211],[1574,214],[1574,217],[1572,220],[1572,223],[1571,227],[1571,230],[1571,233],[1569,236],[1569,239],[1569,243],[1568,246],[1568,249],[1568,252],[1568,255],[1566,259],[1565,264],[1565,267],[1563,269],[1562,274],[1560,278],[1560,281],[1559,284],[1558,288],[1558,293],[1556,296],[1556,299],[1555,305],[1553,309],[1553,315],[1553,321],[1552,325],[1550,328],[1550,331],[1549,335],[1549,340],[1547,343],[1547,346],[1546,350],[1546,354],[1546,357],[1544,360],[1543,365],[1543,367],[1543,370],[1543,373],[1541,376],[1541,379],[1541,382],[1541,385],[1540,388],[1540,391],[1540,394],[1540,397],[1540,400],[1540,403],[1540,405],[1539,410],[1539,413],[1539,416],[1539,419],[1539,422],[1539,425],[1539,429],[1539,432],[1539,435],[1539,438],[1539,441],[1540,444],[1541,446],[1543,449],[1546,452],[1547,455],[1550,457],[1552,460],[1555,463],[1556,465],[1559,467],[1562,470],[1565,473],[1569,476],[1574,479],[1577,480],[1581,483],[1587,486],[1591,490],[1594,490],[1597,493],[1600,495],[1604,498],[1612,504],[1618,506],[1621,508],[1623,511],[1628,514],[1631,517],[1632,520],[1635,523],[1638,524],[1641,525],[1643,528],[1645,530],[1645,533],[1651,537],[1653,540],[1656,542],[1657,544],[1663,552],[1666,553],[1667,556],[1670,559],[1673,562],[1676,566],[1678,569],[1681,569],[1681,572],[1684,574],[1685,577],[1688,578],[1689,581],[1692,584],[1692,587],[1695,588],[1695,591],[1698,591],[1700,594],[1701,597],[1703,600],[1706,602],[1707,604],[1708,607],[1711,609],[1711,612],[1713,615],[1713,618],[1714,622],[1714,625],[1714,629],[1716,632],[1716,635],[1716,638],[1716,641],[1716,644],[1716,647],[1716,650],[1716,653],[1714,656],[1713,659],[1711,662],[1710,664],[1708,667],[1708,670],[1706,672],[1704,675],[1701,676],[1698,678],[1697,681]] },
  { w: 55, pts: [[1533,749],[1539,749],[1544,749],[1566,749],[1569,749],[1577,749],[1584,748],[1587,748]] },
  { w: 55, pts: [[1697,670],[1695,673],[1692,676],[1691,679],[1689,682],[1688,685],[1686,688],[1685,691],[1682,692],[1679,697],[1676,700],[1673,701],[1672,704],[1669,705],[1664,708],[1662,711],[1659,713],[1654,716],[1650,719],[1644,721],[1640,723],[1637,724],[1634,724],[1629,727],[1622,729],[1619,729],[1616,730],[1613,730],[1607,730],[1602,730],[1597,732],[1594,732],[1591,733],[1585,735],[1582,735],[1580,735],[1577,736],[1574,736],[1568,738],[1565,738],[1562,739],[1556,741],[1553,742],[1550,742],[1549,745],[1546,745],[1543,745],[1540,746],[1537,748],[1533,748],[1530,749],[1527,749],[1524,749],[1521,749],[1518,749],[1508,749],[1499,749],[1496,749],[1492,749],[1489,749],[1483,749],[1480,749],[1473,749],[1464,749],[1461,749],[1457,749],[1454,749],[1442,749],[1439,749],[1436,749],[1433,749],[1420,749],[1413,749],[1408,749],[1402,749],[1399,749],[1392,749],[1389,751],[1386,751],[1380,751],[1377,751],[1370,751],[1366,751],[1357,751],[1354,751],[1351,751],[1347,751],[1344,751],[1336,751],[1333,751],[1331,751],[1319,751],[1316,749],[1311,749],[1309,748],[1303,748],[1295,746],[1285,746],[1282,746],[1279,745],[1270,743],[1263,743],[1259,743],[1256,743],[1253,743],[1250,743],[1247,742],[1243,742],[1240,742],[1237,742],[1232,741],[1229,741],[1225,741],[1218,741],[1210,741],[1207,741],[1205,739],[1202,739],[1199,739],[1194,739],[1191,739],[1187,741],[1183,742],[1180,742],[1177,742],[1174,743],[1169,743],[1166,743],[1164,743],[1161,745],[1155,745],[1152,745],[1149,745],[1146,745],[1143,745],[1140,745],[1133,745],[1127,745],[1123,745],[1115,743],[1102,743],[1099,743],[1096,743],[1093,743],[1087,743],[1084,742],[1071,739],[1068,739],[1065,738],[1062,738],[1060,736],[1055,736],[1051,733],[1048,733],[1042,732],[1039,732],[1033,730],[1027,729],[1024,729],[1017,729],[1004,726],[997,724],[988,723],[985,723],[976,721],[972,720],[966,720],[960,717],[957,716],[954,714],[945,708],[941,705],[937,704],[931,700],[925,697],[922,697],[920,694],[912,689],[909,689],[904,686],[900,685],[897,682],[893,681],[890,679],[887,678],[882,675],[879,672],[876,670],[875,667],[874,664],[871,662],[868,660],[866,657],[863,654],[860,651],[857,648],[855,645],[853,642],[852,640],[850,635],[850,632],[849,629],[847,625],[846,622],[846,619],[844,616],[843,613],[843,610],[843,606],[840,603],[840,599],[840,596],[838,593],[838,590],[838,587],[838,583],[838,577],[838,571],[838,565],[838,561],[838,558],[838,555],[838,552],[840,544],[841,540],[841,537],[841,534],[841,531],[841,528],[841,525],[843,523],[843,520],[844,511],[844,506],[844,504],[844,498],[844,487],[844,483],[844,477],[843,473],[843,468],[843,465],[843,460],[844,455],[846,448],[846,442],[846,438],[846,435],[846,427],[846,423],[846,417],[844,413],[844,410],[843,405],[843,400],[840,397],[840,392],[840,386],[838,384],[837,381],[835,378],[834,375],[831,370],[828,365],[825,360],[824,357],[822,354],[818,350],[816,347],[813,343],[812,340],[809,338],[806,335],[805,332],[802,332],[799,329],[796,328],[790,325],[787,324],[784,322],[781,321],[778,321],[770,318],[767,318],[764,316],[761,316],[758,315],[748,313],[737,312],[733,310],[730,310],[727,310],[718,310],[714,310],[709,310],[707,310],[699,310],[692,310],[689,312],[683,313],[680,315],[674,316],[670,318],[663,322],[652,326],[645,331],[642,332],[639,334],[635,338],[630,341],[625,344],[617,348],[614,348],[613,351],[608,351],[606,356],[600,359],[592,363],[586,366],[584,370],[579,373],[576,375],[572,381],[570,384],[566,386],[563,389],[562,392],[557,395],[551,400],[548,403],[547,405],[544,407],[540,413],[537,416],[534,417],[529,420],[526,422],[525,425],[522,427],[518,435],[513,439],[510,444],[509,446],[506,449],[503,452],[500,455],[497,460],[494,464],[488,471],[485,474],[482,477],[480,479],[478,482],[475,486],[472,489],[471,493],[466,498],[463,504],[459,506],[456,511],[452,515],[447,520],[444,523],[440,525],[437,528],[433,530],[428,533],[424,536],[421,539],[418,540],[415,543],[411,546],[406,550],[403,552],[399,556],[396,558],[393,561],[390,562],[387,563],[384,566],[381,566],[377,568],[374,569],[374,572],[371,572],[367,575],[364,577],[361,578],[356,583],[354,583],[351,583],[349,585],[346,585],[343,585],[340,585],[337,585],[335,585],[332,585],[326,585],[323,585],[320,585],[317,585],[314,585],[310,585],[307,585],[304,585],[294,584],[291,584],[288,584],[285,584],[277,583],[273,581],[269,580],[266,580],[264,577],[261,577],[258,575],[254,574],[251,572],[238,566],[233,563],[231,562],[222,559],[214,555],[210,553],[209,550],[201,547],[198,546],[197,543],[194,542],[187,534],[184,533],[179,528],[176,523],[169,514],[166,511],[166,508],[163,505],[163,502],[160,499],[157,496],[156,493],[154,490],[151,489],[147,483],[146,480],[141,476],[140,473]] },
];

// WHITE EDGE LINES — one offset polyline per asphalt edge (sketch units), the
// circuit's boundary-line language: inset from the grass edge on free stretches,
// tucked to the kerb seam where a kerb runs (the kerb paints over the joint).
// Inset transitions are box-blurred over ±3 samples so the line eases to the kerb
// instead of jogging. Shared by the authored map AND the track editor.
export function buildAuthoredEdgeLines(path: Pt[], band: number, kerbs: AuthoredKerb[],
  freeInsetU: number, lineWU: number): [Pt[], Pt[]] {
  const N = path.length;
  const seamU = band * (KERB_SEAM / 124);
  const kerbInsetU = seamU + lineWU / 2;
  const inKerb = (i: number, side: 1 | -1): boolean => kerbs.some((k) => {
    if (k.side !== side) return false;
    const span = ((k.i1 - k.i0) % N + N) % N;
    return ((i - k.i0) % N + N) % N <= span;
  });
  const out: [Pt[], Pt[]] = [[], []];
  for (const side of [1, -1] as const) {
    const raw: number[] = [];
    for (let i = 0; i < N; i++) raw.push(inKerb(i, side) ? kerbInsetU : freeInsetU);
    const pts: Pt[] = [];
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let d = -3; d <= 3; d++) acc += raw[((i + d) % N + N) % N];
      const inset = acc / 7;
      const a = path[((i - 2) % N + N) % N], b = path[(i + 2) % N];
      const tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      const r = band / 2 - inset;
      pts.push([
        path[i][0] + side * (-ty / tl) * r,
        path[i][1] + side * (tx / tl) * r,
      ]);
    }
    out[side === 1 ? 0 : 1] = pts;
  }
  return out;
}

// Trace a freehand polyline SMOOTHED: a light 1-2-1 box blur on interior points
// (endpoints pinned) + quadratic curves through segment midpoints — a drawn stroke's
// SIDES stop showing hand jitter ("chewed" edges, boss's report) while the path stays
// where it was drawn. Coordinates map through the caller's transform. Shared by the
// authored map's worn-line passes AND the track editor.
export function traceWornPolyline(m: CanvasRenderingContext2D, pts: Array<[number, number]>,
  tx: (p: [number, number]) => [number, number]): void {
  if (pts.length < 2) return;
  let a = pts.map((p) => [p[0], p[1]] as [number, number]);
  for (let it = 0; it < 3; it++) {
    const b = a.map((p) => [p[0], p[1]] as [number, number]);
    for (let i = 1; i < a.length - 1; i++) {
      b[i] = [(a[i - 1][0] + 2 * a[i][0] + a[i + 1][0]) / 4, (a[i - 1][1] + 2 * a[i][1] + a[i + 1][1]) / 4];
    }
    a = b;
  }
  const q = a.map(tx);
  m.beginPath();
  m.moveTo(q[0][0], q[0][1]);
  for (let i = 1; i < q.length - 1; i++) {
    const mx = (q[i][0] + q[i + 1][0]) / 2, my = (q[i][1] + q[i + 1][1]) / 2;
    m.quadraticCurveTo(q[i][0], q[i][1], mx, my);
  }
  m.lineTo(q[q.length - 1][0], q[q.length - 1][1]);
}

export interface AuthoredKerbQuad { pts: [Pt, Pt, Pt, Pt]; fill: string }
// Red/white striped kerb + solid blue border hugging one asphalt edge along a marked
// arc — the CIRCUIT's kerb language with every dimension a FRACTION OF THE BAND
// (the same fractions the circuit uses at CS_BAND 124), so a narrower road gets
// proportionally smaller kerbs. Sketch units in and out; blue quads come first in the
// result (painted under the stripes). Shared by the authored map AND the track editor
// so both render the identical geometry.
export function buildAuthoredKerbQuads(path: Pt[], band: number, kerbs: AuthoredKerb[]): AuthoredKerbQuad[] {
  const N = path.length;
  const blue: AuthoredKerbQuad[] = [], stripes: AuthoredKerbQuad[] = [];
  const seam = band * (KERB_SEAM / 124);
  const kerbW = band * 0.11 * KERB_NARROW;
  const blueW = band * 0.045 * KERB_NARROW;
  const stripeLen = band * (KERB_STRIPE / 124);
  const rIn = band / 2 - seam;                     // pinned at the asphalt edge; reach is OUTWARD
  for (const k of kerbs) {
    const span = ((k.i1 - k.i0) % N + N) % N;
    if (span < 2) continue;
    const pts: Pt[] = [], nrm: Pt[] = [], arc: number[] = [0];
    for (let n = 0; n <= span; n++) {
      const i = (k.i0 + n) % N;
      const a = path[((i - 2) % N + N) % N], b = path[(i + 2) % N];
      const tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      pts.push(path[i]);
      nrm.push([k.side * (-ty / tl), k.side * (tx / tl)]);
      if (n > 0) arc.push(arc[n - 1] + Math.hypot(pts[n][0] - pts[n - 1][0], pts[n][1] - pts[n - 1][1]));
    }
    const total = arc[arc.length - 1];
    // A SHORT kerb (a tight hairpin-tongue tip, ~15 stripes here vs 24+ for the rest) crushes:
    // its 14+ arc-stripes cram into the raycast-clamped sliver as a red/white starburst, and
    // where the tip points into OPEN road the raycast finds no facing edge so blue reaches full
    // and pokes into the tarmac. Render it as the boss asked: TWO clean stripes (red then white,
    // split at the arc midpoint) with the reach tucked so blue can't overhang the grass.
    const shortKerb = total / stripeLen < 18;
    const shortCap = kerbW + blueW * 0.4;          // tucks the tip's blue back off the road
    const capAt = (n: number) => shortKerb ? Math.min(allowed[n], shortCap) : allowed[n];
    const taper = stripeLen * 1.5;                 // ends taper to nothing over ~1.5 stripes
    const reach = (s: number) => Math.max(0, Math.min(1, s / taper, (total - s) / taper));
    const at = (n: number, r: number): Pt => [pts[n][0] + nrm[n][0] * r, pts[n][1] + nrm[n][1] * r];
    // Per-sample clearance: a kerb may reach at most HALF WAY across the grass in its
    // normal's direction. Measured by RAYCAST — march outward from the asphalt edge
    // until the ray re-enters asphalt (distance to ANY path sample < rIn); half that
    // gap is the reach bound. Across a thin grass tongue (tight hairpin) the two
    // facing kerbs then meet cleanly at its middle and thin out along the tongue's
    // rounded tip instead of crossing into a deformed tangle; open grass and tight
    // own-corner islands measure wide, so ordinary kerbs are untouched.
    const fullReach = kerbW + blueW;
    const allowed: number[] = [];
    for (let n = 0; n <= span; n++) {
      const gi = (k.i0 + n) % N;
      const ip = at(n, rIn);
      // cheap prefilter: nothing non-local anywhere near → no clamp, skip the raycast
      let minD2 = Infinity;
      for (let j = 0; j < N; j += 4) {
        const ring = Math.min(((j - gi) % N + N) % N, ((gi - j) % N + N) % N);
        if (ring <= 40) continue;
        const d2 = (path[j][0] - ip[0]) ** 2 + (path[j][1] - ip[1]) ** 2;
        if (d2 < minD2) minD2 = d2;
      }
      if (minD2 >= (rIn + 2 * fullReach) ** 2) { allowed.push(fullReach); continue; }
      const cap = 2.4 * fullReach;
      let stop = cap;
      const hit2 = (rIn - 1) ** 2;
      march: for (let e = 3; e <= cap; e += 3) {
        const qx = pts[n][0] + nrm[n][0] * (rIn + e), qy = pts[n][1] + nrm[n][1] * (rIn + e);
        for (let j = 0; j < N; j += 2) {
          const d2 = (path[j][0] - qx) ** 2 + (path[j][1] - qy) ** 2;
          if (d2 < hit2) { stop = e; break march; }
        }
      }
      allowed.push(Math.max(0, stop / 2 + 0.5));
    }
    for (let n = 0; n < span; n++) {
      const f0 = reach(arc[n]), f1 = reach(arc[n + 1]);
      const c0 = capAt(n), c1 = capAt(n + 1);
      const b0 = Math.min(f0 * (kerbW + blueW), c0);
      const b1 = Math.min(f1 * (kerbW + blueW), c1);
      blue.push({
        pts: [at(n, rIn), at(n + 1, rIn), at(n + 1, rIn + b1), at(n, rIn + b0)],
        fill: KERB_BLUE,
      });
      const midArc = (arc[n] + arc[n + 1]) / 2;
      const fill = shortKerb
        ? (midArc < total / 2 ? KERB_RED : KERB_WHITE)          // just two halves — no starburst
        : (Math.floor(midArc / stripeLen) % 2 ? KERB_WHITE : KERB_RED);
      stripes.push({
        pts: [at(n, rIn), at(n + 1, rIn), at(n + 1, rIn + Math.min(f1 * kerbW, c1)), at(n, rIn + Math.min(f0 * kerbW, c0))],
        fill,
      });
    }
  }
  return [...blue, ...stripes];
}

const AUTHORED_LOGICAL = { widthM: FLAT_LOGICAL.widthM, heightM: FLAT_LOGICAL.heightM };
const AUTHORED_PATH: Pt[] = buildCircuitPath(AUTHORED_SKETCH);
const AUTHORED_KERB_QUADS = buildAuthoredKerbQuads(AUTHORED_PATH, AUTHORED_BAND, AUTHORED_KERBS);
// Fit = the editor's WYSIWYG maths: the TRUE drawn extent (ribbon inflated by band/2
// PLUS every kerb vertex — the circuit's fit lesson), band-bound scale capped so the
// whole drawn thing always fits the screen.
const AUTHORED_EXTENT = (() => {
  const half = AUTHORED_BAND / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const p of AUTHORED_PATH) { acc(p[0] - half, p[1] - half); acc(p[0] + half, p[1] + half); }
  for (const q of AUTHORED_KERB_QUADS) for (const p of q.pts) acc(p[0], p[1]);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
})();
const AUTHORED_SCALE = Math.min(
  circuitBandScale(AUTHORED_BAND),
  (AUTHORED_LOGICAL.widthM * CIRCUIT_FIT) / AUTHORED_EXTENT.w,
  (AUTHORED_LOGICAL.heightM * CIRCUIT_FIT) / AUTHORED_EXTENT.h,
);
const AUTHORED_TRACK_W = AUTHORED_SCALE * AUTHORED_BAND;
const AUTHORED_BCX = (AUTHORED_EXTENT.minX + AUTHORED_EXTENT.maxX) / 2;
const AUTHORED_BCY = (AUTHORED_EXTENT.minY + AUTHORED_EXTENT.maxY) / 2;
function authoredToWorld(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - AUTHORED_BCX) * AUTHORED_SCALE + AUTHORED_LOGICAL.widthM / 2,
    y: (sy - AUTHORED_BCY) * AUTHORED_SCALE + AUTHORED_LOGICAL.heightM / 2,
  };
}
// White boundary lines along both asphalt edges (kerb-aware insets), built once.
const AUTHORED_EDGE_LINES = buildAuthoredEdgeLines(
  AUTHORED_PATH, AUTHORED_BAND, AUTHORED_KERBS,
  WHITE_LINE_INSET_M / AUTHORED_SCALE, WHITE_LINE_W_M / AUTHORED_SCALE,
);

const AUTHORED_STRAIGHT_Y = Math.max(...AUTHORED_SKETCH.map((p) => p[1]));
// The finish PATH INDEX: the marked one when the editor set it, else derived — the
// centre of the flatten straight, falling back to the lowest path point.
const AUTHORED_FINISH_IDX = (() => {
  const N = AUTHORED_PATH.length;
  if (AUTHORED_FINISH_I !== null) return ((AUTHORED_FINISH_I % N) + N) % N;
  const f = flatFinishOf(AUTHORED_PATH, AUTHORED_STRAIGHT_Y);
  let bi = 0;
  if (Number.isFinite(f.x)) {
    let bd = Infinity;
    AUTHORED_PATH.forEach((p, i) => {
      const d = (p[0] - f.x) ** 2 + (p[1] - f.y) ** 2;
      if (d < bd) { bd = d; bi = i; }
    });
  } else {
    AUTHORED_PATH.forEach((p, i) => { if (p[1] > AUTHORED_PATH[bi][1]) bi = i; });
  }
  return bi;
})();
const AUTHORED_FINISH = { x: AUTHORED_PATH[AUTHORED_FINISH_IDX][0], y: AUTHORED_PATH[AUTHORED_FINISH_IDX][1] };
const AUTHORED_FAR = lapFarPointOf(AUTHORED_PATH, AUTHORED_FINISH);
const AUTHORED_PATH_WORLD: Pt[] = AUTHORED_PATH.map((p) => {
  const w = authoredToWorld(p[0], p[1]);
  return [w.x, w.y];
});

// Nearest ribbon index to a world point (the rallycross lookup pattern) — only ever
// consulted for points already known to be ON the ribbon, to test dirt membership.
function nearestAuthoredIdx(x: number, y: number): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < AUTHORED_PATH_WORLD.length; i++) {
    const p = AUTHORED_PATH_WORLD[i];
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

// The marked boundary lines, assigned to their NEARER dirt end, plus the arc
// EXTENSION each one implies: a line drawn BEYOND an end MOVES that end out to the
// line (the band is stretched to reach it, the cut trims it back to the exact
// polyline, and the PHYSICS border follows to the line's nearest path index so grip
// and render agree). A line inside the arc just trims (extension 0).
const AUTHORED_DIRT_EDGE_INFO = (() => {
  const none = { start: null as Array<[number, number]> | null, end: null as Array<[number, number]> | null, extStart: 0, extEnd: 0 };
  if (!AUTHORED_DIRT) return none;
  const N = AUTHORED_PATH.length;
  const nearestSketchIdx = (x: number, y: number): number => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) {
      const p = AUTHORED_PATH[i];
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const p0 = AUTHORED_PATH[AUTHORED_DIRT.i0], p1 = AUTHORED_PATH[AUTHORED_DIRT.i1];
  const info = { ...none };
  for (const line of AUTHORED_DIRT_EDGES) {
    if (line.length < 2) continue;
    const ms = line[Math.floor(line.length / 2)];
    const dS = (ms[0] - p0[0]) ** 2 + (ms[1] - p0[1]) ** 2;
    const dE = (ms[0] - p1[0]) ** 2 + (ms[1] - p1[1]) ** 2;
    const li = nearestSketchIdx(ms[0], ms[1]);
    if (dS <= dE) {
      info.start = line;
      const back = (AUTHORED_DIRT.i0 - li + N) % N;       // beyond the start = backward
      info.extStart = back < N / 2 ? back : 0;
    } else {
      info.end = line;
      const fwd = (li - AUTHORED_DIRT.i1 + N) % N;        // beyond the end = forward
      info.extEnd = fwd < N / 2 ? fwd : 0;
    }
  }
  return info;
})();

function authoredDirtAt(x: number, y: number): boolean {
  if (!AUTHORED_DIRT) return false;
  const N = AUTHORED_PATH.length;
  const span = (AUTHORED_DIRT.i1 - AUTHORED_DIRT.i0 + N) % N;
  const from = (AUTHORED_DIRT.i0 - AUTHORED_DIRT_EDGE_INFO.extStart + N) % N;
  const full = span + AUTHORED_DIRT_EDGE_INFO.extStart + AUTHORED_DIRT_EDGE_INFO.extEnd;
  return (nearestAuthoredIdx(x, y) - from + N) % N <= full;
}

// Racing direction = INCREASING path index (the drawing direction — the boss draws the
// bottom straight in the direction of travel). Tangent a few points ahead → a stable
// forward angle at any spot, whatever the layout does (no hardcoded −x assumption).
function authoredForwardAt(idx: number): number {
  const N = AUTHORED_PATH_WORLD.length;
  const a = AUTHORED_PATH_WORLD[idx], b = AUTHORED_PATH_WORLD[(idx + 8) % N];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}
const AUTHORED_FORWARD = authoredForwardAt(AUTHORED_FINISH_IDX);

// Standing grid that FOLLOWS THE RIBBON: walk backward along the path (against the
// racing direction) by the slot's arc distance, then offset laterally along the local
// normal. Two staggered columns sized from THIS track's width. Because the grid rides
// the centreline, every box stays on asphalt whatever the layout does behind the line
// (a straight-line grid put P8 on the grass when the finish sat near a corner).
function authoredGridPose(slot: number): { x: number; y: number; heading: number } {
  const N = AUTHORED_PATH_WORLD.length;
  const col = slot % 2, row = Math.floor(slot / 2);
  const back = CONFIG.wheelbase * 1.73 + row * CONFIG.wheelbase * 3.0 + col * CONFIG.wheelbase * 1.0;
  const lane = (col === 0 ? -1 : 1) * AUTHORED_TRACK_W * 0.18;
  let i = AUTHORED_FINISH_IDX, run = 0, guard = 0;
  while (run < back && guard++ < N) {
    const j = ((i - 1) % N + N) % N;
    run += Math.hypot(
      AUTHORED_PATH_WORLD[i][0] - AUTHORED_PATH_WORLD[j][0],
      AUTHORED_PATH_WORLD[i][1] - AUTHORED_PATH_WORLD[j][1],
    );
    i = j;
  }
  const heading = authoredForwardAt(i);
  const nx = -Math.sin(heading), ny = Math.cos(heading);   // left/right normal of travel
  const p = AUTHORED_PATH_WORLD[i];
  return { x: p[0] + nx * lane, y: p[1] + ny * lane, heading };
}

// PAINTED STARTING GRID — 8 boxes (2 columns × 4 rows) drawn AT the authored spawn poses,
// each oriented to the local racing direction so the grid rides the ribbon (the finish can
// sit on a corner). A half-frame per box — closed bar in FRONT of the nose, two arms running
// back alongside the car — same look/paint (white-line colour, alpha, weight) as the
// circuit's grid, and it reuses the circuit's wheelbase-derived box metres so one car fits a
// box. Painted in drawBackground → under the cars + skids, like the circuit's grid.
const AUTHORED_GRID_SLOTS = 8;   // 2-wide × 4 deep — matches PLAYER_CAP and the 2-column spawn
function drawAuthoredGrid(ctx: CanvasRenderingContext2D, pxPerM: number): void {
  ctx.save();
  ctx.strokeStyle = `rgba(${WHITE_LINE_RGB},${WHITE_LINE_ALPHA})`;
  ctx.lineWidth = Math.max(1, WHITE_LINE_W_M * pxPerM);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const hl = GRID_BOX_L / 2, hw = GRID_BOX_W / 2, arm = GRID_BOX_ARM;
  for (let i = 0; i < AUTHORED_GRID_SLOTS; i++) {
    const g = authoredGridPose(i);
    const ch = Math.cos(g.heading), sh = Math.sin(g.heading);
    // local (lx = along racing dir, +hl = in front of the nose; ly = lateral) → world → px
    const pt = (lx: number, ly: number): [number, number] =>
      [(g.x + lx * ch - ly * sh) * pxPerM, (g.y + lx * sh + ly * ch) * pxPerM];
    const a = pt(hl - arm, -hw), b = pt(hl, -hw), c = pt(hl, hw), d = pt(hl - arm, hw);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
    ctx.stroke();
  }
  ctx.restore();
}

// 2-tone surface mask (grass 0 / ribbon 1) — same bake + threshold approach as the
// circuit's, minus the kerb tone (there are no kerbs to classify).
let _authoredMask: Uint8Array | null | undefined;
let _authoredMW = 0, _authoredMH = 0;
function authoredMask(): Uint8Array | null {
  if (_authoredMask !== undefined) return _authoredMask;
  if (typeof document === 'undefined') { _authoredMask = null; return null; }   // off-DOM tests
  const W = Math.max(1, Math.round(AUTHORED_LOGICAL.widthM * CIRCUIT_MASK_PPM));
  const H = Math.max(1, Math.round(AUTHORED_LOGICAL.heightM * CIRCUIT_MASK_PPM));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d', { willReadFrequently: true });   // exists only to be read back
  if (!c) { _authoredMask = null; return null; }
  // Painted in FOUR tones so ONE raster carries the class (the circuit's approach):
  // grass 0, gravel LOW, ribbon MID, kerb HIGH. Gravel goes down FIRST — the ribbon
  // and kerbs paint over it, so a patch can never override the track itself.
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  c.strokeStyle = c.fillStyle = '#303030';
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const st of AUTHORED_GRAVEL) {
    if (st.pts.length < 2) continue;
    c.lineWidth = Math.max(1, st.w * AUTHORED_SCALE * CIRCUIT_MASK_PPM);
    traceWornPolyline(c, st.pts, ([sx, sy]) => {
      const w = authoredToWorld(sx, sy);
      return [w.x * CIRCUIT_MASK_PPM, w.y * CIRCUIT_MASK_PPM];
    });
    c.stroke();
  }
  c.strokeStyle = '#808080';
  c.lineJoin = 'round'; c.lineCap = 'round';
  c.beginPath();
  const p0 = authoredToWorld(AUTHORED_PATH[0][0], AUTHORED_PATH[0][1]);
  c.moveTo(p0.x * CIRCUIT_MASK_PPM, p0.y * CIRCUIT_MASK_PPM);
  for (let i = 1; i < AUTHORED_PATH.length; i++) {
    const w = authoredToWorld(AUTHORED_PATH[i][0], AUTHORED_PATH[i][1]);
    c.lineTo(w.x * CIRCUIT_MASK_PPM, w.y * CIRCUIT_MASK_PPM);
  }
  c.closePath();
  c.lineWidth = AUTHORED_TRACK_W * CIRCUIT_MASK_PPM;
  c.stroke();
  c.fillStyle = '#f0f0f0';
  for (const q of AUTHORED_KERB_QUADS) {
    c.beginPath();
    for (let i = 0; i < 4; i++) {
      const w = authoredToWorld(q.pts[i][0], q.pts[i][1]);
      if (i === 0) c.moveTo(w.x * CIRCUIT_MASK_PPM, w.y * CIRCUIT_MASK_PPM);
      else c.lineTo(w.x * CIRCUIT_MASK_PPM, w.y * CIRCUIT_MASK_PPM);
    }
    c.closePath(); c.fill();
  }
  try {
    const img = c.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    // thresholds midway between the painted tones (half-coverage rule at AA edges):
    // 240 kerb · 128 ribbon · 48 gravel · 0 grass
    for (let i = 0; i < W * H; i++) {
      const t = img[i * 4];
      mask[i] = t > 184 ? 2 : t > 88 ? 1 : t > 24 ? 3 : 0;   // 2 kerb · 1 ribbon · 3 gravel · 0 grass
    }
    _authoredMW = W; _authoredMH = H;
    _authoredMask = mask;
    return mask;
  } catch (err) {
    // don't cache the failure — a later call retries; lookups fall back to asphalt-everywhere
    noteError('authored-mask', err); console.warn('[circuit2] surface mask build failed:', err);
    return null;
  }
}
function authoredClassAt(x: number, y: number): MarkClass {
  const m = authoredMask();
  if (!m) return 'asphalt';        // no raster (off-DOM) → never penalise
  const mx = (x * CIRCUIT_MASK_PPM) | 0, my = (y * CIRCUIT_MASK_PPM) | 0;
  if (mx < 0 || my < 0 || mx >= _authoredMW || my >= _authoredMH) return 'grass';
  const v = m[my * _authoredMW + mx];
  return v === 2 ? 'kerb' : v === 1 ? 'asphalt' : v === 3 ? 'gravel' : 'grass';
}
function authoredSurfaceAt(x: number, y: number): Surface {
  const c = authoredClassAt(x, y);
  if (c === 'kerb') return 'asphalt';                 // a kerb IS asphalt to the physics
  if (c === 'gravel') return 'gravel';                // run-off patch — real gravel grip
  if (c !== 'asphalt') return 'grass';
  return authoredDirtAt(x, y) ? 'dirt' : 'asphalt';   // dirt laid OVER the ribbon (physics 'dirt')
}
// RENDER-ONLY mark class: kerbs scuff as kerbs, brown gouge marks on dirt AND gravel.
function authoredMarkClassAt(x: number, y: number): MarkClass {
  const c = authoredClassAt(x, y);
  if (c === 'kerb') return 'kerb';
  if (c === 'gravel') return 'gravel';
  if (c !== 'asphalt') return 'grass';
  return authoredDirtAt(x, y) ? 'gravel' : 'asphalt';
}
// TRACK GEOMETRY: on track = ribbon AND kerbs (a kerb is a track extension you may
// ride), never a material question — the dirt overlay does not change the geometry.
function authoredOnTrackAt(x: number, y: number): boolean {
  const c = authoredClassAt(x, y);
  return c === 'asphalt' || c === 'kerb';
}

function drawAuthoredSurface(ctx: CanvasRenderingContext2D, wPx: number, hPx: number) {
  const pxPerM = wPx / AUTHORED_LOGICAL.widthM;
  const rc = { wPx, hPx, pxPerM };
  // 1. GRASS — the whole field.
  SURFACES.grass.paint(ctx, (m, r) => { m.fillRect(0, 0, r.wPx, r.hPx); }, rc);
  // 1b. GRAVEL run-off patches — marked polygons (points connected straight), painted
  //     UNDER the tarmac (circuit order), so overlap with the ribbon hides beneath it.
  if (AUTHORED_GRAVEL.length) {
    SURFACES.gravel.paint(ctx, (m) => {
      m.lineCap = 'round'; m.lineJoin = 'round';
      for (const st of AUTHORED_GRAVEL) {
        if (st.pts.length < 2) continue;
        m.lineWidth = Math.max(1, st.w * AUTHORED_SCALE * pxPerM);
        traceWornPolyline(m, st.pts, ([sx, sy]) => {
          const w = authoredToWorld(sx, sy);
          return [w.x * pxPerM, w.y * pxPerM];
        });
        m.stroke();
      }
    }, rc);
  }
  // 2. ASPHALT — the ribbon, painted PROCEDURALLY in the oval's asphalt style (clean
  //    dark tarmac + a faint rubbered-in racing line). NOT SURFACES.asphalt here: its
  //    image fill is the designer's pre-rendered CIRCUIT art (kerbs/gravel baked in),
  //    which leaks the old track's features through any other ribbon shape.
  const trace = (m: CanvasRenderingContext2D) => {
    m.beginPath();
    const q0 = authoredToWorld(AUTHORED_PATH[0][0], AUTHORED_PATH[0][1]);
    m.moveTo(q0.x * pxPerM, q0.y * pxPerM);
    for (let i = 1; i < AUTHORED_PATH.length; i++) {
      const w = authoredToWorld(AUTHORED_PATH[i][0], AUTHORED_PATH[i][1]);
      m.lineTo(w.x * pxPerM, w.y * pxPerM);
    }
    m.closePath();
    m.lineJoin = 'round'; m.lineCap = 'round';
  };
  trace(ctx);                                               // ONE flat tone — the lighter of the
  ctx.strokeStyle = '#3b3e44';                              // oval's two (boss's pick); no gradient,
  ctx.lineWidth = AUTHORED_TRACK_W * pxPerM;                // no darker worn-line stripe
  ctx.stroke();

  // The dirt SHAPE (band over the marked arc, clipped to the ribbon) — NAMED so it
  // both paints the dirt (2b) and clips the worn line (2c). An end WITH a marked
  // boundary polyline (AUTHORED_DIRT_EDGES) gets the band extended past it and CUT
  // to the drawn line (the rallycross approach); an end without one keeps the plain
  // straight butt cut.
  const dirtShape = AUTHORED_DIRT
    ? (m: CanvasRenderingContext2D): void => {
        const N = AUTHORED_PATH.length;
        const span = (AUTHORED_DIRT.i1 - AUTHORED_DIRT.i0 + N) % N;
        const d0 = AUTHORED_DIRT.i0;
        // marked lines + the extensions they imply (module-computed, physics uses the same)
        const { start: edgeStart, end: edgeEnd, extStart, extEnd } = AUTHORED_DIRT_EDGE_INFO;
        const EXT = 12;                            // cut margin past the line (path samples)
        const from = edgeStart ? -(extStart + EXT) : 0, to = span + (edgeEnd ? extEnd + EXT : 0);
        m.beginPath();
        for (let n = from; n <= to; n++) {
          const p = AUTHORED_PATH_WORLD[((d0 + n) % N + N) % N];
          if (n === from) m.moveTo(p[0] * pxPerM, p[1] * pxPerM);
          else m.lineTo(p[0] * pxPerM, p[1] * pxPerM);
        }
        m.lineJoin = 'round'; m.lineCap = 'butt';
        m.lineWidth = AUTHORED_TRACK_W * pxPerM;
        m.stroke();
        // CUT to each drawn boundary: the marked points connected STRAIGHT, both ends
        // extended past the band edges, closed with a polygon toward the asphalt side.
        // The polygon is LOCALISED (intersected with the band segment around ITS end,
        // the [winFrom..winTo] index window) — the winding track can bring ANOTHER
        // dirt section close to the line, and an unbounded cut erased it there.
        const cut = (lineS: Array<[number, number]>, backIdxDir: 1 | -1, endIdx: number,
          winFrom: number, winTo: number): void => {
          const C = scratch(2, wPx, hPx), cc = C ? C.getContext('2d') : null;
          if (!C || !cc) return;                   // no scratch → skip the cut (plain end stays)
          cc.setTransform(1, 0, 0, 1, 0, 0);
          cc.clearRect(0, 0, wPx, hPx);
          cc.fillStyle = cc.strokeStyle = '#fff';
          const e: Pt[] = lineS.map(([sx, sy]) => {
            const w = authoredToWorld(sx, sy);
            return [w.x * pxPerM, w.y * pxPerM];
          });
          const reach = AUTHORED_TRACK_W * pxPerM;
          const ext = (a: Pt, b: Pt): Pt => {
            const dx = a[0] - b[0], dy = a[1] - b[1];
            const L = Math.hypot(dx, dy) || 1;
            return [a[0] + (dx / L) * reach, a[1] + (dy / L) * reach];
          };
          const poly = [ext(e[0], e[1]), ...e, ext(e[e.length - 1], e[e.length - 2])];
          const bp = AUTHORED_PATH_WORLD[((endIdx + backIdxDir * 10) % N + N) % N];
          const ep = AUTHORED_PATH_WORLD[((endIdx % N) + N) % N];
          let bx = bp[0] - ep[0], by = bp[1] - ep[1];
          const bl = Math.hypot(bx, by) || 1;
          bx /= bl; by /= bl;
          const BIG = reach * 4;
          cc.beginPath();
          cc.moveTo(poly[0][0], poly[0][1]);
          for (let k = 1; k < poly.length; k++) cc.lineTo(poly[k][0], poly[k][1]);
          cc.lineTo(poly[poly.length - 1][0] + bx * BIG, poly[poly.length - 1][1] + by * BIG);
          cc.lineTo(poly[0][0] + bx * BIG, poly[0][1] + by * BIG);
          cc.closePath();
          cc.fill();
          cc.globalCompositeOperation = 'destination-in';
          cc.beginPath();
          for (let n = winFrom; n <= winTo; n++) {
            const p = AUTHORED_PATH_WORLD[((n % N) + N) % N];
            if (n === winFrom) cc.moveTo(p[0] * pxPerM, p[1] * pxPerM);
            else cc.lineTo(p[0] * pxPerM, p[1] * pxPerM);
          }
          cc.lineJoin = 'round'; cc.lineCap = 'butt';
          cc.lineWidth = AUTHORED_TRACK_W * pxPerM * 1.3;
          cc.stroke();
          cc.globalCompositeOperation = 'source-over';
          m.globalCompositeOperation = 'destination-out';
          m.drawImage(C, 0, 0);
          m.globalCompositeOperation = 'source-over';
        };
        // window OVERSHOOTS the band end by 12 samples — with both butt faces at the
        // same index, AA left a half-erased 1px dirt sliver across the track there
        if (edgeStart) {
          cut(edgeStart, -1, ((d0 - extStart) % N + N) % N,
            d0 - extStart - EXT - 12, d0 + 40);
        }
        if (edgeEnd) {
          cut(edgeEnd, 1, (d0 + span + extEnd) % N,
            d0 + span - 40, d0 + span + extEnd + EXT + 12);
        }
        m.globalCompositeOperation = 'destination-in';
        trace(m);
        m.lineWidth = AUTHORED_TRACK_W * pxPerM;
        m.stroke();
        m.globalCompositeOperation = 'source-over';
      }
    : null;

  // IDEAL-LINE layer: the drawn strokes on a scratch, clipped by a shape painted on a
  // second scratch (destination-in), composited at the pass's alpha. Two passes: dark
  // rubbered on the tarmac (2a, under the dirt), lighter worn tone on the dirt (2c).
  const lineLayer = (tone: string, alpha: number, shapeFn: (m: CanvasRenderingContext2D) => void): void => {
    if (!AUTHORED_LINE.length) return;
    const L = scratch(3, wPx, hPx), lc = L ? L.getContext('2d') : null;
    const M = scratch(4, wPx, hPx), mc = M ? M.getContext('2d') : null;
    if (!L || !lc || !M || !mc) return;
    lc.setTransform(1, 0, 0, 1, 0, 0); lc.clearRect(0, 0, wPx, hPx);
    lc.lineCap = 'round'; lc.lineJoin = 'round';
    lc.strokeStyle = tone;
    for (const st of AUTHORED_LINE) {
      if (st.pts.length < 2) continue;
      lc.lineWidth = Math.max(1, st.w * AUTHORED_SCALE * pxPerM);   // EXACT drawn brush width
      traceWornPolyline(lc, st.pts, ([sx, sy]) => {                  // smoothed — no hand jitter
        const w = authoredToWorld(sx, sy);
        return [w.x * pxPerM, w.y * pxPerM];
      });
      lc.stroke();
    }
    mc.setTransform(1, 0, 0, 1, 0, 0); mc.clearRect(0, 0, wPx, hPx);
    mc.fillStyle = mc.strokeStyle = '#fff';
    mc.lineJoin = 'round'; mc.lineCap = 'round';
    shapeFn(mc);
    lc.globalCompositeOperation = 'destination-in';
    lc.drawImage(M, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(L, 0, 0);
    ctx.restore();
  };
  // 2a. worn line, TARMAC pass — subtle darker rubbered band, clipped to the ribbon.
  lineLayer('#181a1e', 0.38, (m) => { trace(m); m.lineWidth = AUTHORED_TRACK_W * pxPerM; m.stroke(); });

  // 2b. DIRT section — the marked arc, packed-earth surface laid over the ribbon.
  if (dirtShape) {
    SURFACES.dirt.paint(ctx, dirtShape, rc);
    // 2c. worn line, DIRT pass — just LIGHTER, nothing fancy (rallycross language),
    //     clipped to the dirt so it can't smudge onto the tarmac or grass.
    const [lr, lg, lb] = DIRT_LOOK.line;
    lineLayer(`rgb(${lr},${lg},${lb})`, 1, dirtShape);
  }
  // 2d. WHITE EDGE LINES — thin boundary lines along both asphalt edges, the same
  //     paint family/weight as the start line. They run across the dirt too (the
  //     rallycross language); the kerbs paint OVER their seam right after.
  ctx.save();
  ctx.strokeStyle = `rgba(${WHITE_LINE_RGB},${WHITE_LINE_ALPHA})`;
  ctx.lineWidth = Math.max(1, WHITE_LINE_W_M * pxPerM);
  ctx.lineJoin = 'round';
  for (const line of AUTHORED_EDGE_LINES) {
    ctx.beginPath();
    for (let i = 0; i < line.length; i++) {
      const w = authoredToWorld(line[i][0], line[i][1]);
      if (i === 0) ctx.moveTo(w.x * pxPerM, w.y * pxPerM);
      else ctx.lineTo(w.x * pxPerM, w.y * pxPerM);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();

  // 3. KERBS — blue borders first, stripes on top (the builder pre-orders them).
  for (const q of AUTHORED_KERB_QUADS) {
    ctx.fillStyle = q.fill;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const w = authoredToWorld(q.pts[i][0], q.pts[i][1]);
      if (i === 0) ctx.moveTo(w.x * pxPerM, w.y * pxPerM);
      else ctx.lineTo(w.x * pxPerM, w.y * pxPerM);
    }
    ctx.closePath(); ctx.fill();
  }
  // 4. START/FINISH — one plain white line across the local travel direction, in the
  //    circuit's paint family (same tone/alpha/width as its start line).
  const fin = authoredToWorld(AUTHORED_FINISH.x, AUTHORED_FINISH.y);
  const qx = Math.cos(AUTHORED_FORWARD + Math.PI / 2), qy = Math.sin(AUTHORED_FORWARD + Math.PI / 2);
  ctx.save();
  ctx.strokeStyle = `rgba(${WHITE_LINE_RGB},${WHITE_LINE_ALPHA})`;
  ctx.lineWidth = Math.max(1, WHITE_LINE_W_M * pxPerM);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo((fin.x - qx * AUTHORED_TRACK_W / 2) * pxPerM, (fin.y - qy * AUTHORED_TRACK_W / 2) * pxPerM);
  ctx.lineTo((fin.x + qx * AUTHORED_TRACK_W / 2) * pxPerM, (fin.y + qy * AUTHORED_TRACK_W / 2) * pxPerM);
  ctx.stroke();
  ctx.restore();

  // 5. STARTING GRID — 8 painted boxes behind the line, riding the ribbon.
  drawAuthoredGrid(ctx, pxPerM);
}

// ---- AUTHORED BILLBOARDS — same machinery as the circuit's ------------------------
// Collision: a solid CIRCLE the diameter of the leg (post) at EACH leg's ground point
// (full-circle arc, car stays outside) — the bottom of the leg, exactly like the
// circuit. Scales with the per-board `scale`.
function authoredBillboardArcs(): ObstacleArc[] {
  const out: ObstacleArc[] = [];
  for (const bb of AUTHORED_BILLBOARDS) {
    const w = authoredToWorld(bb.sx, bb.sy);
    for (const dx of [-BILLBOARD_DIMS.legDxM * bb.scale, BILLBOARD_DIMS.legDxM * bb.scale]) {
      out.push({ cx: w.x + dx, cy: w.y, r: BILLBOARD_DIMS.legR * bb.scale, a0: 0, a1: Math.PI * 2, inside: false });
    }
  }
  return out;
}
function authoredAdAt(xM: number, yM: number): string | null {
  for (let i = AUTHORED_BILLBOARDS.length - 1; i >= 0; i--) {
    const bb = AUTHORED_BILLBOARDS[i];
    if (!bb.ad) continue;
    const w = authoredToWorld(bb.sx, bb.sy);
    const halfW = BILLBOARD_DIMS.W_M * bb.scale / 2;
    const panelBottom = w.y - BILLBOARD_DIMS.POST_H_M * bb.scale;
    const panelTop = panelBottom - BILLBOARD_DIMS.BOARD_H_M * bb.scale;
    if (xM >= w.x - halfW && xM <= w.x + halfW && yM >= panelTop && yM <= panelBottom) return bb.ad.url;
  }
  return null;
}
function drawAuthoredBillboardShadows(ctx: CanvasRenderingContext2D, px: number) {
  for (const bb of AUTHORED_BILLBOARDS) {
    const w = authoredToWorld(bb.sx, bb.sy);
    drawBillboardShadow(ctx, w.x * px, w.y * px, px * bb.scale);
  }
}
function drawAuthoredBillboardsAbove(ctx: CanvasRenderingContext2D, px: number) {
  for (const bb of AUTHORED_BILLBOARDS) {
    const w = authoredToWorld(bb.sx, bb.sy);
    drawBillboardBody(ctx, w.x * px, w.y * px, px * bb.scale, bb.ad);
  }
}

export const authoredCircuitMap: MapDefinition = {
  id: 'circuit2',
  name: 'Circuit II (Rallycross)',
  gameModes: ['free', 'race', 'timeattack', 'xp'],
  // start-only gate ⇒ circuit (laps); the editor shows the LAPS panel, like the ovals.
  trackType: 'circuit',
  smokeColor: [248, 248, 251],    // white rubber smoke (asphalt)
  fixedWorld: AUTHORED_LOGICAL,   // one screen ⇒ standard car size, no camera scroll

  surfaceAt: authoredSurfaceAt,   // arms per-wheel grass grip/drag in physics4
  onTrackAt: authoredOnTrackAt,   // ribbon geometry (XP off-track, race cut detection)

  // OPEN track: no barriers — the only collisions are the billboard legs (bottom of
  // each post), exactly like the circuit.
  createWorld(widthM, heightM) {
    return { width: widthM, height: heightM, rects: [], arcs: authoredBillboardArcs() };
  },

  drawBackground(ctx, wPx, hPx) { drawAuthoredSurface(ctx, wPx, hPx); },
  // Under the cars: the billboards' ground shadows.
  drawObstacles(ctx, _world, px) { drawAuthoredBillboardShadows(ctx, px); },
  // Over the cars: the raised billboard bodies — a car passing under a panel hides behind it.
  drawAboveCars(ctx, _world, px) { drawAuthoredBillboardsAbove(ctx, px); },
  // Ad click hit-test (billboard faces).
  adAt(xM, yM) { return authoredAdAt(xM, yM); },

  // Same gate semantics as the circuit: one start line on the derived finish, the
  // gate lying across the local direction of travel, lap arms at the far point.
  startLine(world) {
    void world;
    const c = authoredToWorld(AUTHORED_FINISH.x, AUTHORED_FINISH.y);
    const far = authoredToWorld(AUTHORED_FAR.x, AUTHORED_FAR.y);
    return {
      type: 'start',
      x: c.x,
      y: c.y,
      radius: AUTHORED_TRACK_W / 2,
      angle: AUTHORED_FORWARD + Math.PI / 2,   // the gate lies ACROSS the travel direction
      forward: AUTHORED_FORWARD,
      farX: far.x,
      farY: far.y,
      farRadius: AUTHORED_TRACK_W,
    };
  },
  // Leaderboard zones: the authored ribbon centreline (finish-anchored, forward).
  zonePath() { return authoredZonePath(); },

  // Standing start behind the line — the grid follows the ribbon (authoredGridPose),
  // so every box sits on asphalt whatever the layout does behind the line.
  spawn(slot, world) {
    void world;
    return authoredGridPose(slot);
  },

  // No walls: just the soft world-edge clamp (grass extends to the edge).
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

// =============================================================================
//  FOOTBALL ARENA (id 'arena') — STEP 1: just the enclosed space, nothing else.
//  A closed, SOLID-floored rounded RECTANGLE (not a ring like the oval): asphalt
//  everywhere inside, SOLID perimeter walls the car bounces off via the SAME
//  collideWithRects / collideWithArcs path the ovals already use — NO new physics.
//  All four sides are STRAIGHT with four generous CORNER arcs; the two SHORT ends
//  stay flat (goals land there in a later step). No ball, goals, teams or score
//  yet — FREE RIDE only. Tuned for 1v1: long axis ~25% shorter than the stadium
//  oval, 3:2 aspect, crossable end-to-end in a few seconds.
// =============================================================================
const ARENA_INTERIOR_W = 180;   // long (horizontal) interior span, m — the crossing distance (goal→goal)
const ARENA_INTERIOR_H = 100;   // short (vertical) interior span, m — the pitch WIDTH; narrowed 1/6
                                //   (120 → 100) for a tighter 1v1. Now 180:100 = 1.8:1
const ARENA_CORNER_R   = 40;    // corner arc radius, m — heavily rounded; < H/2 so each SHORT
                                //   end keeps a 2·(50−40) = 20 m flat straight for a goal later
const ARENA_WALL       = 3.5;   // wall strip thickness, m (matches the oval's wall floor)
const ARENA_MARGIN     = 6;     // ground border drawn outside the walls, m
const ARENA_LOGICAL = {
  widthM:  ARENA_INTERIOR_W + 2 * ARENA_MARGIN,   // 192  (oval world is 256 → 0.75×)
  heightM: ARENA_INTERIOR_H + 2 * ARENA_MARGIN,   // 112  (oval world is 144 → 0.78×)
};

interface ArenaGeom { cx: number; cy: number; HX: number; HY: number; r: number; sq: number; }
interface ArenaWorld extends MapWorld { geom: ArenaGeom; }

function computeArena(wM: number, hM: number): ArenaGeom {
  return {
    cx: wM / 2, cy: hM / 2,
    HX: ARENA_INTERIOR_W / 2, HY: ARENA_INTERIOR_H / 2,   // 90 × 60
    r: ARENA_CORNER_R, sq: ARENA_WALL,
  };
}

// Perimeter STRAIGHT walls — one thin AABB per side, CENTRED on the interior edge (so the drawn
// wall strip IS the collision wall, its band-side face = where the car stops), spanning only the
// flat run between the corners (+ a small overlap into each corner so there's no seam).
function arenaWalls(g: ArenaGeom): ObstacleRect[] {
  const { cx, cy, HX, HY, r, sq } = g;
  const ext = sq;                        // straight↔corner overlap
  const flatX = HX - r, flatY = HY - r;  // half-length of each flat run
  return [
    { x: cx - flatX - ext, y: cy - HY - sq / 2, w: 2 * flatX + 2 * ext, h: sq },  // top    (long side)
    { x: cx - flatX - ext, y: cy + HY - sq / 2, w: 2 * flatX + 2 * ext, h: sq },  // bottom (long side)
    { x: cx - HX - sq / 2, y: cy - flatY - ext, w: sq, h: 2 * flatY + 2 * ext },  // left   (short end, flat)
    { x: cx + HX - sq / 2, y: cy - flatY - ext, w: sq, h: 2 * flatY + 2 * ext },  // right  (short end, flat)
  ];
}

// The four rounded CORNERS as curved (arc) collision boundaries — the car (capsule) contacts the
// smooth curve exactly, no scalloping, exactly like the oval turns. Each centre sits r inside its
// true corner; radius = r − sq/2 (the strip's band-side edge = the straights' inner face);
// inside:true = the car stays inside the arc. A small angular pad overlaps the straights at both
// junctions of every corner.
function arenaArcs(g: ArenaGeom): ObstacleArc[] {
  const { cx, cy, HX, HY, r, sq } = g;
  const rr = r - sq / 2, pad = 0.16, P = Math.PI;
  const ox = HX - r, oy = HY - r;        // corner-centre offset from the arena centre
  return [
    { cx: cx - ox, cy: cy - oy, r: rr, a0: P - pad,        a1: P * 1.5 + pad, inside: true }, // top-left
    { cx: cx + ox, cy: cy - oy, r: rr, a0: P * 1.5 - pad,  a1: P * 2 + pad,   inside: true }, // top-right
    { cx: cx + ox, cy: cy + oy, r: rr, a0: -pad,           a1: P * 0.5 + pad, inside: true }, // bottom-right
    { cx: cx - ox, cy: cy + oy, r: rr, a0: P * 0.5 - pad,  a1: P + pad,       inside: true }, // bottom-left
  ];
}

// Trace the rounded-rect outline at the interior edge, optionally INSET inward by `inset` metres
// (inset = sq/2 gives the walls' band-side face). arcTo rounds each corner with radius r → the
// drawn corners coincide with arenaArcs' collision arcs.
function arenaRoundRectPath(ctx: CanvasRenderingContext2D, g: ArenaGeom, s: number, inset: number) {
  const HX = g.HX - inset, HY = g.HY - inset, r = Math.max(0, g.r - inset);
  const L = (g.cx - HX) * s, R = (g.cx + HX) * s, T = (g.cy - HY) * s, B = (g.cy + HY) * s, rr = r * s;
  ctx.beginPath();
  ctx.moveTo(L + rr, T); ctx.lineTo(R - rr, T); ctx.arcTo(R, T, R, T + rr, rr);
  ctx.lineTo(R, B - rr); ctx.arcTo(R, B, R - rr, B, rr);
  ctx.lineTo(L + rr, B); ctx.arcTo(L, B, L, B - rr, rr);
  ctx.lineTo(L, T + rr); ctx.arcTo(L, T, L + rr, T, rr);
  ctx.closePath();
}

function drawArena(ctx: CanvasRenderingContext2D, wPx: number, hPx: number) {
  const s = wPx / ARENA_LOGICAL.widthM;   // px per metre (uniform — fixedWorld = ARENA_LOGICAL)
  const g = computeArena(ARENA_LOGICAL.widthM, ARENA_LOGICAL.heightM);
  // 1. dark surround (the border + any pillarbox outside the pitch).
  ctx.fillStyle = '#12101a'; ctx.fillRect(0, 0, wPx, hPx);
  // 2. asphalt floor — a clean tarmac, between the oval's ring tones.
  arenaRoundRectPath(ctx, g, s, 0);
  ctx.fillStyle = '#33363d'; ctx.fill();
  // 2b. neutral arena markings (halfway line + centre circle), faint — spatial reference only.
  ctx.save();
  arenaRoundRectPath(ctx, g, s, 0); ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = Math.max(1, 0.5 * s);
  ctx.beginPath(); ctx.moveTo(g.cx * s, (g.cy - g.HY) * s); ctx.lineTo(g.cx * s, (g.cy + g.HY) * s); ctx.stroke();
  ctx.beginPath(); ctx.arc(g.cx * s, g.cy * s, 14 * s, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // 3. wall strip — stroke the interior edge CENTRED (width sq) so its band-side face is exactly
  //    the collision boundary (arenaWalls/arenaArcs). Dark tyre-wall look.
  arenaRoundRectPath(ctx, g, s, 0);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = '#15171c'; ctx.lineWidth = g.sq * s; ctx.stroke();
  // 3b. a thin bright inner edge (at the band-side face) so the boundary reads clearly.
  arenaRoundRectPath(ctx, g, s, g.sq / 2);
  ctx.strokeStyle = 'rgba(120,200,255,0.45)'; ctx.lineWidth = Math.max(1, 0.35 * s); ctx.stroke();
}

// A closed arena: NO track ribbon ⇒ no onTrackAt / startLine / zonePath (all optional). FREE RIDE
// only; the mode system is untouched. Solid walls do all containment; `wrap` is a backstop clamp.
export const arenaMap: MapDefinition = {
  id: 'arena',
  name: 'Arena',
  trackType: 'open',              // no lap/finish line; behaves like a walled free-roam space
  gameModes: ['free'],            // FREE RIDE only for now — no football mode yet
  smokeColor: [248, 248, 251],    // white asphalt smoke
  markClass: 'asphalt',           // grey rubber tyre marks
  fixedWorld: ARENA_LOGICAL,      // whole arena on ONE screen ⇒ constant car size, no follow-cam
  // surfaceAt omitted ⇒ asphalt everywhere (predictable handling), as requested.

  createWorld(widthM, heightM) {
    const g = computeArena(widthM, heightM);
    const world: ArenaWorld = {
      width: widthM, height: heightM,
      rects: arenaWalls(g), arcs: arenaArcs(g), geom: g,
    };
    return world;
  },

  drawBackground(ctx, wPx, hPx) { drawArena(ctx, wPx, hPx); },
  drawObstacles() { /* walls are static geometry (rects/arcs), painted in drawBackground */ },

  // Two spawns facing each other, one near each SHORT end (1v1). Even slots start on the left
  // half facing +x, odd on the right facing −x; extra pairs stack alternately off centre.
  spawn(slot, world) {
    const g = (world as ArenaWorld).geom;
    const side = slot % 2, row = Math.floor(slot / 2);
    const x = side === 0 ? g.cx - g.HX * 0.55 : g.cx + g.HX * 0.55;
    const heading = side === 0 ? 0 : Math.PI;
    const step = CONFIG.wheelbase * 3.2;
    const yOff = row === 0 ? 0 : (row % 2 === 1 ? 1 : -1) * Math.ceil(row / 2) * step;
    const yLim = g.HY - g.r * 0.4;   // keep spawns off the rounded corners
    return { x, y: g.cy + Math.max(-yLim, Math.min(yLim, yOff)), heading };
  },

  // Closed track: the perimeter walls contain the car. `wrap` only hard-clamps a car that somehow
  // escaped the world rect (no torus wrap), mirroring the ovals.
  wrap(car, world) {
    const m = 1.5;
    let clamped = false;
    if (car.x < m) { car.x = m; car.vx = 0; clamped = true; }
    else if (car.x > world.width - m) { car.x = world.width - m; car.vx = 0; clamped = true; }
    if (car.y < m) { car.y = m; car.vy = 0; clamped = true; }
    else if (car.y > world.height - m) { car.y = world.height - m; car.vy = 0; clamped = true; }
    return clamped;
  },

  draggableObstacles: false,   // fixed walls — the drag hooks are never called
};

registerMap(desktopMap);
registerMap(flatTrackMap);
registerMap(asphaltTrackMap);
registerMap(circuitMap);
registerMap(rallycrossMap);
registerMap(authoredCircuitMap);
registerMap(arenaMap);
