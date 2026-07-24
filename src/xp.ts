// =============================================================================
//  XP MODE — endless score run on circuit maps (retuned for Stee-Rex + GRID combo).
//
//  PURE logic: no DOM, no transport, no physics writes. It only READS the car's
//  speed (m/s), sideways slip (rad, rearSlip) and how many wheels are off the
//  track, and accumulates a score — so the drift feel / physics are completely
//  untouched and the rules are unit-testable.
//
//  The addictive loop (GRID-style combo):
//   1. Drive without crashing / leaving the track → XP climbs continuously.
//   2. Rate scales with SPEED (capped at the car's top) × the drift MULTIPLIER.
//   3. A DRIFT BUILDS the multiplier — the deeper (bigger angle) and faster the
//      slide, the faster it builds (EARNED, not instant; slipF genuinely varies).
//   4. When a drift ENDS a COMBO WINDOW opens (comboWindowMs): the multiplier
//      HOLDS (no decay) so you can carry it down a straight. Start another drift
//      inside the window → the combo CHAINS and keeps building, and the window
//      resets. Let the window expire → the combo BANKS and the multiplier resets
//      to ×1. (This replaced the old continuous decay.)
//   5. ENDS: a CRASH (barrier hit, where barriers exist), MORE THAN 2 wheels off
//      the track (3+ = over), or dropping below the slow floor for the grace
//      window. The run ARMS only once the car first reaches the slow floor.
//
//  All feel-numbers are CONFIG constants below — tweak and re-feel.
//
//  ---- CALIBRATION (measured on Stee-Rex arcade, headless) --------------------
//   • top speed 300 km/h = 83.3 m/s (hard limiter).
//   • held drifts run rearSlip ~10-56° (median ~13-21°, deep spikes to ~80°);
//     drift speed settles ~125-134 km/h (~35 m/s).
//   • a genuine grippy corner keeps rearSlip under ~6° (≤~9° on the hardest).
//   • circuit = 639 m; only real straight is the 125 m finish straight (esses are
//     <0.3 s apart). Crossing 125 m inside a 2.5 s window needs ~180 km/h avg →
//     tight but achievable if you commit; the esses chain trivially.
// =============================================================================

export const XP_CONFIG = {
  // ---- speed (was tuned to the old 30 m/s car) --------------------------------
  maxSpeed: 83,             // m/s — Stee-Rex real top (300 km/h). Sets the slow floor + speedF.
  slowSpeedFrac: 0.27,      // slow floor = 0.27 × 83 ≈ 22.4 m/s ≈ 81 km/h — BELOW drift speed
                            //   (~125 km/h, so drifting never trips it) yet catches real crawling.
  slowGraceMs: 2000,        // ms allowed below the floor before the run ends.
  // XP/sec = this × min(speed, maxSpeed) × mult. Speed is CAPPED at the top (no overspeed
  // exploit) and the rate is LOWERED (2.5 → 1.0) so score reflects skill (the chained-drift
  // multiplier), not just that the car is fast. Max rate 1.0 × 83 × 8 ≈ 664 XP/s (only at a
  // maxed combo at top speed — rare); a typical drift chain (~35 m/s, ×3) ≈ 105 XP/s.
  xpPerSecPerSpeed: 1.0,

  // ---- drift multiplier (recalibrated to Stee-Rex's real drift angles) --------
  driftSlipThreshold: 0.15, // rad ≈ 8.6° — above a grippy corner (~6°), below a real drift.
  driftSlipRef: 0.9,        // rad ≈ 52° — the slip giving the FULL slide-intensity factor. Drifts
                            //   run 10-80°, so slipF now genuinely varies (shallow ⇒ low, deep ⇒
                            //   ~1, only the deepest spikes hit the ×2 cap) instead of pinning at ×2.
  driftBuildPerSec: 1.2,    // multiplier units/sec at full speedF×slipF. EARNED: a medium drift
                            //   (speedF~0.5, slipF~0.6) builds ~0.36/s → ~1 → 8 over ~19 s of
                            //   drifting; shallow builds slower, deep faster.
  multMin: 1,               // multiplier floor.
  multMax: 8,               // ceiling — reachable only by sustained chaining (hard to hold at max).

  // ---- GRID combo -------------------------------------------------------------
  comboWindowMs: 2500,      // after a drift ends, the multiplier HOLDS this long; a new drift
                            //   inside it chains (window resets); expiry banks + resets to ×1.
                            //   Verified vs the track: the 125 m straight is tight-but-achievable,
                            //   the esses chain trivially. Bump toward 3000 if the straight frustrates.

  // ---- end conditions ---------------------------------------------------------
  crashImpact: 0.8,         // collideWithRects impact above which a barrier hit ends the run.
  offTrackWheels: 2,        // MORE THAN this many wheels off the track (asphalt/kerb) ends the run
                            //   (2 off = recoverable, 3+ = over). Only bites where a surface mask
                            //   exists (the circuit); on the ovals the crash-end covers it.
};

export type XpEndReason = 'crash' | 'slow' | 'offtrack' | null;

export interface XpRunState {
  xp: number;          // accumulated score (banked on end)
  mult: number;        // current drift multiplier (≥ multMin)
  comboMs: number;     // ms left in the GRID combo window (0 = no active combo)
  active: boolean;     // run in progress (false once ended)
  started: boolean;    // ARMED — has reached the slow floor at least once; before this nothing accrues
  slowMs: number;      // ms spent continuously below the slow floor (after `started`)
  warning: boolean;    // currently below the floor (after started) → HUD should blink
  ended: boolean;      // latched true the moment the run ends
  endReason: XpEndReason;
}

export function makeXpRun(): XpRunState {
  return {
    xp: 0, mult: XP_CONFIG.multMin, comboMs: 0, active: true, started: false,
    slowMs: 0, warning: false, ended: false, endReason: null,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function endRun(run: XpRunState, reason: Exclude<XpEndReason, null>): void {
  run.active = false;
  run.ended = true;
  run.warning = false;
  run.endReason = reason;
}

// Advance the run by `dt` seconds given the car's speed (m/s), |sideways slip| (rad, its
// rearSlip), whether it crashed a barrier this step, and how many wheels are off the track
// (0..4). Mutates `run`. No-op once ended. Physics is never touched — this only reads.
export function updateXpRun(
  run: XpRunState, dt: number, speed: number, slipRad: number,
  crashed: boolean, wheelsOff: number,
  cfg = XP_CONFIG,
): void {
  if (!run.active || dt <= 0) return;

  // END conditions checked first (bank whatever's accumulated):
  if (crashed) { endRun(run, 'crash'); return; }                    // barrier hit (ovals)
  if (wheelsOff > cfg.offTrackWheels) { endRun(run, 'offtrack'); return; }  // 3+ wheels off (circuit)

  // ARM: nothing accrues until the car FIRST reaches the slow floor (getting up to speed
  // off the line). Once crossed, the run is active and stays active.
  const floor = cfg.maxSpeed * cfg.slowSpeedFrac;
  if (!run.started) {
    if (speed >= floor) run.started = true;
    else return;
  }

  // ---- DRIFT MULTIPLIER + GRID COMBO ----
  const drifting = Math.abs(slipRad) > cfg.driftSlipThreshold && speed > 0.5;
  if (drifting) {
    // build with speed × slide depth; (re)arm the combo window every drifting frame
    const speedF = clamp(speed / cfg.maxSpeed, 0, 1);
    const slipF = clamp(Math.abs(slipRad) / cfg.driftSlipRef, 0.3, 2);
    run.mult = Math.min(cfg.multMax, run.mult + cfg.driftBuildPerSec * speedF * slipF * dt);
    run.comboMs = cfg.comboWindowMs;
  } else if (run.comboMs > 0) {
    // not drifting but inside the window → HOLD the multiplier and count the window down;
    // when it expires, bank the combo and reset the multiplier to ×1.
    run.comboMs = Math.max(0, run.comboMs - dt * 1000);
    if (run.comboMs === 0) run.mult = cfg.multMin;
  }

  // XP accrues with (capped) SPEED × multiplier.
  run.xp += cfg.xpPerSecPerSpeed * Math.min(speed, cfg.maxSpeed) * run.mult * dt;

  // SLOW-SPEED end (only reachable once armed): below the floor → blink; sustained past the
  // grace window → end + bank. Above it → reset.
  if (speed >= floor) {
    run.slowMs = 0;
    run.warning = false;
  } else {
    run.slowMs += dt * 1000;
    run.warning = true;
    if (run.slowMs >= cfg.slowGraceMs) endRun(run, 'slow');
  }
}

// Pretty score, e.g. 12345 → "12,345".
export function formatXp(xp: number): string {
  return Math.floor(Math.max(0, xp)).toLocaleString('en-US');
}
