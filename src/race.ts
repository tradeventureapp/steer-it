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
  countdownMs: number;     // STANDING START: how long the grid is held before GO
  finishGraceMs: number;   // DNF timeout: grace after the LEADER finishes before stragglers are DNF
}

export const RACE_CONFIG: RaceConfig = {
  laps: 1,
  maxCheckpoints: 5,
  gateRadius: 5.03,   // m — real metres on the Stage-C1 ruler (was 1.7 for the 1/3 car; ×2.96)
  countdownMs: 3000,  // 3 → 2 → 1 → GO
  finishGraceMs: 60000,  // 60 s — once the winner crosses, everyone else has this long to finish
};

// 'countdown' = a STANDING START: the grid is held, inputs are ignored, and the race
// clock has not begun. It is entered ONLY via beginCountdown(); a host that never calls
// it sees the original pre → racing → finished flow, unchanged.
export type RacePhase = 'pre' | 'countdown' | 'racing' | 'finished';

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
  // --- standing start ---
  locked: boolean;       // hold the car + ignore its inputs (true only during the countdown)
  countdownMs: number;   // ms left until GO (0 unless counting down)
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
  // TIMING IS ON THE LINE, not near it. A DIRECTIONAL element (one with `forward` — the
  // start/finish lines) is a real LINE PLANE: it triggers on the step the fed point crosses
  // from behind it to past it, within the line's half-width. So a lap completes exactly as
  // the car reaches the line, which is what a transponder does. Non-directional elements
  // (checkpoints — a point you drive near, with no orientation) keep the proximity gate.
  //
  // Signed distance along the racing direction, per element: <0 behind the line, ≥0 past it.
  // Held across steps so the sign CHANGE is what fires. NaN = no reading yet (first step, or
  // reset) ⇒ nothing can fire until we have two samples to compare.
  private prevSd: number[];
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
  private cdStartMs = 0;   // when the standing-start countdown began
  private lastX = 0;       // last fed car point (for the live-progress estimate)
  private lastY = 0;

  constructor(elements: RaceElement[], cfg: RaceConfig = RACE_CONFIG) {
    this.elements = elements;
    this.cfg = { ...cfg, laps: clampLaps(cfg.laps) };
    this.cpTotal = elements.filter((e) => e.type === 'checkpoint').length;
    const hasStart = elements.some((e) => e.type === 'start');
    const hasFinish = elements.some((e) => e.type === 'finish');
    this.isCircuit = hasStart && !hasFinish;
    this.startEl = elements.find((e) => e.type === 'start') ?? null;
    this.inside = elements.map(() => false);
    this.prevSd = elements.map(() => NaN);
  }

  reset() {
    this.phase = 'pre';
    this.startMs = 0;
    this.finishMs = 0;
    this.lap = 0;
    this.collected.clear();
    this.armed = false;
    this.cdStartMs = 0;
    this.inside = this.elements.map(() => false);
    this.prevSd = this.elements.map(() => NaN);
  }

  /** Signed distance past element `e`'s line plane (<0 behind, ≥0 past), and the offset
   *  ACROSS it. Only meaningful for a directional element. */
  private planeCoords(e: RaceElement, x: number, y: number): { sd: number; lat: number } {
    const c = Math.cos(e.forward!), s = Math.sin(e.forward!);
    const dx = x - e.x, dy = y - e.y;
    return { sd: dx * c + dy * s, lat: -dx * s + dy * c };
  }

  /**
   * STANDING START. Hold the grid for `countdownMs`, then GO: the clock starts at the GO
   * instant (not at a line crossing) and lap 1 is already running, so ONE armed forward
   * crossing completes a 1-lap race.
   *
   * This also fixes the flying start's real bug: the grid sits INSIDE the start gate (a few
   * m from the line, which has a band-wide radius), and on the stationary first frame the
   * crossing is not "forward" (v = 0), so the enter-edge was consumed with the race still
   * in 'pre'. The race then only STARTED on the next pass — a whole lap later — which is
   * why a 1-lap race took ~2 laps to finish. Holding `inside[]` across the countdown and
   * entering 'racing' at GO removes that entirely.
   *
   * OPT-IN: never call this and the flow is exactly as before (a sprint keeps its flying
   * start off the first crossing).
   */
  beginCountdown(now: number) {
    this.reset();
    this.phase = 'countdown';
    this.cdStartMs = now;
  }

  // Feed the car position (world metres), a timestamp (ms), and OPTIONALLY the
  // car's velocity (m/s) every physics step. Velocity drives the directional
  // start-line crossing (circuit anti-cheat); omit it and crossings count in any
  // direction (legacy / checkpoint races are unaffected).
  update(x: number, y: number, now: number, vx = 0, vy = 0) {
    this.lastX = x; this.lastY = y;   // remember for the live-progress estimate
    if (this.phase === 'finished' || this.elements.length === 0) return;

    if (this.phase === 'countdown') {
      // Held on the grid: no gate may trigger. But DO keep the per-element state current —
      // the grid sits behind the line and inside its old radius, so at GO that must already
      // be latched or the car's first metre would read as a fresh crossing.
      for (let i = 0; i < this.elements.length; i++) {
        const e = this.elements[i];
        const r = e.radius ?? this.cfg.gateRadius;
        const dx = x - e.x, dy = y - e.y;
        this.inside[i] = dx * dx + dy * dy < r * r;
        if (e.forward !== undefined) this.prevSd[i] = this.planeCoords(e, x, y).sd;
      }
      if (now - this.cdStartMs < this.cfg.countdownMs) return;
      // GO. The clock starts at the exact GO instant, not at this frame, so the elapsed
      // time is independent of the frame rate. Lap 1 is already running and UNARMED, so
      // the car must go round before its next crossing can complete it.
      this.phase = 'racing';
      this.startMs = this.cdStartMs + this.cfg.countdownMs;
      this.lap = 1;
      this.collected.clear();
      this.armed = false;
      // fall through — this frame is already racing
    }

    // Arm the lap once the car reaches the circuit's far side (anti-shortcut).
    const f = this.startEl;
    if (this.phase === 'racing' && f && f.farRadius !== undefined) {
      const fdx = x - (f.farX ?? f.x), fdy = y - (f.farY ?? f.y);
      if (fdx * fdx + fdy * fdy < f.farRadius * f.farRadius) this.armed = true;
    }

    for (let i = 0; i < this.elements.length; i++) {
      const e = this.elements[i];
      const r = e.radius ?? this.cfg.gateRadius;
      if (e.forward !== undefined) {
        // LINE PLANE: fire on the step the point goes from behind the line to past it,
        // within the line's half-width. Sweeping the sign change also means a step can
        // never tunnel through the line, however fast the car is going.
        const { sd, lat } = this.planeCoords(e, x, y);
        const prev = this.prevSd[i];
        if (!Number.isNaN(prev) && prev < 0 && sd >= 0 && Math.abs(lat) < r) {
          this.onEnter(i, now, vx, vy);
        }
        this.prevSd[i] = sd;
      } else {
        const dx = x - e.x, dy = y - e.y;
        const now2 = dx * dx + dy * dy < r * r;
        if (now2 && !this.inside[i]) this.onEnter(i, now, vx, vy);  // enter edge only
        this.inside[i] = now2;
      }
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
      locked: this.phase === 'countdown',
      countdownMs: this.phase === 'countdown'
        ? Math.max(0, this.cfg.countdownMs - (now - this.cdStartMs))
        : 0,
    };
  }

  /**
   * A monotonic "how far through the race" scalar for LIVE ordering: laps completed
   * + an intra-lap fraction. Finished ⇒ total laps. Racing on a circuit: 0→0.5 as
   * the car nears the FAR point (the arming gate), 0.5→1.0 as it heads back to the
   * start line — so an armed car always outranks a not-yet-armed car on the same
   * lap. Straight-line distance to the gate is a coarse but stable tiebreak (the
   * lap + armed half dominates); checkpoints are the fallback for sprint tracks.
   * Ordering only — the authoritative lap/finish logic is untouched.
   */
  progress(): number {
    if (this.phase === 'finished') return this.cfg.laps;
    if (this.phase !== 'racing') return 0;
    const lapsDone = Math.max(0, this.lap - 1);
    const f = this.startEl;
    if (f && f.farRadius !== undefined) {
      const fx = f.farX ?? f.x, fy = f.farY ?? f.y;
      const ref = Math.hypot(fx - f.x, fy - f.y) || 1;
      if (!this.armed) {
        const d = Math.hypot(this.lastX - fx, this.lastY - fy);
        return lapsDone + 0.5 * clamp01(1 - d / ref);
      }
      const d = Math.hypot(this.lastX - f.x, this.lastY - f.y);
      return lapsDone + 0.5 + 0.5 * clamp01(1 - d / ref);
    }
    // sprint / checkpoint tracks: fraction of this lap's checkpoints collected
    return lapsDone + (this.cpTotal > 0 ? this.collected.size / this.cpTotal : 0);
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// =============================================================================
//  MULTI-CAR RACE — one RaceState per car (each races the same elements/laps
//  independently, reusing the directional + armed-lap counting), plus a
//  FINISHING ORDER recorded as each car completes. Pure + testable.
//
//  The host feeds EVERY car's position each step (`update(slot, …)`), reads
//  `finishers()` for the live feed + `isComplete(connectedSlots)` for the podium.
//  Disconnect = `remove(slot)`: an unfinished car is dropped and never blocks the
//  race end; a finished car keeps its result. The race ends only when every
//  STILL-CONNECTED car has finished.
// =============================================================================
// One row of the LIVE (mid-race) standings — P1..PN over all connected cars.
export interface LiveRank {
  slot: number;
  position: number;   // 1-based live position
  finished: boolean;  // already crossed the final line (locked at the top)
  lap: number;        // current 1-based lap (for the "L2" readout)
}

export interface Finisher {
  slot: number;
  position: number;   // 1-based finishing position (assigned in finish order)
  finishMs: number;   // race time at finish (ms)
}

// A full-results row: every finisher first (with a time), then every DNF car
// (connected-but-unfinished when the race ended), ranked after the finishers.
export interface RaceResultRow {
  slot: number;
  position: number;   // 1-based; finishers keep their finish order, DNF continue after them
  dnf: boolean;       // true = did not finish (no time)
  finishMs: number;   // finish time (ms); 0 / ignore when dnf
  lap: number;        // laps reached (used to rank DNF cars, more = better)
}

const EMPTY_SET: ReadonlySet<number> = new Set();

export class RaceManager {
  private readonly elements: RaceElement[];
  private readonly cfg: RaceConfig;
  private readonly cars = new Map<number, RaceState>();
  private order: Finisher[] = [];
  private finished = new Set<number>();
  // DNF timeout: the instant the FIRST car finished (null until then). The grace
  // window runs from here; when it expires, still-racing connected cars are DNF and
  // the race ends — so a stuck car can never hang the podium forever.
  private leaderFinishMs: number | null = null;

  constructor(elements: RaceElement[], cfg: RaceConfig = RACE_CONFIG) {
    this.elements = elements;
    this.cfg = cfg;
  }

  // When a standing start is running, the SAME instant is handed to every car — including
  // one that joins mid-countdown — so the whole grid unlocks on one shared GO.
  private cdAt: number | null = null;

  private state(slot: number): RaceState {
    let rs = this.cars.get(slot);
    if (!rs) {
      rs = new RaceState(this.elements, this.cfg);
      if (this.cdAt !== null) rs.beginCountdown(this.cdAt);
      this.cars.set(slot, rs);
    }
    return rs;
  }

  /** STANDING START for the whole grid: one countdown, everyone unlocks on the same GO. */
  beginCountdown(now: number): void {
    this.cdAt = now;
    this.order = [];
    this.finished.clear();
    this.leaderFinishMs = null;   // fresh grid → grace timer disarmed
    for (const rs of this.cars.values()) rs.beginCountdown(now);
  }

  // Register a car so it exists before it moves (optional; update() also creates).
  add(slot: number): void { this.state(slot); }

  // Advance one car. When its RaceState transitions to finished, append it to the
  // finishing order with the next position + its finish time. No-op once a car
  // has finished (its result is locked) — so it never double-records.
  update(slot: number, x: number, y: number, now: number, vx = 0, vy = 0): void {
    if (this.finished.has(slot)) return;
    const rs = this.state(slot);
    rs.update(x, y, now, vx, vy);
    const h = rs.hud(now);
    if (h.finished) {
      this.finished.add(slot);
      this.order.push({ slot, position: this.order.length + 1, finishMs: h.finishMs });
      if (this.leaderFinishMs === null) this.leaderFinishMs = now;   // start the DNF grace timer
    }
  }

  // Disconnect: stop tracking the car. Its finishing-order entry (if any) stays —
  // a finished-then-left player can still appear in results — but it is no longer
  // "connected", so isComplete() never waits on it. Clearing `finished` lets the
  // slot race fresh if it's later reclaimed by a new player.
  remove(slot: number): void {
    this.cars.delete(slot);
    this.finished.delete(slot);
  }

  // Rematch: zero every car's progress + the finishing order, keep the car set.
  reset(): void {
    for (const rs of this.cars.values()) rs.reset();
    this.order = [];
    this.finished.clear();
    this.leaderFinishMs = null;
    this.cdAt = null;   // drop the standing start; the host re-arms it if it wants one
  }

  // ---- DNF timeout ---------------------------------------------------------
  // The grace window opens when the LEADER finishes. `graceMsLeft` is what the
  // on-screen "Race ends in …" countdown shows; null = the leader hasn't finished
  // yet (no countdown). `graceExpired` fires once, at the end of that window.
  graceMsLeft(now: number): number | null {
    if (this.leaderFinishMs === null) return null;
    return Math.max(0, this.cfg.finishGraceMs - (now - this.leaderFinishMs));
  }
  graceExpired(now: number): boolean {
    return this.leaderFinishMs !== null && now - this.leaderFinishMs >= this.cfg.finishGraceMs;
  }

  /**
   * The SHARED standing-start countdown: ms until GO, or 0 when not counting down. Read
   * this for the on-screen countdown rather than any one car's HUD — it is one countdown
   * for the whole grid, and it exists even before a car has been fed a frame.
   */
  countdownMs(now: number): number {
    if (this.cdAt === null) return 0;
    return Math.max(0, this.cfg.countdownMs - (now - this.cdAt));
  }
  /** True while the grid is held (inputs must be ignored + cars kept stationary). */
  locked(now: number): boolean {
    return this.cdAt !== null && now - this.cdAt < this.cfg.countdownMs;
  }

  // Per-car HUD (lap/time) for a readout. Unknown slot ⇒ an inactive HUD.
  hud(slot: number, now: number): RaceHud {
    return (this.cars.get(slot) ?? new RaceState(this.elements, this.cfg)).hud(now);
  }
  // A car's collected checkpoints (open-map render dimming).
  collectedElementIndices(slot: number): ReadonlySet<number> {
    return this.cars.get(slot)?.collectedElementIndices() ?? EMPTY_SET;
  }

  finishers(): Finisher[] { return this.order.slice(); }
  hasFinishers(): boolean { return this.order.length > 0; }
  isFinished(slot: number): boolean { return this.finished.has(slot); }

  // COMPLETE when ≥1 car is connected and EITHER every connected car has finished,
  // OR the DNF grace window has expired after the leader finished (a stuck car can
  // never hang the race). Disconnected cars are ignored — they never block the end.
  isComplete(connectedSlots: Iterable<number>, now?: number): boolean {
    const slots = [...connectedSlots];
    if (slots.length === 0) return false;
    if (slots.every((s) => this.finished.has(s))) return true;
    return now !== undefined && this.graceExpired(now);   // timeout → end with DNF stragglers
  }

  // Final standings: every finisher (with a time), then every connected car that did
  // NOT finish, ranked after them by laps reached (more = better), then slot. Used to
  // build the podium + results list; the timeout path is what surfaces the DNF rows.
  results(connectedSlots: Iterable<number>, now: number): RaceResultRow[] {
    const rows: RaceResultRow[] = this.order.map((f) => ({
      slot: f.slot, position: f.position, dnf: false, finishMs: f.finishMs, lap: this.cfg.laps,
    }));
    const dnf = [...connectedSlots]
      .filter((s) => !this.finished.has(s))
      .map((s) => ({ slot: s, lap: this.hud(s, now).lap }))
      .sort((a, b) => (b.lap - a.lap) || (a.slot - b.slot));
    let pos = rows.length;
    for (const d of dnf) rows.push({ slot: d.slot, position: ++pos, dnf: true, finishMs: 0, lap: d.lap });
    return rows;
  }

  // LIVE standings for the in-race panel: FINISHED cars first (locked in their
  // finish order), then the still-racing cars ordered by progress() DESC (laps
  // completed, then intra-lap progress; slot breaks ties for a stable list). P1..PN
  // over ALL connected cars, updated every frame as cars overtake.
  liveOrder(connectedSlots: Iterable<number>, now: number): LiveRank[] {
    const slots = [...connectedSlots];
    const finishedSlots = this.order.filter((f) => slots.includes(f.slot)).map((f) => f.slot);
    const racing = slots.filter((s) => !this.finished.has(s)).sort((a, b) =>
      ((this.cars.get(b)?.progress() ?? 0) - (this.cars.get(a)?.progress() ?? 0)) || (a - b));
    return [...finishedSlots, ...racing].map((slot, i) => ({
      slot, position: i + 1, finished: this.finished.has(slot), lap: this.hud(slot, now).lap,
    }));
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
