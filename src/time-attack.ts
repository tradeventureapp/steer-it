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
//  OFF-TRACK INVALIDATION (mirrors XP mode). The caller feeds the SAME per-wheel
//  count XP does — desktop's `wheelsOffTrack()` (each wheel tested by the map's
//  `onTrackAt` track geometry) — and the SAME threshold, `XP_CONFIG.offTrackWheels`
//  (>2 = 3+ wheels off). Going that far off DURING a lap marks the lap INVALID: an
//  invalid lap still finishes and still times/records its crossing (so the next lap
//  starts correctly), but it can never set the record, however fast. The flag is
//  STICKY within a lap and resets to VALID at each crossing — a fresh lap is clean.
//  Where XP ENDS the run on the same condition, Time Attack only invalidates the lap.
//
//  Pure: no DOM, no storage, no transport — so it's unit-testable like race.ts /
//  xp.ts. The personal best is passed IN and handed back OUT; persisting it
//  (localStorage) is the caller's job, exactly as xp.ts leaves the XP best to
//  desktop.ts.
// =============================================================================

import { RaceState, RACE_CONFIG, type RaceElement } from './race';
import { XP_CONFIG } from './xp';   // off-track threshold — the SAME one XP invalidates on

// The RaceState lap ceiling. RaceState finishes at its lap limit (it is built for
// races, which end), so Time Attack runs it at the maximum race.ts allows and
// recycles on the rare occasion the ceiling is reached — see `update`. 99 laps is
// well over an hour of continuous driving, so in practice this never fires.
const ROLL_LAPS = 99;

/** A lap that just completed. */
export interface CompletedLap {
  ms: number;        // the lap's time
  lapNumber: number; // 1-based, counting completed laps this session
  isBest: boolean;   // beat the personal best — ONLY ever true for a VALID lap
  valid: boolean;    // was the lap clean (on-track AND zones in order)?
  // The two independent validity COMPONENTS, surfaced for analytics (they are the operands of
  // `valid` above — exposing them changes no rule). `offTrack` = the lap went > threshold wheels
  // off-track at some point; `zonesOk` = the caller's `zonesValid` (all 6 zones in order this lap).
  offTrack: boolean;
  zonesOk: boolean;
}

/** Everything the on-screen readout needs (no internal state leaks). */
export interface TimeAttackHud {
  running: boolean;        // the clock is live (the first crossing has happened)
  currentMs: number;       // the lap in progress (0 before the first crossing)
  currentValid: boolean;   // is the lap in progress still clean? (false = went off-track)
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
  // The lap in progress is VALID until the car goes > threshold wheels off-track; then it
  // latches invalid (sticky) until the next crossing resets it. Only a valid lap can record.
  private lapValid = true;
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
   * the game clock, its velocity, how many wheels are off-track THIS step (0..4, from
   * desktop's `wheelsOffTrack()` — the SAME count XP is fed), and — at a lap-completion
   * instant — whether all 6 leaderboard ZONES were passed in order this lap (`zonesValid`,
   * from the ZoneTracker; defaults true so tests / zone-less maps behave as before). Every
   * physics step. Returns the lap that just completed on this step, or null.
   *
   * ONE validity rule: a lap can set the record ONLY if it stayed on track AND passed every
   * zone in order — so an off-track OR a shortcut lap sets neither the local best nor the
   * online board (they submit off the same `isBest`).
   */
  update(
    x: number, y: number, now: number, vx: number, vy: number,
    wheelsOff: number, zonesValid = true,
  ): CompletedLap | null {
    this.rs.update(x, y, now, vx, vy);
    const h = this.rs.hud(now);

    // FIRST crossing: RaceState flipped to 'racing'. Its startMs is the exact crossing
    // instant, so derive our lap origin from it rather than from this frame — that keeps
    // the lap clock independent of the frame rate, as race.ts is.
    if (!this.running && h.phase === 'racing') {
      this.running = true;
      this.lapStartMs = now - h.elapsedMs;
      this.prevLap = h.lap;
      this.lapValid = true;   // the timed lap begins clean (off-track before the line is moot)
      return null;   // the start crossing ends no lap — timing BEGINS here
    }
    if (!this.running) return null;

    // OFF-TRACK ⇒ the lap is INVALID. Same detection + threshold as XP mode: the caller
    // passes wheelsOffTrack()'s count and > XP_CONFIG.offTrackWheels (>2 = 3+ wheels off)
    // trips it — where updateXpRun ENDS the run, here it only latches the lap invalid
    // (sticky: it never clears mid-lap, only the next crossing resets it below).
    if (wheelsOff > XP_CONFIG.offTrackWheels) this.lapValid = false;

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
    // VALID = on track the whole lap (off-track flag) AND all 6 zones in order (zonesValid).
    // Either failing makes the lap ineligible for the record.
    const valid = this.lapValid && zonesValid;
    // Off-track COMPONENT captured here, BEFORE the lapValid reset below — for analytics only
    // (it changes no rule; it's the operand of `valid`). `zonesOk` is the caller's zonesValid.
    const offTrack = !this.lapValid;
    // An INVALID lap can NEVER set the record, however fast — the isBest test is gated on it.
    const isBest = valid && (this.bestMs === null || ms < this.bestMs);
    if (isBest) this.bestMs = ms;
    this.lastMs = ms;
    this.lastWasBest = isBest;
    this.lapValid = true;   // the next lap starts on a clean slate

    if (hitCeiling) {
      // Ceiling reached: hand RaceState a clean slate so timing continues. The next
      // crossing is a fresh START crossing, so that one lap is not timed — the only
      // gap in an otherwise unbroken roll, and it takes 98 laps to reach.
      this.rs = this.freshState();
      this.running = false;
      this.prevLap = 0;
      this.prevFinished = false;
    }
    return { ms, lapNumber: this.lapsDone, isBest, valid, offTrack, zonesOk: zonesValid };
  }

  hud(now: number): TimeAttackHud {
    return {
      running: this.running,
      currentMs: this.running ? Math.max(0, now - this.lapStartMs) : 0,
      currentValid: this.lapValid,
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
