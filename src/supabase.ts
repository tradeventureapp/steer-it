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
    // SOCKET-LEVEL heartbeat (Phoenix ping) — this is what resets the server's
    // idle timer, NOT broadcast traffic. Ping every 15s, well inside the ~60s
    // idle window, so an active game's socket is never torn down for inactivity.
    heartbeatIntervalMs: 15000,
    // ROOT CAUSE of the ~60s drop: a main-thread setInterval heartbeat is
    // THROTTLED to ≥1/min when the desktop tab is unfocused (the host watches the
    // phones), so the 15s ping stretches past 60s and the socket idles out.
    // `worker: true` runs the heartbeat in a Web Worker (an inline blob — no
    // external fetch) that browsers DON'T throttle in the background, so the
    // ping keeps firing every 15s no matter what the tab is doing.
    worker: true,
    // Channel/socket join timeout.
    timeout: 10000,
    // p18b: NEVER tear the socket down when channels momentarily go empty.
    // realtime-js 2.x added `disconnectOnEmptyChannelsAfterMs`, DEFAULTING to
    // 2 × heartbeatIntervalMs = 30000ms here — a 30s timer that, combined with
    // our reconnect churn (removeChannel → 0 channels → schedule disconnect),
    // was one source of the ~30s control dropout. We own the channel lifecycle
    // (the resilient wrapper re-creates on drop), so the socket must stay up
    // regardless of transient empty-channel windows. MAX_SAFE_INTEGER = never.
    disconnectOnEmptyChannelsAfterMs: Number.MAX_SAFE_INTEGER,
    // FAST socket reconnect: if the WS does drop, re-open it near-instantly
    // (the default stepped backoff goes 1s→2s→5s→10s, which is the 5-10s blip we
    // saw). 250ms → 2.5s cap means a blip recovers in well under a second.
    reconnectAfterMs: (tries: number) => [250, 500, 1000, 1500, 2500][tries - 1] ?? 2500,
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
  // WebRTC migration (V1): once the P2P DataChannel is open the PHONE leaves
  // the Realtime channel DELIBERATELY — stop() unsubscribes AND suppresses the
  // auto-reconnect (otherwise the wrapper would treat the leave as a drop and
  // rejoin). resume() re-subscribes for re-signaling (reconnect / return from
  // background). The desktop never calls these (its channel stays up to serve
  // new joiners' signaling).
  stop(): void;
  resume(): void;
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
  let stopped = false;   // deliberate leave (WebRTC up) — suppress auto-reconnect
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const log = (msg: string) => console.info(`[${label}] ${isoNow()} ${msg}`);

  function scheduleReconnect(reason: string) {
    if (stopped || reconnectTimer) return;
    // Fast, short backoff (the socket itself reconnects fast via reconnectAfterMs;
    // this just re-creates the channel on top). 250ms→3s cap.
    const delay = Math.min(250 * 2 ** attempts, 3000); // 250,500,1000,2000,3000…
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
    stop() {
      if (stopped) return;
      stopped = true;
      ready = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { supabase.removeChannel(ch); } catch { /* ignore */ }
      log('stopped (deliberate leave — P2P transport up)');
    },
    resume() {
      if (!stopped) return;
      stopped = false;
      attempts = 0;
      log('resuming (re-signaling)');
      connect();
    },
  };
}
