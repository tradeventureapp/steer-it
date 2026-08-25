// =============================================================================
//  Blitz RS — top-down PNG sprite (the designer's rendered car), baked once,
//  then RECOLOURED into the 8 shared body colours (the same palette the Stee-Rex
//  uses; picked on the phone).
//
//  VISUAL ONLY. The Blitz's physics is the golden PHYS4 reference and is NOT
//  touched by this file — swapping the vector body for this bitmap, and tinting
//  the body panels, changes only what's drawn. Same loader as the Fury sprite.
//
//  The art is a top-down PNG in `public/BlitzRS.png` (nose UP, WHITE body + our
//  SUNSET-gradient stripe, on a black field — NO third-party livery). We load it
//  ONCE, FLOOD-FILL the connected near-black background to transparent (so it works
//  as a sprite over any surface — the car's own dark parts, interior to the
//  silhouette, are kept), and measure the opaque bbox for the pivot + scale. That
//  stripped base is then TINTED per colour into 8 cached bitmaps.
//
//  RECOLOUR = a SYNTHESISED METALLIC SHEEN (matching Stee-Rex / Scrappy). `isBody` (light +
//  desaturated) picks the WHITE BODY panels; the SUNSET STRIPE (saturated), the tinted GLASS +
//  WHEELS (dark) and the RED LIGHTS (saturated) fail it, so they render identically across every
//  colour. ⚠️ NOT a flat multiply: this render's body is a nearly UNIFORM bright white (measured
//  p25–p75 ≈ 245–248 — no shading of its own), so `tint × brightness` came out flat/washed-out.
//  Instead body pixels are repainted from the skin's 5-tone metallic RAMP (the SAME tones Stee-Rex
//  authors) via a width-wise cylindrical SHEEN (dark edges → bright peak streak → lit centre, per
//  ROW so it hugs the silhouette; fine dark detail preserved by a local-brightness modulation) —
//  giving the same gloss as the other cars. The source PNG is UNCHANGED (recolour is code-only, so
//  the hashed JS bundle carries the new look — no image cache-bust needed). Length-anchored to the
//  Blitz RS's real drawn length. Physics is the golden PHYS4 and is NOT touched (0.0e+0 intact).
// =============================================================================

// The 8 shared body colours — SAME order + hexes as STEEREX_SKIN_COLORS (the phone
// picker) so all three cars share the identical palette. `blitzSkinForColor` (vehicles.ts)
// maps a picked swatch → its skin here; an unknown colour falls back to 'white' (the
// iconic near-white Blitz).
export type BlitzSkin = 'silver' | 'black' | 'blue' | 'red' | 'purple' | 'white' | 'orange' | 'yellow';

// Per-skin 5-tone METALLIC RAMP [shadow, dark, mid, light, peak] — the SAME tones Stee-Rex authors
// (steerex-sprite SKIN_DEFS / metallicSkin), shared with Scrappy. `mid` = the STEEREX_SKIN_COLORS hue.
const SKIN_RAMP: Record<BlitzSkin, number[][]> = {
  silver: [[91,98,107],[127,135,144],[174,182,191],[199,204,210],[238,241,244]],
  black:  [[36,39,44],[52,56,63],[74,79,87],[86,91,99],[130,136,146]],
  blue:   [[15,38,71],[28,68,135],[47,108,203],[110,163,234],[216,232,255]],
  red:    [[69,17,26],[138,28,40],[204,43,56],[231,98,106],[255,215,213]],
  purple: [[42,20,80],[79,42,144],[124,75,198],[169,126,230],[236,220,255]],
  white:  [[182,179,173],[211,208,201],[233,230,224],[247,245,241],[255,255,255]],
  orange: [[77,31,6],[156,64,15],[224,106,28],[255,157,78],[255,227,194]],
  yellow: [[95,68,6],[171,125,10],[234,182,28],[255,219,86],[255,246,204]],
};

const SRC = '/BlitzRS.png';              // served from public/ at the site root (UNCHANGED image)
const BG_LUMA = 28;                      // ≤ this luma + connected to a corner = background → transparent

// The stripped base (transparent background), decoded ONCE. Each skin bakes from this. `rMin`/`rMax`
// = per-row body left/right extents (for the width-wise sheen); `bMid` = median body brightness.
let _base: { data: Uint8ClampedArray; W: number; H: number;
  rMin: Int32Array; rMax: Int32Array; bMid: number } | null = null;
let _baseLoading = false;

const _cache = new Map<BlitzSkin, HTMLCanvasElement>();
let _opaque: { lenPx: number; widPx: number; cxPx: number; cyPx: number } | null = null;

/** The measured opaque bbox of the Blitz bitmap (null until the base decodes). */
export function blitzOpaque() { return _opaque; }

// Flood-fill the connected near-black background (from the 4 corners) to transparent, in place.
function stripBackground(d: Uint8ClampedArray, W: number, H: number) {
  const luma = (i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const seen = new Uint8Array(W * H);
  const st: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = y * W + x;
    if (seen[p] || luma(p * 4) > BG_LUMA) return;
    seen[p] = 1; d[p * 4 + 3] = 0; st.push(p);
  };
  push(0, 0); push(W - 1, 0); push(0, H - 1); push(W - 1, H - 1);
  while (st.length) {
    const p = st.pop()!; const x = p % W, y = (p / W) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
}

// Opaque bbox measured directly off the stripped RGBA (alpha channel), no canvas needed.
function measureOpaqueData(d: Uint8ClampedArray, W: number, H: number) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return;
  _opaque = { lenPx: y1 - y0 + 1, widPx: x1 - x0 + 1, cxPx: (x0 + x1 + 1) / 2, cyPx: (y0 + y1 + 1) / 2 };
}

// WHITE-BODY MASK: a light, desaturated (near-neutral) pixel = a body panel. The saturated
// sunset stripe + red lights (max-min large) and the dark glass/wheels (max low) all fail it.
function isBody(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx > 150 && (mx - mn) < 40 && mn > 60;
}

// Kick the one-time base decode (background-strip + opaque measure). Skins bake off `_base`.
function kickBase(): void {
  if (_base || _baseLoading) return;
  _baseLoading = true;
  const img = new Image();
  img.src = SRC;
  const bake = () => {
    try {
      const W = img.naturalWidth, H = img.naturalHeight;
      if (!W || !H) { _baseLoading = false; return; }
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d', { willReadFrequently: true });
      if (!c) { _baseLoading = false; return; }
      c.drawImage(img, 0, 0);
      const id = c.getImageData(0, 0, W, H);
      stripBackground(id.data, W, H);
      const { rMin, rMax, bMid } = analyseBody(id.data, W, H);
      _base = { data: id.data, W, H, rMin, rMax, bMid };
      measureOpaqueData(id.data, W, H);
    } catch {
      _baseLoading = false;   // decode/read threw (memory / tainted) → allow a later retry
    }
  };
  const fail = () => { _baseLoading = false; };
  if (typeof img.decode === 'function') img.decode().then(bake).catch(fail);
  else { img.onload = bake; img.onerror = fail; }
}

// One-time body analysis for the sheen: per-row body left/right extent (rMin/rMax) + the median body
// brightness (bMid). Run once on the stripped base; every skin bakes off these.
function analyseBody(d: Uint8ClampedArray, W: number, H: number):
  { rMin: Int32Array; rMax: Int32Array; bMid: number } {
  const rMin = new Int32Array(H).fill(1 << 30);
  const rMax = new Int32Array(H).fill(-1);
  const bri: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] <= 8) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (!isBody(r, g, b)) continue;
      if (x < rMin[y]) rMin[y] = x;
      if (x > rMax[y]) rMax[y] = x;
      bri.push(Math.max(r, g, b));
    }
  }
  bri.sort((a, b) => a - b);
  const bMid = bri.length ? bri[bri.length >> 1] : 247;
  return { rMin, rMax, bMid };
}

// SHEEN tone at `c` = |x − rowCentre| / rowHalfWidth (0 centre → 1 edge). Reproduces Stee-Rex's body
// gradient: lit centre → PEAK highlight streak → mid → dark edge. `ramp` = [shadow,dark,mid,light,peak].
function sheen(ramp: number[][], c: number): [number, number, number] {
  const lerp = (a: number[], b: number[], f: number): [number, number, number] =>
    [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  const [, dk, md, lt, pk] = ramp;
  if (c < 0.42) return lerp(lt, pk, c / 0.42);
  if (c < 0.82) return lerp(pk, md, (c - 0.42) / 0.40);
  return lerp(md, dk, (c - 0.82) / 0.18);
}

// Synthesize a skin bitmap: repaint the body panels with the skin's metallic sheen. The render's
// body is a near-uniform white, so the sheen (a width-wise dark→peak→dark ramp, per row so it hugs
// the silhouette) provides the highlights/shading; the render's fine dark detail (panel/door lines)
// is preserved by modulating with local brightness ÷ bMid. Non-body pixels (sunset stripe, glass,
// wheels, red lights) keep their own colour.
function bakeSkin(skin: BlitzSkin): HTMLCanvasElement | null {
  if (!_base) return null;
  const { data: src, W, H, rMin, rMax, bMid } = _base;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  if (!c) return null;
  const id = c.createImageData(W, H);
  const dst = id.data;
  const ramp = SKIN_RAMP[skin];
  for (let y = 0; y < H; y++) {
    const lo = rMin[y], hi = rMax[y];
    const cen = (lo + hi) / 2, half = Math.max(1, (hi - lo) / 2);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = src[i + 3], r = src[i], g = src[i + 1], b = src[i + 2];
      dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = a;
      if (a <= 8 || !isBody(r, g, b)) continue;
      const o = sheen(ramp, Math.min(1, Math.abs(x - cen) / half));
      const m = Math.max(0.62, Math.min(1.12, Math.max(r, g, b) / bMid));
      dst[i] = Math.min(255, o[0] * m);
      dst[i + 1] = Math.min(255, o[1] * m);
      dst[i + 2] = Math.min(255, o[2] * m);
    }
  }
  c.putImageData(id, 0, 0);
  return cv;
}

/**
 * The cached Blitz bitmap for a colour skin (transparent background, nose UP, opaque centre =
 * the rotation pivot). Null until the base PNG has decoded — kicks the one-time decode on the
 * first call, then bakes + caches each skin on demand.
 */
export function blitzSprite(skin: BlitzSkin = 'white'): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const hit = _cache.get(skin);
  if (hit) return hit;
  if (!_base) { kickBase(); return null; }
  const cv = bakeSkin(skin);
  if (cv) _cache.set(skin, cv);
  return cv;
}

/** Warm the base decode so a Blitz car is never invisible on first spawn. */
export function preloadBlitz(): void { blitzSprite('white'); }

// ---- MIPMAP DOWNSCALE CACHE (crisp small render) — same approach as Stee-Rex/Fury ----
export interface BlitzMip { cv: HTMLCanvasElement; widPx: number; cxPx: number; cyPx: number; }
const _mips = new Map<string, BlitzMip>();
function downscaleStep(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d')!;
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, w, h);
  return cv;
}
/** A cached copy of the bitmap pre-scaled so its opaque length ≈ `targetLenPx`. */
export function blitzScaled(skin: BlitzSkin, targetLenPx: number): BlitzMip | null {
  const src = _cache.get(skin);
  if (!src || !_opaque) return null;
  const srcLen = _opaque.lenPx;
  if (targetLenPx >= srcLen * 0.9) {
    return { cv: src, widPx: _opaque.widPx, cxPx: _opaque.cxPx, cyPx: _opaque.cyPx };
  }
  const bucket = Math.max(48, Math.pow(2, Math.round(Math.log2(Math.max(1, targetLenPx)))));
  const key = skin + ':' + bucket;
  const hit = _mips.get(key);
  if (hit) return hit;
  const f = Math.min(1, bucket / srcLen);
  const finalW = Math.max(1, Math.round(src.width * f));
  const finalH = Math.max(1, Math.round(src.height * f));
  let cur = src;
  while (cur.width > finalW * 2) {
    cur = downscaleStep(cur, Math.max(finalW, Math.round(cur.width / 2)),
                             Math.max(finalH, Math.round(cur.height / 2)));
  }
  const out = downscaleStep(cur, finalW, finalH);
  const mip: BlitzMip = { cv: out, widPx: _opaque.widPx * f, cxPx: _opaque.cxPx * f, cyPx: _opaque.cyPx * f };
  _mips.set(key, mip);
  return mip;
}
