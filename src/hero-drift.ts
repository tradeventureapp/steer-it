// =============================================================================
//  HERO DRIFT — the landing-page Stee-Rex that drifts around the headline.
//
//  Purely decorative + purely client-side: no server calls, no Supabase, no game
//  state. It draws the REAL Stee-Rex sprite with the game's drift feel (sideways
//  slide, tyre marks, smoke) on a canvas that sits BEHIND the headline/CTAs and
//  never takes a pointer event, so the page's job always comes first.
//
//  BEHAVIOUR (hybrid):
//    • DEFAULT   — laps a smooth loop AROUND the headline (a rounded-rect circuit
//                  built OUTSIDE the hero's bounding box), drifting through the
//                  corners. Alive with zero interaction.
//    • POINTER   — when the cursor/touch comes near, the car steers toward it and
//                  chases it (jerk it and the car slides). Let go and it eases
//                  back onto its loop. The chase target is CLAMPED out of the
//                  headline box, so the text never gets covered even when chased.
//    • REDUCED   — prefers-reduced-motion: one static parked frame, no loop.
//
//  The whole thing is a kinematic model (heading + velocity direction + speed),
//  not the game's physics4 — it only has to LOOK like the game, and this keeps
//  the landing page's frame budget tiny.
// =============================================================================
import { steerexSprite, steerexOpaque, type SteerexSkin } from './steerex-sprite';
import { STEEREX_DIMS } from './vehicles';
import { CONFIG } from './vehicle-core';

// The hero car is drawn at EXACTLY its in-game size — same metres, same px-per-metre
// as the race (≈30 px long), derived from the game's own constants so it can never
// drift out of sync. It must never look bigger than the car you actually drive.
const GAME_CAR_PX = STEEREX_DIMS.lengthM * CONFIG.pxPerMeter;
// Game pace on the same ruler — a proper racing speed (~120 km/h ⇒ 33 m/s), so it moves
// across the screen exactly as fast as it does in a race, not a decorative crawl.
const GAME_CRUISE_PX = 33 * CONFIG.pxPerMeter;

export interface HeroDriftOptions {
  /** Element the loop must stay OUTSIDE of (the headline + CTA card). */
  keepOut: HTMLElement | null;
  /** Sprite skin to drive. */
  skin?: SteerexSkin;
}

export interface HeroDriftHandle {
  /** Run only while the hero is on screen — stops the rAF entirely when false. */
  setActive(on: boolean): void;
  /** Debug/preview only: outline the loop + the keep-out box. Off in production. */
  setDebugPath(on: boolean): void;
  destroy(): void;
}

// ---- tunables ---------------------------------------------------------------
const LOOK = {
  carLenPx: GAME_CAR_PX,       // EXACTLY the in-game car size (never larger)
  carLenPxSmall: GAME_CAR_PX,  // same on touch — it's already small
  cruise: GAME_CRUISE_PX,      // px/s along the loop (game pace on the game's ruler)
  vRef: 70,                // speed at which steering reaches full authority
  omegaMax: 3.1,           // rad/s max yaw
  steerRange: 1.0,         // rad of heading error that maps to full lock (softer = less twitchy)
  // How fast the velocity direction catches the heading. LOWER = the slide is held longer,
  // so the drift angle settles at ω/grip instead of snapping straight — this is the knob
  // that makes the drift look sustained rather than flicky.
  grip: 2.5,
  betaMax: 0.70,           // rad (~40°) — hard cap so it can never spin out
  cornerSlow: 0.42,        // how much a hard corner scrubs speed
  lookaheadPx: GAME_CAR_PX * 2.2,   // aim ~2 car lengths up the loop
  chaseRadius: 360,        // cursor must be this close (px) to grab the car
  chaseInMs: 260,          // ramp on/off so the hand-off is never a snap
  chaseOutMs: 900,
  pointerIdleMs: 1400,     // no movement for this long → back to the loop
  markBeta: 0.20,          // rad of slide before tyres start marking
  smokeBeta: 0.30,
  // Brand: neon sunset. Dark scuff would vanish on the purple bloom, so the
  // marks read as a magenta tyre glow and the smoke as warm sunset haze.
  markRgb: '255, 74, 160',
  smokeRgb: '255, 176, 132',
};
const MARK_MAX = 190;        // ring-buffer length (per wheel pair) — bounded, no growth
const MARK_MAX_SMALL = 90;
const SMOKE_MAX = 54;
const SMOKE_MAX_SMALL = 16;
const LOOP_SAMPLES = 240;    // polyline resolution of the loop

type Pt = { x: number; y: number };
type Mark = { ax: number; ay: number; bx: number; by: number; age: number };
type Puff = { x: number; y: number; vx: number; vy: number; age: number; life: number; r: number };

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Shortest signed angle a→b, in (−π, π]. */
function angDiff(b: number, a: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * The loop: a rounded rectangle that RINGS the keep-out box (the headline+CTA),
 * inset from the viewport edges. Straights + tight-ish corners is what makes the
 * car actually drift — a plain ellipse would just grip all the way round.
 */
function buildLoop(w: number, h: number, keep: DOMRect | null): Pt[] {
  const edge = Math.min(w, h) * 0.05 + 12;          // margin from the viewport edge
  // The loop HUGS the headline: it runs a fixed, modest gap outside the hero box rather
  // than halfway out to the screen edge — the car's home is around the logo, not the
  // borders. Only a narrow window pulls it in toward the edge, and it can never end up
  // closer than `minGap` to the text.
  const kx0 = keep ? keep.left : w * 0.5 - 200;
  const kx1 = keep ? keep.right : w * 0.5 + 200;
  const ky0 = keep ? keep.top : h * 0.5 - 120;
  const ky1 = keep ? keep.bottom : h * 0.5 + 120;
  // Tuned by sweeping (shape × gap) against the real hero box: the closest orbit that still
  // clears the text everywhere AND keeps the car sliding ~78% of the lap.
  const ringGap = GAME_CAR_PX * 2.85;
  const minGap = GAME_CAR_PX;                       // never closer than one car length

  const L = Math.min(Math.max(kx0 - ringGap, edge), kx0 - minGap);
  const R = Math.max(Math.min(kx1 + ringGap, w - edge), kx1 + minGap);
  const T = Math.min(Math.max(ky0 - ringGap, edge), ky0 - minGap);
  const B = Math.max(Math.min(ky1 + ringGap, h - edge), ky1 + minGap);

  const rw = Math.max(40, R - L), rh = Math.max(40, B - T);
  const pts: Pt[] = [];
  for (let i = 0; i < LOOP_SAMPLES; i++) {
    // Superellipse-ish rounded rect via a squashed parametric corner blend.
    const t = (i / LOOP_SAMPLES) * TAU;
    const c = Math.cos(t), s = Math.sin(t);
    // Near-elliptical (not squarish): curvature stays high the WHOLE way round, so the car
    // holds one continuous slide instead of gripping the straights and only drifting the
    // corners. A steady orbiting drift, not an intermittent one.
    const n = 2.6;
    const ax = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const ay = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    pts.push({ x: (L + R) / 2 + (rw / 2) * ax, y: (T + B) / 2 + (rh / 2) * ay });
  }

  // CLEARANCE GUARD — a rounded loop cuts the CORNERS of a wide headline box, so on some
  // viewport/card ratios a point could land right on the text. Push any such point out to
  // the box inflated by minGap. Runs once per resize over 240 points (free), and makes the
  // clearance structural instead of something the tuning has to get right on every screen.
  const ex0 = kx0 - minGap, ex1 = kx1 + minGap, ey0 = ky0 - minGap, ey1 = ky1 + minGap;
  for (const p of pts) {
    if (p.x > ex0 && p.x < ex1 && p.y > ey0 && p.y < ey1) {
      const dl = p.x - ex0, dr = ex1 - p.x, dtp = p.y - ey0, db = ey1 - p.y;
      const m = Math.min(dl, dr, dtp, db);
      if (m === dl) p.x = ex0; else if (m === dr) p.x = ex1;
      else if (m === dtp) p.y = ey0; else p.y = ey1;
    }
  }
  return pts;
}

export function startHeroDrift(
  canvas: HTMLCanvasElement, opts: HeroDriftOptions,
): HeroDriftHandle {
  const ctx = canvas.getContext('2d');
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Touch / weak device → fewer effects, smaller car, lower backing resolution.
  const small = typeof matchMedia === 'function'
    && (matchMedia('(hover: none)').matches || matchMedia('(max-width: 720px)').matches);

  let markMax = small ? MARK_MAX_SMALL : MARK_MAX;
  let smokeMax = small ? SMOKE_MAX_SMALL : SMOKE_MAX;
  let effects = !reduced;                 // adaptive: killed if the frame budget slips

  let W = 0, H = 0, dpr = 1;
  let loop: Pt[] = [];
  let loopLen = 0;
  const seg: number[] = [];               // cumulative arc length per loop point

  // --- car state (kinematic) ---
  let px = 0, py = 0;                     // position
  let theta = 0;                          // heading (where the nose points)
  let phi = 0;                            // velocity direction
  let v = LOOK.cruise;
  let s = 0;                              // progress along the loop (arc length)

  const marks: Mark[] = [];
  const puffs: Puff[] = [];

  // --- pointer ---
  let pointer: Pt | null = null;
  let pointerAt = -1e9;
  let chase = 0;                          // 0 = loop, 1 = fully chasing the pointer

  let running = false, active = false, raf = 0, last = 0;
  let debugPath = false;
  let slowFrames = 0;

  function measure() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);

    const keep = opts.keepOut ? opts.keepOut.getBoundingClientRect() : null;
    const cr = canvas.getBoundingClientRect();
    // keep-out in canvas-local coords
    const kRect = keep
      ? new DOMRect(keep.left - cr.left, keep.top - cr.top, keep.width, keep.height)
      : null;
    loop = buildLoop(W, H, kRect);
    seg.length = 0;
    loopLen = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      seg.push(loopLen);
      loopLen += Math.hypot(b.x - a.x, b.y - a.y);
    }
    keepRect = kRect;
  }
  let keepRect: DOMRect | null = null;

  /** Point at arc-length `d` around the loop. */
  function atLen(d: number): Pt {
    if (!loop.length || loopLen <= 0) return { x: W / 2, y: H / 2 };
    let t = d % loopLen; if (t < 0) t += loopLen;
    // binary search the segment
    let lo = 0, hi = seg.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (seg[m] <= t) lo = m; else hi = m - 1; }
    const a = loop[lo], b = loop[(lo + 1) % loop.length];
    const segLen = (lo + 1 < seg.length ? seg[lo + 1] : loopLen) - seg[lo];
    const f = segLen > 0 ? (t - seg[lo]) / segLen : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  /** Arc length of the loop point nearest to (x,y) — used to rejoin smoothly. */
  function nearestLen(x: number, y: number): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < loop.length; i++) {
      const d = (loop[i].x - x) ** 2 + (loop[i].y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return seg[best];
  }

  /** Push a chase target OUT of the headline box so the car never sits on the text. */
  function clampOutOfKeep(p: Pt): Pt {
    const k = keepRect;
    if (!k) return p;
    const pad = 12;
    if (p.x < k.left - pad || p.x > k.right + pad || p.y < k.top - pad || p.y > k.bottom + pad) return p;
    // inside → push to the nearest edge
    const dl = p.x - (k.left - pad), dr = (k.right + pad) - p.x;
    const dt = p.y - (k.top - pad), db = (k.bottom + pad) - p.y;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: k.left - pad, y: p.y };
    if (m === dr) return { x: k.right + pad, y: p.y };
    if (m === dt) return { x: p.x, y: k.top - pad };
    return { x: p.x, y: k.bottom + pad };
  }

  function reset() {
    s = 0;
    const p0 = atLen(0), p1 = atLen(40);
    px = p0.x; py = p0.y;
    theta = phi = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    v = LOOK.cruise;
    marks.length = 0; puffs.length = 0;
  }

  // ---- simulation ----------------------------------------------------------
  function step(dt: number) {
    // pointer engagement: near enough + moved recently. A cursor sitting ON the headline
    // is NOT chased — the car keeps to its loop rather than diving across the text (again:
    // it simply doesn't want to go there; nothing blocks it).
    const fresh = performance.now() - pointerAt < LOOK.pointerIdleMs;
    const near = !!pointer && Math.hypot(pointer.x - px, pointer.y - py) < LOOK.chaseRadius;
    const overText = !!pointer && !!keepRect
      && pointer.x > keepRect.left && pointer.x < keepRect.right
      && pointer.y > keepRect.top && pointer.y < keepRect.bottom;
    const want = fresh && near && !overText ? 1 : 0;
    const rate = want > chase ? dt * 1000 / LOOK.chaseInMs : dt * 1000 / LOOK.chaseOutMs;
    chase += clamp(want - chase, -rate, rate);

    if (chase < 0.999) s += v * dt;               // loop progress (frozen while fully chasing)
    const loopTarget = atLen(s + LOOK.lookaheadPx);
    let target = loopTarget;
    if (pointer && chase > 0) {
      const c = clampOutOfKeep(pointer);
      target = { x: loopTarget.x + (c.x - loopTarget.x) * chase,
        y: loopTarget.y + (c.y - loopTarget.y) * chase };
    }

    // steer toward the target
    let desired = Math.atan2(target.y - py, target.x - px);

    // SOFT avoidance around the headline — NOT a wall. There is no barrier the car can
    // hit: if it drifts toward the logo zone its DESIRED HEADING is bent away, so it
    // arcs around the text under its own steering. The nearer the middle, the stronger
    // the bend, and it fades to nothing at the boundary (no edge to bump into).
    if (keepRect) {
      const cx = keepRect.x + keepRect.width / 2, cy = keepRect.y + keepRect.height / 2;
      // The field is deliberately SMALLER than the loop's own gap from the text, so the
      // car's normal lap sits completely outside it and never feels a constant push
      // outward (that's what was shoving it into the screen edges). It only ever acts if
      // something actually drags the car in toward the headline.
      const pad = GAME_CAR_PX * 0.9;   // < ringGap (2×), so the orbit never feels a push
      const halfW = keepRect.width / 2 + pad;
      const halfH = keepRect.height / 2 + pad;
      // box-shaped distance: 0 at the centre, 1 on the (padded) boundary
      const d = Math.max(Math.abs(px - cx) / halfW, Math.abs(py - cy) / halfH);
      if (d < 1) {
        const away = Math.atan2(py - cy, px - cx);
        const w = Math.min(1, (1 - d) * 2.4);        // ramp in smoothly, reach full authority
        desired += angDiff(away, desired) * w;
      }
    }

    const err = angDiff(desired, theta);
    const steer = clamp(err / LOOK.steerRange, -1, 1);
    const omega = steer * LOOK.omegaMax * Math.min(1, v / LOOK.vRef);
    theta += omega * dt;

    // velocity direction chases the heading — the LAG is the drift angle
    phi += angDiff(theta, phi) * Math.min(1, LOOK.grip * dt);
    let beta = angDiff(theta, phi);
    if (Math.abs(beta) > LOOK.betaMax) {          // hard cap → can never spin out
      phi = theta - Math.sign(beta) * LOOK.betaMax;
      beta = angDiff(theta, phi);
    }

    // scrub speed in the corners, then recover
    const vT = LOOK.cruise * (1 - LOOK.cornerSlow * Math.min(1, Math.abs(omega) / LOOK.omegaMax));
    v += (vT - v) * Math.min(1, 2.6 * dt);

    px += Math.cos(phi) * v * dt;
    py += Math.sin(phi) * v * dt;

    // when the pointer lets go, rejoin the loop at the nearest point
    if (chase < 0.02 && want === 0) s = nearestLen(px, py);

    // NO WALLS ANYWHERE — not around the logo, not at the screen edge. If the pointer
    // drags the car off the side it simply DRIVES OFF the edge and comes back in on its
    // own (the loop target is on-screen, so its steering already points home). Bumping
    // along an invisible border looked wrong, so there is no border to bump along.
    // The only safety is a far-field leash: if it somehow ends up absurdly far out (a
    // stray pointer event off-window), snap the loop progress to the nearest point so it
    // heads straight back — it is never stopped, only re-aimed.
    const outX = Math.max(0, Math.abs(px - W / 2) - W), outY = Math.max(0, Math.abs(py - H / 2) - H);
    if (outX > 0 || outY > 0) { s = nearestLen(px, py); }

    // ---- tyre marks + smoke (both bounded; skipped when effects are off) ----
    const carLen = small ? LOOK.carLenPxSmall : LOOK.carLenPx;
    const halfW = carLen * 0.22, back = carLen * 0.30;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const rlx = px - ct * back - st * halfW, rly = py - st * back + ct * halfW;
    const rrx = px - ct * back + st * halfW, rry = py - st * back - ct * halfW;

    if (effects && Math.abs(beta) > LOOK.markBeta) {
      marks.push({ ax: rlx, ay: rly, bx: rrx, by: rry, age: 0 });
      if (marks.length > markMax) marks.splice(0, marks.length - markMax);
      if (Math.abs(beta) > LOOK.smokeBeta && puffs.length < smokeMax) {
        const sp = (Math.abs(beta) - LOOK.smokeBeta) * 40;
        const side = Math.random() < 0.5;
        puffs.push({
          x: side ? rlx : rrx, y: side ? rly : rry,
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
      p.age += dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - 1.6 * dt; p.vy *= 1 - 1.6 * dt;
      p.r += GAME_CAR_PX * 0.35 * dt;      // grow in proportion to the (game-sized) car
      if (p.age >= p.life) puffs.splice(i, 1);
    }
    return beta;
  }

  // ---- render --------------------------------------------------------------
  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    // preview aid only (default off): the loop the car laps + the box it must stay out of
    if (debugPath && loop.length) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(120, 230, 255, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(loop[0].x, loop[0].y);
      for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i].x, loop[i].y);
      ctx.closePath(); ctx.stroke();
      if (keepRect) {
        ctx.strokeStyle = 'rgba(255, 210, 90, 0.55)';
        ctx.strokeRect(keepRect.x, keepRect.y, keepRect.width, keepRect.height);
      }
      ctx.restore();
    }

    // tyre marks — two continuous rubber lines (one per rear wheel) that fade with
    // age. Ring-buffered, so the cost is bounded no matter how long the page sits.
    if (effects && marks.length > 1) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.5, GAME_CAR_PX * 0.06);
      const life = 2.6;
      for (let i = 1; i < marks.length; i++) {
        const m = marks[i], p = marks[i - 1];
        const a = 1 - m.age / life;
        if (a <= 0) continue;
        // a break in the trail (car re-entered a slide elsewhere) → don't bridge it
        if (Math.hypot(m.ax - p.ax, m.ay - p.ay) > GAME_CAR_PX * 1.2) continue;
        ctx.strokeStyle = `rgba(${LOOK.markRgb}, ${(a * 0.34).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(p.ax, p.ay); ctx.lineTo(m.ax, m.ay);
        ctx.moveTo(p.bx, p.by); ctx.lineTo(m.bx, m.by);
        ctx.stroke();
      }
    }

    // smoke
    if (effects) {
      for (const p of puffs) {
        const a = (1 - p.age / p.life) * 0.16;
        if (a <= 0) continue;
        ctx.fillStyle = `rgba(${LOOK.smokeRgb}, ${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      }
    }

    // the car
    const sprite = steerexSprite(opts.skin ?? 'silver');
    const carLen = small ? LOOK.carLenPxSmall : LOOK.carLenPx;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(theta + Math.PI / 2);          // sprite nose is UP → +90° faces +x
    if (sprite) {
      const op = steerexOpaque();
      const sx = op ? op.cxPx - op.widPx / 2 : 0;
      const sy = op ? op.cyPx - op.lenPx / 2 : 0;
      const sw = op ? op.widPx : sprite.width;
      const sh = op ? op.lenPx : sprite.height;
      const sc = carLen / sh;
      ctx.drawImage(sprite, sx, sy, sw, sh, (-sw * sc) / 2, (-sh * sc) / 2, sw * sc, sh * sc);
    } else {
      // sprite not decoded yet — a brand-tinted placeholder so nothing pops in blank
      ctx.fillStyle = 'rgba(210, 214, 222, 0.9)';
      ctx.fillRect(-carLen * 0.17, -carLen / 2, carLen * 0.34, carLen);
    }
    ctx.restore();
  }

  function frame(now: number) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    // adaptive quality — if we're consistently missing the budget, drop effects
    if (dt > 0.034) { if (++slowFrames > 45) { effects = false; marks.length = 0; puffs.length = 0; } }
    else if (slowFrames > 0) slowFrames--;
    step(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduced || !ctx) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // ---- wiring --------------------------------------------------------------
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    pointerAt = performance.now();
  };
  const onLeave = () => { pointer = null; };
  const onResize = () => { measure(); };
  const onVis = () => { if (document.hidden) stop(); else if (active) start(); };

  measure();
  reset();
  if (reduced) { draw(); }        // static parked frame, no loop

  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerdown', onPointer, { passive: true });
  window.addEventListener('pointerleave', onLeave, { passive: true });
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVis);

  return {
    setDebugPath(on: boolean) { debugPath = on; if (!running) draw(); },
    setActive(on: boolean) {
      active = on;
      if (on) { measure(); if (!running) { last = performance.now(); } start(); }
      else stop();
    },
    destroy() {
      stop();
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
