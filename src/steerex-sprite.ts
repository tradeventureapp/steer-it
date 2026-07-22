// =============================================================================
//  Stee-Rex — the designer's top-down SVG sprite, rasterised once per skin.
//  (Designer working title "Rascal RX"; the in-game name is Stee-Rex.)
//
//  VISUAL ONLY. Stee-Rex has no physics tune yet — in game it borrows Blitz RS's
//  physics4 params as a placeholder (the drive model is the global PHYS4, so no
//  per-car physics exists to change). This module only builds + caches the look.
//
//  The car is the SVG group `#carG` (authored in a 900×1080 viewBox, nose UP). We
//  render JUST that group — no light background, no ground-shadow filter — onto a
//  transparent bitmap, cropped to a viewBox that is SYMMETRIC about the geometry
//  centre so the bitmap's centre is the car's rotation pivot (like Blitz RS).
//
//  Two skins (SILVER brushed steel / BLACK graphite) differ ONLY in the body /
//  roof / fenderL / fenderR gradients — everything else (stripes, glass, tyres,
//  flares, wing, lights) is identical, per the handoff. The single geometry used
//  for both is the more-detailed Silver `#carG`.
// =============================================================================

export type SteerexSkin = 'silver' | 'black';

// Geometry (SVG units, inside #carG): content bbox x[164,496] y[206,738] →
// centre (330,472), nose→tail length 532. The render viewBox pads 30 units so the
// wing drop-shadow isn't clipped AND stays symmetric about the centre (canvas
// centre == car centre → correct rotation pivot).
export const STEEREX_LEN_SVG = 532;             // nose→tail; the length we size to match Blitz RS
export const STEEREX_RASTER = 3;                // bitmap px per SVG unit (crisp when scaled down)
const VB = { x: 134, y: 176, w: 392, h: 592 };  // centre (330,472), 30-unit margin

// ---- per-skin gradients (the ONLY difference between skins) ----
const SKIN_DEFS: Record<SteerexSkin, string> = {
  silver: `
    <linearGradient id="body" x1="196" y1="0" x2="464" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7f8790"/><stop offset="0.1" stop-color="#aeb6bf"/><stop offset="0.3" stop-color="#eef1f4"/><stop offset="0.5" stop-color="#c7ccd2"/><stop offset="0.7" stop-color="#eef1f4"/><stop offset="0.9" stop-color="#aeb6bf"/><stop offset="1" stop-color="#7f8790"/>
    </linearGradient>
    <linearGradient id="roof" x1="214" y1="0" x2="446" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8f97a0"/><stop offset="0.5" stop-color="#e6eaee"/><stop offset="1" stop-color="#8f97a0"/>
    </linearGradient>
    <linearGradient id="fenderL" x1="182" y1="0" x2="212" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5b626b"/><stop offset="0.55" stop-color="#aeb6bf"/><stop offset="1" stop-color="#eef1f4"/></linearGradient>
    <linearGradient id="fenderR" x1="448" y1="0" x2="478" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#eef1f4"/><stop offset="0.45" stop-color="#aeb6bf"/><stop offset="1" stop-color="#5b626b"/></linearGradient>`,
  black: `
    <linearGradient id="body" x1="196" y1="0" x2="464" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#565b63"/><stop offset="0.1" stop-color="#34383f"/><stop offset="0.3" stop-color="#828892"/><stop offset="0.5" stop-color="#3f444c"/><stop offset="0.7" stop-color="#828892"/><stop offset="0.9" stop-color="#34383f"/><stop offset="1" stop-color="#565b63"/>
    </linearGradient>
    <linearGradient id="roof" x1="214" y1="0" x2="446" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#3a3f47"/><stop offset="0.5" stop-color="#7a808b"/><stop offset="1" stop-color="#3a3f47"/>
    </linearGradient>
    <linearGradient id="fenderL" x1="182" y1="0" x2="212" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#24272c"/><stop offset="0.55" stop-color="#4a4f57"/><stop offset="1" stop-color="#828892"/></linearGradient>
    <linearGradient id="fenderR" x1="448" y1="0" x2="478" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#828892"/><stop offset="0.45" stop-color="#4a4f57"/><stop offset="1" stop-color="#24272c"/></linearGradient>`,
};

// ---- shared defs (identical for both skins) ----
const SHARED_DEFS = `
  <linearGradient id="rocker" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1410"/><stop offset="1" stop-color="#160a08"/></linearGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#10202e"/><stop offset="1" stop-color="#243d4c"/></linearGradient>
  <linearGradient id="flare" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26282f"/><stop offset="0.5" stop-color="#0f1013"/><stop offset="1" stop-color="#26282f"/></linearGradient>
  <linearGradient id="wing" x1="176" y1="0" x2="484" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1a1c22"/><stop offset="0.5" stop-color="#4a5059"/><stop offset="1" stop-color="#1a1c22"/></linearGradient>
  <linearGradient id="tire" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0d0f13"/><stop offset="0.5" stop-color="#2b2f37"/><stop offset="1" stop-color="#0d0f13"/></linearGradient>
  <linearGradient id="steerStripe" x1="0" y1="206" x2="0" y2="730" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff8a3d"/><stop offset="0.5" stop-color="#ff2d8f"/><stop offset="1" stop-color="#7a1fff"/></linearGradient>
  <filter id="wingShadow" x="-30%" y="-60%" width="160%" height="260%"><feDropShadow dx="0" dy="7" stdDeviation="5" flood-color="#0a0608" flood-opacity="0.5"/></filter>
  <clipPath id="rwin"><path d="M249 553 L411 553 L417 617 Q418 624 411 624 L249 624 Q242 624 243 617 Z"/></clipPath>`;

// ---- the car geometry (Silver #carG, verbatim; identical for both skins) ----
// NARROWER version: the designer squeezes the whole car horizontally to 0.8× about its
// centre-line (x=330), exactly as their `<use transform="… scale(0.8 1) …">` does. The
// geometry inside is byte-identical to the wider version; only this outer transform is new.
const CAR_G = `
  <g id="carG" transform="translate(330 0) scale(0.8 1) translate(-330 0)">
    <rect x="192" y="330" width="14" height="300" rx="5" fill="url(#rocker)"/>
    <rect x="454" y="330" width="14" height="300" rx="5" fill="url(#rocker)"/>
    <g>
      <rect x="164" y="258" width="66" height="104" rx="24" fill="url(#flare)"/>
      <rect x="430" y="258" width="66" height="104" rx="24" fill="url(#flare)"/>
      <rect x="164" y="590" width="66" height="108" rx="24" fill="url(#flare)"/>
      <rect x="430" y="590" width="66" height="108" rx="24" fill="url(#flare)"/>
      <rect x="170" y="272" width="46" height="80" rx="13" fill="url(#tire)"/>
      <rect x="444" y="272" width="46" height="80" rx="13" fill="url(#tire)"/>
      <rect x="170" y="606" width="46" height="82" rx="13" fill="url(#tire)"/>
      <rect x="444" y="606" width="46" height="82" rx="13" fill="url(#tire)"/>
      <rect x="172" y="298" width="42" height="30" rx="6" fill="#1a1c22" opacity="0.6"/>
      <rect x="446" y="298" width="42" height="30" rx="6" fill="#1a1c22" opacity="0.6"/>
      <path d="M212 258 L188 258 Q182 258 182 268 L182 356 Q182 366 188 366 L212 366 Z" fill="url(#fenderL)" stroke="#3a4048" stroke-width="1"/>
      <path d="M448 258 L472 258 Q478 258 478 268 L478 356 Q478 366 472 366 L448 366 Z" fill="url(#fenderR)" stroke="#3a4048" stroke-width="1"/>
      <path d="M212 592 L188 592 Q182 592 182 602 L182 690 L212 706 Z" fill="url(#fenderL)" stroke="#3a4048" stroke-width="1"/>
      <path d="M448 592 L472 592 Q478 592 478 602 L478 690 L448 706 Z" fill="url(#fenderR)" stroke="#3a4048" stroke-width="1"/>
      <rect x="172" y="632" width="42" height="30" rx="6" fill="#1a1c22" opacity="0.6"/>
      <rect x="446" y="632" width="42" height="30" rx="6" fill="#1a1c22" opacity="0.6"/>
    </g>
    <path d="M240 206 L420 206 Q428 206 432 213 L464 258 L464 700 L446 730 L214 730 L196 700 L196 258 L228 213 Q232 206 240 206 Z" fill="url(#body)" stroke="#5b636d" stroke-width="2" stroke-linejoin="round"/>
    <path d="M238 220 L422 220 L452 264 L452 694 L436 718 L224 718 L208 694 L208 264 Z" fill="none" stroke="#ffffff" stroke-width="1.3" opacity="0.5" stroke-linejoin="round"/>
    <rect x="262" y="281" width="32" height="54" rx="6" fill="#181a1e" stroke="#5b636d" stroke-width="1.2"/>
    <rect x="366" y="281" width="32" height="54" rx="6" fill="#181a1e" stroke="#5b636d" stroke-width="1.2"/>
    <g stroke="#3a4048" stroke-width="1.6"><line x1="268" y1="291" x2="288" y2="291"/><line x1="268" y1="300" x2="288" y2="300"/><line x1="268" y1="309" x2="288" y2="309"/><line x1="268" y1="318" x2="288" y2="318"/><line x1="268" y1="327" x2="288" y2="327"/><line x1="372" y1="291" x2="392" y2="291"/><line x1="372" y1="300" x2="392" y2="300"/><line x1="372" y1="309" x2="392" y2="309"/><line x1="372" y1="318" x2="392" y2="318"/><line x1="372" y1="327" x2="392" y2="327"/></g>
    <rect x="304" y="206" width="22" height="524" fill="url(#steerStripe)"/>
    <rect x="334" y="206" width="22" height="524" fill="url(#steerStripe)"/>
    <rect x="300" y="206" width="4" height="524" fill="#111418"/>
    <rect x="356" y="206" width="4" height="524" fill="#111418"/>
    <rect x="326" y="206" width="8" height="524" fill="#111418"/>
    <path d="M240 363 Q330 348 420 363 Q435 366 433 374 L415 441 Q412 449 400 449 L260 449 Q248 449 245 441 L227 374 Q225 366 240 363 Z" fill="url(#glass)" stroke="#0e1c26" stroke-width="1.5"/>
    <path d="M227 374 L248 449 L257 446 L236 373 Z" fill="#0e1c26"/>
    <path d="M433 374 L412 449 L403 446 L424 373 Z" fill="#0e1c26"/>
    <path d="M240 535 Q243 535 243 531 L243 461 Q243 457 240 452 L219 375 Q215 368 211 375 L214 531 Q214 535 217 535 Z" fill="url(#glass)" stroke="#0e1c26" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M420 535 Q417 535 417 531 L417 461 Q417 457 420 452 L441 375 Q445 368 449 375 L446 531 Q446 535 443 535 Z" fill="url(#glass)" stroke="#0e1c26" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M215 527 L242 527 L242 533 L215 533 Z" fill="#0e1c26"/>
    <path d="M418 527 L445 527 L445 533 L418 533 Z" fill="#0e1c26"/>
    <path d="M214 382 L219 382 L219 528 L214 528 Z" fill="#0e1c26"/>
    <path d="M446 382 L441 382 L441 528 L446 528 Z" fill="#0e1c26"/>
    <path d="M243 458 L219 375 L214 378 L238 459 Z" fill="#0e1c26"/>
    <path d="M417 458 L441 375 L446 378 L422 459 Z" fill="#0e1c26"/>
    <path d="M245 441 Q248 449 260 449 L400 449 Q412 449 415 441 L413 436 Q409 444 400 444 L260 444 Q251 444 247 436 Z" fill="#0e1c26"/>
    <path d="M240 363 Q330 348 420 363 L418 369 Q330 354 242 369 Z" fill="#0e1c26"/>
    <path d="M243 461 L238 461 L238 531 L243 531 Z" fill="#0e1c26"/>
    <path d="M417 461 L422 461 L422 531 L417 531 Z" fill="#0e1c26"/>
    <rect x="248" y="449" width="164" height="117" rx="6" fill="url(#roof)" stroke="#5b636d" stroke-width="1.6"/>
    <rect x="304" y="449" width="22" height="117" fill="url(#steerStripe)"/>
    <rect x="334" y="449" width="22" height="117" fill="url(#steerStripe)"/>
    <rect x="300" y="449" width="4" height="117" fill="#111418"/>
    <rect x="356" y="449" width="4" height="117" fill="#111418"/>
    <rect x="326" y="449" width="8" height="117" fill="#111418"/>
    <g transform="translate(0 14)"><g clip-path="url(#rwin)">
      <rect x="206" y="550" width="250" height="78" fill="url(#glass)"/>
      <rect x="206" y="558" width="250" height="2" fill="#16181d"/><rect x="206" y="560" width="250" height="1.2" fill="#565c65" opacity="0.8"/>
      <rect x="206" y="566" width="250" height="2" fill="#16181d"/><rect x="206" y="568" width="250" height="1.2" fill="#565c65" opacity="0.8"/>
      <rect x="206" y="574" width="250" height="2" fill="#16181d"/><rect x="206" y="576" width="250" height="1.2" fill="#565c65" opacity="0.8"/>
      <rect x="206" y="582" width="250" height="2" fill="#16181d"/><rect x="206" y="584" width="250" height="1.2" fill="#565c65" opacity="0.8"/>
      <rect x="206" y="590" width="250" height="2" fill="#16181d"/><rect x="206" y="592" width="250" height="1.2" fill="#565c65" opacity="0.8"/>
      <rect x="206" y="598" width="250" height="2" fill="#16181d"/><rect x="206" y="600" width="250" height="1.2" fill="#565c65" opacity="0.8"/>
      <rect x="206" y="606" width="250" height="2" fill="#16181d"/><rect x="206" y="608" width="250" height="1.2" fill="#565c65" opacity="0.8"/>
      <rect x="206" y="614" width="250" height="2" fill="#16181d"/><rect x="206" y="616" width="250" height="1.2" fill="#565c65" opacity="0.8"/>
    </g>
    <path d="M249 553 L411 553 L417 617 Q418 624 411 624 L249 624 Q242 624 243 617 Z" fill="none" stroke="#0e1c26" stroke-width="1.5"/>
    <path d="M249 553 L411 553 L411 559 L249 559 Z" fill="#0e1c26"/>
    <path d="M249 553 L243 617 Q242 621 244 623 L250 622 L255 556 Z" fill="#0e1c26"/>
    <path d="M411 553 L417 617 Q418 621 416 623 L410 622 L405 556 Z" fill="#0e1c26"/></g>
    <rect x="214" y="708" width="232" height="22" rx="2" fill="#14161b"/>
    <rect x="236" y="716" width="78" height="4" rx="1" fill="#a82424"/>
    <rect x="346" y="716" width="78" height="4" rx="1" fill="#a82424"/>
    <rect x="245" y="726" width="56" height="12" rx="6" fill="#4a505a"/>
    <rect x="248" y="729" width="50" height="8" rx="4" fill="#101216"/>
    <rect x="250" y="730" width="46" height="2.4" rx="1.2" fill="#5a616b"/>
    <rect x="359" y="726" width="56" height="12" rx="6" fill="#4a505a"/>
    <rect x="362" y="729" width="50" height="8" rx="4" fill="#101216"/>
    <rect x="364" y="730" width="46" height="2.4" rx="1.2" fill="#5a616b"/>
    <g filter="url(#wingShadow)">
      <path d="M186 666 L474 666 L488 700 L172 700 Z" fill="url(#wing)" stroke="#0e1116" stroke-width="1.6"/>
      <path d="M192 671 L468 671 L470 677 L190 677 Z" fill="#7a828d" opacity="0.75"/>
    </g>
  </g>`;

function svgFor(skin: SteerexSkin): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VB.w * STEEREX_RASTER}" height="${VB.h * STEEREX_RASTER}" viewBox="${VB.x} ${VB.y} ${VB.w} ${VB.h}">`
    + `<defs>${SKIN_DEFS[skin]}${SHARED_DEFS}</defs>${CAR_G}</svg>`;
}

const _cache = new Map<SteerexSkin, HTMLCanvasElement>();
const _loading = new Set<SteerexSkin>();

// The sprite's FULL OPAQUE bounding box, measured from the rasterised bitmap (tyres,
// flares and any AA/shadow bleed included). Both skins share the geometry, so this is
// measured once. `lenPx`/`widPx` are the opaque nose→tail / across-tyres extents in
// bitmap px; (cxPx,cyPx) the opaque centre = the rotation pivot the sprite is drawn
// about. drawSteerex scales `lenPx` → the vehicle's real length, so the width follows
// automatically at the sprite's own aspect ratio (no stretching).
let _opaque: { lenPx: number; widPx: number; cxPx: number; cyPx: number } | null = null;
/** The measured opaque bbox of the Stee-Rex bitmap (null until the first skin bakes). */
export function steerexOpaque() { return _opaque; }
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
 * The cached, rasterised Stee-Rex bitmap for a skin (transparent, nose UP, centred
 * on the car's rotation pivot). Null until it has decoded — kicks the async bake on
 * the first call. Call `preloadSteerex()` at startup so it's ready before use.
 */
export function steerexSprite(skin: SteerexSkin): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const hit = _cache.get(skin);
  if (hit) return hit;
  if (!_loading.has(skin)) {
    _loading.add(skin);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(skin));
    const bake = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = Math.round(VB.w * STEEREX_RASTER);
        cv.height = Math.round(VB.h * STEEREX_RASTER);
        const c = cv.getContext('2d');
        if (!c) { _loading.delete(skin); return; }   // no ctx (memory) → allow a later retry
        c.drawImage(img, 0, 0, cv.width, cv.height);
        _cache.set(skin, cv);
        if (!_opaque) measureOpaque(cv);   // both skins share the geometry → measure once
      } catch {
        _loading.delete(skin);             // bake threw (memory) → don't get stuck; retry next call
      }
    };
    // A decode/load FAILURE (memory pressure, transient) must RELEASE the skin from _loading —
    // otherwise it stays "loading" forever and the sprite never reappears for the session (the
    // "car image sometimes doesn't show" bug). Releasing lets the next steerexSprite() retry.
    const fail = () => { _loading.delete(skin); };
    // decode() gates on the bitmap being canvas-paintable (WebKit fires load early).
    if (typeof img.decode === 'function') img.decode().then(bake).catch(fail);
    else { img.onload = bake; img.onerror = fail; }
  }
  return null;
}

/** Warm both skins so a Stee-Rex car is never invisible on first spawn. */
export function preloadSteerex(): void {
  steerexSprite('silver');
  steerexSprite('black');
}

// ---- MIPMAP DOWNSCALE CACHE (crisp small render) ----------------------------------------
// The source bitmap is huge (~1776 px long) but the in-game car is ~40-140 px. Downscaling
// that far in ONE drawImage step aliases the fine details (window slats, stripes, thin strokes)
// into speckle/grain. Fix: pre-downscale to ~the on-screen size via STEPPED HALVING (each step
// high-quality), cached per (skin, size bucket), so the per-frame draw is a gentle ≤2× scale.
export interface SteerexMip { cv: HTMLCanvasElement; widPx: number; cxPx: number; cyPx: number; }
const _mips = new Map<string, SteerexMip>();
function downscaleStep(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d')!;
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, w, h);
  return cv;
}
/**
 * A cached copy of the skin bitmap pre-scaled so its opaque length ≈ `targetLenPx` (power-of-two
 * bucketed → stable across frames), for a crisp small draw. Returns the source unchanged when no
 * meaningful downscale is needed. Null until the source has baked.
 */
export function steerexScaled(skin: SteerexSkin, targetLenPx: number): SteerexMip | null {
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
  const f = Math.min(1, bucket / srcLen);          // downscale factor for the FULL bitmap
  const finalW = Math.max(1, Math.round(src.width * f));
  const finalH = Math.max(1, Math.round(src.height * f));
  let cur = src;
  while (cur.width > finalW * 2) {                  // halve repeatedly (crisp) until close
    cur = downscaleStep(cur, Math.max(finalW, Math.round(cur.width / 2)),
                             Math.max(finalH, Math.round(cur.height / 2)));
  }
  const out = downscaleStep(cur, finalW, finalH);
  const mip: SteerexMip = { cv: out, widPx: _opaque.widPx * f, cxPx: _opaque.cxPx * f, cyPx: _opaque.cyPx * f };
  _mips.set(key, mip);
  return mip;
}
