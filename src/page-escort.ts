// =============================================================================
//  PAGE ESCORT — the landing-page Stee-Rex that escorts you DOWN the page.
//
//  ONE car, but it lives in the SECTION you're looking at. The HERO loop is the
//  ORIGINAL orbit — a rounded-rect ringing the headline card, computed exactly as
//  the old hero-drift did, so the top is untouched. Every section BELOW the hero
//  has its own editable loop (a Catmull-Rom spline through waypoints): scroll down
//  and the car drifts across into that section's loop and laps there. Rendered
//  BEHIND all content (low z-index), passes behind text / mockups / buttons, never
//  takes a pointer event, and leaves tyre marks + smoke — including the streak it
//  lays crossing from one loop to the next.
//
//  MODEL — purely client-side, purely decorative (no Supabase, no game state):
//    • Section 0 (HERO) = the original computed rounded-rect orbit around the card
//      keep-out box (untouched). Sections 1+ = editable waypoint loops, stored as
//      FRACTIONS of the scroll content so they survive resize / reflow. The author
//      lays those out visually (preview editor) and hands back the final set.
//    • The CAR circles the loop of the section under your viewport; scrolling into
//      another section re-targets it and it DRIFTS across (same kinematic drift
//      feel as the game — heading + velocity direction, the LAG is the drift
//      angle, corner-scrub). Not physics4; it only has to LOOK like the game.
//    • The CAMERA is your scroll. REDUCED = one static frame. MOBILE = smaller
//      car, fewer particles, 30 fps cap, lower backing res.
// =============================================================================
import { steerexSprite, steerexOpaque, type SteerexSkin } from './steerex-sprite';
import { STEEREX_DIMS } from './vehicles';
import { CONFIG } from './vehicle-core';

const GAME_CAR_PX = STEEREX_DIMS.lengthM * CONFIG.pxPerMeter;
const GAME_CRUISE_PX = 33 * CONFIG.pxPerMeter;

export interface Waypoint { xf: number; yf: number; }

export interface PageEscortOptions {
  /** The scrolling container the loops live inside (the landing `#main-menu`). */
  scroller: HTMLElement;
  /** Per-section elements defining the vertical bands (hero, how, …). */
  sections: HTMLElement[];
  /** Section 0's original orbit rings THIS element (the headline card). */
  heroKeepOut: HTMLElement | null;
  /** Editable loops for sections 1+ (parallel to sections[1..]), content fractions. */
  loops: Waypoint[][];
  /** Sprite skin to drive. */
  skin?: SteerexSkin;
}

export interface PageEscortHandle {
  setActive(on: boolean): void;
  /** Replace the editable (non-hero) loops (live). */
  setLoops(loops: Waypoint[][]): void;
  /** Current editable (non-hero) loops (a deep copy). */
  getLoops(): Waypoint[][];
  /** Which absolute section a content-fraction Y falls in (0 = hero). */
  sectionForYf(yf: number): number;
  sectionCount(): number;
  setDebugPath(on: boolean): void;
  contentToClient(xf: number, yf: number): { x: number; y: number };
  clientToContent(x: number, y: number): Waypoint;
  destroy(): void;
}

const LOOK = {
  carLenPx: GAME_CAR_PX,
  carLenPxSmall: GAME_CAR_PX * 0.8,
  cruise: GAME_CRUISE_PX,
  travelHurry: 1.3,        // gentle speed × while drifting ACROSS to another section's loop
                           // (was 2.2 — too fast; the calm cruise is the same everywhere now)
  vRef: 70,
  omegaMax: 3.1,
  steerRange: 1.0,
  grip: 2.5,
  betaMax: 0.70,
  cornerSlow: 0.42,
  lookaheadPx: GAME_CAR_PX * 2.2,
  // HERO orbit shape — matches the original hero-drift exactly.
  ringGap: GAME_CAR_PX * 2.85,
  minGap: GAME_CAR_PX,
  // Cursor / touch reaction (restored from the original hero-drift).
  chaseRadius: 360,        // pointer must be within this (content px) to grab the car
  chaseInMs: 260,          // ramp on/off so the hand-off is never a snap
  chaseOutMs: 900,
  pointerIdleMs: 1400,     // no movement for this long → ease back to the loop
  markBeta: 0.20,
  smokeBeta: 0.30,
  markRgb: '255, 74, 160',
  smokeRgb: '255, 176, 132',
  markLife: 3.2,
};
const MARK_MAX = 520;
const MARK_MAX_SMALL = 180;
const SMOKE_MAX = 60;
const SMOKE_MAX_SMALL = 18;
const SUBDIV = 24;
const HERO_SAMPLES = 240;

// Editable loops for sections BELOW the hero. One entry per non-hero section —
// here: HOW IT WORKS. Laid out visually in the preview editor (final points).
const DEFAULT_LOOPS: Waypoint[][] = [
  // HOW IT WORKS — laid out in the editor (author's final points).
  [
    { xf: 0.486, yf: 0.324 }, { xf: 0.750, yf: 0.329 }, { xf: 0.853, yf: 0.380 },
    { xf: 0.872, yf: 0.444 }, { xf: 0.796, yf: 0.480 }, { xf: 0.666, yf: 0.481 },
    { xf: 0.352, yf: 0.472 }, { xf: 0.161, yf: 0.548 }, { xf: 0.205, yf: 0.591 },
    { xf: 0.490, yf: 0.601 }, { xf: 0.749, yf: 0.594 }, { xf: 0.822, yf: 0.561 },
    { xf: 0.574, yf: 0.476 }, { xf: 0.302, yf: 0.466 }, { xf: 0.198, yf: 0.427 },
    { xf: 0.158, yf: 0.361 }, { xf: 0.270, yf: 0.330 }, { xf: 0.507, yf: 0.298 },
  ],
  [],   // free vs premium — default oval until drawn
  [],   // roadmap — default oval until drawn
];

type Pt = { x: number; y: number };
type Mark = { ax: number; ay: number; bx: number; by: number; age: number };
type Puff = { x: number; y: number; vx: number; vy: number; age: number; life: number; r: number };
type BuiltLoop = { poly: Pt[]; seg: number[]; len: number };
type Band = { top: number; bot: number };

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
function angDiff(b: number, a: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
function catmull(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t
      + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
      + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t
      + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
      + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}
function polyToBuilt(poly: Pt[]): BuiltLoop {
  const seg: number[] = [];
  let len = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    seg.push(len);
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return { poly, seg, len };
}

export function startPageEscort(
  canvas: HTMLCanvasElement, opts: PageEscortOptions,
): PageEscortHandle {
  const ctx = canvas.getContext('2d');
  const scroller = opts.scroller;
  const sections = opts.sections;
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = typeof matchMedia === 'function'
    && (matchMedia('(hover: none)').matches || matchMedia('(max-width: 720px)').matches);

  const markMax = small ? MARK_MAX_SMALL : MARK_MAX;
  const smokeMax = small ? SMOKE_MAX_SMALL : SMOKE_MAX;
  let effects = !reduced;

  // Editable loops for sections 1+ (index k ↔ section k+1). ALWAYS one slot per
  // non-hero section — pad with empty loops so EVERY section has a route (an empty
  // slot falls back to a synthesized default oval, below, so the car never gets
  // stuck lapping a far section's loop off-band = the old "races in free-vs-premium").
  const NEED = Math.max(0, sections.length - 1);
  let loopsWP: Waypoint[][] = (opts.loops.length ? opts.loops : DEFAULT_LOOPS).map((l) => l.slice());
  while (loopsWP.length < NEED) loopsWP.push([]);
  if (loopsWP.length > NEED) loopsWP = loopsWP.slice(0, NEED);

  let W = 0, H = 0, dpr = 1;
  let contentW = 1, contentH = 1;
  let built: BuiltLoop[] = [];      // index 0 = hero orbit, 1+ = loopsWP
  let bands: Band[] = [];

  let px = 0, py = 0, theta = 0, phi = 0, v = LOOK.cruise, s = 0;
  let curIdx = 0;
  const marks: Mark[] = [];
  const puffs: Puff[] = [];

  // --- pointer (cursor / touch) ---
  let pointer: Pt | null = null;     // VIEWPORT px (content Y = pointer.y + scrollTop)
  let pointerAt = -1e9;
  let chase = 0;                     // 0 = pure loop, 1 = fully chasing the pointer
  let heroCardRect: { x0: number; y0: number; x1: number; y1: number } | null = null;

  let running = false, active = false, raf = 0, last = 0;
  let debugPath = false, slowFrames = 0;

  /** Element's rect in scroll-content px (walk offsetParent up to the scroller). */
  function contentRectOf(el: HTMLElement): { x0: number; y0: number; x1: number; y1: number } {
    let x = 0, y = 0;
    let e: HTMLElement | null = el;
    while (e && e !== scroller) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent as HTMLElement | null; }
    return { x0: x, y0: y, x1: x + el.offsetWidth, y1: y + el.offsetHeight };
  }

  /** The ORIGINAL hero orbit — a superellipse rounded-rect ringing the card,
   *  inset within the hero band. Reproduces the old hero-drift buildLoop exactly. */
  function buildHeroLoop(): BuiltLoop {
    const hero = sections[0];
    if (!hero || !opts.heroKeepOut) return { poly: [], seg: [], len: 0 };
    const bandTop = hero.offsetTop;
    const w = contentW, h = Math.max(40, hero.offsetHeight);
    const kr = contentRectOf(opts.heroKeepOut);
    const kx0 = kr.x0, kx1 = kr.x1, ky0 = kr.y0 - bandTop, ky1 = kr.y1 - bandTop;   // band-local y
    const edge = Math.min(w, h) * 0.05 + 12;
    const L = Math.min(Math.max(kx0 - LOOK.ringGap, edge), kx0 - LOOK.minGap);
    const R = Math.max(Math.min(kx1 + LOOK.ringGap, w - edge), kx1 + LOOK.minGap);
    const T = Math.min(Math.max(ky0 - LOOK.ringGap, edge), ky0 - LOOK.minGap);
    const B = Math.max(Math.min(ky1 + LOOK.ringGap, h - edge), ky1 + LOOK.minGap);
    const rw = Math.max(40, R - L), rh = Math.max(40, B - T);
    const cx = (L + R) / 2, cy = (T + B) / 2;
    const n = 2.6;
    const poly: Pt[] = [];
    for (let i = 0; i < HERO_SAMPLES; i++) {
      const t = (i / HERO_SAMPLES) * TAU, c = Math.cos(t), sn = Math.sin(t);
      const ax = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      const ay = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
      poly.push({ x: cx + (rw / 2) * ax, y: bandTop + cy + (rh / 2) * ay });
    }
    // clearance guard — push any point that lands on the (inflated) card back out
    const ex0 = kx0 - LOOK.minGap, ex1 = kx1 + LOOK.minGap, ey0 = ky0 - LOOK.minGap, ey1 = ky1 + LOOK.minGap;
    for (const p of poly) {
      const yl = p.y - bandTop;
      if (p.x > ex0 && p.x < ex1 && yl > ey0 && yl < ey1) {
        const dl = p.x - ex0, dr = ex1 - p.x, dt = yl - ey0, db = ey1 - yl;
        const m = Math.min(dl, dr, dt, db);
        if (m === dl) p.x = ex0; else if (m === dr) p.x = ex1;
        else if (m === dt) p.y = bandTop + ey0; else p.y = bandTop + ey1;
      }
    }
    return polyToBuilt(poly);
  }

  function buildSpline(wp: Waypoint[], secIdx: number): BuiltLoop {
    const n = wp.length;
    if (n < 3) return { poly: [], seg: [], len: 0 };
    const p = wp.map((w) => ({ x: w.xf * contentW, y: w.yf * contentH }));
    const poly: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n], d = p[(i + 2) % n];
      for (let j = 0; j < SUBDIV; j++) poly.push(catmull(a, b, c, d, j / SUBDIV));
    }
    // MOBILE containment: loops are authored against the DESKTOP layout, but on a
    // phone the sections restack TALLER, so a loop that fit its section on desktop
    // spills into the next one — and the car "drives across" into it. Squeeze the
    // loop's vertical extent to fit its OWN section band (shape kept, only shrunk +
    // re-centred). Desktop is untouched → the car laps exactly what was drawn.
    const b = bands[secIdx];
    if (small && b) {
      let minY = Infinity, maxY = -Infinity;
      for (const q of poly) { if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
      const inset = LOOK.carLenPxSmall * 0.7;
      const bTop = b.top + inset, bBot = b.bot - inset;
      if (maxY > minY && bBot > bTop) {
        const sc = Math.min(1, (bBot - bTop) / (maxY - minY));   // shrink-to-fit only, never enlarge
        const srcMid = (minY + maxY) / 2, dstMid = (bTop + bBot) / 2;
        for (const q of poly) q.y = clamp(dstMid + (q.y - srcMid) * sc, bTop, bBot);
      }
    }
    return polyToBuilt(poly);
  }

  // A calm centred oval inset within a section's band — the fallback route for a
  // section the author hasn't drawn yet, so the car always has somewhere to lap.
  function buildDefaultOval(secIdx: number): BuiltLoop {
    const b = bands[secIdx];
    if (!b) return { poly: [], seg: [], len: 0 };
    const cx = contentW / 2, cy = (b.top + b.bot) / 2;
    const rw = contentW * 0.32, rh = Math.max(60, (b.bot - b.top) * 0.30);
    const poly: Pt[] = [];
    const N = 64;
    for (let i = 0; i < N; i++) { const t = (i / N) * TAU; poly.push({ x: cx + rw * Math.cos(t), y: cy + rh * Math.sin(t) }); }
    return polyToBuilt(poly);
  }

  function rebuild() {
    // bands FIRST — the default oval needs each section's band.
    bands = sections.map((el) => ({ top: el.offsetTop, bot: el.offsetTop + el.offsetHeight }));
    built = [buildHeroLoop(), ...loopsWP.map((wp, k) => (wp.length >= 3 ? buildSpline(wp, k + 1) : buildDefaultOval(k + 1)))];
    heroCardRect = opts.heroKeepOut ? contentRectOf(opts.heroKeepOut) : null;
  }

  /** Push a chase target OUT of the hero headline card so the car never covers it
   *  (only used while lapping the hero, exactly as the original hero-drift did). */
  function clampOutOfHeroCard(x: number, y: number): Pt {
    const k = heroCardRect;
    if (!k) return { x, y };
    const pad = 12;
    if (x < k.x0 - pad || x > k.x1 + pad || y < k.y0 - pad || y > k.y1 + pad) return { x, y };
    const dl = x - (k.x0 - pad), dr = (k.x1 + pad) - x, dt = y - (k.y0 - pad), db = (k.y1 + pad) - y;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: k.x0 - pad, y };
    if (m === dr) return { x: k.x1 + pad, y };
    if (m === dt) return { x, y: k.y0 - pad };
    return { x, y: k.y1 + pad };
  }

  function measure() {
    W = Math.max(1, scroller.clientWidth);
    H = Math.max(1, scroller.clientHeight);
    dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    contentW = Math.max(1, scroller.clientWidth);
    contentH = Math.max(1, scroller.scrollHeight);
    rebuild();
  }

  function sectionAtY(y: number): number {
    if (!bands.length) return 0;
    for (let i = 0; i < bands.length; i++) if (y >= bands[i].top && y < bands[i].bot) return i;
    let best = 0, bd = Infinity;
    for (let i = 0; i < bands.length; i++) {
      const c = (bands[i].top + bands[i].bot) / 2, d = Math.abs(y - c);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function atLen(idx: number, d: number): Pt {
    const L = built[idx];
    if (!L || !L.poly.length || L.len <= 0) return { x: contentW / 2, y: contentH / 2 };
    let t = d % L.len; if (t < 0) t += L.len;
    let lo = 0, hi = L.seg.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L.seg[m] <= t) lo = m; else hi = m - 1; }
    const a = L.poly[lo], b = L.poly[(lo + 1) % L.poly.length];
    const segLen = (lo + 1 < L.seg.length ? L.seg[lo + 1] : L.len) - L.seg[lo];
    const f = segLen > 0 ? (t - L.seg[lo]) / segLen : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  function nearestLen(idx: number, x: number, y: number): number {
    const L = built[idx];
    if (!L || !L.poly.length) return 0;
    let best = 0, bd = Infinity;
    for (let i = 0; i < L.poly.length; i++) {
      const d = (L.poly[i].x - x) ** 2 + (L.poly[i].y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return L.seg[best];
  }

  function firstValidSection(y: number): number {
    let idx = sectionAtY(y);
    if (!built[idx] || built[idx].len <= 0) {
      for (let i = 0; i < built.length; i++) if (built[i].len > 0) { idx = i; break; }
    }
    return idx;
  }

  function reset() {
    const camY = scroller.scrollTop;
    curIdx = firstValidSection(camY + H * 0.5);
    s = 0;
    const p0 = atLen(curIdx, 0), p1 = atLen(curIdx, 40);
    px = p0.x; py = p0.y;
    theta = phi = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    v = LOOK.cruise;
    marks.length = 0; puffs.length = 0;
  }

  function step(dt: number): number {
    const camY = scroller.scrollTop;
    // the loop of the section you're looking at (scroll-follow)
    const wantSec = sectionAtY(camY + H * 0.5);
    if (wantSec !== curIdx && built[wantSec] && built[wantSec].len > 0) {
      curIdx = wantSec;
      s = nearestLen(curIdx, px, py);
    }

    // ---- pointer engagement (cursor / touch reaction) -----------------------
    // pointer.y is VIEWPORT px → content Y is +camY, so a still cursor keeps its
    // on-screen spot as the page scrolls under it.
    const now = performance.now();
    const fresh = now - pointerAt < LOOK.pointerIdleMs;
    let pcx = 0, pcy = 0, near = false, overHero = false;
    if (pointer) {
      pcx = pointer.x; pcy = pointer.y + camY;
      near = Math.hypot(pcx - px, pcy - py) < LOOK.chaseRadius;
      // don't dive across the headline while lapping the hero (it simply doesn't
      // want to go there — the car is behind the text either way).
      if (curIdx === 0 && heroCardRect) {
        overHero = pcx > heroCardRect.x0 && pcx < heroCardRect.x1
          && pcy > heroCardRect.y0 && pcy < heroCardRect.y1;
      }
    }
    const wantChase = fresh && near && !overHero ? 1 : 0;
    const rate = wantChase > chase ? dt * 1000 / LOOK.chaseInMs : dt * 1000 / LOOK.chaseOutMs;
    chase += clamp(wantChase - chase, -rate, rate);

    const band = bands[curIdx];
    const onBand = !band || (py > band.top - H * 0.15 && py < band.bot + H * 0.15);
    const hurry = onBand ? 1 : LOOK.travelHurry;

    if (chase < 0.999) s += v * dt;      // loop progress (frozen while fully chasing)
    const loopTarget = atLen(curIdx, s + LOOK.lookaheadPx);
    let target = loopTarget;
    if (pointer && chase > 0) {
      const c = (curIdx === 0 && heroCardRect) ? clampOutOfHeroCard(pcx, pcy) : { x: pcx, y: pcy };
      target = { x: loopTarget.x + (c.x - loopTarget.x) * chase, y: loopTarget.y + (c.y - loopTarget.y) * chase };
    }

    const desired = Math.atan2(target.y - py, target.x - px);
    const err = angDiff(desired, theta);
    const steer = clamp(err / LOOK.steerRange, -1, 1);
    const omega = steer * LOOK.omegaMax * Math.min(1, v / LOOK.vRef);
    theta += omega * dt;

    phi += angDiff(theta, phi) * Math.min(1, LOOK.grip * dt);
    let beta = angDiff(theta, phi);
    if (Math.abs(beta) > LOOK.betaMax) {
      phi = theta - Math.sign(beta) * LOOK.betaMax;
      beta = angDiff(theta, phi);
    }

    const vT = LOOK.cruise * hurry * (1 - LOOK.cornerSlow * Math.min(1, Math.abs(omega) / LOOK.omegaMax));
    v += (vT - v) * Math.min(1, 2.6 * dt);

    px += Math.cos(phi) * v * dt;
    py += Math.sin(phi) * v * dt;

    // pointer let go → rejoin the loop at the nearest point (eases back in)
    if (chase < 0.02 && wantChase === 0) s = nearestLen(curIdx, px, py);

    const cp = atLen(curIdx, s);
    if ((px - cp.x) ** 2 + (py - cp.y) ** 2 > (contentW + contentH) ** 2) s = nearestLen(curIdx, px, py);

    const carLen = small ? LOOK.carLenPxSmall : LOOK.carLenPx;
    const halfW = carLen * 0.22, back = carLen * 0.30;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const rlx = px - ct * back - st * halfW, rly = py - st * back + ct * halfW;
    const rrx = px - ct * back + st * halfW, rry = py - st * back - ct * halfW;
    const seen = py > camY - H * 0.15 && py < camY + H * 1.15;

    if (effects && seen && Math.abs(beta) > LOOK.markBeta) {
      marks.push({ ax: rlx, ay: rly, bx: rrx, by: rry, age: 0 });
      if (marks.length > markMax) marks.splice(0, marks.length - markMax);
      if (Math.abs(beta) > LOOK.smokeBeta && puffs.length < smokeMax) {
        const sp = (Math.abs(beta) - LOOK.smokeBeta) * 40;
        const sideL = Math.random() < 0.5;
        puffs.push({
          x: sideL ? rlx : rrx, y: sideL ? rly : rry,
          vx: -Math.cos(phi) * sp + (Math.random() - 0.5) * 22,
          vy: -Math.sin(phi) * sp + (Math.random() - 0.5) * 22,
          age: 0, life: 0.75 + Math.random() * 0.5,
          r: carLen * (0.16 + Math.random() * 0.12),
        });
      }
    }
    for (const m of marks) m.age += dt;
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - 1.6 * dt; p.vy *= 1 - 1.6 * dt;
      p.r += GAME_CAR_PX * 0.35 * dt;
      if (p.age >= p.life) puffs.splice(i, 1);
    }
    return camY;
  }

  const SEC_COLORS = ['255, 210, 90', '255, 90, 170', '120, 230, 255', '120, 255, 170'];
  function draw(camY: number) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(0, -camY);
    const top = camY - 40, bot = camY + H + 40;

    if (debugPath) {
      for (let li = 0; li < built.length; li++) {
        const L = built[li];
        if (!L.poly.length) continue;
        const col = SEC_COLORS[li % SEC_COLORS.length];
        ctx.save();
        ctx.setLineDash([7, 7]);
        ctx.strokeStyle = `rgba(${col}, ${li === curIdx ? 0.85 : 0.4})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(L.poly[0].x, L.poly[0].y);
        for (let i = 1; i < L.poly.length; i++) ctx.lineTo(L.poly[i].x, L.poly[i].y);
        ctx.closePath(); ctx.stroke();
        ctx.restore();
      }
    }

    if (effects && marks.length > 1) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.5, GAME_CAR_PX * 0.06);
      for (let i = 1; i < marks.length; i++) {
        const m = marks[i], p = marks[i - 1];
        if (m.ay < top && p.ay < top) continue;
        if (m.ay > bot && p.ay > bot) continue;
        const a = 1 - m.age / LOOK.markLife;
        if (a <= 0) continue;
        if (Math.hypot(m.ax - p.ax, m.ay - p.ay) > GAME_CAR_PX * 1.2) continue;
        ctx.strokeStyle = `rgba(${LOOK.markRgb}, ${(a * 0.34).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(p.ax, p.ay); ctx.lineTo(m.ax, m.ay);
        ctx.moveTo(p.bx, p.by); ctx.lineTo(m.bx, m.by);
        ctx.stroke();
      }
    }

    if (effects) {
      for (const p of puffs) {
        if (p.y < top || p.y > bot) continue;
        const a = (1 - p.age / p.life) * 0.16;
        if (a <= 0) continue;
        ctx.fillStyle = `rgba(${LOOK.smokeRgb}, ${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      }
    }

    const sprite = steerexSprite(opts.skin ?? 'silver');
    const carLen = small ? LOOK.carLenPxSmall : LOOK.carLenPx;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(theta + Math.PI / 2);
    if (sprite) {
      const op = steerexOpaque();
      const sx = op ? op.cxPx - op.widPx / 2 : 0;
      const sy = op ? op.cyPx - op.lenPx / 2 : 0;
      const sw = op ? op.widPx : sprite.width;
      const sh = op ? op.lenPx : sprite.height;
      const sc = carLen / sh;
      ctx.drawImage(sprite, sx, sy, sw, sh, (-sw * sc) / 2, (-sh * sc) / 2, sw * sc, sh * sc);
    } else {
      ctx.fillStyle = 'rgba(210, 214, 222, 0.9)';
      ctx.fillRect(-carLen * 0.17, -carLen / 2, carLen * 0.34, carLen);
    }
    ctx.restore();
    ctx.restore();
  }

  const FRAME_MIN_MS = small ? 33 : 0;
  function frame(now: number) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (FRAME_MIN_MS && (now - last) < FRAME_MIN_MS) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    if (dt > 0.05) { if (++slowFrames > 45) { effects = false; marks.length = 0; puffs.length = 0; } }
    else if (slowFrames > 0) slowFrames--;
    const wasUnsized = W <= 1 || H <= 1 || !built.length || (built[curIdx]?.len ?? 0) <= 0;
    if (Math.abs(scroller.scrollHeight - contentH) > 4
      || scroller.clientWidth !== W || scroller.clientHeight !== H) {
      measure();
      if (wasUnsized && (built[curIdx]?.len ?? 0) > 0) reset();
    }
    const camY = step(dt);
    draw(camY);
  }

  function start() {
    if (running || reduced || !ctx) return;
    running = true; last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  const onResize = () => { measure(); };
  const onVis = () => { if (document.hidden) stop(); else if (active) start(); };
  // Cursor / touch → chase target. Listened on WINDOW (the canvas is
  // pointer-events:none), so it works behind all content without blocking clicks.
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    pointerAt = performance.now();
  };
  const onLeave = () => { pointer = null; };

  measure();
  reset();
  if (reduced) draw(scroller.scrollTop);

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerdown', onPointer, { passive: true });
  window.addEventListener('pointerleave', onLeave, { passive: true });

  return {
    setActive(on: boolean) {
      active = on;
      if (on) {
        measure();
        if ((built[curIdx]?.len ?? 0) > 0 && ((px - atLen(curIdx, s).x) ** 2 + (py - atLen(curIdx, s).y) ** 2) > (contentW * contentH)) reset();
        last = performance.now(); start();
      } else stop();
    },
    setLoops(loops: Waypoint[][]) { loopsWP = loops.map((l) => l.slice()); rebuild(); if (reduced && ctx) draw(scroller.scrollTop); },
    getLoops() { return loopsWP.map((l) => l.map((w) => ({ ...w }))); },
    sectionForYf(yf: number) { return sectionAtY(yf * contentH); },
    sectionCount() { return sections.length; },
    setDebugPath(on: boolean) { debugPath = on; if (!running && ctx) draw(scroller.scrollTop); },
    contentToClient(xf: number, yf: number) { return { x: xf * contentW, y: yf * contentH - scroller.scrollTop }; },
    clientToContent(x: number, y: number) { return { xf: x / contentW, yf: (y + scroller.scrollTop) / contentH }; },
    destroy() {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('pointerleave', onLeave);
    },
  };
}

export { DEFAULT_LOOPS };
