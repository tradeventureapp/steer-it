// =============================================================================
//  Steer It — soundscape, iteration 4: SAMPLE-BASED playback.
//
//  Three realtime-synthesis attempts read as synth tones / static / breath.
//  This version plays baked WAV loops (see tools/bake-audio.mjs — rendered
//  offline with heavy processing and numeric QC; sourcing of CC0 recordings
//  failed from this environment: freesound API 401 without a token,
//  pixabay 403 for non-browser clients, Wikimedia hits unloopable/OGG).
//
//  Playback model (the standard indie-game pattern):
//    engine_idle.wav  ─ loop ─ rate 0.75-1.60 ─ gain cos(rpm·π/2) ─┐
//    engine_high.wav  ─ loop ─ rate 0.70-1.75 ─ gain sin(rpm·π/2) ─┼─ lowpass ─ engineGain ─┐
//    tire_squeal.wav  ─ loop ─ rate w/ slip ─ squealGain ─ pan ────────────────────────────┼─ master ─ limiter
//    tire_squeal.wav  ─ loop ─ rate ~0.65 ─ burnoutGain (wheelspin) ────────────────────────┤
//    synthesized impact thump/knock (kept from iteration 1) ─────────────────────────────────┘
//
//  - Virtual RPM still derives from REAR WHEEL speed (burnouts rev high
//    while the car crawls).
//  - The two-layer crossfade masks playback-rate pitch artifacts; rates
//    stay within ~0.7-1.8x.
//  - Throttle opens a lowpass + lifts the gain — instant load character.
//  - Mix target: engine ~60%, squeal ~25%, impacts ~15%.
//
//  Autoplay policy: nothing loads until enable() runs in a user gesture
//  (async: fetch + decode, then the button flips). M / button toggles mute
//  via the master gain — the graph keeps running, unmute is instant.
// =============================================================================

export const SOUND_CONFIG = {
  master: 0.8,

  // ---------- Engine (two-layer sample crossfade) ----------
  rpmFullWheelSpeed: 42,       // m/s WHEEL contact speed = full RPM
  rpmCurve: 0.72,              // <1 = satisfying early climb
  idleRateBase: 0.75,          // playbackRate span for the idle loop
  idleRateSpan: 0.85,
  highRateBase: 0.70,          // and for the high-RPM loop
  highRateSpan: 1.05,
  filterBaseHz: 900,           // lowpass: darker off-throttle
  filterThrottleHz: 3200,      // opens with throttle
  filterRpmHz: 800,
  engineVolBase: 0.34,
  engineVolThrottle: 0.22,
  attackTau: 0.02,             // throttle swell — must feel instant
  releaseTau: 0.09,

  // ---------- Tire squeal ----------
  squealStartDeg: 9,
  squealFullDeg: 26,
  squealVol: 0.26,
  squealRateBase: 0.95,        // playbackRate rises a little with slip
  squealRateSpan: 0.30,

  // ---------- Burnout screech (squeal loop, dropped low + rough) ----------
  burnoutVol: 0.28,
  burnoutRateBase: 0.62,
  burnoutRateSpan: 0.20,

  // ---------- Impacts (synthesized — they were fine) ----------
  impactVol: 0.55,
  impactFullSpeed: 12,
};

export interface SoundState {
  wheelSpeed: number;   // rear wheel contact speed, m/s (RPM proxy)
  speed: number;        // car speed, m/s
  slipAngle: number;    // rear slip angle, rad (signed)
  wheelSpin: number;    // 0..1 (only when the rear is saturated)
  throttle: number;     // 0..1
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private idleSrc!: AudioBufferSourceNode;
  private highSrc!: AudioBufferSourceNode;
  private idleGain!: GainNode;
  private highGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private squealSrc!: AudioBufferSourceNode;
  private squealGain!: GainNode;
  private squealPan!: StereoPannerNode;
  private burnoutSrc!: AudioBufferSourceNode;
  private burnoutGain!: GainNode;
  private noiseBuffer!: AudioBuffer;

  private building = false;
  enabled = false;
  muted = false;
  onChange: (() => void) | null = null;

  // Must be called from a user gesture (click/key) per autoplay policy.
  enable() {
    if (this.ctx) {
      this.ctx.resume().catch(() => { /* ignore */ });
      this.enabled = true;
      this.muted = false;
      this.applyMaster();
      this.onChange?.();
      return;
    }
    if (this.building) return;
    this.building = true;
    void this.build()
      .then(() => {
        this.enabled = true;
        this.muted = false;
        this.applyMaster();
        this.onChange?.();
      })
      .catch((err) => {
        console.warn('Sound init failed:', err);
        this.ctx = null;
      })
      .finally(() => { this.building = false; });
  }

  toggleMute() {
    if (!this.enabled) { this.enable(); return; }
    this.muted = !this.muted;
    this.applyMaster();
    this.onChange?.();
  }

  private applyMaster() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(
      this.muted ? 0 : SOUND_CONFIG.master, this.ctx.currentTime, 0.03);
  }

  private async build() {
    const C = SOUND_CONFIG;
    const ctx = new AudioContext();

    // Load + decode the baked loops in parallel.
    const load = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    };
    const [idleBuf, highBuf, squealBuf] = await Promise.all([
      load('/audio/engine_idle.wav'),
      load('/audio/engine_high.wav'),
      load('/audio/tire_squeal.wav'),
    ]);
    await ctx.resume();
    this.ctx = ctx;

    // Master chain: gain → soft limiter → out.
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 18;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.master.connect(limiter);
    limiter.connect(ctx.destination);

    // ---------- Engine: two looped layers, equal-power crossfade ----------
    const mkLoop = (buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      return src;
    };
    this.idleSrc = mkLoop(idleBuf);
    this.highSrc = mkLoop(highBuf);
    this.idleGain = ctx.createGain(); this.idleGain.gain.value = 1;
    this.highGain = ctx.createGain(); this.highGain.gain.value = 0;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = C.filterBaseHz;
    this.engineFilter.Q.value = 0.8;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.idleSrc.connect(this.idleGain);
    this.highSrc.connect(this.highGain);
    this.idleGain.connect(this.engineFilter);
    this.highGain.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // ---------- Tires: squeal + low-rate rough copy for burnouts ----------
    this.squealSrc = mkLoop(squealBuf);
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealPan = ctx.createStereoPanner();
    this.squealSrc.connect(this.squealGain);
    this.squealGain.connect(this.squealPan);
    this.squealPan.connect(this.master);

    this.burnoutSrc = mkLoop(squealBuf);
    this.burnoutSrc.playbackRate.value = C.burnoutRateBase;
    this.burnoutGain = ctx.createGain();
    this.burnoutGain.gain.value = 0;
    this.burnoutSrc.connect(this.burnoutGain);
    this.burnoutGain.connect(this.master);

    // Noise buffer for the synthesized impact thumps.
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Stagger loop starts so the two engine layers don't phase-align.
    const t = ctx.currentTime;
    this.idleSrc.start(t);
    this.highSrc.start(t, highBuf.duration * 0.37);
    this.squealSrc.start(t);
    this.burnoutSrc.start(t, squealBuf.duration * 0.5);
  }

  // Per-frame parameter drive — smooth ramps, no zipper noise.
  update(s: SoundState) {
    if (!this.ctx || !this.enabled) return;
    const C = SOUND_CONFIG;
    const t = this.ctx.currentTime;

    // ---- RPM from WHEEL speed → crossfade + playback rates ----
    const rpmN = Math.pow(
      clamp(Math.abs(s.wheelSpeed) / C.rpmFullWheelSpeed, 0, 1), C.rpmCurve);
    const xf = rpmN * Math.PI / 2;
    this.idleGain.gain.setTargetAtTime(Math.cos(xf), t, 0.04);
    this.highGain.gain.setTargetAtTime(Math.sin(xf), t, 0.04);
    this.idleSrc.playbackRate.setTargetAtTime(
      C.idleRateBase + rpmN * C.idleRateSpan, t, 0.03);
    this.highSrc.playbackRate.setTargetAtTime(
      C.highRateBase + rpmN * C.highRateSpan, t, 0.03);

    // ---- Load character: brightness + swell ----
    this.engineFilter.frequency.setTargetAtTime(
      C.filterBaseHz + s.throttle * C.filterThrottleHz + rpmN * C.filterRpmHz,
      t, 0.03);
    const vol = C.engineVolBase + s.throttle * C.engineVolThrottle;
    const rising = vol > this.engineGain.gain.value;
    this.engineGain.gain.setTargetAtTime(
      vol, t, rising ? C.attackTau : C.releaseTau);

    // ---- Drift squeal: continuous mirror of the slip angle ----
    const slipDeg = Math.abs(s.slipAngle) * 180 / Math.PI;
    const sNorm = clamp(
      (slipDeg - C.squealStartDeg) / (C.squealFullDeg - C.squealStartDeg), 0, 1);
    const squealVol = sNorm * clamp(s.speed / 8, 0.2, 1) * C.squealVol;
    this.squealGain.gain.setTargetAtTime(squealVol, t, 0.05);
    this.squealSrc.playbackRate.setTargetAtTime(
      C.squealRateBase + sNorm * C.squealRateSpan, t, 0.06);
    this.squealPan.pan.setTargetAtTime(
      clamp(Math.sign(s.slipAngle) * -0.3 * sNorm, -0.4, 0.4), t, 0.08);

    // ---- Burnout: wheelspin while the car is slow ----
    const wspinN = s.wheelSpin * clamp(1 - s.speed / 12, 0, 1);
    this.burnoutGain.gain.setTargetAtTime(wspinN * C.burnoutVol, t, 0.05);
    this.burnoutSrc.playbackRate.setTargetAtTime(
      C.burnoutRateBase + s.wheelSpin * C.burnoutRateSpan, t, 0.06);
  }

  // One-shot synthesized thump: lowpassed noise burst + low sine knock.
  impact(strength: number) {
    if (!this.ctx || !this.enabled || this.muted) return;
    const C = SOUND_CONFIG;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const k = clamp(strength / C.impactFullSpeed, 0.08, 1);
    const pitchVar = 0.8 + Math.random() * 0.4;

    const burst = ctx.createBufferSource();
    burst.buffer = this.noiseBuffer;
    burst.playbackRate.value = pitchVar;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420 * pitchVar + 600 * k;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(C.impactVol * k, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    burst.connect(lp); lp.connect(bg); bg.connect(this.master);
    burst.start(t, Math.random());
    burst.stop(t + 0.16);

    const knock = ctx.createOscillator();
    knock.type = 'sine';
    knock.frequency.setValueAtTime(110 * pitchVar, t);
    knock.frequency.exponentialRampToValueAtTime(55, t + 0.1);
    const kg = ctx.createGain();
    kg.gain.setValueAtTime(C.impactVol * 0.8 * k, t);
    kg.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    knock.connect(kg); kg.connect(this.master);
    knock.start(t);
    knock.stop(t + 0.13);
  }
}
