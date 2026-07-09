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
}
export type PeerFactory = () => PeerLike;

const defaultPeerFactory: PeerFactory = () =>
  new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS }) as unknown as PeerLike;

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
