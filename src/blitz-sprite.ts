// =============================================================================
//  Blitz RS — top-down PNG sprite (the designer's rendered car), baked once.
//
//  VISUAL ONLY. The Blitz's physics is the golden PHYS4 reference and is NOT
//  touched by this file — swapping the vector body for this bitmap changes only
//  what's drawn. Same loader as the Fury/Stee-Rex sprites.
//
//  The art is a top-down PNG in `public/BlitzRS.png` (nose UP, white body + our
//  SUNSET-gradient stripe, on a black field — NO third-party livery). We load it,
//  FLOOD-FILL the connected near-black background to transparent (so it works as a
//  sprite over any surface — the car's own dark parts, interior to the silhouette,
//  are kept), then measure the opaque bbox for the pivot + scale. The same blit
//  path draws it, LENGTH-anchored to the Blitz RS's real drawn length so it drops
//  in at exactly the vector body's size. A transparent OR black background both bake.
// =============================================================================

export type BlitzSkin = 'stripe';

const SRC = '/BlitzRS.png';              // served from public/ at the site root
const BG_LUMA = 28;                      // ≤ this luma + connected to a corner = background → transparent

const _cache = new Map<BlitzSkin, HTMLCanvasElement>();
const _loading = new Set<BlitzSkin>();
let _opaque: { lenPx: number; widPx: number; cxPx: number; cyPx: number } | null = null;

/** The measured opaque bbox of the Blitz bitmap (null until it bakes). */
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

function measureOpaque(cv: HTMLCanvasElement) {
  const c = cv.getContext('2d');
  if (!c) return;
  const d = c.getImageData(0, 0, cv.width, cv.height).data;
  let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      if (d[(y * cv.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return;
  _opaque = { lenPx: y1 - y0 + 1, widPx: x1 - x0 + 1, cxPx: (x0 + x1 + 1) / 2, cyPx: (y0 + y1 + 1) / 2 };
}

/**
 * The cached Blitz bitmap (transparent background, nose UP, its opaque centre = the rotation
 * pivot). Null until the PNG has decoded + baked — kicks the async bake on the first call.
 */
export function blitzSprite(skin: BlitzSkin = 'stripe'): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const hit = _cache.get(skin);
  if (hit) return hit;
  if (!_loading.has(skin)) {
    _loading.add(skin);
    const img = new Image();
    img.src = SRC;
    const bake = () => {
      try {
        const W = img.naturalWidth, H = img.naturalHeight;
        if (!W || !H) { _loading.delete(skin); return; }
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const c = cv.getContext('2d', { willReadFrequently: true });
        if (!c) { _loading.delete(skin); return; }
        c.drawImage(img, 0, 0);
        const id = c.getImageData(0, 0, W, H);
        stripBackground(id.data, W, H);
        c.putImageData(id, 0, 0);
        _cache.set(skin, cv);
        if (!_opaque) measureOpaque(cv);
      } catch {
        _loading.delete(skin);   // bake threw (memory / tainted) → allow a later retry
      }
    };
    const fail = () => { _loading.delete(skin); };
    if (typeof img.decode === 'function') img.decode().then(bake).catch(fail);
    else { img.onload = bake; img.onerror = fail; }
  }
  return null;
}

/** Warm the sprite so a Blitz car is never invisible on first spawn. */
export function preloadBlitz(): void { blitzSprite('stripe'); }

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
