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
export type FurySkin = 'silver' | 'black' | 'blue' | 'red' | 'purple' | 'white' | 'orange' | 'yellow';

const SKIN_TINT: Record<FurySkin, [number, number, number]> = {
  silver: [201, 206, 214],   // #c9ced6
  black:  [42, 45, 52],      // #2a2d34
  blue:   [47, 108, 203],    // #2f6ccb
  red:    [204, 43, 56],     // #cc2b38
  purple: [124, 75, 198],    // #7c4bc6
  white:  [242, 240, 236],   // #f2f0ec
  orange: [224, 106, 28],    // #e06a1c
  yellow: [234, 182, 28],    // #eab61c
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
// The stripped base + the body mask, decoded ONCE; every skin is baked from these.
let _base: { data: Uint8ClampedArray; W: number; H: number } | null = null;
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
    _base = base;
    measureOpaqueData(base.data, base.W, base.H);
  }).catch(() => { _baseLoading = false; });   // transient → allow a later retry
}

// Copy the stripped base and multiply the MASKED pixels toward the tint. Multiplying by the
// pixel's own brightness is what preserves the render's shading instead of flat-filling it.
function bakeSkin(skin: FurySkin): HTMLCanvasElement | null {
  if (!_base) return null;
  const { data: src, W, H } = _base;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  if (!c) return null;
  const id = c.createImageData(W, H);
  const dst = id.data;
  const [tr, tg, tb] = SKIN_TINT[skin];
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const a = src[i + 3];
    const r = src[i], g = src[i + 1], b = src[i + 2];
    dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = a;
    if (a <= 8 || !_mask || !_mask[p]) continue;
    const br = Math.max(r, g, b) / 255;
    dst[i] = Math.round(tr * br);
    dst[i + 1] = Math.round(tg * br);
    dst[i + 2] = Math.round(tb * br);
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
