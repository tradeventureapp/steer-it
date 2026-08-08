// =============================================================================
//  FREE RIDE session timing — PURE state machine (no DOM, no analytics, no clock).
//
//  Extracted deliberately: "how long did they actually play" has fiddly rules — begin
//  only on real driving, count VISIBLE time only, end exactly once on whichever signal
//  arrives first — and the browser preview can't exercise them (a hidden tab stalls
//  rAF, so no car ever moves). Kept pure with an injected `now`, it is unit-testable to
//  the millisecond, matching the project's other pure modules (lobby / xp / cars).
//
//  The owner (desktop.ts) supplies the clock and turns the returned signals into
//  analytics events; nothing here knows what an analytics provider is.
// =============================================================================

/** What the caller should emit after a transition. `null` = nothing happened. */
export type SessionSignal = 'start' | 'end' | null;

export class FreeRideSession {
  private started = false;
  private ended = false;
  private visibleMs = 0;             // accumulated time the page was VISIBLE while driving
  // Start of the current visible stretch; NULL when paused/stopped.
  // ⚠️ null, not 0 — 0 is a legitimate timestamp, and using it as the "paused" sentinel
  // made every method no-op at t=0 (invisible in production, where Date.now() is never 0,
  // but it silently broke the unit tests and would break any injected clock).
  private resumedAt: number | null = null;

  /** Has the session begun (a car was actually being driven)? */
  isStarted(): boolean { return this.started; }
  /** Terminal — an ended session never restarts within a page life. */
  isEnded(): boolean { return this.ended; }

  /**
   * Driving was observed. Begins the session (and the clock) on the FIRST call only —
   * loading the screen, or nudging a car after the session already ended, must not
   * start or restart anything.
   */
  begin(now: number): SessionSignal {
    if (this.started || this.ended) return null;
    this.started = true;
    this.resumedAt = now;
    return 'start';
  }

  /** Page hidden: bank the visible stretch, then end (a hidden tab is not playing). */
  hide(now: number): SessionSignal {
    this.pause(now);
    return this.end();
  }

  /** Page visible again: resume the clock. Hidden time is never counted. */
  show(now: number): void {
    if (!this.started || this.ended || this.resumedAt !== null) return;
    this.resumedAt = now;
  }

  /** Left free ride (menu / race / XP / editor) or the page is going away. */
  leave(now: number): SessionSignal {
    this.pause(now);
    return this.end();
  }

  /** Visible-time total. Safe to call at any point, ended or not. */
  elapsedMs(now: number): number {
    return this.visibleMs + (this.resumedAt !== null ? now - this.resumedAt : 0);
  }

  private pause(now: number): void {
    if (this.resumedAt === null) return;
    this.visibleMs += now - this.resumedAt;
    this.resumedAt = null;
  }
  private end(): SessionSignal {
    if (!this.started || this.ended) return null;   // never started ⇒ nothing to report
    this.ended = true;
    return 'end';
  }
}
