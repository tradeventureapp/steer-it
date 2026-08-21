// =============================================================================
//  Scrappy GT — top-down PNG sprite (the designer's rendered car), baked once,
//  then RECOLOURED into the 8 shared body colours (the same palette Stee-Rex /
//  Blitz / Fury use; picked on the phone).
//
//  VISUAL ONLY. The physics is the arcade per-wheel model (SCRAPPY_ARCADE in
//  vehicles.ts); this file only builds + caches the look, exactly like the Blitz
//  sprite it is modelled on.
//
//  The art is a top-down PNG in `public/ScrappyGT.png` (nose UP, WHITE body, on a
//  near-black field — NO third-party livery). We load it ONCE, FLOOD-FILL the
//  connected near-black background to transparent (so it works as a sprite over any
//  surface — the car's own dark parts, interior to the silhouette, are kept), and
//  measure the opaque bbox for the pivot + scale. That stripped base is then TINTED
//  per colour into 8 cached bitmaps.
//
//  RECOLOUR = a masked multiply (the Blitz approach — the render IS a white body, so
//  a colour-only rule works; no hand-authored mask needed). ONLY light + desaturated
//  body panels are multiplied toward the target hue (3D shading preserved — a body
//  pixel keeps its brightness, just gains the colour). The dark glass / wheels /
//  tyres and any saturated accents fail the body test, so they render identically
//  across every colour. WIDTH-anchored in the draw path (drawScrappy in desktop.ts).
// =============================================================================

// The 8 shared body colours — SAME order + hexes as STEEREX_SKIN_COLORS (the phone
// picker), so all four cars share the identical palette. `scrappySkinForColor`
// (vehicles.ts) maps a picked swatch → its skin here; an unknown colour → 'white'.
export type ScrappySkin = 'silver' | 'black' | 'blue' | 'red' | 'purple' | 'white' | 'orange' | 'yellow';

// Target body tint per skin (r,g,b) — the STEEREX_SKIN_COLORS hexes. `white` is a warm
// near-white ⇒ its multiply is ~identity (the body stays essentially the shipped white).
const SKIN_TINT: Record<ScrappySkin, [number, number, number]> = {
  silver: [201, 206, 214],   // #c9ced6
  black:  [42, 45, 52],      // #2a2d34
  blue:   [47, 108, 203],    // #2f6ccb
  red:    [204, 43, 56],     // #cc2b38
  purple: [124, 75, 198],    // #7c4bc6
  white:  [242, 240, 236],   // #f2f0ec
  orange: [224, 106, 28],    // #e06a1c
  yellow: [234, 182, 28],    // #eab61c
};

const SRC = '/ScrappyGT.png';            // served from public/ at the site root
const BG_LUMA = 28;                      // ≤ this luma + connected to a corner = background → transparent

// The stripped base (transparent background), decoded ONCE. Each skin is tinted from this.
let _base: { data: Uint8ClampedArray; W: number; H: number } | null = null;
let _baseLoading = false;

const _cache = new Map<ScrappySkin, HTMLCanvasElement>();
let _opaque: { lenPx: number; widPx: number; cxPx: number; cyPx: number } | null = null;

/** The measured opaque bbox of the Scrappy bitmap (null until the base decodes). */
export function scrappyOpaque() { return _opaque; }

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

// WHITE-BODY MASK: a light, desaturated (near-neutral) pixel = a body panel. Saturated
// accents (max-min large) and the dark glass/wheels (max low) all fail it.
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
      _base = { data: id.data, W, H };
      measureOpaqueData(id.data, W, H);
    } catch {
      _baseLoading = false;   // decode/read threw (memory / tainted) → allow a later retry
    }
  };
  const fail = () => { _baseLoading = false; };
  if (typeof img.decode === 'function') img.decode().then(bake).catch(fail);
  else { img.onload = bake; img.onerror = fail; }
}

// Synthesize a skin bitmap: copy the stripped base, multiply the body panels toward the tint.
function bakeSkin(skin: ScrappySkin): HTMLCanvasElement | null {
  if (!_base) return null;
  const { data: src, W, H } = _base;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  if (!c) return null;
  const id = c.createImageData(W, H);
  const dst = id.data;
  const [tr, tg, tb] = SKIN_TINT[skin];
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    const r = src[i], g = src[i + 1], b = src[i + 2];
    dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = a;
    if (a <= 8) continue;
    if (isBody(r, g, b)) {
      const br = Math.max(r, g, b) / 255;      // body brightness → preserves the 3D shading
      dst[i] = Math.round(tr * br);
      dst[i + 1] = Math.round(tg * br);
      dst[i + 2] = Math.round(tb * br);
    }
  }
  c.putImageData(id, 0, 0);
  return cv;
}

/**
 * The cached Scrappy bitmap for a colour skin (transparent background, nose UP, opaque centre =
 * the rotation pivot). Null until the base PNG has decoded — kicks the one-time decode on the
 * first call, then bakes + caches each skin on demand.
 */
export function scrappySprite(skin: ScrappySkin = 'white'): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const hit = _cache.get(skin);
  if (hit) return hit;
  if (!_base) { kickBase(); return null; }
  const cv = bakeSkin(skin);
  if (cv) _cache.set(skin, cv);
  return cv;
}

/** Warm the base decode so a Scrappy car is never invisible on first spawn. */
export function preloadScrappy(): void { scrappySprite('white'); }

// ---- MIPMAP DOWNSCALE CACHE (crisp small render) — same approach as Stee-Rex/Fury/Blitz ----
export interface ScrappyMip { cv: HTMLCanvasElement; widPx: number; cxPx: number; cyPx: number; }
const _mips = new Map<string, ScrappyMip>();
function downscaleStep(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d')!;
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, w, h);
  return cv;
}
/** A cached copy of the bitmap pre-scaled so its opaque length ≈ `targetLenPx`. */
export function scrappyScaled(skin: ScrappySkin, targetLenPx: number): ScrappyMip | null {
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
  const mip: ScrappyMip = { cv: out, widPx: _opaque.widPx * f, cxPx: _opaque.cxPx * f, cyPx: _opaque.cyPx * f };
  _mips.set(key, mip);
  return mip;
}
