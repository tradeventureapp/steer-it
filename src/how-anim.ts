// =============================================================================
//  HOW IT WORKS — the single-source-of-truth demo animation.
//
//  ONE rAF loop drives the whole composition:
//    1. an SVG path (the circuit loop inside the monitor, traced on the real
//       screenshot) is the single source of truth;
//    2. the car's position is sampled along it;
//    3. ONE steering value = the angle between the tangent NOW and the tangent
//       a LOOKAHEAD further along (i.e. "which way is the next corner");
//    4. that one value derives BOTH the car's turning on the monitor AND the
//       tilt of the steering-wheel phone.
//
//  READABILITY OVER PHYSICS: the phone always tilts INTO the corner (no
//  countersteer). The car's drift is purely visual — a yaw offset + smoke
//  derived from the same steering value — and never feeds back into the tilt.
//  The viewer must read "tilt left → car goes left".
//
//  Perf/a11y: the loop runs ONLY while the section is on screen (Intersection-
//  Observer) and the tab is visible; prefers-reduced-motion gets one static
//  frame and no rAF at all; the phone animates via transform only.
// =============================================================================
import { steerexSprite, steerexOpaque, type SteerexSkin } from './steerex-sprite';

// ---- THE tuning knob: phone tilt (deg) at full steering lock. --------------
const TILT_SCALE = 18;

// Path/world units are the screenshot's pixel space (1536×864).
const SPEED = 310;          // px of path per second on the straights (~14 s per lap)
const CORNER_SLOW = 0.3;    // fraction of speed scrubbed at full lock (natural pace)
const LOOKAHEAD = 120;      // px ahead used to read the upcoming corner
const TANGENT_EPS = 16;     // px each side for the local tangent (wide = smooth)
const STEER_REF = 0.5;      // rad of tangent change that means full lock
const STEER_SMOOTH = 6.5;   // 1/s low-pass on the steering value (no jitter)
const CAR_LEN = 52;         // car length in path px (readable but not oversized)
const DRIFT_YAW = 0.5;      // rad of VISUAL drift yaw at full lock (never affects tilt)
const DRIFT_LAG = 3.2;      // 1/s — the drift angle builds/releases with a lag (a held slide)
const HEADING_SMOOTH = 11;  // 1/s low-pass on the drawn heading (kills sampling jitter)
const SMOKE_AT = 0.14;      // |drift yaw| (rad) that starts smoke
const SMOKE_MAX = 30;       // bounded pool
const MARK_AT = 0.1;        // |drift yaw| (rad) that starts tyre marks
const MARK_MAX = 110;       // bounded ring buffer of mark segments
const MARK_LIFE = 1.5;      // seconds a mark takes to fade
// The QR panel HUD area of the screenshot (the car passes BEHIND it, like in-game).
const PANEL = { x: 0.845, y: 0.0, w: 0.15, h: 0.48 };

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
function angDiff(b: number, a: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

type Puff = { x: number; y: number; age: number; life: number; r: number };
type Mark = { ax: number; ay: number; bx: number; by: number; age: number };

export interface HowSceneHandle {
  setEnabled(on: boolean): void;
  destroy(): void;
}

export function startHowScene(opts: {
  pathEl: SVGPathElement;      // the circuit loop (source of truth)
  canvas: HTMLCanvasElement;   // overlay inside the monitor (car + smoke)
  screenImg: HTMLImageElement; // the circuit screenshot (for the HUD mask)
  wheelEl: HTMLElement;        // the steering-wheel phone (tilted via transform)
  skin?: SteerexSkin;
}): HowSceneHandle {
  const { pathEl, canvas, screenImg, wheelEl } = opts;
  const skin = opts.skin ?? 'silver';
  const ctx = canvas.getContext('2d');
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = typeof matchMedia === 'function'
    && (matchMedia('(hover: none)').matches || matchMedia('(max-width: 720px)').matches);

  // ---- presample the SVG path into a uniform-by-length table (once) --------
  const total = pathEl.getTotalLength();
  const N = 1440;
  const px = new Float32Array(N), py = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = pathEl.getPointAtLength((i / N) * total);
    px[i] = p.x; py[i] = p.y;
  }
  const at = (s: number): [number, number] => {
    let t = (s % total + total) % total;
    const f = (t / total) * N;
    const i = Math.floor(f) % N, j = (i + 1) % N, u = f - Math.floor(f);
    return [px[i] + (px[j] - px[i]) * u, py[i] + (py[j] - py[i]) * u];
  };
  const tangentAt = (s: number): number => {
    const a = at(s - TANGENT_EPS), b = at(s + TANGENT_EPS);
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };

  // ---- state ----------------------------------------------------------------
  let s = 0;                       // arc position
  let steer = 0;                   // THE steering value (smoothed, −1..1)
  let drift = 0;                   // VISUAL drift yaw (rad) — lags the steer = a held slide
  let heading = 0;                 // smoothed drawn heading
  let headingInit = false;
  const puffs: Puff[] = [];
  const marks: Mark[] = [];
  let W = 0, H = 0, dpr = 1, k = 1;   // canvas metrics; k = css-px per path-px

  function measure() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    k = W / 1536;
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    // tyre marks first (on the tarmac, under everything)
    if (marks.length > 1) {
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, CAR_LEN * 0.07 * k);
      for (let i = 1; i < marks.length; i++) {
        const m = marks[i], p = marks[i - 1];
        const a = 1 - m.age / MARK_LIFE;
        if (a <= 0) continue;
        // a gap in the trail (drift re-entered elsewhere) → don't bridge it
        if (Math.hypot(m.ax - p.ax, m.ay - p.ay) > CAR_LEN) continue;
        ctx.strokeStyle = `rgba(18, 18, 26, ${(a * 0.32).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(p.ax * k, p.ay * k); ctx.lineTo(m.ax * k, m.ay * k);
        ctx.moveTo(p.bx * k, p.by * k); ctx.lineTo(m.bx * k, m.by * k);
        ctx.stroke();
      }
    }

    // smoke (under the car)
    for (const p of puffs) {
      const a = (1 - p.age / p.life) * 0.16;
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(235, 235, 242, ${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x * k, p.y * k, p.r * k, 0, TAU); ctx.fill();
    }

    // the car — REAL sprite at the SMOOTHED heading (tangent + held drift yaw)
    const [x, y] = at(s);
    const sprite = steerexSprite(skin);
    ctx.save();
    ctx.translate(x * k, y * k);
    ctx.rotate(heading + Math.PI / 2);        // sprite nose is UP
    const len = CAR_LEN * k;
    if (sprite) {
      const op = steerexOpaque();
      const sx = op ? op.cxPx - op.widPx / 2 : 0;
      const sy = op ? op.cyPx - op.lenPx / 2 : 0;
      const sw = op ? op.widPx : sprite.width;
      const sh = op ? op.lenPx : sprite.height;
      const sc = len / sh;
      ctx.drawImage(sprite, sx, sy, sw, sh, (-sw * sc) / 2, (-sh * sc) / 2, sw * sc, sh * sc);
    } else {
      ctx.fillStyle = 'rgba(210, 214, 222, 0.9)';
      ctx.fillRect(-len * 0.18, -len / 2, len * 0.36, len);
    }
    ctx.restore();

    // HUD mask — re-blit the QR panel over the car so it passes BEHIND the panel
    if (screenImg.naturalWidth > 0) {
      const iw = screenImg.naturalWidth, ih = screenImg.naturalHeight;
      ctx.drawImage(screenImg,
        PANEL.x * iw, PANEL.y * ih, PANEL.w * iw, PANEL.h * ih,
        PANEL.x * W, PANEL.y * H, PANEL.w * W, PANEL.h * H);
    }
  }

  function step(dt: number) {
    // corners scrub speed (steer is smooth, so the pace eases in/out naturally)
    s += SPEED * (1 - CORNER_SLOW * Math.abs(steer)) * dt;
    // ONE steering value: tangent now vs tangent a lookahead ahead.
    const raw = clamp(angDiff(tangentAt(s + LOOKAHEAD), tangentAt(s)) / STEER_REF, -1, 1);
    steer += (raw - steer) * Math.min(1, STEER_SMOOTH * dt);

    // the VISUAL drift yaw lags the steering — the slide builds, hangs through the
    // corner and releases smoothly on exit (never feeds back into the tilt)
    drift += (steer * DRIFT_YAW - drift) * Math.min(1, DRIFT_LAG * dt);

    // the drawn heading is low-passed too, so it can never step frame-to-frame
    const target = tangentAt(s) + drift;
    if (!headingInit) { heading = target; headingInit = true; }
    heading += angDiff(target, heading) * Math.min(1, HEADING_SMOOTH * dt);

    const [x, y] = at(s);
    const back = heading + Math.PI;
    const halfW = CAR_LEN * 0.2, backOff = CAR_LEN * 0.34;

    // tyre marks from the rear axle while sliding (bounded ring buffer)
    if (Math.abs(drift) > MARK_AT) {
      const bx = x + Math.cos(back) * backOff, by = y + Math.sin(back) * backOff;
      const nx = Math.cos(heading + Math.PI / 2), ny = Math.sin(heading + Math.PI / 2);
      marks.push({ ax: bx - nx * halfW, ay: by - ny * halfW, bx: bx + nx * halfW, by: by + ny * halfW, age: 0 });
      if (marks.length > MARK_MAX) marks.splice(0, marks.length - MARK_MAX);
    }
    for (const m of marks) m.age += dt;
    while (marks.length && marks[0].age >= MARK_LIFE) marks.shift();

    // soft smoke while sliding (visual only)
    if (Math.abs(drift) > SMOKE_AT && puffs.length < SMOKE_MAX) {
      puffs.push({
        x: x + Math.cos(back) * CAR_LEN * 0.42 + (Math.random() - 0.5) * 8,
        y: y + Math.sin(back) * CAR_LEN * 0.42 + (Math.random() - 0.5) * 8,
        age: 0, life: 0.7 + Math.random() * 0.4, r: 6 + Math.random() * 6,
      });
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.age += dt; p.r += 13 * dt;
      if (p.age >= p.life) puffs.splice(i, 1);
    }

    // BOTH outputs from the SAME steering value:
    draw();                                                        // car turn (canvas)
    wheelEl.style.transform = `rotate(${(steer * TILT_SCALE).toFixed(2)}deg)`;  // phone tilt
  }

  // ---- loop gating ----------------------------------------------------------
  let enabled = false, onScreen = false, running = false, raf = 0, last = 0;
  const FRAME_MIN_MS = small ? 33 : 0;    // ~30 fps cap on phones
  function frame(now: number) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (FRAME_MIN_MS && now - last < FRAME_MIN_MS) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    step(dt);
  }
  function sync() {
    const want = enabled && onScreen && !document.hidden && !reduced;
    if (want && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
    else if (!want && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  }

  const io = ('IntersectionObserver' in window)
    ? new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); sync(); }, { threshold: 0.12 })
    : null;
  const onResize = () => { measure(); if (!running) draw(); };
  const onVis = () => sync();

  measure();
  // Static first frame (also THE frame under prefers-reduced-motion): the car on
  // the start straight, the wheel phone at a slight readable tilt.
  steer = reduced ? -0.45 : 0;
  drift = steer * DRIFT_YAW;
  heading = tangentAt(s) + drift;
  headingInit = true;
  draw();
  if (reduced) wheelEl.style.transform = `rotate(${(steer * TILT_SCALE).toFixed(1)}deg)`;
  if (io) io.observe(canvas); else onScreen = true;
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVis);
  // repaint the parked frame once the sprite/screenshot decode late
  if (!steerexSprite(skin)) setTimeout(() => { if (!running) draw(); }, 350);
  if (!screenImg.complete) screenImg.addEventListener('load', () => { if (!running) draw(); }, { once: true });

  return {
    setEnabled(on: boolean) { enabled = on; sync(); },
    destroy() {
      running = false; if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
