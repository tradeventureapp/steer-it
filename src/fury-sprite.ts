// =============================================================================
//  Fury 200 EVO — top-down PNG sprite (the designer's rendered car), baked once.
//
//  VISUAL ONLY, and DEV-GATED: the Fury is only ever selectable by the dev host
//  (see desktop.ts `isDev`), so a normal player never sees or loads it. Like
//  Stee-Rex it has no physics tune of its own — in game it borrows the shared PHYS4.
//
//  The art is a top-down PNG in `public/Fury.png` (nose UP, on a black field). We
//  load it, FLOOD-FILL the connected near-black background to transparent (so it
//  works as a sprite over any surface — the car's own dark parts, interior to the
//  silhouette, are kept), then measure the opaque bbox for the pivot + scale. The
//  same blit path as Stee-Rex draws it, width-anchored to the Fury's real widthM.
//
//  ---- THE 8 COLOURS: WHY A MASK ASSET AND NOT A COLOUR RULE --------------------
//  Blitz recolours itself with a pure arithmetic test (light + desaturated = body).
//  That rule CANNOT work here: Fury carries branding, and its glass (rgb ~168,184,204,
//  saturation 36) sits close enough to white bodywork to be swept up, while its white
//  decals are the EXACT same RGB as white bodywork — no colour-only rule can separate
//  those two, and a connected-component rule fails as well because the bodywork itself
//  splits into several large regions.
//
//  So the body region is stated explicitly by `public/Fury-mask.png` (WHITE = recolour,
//  BLACK = leave). It is pixel-aligned with the sprite, greyscale, ~13 KB. That also
//  makes the 8 colours geometrically IDENTICAL by construction — one source bitmap, so
//  no shape/shadow/perspective drift between colours (and the hitbox never depends on
//  the art anyway: it comes from FURY_DIMS).
// =============================================================================

// The 8 shared body colours — SAME order + hexes as STEEREX_SKIN_COLORS / BlitzSkin, so all
// three cars answer the one phone picker. `blitzSkinForColor`'s sibling lives in vehicles.ts.
import { metallicRampRGB } from './metallic';
// The 8 named palette skins, PLUS any arbitrary hex (a Steerball team shade) baked from its metallic
// ramp — so team colours recolour the masked body exactly like the named palette does.
type FurySkinName = 'silver' | 'black' | 'blue' | 'red' | 'purple' | 'white' | 'orange' | 'yellow';
export type FurySkin = FurySkinName | (string & {});

// Per-skin 5-tone METALLIC RAMP [shadow, dark, mid, light, peak] — the SAME tones Stee-Rex authors,
// shared with Blitz/Scrappy. Fury's body render is mostly bright too, so a flat multiply washed it
// out; instead the MASKED body is repainted with a synthesised sheen from these (see bakeSkin).
const SKIN_RAMP: Record<FurySkinName, number[][]> = {
  silver: [[91,98,107],[127,135,144],[174,182,191],[199,204,210],[238,241,244]],
  black:  [[36,39,44],[52,56,63],[74,79,87],[86,91,99],[130,136,146]],
  blue:   [[15,38,71],[28,68,135],[47,108,203],[110,163,234],[216,232,255]],
  red:    [[69,17,26],[138,28,40],[204,43,56],[231,98,106],[255,215,213]],
  purple: [[42,20,80],[79,42,144],[124,75,198],[169,126,230],[236,220,255]],
  white:  [[182,179,173],[211,208,201],[233,230,224],[247,245,241],[255,255,255]],
  orange: [[77,31,6],[156,64,15],[224,106,28],[255,157,78],[255,227,194]],
  yellow: [[95,68,6],[171,125,10],[234,182,28],[255,219,86],[255,246,204]],
};

const SRC = '/Fury.png';                 // served from public/ at the site root
// BACKGROUND = near PURE BLACK (every channel ≤ this), NOT just low luma. The Fury art has
// dark-but-coloured parts that touch the silhouette edge — the navy chevrons (high BLUE channel)
// and the near-black GREY mirrors (rgb ≈ 17) — which a plain luma≤28 flood LEAKS into and erases,
// bleeding the surface through the rear windows + mirrors. A per-channel black test keeps them:
// the navy's blue channel and the mirror's 17 both exceed 14, so only the true black field (0,0,0)
// is removed. (Kept < the mirror's 17 so the mirrors survive.)
const BG_MAX = 14;

const MASK_SRC = '/Fury-mask.png';       // WHITE = recolour this pixel, BLACK = keep as-is

const _cache = new Map<FurySkin, HTMLCanvasElement>();
// The stripped base + the body mask, decoded ONCE; every skin is baked from these. `rMin`/`rMax` =
// per-row MASKED-body left/right extents (for the width-wise sheen); `bMid` = median masked-body
// brightness. (Empty/247 when the mask is refused → bakeSkin then leaves the original livery.)
let _base: { data: Uint8ClampedArray; W: number; H: number;
  rMin: Int32Array; rMax: Int32Array; bMid: number } | null = null;
let _mask: Uint8Array | null = null;
let _baseLoading = false;
let _opaque: { lenPx: number; widPx: number; cxPx: number; cyPx: number } | null = null;

/** The measured opaque bbox of the Fury bitmap (null until it bakes). */
export function furyOpaque() { return _opaque; }

// Flood-fill the connected PURE-BLACK background (from the 4 corners) to transparent, in place.
function stripBackground(d: Uint8ClampedArray, W: number, H: number) {
  const isBg = (i: number) => d[i] <= BG_MAX && d[i + 1] <= BG_MAX && d[i + 2] <= BG_MAX;
  const seen = new Uint8Array(W * H);
  const st: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = y * W + x;
    if (seen[p] || !isBg(p * 4)) return;
    seen[p] = 1; d[p * 4 + 3] = 0; st.push(p);
  };
  push(0, 0); push(W - 1, 0); push(0, H - 1); push(W - 1, H - 1);
  while (st.length) {
    const p = st.pop()!; const x = p % W, y = (p / W) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
}

// Opaque bbox measured straight off the stripped RGBA — no canvas round-trip needed.
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

// Decode a PNG to RGBA once. Used for BOTH the sprite and the mask.
function decodeToData(src: string): Promise<{ data: Uint8ClampedArray; W: number; H: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = src;
    const read = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      if (!W || !H) { reject(new Error('empty image')); return; }
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d', { willReadFrequently: true });
      if (!c) { reject(new Error('no 2d context')); return; }
      c.drawImage(img, 0, 0);
      resolve({ data: c.getImageData(0, 0, W, H).data, W, H });
    };
    const fail = () => reject(new Error('decode failed'));
    if (typeof img.decode === 'function') img.decode().then(read).catch(fail);
    else { img.onload = read; img.onerror = fail; }
  });
}

// One-time decode of the sprite + mask. Skins bake off these.
function kickBase(): void {
  if (_base || _baseLoading) return;
  _baseLoading = true;
  Promise.all([decodeToData(SRC), decodeToData(MASK_SRC)]).then(([base, mask]) => {
    stripBackground(base.data, base.W, base.H);
    // The mask MUST be pixel-aligned with the sprite. If it isn't (a re-export at the
    // wrong size), recolouring would smear across the branding — so refuse the mask and
    // ship the car in its original livery rather than a corrupted one.
    if (mask.W !== base.W || mask.H !== base.H) {
      console.warn(`[fury] mask ${mask.W}x${mask.H} != sprite ${base.W}x${base.H} — recolour disabled`);
    } else {
      const m = new Uint8Array(base.W * base.H);
      for (let p = 0; p < m.length; p++) m[p] = mask.data[p * 4] > 128 ? 1 : 0;   // threshold at mid-grey
      _mask = m;
    }
    const { rMin, rMax, bMid } = analyseBody(base.data, base.W, base.H, _mask);
    _base = { data: base.data, W: base.W, H: base.H, rMin, rMax, bMid };
    measureOpaqueData(base.data, base.W, base.H);
  }).catch(() => { _baseLoading = false; });   // transient → allow a later retry
}

// One-time MASKED-body analysis for the sheen: per-row body left/right extent (rMin/rMax) + the
// median masked-body brightness (bMid). `mask` null (refused) ⇒ no body ⇒ empty extents / bMid 247.
function analyseBody(d: Uint8ClampedArray, W: number, H: number, mask: Uint8Array | null):
  { rMin: Int32Array; rMax: Int32Array; bMid: number } {
  const rMin = new Int32Array(H).fill(1 << 30);
  const rMax = new Int32Array(H).fill(-1);
  const bri: number[] = [];
  if (mask) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x, i = p * 4;
        if (d[i + 3] <= 8 || !mask[p]) continue;
        if (x < rMin[y]) rMin[y] = x;
        if (x > rMax[y]) rMax[y] = x;
        bri.push(Math.max(d[i], d[i + 1], d[i + 2]));
      }
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

// Repaint the MASKED body pixels with the skin's metallic sheen (matching Stee-Rex / Scrappy / Blitz).
// The body render is mostly bright, so a flat multiply washed out; the sheen (a width-wise
// dark→peak→dark ramp, per row so it hugs the silhouette) gives the highlights/shading, with the
// render's fine dark detail preserved by a local-brightness ÷ bMid modulation. Everything the mask
// EXCLUDES — glass, chevrons, the logo tile, taillights, vents, the blue wordmarks — is untouched;
// a refused mask (`_mask` null) means no body pixels, so the original livery ships unchanged.
function bakeSkin(skin: FurySkin): HTMLCanvasElement | null {
  if (!_base) return null;
  const { data: src, W, H, rMin, rMax, bMid } = _base;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  if (!c) return null;
  const id = c.createImageData(W, H);
  const dst = id.data;
  // Named skin → its authored ramp; any other id → a hex (team shade), ramp synthesised.
  const ramp = (SKIN_RAMP as Record<string, number[][] | undefined>)[skin] ?? metallicRampRGB(skin);
  for (let y = 0; y < H; y++) {
    const lo = rMin[y], hi = rMax[y];
    const cen = (lo + hi) / 2, half = Math.max(1, (hi - lo) / 2);
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      const a = src[i + 3], r = src[i], g = src[i + 1], b = src[i + 2];
      dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = a;
      if (a <= 8 || !_mask || !_mask[p]) continue;
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
 * The cached Fury bitmap for a colour skin (transparent background, nose UP, opaque centre =
 * the rotation pivot). Null until the sprite + mask have decoded — kicks that once, then
 * bakes and caches each skin on demand.
 */
export function furySprite(skin: FurySkin = 'white'): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const hit = _cache.get(skin);
  if (hit) return hit;
  if (!_base) { kickBase(); return null; }
  const cv = bakeSkin(skin);
  if (cv) _cache.set(skin, cv);
  return cv;
}

/** Warm the decode so a Fury car is never invisible on first spawn. */
export function preloadFury(): void { furySprite('white'); }

// ---- MIPMAP DOWNSCALE CACHE (crisp small render) — same approach as Stee-Rex ----
export interface FuryMip { cv: HTMLCanvasElement; widPx: number; cxPx: number; cyPx: number; }
const _mips = new Map<string, FuryMip>();
function downscaleStep(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d')!;
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, w, h);
  return cv;
}
/** A cached copy of the bitmap pre-scaled so its opaque length ≈ `targetLenPx`. */
export function furyScaled(skin: FurySkin, targetLenPx: number): FuryMip | null {
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
  const mip: FuryMip = { cv: out, widPx: _opaque.widPx * f, cxPx: _opaque.cxPx * f, cyPx: _opaque.cyPx * f };
  _mips.set(key, mip);
  return mip;
}
