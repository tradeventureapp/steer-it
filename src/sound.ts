// =============================================================================
//  Steer It — procedural soundscape (Web Audio synthesis, no samples).
//
//  One graph, built once, parameters modulated every frame from physics
//  state. The engine's pitch tracks REAR WHEEL speed (not car speed), so a
//  burnout audibly revs to the moon while the car crawls — the drift sound
//  signature. Throttle opens a lowpass (dark off-throttle, bright on) and
//  swells the volume; lifting fires a tasteful overrun burble.
//
//  Browser autoplay policy: nothing is constructed until enable() runs
//  inside a user gesture. Muting drops the master gain (graph keeps
//  running) so unmute is instant.
//
//  Signal flow:
//    saw + sub-square + detuned-saw ─ mix ─ lowpass ─ engineGain ──┐
//    noise ─ bandpass(squeal) ─ squealGain ─ stereo pan ───────────┤
//    noise ─ bandpass(burnout, fluttered) ─ burnoutGain ───────────┼─ master
//    noise ─ bandpass(burble) ─ burbleGain (scheduled blips) ──────┤   gain
//    one-shot impact thump/knock nodes ─────────────────────────────┘    │
//                                                    soft limiter ── destination
// =============================================================================

export const SOUND_CONFIG = {
  master: 0.8,                 // master gain (limiter catches the peaks)

  // ---------- Engine ----------
  idleHz: 52,                  // oscillator base at standstill (low rumble)
  maxHz: 380,                  // base at full virtual RPM
  rpmFullWheelSpeed: 42,       // m/s of WHEEL contact speed = full RPM
  rpmCurve: 0.72,              // <1 = climbs fast early, satisfying rise
  wobbleHz: 5.5,               // mechanical pitch wobble LFO
  wobbleDepthHz: 2.4,
  jitter: 0.012,               // ±1.2% random-walk pitch jitter
  filterBaseHz: 240,           // lowpass: closed/dark at idle, off-throttle
  filterThrottleHz: 2900,      // + opened by throttle (brightness)
  filterRpmHz: 1300,           // + opened by RPM
  engineIdleVol: 0.17,
  engineThrottleVol: 0.27,
  engineRpmVol: 0.14,
  attackTau: 0.02,             // s — throttle-on swell (must feel instant)
  releaseTau: 0.09,            // s — off-throttle drop
  burbleVol: 0.12,             // overrun blip volume

  // ---------- Tires ----------
  squealStartDeg: 9,           // slip angle where the squeal fades in
  squealFullDeg: 26,           // full wail
  squealVol: 0.38,
  squealFreqBase: 1150,        // bandpass center, Hz
  squealFreqSlip: 1500,        // + with slip depth
  squealQ: 7,
  burnoutVol: 0.42,            // rough low screech for wheelspin at low speed
  burnoutFreqHz: 520,
  burnoutQ: 2.5,
  burnoutFlutterHz: 27,        // square-LFO flutter on the filter = roughness
  burnoutFlutterDepth: 80,

  // ---------- Impacts ----------
  impactVol: 0.55,
  impactFullSpeed: 12,         // m/s normal impact = full-volume THUD
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
  private oscMain!: OscillatorNode;
  private oscSub!: OscillatorNode;
  private oscHarm!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private squealGain!: GainNode;
  private squealPan!: StereoPannerNode;
  private burnoutFilter!: BiquadFilterNode;
  private burnoutGain!: GainNode;
  private burbleGain!: GainNode;
  private noiseBuffer!: AudioBuffer;

  private prevThrottle = 0;
  private jitterState = 0;
  enabled = false;
  muted = false;
  onChange: (() => void) | null = null;

  // Must be called from a user gesture (click/key) per autoplay policy.
  enable() {
    if (!this.ctx) this.build();
    this.ctx!.resume().catch(() => { /* ignore */ });
    this.enabled = true;
    this.muted = false;
    this.applyMaster();
    this.onChange?.();
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

  private build() {
    const C = SOUND_CONFIG;
    const ctx = new AudioContext();
    this.ctx = ctx;

    // Master chain: gain → soft limiter → out. The compressor with a hard
    // ratio acts as the limiter, so layered peaks never clip.
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

    // ---------- Engine: three oscillators → lowpass → gain ----------
    this.oscMain = ctx.createOscillator();
    this.oscMain.type = 'sawtooth';
    this.oscSub = ctx.createOscillator();
    this.oscSub.type = 'square';
    this.oscHarm = ctx.createOscillator();
    this.oscHarm.type = 'sawtooth';

    const mixMain = ctx.createGain(); mixMain.gain.value = 0.50;
    const mixSub  = ctx.createGain(); mixSub.gain.value  = 0.36;
    const mixHarm = ctx.createGain(); mixHarm.gain.value = 0.17;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = C.filterBaseHz;
    this.engineFilter.Q.value = 1.1;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.oscMain.connect(mixMain); mixMain.connect(this.engineFilter);
    this.oscSub.connect(mixSub);   mixSub.connect(this.engineFilter);
    this.oscHarm.connect(mixHarm); mixHarm.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Mechanical pitch wobble — sine LFO into the osc frequencies.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = C.wobbleHz;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = C.wobbleDepthHz;
    lfo.connect(lfoDepth);
    lfoDepth.connect(this.oscMain.frequency);
    lfoDepth.connect(this.oscHarm.frequency);

    // ---------- Shared looped white-noise source ----------
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;

    // Drift squeal: bandpass noise, panned slightly by slip direction.
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = C.squealFreqBase;
    this.squealFilter.Q.value = C.squealQ;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealPan = ctx.createStereoPanner();
    noise.connect(this.squealFilter);
    this.squealFilter.connect(this.squealGain);
    this.squealGain.connect(this.squealPan);
    this.squealPan.connect(this.master);

    // Burnout screech: lower bandpass with a square-LFO flutter on its
    // center frequency — the roughness of a tire tearing at tarmac.
    this.burnoutFilter = ctx.createBiquadFilter();
    this.burnoutFilter.type = 'bandpass';
    this.burnoutFilter.frequency.value = C.burnoutFreqHz;
    this.burnoutFilter.Q.value = C.burnoutQ;
    this.burnoutGain = ctx.createGain();
    this.burnoutGain.gain.value = 0;
    noise.connect(this.burnoutFilter);
    this.burnoutFilter.connect(this.burnoutGain);
    this.burnoutGain.connect(this.master);
    const flutter = ctx.createOscillator();
    flutter.type = 'square';
    flutter.frequency.value = C.burnoutFlutterHz;
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = C.burnoutFlutterDepth;
    flutter.connect(flutterDepth);
    flutterDepth.connect(this.burnoutFilter.frequency);

    // Overrun burble: midband noise blips, scheduled on throttle lift.
    const burbleFilter = ctx.createBiquadFilter();
    burbleFilter.type = 'bandpass';
    burbleFilter.frequency.value = 620;
    burbleFilter.Q.value = 2;
    this.burbleGain = ctx.createGain();
    this.burbleGain.gain.value = 0;
    noise.connect(burbleFilter);
    burbleFilter.connect(this.burbleGain);
    this.burbleGain.connect(this.master);

    this.oscMain.start();
    this.oscSub.start();
    this.oscHarm.start();
    lfo.start();
    flutter.start();
    noise.start();
  }

  // Per-frame parameter drive. setTargetAtTime everywhere — smooth, no
  // zipper noise, and tiny time constants keep it feeling instant.
  update(s: SoundState) {
    if (!this.ctx || !this.enabled) return;
    const C = SOUND_CONFIG;
    const t = this.ctx.currentTime;

    // ---- Engine pitch from WHEEL speed (burnout = high revs) ----
    const rpmN = Math.pow(
      clamp(Math.abs(s.wheelSpeed) / C.rpmFullWheelSpeed, 0, 1), C.rpmCurve);
    this.jitterState = clamp(
      this.jitterState + (Math.random() - 0.5) * 0.5, -1, 1);
    const f = (C.idleHz + rpmN * (C.maxHz - C.idleHz)) *
      (1 + C.jitter * this.jitterState);
    this.oscMain.frequency.setTargetAtTime(f, t, 0.02);
    this.oscSub.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.oscHarm.frequency.setTargetAtTime(f * 1.503, t, 0.02);

    // ---- Throttle character: brightness + swell ----
    const cutoff = C.filterBaseHz + s.throttle * C.filterThrottleHz +
      rpmN * C.filterRpmHz;
    this.engineFilter.frequency.setTargetAtTime(cutoff, t, 0.03);

    const vol = C.engineIdleVol + s.throttle * C.engineThrottleVol +
      rpmN * C.engineRpmVol;
    const rising = vol > this.engineGain.gain.value;
    this.engineGain.gain.setTargetAtTime(
      vol, t, rising ? C.attackTau : C.releaseTau);

    // ---- Overrun burble on a sharp lift at revs ----
    if (this.prevThrottle - s.throttle > 0.45 && rpmN > 0.25) {
      const g = this.burbleGain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0, t);
      for (let i = 0; i < 3; i++) {
        const bt = t + 0.03 + i * 0.095 + Math.random() * 0.02;
        g.linearRampToValueAtTime(C.burbleVol * (1 - i * 0.25), bt + 0.012);
        g.exponentialRampToValueAtTime(0.001, bt + 0.07);
      }
    }
    this.prevThrottle = s.throttle;

    // ---- Drift squeal: continuous mirror of the slip angle ----
    const slipDeg = Math.abs(s.slipAngle) * 180 / Math.PI;
    const sNorm = clamp(
      (slipDeg - C.squealStartDeg) / (C.squealFullDeg - C.squealStartDeg), 0, 1);
    const squealVol = sNorm * clamp(s.speed / 8, 0.2, 1) * C.squealVol;
    this.squealGain.gain.setTargetAtTime(squealVol, t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(
      C.squealFreqBase + sNorm * C.squealFreqSlip + s.speed * 15, t, 0.06);
    this.squealPan.pan.setTargetAtTime(
      clamp(Math.sign(s.slipAngle) * -0.3 * sNorm, -0.4, 0.4), t, 0.08);

    // ---- Burnout screech: wheelspin while the car is slow ----
    const burnout = s.wheelSpin * clamp(1 - s.speed / 12, 0, 1) * C.burnoutVol;
    this.burnoutGain.gain.setTargetAtTime(burnout, t, 0.05);
  }

  // One-shot synthesized thump: lowpassed noise burst + low sine knock.
  // `strength` = normal impact speed (m/s) from the collision resolver.
  impact(strength: number) {
    if (!this.ctx || !this.enabled || this.muted) return;
    const C = SOUND_CONFIG;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const k = clamp(strength / C.impactFullSpeed, 0.08, 1);
    const pitchVar = 0.8 + Math.random() * 0.4;

    // Noise burst through a lowpass — the "crunch" body.
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

    // Low sine knock — the "thud" fundamental.
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
