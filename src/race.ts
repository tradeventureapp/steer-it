// =============================================================================
//  Race elements — start / finish / checkpoints, with passage detection and
//  lap/timer logic. STEP 3a: the LOGIC (a click-to-place editor lands next and
//  will write the SAME RaceElement[] this consumes).
//
//  Pure + transport/DOM-free so it's unit-testable. desktop.ts owns one
//  RaceState, feeds it the car position each physics step, and reads hud() for
//  the on-screen readout. Rendering of the gates lives in desktop.ts (canvas).
//
//  Detection is deliberately FORGIVING: an element triggers when the car comes
//  within its radius (gate-as-circle), on the ENTER edge (you must leave and
//  re-enter to trigger again — no re-collecting while parked on it).
//
//  Lap rule (order of checkpoints NOT enforced for now):
//    cross START → timing begins → collect ALL placed checkpoints (any order)
//    → cross FINISH → lap complete. 0 checkpoints ⇒ START→FINISH completes it.
//    A FINISH crossing with checkpoints still missing is ignored (tolerant).
//    With laps>1, a completed lap clears the checkpoints and the next lap runs;
//    the final lap's FINISH ends the race and records the elapsed time.
// =============================================================================

export type RaceType = 'start' | 'finish' | 'checkpoint';

// One placed element. Positions are WORLD METRES — the same shape a future
// editor will produce. `index` orders checkpoints for display (detection is
// order-agnostic for now). `radius`/`angle` are optional (defaults below).
export interface RaceElement {
  type: RaceType;
  x: number;
  y: number;
  index?: number;   // checkpoint number (1-based for display)
  radius?: number;  // trigger radius (m); falls back to RaceConfig.gateRadius
  angle?: number;   // gate orientation (rad) — rendering only
}

export interface RaceConfig {
  laps: number;            // 1..10 (clamped)
  maxCheckpoints: number;  // cap the editor will honour
  gateRadius: number;      // default trigger radius (m) — forgiving
}

export const RACE_CONFIG: RaceConfig = {
  laps: 1,
  maxCheckpoints: 5,
  gateRadius: 1.7,
};

export type RacePhase = 'pre' | 'racing' | 'finished';

// Snapshot for the HUD (no internal state leaks).
export interface RaceHud {
  active: boolean;       // any elements present at all
  phase: RacePhase;
  elapsedMs: number;     // live during racing, frozen at finish
  cpCollected: number;
  cpTotal: number;
  lap: number;           // 1-based
  laps: number;
  finished: boolean;
  finishMs: number;      // total time once finished (else 0)
}

function clampLaps(n: number): number {
  return Math.max(1, Math.min(10, Math.floor(n)));
}

export class RaceState {
  private readonly elements: RaceElement[];
  private readonly cfg: RaceConfig;
  private readonly cpTotal: number;

  private inside: boolean[];     // per-element overlap (for enter-edge detect)
  private phase: RacePhase = 'pre';
  private startMs = 0;
  private finishMs = 0;
  private lap = 0;               // 0 until started, then 1-based
  private collected = new Set<number>();  // element indices of collected CPs

  constructor(elements: RaceElement[], cfg: RaceConfig = RACE_CONFIG) {
    this.elements = elements;
    this.cfg = { ...cfg, laps: clampLaps(cfg.laps) };
    this.cpTotal = elements.filter((e) => e.type === 'checkpoint').length;
    this.inside = elements.map(() => false);
  }

  reset() {
    this.phase = 'pre';
    this.startMs = 0;
    this.finishMs = 0;
    this.lap = 0;
    this.collected.clear();
    this.inside = this.elements.map(() => false);
  }

  // Feed the car position (world metres) + a timestamp (ms) every physics step.
  update(x: number, y: number, now: number) {
    if (this.phase === 'finished' || this.elements.length === 0) return;
    for (let i = 0; i < this.elements.length; i++) {
      const e = this.elements[i];
      const r = e.radius ?? this.cfg.gateRadius;
      const dx = x - e.x, dy = y - e.y;
      const now2 = dx * dx + dy * dy < r * r;
      if (now2 && !this.inside[i]) this.onEnter(i, now);  // enter edge only
      this.inside[i] = now2;
    }
  }

  private onEnter(i: number, now: number) {
    const e = this.elements[i];
    if (e.type === 'start') {
      if (this.phase === 'pre') {
        this.phase = 'racing';
        this.startMs = now;
        this.lap = 1;
        this.collected.clear();
      }
      return;
    }
    if (this.phase !== 'racing') return;
    if (e.type === 'checkpoint') {
      this.collected.add(i);
      return;
    }
    // finish — only when every placed checkpoint has been collected
    if (e.type === 'finish' && this.collected.size >= this.cpTotal) {
      if (this.lap < this.cfg.laps) {
        this.lap += 1;
        this.collected.clear();   // next lap
      } else {
        this.phase = 'finished';
        this.finishMs = now;
      }
    }
  }

  // Element-array indices of currently-collected checkpoints (for rendering
  // feedback — collected rings dim). Cleared each lap.
  collectedElementIndices(): ReadonlySet<number> { return this.collected; }

  hud(now: number): RaceHud {
    const elapsed =
      this.phase === 'racing' ? Math.max(0, now - this.startMs) :
      this.phase === 'finished' ? this.finishMs - this.startMs : 0;
    return {
      active: this.elements.length > 0,
      phase: this.phase,
      elapsedMs: elapsed,
      cpCollected: this.collected.size,
      cpTotal: this.cpTotal,
      lap: this.lap || 1,
      laps: this.cfg.laps,
      finished: this.phase === 'finished',
      finishMs: this.phase === 'finished' ? this.finishMs - this.startMs : 0,
    };
  }
}

// =============================================================================
//  Editor mutators — operate on the live RaceElement[] (the single source of
//  truth shared with RaceState). Pure (mutate the passed array), unit-testable.
//  After any structural change the desktop rebuilds its RaceState from the
//  array so the cached cpTotal / inside[] stay in sync.
// =============================================================================
export function countCheckpoints(elements: RaceElement[]): number {
  let n = 0;
  for (const e of elements) if (e.type === 'checkpoint') n++;
  return n;
}

// Renumber checkpoints 1..n in array (= placement) order.
export function renumberCheckpoints(elements: RaceElement[]): void {
  let n = 0;
  for (const e of elements) if (e.type === 'checkpoint') e.index = ++n;
}

export interface PlaceResult { ok: boolean; reason?: 'cap'; }

// Place an element at (x,y) world metres. START/FINISH are unique (a new one
// replaces the old). CHECKPOINT appends up to cfg.maxCheckpoints (else ignored
// with reason 'cap') and auto-numbers in placement order.
export function placeElement(
  elements: RaceElement[], type: RaceType, x: number, y: number,
  cfg: RaceConfig = RACE_CONFIG,
): PlaceResult {
  if (type === 'start' || type === 'finish') {
    const i = elements.findIndex((e) => e.type === type);
    if (i >= 0) elements.splice(i, 1);
    elements.push({ type, x, y, angle: 0 });
    return { ok: true };
  }
  if (countCheckpoints(elements) >= cfg.maxCheckpoints) return { ok: false, reason: 'cap' };
  elements.push({ type: 'checkpoint', x, y });
  renumberCheckpoints(elements);
  return { ok: true };
}

// Remove the element at array index `idx` (renumbering any checkpoints).
export function removeElementAt(elements: RaceElement[], idx: number): void {
  if (idx < 0 || idx >= elements.length) return;
  elements.splice(idx, 1);
  renumberCheckpoints(elements);
}

export function clearElements(elements: RaceElement[]): void {
  elements.length = 0;
}

// Topmost element (last drawn) whose centre is within `radius` of (x,y); -1 if
// none. Used for editor drag/delete hit-testing.
export function findElementIndexAt(
  elements: RaceElement[], x: number, y: number, radius: number,
): number {
  for (let i = elements.length - 1; i >= 0; i--) {
    const dx = x - elements[i].x, dy = y - elements[i].y;
    if (dx * dx + dy * dy <= radius * radius) return i;
  }
  return -1;
}

// Format ms as M:SS.t (tenths) for the HUD.
export function formatRaceTime(ms: number): string {
  const totalT = Math.max(0, Math.round(ms / 100)); // tenths
  const tenths = totalT % 10;
  const totalS = Math.floor(totalT / 10);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60);
  return `${m}:${String(s).padStart(2, '0')}.${tenths}`;
}
