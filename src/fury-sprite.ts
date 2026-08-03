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
//  Drop a logo-cleaned PNG in at the same path and it just works (a transparent OR
//  black background both bake correctly).
// =============================================================================

export type FurySkin = 'lombard';

const SRC = '/Fury.png';                 // served from public/ at the site root
// BACKGROUND = near PURE BLACK (every channel ≤ this), NOT just low luma. The Fury art has
// dark-but-coloured parts that touch the silhouette edge — the navy chevrons (high BLUE channel)
// and the near-black GREY mirrors (rgb ≈ 17) — which a plain luma≤28 flood LEAKS into and erases,
// bleeding the surface through the rear windows + mirrors. A per-channel black test keeps them:
// the navy's blue channel and the mirror's 17 both exceed 14, so only the true black field (0,0,0)
// is removed. (Kept < the mirror's 17 so the mirrors survive.)
const BG_MAX = 14;

const _cache = new Map<FurySkin, HTMLCanvasElement>();
const _loading = new Set<FurySkin>();
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
 * The cached Fury bitmap (transparent background, nose UP, its opaque centre = the rotation
 * pivot). Null until the PNG has decoded + baked — kicks the async bake on the first call.
 */
export function furySprite(skin: FurySkin = 'lombard'): HTMLCanvasElement | null {
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

/** Warm the sprite so a Fury car is never invisible on first spawn. */
export function preloadFury(): void { furySprite('lombard'); }

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
