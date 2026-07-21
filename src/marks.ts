// =============================================================================
//  Steer It — TYRE MARKS: threshold + per-surface saturation (no fading, ever)
// =============================================================================
//
// Marks NEVER disappear: rubber does not evaporate, dug turf does not regrow, gravel does
// not resettle. The track stops going solid after a long session because of two mechanisms,
// neither of which is decay:
//
//  1. THRESHOLD — a mark is laid only where the tyre is genuinely grinding energy into the
//     ground. intensity = f(slip energy) = wheel load × contact slip speed. Normal cornering
//     (a couple of degrees of slip) falls under the floor and marks NOTHING; above it the
//     alpha scales continuously, so a moderate scrub is faint and only a committed drift or
//     a burnout lays dark rubber. This is the main fix against "painting".
//
//  2. SATURATION — repeated passes approach a per-surface cap ASYMPTOTICALLY, then stop.
//     This falls straight out of source-over compositing: stamping alpha `a` into the layer
//     gives A' = A + a(1 − A), so every pass adds less and A → 1. The CAP is then baked into
//     HOW the layer is composited, which is why there are exactly two layers:
//
//       • MULTIPLY (asphalt, kerbs, gravel) — the stamp colour IS the multiply factor, so a
//         saturated pixel is surface × factor: it DARKENS while preserving what is beneath.
//         That is what keeps a saturated kerb showing its red/white/blue, a saturated racing
//         line reading as asphalt rather than black, and disturbed gravel reading as gravel
//         with its grain intact. Each surface's cap IS its factor.
//       • SOURCE-OVER (grass) — dug turf is a HUE change (green → brown), which multiply
//         cannot do (it only darkens). Its cap is the layer's draw alpha.
//
// Memory is FIXED: two bitmaps sized once. Nothing accumulates in an array, so this also
// retires the unbounded skid-line list that was the real performance time-bomb.

import { CONFIG, bodyToWorld, type CarState } from './vehicle-core';
import { wheelDebug, PHYS4 } from './physics4';
import { sizeCanvasFitted } from './surfaces';
import type { Surface, MarkClass } from './maps';

// ---- TUNE: intensity ----------------------------------------------------------------
// Slip energy = load(N) × slip speed(m/s) ≈ the power that contact patch grinds away.
// Measured on the real car: a clean 1.5 g corner ≈ 2 kN × 0.6 m/s ≈ 1.2 kW per wheel; a
// committed drift ≈ 2.5 kN × 11 m/s ≈ 28 kW; a standing burnout ≈ 30 kW.
export const MARK = {
  // THE GATE — how far PAST the tyre's own friction peak this wheel must be before it lays
  // anything, as a multiple of the peak. MEASURED (see the calibration probe): a gripped
  // limit corner runs at 11.3° median / 14.4° peak slip and the car is NOT sliding, while a
  // committed drift sits at 29.5°. Energy alone CANNOT separate those two — the gripped
  // corner is FASTER, so it dissipates MORE power (26.5 kW vs the drift's 9.9 kW median).
  // Sliding past the peak is the physically real thing that deposits rubber, so that is the
  // gate; energy then only decides how DARK it goes. 1.5 clears the measured 14.8° worst
  // case of a legitimate max-grip corner.
  slideMargin: 1.5,
  energyMin: 1500,     // W — noise floor (a slide that has nearly stopped stops marking)
  energyFull: 30000,   // W — at/above this: full-strength stamp
  rate: 0.055,         // stamp alpha per frame at full intensity → how fast it saturates

  // ---- TUNE: per-surface saturation caps ----
  // MULTIPLY factors (rgb): a fully saturated pixel = surface × factor/255. Lower = darker.
  mulAsphalt: '150,150,154',   // ×0.59 — a real circuit's rubbered-in racing line
  // Kerbs get the STRONGEST rubber on the track, not the weakest: black rubber on a WHITE
  // block is the highest-contrast mark anywhere, and race kerbs get visibly blackened. ×0.83
  // was near-invisible (white 232 -> 193). ×0.50 blackens the white to 116 while the pattern
  // stays obvious — red 101,28,24 vs white 116,116,119 vs blue 24,56,101 (see the sweep).
  mulKerb:    '128,128,131',   // ×0.50 — scuffed kerb, NOT a black band
  mulGravel:  '184,181,172',   // ×0.72 — disturbed stone, grain intact
  // SOURCE-OVER (grass): dug turf brown, and the alpha cap it approaches (1.0 = a decal).
  grassRgb:   '96,68,40',
  grassCap:   0.82,

  // Widths in LOGICAL px: rubber is a tyre-width line, gouges are wider.
  wAsphalt: 3, wKerb: 3, wGrass: 5, wGravel: 7,
};

const WIDTH: Record<MarkClass, keyof typeof MARK> = {
  asphalt: 'wAsphalt', kerb: 'wKerb', grass: 'wGrass', gravel: 'wGravel',
};
const MUL: Record<string, keyof typeof MARK> = {
  asphalt: 'mulAsphalt', kerb: 'mulKerb', gravel: 'mulGravel',
};

/**
 * Per-wheel slip energy (W): load × the speed the contact patch is being ground across the
 * ground at. Built from what physics4 already exposes, plus the wheel's own contact velocity
 * (reconstructed from the body state — the same rigid-body relation physics4 uses internally).
 */
export function slipEnergy(state: CarState, i: number): number {
  const st = wheelDebug(state);
  if (!st) return 0;
  // This wheel's contact-point velocity, in the body frame: v_body + ω × r.
  const cos = Math.cos(state.heading), sin = Math.sin(state.heading);
  const vbx = state.vx * cos + state.vy * sin;
  const vby = -state.vx * sin + state.vy * cos;
  const rx = (i < 2 ? +1 : -1) * CONFIG.wheelbase / 2;
  const ry = (i % 2 === 0 ? -1 : +1) * CONFIG.trackWidth / 2;
  const vlong = vbx - state.angularVel * ry;
  const vlat = vby + state.angularVel * rx;
  const vc = Math.hypot(vlong, vlat);
  // LATERAL: the patch is dragged sideways at |v_contact|·sin(slip angle).
  const lat = vc * Math.abs(Math.sin(st.slip[i]));
  // LONGITUDINAL (driven wheels only): κ = (ω·r − vlong)/max(|vlong|,3), so the real slip
  // speed in m/s is κ·max(|vlong|,3). It MUST use this wheel's own vlong — using the car's
  // total speed inflates it wildly once the car is sideways (vlong collapses, speed doesn't).
  const lon = i >= 2
    ? Math.abs(st.slipRatio[i - 2]) * Math.max(Math.abs(vlong), 3)
    : 0;
  return st.load[i] * Math.hypot(lat, lon);
}
/**
 * Is this tyre PAST its friction peak, i.e. genuinely sliding rather than gripping?
 * The peaks are derived from the car's own Magic-Formula coefficients (Fy = D·sin(C·atan(B·α))
 * peaks where C·atan(B·α) = π/2), so a tyre retune moves the gate automatically instead of
 * silently invalidating a hardcoded angle. Lateral OR longitudinal counts — a wheel locked
 * dead straight has ZERO slip angle but is very much laying rubber.
 */
function sliding(state: CarState, i: number): boolean {
  const st = wheelDebug(state);
  if (!st) return false;
  const aPeak = Math.tan(Math.PI / (2 * PHYS4.tireC)) / PHYS4.tireB;
  const kPeak = Math.tan(Math.PI / (2 * PHYS4.tireCx)) / PHYS4.tireBx;
  if (Math.abs(st.slip[i]) > aPeak * MARK.slideMargin) return true;
  return i >= 2 && Math.abs(st.slipRatio[i - 2]) > kPeak * MARK.slideMargin;
}
/**
 * 0 unless this wheel is SLIDING, then ramping with slip energy. THE anti-painting gate:
 * normal cornering — however hard — leaves nothing, and only a real slide darkens.
 */
export function markIntensity(state: CarState, i: number): number {
  if (!sliding(state, i)) return 0;
  const e = slipEnergy(state, i);
  if (e <= MARK.energyMin) return 0;
  return Math.min(1, (e - MARK.energyMin) / (MARK.energyFull - MARK.energyMin));
}
/**
 * A wheel DIGS when it is spinning up or scrubbing sideways — the same gate the smoke uses.
 * Off-tarmac this rides ON TOP of the energy threshold: a wheel rolling calmly across grass
 * or through a trap disturbs nothing, however fast it is travelling.
 */
function digging(state: CarState, slip: number, rear: boolean) {
  return (rear && state.wheelSpin > 0.2) || Math.abs(slip) > CONFIG.slipThresholdForSkid;
}

interface Trail { px: number; py: number; active: boolean }
const newTrails = (): Trail[] =>
  [0, 0, 0, 0].map(() => ({ px: 0, py: 0, active: false }));

export class TyreMarks {
  // MULTIPLY layer: asphalt / kerb / gravel. SOURCE-OVER layer: grass.
  private mul: HTMLCanvasElement | null = null;
  private mulCtx: CanvasRenderingContext2D | null = null;
  private over: HTMLCanvasElement | null = null;
  private overCtx: CanvasRenderingContext2D | null = null;
  private wPx = 0; private hPx = 0;
  // Has anything been stamped into each layer? An empty layer is never blitted, so a
  // clean map (or an asphalt-only map whose grass layer stays empty) costs no per-frame
  // composite — the whole system is free until the first mark is laid.
  private mulDirty = false; private overDirty = false;
  // Per-car wheel trails, keyed by the CarState object — a respawn makes a new object and so
  // starts a fresh trail, and a departed car's entry is collected. Same pattern as physics4.
  private trails = new WeakMap<CarState, Trail[]>();

  /** (Re)size both layers to the LOGICAL pixel grid. Clears them (a resize invalidates). */
  resize(wPx: number, hPx: number, dpr: number) {
    if (typeof document === 'undefined') return;
    if (!this.mul) {
      this.mul = document.createElement('canvas');
      this.mulCtx = this.mul.getContext('2d');
      this.over = document.createElement('canvas');
      this.overCtx = this.over.getContext('2d');
    }
    this.wPx = wPx; this.hPx = hPx;
    for (const [cv, cx] of [[this.mul, this.mulCtx], [this.over, this.overCtx]] as
      Array<[HTMLCanvasElement, CanvasRenderingContext2D | null]>) {
      // Clamp the backing to safe canvas limits (VERIFY + downscale); draw() blits with an
      // explicit dest size, so a capped backing is just lower-res, never garbled.
      const s = sizeCanvasFitted(cv, wPx, hPx, dpr);
      cx?.setTransform(s, 0, 0, s, 0, 0);
    }
  }
  clear() {
    this.mulCtx?.clearRect(0, 0, this.wPx, this.hPx);
    this.overCtx?.clearRect(0, 0, this.wPx, this.hPx);
    this.mulDirty = this.overDirty = false;
  }
  /** Break every trail (wrap / respawn) so no streak is drawn across the jump. */
  cut(state: CarState) {
    const t = this.trails.get(state);
    if (t) for (const w of t) w.active = false;
  }

  /**
   * Lay this car's marks for one step. ALL FOUR wheels mark — the fronts scrub the track too.
   * `surf` is the ground under each wheel in [fL, fR, rL, rR] order; `classAt` splits kerbs
   * out of asphalt for the render only.
   */
  record(
    state: CarState, surf: Surface[], slips: number[],
    classAt: (x: number, y: number) => MarkClass, px: number,
  ) {
    if (!this.mulCtx || !this.overCtx) return;
    let t = this.trails.get(state);
    if (!t) { t = newTrails(); this.trails.set(state, t); }
    const halfTrack = CONFIG.trackWidth / 2;
    const fwd = CONFIG.wheelbase / 2;
    const pos = [
      bodyToWorld(state, +fwd, +halfTrack), bodyToWorld(state, +fwd, -halfTrack),
      bodyToWorld(state, -fwd, +halfTrack), bodyToWorld(state, -fwd, -halfTrack),
    ];
    for (let i = 0; i < 4; i++) {
      const off = surf[i] !== 'asphalt';
      const gate = !off || digging(state, slips[i], i >= 2);
      this.stamp(t[i], pos[i].x, pos[i].y, gate ? markIntensity(state, i) : 0, classAt, px);
    }
  }

  private stamp(
    trail: Trail, wx: number, wy: number, intensity: number,
    classAt: (x: number, y: number) => MarkClass, px: number,
  ) {
    if (intensity <= 0) { trail.active = false; return; }
    const x = wx * px, y = wy * px;
    if (trail.active) {
      const dx = x - trail.px, dy = y - trail.py;
      if (dx * dx + dy * dy < 10000) {          // never draw across a wrap jump
        const cls = classAt(wx, wy);
        const grass = cls === 'grass';
        const c = (grass ? this.overCtx : this.mulCtx)!;
        // Gouges are patchy dug material, not a clean drawn line — keep the per-segment
        // opacity jitter the dig tracks had. Rubber is a clean line.
        const jit = (grass || cls === 'gravel') ? (0.65 + Math.random() * 0.7) : 1;
        const a = MARK.rate * intensity * jit;
        const rgb = grass ? MARK.grassRgb : MARK[MUL[cls]];
        c.strokeStyle = `rgba(${rgb},${a.toFixed(3)})`;
        c.lineWidth = MARK[WIDTH[cls]] as number;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(trail.px, trail.py);
        c.lineTo(x, y);
        c.stroke();
        if (grass) this.overDirty = true; else this.mulDirty = true;
      }
    }
    trail.px = x; trail.py = y; trail.active = true;
  }

  /**
   * Composite both layers under the cars. Dug turf REPLACES the grass; the multiply pass then
   * DARKENS asphalt/kerb/gravel without hiding what is beneath — so a saturated kerb keeps
   * its stripes and the racing line still reads as tarmac.
   */
  draw(ctx: CanvasRenderingContext2D, ox: number, oy: number, dw: number, dh: number) {
    if (this.over && this.overDirty) {
      ctx.globalAlpha = MARK.grassCap;
      ctx.drawImage(this.over, ox, oy, dw, dh);
      ctx.globalAlpha = 1;
    }
    if (this.mul && this.mulDirty) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(this.mul, ox, oy, dw, dh);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}
