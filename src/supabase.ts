import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.'
  );
}

export const supabase = createClient(url, key, {
  realtime: {
    params: { eventsPerSecond: 60 },
    // Keepalive: ping the socket well INSIDE the server's ~60s idle window so an
    // active game never gets torn down for "inactivity". (Default is 25s; we go
    // tighter to be safe across flaky Wi-Fi.)
    heartbeatIntervalMs: 15000,
    // Channel join timeout.
    timeout: 12000,
  },
});

export function channelName(code: string) {
  return `steer:${code}`;
}

// =============================================================================
//  Resilient Realtime channel — survives transient disconnects.
//
//  Supabase/Phoenix channels are single-use: once a channel instance closes or
//  errors you must create a NEW instance to rejoin (you cannot call subscribe()
//  twice on the same one). This wrapper does exactly that: on
//  CLOSED / TIMED_OUT / CHANNEL_ERROR it removes the dead channel and re-creates
//  + re-wires + re-subscribes a fresh one for the SAME room (with backoff), so
//  the game auto-recovers without a QR rescan. All sends go through it so they
//  always target the current live channel (and no-op while reconnecting).
//
//  `wire(ch)` re-registers the broadcast handlers on each (re)created channel.
//  Hooks: onReady (SUBSCRIBED) / onDrop (a fatal status) — both timestamp-logged.
// =============================================================================
type BroadcastMsg = { type: 'broadcast'; event: string; payload: unknown };

export interface ResilientChannel {
  send(msg: BroadcastMsg): void;
  isReady(): boolean;
  current(): RealtimeChannel;
}

const isoNow = () => new Date().toISOString();

export function createResilientChannel(
  name: string,
  config: { broadcast?: { self?: boolean } },
  wire: (ch: RealtimeChannel) => void,
  hooks: { label: string; onReady?: () => void; onDrop?: (status: string) => void } = { label: 'realtime' },
): ResilientChannel {
  const label = hooks.label;
  let ch: RealtimeChannel;
  let ready = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const log = (msg: string) => console.info(`[${label}] ${isoNow()} ${msg}`);

  function scheduleReconnect(reason: string) {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** attempts, 8000); // 1s,2s,4s,8s…cap 8s
    attempts++;
    log(`reconnecting in ${delay}ms (attempt ${attempts}) after ${reason}`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      try { supabase.removeChannel(ch); } catch { /* ignore */ }
      connect();
    }, delay);
  }

  function connect() {
    ch = supabase.channel(name, { config });
    wire(ch);
    ch.subscribe((status, err) => {
      log(`status=${status}${err ? ` err=${(err as Error)?.message ?? err}` : ''}`);
      if (status === 'SUBSCRIBED') {
        ready = true;
        attempts = 0;
        hooks.onReady?.();
      } else if (status === 'CLOSED' || status === 'TIMED_OUT' || status === 'CHANNEL_ERROR') {
        const wasReady = ready;
        ready = false;
        if (wasReady) hooks.onDrop?.(status);
        scheduleReconnect(status);
      }
    });
  }

  connect();

  return {
    send(msg) {
      if (!ready) return;                     // resends on the next heartbeat/tick
      try { ch.send(msg); } catch (e) { log(`send failed: ${e}`); }
    },
    isReady: () => ready,
    current: () => ch,
  };
}
