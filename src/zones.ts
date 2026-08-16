// =============================================================================
//  STEER IT — ZONE tracking for leaderboard anti-cheat (Time Attack + XP).
//
//  PURE: no DOM, no physics, no transport — like xp.ts / time-attack.ts. It is fed
//  the car's point on the fixed physics step (the SAME honest, frame-rate-independent
//  clock lap time uses) and answers two questions used ONLY for leaderboard validity /
//  proof-of-play — it never affects driving and is invisible in normal play.
//
//  ZONES: each racing track's CENTRELINE (an arc-length-even closed polyline, anchored
//  at the finish and oriented in the racing direction — the map builds it, see
//  MapDefinition.zonePath) is split into 6 EQUAL arc-length buckets, laid end to end
//  with no gaps. "Which zone am I in" = the nearest centreline point's bucket, so a zone
//  is the FULL WIDTH of the ribbon by construction (a car anywhere on the band is within
//  half a track-width of the centreline) — generous, so legit driving never misses one;
//  only a real shortcut (which also trips the off-track check) skips a zone.
//
//  TWO USES, per mode:
//   • TIME ATTACK: a lap is zone-valid iff all 6 zones were entered IN ORDER during it
//     (first-entry timestamps present + monotonic). The submit sends those 6 splits; the
//     RPC re-checks the structure. Combined with off-track invalidation, a shortcut is
//     caught whether it cuts across grass (off-track) or reverses on the ribbon (zones).
//   • XP: a survival run need NOT finish a lap, so zones are PROOF-OF-PLAY, not a gate:
//     the run reports distinct zones visited, completed loops, and a contiguity flag, and
//     the RPC rejects only contradictory / no-play data (a fabricated console score) —
//     a legit partial run (ended mid-track) is accepted.
// =============================================================================

export type ZonePoint = [number, number];
export const ZONE_COUNT = 6;

/** The proof-of-play summary an XP run sends alongside its score. */
export interface XpProof {
  zc: number;    // distinct zones visited this run (0..6)
  laps: number;  // completed forward loops (0→…→5→0)
  ord: boolean;  // contiguous traversal — no zone JUMPS (a teleport/fabricated feed breaks it)
}

export class ZoneTracker {
  private readonly path: ZonePoint[];
  private readonly n: number;
  private lastIdx = 0;                 // nearest-index search hint (car moves smoothly)
  // ---- per-LAP state (Time Attack) ----
  private lapStart = 0;
  private firstEntry: (number | null)[] = new Array(ZONE_COUNT).fill(null);
  // ---- whole-RUN state (XP proof-of-play) ----
  private readonly visited = new Set<number>();
  private laps = 0;
  private ordOk = true;
  private lastZone = -1;

  /** `path` = the world-space centreline: arc-length-even, closed, index 0 = finish,
   *  increasing index = racing direction. */
  constructor(path: ZonePoint[]) {
    this.path = path;
    this.n = path.length;
  }

  private zoneOf(idx: number): number {
    // 6 equal index ranges; index 0 = finish ⇒ zone 0 starts at the finish.
    return Math.min(ZONE_COUNT - 1, Math.floor((idx * ZONE_COUNT) / this.n));
  }

  // Nearest centreline index to (x,y). Windowed around the last hit (the car moves a little
  // per step), falling back to a full scan when the window's best sits at its edge (a jump /
  // respawn) so a teleport is found, not silently clamped.
  private nearestIndex(x: number, y: number): number {
    const W = Math.max(6, Math.floor(this.n / 12));   // ~half a zone of slack
    let best = this.lastIdx, bestD = Infinity;
    for (let k = -W; k <= W; k++) {
      const i = ((this.lastIdx + k) % this.n + this.n) % this.n;
      const dx = this.path[i][0] - x, dy = this.path[i][1] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    // Window edge ⇒ the true nearest may be outside it → full scan.
    const off = ((best - this.lastIdx) % this.n + this.n) % this.n;
    if (off === W || off === this.n - W) {
      for (let i = 0; i < this.n; i++) {
        const dx = this.path[i][0] - x, dy = this.path[i][1] - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    this.lastIdx = best;
    return best;
  }

  /** Feed the car's world point + game clock (ms) every fixed physics step. */
  update(x: number, y: number, now: number): void {
    const z = this.zoneOf(this.nearestIndex(x, y));

    // per-LAP first-entry (Time Attack)
    if (this.firstEntry[z] === null) this.firstEntry[z] = now - this.lapStart;

    // whole-RUN proof-of-play (XP)
    this.visited.add(z);
    if (this.lastZone === -1) {
      this.lastZone = z;
    } else if (z !== this.lastZone) {
      const fwd = (this.lastZone + 1) % ZONE_COUNT;
      const back = (this.lastZone + ZONE_COUNT - 1) % ZONE_COUNT;
      if (z === fwd) {
        if (this.lastZone === ZONE_COUNT - 1 && z === 0) this.laps++;   // forward wrap = a lap
      } else if (z !== back) {
        this.ordOk = false;   // a JUMP of ≥2 zones — impossible by driving (teleport/fabrication)
      }
      this.lastZone = z;
    }
  }

  // ---- Time Attack ----
  /** True at a lap-completion instant iff every zone was entered in order this lap. */
  lapComplete(): boolean {
    let prev = -1;
    for (let z = 0; z < ZONE_COUNT; z++) {
      const t = this.firstEntry[z];
      if (t === null || t < prev) return false;
      prev = t;
    }
    return true;
  }
  /** The just-completed lap's 6 split ms (from lap start), or null if not zone-valid. */
  lapSplits(): number[] | null {
    if (!this.lapComplete()) return null;
    return this.firstEntry.map((t) => Math.max(0, Math.round(t as number)));
  }
  /** Start a fresh lap accumulator (called at each Time Attack lap boundary). */
  resetLap(now: number): void {
    this.lapStart = now;
    this.firstEntry = new Array(ZONE_COUNT).fill(null);
  }

  // ---- XP ----
  /** The whole-run proof-of-play summary. */
  xpProof(): XpProof {
    return { zc: this.visited.size, laps: this.laps, ord: this.ordOk };
  }
}

/** Does an XP proof pass the SAME structural checks the RPC applies? (client mirror, so a
 *  contradictory run neither records locally nor submits — one validity rule.) `value` is the
 *  run score. Legit runs always pass; a fabricated/teleport run fails. */
export function xpProofValid(p: XpProof, value: number): boolean {
  if (!p.ord) return false;                 // teleport / fabricated position feed
  if (value > 0 && p.zc === 0) return false;   // a score with no play
  if (p.laps > 0 && p.zc < ZONE_COUNT) return false;   // a completed loop passes all zones
  return true;
}
