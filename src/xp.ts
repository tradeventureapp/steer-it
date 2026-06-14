// =============================================================================
//  XP MODE — endless score run on circuit maps (the flat oval).
//
//  PURE logic: no DOM, no transport, no physics writes. It only READS the car's
//  speed (m/s) and sideways slip (rad) and accumulates a score, so the drift
//  feel / physics are completely untouched and the rules are unit-testable.
//
//  The addictive loop:
//   1. Drive without crashing → XP climbs continuously.
//   2. Rate scales with SPEED (faster ⇒ XP climbs faster).
//   3. A sustained DRIFT multiplies the gain — the longer/bigger the slide (and
//      the faster), the higher the ×, stacking up to multMax. It decays back to
//      ×1 when you stop sliding.
//   4. Drop below ~45% of max speed → a warning (HUD blinks); if you don't speed
//      back up within the grace window (~2 s) the run ENDS and banks.
//      The run is ARMED only once the car FIRST reaches that min speed — before
//      that nothing accrues (you're just getting up to speed off the line).
//   5. CRASH (barrier/edge hit) → instant end + bank.
//
//  All the feel-numbers are CONFIG constants below — tweak and re-feel.
// =============================================================================

export const XP_CONFIG = {
  maxSpeed: 30,             // m/s — reference top speed; the slow threshold is a fraction of this
  slowSpeedFrac: 0.45,      // min speed = this × maxSpeed: arms the run, and below it → warning
  slowGraceMs: 2000,        // ms allowed below the threshold before the run ends
  xpPerSecPerSpeed: 2.5,    // base XP/sec = this × speed(m/s) × multiplier
  driftSlipThreshold: 0.12, // rad |rearSlip| above which the car counts as "drifting" (~7°)
  driftSlipRef: 0.5,        // rad — slip giving the full slide-intensity factor (~29°)
  driftBuildPerSec: 1.0,    // multiplier units gained per second of full-speed/deep drift
  driftDecayPerSec: 1.5,    // multiplier units lost per second when not drifting
  multMin: 1,               // multiplier floor (no drift)
  multMax: 5,               // multiplier cap (drift can stack to here)
  crashImpact: 0.8,         // collideWithRects impact above which a hit counts as a crash
};

export type XpEndReason = 'crash' | 'slow' | null;

export interface XpRunState {
  xp: number;          // accumulated score (banked on end)
  mult: number;        // current drift multiplier (≥ multMin)
  active: boolean;     // run in progress (false once ended)
  started: boolean;    // ARMED — has reached the min speed at least once; before
                       // this nothing accrues (you're getting up to speed off the line)
  slowMs: number;      // ms spent continuously below the slow threshold (after `started`)
  warning: boolean;    // currently below threshold (after started) → HUD should blink
  ended: boolean;      // latched true the moment the run ends
  endReason: XpEndReason;
}

export function makeXpRun(): XpRunState {
  return {
    xp: 0, mult: XP_CONFIG.multMin, active: true, started: false,
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

// Advance the run by `dt` seconds given the car's speed (m/s), |sideways slip|
// (rad, the car's rearSlip), and whether it crashed this step. Mutates `run`.
// No-op once the run has ended. Physics is never touched — this only reads.
export function updateXpRun(
  run: XpRunState, dt: number, speed: number, slipRad: number, crashed: boolean,
  cfg = XP_CONFIG,
): void {
  if (!run.active || dt <= 0) return;

  // CRASH → instant end (bank whatever's accumulated). Checked first.
  if (crashed) { endRun(run, 'crash'); return; }

  // ARM: the run hasn't really begun until the car FIRST reaches the minimum
  // speed (slowSpeedFrac × maxSpeed). Before that crossing: no XP, no multiplier
  // change, no warning, no slow timer — you're just getting up to speed off the
  // line. Once it's crossed, the run is active and stays active.
  const threshold = cfg.maxSpeed * cfg.slowSpeedFrac;
  if (!run.started) {
    if (speed >= threshold) run.started = true;
    else return;
  }

  // ---- The run is now ACTIVE (started === true). ----

  // DRIFT MULTIPLIER — builds while sliding (length-of-slide), scaled by how
  // fast and how deep the slide is; decays back toward ×1 when not sliding.
  const drifting = Math.abs(slipRad) > cfg.driftSlipThreshold && speed > 0.5;
  if (drifting) {
    const speedF = clamp(speed / cfg.maxSpeed, 0, 1);
    const slipF = clamp(Math.abs(slipRad) / cfg.driftSlipRef, 0.3, 2);
    run.mult = Math.min(cfg.multMax, run.mult + cfg.driftBuildPerSec * speedF * slipF * dt);
  } else {
    run.mult = Math.max(cfg.multMin, run.mult - cfg.driftDecayPerSec * dt);
  }

  // XP accrues with SPEED × multiplier.
  run.xp += cfg.xpPerSecPerSpeed * speed * run.mult * dt;

  // SLOW-SPEED penalty (only reachable once armed): below the threshold → blink;
  // sustained past the grace window → end + bank. Above it → reset.
  if (speed >= threshold) {
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
