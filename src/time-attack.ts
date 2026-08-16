// =============================================================================
//  TIME ATTACK — solo, rolling lap timing on a track's built-in start/finish line.
//
//  This module does NOT re-implement crossing detection. It OWNS a race.ts
//  RaceState built from the map's own `startLine()` element, so the validity rules
//  are LITERALLY Race mode's:
//    • line-plane sweep (sign change of the signed distance) — no tunnelling,
//    • FORWARD-only (velocity must point along the racing direction) — no reversing
//      back over the line, no wrong-way,
//    • ARMED (the car must reach the far point before a crossing counts) — a car
//      wiggling on the line, or circling at it, logs nothing.
//  Reusing RaceState rather than copying those rules is the whole point: the same
//  fix reaches both modes, and Time Attack can never drift out of sync with Race.
//
//  What this module ADDS is the ROLLING behaviour. Race mode stops at the lap limit
//  and reports ONE total time; Time Attack wants every lap timed back-to-back,
//  forever, with no manual reset:
//    • the FIRST forward crossing starts the clock (the spawn→line run is NOT
//      timed — that crossing IS the start line),
//    • every later valid crossing ends the current lap and starts the next.
//
//  Pure: no DOM, no storage, no transport — so it's unit-testable like race.ts /
//  xp.ts. The personal best is passed IN and handed back OUT; persisting it
//  (localStorage) is the caller's job, exactly as xp.ts leaves the XP best to
//  desktop.ts.
// =============================================================================

import { RaceState, RACE_CONFIG, type RaceElement } from './race';

// The RaceState lap ceiling. RaceState finishes at its lap limit (it is built for
// races, which end), so Time Attack runs it at the maximum race.ts allows and
// recycles on the rare occasion the ceiling is reached — see `update`. 99 laps is
// well over an hour of continuous driving, so in practice this never fires.
const ROLL_LAPS = 99;

/** A lap that just completed. */
export interface CompletedLap {
  ms: number;        // the lap's time
  lapNumber: number; // 1-based, counting completed laps this session
  isBest: boolean;   // beat the personal best that was in force when it finished
}

/** Everything the on-screen readout needs (no internal state leaks). */
export interface TimeAttackHud {
  running: boolean;        // the clock is live (the first crossing has happened)
  currentMs: number;       // the lap in progress (0 before the first crossing)
  lastMs: number | null;   // the most recently completed lap (null = none yet)
  lastWasBest: boolean;    // ...and whether it set a new record
  bestMs: number | null;   // personal best this session (seeded by the caller)
  lapsDone: number;        // completed laps this session
}

export class TimeAttackRun {
  private readonly element: RaceElement;
  private rs: RaceState;
  // The clock is OURS, not RaceState's: its `elapsedMs` counts from the very first
  // crossing (total race time), whereas a lap time restarts at every crossing.
  private lapStartMs = 0;
  private running = false;
  private lapsDone = 0;
  private lastMs: number | null = null;
  private lastWasBest = false;
  private bestMs: number | null;
  // Previous-step readings, so a change is what fires (RaceState reports state, not events).
  private prevLap = 0;
  private prevFinished = false;

  /** `element` is the map's startLine(); `bestMs` is the stored personal best (null = none). */
  constructor(element: RaceElement, bestMs: number | null = null) {
    this.element = element;
    this.bestMs = bestMs !== null && bestMs > 0 ? bestMs : null;
    this.rs = this.freshState();
  }

  private freshState(): RaceState {
    return new RaceState([this.element], { ...RACE_CONFIG, laps: ROLL_LAPS });
  }

  /**
   * Feed the car's point (world metres, the NOSE — same point Race mode feeds),
   * the game clock, and its velocity, every physics step. Returns the lap that
   * just completed on this step, or null.
   */
  update(x: number, y: number, now: number, vx: number, vy: number): CompletedLap | null {
    this.rs.update(x, y, now, vx, vy);
    const h = this.rs.hud(now);

    // FIRST crossing: RaceState flipped to 'racing'. Its startMs is the exact crossing
    // instant, so derive our lap origin from it rather than from this frame — that keeps
    // the lap clock independent of the frame rate, as race.ts is.
    if (!this.running && h.phase === 'racing') {
      this.running = true;
      this.lapStartMs = now - h.elapsedMs;
      this.prevLap = h.lap;
      return null;   // the start crossing ends no lap — timing BEGINS here
    }
    if (!this.running) return null;

    // A lap completed if the lap counter advanced, OR if RaceState hit its ceiling and
    // finished (which completes a lap WITHOUT advancing the counter — see tryCompleteLap).
    const rolled = h.lap > this.prevLap;
    const hitCeiling = h.finished && !this.prevFinished;
    this.prevLap = h.lap;
    this.prevFinished = h.finished;
    if (!rolled && !hitCeiling) return null;

    const ms = now - this.lapStartMs;
    this.lapStartMs = now;
    this.lapsDone += 1;
    const isBest = this.bestMs === null || ms < this.bestMs;
    if (isBest) this.bestMs = ms;
    this.lastMs = ms;
    this.lastWasBest = isBest;

    if (hitCeiling) {
      // Ceiling reached: hand RaceState a clean slate so timing continues. The next
      // crossing is a fresh START crossing, so that one lap is not timed — the only
      // gap in an otherwise unbroken roll, and it takes 98 laps to reach.
      this.rs = this.freshState();
      this.running = false;
      this.prevLap = 0;
      this.prevFinished = false;
    }
    return { ms, lapNumber: this.lapsDone, isBest };
  }

  hud(now: number): TimeAttackHud {
    return {
      running: this.running,
      currentMs: this.running ? Math.max(0, now - this.lapStartMs) : 0,
      lastMs: this.lastMs,
      lastWasBest: this.lastWasBest,
      bestMs: this.bestMs,
      lapsDone: this.lapsDone,
    };
  }

  /** The personal best, for persisting (null = no lap completed and none was seeded). */
  best(): number | null { return this.bestMs; }
}

/**
 * A lap time, read the way a lap time is read: `ss.mmm` under a minute, `m:ss.mmm`
 * over it. Deliberately NOT race.ts's formatRaceTime — that one is tenths, which is
 * far too coarse to separate two attempts at the same corner.
 */
export function formatLapTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const millis = t % 1000;
  const totalS = Math.floor(t / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60);
  const frac = String(millis).padStart(3, '0');
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${frac}` : `${s}.${frac}`;
}
