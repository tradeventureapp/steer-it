// =============================================================================
//  WebRTC transport (V1) — tilt flows phone ↔ desktop over a P2P DataChannel;
//  Supabase Realtime carries ONLY the signaling handshake (~10 msgs/pairing).
//
//  Topology: N phones → 1 desktop. The PHONE initiates (it knows when it
//  arrives): it creates the RTCPeerConnection + BOTH DataChannels and sends an
//  offer; the desktop answers and manages a Map<clientId, peer>.
//
//  Channels (both negotiated in the ONE offer SDP — no extra signaling):
//    • "control"  {ordered:false, maxRetransmits:0} — the 30 Hz tilt stream.
//      Latest-state semantics: dropping a stale packet beats head-of-line
//      blocking. Payload = EXACTLY the EV.control shape (desktop routes both
//      transports through the same applyInputs path).
//    • "state"    reliable/ordered (default) — everything that must not be
//      lost, BOTH directions: desktop→phone lobby roster + full; phone→desktop
//      join heartbeat, color, name, leave. Framed {ev, payload} with the SAME
//      EV names as the Realtime events → same handlers on both sides.
//
//  Fallback: if the control channel isn't open within RTC_FALLBACK_MS the
//  phone stays on the Realtime path entirely (today's behavior) — playable
//  for everyone, P2P for the ~85% whose NAT allows it. No TURN in V1; add
//  TURN servers to RTC_ICE_SERVERS when scaling (config-only, extensible).
//
//  The RTCPeerConnection surface is injected (PeerFactory) so the signaling
//  flow, pairing message count, host reconnect-replace, and fallback timer are
//  unit-testable headless (Node has no WebRTC).
// =============================================================================

// ---- signaling event names (ride the existing steer:<code> channel) ----
export const RTC_EV = {
  offer: 'rtc-offer',    // phone → desktop { id, sdp }
  answer: 'rtc-answer',  // desktop → phone { id, sdp }
  ice: 'rtc-ice',        // both ways       { id, from: 'phone'|'host', candidate }
} as const;

// STUN only in V1. TURN (Cloudflare / coturn) slots in HERE later — config
// change only, no code change (V3, before the scale push).
export const RTC_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export const RTC_FALLBACK_MS = 8000;   // control DC not open by then → stay on Realtime

// ---- minimal structural surface of RTCPeerConnection/RTCDataChannel we use ----
// (injectable for headless tests; the real objects satisfy these shapes)
export interface DataChannelLike {
  readonly label: string;
  readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}
export interface PeerLike {
  onicecandidate: ((ev: { candidate: unknown | null }) => void) | null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  readonly connectionState: string;
  createDataChannel(label: string, opts?: RTCDataChannelInit): DataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(d: unknown): Promise<void>;
  setRemoteDescription(d: unknown): Promise<void>;
  addIceCandidate(c: unknown): Promise<void>;
  close(): void;
  // Optional (real RTCPeerConnection has it; fakes may omit) — used for the
  // per-pairing connection-path log (direct vs TURN relay).
  getStats?(): Promise<{ forEach(cb: (report: Record<string, unknown>) => void): void }>;
}
export type PeerFactory = () => PeerLike;

const defaultPeerFactory: PeerFactory = () =>
  new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS }) as unknown as PeerLike;

// Build a PeerFactory with extra ICE servers (STEP 3: the short-lived TURN
// creds fetched at pairing time) and an optional forced-relay policy
// (?rtc=relay — ICE may then use ONLY relay candidates: the TURN test switch).
export function makePeerFactory(iceServers: RTCIceServer[], relayOnly = false): PeerFactory {
  return () => new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: relayOnly ? 'relay' : 'all',
  }) as unknown as PeerLike;
}

// Fetch short-lived TURN iceServers from /api/turn (Vercel function). Returns
// the extra servers or null on ANY failure (timeout, 4xx/5xx, bad shape) —
// the caller then proceeds STUN-only, so TURN being down never blocks pairing.
// fetchFn injectable for headless tests.
export async function fetchTurnServers(
  fetchFn: typeof fetch = fetch, timeoutMs = 2000, url = '/api/turn',
): Promise<RTCIceServer[] | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetchFn(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json() as { iceServers?: unknown };
    const s = data?.iceServers;
    if (!s) return null;
    const arr = Array.isArray(s) ? s : [s];
    return arr.every((e) => e && typeof e === 'object' && 'urls' in (e as object))
      ? arr as RTCIceServer[] : null;
  } catch {
    return null;
  }
}

// Which path did an open connection take? Reads the nominated candidate pair
// from getStats: local candidate type 'relay' = TURN, anything else = direct.
export async function connectionPathOf(pc: PeerLike): Promise<'direct' | 'relay' | 'unknown'> {
  if (!pc.getStats) return 'unknown';
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    let pairId: string | null = null;
    const pairs: Record<string, unknown>[] = [];
    stats.forEach((rep) => {
      byId.set(String(rep.id), rep);
      if (rep.type === 'transport' && rep.selectedCandidatePairId) {
        pairId = String(rep.selectedCandidatePairId);
      }
      if (rep.type === 'candidate-pair' && (rep.nominated || rep.selected) && rep.state === 'succeeded') {
        pairs.push(rep);
      }
    });
    const pair = (pairId ? byId.get(pairId) : undefined) ?? pairs[0];
    if (!pair) return 'unknown';
    const local = byId.get(String(pair.localCandidateId));
    if (!local) return 'unknown';
    return local.candidateType === 'relay' ? 'relay' : 'direct';
  } catch {
    return 'unknown';
  }
}

// Fallback detector (desktop): a phone still driving over Realtime with no RTC
// peer after graceMs is on the fallback path — log it ONCE per id. Pure +
// injectable clock for headless tests.
export function createFallbackTracker(graceMs: number, log: (id: string) => void) {
  const firstSeen = new Map<string, number>();
  const logged = new Set<string>();
  return {
    note(id: string, hasRtcPeer: boolean, now: number) {
      if (hasRtcPeer) { firstSeen.delete(id); return; }
      const t0 = firstSeen.get(id);
      if (t0 === undefined) { firstSeen.set(id, now); return; }
      if (now - t0 >= graceMs && !logged.has(id)) {
        logged.add(id);
        log(id);
      }
    },
  };
}

export type StateMsg = { ev: string; payload: unknown };

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return null;
  try { return JSON.parse(data); } catch { return null; }
}

// =============================================================================
//  PHONE side — one PC, initiates the pairing.
// =============================================================================
export interface PhoneRtcOpts {
  clientId: string;
  signal: (event: string, payload: unknown) => void;      // → Supabase channel
  onControlOpen: () => void;   // control DC open → caller migrates off Realtime
  onStateMessage: (msg: StateMsg) => void;                // lobby / full
  onFallback: () => void;      // never opened within fallbackMs → stay on Realtime
  onDead: () => void;          // WAS open, now failed/closed → caller re-signals
  fallbackMs?: number;
  pcFactory?: PeerFactory;
}
export interface PhoneRtc {
  handleSignal(event: string, payload: unknown): void;    // rtc-answer / rtc-ice(host)
  sendControl(payload: unknown): boolean;                 // false → caller uses Realtime
  sendState(ev: string, payload: unknown): boolean;
  isUp(): boolean;
  close(): void;
}

export function connectPhoneRtc(o: PhoneRtcOpts): PhoneRtc {
  const pc = (o.pcFactory ?? defaultPeerFactory)();
  const id = o.clientId;
  let opened = false;   // control DC ever opened
  let ended = false;    // fallback/dead/close fired — never fire twice

  const control = pc.createDataChannel('control', { ordered: false, maxRetransmits: 0 });
  const state = pc.createDataChannel('state');   // reliable/ordered default

  const fallbackTimer = setTimeout(() => {
    if (!opened && !ended) { ended = true; try { pc.close(); } catch { /* ignore */ } o.onFallback(); }
  }, o.fallbackMs ?? RTC_FALLBACK_MS);

  const dead = () => {
    if (!opened || ended) return;
    ended = true;
    try { pc.close(); } catch { /* ignore */ }
    o.onDead();
  };

  control.onopen = () => {
    if (ended) return;
    opened = true;
    clearTimeout(fallbackTimer);
    o.onControlOpen();
  };
  control.onclose = dead;
  state.onmessage = (ev) => {
    const m = parseJson(ev.data) as StateMsg | null;
    if (m && typeof m.ev === 'string') o.onStateMessage(m);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dead();
  };
  pc.onicecandidate = (ev) => {
    if (ev.candidate) o.signal(RTC_EV.ice, { id, from: 'phone', candidate: ev.candidate });
  };

  // offer (trickle ICE — candidates flow separately as they arrive)
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer).then(() => {
      o.signal(RTC_EV.offer, { id, sdp: offer });
    }))
    .catch((e) => console.warn('[rtc] offer failed', e));

  return {
    handleSignal(event, payload) {
      const p = payload as { id?: string; from?: string; sdp?: unknown; candidate?: unknown };
      if (p?.id !== id) return;   // someone else's pairing on the shared channel
      if (event === RTC_EV.answer && p.sdp) {
        pc.setRemoteDescription(p.sdp).catch((e) => console.warn('[rtc] answer failed', e));
      } else if (event === RTC_EV.ice && p.from === 'host' && p.candidate) {
        pc.addIceCandidate(p.candidate).catch(() => { /* late/stale candidate */ });
      }
    },
    sendControl(payload) {
      if (control.readyState !== 'open') return false;
      try { control.send(JSON.stringify(payload)); return true; } catch { return false; }
    },
    sendState(ev, payload) {
      if (state.readyState !== 'open') return false;
      try { state.send(JSON.stringify({ ev, payload })); return true; } catch { return false; }
    },
    isUp: () => opened && !ended && control.readyState === 'open',
    close() {
      ended = true;
      clearTimeout(fallbackTimer);
      try { pc.close(); } catch { /* ignore */ }
    },
  };
}

// =============================================================================
//  DESKTOP side — host manager, one peer per phone, join/leave mid-game.
// =============================================================================
export interface RtcHostOpts {
  signal: (event: string, payload: unknown) => void;      // → Supabase channel
  onControl: (id: string, payload: unknown) => void;      // same shape as EV.control
  onStateMessage: (id: string, msg: StateMsg) => void;    // join/color/name/leave
  // Fired when a phone's control channel OPENS on the host — the desktop logs
  // the connection path here (connectionPathOf(pc): direct vs relay/TURN).
  onPeerConnected?: (id: string, pc: PeerLike) => void;
  pcFactory?: PeerFactory;
}
export interface RtcHost {
  handleSignal(event: string, payload: unknown): void;    // rtc-offer / rtc-ice(phone)
  sendStateTo(id: string, ev: string, payload: unknown): boolean;
  broadcastState(ev: string, payload: unknown): void;
  hasPeer(id: string): boolean;
  peerCount(): number;
  close(id: string): void;
}

interface HostPeer { pc: PeerLike; control: DataChannelLike | null; state: DataChannelLike | null; }

export function createRtcHost(o: RtcHostOpts): RtcHost {
  const peers = new Map<string, HostPeer>();
  const factory = o.pcFactory ?? defaultPeerFactory;

  function close(id: string) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.pc.close(); } catch { /* ignore */ }
  }

  function acceptOffer(id: string, sdp: unknown) {
    close(id);   // reconnect: a fresh offer REPLACES the old peer for this phone
    const pc = factory();
    const peer: HostPeer = { pc, control: null, state: null };
    peers.set(id, peer);

    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      if (ch.label === 'control') {
        peer.control = ch;
        if (ch.readyState === 'open') o.onPeerConnected?.(id, pc);
        else ch.onopen = () => o.onPeerConnected?.(id, pc);
        ch.onmessage = (m) => {
          const p = parseJson(m.data);
          if (p) o.onControl(id, p);
        };
      } else if (ch.label === 'state') {
        peer.state = ch;
        ch.onmessage = (m) => {
          const msg = parseJson(m.data) as StateMsg | null;
          if (msg && typeof msg.ev === 'string') o.onStateMessage(id, msg);
        };
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) o.signal(RTC_EV.ice, { id, from: 'host', candidate: ev.candidate });
    };
    pc.onconnectionstatechange = () => {
      // Peer cleanup only — the CAR's lifecycle stays driven by lastInputAt /
      // RESILIENCE (packets stopping is what matters, not the PC object).
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (peers.get(id)?.pc === pc) close(id);
      }
    };

    pc.setRemoteDescription(sdp)
      .then(() => pc.createAnswer())
      .then((answer) => pc.setLocalDescription(answer).then(() => {
        o.signal(RTC_EV.answer, { id, sdp: answer });
      }))
      .catch((e) => console.warn('[rtc-host] answer failed', e));
  }

  return {
    handleSignal(event, payload) {
      const p = payload as { id?: string; from?: string; sdp?: unknown; candidate?: unknown };
      const id = typeof p?.id === 'string' ? p.id : '';
      if (!id) return;
      if (event === RTC_EV.offer && p.sdp) {
        acceptOffer(id, p.sdp);
      } else if (event === RTC_EV.ice && p.from === 'phone' && p.candidate) {
        peers.get(id)?.pc.addIceCandidate(p.candidate).catch(() => { /* late/stale */ });
      }
    },
    sendStateTo(id, ev, payload) {
      const st = peers.get(id)?.state;
      if (!st || st.readyState !== 'open') return false;
      try { st.send(JSON.stringify({ ev, payload })); return true; } catch { return false; }
    },
    broadcastState(ev, payload) {
      const data = JSON.stringify({ ev, payload });
      for (const p of peers.values()) {
        if (p.state && p.state.readyState === 'open') {
          try { p.state.send(data); } catch { /* ignore */ }
        }
      }
    },
    hasPeer: (id) => peers.has(id),
    peerCount: () => peers.size,
    close,
  };
}
