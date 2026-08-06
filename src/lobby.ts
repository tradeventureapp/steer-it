// =============================================================================
//  Lobby / multiplayer slot model — shared by the desktop (authority) and the
//  phone controllers. STEP 1: connection + slots + colours only (no 2nd car).
//
//  Designed for N players. To raise the cap, change PLAYER_CAP — everything
//  (slot assignment, "game full", roster, palette wrap) scales off it. Nothing
//  is hardcoded to "player 1 / player 2".
//
//  TRANSPORT: the existing Supabase Realtime broadcast channel `steer:<code>`.
//  Messages are separated by EVENT NAME so phones and the desktop never react
//  to each other's traffic by accident:
//    phone → desktop :  join | color | leave | control
//    desktop → phone :  lobby | full
//  The DESKTOP is the single authority: it alone assigns slots (no races —
//  Supabase delivers to the desktop's single JS thread, processed in order).
// =============================================================================

// Max simultaneous players. Tested with 2; built for up to this many.
export const PLAYER_CAP = 8;

// =============================================================================
//  RESILIENCE — the SINGLE SOURCE OF TRUTH for the connection lifecycle.
//  EVERY "is this phone still here?" decision (input, slot/lobby retention, car
//  lifecycle, race/XP) reads THIS block and the SAME per-id lastSeen, so the
//  scattered, disagreeing timeouts that produced three separate "drop → gameplay
//  breaks" bugs (de1f475 input-zero, 47319e6 ~30s dropout, respawn-at-start)
//  cannot reappear.
//
//  ONE ordered model, by age = now − lastSeen[clientId] (a packet of ANY kind —
//  control @30Hz or the join heartbeat — refreshes lastSeen):
//    age ≤ INPUT_COAST_MS          CONNECTED     → hold last input (bridge jitter)
//    INPUT_COAST_MS … _NEUTRAL_BY  RECONNECTING  → ramp input to neutral (no runaway)
//    _NEUTRAL_BY … PRESENCE_GRACE  RECONNECTING  → car/slot/race/XP PRESERVED in place
//    age ≥ PRESENCE_GRACE_MS       DEPARTED      → free slot, remove car, finalize race
//
//  INVARIANTS: INPUT_COAST < INPUT_NEUTRAL_BY < PRESENCE_GRACE, and
//  PRESENCE_GRACE_MS must EXCEED the worst realistic transport reconnect, so a
//  recoverable reconnect is NEVER mistaken for a departure (the whole class of
//  bug). Phase 1 = hundreds-of-sessions target; jitter/idempotency = Phase 2;
//  transport-scale (uplink/downlink + rate cut) = Phase 3.
// =============================================================================
export const RESILIENCE = {
  HEARTBEAT_MS: 1200,         // phone liveness emit cadence (control @30Hz also counts)
  INPUT_COAST_MS: 400,        // hold last input through jitter / a sub-second blip
  INPUT_NEUTRAL_BY_MS: 1000,  // input fully ramped to neutral by here (parked, safe)
  PRESENCE_GRACE_MS: 20000,   // reconnecting → departed cutoff (start 20s; pending load-test)
} as const;

// How often a phone re-announces itself (join doubles as a keepalive), and how
// often the desktop re-broadcasts the full lobby for late/again-syncing phones.
// The heartbeat is the liveness emit; its cadence lives in RESILIENCE.
export const PHONE_HEARTBEAT_MS = RESILIENCE.HEARTBEAT_MS;
// Periodic roster re-broadcast (fan-out to every phone). On-change broadcasts carry the
// real-time updates; this is only the late-joiner/again-sync safety net → 5 s is plenty
// (was 2 s — quota quick-win, −60% of the periodic fan-out).
export const LOBBY_SYNC_MS = 5000;

// ---------------------------------------------------------------------------
//  Control send DEADBAND (quota quick-win) — pure + unit-testable.
//  The phone ticks at SEND_HZ (30) but only SENDS when the (quantized) input
//  actually changed, with a keepalive floor so an idle-but-connected phone
//  still emits ≥5 Hz — CONTROL_KEEPALIVE_MS (200) is well inside
//  RESILIENCE.INPUT_COAST_MS (400), so the desktop NEVER mistakes an idle
//  phone for a dropped one (no coast/neutral ramp on a quiet controller).
//  Quantization (0.01 steps) kills gyro micro-jitter that would otherwise
//  defeat the deadband; 0.01 of full lock is imperceptible (desktop lerps).
// ---------------------------------------------------------------------------
export const CONTROL_KEEPALIVE_MS = 200;   // 5 Hz idle floor (< INPUT_COAST_MS 400)

export interface ControlSample {
  steer: number; throttle: number; brake: number; handbrake: boolean;
}

export function quantizeControl(v: number): number {
  return Math.round(v * 100) / 100;
}

export function shouldSendControl(
  prev: ControlSample | null, next: ControlSample, msSinceLastSend: number,
): boolean {
  if (!prev) return true;                                  // first packet
  if (msSinceLastSend >= CONTROL_KEEPALIVE_MS) return true; // keepalive floor
  return next.steer !== prev.steer
    || next.throttle !== prev.throttle
    || next.brake !== prev.brake
    || next.handbrake !== prev.handbrake;
}

// The car's colour set is the Blitz RS identity's palette (ONE unified muted
// retro/90s palette). Re-exported here as CAR_COLORS so every existing consumer
// — the phone colour picker, per-slot default colours, and the roster colour
// names — picks it up unchanged. The 12 colours give more choices than the 8
// slots; per-slot recolour is unchanged (each car renders its own hex).
export type { CarColor } from './vehicles';
export { BLITZ_RS_COLORS as CAR_COLORS } from './vehicles';
// The ARCADE car's two skins, offered as its "colours" — re-exported here so the phone
// can build the RIGHT picker on its FIRST paint from the mode in the join URL (?m=arcade),
// with no flash of the other car's palette while it waits for the host's lobby message.
export { STEEREX_SKIN_COLORS } from './vehicles';

import { BLITZ_RS_COLORS as _BLITZ, STEEREX_SKIN_COLORS as _REX, type CarColor as _CarColor } from './vehicles';
/**
 * The colour palette a race MODE offers — the ONE mapping, shared by the host (what it
 * sends + shows) and the phone (what it paints from the `?m=` join-URL hint), so the two
 * can never disagree. Returns null for an unknown/absent mode, which the phone treats as
 * "car not known yet → draw no swatches" (rather than flashing the wrong car's colours).
 * (The dev-only Fury is a SIM car, not a mode → it rides the SIM palette; the phone never
 * needs a Fury-specific palette.)
 */
export function paletteForMode(mode: string | null | undefined): _CarColor[] | null {
  // Both cars share the SAME 8-colour palette (the Stee-Rex swatches). SIM (Blitz RS) and
  // ARCADE (Stee-Rex) both offer the identical 8 → the phone colour picker is the same for
  // every car. (The dev-only Fury is a SIM car → it rides this palette but ignores the pick.)
  return mode === 'arcade' || mode === 'sim' ? _REX : null;
}

// Player names: short, sanitized (also HTML-unsafe chars stripped because the
// desktop roster renders them). Empty → the roster falls back to "PLAYER n".
export const NAME_MAX = 12;
export function sanitizeName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f<>&"'`\\]/g, '') // strip control + HTML-unsafe chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

// =============================================================================
//  COLOUR VALIDATION — a phone-supplied colour is UNTRUSTED INPUT.
//
//  The host renders player colours into its own DOM (roster dot, live standings,
//  finish feed, podium/results). Those are string-built `innerHTML` sinks, so an
//  unvalidated colour is not merely a wrong swatch — it is an HTML-injection
//  (XSS) vector on the HOST page, whose origin holds the host's Supabase session.
//  A colour therefore NEVER travels as "whatever the phone sent": it is clamped
//  to the shipped palette here, at the one gate both transports pass through.
//
//  The allow-list is the UNION of the shipped palettes (the shared 8 + the legacy
//  Blitz 12). Union rather than the current mode's palette so an OLD CACHED PHONE
//  build that still sends a legacy hex keeps its colour instead of silently
//  losing it — every entry is one of our own literals, so the union is exactly as
//  safe as any single palette.
// =============================================================================
const _ALLOWED_COLORS: ReadonlyMap<string, string> = new Map(
  [..._REX, ..._BLITZ].map((c) => [c.hex.toLowerCase(), c.hex] as const),
);

/**
 * A phone-supplied colour clamped to the palette: returns the CANONICAL palette hex,
 * or null if the value is not an offered colour (unknown hex, wrong type, or an
 * injection payload). Callers treat null as "no colour supplied" — the player keeps
 * their current/default colour, so a rejected value never breaks a join.
 */
export function sanitizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return _ALLOWED_COLORS.get(raw.trim().toLowerCase()) ?? null;
}

/**
 * RENDER-TIME guarantee: the only thing that may reach a CSS value / style attribute
 * is a literal `#rrggbb`. Storage is already palette-clamped (`sanitizeColor`), so this
 * is a SECOND, INDEPENDENT barrier — even if some future path stored an unvalidated
 * string, it can never break out of the attribute and become markup. Anything else
 * collapses to `fallback`.
 */
export function cssColor(raw: unknown, fallback = '#1d3fa0'): string {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim() : fallback;
}

export function colorName(hex: string): string {
  const h = String(hex ?? '').toLowerCase();
  // Search the SHARED 8-colour palette first (Blitz RS + Stee-Rex both use it), then the
  // legacy Blitz 12 (kept for any older stored hex) → the roster shows a name, not a raw hex.
  const c = _REX.find((c) => c.hex.toLowerCase() === h) ?? _BLITZ.find((c) => c.hex.toLowerCase() === h);
  // NOT a known colour → return a NEUTRAL LABEL, never the raw string. This function's
  // result is rendered as roster text, so echoing an arbitrary input back would re-open
  // the injection path the colour clamp closes.
  return c ? c.name : (/^#[0-9a-f]{6}$/i.test(h) ? h : 'Custom');
}
// Default colour for a slot (wraps the shared 8-colour palette so N > palette still works) —
// so an un-picked car spawns in a DISTINCT colour that both cars' pickers recognise.
export function defaultColorForSlot(slot: number): string {
  return _REX[slot % _REX.length].hex;
}

// ---- Broadcast event names ----
export const EV = {
  // phone → desktop
  join: 'join',       // { id, color, name? }  — join + keepalive heartbeat
  color: 'color',     // { id, color }  — colour choice (immediate)
  name: 'name',       // { id, name }   — player rename (immediate)
  leave: 'leave',     // { id }         — clean disconnect (best-effort)
  control: 'control', // { id, slot, steer, throttle, brake, handbrake }
  // desktop → phone
  lobby: 'lobby',     // { players: LobbyPlayer[], cap }
  full: 'full',       // { id }         — your join was rejected (all slots taken)
} as const;

// ---- Payload shapes ----
export interface LobbyPlayer {
  slot: number;
  id: string;
  color: string;
  name?: string;      // empty/absent → UI shows "PLAYER n"
  connected: boolean;
}
export interface LobbyMsg { players: LobbyPlayer[]; cap: number; }

// =============================================================================
//  LobbyState — the desktop authority's slot model, as a PURE state machine
//  (no transport, no DOM) so it's unit-testable and the slot logic lives in one
//  place. desktop.ts owns one instance and wires Supabase messages to it.
//
//  Slot assignment: the lowest free slot in [0, cap). A known id keeps its slot
//  (reclaim on reconnect). All mutators take an explicit `now` (testable time).
// =============================================================================
export interface LobbyStatePlayer { id: string; color: string; name?: string; lastSeen: number; }

export class LobbyState {
  readonly cap: number;
  private players = new Map<number, LobbyStatePlayer>();

  constructor(cap: number = PLAYER_CAP) { this.cap = cap; }

  size(): number { return this.players.size; }

  slotOf(id: string): number | null {
    for (const [slot, p] of this.players) if (p.id === id) return slot;
    return null;
  }

  private firstFreeSlot(): number | null {
    for (let s = 0; s < this.cap; s++) if (!this.players.has(s)) return s;
    return null;
  }

  snapshot(): LobbyPlayer[] {
    const arr: LobbyPlayer[] = [];
    for (const [slot, p] of this.players) {
      arr.push({ slot, id: p.id, color: p.color, name: p.name, connected: true });
    }
    return arr.sort((a, b) => a.slot - b.slot);
  }

  // Join or reclaim. Returns the assigned slot (null = lobby full) and whether
  // the visible lobby changed (new slot / colour / name). Always refreshes
  // lastSeen. The join heartbeat carries colour + name so both survive reclaim.
  join(
    id: string, color: string | undefined, now: number, name?: string,
  ): { slot: number | null; changed: boolean } {
    const cleanName = name === undefined ? undefined : (sanitizeName(name) || '');
    // COLOUR CLAMP (storage backstop). Every colour that enters the lobby model passes
    // `sanitizeColor` HERE, so `p.color` can only ever hold a palette hex no matter which
    // call site (or future transport) supplied it. A rejected colour degrades to
    // "none supplied" — the player keeps their current colour / the slot default — so a
    // bad value never blocks a join. Callers ALSO validate at the transport boundary
    // (desktop.ts handleColor/handleJoin); this is the defence-in-depth second layer.
    const cleanColor = color === undefined ? undefined : (sanitizeColor(color) ?? undefined);
    let slot = this.slotOf(id);
    if (slot !== null) {
      const p = this.players.get(slot)!;
      p.lastSeen = now;
      let changed = false;
      if (cleanColor && cleanColor !== p.color) { p.color = cleanColor; changed = true; }
      if (cleanName !== undefined && cleanName !== (p.name ?? '')) {
        p.name = cleanName || undefined;
        changed = true;
      }
      return { slot, changed };
    }
    slot = this.firstFreeSlot();
    if (slot === null) return { slot: null, changed: false };
    this.players.set(slot, {
      id,
      color: cleanColor || defaultColorForSlot(slot),
      name: cleanName ? cleanName : undefined,
      lastSeen: now,
    });
    return { slot, changed: true };
  }

  // Colour pick — updates an existing player (joins if there is room).
  setColor(id: string, color: string, now: number): { changed: boolean } {
    const r = this.join(id, color, now);
    return { changed: r.slot !== null && r.changed };
  }

  // Name change — same join path, carrying only the name.
  setName(id: string, name: string, now: number): { changed: boolean } {
    const r = this.join(id, undefined, now, name);
    return { changed: r.slot !== null && r.changed };
  }

  touch(id: string, now: number) {
    const slot = this.slotOf(id);
    if (slot !== null) this.players.get(slot)!.lastSeen = now;
  }

  leave(id: string): { changed: boolean } {
    const slot = this.slotOf(id);
    if (slot === null) return { changed: false };
    this.players.delete(slot);
    return { changed: true };
  }

  // Free slots whose phone has gone quiet beyond the timeout. Returns the freed
  // slots (with id + how long they'd been silent) so the caller can log WHY a
  // car vanished — distinguishing a genuinely-gone phone from other causes.
  sweep(
    now: number, timeout: number = RESILIENCE.PRESENCE_GRACE_MS,
  ): { changed: boolean; freed: Array<{ slot: number; id: string; ageMs: number }> } {
    const freed: Array<{ slot: number; id: string; ageMs: number }> = [];
    for (const [slot, p] of [...this.players]) {
      const ageMs = now - p.lastSeen;
      if (ageMs > timeout) {
        this.players.delete(slot);
        freed.push({ slot, id: p.id, ageMs });
      }
    }
    return { changed: freed.length > 0, freed };
  }
}

// ---- Stable per-tab client id (survives reload → reclaim same slot) ----
const CLIENT_ID_KEY = 'steerit_client_id';
export function getClientId(): string {
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = 'c_' + Math.random().toString(36).slice(2, 10) +
        Date.now().toString(36).slice(-4);
      sessionStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage blocked — fall back to an in-memory id.
    return 'c_' + Math.random().toString(36).slice(2, 12);
  }
}
