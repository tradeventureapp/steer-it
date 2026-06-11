// =============================================================================
//  Steer It — procedural soundscape, iteration 3: CLEAN over realistic.
//
//  Iteration 2's impulse-train engine read as radio static and its wide
//  noise squeal as breath. This version goes back to the iteration-1
//  oscillator engine — generic but clean — with ONE subtle mechanical
//  touch: a gentle amplitude throb at the virtual firing rate (~16%
//  depth). The pitched oscillator tone carries the sound; every noise
//  source left in the mix is tightly bandpass-filtered and quiet.
//
//    saw + sub-square + detuned-saw ─ mix ─ AM throb ─ lowpass ─ gain ──┐
//    noise ─ NARROW bandpass 1.7-2.6 kHz (squeal) ─ gain ─ pan ─────────┤
//    noise ─ bandpass 950 Hz Q8 + flutter (burnout) ─ gain ─────────────┼─ master ─ limiter
//    noise ─ bandpass 620 Hz (overrun burble blips) ─ gain ─────────────┤
//    one-shot impact thump/knock ─────────────────────────────────────────┘
//
//  Rules of the mix: at idle and at full throttle the dominant sound is
//  a PITCHED ENGINE TONE — never hiss. The squeal is high and narrow —
//  instantly "tires", never wind. RPM still derives from REAR WHEEL
//  speed, so burnouts rev high while the car crawls.
//
//  Autoplay policy: nothing constructed until enable() runs in a user
//  gesture. Mute dips the master gain; the graph keeps running.
// =============================================================================

export const SOUND_CONFIG = {
  master: 0.8,

  // ---------- Engine (oscillator core) ----------
  idleHz: 52,                  // oscillator base at standstill
  maxHz: 380,                  // at full virtual RPM
  rpmFullWheelSpeed: 42,       // m/s WHEEL contact speed = full RPM
  rpmCurve: 0.72,              // <1 = satisfying early climb
  wobbleHz: 5.5,               // mechanical pitch wobble LFO
  wobbleDepthHz: 2.4,
  jitter: 0.012,               // ±1.2% random-walk pitch jitter
  // Gentle AM throb at the firing rate — the one nod to "combustion".
  // Low depth on purpose: a throb, not a buzz.
  amDepth: 0.16,
  fireRateIdle: 30,            // throb rate at idle (lopey)
  fireRateMax: 220,            // at redline (fuses perceptually)
  filterBaseHz: 240,           // lowpass: dark off-throttle
  filterThrottleHz: 2900,      // opens with throttle
  filterRpmHz: 1300,           // and with RPM
  engineIdleVol: 0.20,
  engineThrottleVol: 0.26,
  engineRpmVol: 0.12,
  attackTau: 0.02,
  releaseTau: 0.09,
  burbleVol: 0.10,             // overrun blips (tightly filtered, brief)

  // ---------- Tire squeal: HIGH and NARROW = instantly "tires" ----------
  squealStartDeg: 9,
  squealFullDeg: 26,
  squealVol: 0.26,
  squealFreqBase: 1700,        // Hz — bandpass center at light slip
  squealFreqSlip: 900,         // rises with slip depth (deeper = higher wail)
  squealQ: 12,                 // narrow band — squeal, not wind

  // ---------- Burnout screech: high + rough, no woosh ----------
  burnoutVol: 0.30,
  burnoutFreqHz: 950,
  burnoutQ: 8,
  burnoutFlutterHz: 27,        // square-LFO flutter = roughness
  burnoutFlutterDepth: 120,

  // ---------- Impacts (unchanged from iteration 1) ----------
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
  private oscMain!: OscillatorNode;
  private oscSub!: OscillatorNode;
  private oscHarm!: OscillatorNode;
  private amOsc!: OscillatorNode;
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

    // ---------- Engine: oscillators → AM throb → lowpass → gain ----------
    this.oscMain = ctx.createOscillator();
    this.oscMain.type = 'sawtooth';
    this.oscSub = ctx.createOscillator();
    this.oscSub.type = 'square';
    this.oscHarm = ctx.createOscillator();
    this.oscHarm.type = 'sawtooth';

    const mixMain = ctx.createGain(); mixMain.gain.value = 0.50;
    const mixSub  = ctx.createGain(); mixSub.gain.value  = 0.36;
    const mixHarm = ctx.createGain(); mixHarm.gain.value = 0.17;

    // AM throb: gain sits at (1 − depth/2), a sine at the firing rate
    // adds ±depth/2 → smooth 16% amplitude pulse. Mechanical, not buzzy.
    const amGain = ctx.createGain();
    amGain.gain.value = 1 - C.amDepth / 2;
    this.amOsc = ctx.createOscillator();
    this.amOsc.type = 'sine';
    this.amOsc.frequency.value = C.fireRateIdle;
    const amDepth = ctx.createGain();
    amDepth.gain.value = C.amDepth / 2;
    this.amOsc.connect(amDepth);
    amDepth.connect(amGain.gain);

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = C.filterBaseHz;
    this.engineFilter.Q.value = 1.1;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.oscMain.connect(mixMain); mixMain.connect(amGain);
    this.oscSub.connect(mixSub);   mixSub.connect(amGain);
    this.oscHarm.connect(mixHarm); mixHarm.connect(amGain);
    amGain.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Mechanical pitch wobble.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = C.wobbleHz;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = C.wobbleDepthHz;
    lfo.connect(lfoDepth);
    lfoDepth.connect(this.oscMain.frequency);
    lfoDepth.connect(this.oscHarm.frequency);

    // ---------- Shared looped white-noise source (filtered uses only) ----------
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;

    // Tire squeal — narrow high bandpass, panned by slip direction.
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

    // Burnout screech — high-ish narrow band with frequency flutter.
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

    // Overrun burble: brief midband blips, scheduled on throttle lift.
    const burbleFilter = ctx.createBiquadFilter();
    burbleFilter.type = 'bandpass';
    burbleFilter.frequency.value = 620;
    burbleFilter.Q.value = 2.5;
    this.burbleGain = ctx.createGain();
    this.burbleGain.gain.value = 0;
    noise.connect(burbleFilter);
    burbleFilter.connect(this.burbleGain);
    this.burbleGain.connect(this.master);

    this.oscMain.start();
    this.oscSub.start();
    this.oscHarm.start();
    this.amOsc.start();
    lfo.start();
    flutter.start();
    noise.start();
  }

  // Per-frame parameter drive — smooth ramps, no zipper noise.
  update(s: SoundState) {
    if (!this.ctx || !this.enabled) return;
    const C = SOUND_CONFIG;
    const t = this.ctx.currentTime;

    // ---- Engine pitch + throb rate from WHEEL speed ----
    const rpmN = Math.pow(
      clamp(Math.abs(s.wheelSpeed) / C.rpmFullWheelSpeed, 0, 1), C.rpmCurve);
    this.jitterState = clamp(
      this.jitterState + (Math.random() - 0.5) * 0.5, -1, 1);
    const f = (C.idleHz + rpmN * (C.maxHz - C.idleHz)) *
      (1 + C.jitter * this.jitterState);
    this.oscMain.frequency.setTargetAtTime(f, t, 0.02);
    this.oscSub.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.oscHarm.frequency.setTargetAtTime(f * 1.503, t, 0.02);
    this.amOsc.frequency.setTargetAtTime(
      C.fireRateIdle + rpmN * (C.fireRateMax - C.fireRateIdle), t, 0.03);

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

    // ---- Drift squeal: high, narrow, pitch rising with slip depth ----
    const slipDeg = Math.abs(s.slipAngle) * 180 / Math.PI;
    const sNorm = clamp(
      (slipDeg - C.squealStartDeg) / (C.squealFullDeg - C.squealStartDeg), 0, 1);
    const squealVol = sNorm * clamp(s.speed / 8, 0.2, 1) * C.squealVol;
    this.squealGain.gain.setTargetAtTime(squealVol, t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(
      C.squealFreqBase + sNorm * C.squealFreqSlip, t, 0.06);
    this.squealPan.pan.setTargetAtTime(
      clamp(Math.sign(s.slipAngle) * -0.3 * sNorm, -0.4, 0.4), t, 0.08);

    // ---- Burnout screech: wheelspin while the car is slow ----
    const burnout = s.wheelSpin * clamp(1 - s.speed / 12, 0, 1) * C.burnoutVol;
    this.burnoutGain.gain.setTargetAtTime(burnout, t, 0.05);
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
