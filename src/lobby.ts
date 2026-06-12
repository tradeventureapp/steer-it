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

// A phone is considered disconnected if the desktop hasn't heard from it
// (join heartbeat / control / color) within this window → its slot is freed.
export const IDLE_TIMEOUT_MS = 6000;

// How often a phone re-announces itself (join doubles as a keepalive), and how
// often the desktop re-broadcasts the full lobby for late/again-syncing phones.
export const PHONE_HEARTBEAT_MS = 1200;
export const LOBBY_SYNC_MS = 2000;

// On-brand neon car colours (logo / synthwave palette). At least PLAYER_CAP of
// them so every slot gets a sensible default; players may pick any.
export interface CarColor { name: string; hex: string; }
export const CAR_COLORS: CarColor[] = [
  { name: 'blue',    hex: '#2d7cff' },
  { name: 'magenta', hex: '#ff2d95' },
  { name: 'orange',  hex: '#ff8a3d' },
  { name: 'green',   hex: '#39ff6a' },
  { name: 'cyan',    hex: '#2de2e6' },
  { name: 'yellow',  hex: '#ffe23d' },
  { name: 'purple',  hex: '#b15cff' },
  { name: 'red',     hex: '#ff3b3b' },
  { name: 'pink',    hex: '#ff7ad9' },
  { name: 'lime',    hex: '#b6ff3d' },
];

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

export function colorName(hex: string): string {
  const c = CAR_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase());
  return c ? c.name : hex;
}
// Default colour for a slot (wraps the palette so N > palette still works).
export function defaultColorForSlot(slot: number): string {
  return CAR_COLORS[slot % CAR_COLORS.length].hex;
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
    let slot = this.slotOf(id);
    if (slot !== null) {
      const p = this.players.get(slot)!;
      p.lastSeen = now;
      let changed = false;
      if (color && color !== p.color) { p.color = color; changed = true; }
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
      color: color || defaultColorForSlot(slot),
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

  // Free slots whose phone has gone quiet beyond the timeout.
  sweep(now: number, timeout: number = IDLE_TIMEOUT_MS): { changed: boolean } {
    let changed = false;
    for (const [slot, p] of [...this.players]) {
      if (now - p.lastSeen > timeout) { this.players.delete(slot); changed = true; }
    }
    return { changed };
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
