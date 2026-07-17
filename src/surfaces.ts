// =============================================================================
//  Steer It — SURFACE LIBRARY
//
//  ONE surface = ONE definition, game-wide. Saying "grass" means one thing
//  everywhere: how it LOOKS + how it GRIPS + what MARKS it takes + what DUST it
//  throws. A map never re-describes a surface — it only supplies GEOMETRY and
//  PLACEMENT ("the field is grass", "these regions are gravel", "the ribbon is
//  asphalt") and the library paints it.
//
//  Nothing map-specific lives in here: a surface is handed a SHAPE (a callback
//  that paints the region's alpha) plus the world transform, and fills it. That
//  is what keeps the boundaries GEOMETRIC — the shape's own anti-aliased path is
//  the edge, so every transition is as clean as a vector stroke, at any zoom.
//
//  Textures bake ONCE per (surface, canvas size, angle) into a cached canvas —
//  the per-frame cost is a single drawImage of an already-composited layer.
//
//  Physics + effects are NOT re-defined here; the library just joins the existing
//  identities onto the surface so consumers can ask one object for all of it.
// =============================================================================

import { FX_CONFIG, GRASS_DUST_RGB, GRAVEL_SPRAY_RGB, DEFAULT_SMOKE_RGB } from './effects';
import type { Surface, MarkClass } from './maps';   // type-only ⇒ erased, no import cycle

export type SurfaceId = 'grass' | 'gravel' | 'asphalt';

/** The target canvas + world scale a surface is being painted for. */
export interface SurfaceRC { wPx: number; hPx: number; pxPerM: number; }

/**
 * A region to fill. It paints the region's ALPHA into `mask` (fill/stroke/drawImage —
 * the style is pre-set to opaque white). Its own path anti-aliasing becomes the
 * surface's edge, so a spline stroke or a blurred disc-union both work and both
 * come out with soft, oval-grade boundaries.
 */
export type SurfaceShape = (mask: CanvasRenderingContext2D, rc: SurfaceRC) => void;

export interface SurfacePaintOpts {
  /** Overrides the surface's default texture direction (mown stripes / rake grooves). */
  angleDeg?: number;
}

/** A ring of offsets, for eroding/dilating an alpha by `r` px (an octagon — plenty for a rim). */
function ring(r: number): Array<[number, number]> {
  const d = r * Math.SQRT1_2;
  return [[r, 0], [-r, 0], [0, r], [0, -r], [d, d], [d, -d], [-d, d], [-d, -d]];
}

/** What a surface throws when a wheel digs into it (the existing effects identity). */
export interface SurfaceDust {
  readonly rgb: readonly [number, number, number];
  readonly scale: number; readonly size: number; readonly alpha: number;
}

export interface SurfaceDef {
  readonly id: SurfaceId;
  /** Physics binding — the value `physics4` looks up in `tire.muScale` / the drag terms. */
  readonly physics: Surface;
  /** Effects identity — the class `marks.ts` caps/tints rubber + gouges by. */
  readonly markClass: MarkClass;
  readonly dust: SurfaceDust;
  /** The full-canvas texture for this surface (cached). Null only if there is no DOM. */
  texture(rc: SurfaceRC, opts?: SurfacePaintOpts): CanvasImageSource | null;
  /** Fill `shape`'s region with this surface, compositing onto `ctx`. */
  paint(ctx: CanvasRenderingContext2D, shape: SurfaceShape, rc: SurfaceRC, opts?: SurfacePaintOpts): void;
}

// ---------------------------------------------------------------- tunables ---

/**
 * GRASS — a groomed, MOWN lawn: alternating bands of the two greens of our family,
 * laid at a slight fixed diagonal. Subtle contrast on purpose: it should read as a
 * mower's stripes catching the light, never as a checkerboard.
 */
export const GRASS_LOOK = {
  light: [116, 164, 72] as [number, number, number],   // the family's light green
  dark:  [98, 143, 62] as [number, number, number],    // …and a slightly darker one
  bandM: 4.2,        // METRES per band (world-scaled ⇒ same look at any zoom/canvas)
  angleDeg: 12,      // slight diagonal off horizontal
  edgeSoft: 0.12,    // 0..1 — band-edge softness (small = crisp bands, large = wavy gradient)
};

/**
 * GRAVEL — a light, warm sand trap, RAKED: broad flat beige with soft brown-tinted
 * grooves where the rake teeth expose the damper layer underneath. Stylized and
 * zen-groomed — the base × groove interplay IS the surface, not photographic noise.
 */
export const GRAVEL_LOOK = {
  base:   [203, 189, 160] as [number, number, number],  // light warm sand-beige
  groove: [140, 108,  72] as [number, number, number],  // the damp under-layer (brown)
  rakeStrength: 0.20,   // 0..1 — how dark the groove shading gets at its centre
  rakeSpacingM: 2.0,    // METRES between grooves
  rakeAngleDeg: 38,     // one consistent global direction (≠ the grass angle → reads distinct)
  rakeSharp: 2.0,       // groove profile power: >1 = broad light bands, narrow soft grooves
  // Grain: OFF. Judged both ways at 1:1 and blown up — a per-cell speckle fine enough to read
  // as sand is below a pixel here, so it only aliases into a faint dither (and a blocky
  // checkerboard when zoomed). The raking alone carries the surface, which is the drawn,
  // zen-groomed look we want. Left as a knob: raise it for a hint of grain.
  speckle: 0,           // 0..1 — a HINT of grain (0 = off)
  speckleM: 0.22,       // metres per speckle cell
};

// ------------------------------------------------------------- asphalt fill ---
// The asphalt surface's fill is the designer's approved tarmac — the light tone with
// the worn ideal line. It is the SURFACE's texture (a game-wide asphalt look that
// happens to be authored as an image), not a map's picture: maps only cut shapes out
// of it. This is the only bitmap in the render.
// The source image is a finished picture, so its tarmac carries its OWN baked edge treatment
// (a dark anti-aliased rim). Our shape's edge is not the image's edge, so that rim would land
// just inside our boundary as a dark fringe. Cured GEOMETRICALLY (see cleanFill): sample the
// fill only from well inside the shape, then stretch that clean tarmac back out to the edge.
const ASPHALT_FILL_SRC = 'track-surfaces.png';
const ASPHALT_FILL_INSET_M = 0.9;   // m — how far inside the shape the fill is sampled from
const ASPHALT_PRELOAD: [string, string] = ['#63676f', '#565a62'];   // ≈rgb(92,96,104) until it loads

let _asphaltImg: HTMLImageElement | null = null;
let _asphaltReady = false;   // true ONLY once the bitmap has DECODED (i.e. is canvas-paintable)
let _onReady: (() => void) | null = null;

/**
 * Register a host repaint for when the async surface assets become paintable. If the asset
 * has ALREADY decoded (the callback lost the race), fire immediately so the host never misses
 * the one-shot invalidation.
 */
export function onSurfaceAssetsReady(cb: () => void): void {
  _onReady = cb;
  if (_asphaltReady) cb();
}

function markAsphaltReady(): void {
  _asphaltReady = true;
  if (_onReady) _onReady();   // invalidate + repaint the host's static layers, now that it decoded
}

function asphaltFill(): HTMLImageElement | null {
  if (typeof document === 'undefined') return null;
  if (!_asphaltImg) {
    const img = new Image();
    // `img.complete`/`onload` is NOT enough. On WebKit (Safari/Mac) the bitmap fires `load`
    // BEFORE it is decoded, and drawing an undecoded image composites TRANSPARENT pixels —
    // cleanFill uses source-in, so a transparent source CLEARS the ribbon and the grass below
    // shows through (and, because the wallpaper is a one-shot static layer, it sticks and
    // survives a cached restart). Gate readiness on decode(): only expose the image once it is
    // genuinely paintable; until then — and FOREVER on a load/decode failure — asphaltFill
    // returns null so the flat preload tarmac tone fills the ribbon, never transparent-to-grass.
    img.src = ASPHALT_FILL_SRC;
    if (typeof img.decode === 'function') {
      img.decode().then(markAsphaltReady).catch(() => { /* failed → keep the preload tone */ });
    } else {
      // Ancient engines without decode(): fall back to onload + a natural-size check.
      img.onload = () => { if (img.naturalWidth > 0) markAsphaltReady(); };
    }
    _asphaltImg = img;
  }
  return _asphaltReady ? _asphaltImg : null;
}

// ------------------------------------------------------------------ helpers ---

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Deterministic per-cell hash → the speckle is identical every load. */
function hash2(ix: number, iy: number): number {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w)); cv.height = Math.max(1, Math.round(h));
  return cv;
}

/** Reusable scratch buffers (allocated once, resized on demand). */
const _scratches: Array<HTMLCanvasElement | null> = [];
function scratch(i: number, w: number, h: number): HTMLCanvasElement | null {
  if (!_scratches[i]) _scratches[i] = makeCanvas(w, h);
  const cv = _scratches[i];
  if (!cv) return null;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv;
}

/** Paint a shape's alpha as opaque white into a fresh context. */
function shapeAlpha(c: CanvasRenderingContext2D, shape: SurfaceShape, rc: SurfaceRC): void {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, rc.wPx, rc.hPx);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.fillStyle = '#fff'; c.strokeStyle = '#fff';
  c.lineJoin = 'round'; c.lineCap = 'round';
  c.save();
  shape(c, rc);
  c.restore();
}

/**
 * Take `tex` only from `shape`'s INTERIOR (eroded by `insetPx`), then stretch that sample
 * back out past the boundary. The shape's edge is then filled with the surface's own
 * interior tone and can never inherit whatever happens to sit beside it inside the source
 * image. Purely geometric — no pixel is ever classified; the shape decides what is "inside".
 */
function cleanFill(shape: SurfaceShape, rc: SurfaceRC, tex: CanvasImageSource,
  insetPx: number): CanvasImageSource | null {
  const S = scratch(1, rc.wPx, rc.hPx), A = scratch(2, rc.wPx, rc.hPx), D = scratch(3, rc.wPx, rc.hPx);
  if (!S || !A || !D) return null;
  const s = S.getContext('2d'), a = A.getContext('2d'), d = D.getContext('2d');
  if (!s || !a || !d) return null;

  shapeAlpha(s, shape, rc);                                  // pristine alpha

  a.setTransform(1, 0, 0, 1, 0, 0);
  a.clearRect(0, 0, rc.wPx, rc.hPx);
  a.globalCompositeOperation = 'source-over';
  a.drawImage(S, 0, 0);
  a.globalCompositeOperation = 'destination-in';             // erode: ∩ of shifted copies
  for (const [dx, dy] of ring(insetPx)) a.drawImage(S, dx, dy);
  a.globalCompositeOperation = 'source-in';                  // …sample the fill through it
  a.drawImage(tex, 0, 0, rc.wPx, rc.hPx);
  a.globalCompositeOperation = 'source-over';

  d.setTransform(1, 0, 0, 1, 0, 0);
  d.clearRect(0, 0, rc.wPx, rc.hPx);
  d.globalCompositeOperation = 'source-over';                // dilate the CLEAN sample back out
  for (const [dx, dy] of ring(insetPx + 2)) d.drawImage(A, dx, dy);
  d.drawImage(A, 0, 0);                                      // …crisp interior on top
  return D;
}

/** Cache a baked texture per (canvas size, angle). */
function cached(store: Map<string, HTMLCanvasElement>, rc: SurfaceRC, angle: number,
  bake: (c: CanvasRenderingContext2D, rc: SurfaceRC, angle: number) => void): HTMLCanvasElement | null {
  const key = rc.wPx + 'x' + rc.hPx + '@' + angle.toFixed(2);
  const hit = store.get(key);
  if (hit) return hit;
  const cv = makeCanvas(rc.wPx, rc.hPx); if (!cv) return null;
  const c = cv.getContext('2d'); if (!c) return null;
  bake(c, rc, angle);
  store.set(key, cv);
  return cv;
}

/** Shared paint: shape → alpha, texture → source-in, composite. */
function paintThrough(
  ctx: CanvasRenderingContext2D, shape: SurfaceShape, rc: SurfaceRC,
  tex: CanvasImageSource | null,
): void {
  if (!tex) return;
  const buf = scratch(0, rc.wPx, rc.hPx); if (!buf) return;
  const b = buf.getContext('2d'); if (!b) return;
  shapeAlpha(b, shape, rc);           // ← the map's geometry paints the region's alpha
  b.globalCompositeOperation = 'source-in';
  b.drawImage(tex, 0, 0, rc.wPx, rc.hPx);
  b.globalCompositeOperation = 'source-over';
  ctx.drawImage(buf, 0, 0);
}

// ----------------------------------------------------------------- surfaces ---

const _grassTex = new Map<string, HTMLCanvasElement>();
const _gravelTex = new Map<string, HTMLCanvasElement>();
const _asphaltTex = new Map<string, HTMLCanvasElement>();

const GRASS: SurfaceDef = {
  id: 'grass',
  physics: 'grass',
  markClass: 'grass',
  dust: {
    rgb: GRASS_DUST_RGB,
    scale: FX_CONFIG.grassDustScale, size: FX_CONFIG.grassDustSize, alpha: FX_CONFIG.grassDustAlpha,
  },
  texture(rc, opts) {
    const angle = opts?.angleDeg ?? GRASS_LOOK.angleDeg;
    return cached(_grassTex, rc, angle, (c, r, ang) => {
      const img = c.createImageData(r.wPx, r.hPx), d = img.data;
      const a = ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const period = Math.max(2, GRASS_LOOK.bandM * r.pxPerM) * 2;   // light band + dark band
      const [lr, lg, lb] = GRASS_LOOK.light, [dr, dg, db] = GRASS_LOOK.dark;
      const soft = Math.max(0.02, GRASS_LOOK.edgeSoft);
      for (let y = 0; y < r.hPx; y++) {
        for (let x = 0; x < r.wPx; x++) {
          // project onto the stripe axis, take the phase, and sharpen a sine into a
          // soft-edged square wave — flat bands, clean transitions, no gradient look
          const ph = ((x * ca + y * sa) / period) % 1;
          const m = clamp01(Math.sin(2 * Math.PI * ph) / soft * 0.5 + 0.5);
          const o = (y * r.wPx + x) * 4;
          d[o]     = dr + (lr - dr) * m;
          d[o + 1] = dg + (lg - dg) * m;
          d[o + 2] = db + (lb - db) * m;
          d[o + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    });
  },
  paint(ctx, shape, rc, opts) { paintThrough(ctx, shape, rc, this.texture(rc, opts)); },
};

const GRAVEL: SurfaceDef = {
  id: 'gravel',
  physics: 'gravel',
  markClass: 'gravel',
  dust: {
    rgb: GRAVEL_SPRAY_RGB,
    scale: FX_CONFIG.gravelSprayScale, size: FX_CONFIG.gravelSpraySize, alpha: FX_CONFIG.gravelSprayAlpha,
  },
  texture(rc, opts) {
    const angle = opts?.angleDeg ?? GRAVEL_LOOK.rakeAngleDeg;
    return cached(_gravelTex, rc, angle, (c, r, ang) => {
      const img = c.createImageData(r.wPx, r.hPx), d = img.data;
      const a = ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const period = Math.max(2, GRAVEL_LOOK.rakeSpacingM * r.pxPerM);
      const [br, bg, bb] = GRAVEL_LOOK.base, [gr, gg, gb] = GRAVEL_LOOK.groove;
      const cell = Math.max(1, GRAVEL_LOOK.speckleM * r.pxPerM);
      for (let y = 0; y < r.hPx; y++) {
        for (let x = 0; x < r.wPx; x++) {
          // groove profile: a raised-cosine, powered up so the light top dominates and
          // the brown groove stays a narrow, soft-shouldered shadow
          const u = (x * ca + y * sa) / period;
          const v = 0.5 - 0.5 * Math.cos(2 * Math.PI * (u - Math.floor(u)));
          const k = Math.pow(v, GRAVEL_LOOK.rakeSharp) * GRAVEL_LOOK.rakeStrength;
          let rr = br + (gr - br) * k, rg = bg + (gg - bg) * k, rb = bb + (gb - bb) * k;
          if (GRAVEL_LOOK.speckle > 0) {
            const n = (hash2((x / cell) | 0, (y / cell) | 0) * 2 - 1) * GRAVEL_LOOK.speckle * 255;
            rr += n; rg += n; rb += n;
          }
          const o = (y * r.wPx + x) * 4;
          d[o] = rr; d[o + 1] = rg; d[o + 2] = rb; d[o + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    });
  },
  paint(ctx, shape, rc, opts) { paintThrough(ctx, shape, rc, this.texture(rc, opts)); },
};

const ASPHALT: SurfaceDef = {
  id: 'asphalt',
  physics: 'asphalt',
  markClass: 'asphalt',
  dust: {
    rgb: DEFAULT_SMOKE_RGB,
    scale: 1, size: 1, alpha: 1,
  },
  texture(rc) {
    const img = asphaltFill();
    if (img) return img;              // the approved tarmac; paint scales it to the canvas
    // Until it arrives: the same light grey, so the first frames don't flash a wrong tone.
    return cached(_asphaltTex, rc, 0, (c, r) => {
      const g = c.createLinearGradient(0, 0, 0, r.hPx);
      g.addColorStop(0, ASPHALT_PRELOAD[0]); g.addColorStop(1, ASPHALT_PRELOAD[1]);
      c.fillStyle = g; c.fillRect(0, 0, r.wPx, r.hPx);
    });
  },
  paint(ctx, shape, rc, opts) {
    const tex = this.texture(rc, opts);
    if (!tex) return;
    // Only the image fill carries a baked-in edge; the preload tone is flat, nothing to clean.
    const fill = tex === _asphaltImg
      ? cleanFill(shape, rc, tex, Math.max(1, ASPHALT_FILL_INSET_M * rc.pxPerM))
      : tex;
    paintThrough(ctx, shape, rc, fill);
  },
};

export const SURFACES: Record<SurfaceId, SurfaceDef> = { grass: GRASS, gravel: GRAVEL, asphalt: ASPHALT };
export function getSurface(id: SurfaceId): SurfaceDef { return SURFACES[id]; }
