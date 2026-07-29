// =============================================================================
//  Fury 200 EVO — top-down SVG sprite, rasterised once. (WIP test vehicle.)
//
//  VISUAL ONLY, and DEV-GATED: the Fury is only ever selectable by the dev host
//  (see desktop.ts `isDev`), so a normal player never sees or loads it. Like
//  Stee-Rex it has no physics tune yet — in game it borrows the shared PHYS4.
//
//  A compact Group-B rallycross silhouette (waisted body, big square arches, a
//  forward glasshouse, roof intercooler scoop, louvred engine deck, tall biplane
//  rear wing) in a white + blue diagonal-stripe rally livery, drawn in the house
//  vector style. All marks ORIGINAL — no real make/model/sponsor names anywhere
//  (public identity is "Fury 200 EVO" only, like "Blitz RS" / "Stee-Rex").
//
//  Authored in a viewBox SYMMETRIC about the geometry centre (330,472) so the
//  bitmap's centre is the car's rotation pivot; nose points UP. The rough visual
//  is intentional (a test placeholder — to be redone later).
// =============================================================================

export type FurySkin = 'lombard';

export const FURY_LEN_SVG = 532;                // nose→tail (matches the opaque length target)
export const FURY_RASTER = 3;                   // bitmap px per SVG unit (crisp when scaled down)
const VB = { x: 171, y: 166, w: 318, h: 612 };  // centre (330,472), symmetric margin

// Body outline — shared by the fill and the livery clip so stripes follow the panel.
const BODY_D = 'M296 210 Q330 204 364 210 Q406 216 431 250 Q447 278 447 302 Q447 338 434 353 Q426 402 424 442 L423 520 Q425 566 434 596 Q447 622 447 646 Q447 684 438 700 Q434 707 426 709 L234 709 Q226 707 222 700 Q213 684 213 646 Q213 622 226 596 Q235 566 237 520 L236 442 Q234 402 226 353 Q213 338 213 302 Q213 278 229 250 Q254 216 296 210 Z';

const BLUE = '#1a44c4';
// One diagonal blue slash (a parallelogram along `ang`, width `w`).
const diag = (x: number, y: number, len: number, w: number, ang: number) => {
  const r = ang * Math.PI / 180, dx = Math.cos(r) * len, dy = Math.sin(r) * len, nx = -Math.sin(r) * w, ny = Math.cos(r) * w;
  return `<path d="M${x} ${y} l${dx.toFixed(1)} ${dy.toFixed(1)} l${nx.toFixed(1)} ${ny.toFixed(1)} l${(-dx).toFixed(1)} ${(-dy).toFixed(1)} Z"/>`;
};
// A mirrored fan of blue stripes over the mid/rear body (the rally livery), clipped to the body.
const stripes = () => {
  const ws = [7, 14, 6, 20, 8, 12], gap = [0, 20, 40, 54, 82, 98];
  let s = '';
  for (let i = 0; i < ws.length; i++) {
    s += diag(150, 452 + gap[i], 190, ws[i], -46);        // left half, rising to centre-rear
    s += diag(510, 452 + gap[i], 190, ws[i], 180 + 46);   // right half (mirror)
  }
  return `<g fill="${BLUE}">${s}</g>`;
};
// slat highlight helper (rear window)
const slats = (x: number, w: number, y0: number, n: number, step: number) => {
  let s = '';
  for (let i = 0; i < n; i++) { const y = y0 + i * step; s += `<rect x="${x}" y="${y}" width="${w}" height="1.8" fill="#16181d"/><rect x="${x}" y="${y + 1.8}" width="${w}" height="1.1" fill="#565c65" opacity="0.8"/>`; }
  return s;
};
// engine-deck louvres (over the metallic deck)
const louvres = (x: number, w: number, y0: number, n: number, step: number) => {
  let s = '';
  for (let i = 0; i < n; i++) { const y = y0 + i * step; s += `<rect x="${x}" y="${y}" width="${w}" height="3" rx="1.5" fill="#2b3038"/><rect x="${x}" y="${y + 3}" width="${w}" height="1.3" fill="#f2f5f8" opacity="0.5"/>`; }
  return s;
};

const DEFS = `
  <linearGradient id="body" x1="212" y1="0" x2="448" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#7f8790"/><stop offset="0.1" stop-color="#aeb6bf"/><stop offset="0.3" stop-color="#eef1f4"/><stop offset="0.5" stop-color="#c7ccd2"/><stop offset="0.7" stop-color="#eef1f4"/><stop offset="0.9" stop-color="#aeb6bf"/><stop offset="1" stop-color="#7f8790"/></linearGradient>
  <linearGradient id="roof" x1="264" y1="0" x2="396" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8f97a0"/><stop offset="0.5" stop-color="#e6eaee"/><stop offset="1" stop-color="#8f97a0"/></linearGradient>
  <linearGradient id="rocker" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1410"/><stop offset="1" stop-color="#160a08"/></linearGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#10202e"/><stop offset="1" stop-color="#243d4c"/></linearGradient>
  <linearGradient id="flare" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26282f"/><stop offset="0.5" stop-color="#0f1013"/><stop offset="1" stop-color="#26282f"/></linearGradient>
  <linearGradient id="wing" x1="196" y1="0" x2="464" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1a1c22"/><stop offset="0.5" stop-color="#4a5059"/><stop offset="1" stop-color="#1a1c22"/></linearGradient>
  <linearGradient id="tire" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0d0f13"/><stop offset="0.5" stop-color="#2b2f37"/><stop offset="1" stop-color="#0d0f13"/></linearGradient>
  <linearGradient id="blueScoop" x1="304" y1="0" x2="356" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#123090"/><stop offset="0.5" stop-color="#2f63e0"/><stop offset="1" stop-color="#123090"/></linearGradient>
  <clipPath id="bodyclip"><path d="${BODY_D}"/></clipPath>
  <filter id="wingShadow" x="-30%" y="-60%" width="160%" height="260%"><feDropShadow dx="0" dy="8" stdDeviation="3.5" flood-color="#0a0608" flood-opacity="0.55"/></filter>`;

const FURY_G = `
  <g id="furyG">
    <rect x="234" y="360" width="10" height="220" rx="5" fill="url(#rocker)"/>
    <rect x="416" y="360" width="10" height="220" rx="5" fill="url(#rocker)"/>
    <path d="${BODY_D}" fill="url(#body)" stroke="#4c545d" stroke-width="2" stroke-linejoin="round"/>
    <g clip-path="url(#bodyclip)">
      <path d="M300 210 Q330 205 360 210 Q398 218 417 246 L410 262 Q372 240 330 239 Q288 240 250 262 L243 246 Q262 218 300 210 Z" fill="${BLUE}"/>
      ${stripes()}
      <path d="M213 646 Q213 690 234 709 L426 709 Q447 690 447 646 L447 632 Q400 620 330 620 Q260 620 213 632 Z" fill="${BLUE}" opacity="0.85"/>
    </g>
    <rect x="212" y="256" width="50" height="82" rx="22" fill="url(#flare)"/>
    <rect x="398" y="256" width="50" height="82" rx="22" fill="url(#flare)"/>
    <rect x="212" y="588" width="50" height="88" rx="22" fill="url(#flare)"/>
    <rect x="398" y="588" width="50" height="88" rx="22" fill="url(#flare)"/>
    <rect x="211.2" y="258" width="38" height="74" rx="12" fill="url(#tire)"/>
    <rect x="410.8" y="258" width="38" height="74" rx="12" fill="url(#tire)"/>
    <rect x="211.2" y="590" width="38" height="81" rx="12" fill="url(#tire)"/>
    <rect x="410.8" y="590" width="38" height="81" rx="12" fill="url(#tire)"/>
    <rect x="213" y="284" width="34" height="24" rx="6" fill="#1a1c22" opacity="0.5"/>
    <rect x="413" y="284" width="34" height="24" rx="6" fill="#1a1c22" opacity="0.5"/>
    <rect x="213" y="618" width="34" height="26" rx="6" fill="#1a1c22" opacity="0.5"/>
    <rect x="413" y="618" width="34" height="26" rx="6" fill="#1a1c22" opacity="0.5"/>
    <path d="M300 210 Q330 205 360 210 L360 218 Q330 213 300 218 Z" fill="#c7ccd2" opacity="0.9"/>
    <rect x="262" y="234" width="30" height="20" rx="4" fill="#0f1620" stroke="#4c545d" stroke-width="1"/>
    <rect x="266" y="237" width="22" height="14" rx="3" fill="#3a5566"/>
    <rect x="368" y="234" width="30" height="20" rx="4" fill="#0f1620" stroke="#4c545d" stroke-width="1"/>
    <rect x="372" y="237" width="22" height="14" rx="3" fill="#3a5566"/>
    <rect x="306" y="220" width="48" height="18" rx="3" fill="#181a1e" stroke="#4c545d" stroke-width="1"/>
    <g stroke="#3a4048" stroke-width="1.4"><line x1="312" y1="225" x2="348" y2="225"/><line x1="312" y1="230" x2="348" y2="230"/><line x1="312" y1="234" x2="348" y2="234"/></g>
    <circle cx="300" cy="246" r="7" fill="#111721" stroke="#4c545d" stroke-width="1"/><circle cx="300" cy="246" r="4.5" fill="#5a7686"/>
    <circle cx="360" cy="246" r="7" fill="#111721" stroke="#4c545d" stroke-width="1"/><circle cx="360" cy="246" r="4.5" fill="#5a7686"/>
    <path d="M258 320 Q330 310 402 320 Q408 321 406 328 L390 388 Q330 380 270 388 L254 328 Q252 321 258 320 Z" fill="url(#glass)" stroke="#0e1c26" stroke-width="1.5"/>
    <path d="M270 388 Q330 380 390 388 L388 383 Q330 375 272 383 Z" fill="#0e1c26"/>
    <path d="M254 328 L270 388 L276 386 L260 327 Z" fill="#0e1c26"/><path d="M406 328 L390 388 L384 386 L400 327 Z" fill="#0e1c26"/>
    <rect x="272" y="386" width="116" height="52" rx="7" fill="url(#roof)" stroke="#4c545d" stroke-width="1.6"/>
    <rect x="278" y="398" width="22" height="40" rx="6" fill="url(#roof)" stroke="#4a5059" stroke-width="1.2"/>
    <path d="M281 401 L297 401 L294 416 L284 416 Z" fill="#0c0e12"/>
    <rect x="360" y="398" width="22" height="40" rx="6" fill="url(#roof)" stroke="#4a5059" stroke-width="1.2"/>
    <path d="M363 401 L379 401 L376 416 L366 416 Z" fill="#0c0e12"/>
    <rect x="303" y="392" width="54" height="56" rx="7" fill="url(#blueScoop)" stroke="#122a70" stroke-width="1.6"/>
    <path d="M308 396 L352 396 L348 420 L312 420 Z" fill="#0b0d11"/>
    <g stroke="#343a42" stroke-width="1.6"><line x1="330" y1="396" x2="330" y2="420"/><line x1="320" y1="397" x2="318" y2="419"/><line x1="340" y1="397" x2="342" y2="419"/></g>
    <rect x="307" y="426" width="46" height="18" rx="3" fill="#20242b"/>
    <rect x="309" y="429" width="42" height="2.2" fill="#f2f5f8" opacity="0.3"/>
    <path d="M280 452 L380 452 Q386 452 386 459 L380 486 Q330 480 280 486 L274 459 Q274 452 280 452 Z" fill="url(#glass)" stroke="#0e1c26" stroke-width="1.4"/>
    <g>${slats(280, 100, 458, 3, 7)}</g>
    <g>${louvres(252, 46, 500, 8, 12)}${louvres(362, 46, 500, 8, 12)}</g>
    <rect x="240" y="694" width="180" height="15" rx="2" fill="#14161b"/>
    <rect x="256" y="699" width="66" height="4" rx="1" fill="#c22a2a"/>
    <rect x="338" y="699" width="66" height="4" rx="1" fill="#c22a2a"/>
    <rect x="252" y="712" width="156" height="26" rx="2" fill="#0e1014"/>
    <g stroke="#343a42" stroke-width="1.5"><line x1="278" y1="716" x2="278" y2="736"/><line x1="304" y1="716" x2="304" y2="736"/><line x1="330" y1="716" x2="330" y2="736"/><line x1="356" y1="716" x2="356" y2="736"/><line x1="382" y1="716" x2="382" y2="736"/></g>
    <g filter="url(#wingShadow)">
      <rect x="220" y="640" width="16" height="70" rx="2" fill="#1c1e24" stroke="#0e1116" stroke-width="1.2"/>
      <rect x="424" y="640" width="16" height="70" rx="2" fill="#1c1e24" stroke="#0e1116" stroke-width="1.2"/>
      <path d="M224 648 L436 648 L444 690 L216 690 Z" fill="url(#wing)" stroke="#0e1116" stroke-width="1.8"/>
      <path d="M232 654 L428 654 L430 662 L230 662 Z" fill="#9aa2ad" opacity="0.75"/>
      <path d="M228 678 L432 678 L436 686 L224 686 Z" fill="#0e1116" opacity="0.5"/>
    </g>
  </g>`;

function svgFor(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VB.w * FURY_RASTER}" height="${VB.h * FURY_RASTER}" viewBox="${VB.x} ${VB.y} ${VB.w} ${VB.h}">`
    + `<defs>${DEFS}</defs>${FURY_G}</svg>`;
}

const _cache = new Map<FurySkin, HTMLCanvasElement>();
const _loading = new Set<FurySkin>();
let _opaque: { lenPx: number; widPx: number; cxPx: number; cyPx: number } | null = null;

/** The measured opaque bbox of the Fury bitmap (null until it bakes). */
export function furyOpaque() { return _opaque; }
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
 * The cached, rasterised Fury bitmap (transparent, nose UP, centred on the rotation
 * pivot). Null until decoded — kicks the async bake on the first call.
 */
export function furySprite(skin: FurySkin = 'lombard'): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const hit = _cache.get(skin);
  if (hit) return hit;
  if (!_loading.has(skin)) {
    _loading.add(skin);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor());
    const bake = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = Math.round(VB.w * FURY_RASTER);
        cv.height = Math.round(VB.h * FURY_RASTER);
        const c = cv.getContext('2d');
        if (!c) { _loading.delete(skin); return; }
        c.drawImage(img, 0, 0, cv.width, cv.height);
        _cache.set(skin, cv);
        if (!_opaque) measureOpaque(cv);
      } catch {
        _loading.delete(skin);
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
