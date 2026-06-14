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
//  TRACK TYPE is implied by whether a FINISH gate is placed (no extra toggle):
//    SPRINT  (a FINISH exists): cross START → timing begins → collect ALL
//            checkpoints (any order) → cross FINISH → lap complete.
//    CIRCUIT (only START, no FINISH): the START gate is ALSO the finish line.
//            Cross START → timing begins; after collecting all checkpoints,
//            cross START AGAIN → lap complete. 0 checkpoints ⇒ START→START.
//
//  Lap rule (order of checkpoints NOT enforced for now):
//    0 checkpoints ⇒ a single line crossing completes the lap (sprint:
//    START→FINISH; circuit: START→START). A finish/lap crossing with
//    checkpoints still missing is ignored (tolerant). With laps>1, a completed
//    lap clears the checkpoints and the next lap runs; the final lap's crossing
//    ends the race and records the elapsed time. laps is clamped to 1..10.
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
  // --- Circuit start/finish anti-cheat (set by the map's startLine) ---
  forward?: number;     // racing direction through the line (rad). When set, a
                        //   crossing only counts if the car's velocity points
                        //   this way (no reverse-over-the-line spam, no wrong-way).
  farX?: number;        // a far-side "must reach" point of the circuit; the lap
  farY?: number;        //   ARMS only once the car comes within farRadius of it,
  farRadius?: number;   //   so tiny circles near the line never complete a lap.
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
  // 1..99 (circuit maps go up to 99; the open editor still offers 1..10). 0 laps
  // = free-roam is handled by the caller (no race elements), not here.
  return Math.max(1, Math.min(99, Math.floor(n)));
}

export class RaceState {
  private readonly elements: RaceElement[];
  private readonly cfg: RaceConfig;
  private readonly cpTotal: number;
  // Track type, derived from the placed elements: a FINISH ⇒ sprint; only a
  // START (no finish) ⇒ circuit, where the start gate doubles as the finish.
  readonly isCircuit: boolean;

  private inside: boolean[];     // per-element overlap (for enter-edge detect)
  private phase: RacePhase = 'pre';
  private startMs = 0;
  private finishMs = 0;
  private lap = 0;               // 0 until started, then 1-based
  private collected = new Set<number>();  // element indices of collected CPs
  // Circuit anti-cheat: the start element + an "armed" latch. A lap only
  // completes on an ARMED, FORWARD crossing of the start line; reaching the
  // circuit's far point arms it. Re-cross without going round ⇒ not armed ⇒ no
  // lap; reverse over the line ⇒ not forward ⇒ no lap.
  private readonly startEl: RaceElement | null;
  private armed = false;

  constructor(elements: RaceElement[], cfg: RaceConfig = RACE_CONFIG) {
    this.elements = elements;
    this.cfg = { ...cfg, laps: clampLaps(cfg.laps) };
    this.cpTotal = elements.filter((e) => e.type === 'checkpoint').length;
    const hasStart = elements.some((e) => e.type === 'start');
    const hasFinish = elements.some((e) => e.type === 'finish');
    this.isCircuit = hasStart && !hasFinish;
    this.startEl = elements.find((e) => e.type === 'start') ?? null;
    this.inside = elements.map(() => false);
  }

  reset() {
    this.phase = 'pre';
    this.startMs = 0;
    this.finishMs = 0;
    this.lap = 0;
    this.collected.clear();
    this.armed = false;
    this.inside = this.elements.map(() => false);
  }

  // Feed the car position (world metres), a timestamp (ms), and OPTIONALLY the
  // car's velocity (m/s) every physics step. Velocity drives the directional
  // start-line crossing (circuit anti-cheat); omit it and crossings count in any
  // direction (legacy / checkpoint races are unaffected).
  update(x: number, y: number, now: number, vx = 0, vy = 0) {
    if (this.phase === 'finished' || this.elements.length === 0) return;

    // Arm the lap once the car reaches the circuit's far side (anti-shortcut).
    const f = this.startEl;
    if (this.phase === 'racing' && f && f.farRadius !== undefined) {
      const fdx = x - (f.farX ?? f.x), fdy = y - (f.farY ?? f.y);
      if (fdx * fdx + fdy * fdy < f.farRadius * f.farRadius) this.armed = true;
    }

    for (let i = 0; i < this.elements.length; i++) {
      const e = this.elements[i];
      const r = e.radius ?? this.cfg.gateRadius;
      const dx = x - e.x, dy = y - e.y;
      const now2 = dx * dx + dy * dy < r * r;
      if (now2 && !this.inside[i]) this.onEnter(i, now, vx, vy);  // enter edge only
      this.inside[i] = now2;
    }
  }

  // True if the car is crossing element `e` in its FORWARD racing direction.
  // No `forward` set on the element ⇒ always true (non-directional / legacy).
  private isForward(e: RaceElement, vx: number, vy: number): boolean {
    if (e.forward === undefined) return true;
    return vx * Math.cos(e.forward) + vy * Math.sin(e.forward) > 0;
  }
  // Whether an armed full lap is required for this start line (only when the map
  // declared a far point); otherwise fall back to checkpoint/legacy gating.
  private lapArmed(): boolean {
    return this.startEl?.farRadius === undefined ? true : this.armed;
  }

  private onEnter(i: number, now: number, vx: number, vy: number) {
    const e = this.elements[i];
    if (e.type === 'start') {
      if (this.phase === 'pre') {
        // Timing begins on the first FORWARD crossing of the start line.
        if (this.isForward(e, vx, vy)) {
          this.phase = 'racing';
          this.startMs = now;
          this.lap = 1;
          this.collected.clear();
          this.armed = false;   // must go round to arm the first lap
        }
      } else if (this.isCircuit && this.phase === 'racing') {
        // Circuit: the START gate is ALSO the finish line. A lap completes only
        // on a FORWARD, ARMED crossing (after the checkpoints, if any) — then
        // disarm so the next lap must go round again.
        if (this.isForward(e, vx, vy) && this.lapArmed()) {
          this.tryCompleteLap(now);
          this.armed = false;
        }
      }
      return;
    }
    if (this.phase !== 'racing') return;
    if (e.type === 'checkpoint') {
      this.collected.add(i);
      return;
    }
    if (e.type === 'finish' && this.isForward(e, vx, vy)) this.tryCompleteLap(now);
  }

  // Complete a lap (or the whole race on the final lap) — but only once every
  // placed checkpoint has been collected (a premature crossing is ignored).
  private tryCompleteLap(now: number) {
    if (this.collected.size < this.cpTotal) return;
    if (this.lap < this.cfg.laps) {
      this.lap += 1;
      this.collected.clear();   // next lap
    } else {
      this.phase = 'finished';
      this.finishMs = now;
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

// Track type from the placed elements (same rule as RaceState.isCircuit): a
// FINISH ⇒ sprint; only a START (no finish) ⇒ circuit. Used by the desktop for
// the editor status line and to render the start gate as a start/finish line.
export function isCircuitTrack(elements: RaceElement[]): boolean {
  return elements.some((e) => e.type === 'start')
    && !elements.some((e) => e.type === 'finish');
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
