// =============================================================================
//  GHOST — self-ghost recording + smooth interpolated playback (Time Attack, Phase 1).
//
//  A ghost is a translucent replay of one of YOUR OWN clean laps, driven from the
//  lap-start crossing in sync with your current lap so you can see where you're
//  ahead/behind. This module is the PURE part (no DOM, no storage, no canvas):
//    • GhostRecorder — a growing per-lap buffer, appended ONE sample per FIXED
//      PHYSICS STEP (so the recording is frame-rate independent, exactly like the
//      lap timer), frozen into a compact Recording on lap completion.
//    • sampleGhost() — the smoothness: INTERPOLATES position + rotation between the
//      fixed-step samples from a continuous cursor time, so the ghost moves fluidly
//      at any render framerate and never steps/snaps between samples.
//    • serialize/parse — compact localStorage form for the persisted personal best.
//
//  Samples are stored UNIFORMLY spaced (dt ms apart), so a lookup is O(1) index
//  arithmetic — no search. desktop.ts owns the state/UI/storage wiring, mirroring
//  how time-attack.ts leaves persistence to the caller.
// =============================================================================

/** A frozen ghost lap: uniformly-spaced fixed-step samples, `dt` ms apart. */
export interface GhostRec {
  dt: number;     // ms between samples (one fixed step × the decimation factor)
  xs: number[];   // world-metre X per sample
  ys: number[];   // world-metre Y per sample
  hs: number[];   // heading (radians) per sample
}

/** One fixed physics step, in ms (matches desktop's FIXED_DT = 1/60). */
export const GHOST_STEP_MS = 1000 / 60;

const TWO_PI = Math.PI * 2;
/** Shortest signed angular delta from `from` to `to`, in (-π, π]. */
function angDelta(to: number, from: number): number {
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/**
 * A per-lap sample buffer. Push one pose per FIXED PHYSICS STEP while a lap is being
 * timed; reset at each start/finish crossing. `freeze` turns the current buffer into a
 * uniformly-spaced Recording (optionally decimated for storage + rounded for size).
 */
export class GhostRecorder {
  private xs: number[] = [];
  private ys: number[] = [];
  private hs: number[] = [];

  reset(): void { this.xs = []; this.ys = []; this.hs = []; }
  push(x: number, y: number, heading: number): void {
    this.xs.push(x); this.ys.push(y); this.hs.push(heading);
  }
  get length(): number { return this.xs.length; }

  /**
   * Freeze the buffer into a Recording. `decim` (≥1) keeps every Nth sample — the
   * spacing stays UNIFORM (dt = STEP × decim), which is what keeps sampling O(1).
   * `round` trims coordinate precision (position 1 cm, heading 1e-4 rad) so the
   * persisted personal best stays small in localStorage. Returns null if too short.
   */
  freeze(decim = 1, round = false): GhostRec | null {
    const n = this.xs.length;
    if (n < 4) return null;
    const d = Math.max(1, Math.floor(decim));
    const xs: number[] = [], ys: number[] = [], hs: number[] = [];
    for (let i = 0; i < n; i += d) {
      if (round) {
        xs.push(Math.round(this.xs[i] * 100) / 100);
        ys.push(Math.round(this.ys[i] * 100) / 100);
        hs.push(Math.round(this.hs[i] * 1e4) / 1e4);
      } else {
        xs.push(this.xs[i]); ys.push(this.ys[i]); hs.push(this.hs[i]);
      }
    }
    if (xs.length < 2) return null;
    return { dt: GHOST_STEP_MS * d, xs, ys, hs };
  }
}

/** Decimation factor to keep a persisted ghost within `maxSamples` (min 2 ⇒ ≤30 Hz). */
export function decimFor(n: number, maxSamples: number): number {
  return Math.max(2, Math.ceil(n / Math.max(1, maxSamples)));
}

export interface GhostPose { x: number; y: number; heading: number; }

/**
 * The interpolated pose at `cursorMs` (ms since lap start). This is the SMOOTHNESS:
 * the cursor is a continuous render-frame time, and the pose is linearly interpolated
 * between the two bracketing fixed-step samples (heading via the shortest arc), so the
 * ghost glides at any framerate. Returns:
 *   • sample 0 when the cursor is at/behind the start (ghost waits on the line),
 *   • null once the cursor passes the recording's end (the ghost finished its lap —
 *     the caller then simply stops drawing it).
 */
export function sampleGhost(rec: GhostRec, cursorMs: number): GhostPose | null {
  const n = rec.xs.length;
  if (n < 2 || rec.dt <= 0) return null;
  const idxF = cursorMs / rec.dt;
  if (idxF <= 0) return { x: rec.xs[0], y: rec.ys[0], heading: rec.hs[0] };
  if (idxF >= n - 1) return null;   // past the end → ghost has finished
  const i = Math.floor(idxF);
  const t = idxF - i;
  return {
    x: rec.xs[i] + (rec.xs[i + 1] - rec.xs[i]) * t,
    y: rec.ys[i] + (rec.ys[i + 1] - rec.ys[i]) * t,
    heading: rec.hs[i] + angDelta(rec.hs[i + 1], rec.hs[i]) * t,
  };
}

/** Compact JSON for localStorage (the persisted personal-best ghost). */
export function serializeGhost(rec: GhostRec): string {
  return JSON.stringify({ v: 1, dt: rec.dt, x: rec.xs, y: rec.ys, h: rec.hs });
}

/** Parse + validate a stored ghost; null on anything malformed. */
export function parseGhost(raw: string | null): GhostRec | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: number; dt?: unknown; x?: unknown; y?: unknown; h?: unknown };
    if (!o || o.v !== 1) return null;
    const dt = o.dt, x = o.x, y = o.y, h = o.h;
    if (typeof dt !== 'number' || !(dt > 0)) return null;
    if (!Array.isArray(x) || !Array.isArray(y) || !Array.isArray(h)) return null;
    if (x.length !== y.length || x.length !== h.length || x.length < 2) return null;
    return { dt, xs: x as number[], ys: y as number[], hs: h as number[] };
  } catch { return null; }
}
