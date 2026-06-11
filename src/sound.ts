// =============================================================================
//  Steer It — procedural soundscape, iteration 2 (Web Audio, no samples).
//
//  THE ENGINE IS NOT A TONE. A real engine is a rapid series of combustion
//  events — ~30 firings/sec at idle (heard as a lopey rumble), blending
//  into a roar near redline but always keeping pulse and irregularity.
//  The core is an AudioWorklet generating that impulse train sample-
//  accurately: each firing is a few-ms noise burst + a low sine thump,
//  with per-pulse amplitude (±15%) and timing (±4%) randomness — the
//  irregularity is what reads as "mechanical" instead of "synth".
//
//  The pulse train then drives a RESONANT BODY: three fixed bandpass
//  formants (~90/220/600 Hz — exhaust pipe + block resonances, low-mid
//  biased for a small-rally-car growl) plus a direct low thump path, into
//  a load filter whose cutoff opens with throttle (dark off-throttle,
//  bright and snarling on it).
//
//  Dirt layers: an RPM-tracking mechanical rustle bed, an intake hiss
//  that rises with throttle, and sparse overrun pops (extra-strong lone
//  pulses through the same exhaust formants) when lifting at revs.
//
//  Virtual RPM still derives from REAR WHEEL speed — a burnout revs to
//  the moon while the car crawls. Tire squeal / burnout screech / impact
//  thumps carry over from iteration 1, rebalanced against the new engine.
//
//  Autoplay policy: nothing is constructed until enable() runs inside a
//  user gesture. Mute dips the master gain; the graph keeps running.
// =============================================================================

export const SOUND_CONFIG = {
  master: 0.8,

  // ---------- Engine core (impulse train) ----------
  idleFiringHz: 30,            // firings/sec at standstill — audible lope
  maxFiringHz: 240,            // near redline — blends into a roar
  rpmFullWheelSpeed: 42,       // m/s of WHEEL contact speed = full RPM
  rpmCurve: 0.72,              // <1 = climbs fast early
  engineVolBase: 0.40,         // off-throttle engine level
  engineVolThrottle: 0.26,     // + under load
  attackTau: 0.02,             // throttle swell — must feel instant
  releaseTau: 0.09,

  // ---------- Resonant body ----------
  formant1Hz: 92,  formant1Q: 3.2, formant1Gain: 1.0,   // exhaust fundamental
  formant2Hz: 225, formant2Q: 3.0, formant2Gain: 0.75,  // block knock
  formant3Hz: 620, formant3Q: 2.4,                      // snarl (gain = load)
  formant3GainBase: 0.30, formant3GainThrottle: 0.45,
  bodyLowpassHz: 160,          // direct low-thump path
  loadFilterBaseHz: 750,       // overall brightness: dark off-throttle...
  loadFilterThrottleHz: 2700,  // ...opens under load

  // ---------- Dirt layers ----------
  rustleVol: 0.045,            // mechanical noise bed, RPM-tracking
  intakeVol: 0.07,             // hiss rising with throttle
  popChancePerSec: 1.6,        // sparse coast pops at mid/high RPM
  popLiftThreshold: 0.45,      // sharp-lift detection for overrun pops

  // ---------- Tires (carried over, rebalanced) ----------
  squealStartDeg: 9,
  squealFullDeg: 26,
  squealVol: 0.30,
  squealFreqBase: 1150,
  squealFreqSlip: 1500,
  squealQ: 7,
  burnoutVol: 0.34,
  burnoutFreqHz: 520,
  burnoutQ: 2.5,
  burnoutFlutterHz: 27,
  burnoutFlutterDepth: 80,

  // ---------- Impacts ----------
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

// -----------------------------------------------------------------------------
//  The AudioWorklet processor source. Registered from a Blob URL so it
//  needs no bundler support. Self-contained; k-rate params firingRate and
//  throttle; port message 'pop' queues an extra-strong lone pulse.
// -----------------------------------------------------------------------------
const ENGINE_WORKLET_SRC = `
class EngineCore extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'firingRate', defaultValue: 30, minValue: 5, maxValue: 400, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.nextFire = 0;
    this.pulses = [];
    this.popQueue = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'pop') this.popQueue += 1 + (Math.random() < 0.4 ? 1 : 0);
    };
  }
  fire(throttle, isPop) {
    // Per-pulse randomness — amplitude +-15%, pitch +-8% — is the
    // mechanical irregularity. Throttle makes pulses louder and sharper.
    this.pulses.push({
      age: 0,
      amp: (isPop ? 1.8 : 0.55 + 0.45 * throttle) * (0.85 + Math.random() * 0.3),
      freq: (isPop ? 54 : 76) * (0.92 + Math.random() * 0.16),
      sTau: isPop ? 0.020 : 0.012,
      nTau: 0.0028 + (1 - throttle) * 0.003,
      nAmp: isPop ? 0.9 : 0.55,
    });
    if (this.pulses.length > 10) this.pulses.shift();
  }
  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    const dt = 1 / sampleRate;
    const rate = Math.max(5, parameters.firingRate[0]);
    const thr = parameters.throttle[0];
    const interval = 1 / rate;
    for (let i = 0; i < out.length; i++) {
      this.nextFire -= dt;
      if (this.nextFire <= 0) {
        const isPop = this.popQueue > 0;
        if (isPop) this.popQueue--;
        this.fire(thr, isPop);
        // Timing jitter +-4% — engines are never metronomes.
        this.nextFire += interval * (1 + 0.08 * (Math.random() - 0.5));
      }
      let s = 0;
      for (let j = this.pulses.length - 1; j >= 0; j--) {
        const p = this.pulses[j];
        if (p.age > 0.06) { this.pulses.splice(j, 1); continue; }
        // Low sine thump (slight upward chirp) + fast noise crack.
        s += p.amp * (
          Math.exp(-p.age / p.sTau) *
            Math.sin(6.28318 * p.freq * p.age * (1 + p.age * 6)) * 0.9 +
          Math.exp(-p.age / p.nTau) * (Math.random() * 2 - 1) * p.nAmp
        );
        p.age += dt;
      }
      out[i] = s * 0.5;
    }
    return true;
  }
}
registerProcessor('engine-core', EngineCore);
`;

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineNode: AudioWorkletNode | null = null;
  private engineGain!: GainNode;
  private loadFilter!: BiquadFilterNode;
  private formant3Gain!: GainNode;
  private rustleGain!: GainNode;
  private intakeGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private squealGain!: GainNode;
  private squealPan!: StereoPannerNode;
  private burnoutFilter!: BiquadFilterNode;
  private burnoutGain!: GainNode;
  private noiseBuffer!: AudioBuffer;

  private prevThrottle = 0;
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

    // Register the engine-core processor from a Blob — no bundler magic.
    const blob = new Blob([ENGINE_WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
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

    // ---------- Engine: impulse train → resonant body → load filter ----------
    this.engineNode = new AudioWorkletNode(ctx, 'engine-core', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const mkFormant = (hz: number, q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    const f1 = mkFormant(C.formant1Hz, C.formant1Q);
    const f2 = mkFormant(C.formant2Hz, C.formant2Q);
    const f3 = mkFormant(C.formant3Hz, C.formant3Q);
    const g1 = ctx.createGain(); g1.gain.value = C.formant1Gain;
    const g2 = ctx.createGain(); g2.gain.value = C.formant2Gain;
    this.formant3Gain = ctx.createGain();
    this.formant3Gain.gain.value = C.formant3GainBase;
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = C.bodyLowpassHz;
    const gBody = ctx.createGain(); gBody.gain.value = 0.9;

    // Brightness under load: dark when coasting, opens with throttle.
    this.loadFilter = ctx.createBiquadFilter();
    this.loadFilter.type = 'lowpass';
    this.loadFilter.frequency.value = C.loadFilterBaseHz;
    this.loadFilter.Q.value = 0.8;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.engineNode.connect(f1); f1.connect(g1); g1.connect(this.loadFilter);
    this.engineNode.connect(f2); f2.connect(g2); g2.connect(this.loadFilter);
    this.engineNode.connect(f3); f3.connect(this.formant3Gain);
    this.formant3Gain.connect(this.loadFilter);
    this.engineNode.connect(body); body.connect(gBody);
    gBody.connect(this.loadFilter);
    this.loadFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // ---------- Shared looped white-noise source ----------
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;

    // Dirt: mechanical rustle bed (RPM-tracking) + intake hiss (throttle).
    const rustleLp = ctx.createBiquadFilter();
    rustleLp.type = 'lowpass';
    rustleLp.frequency.value = 320;
    this.rustleGain = ctx.createGain();
    this.rustleGain.gain.value = 0;
    noise.connect(rustleLp); rustleLp.connect(this.rustleGain);
    this.rustleGain.connect(this.master);

    const intakeBp = ctx.createBiquadFilter();
    intakeBp.type = 'bandpass';
    intakeBp.frequency.value = 1900;
    intakeBp.Q.value = 0.9;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    noise.connect(intakeBp); intakeBp.connect(this.intakeGain);
    this.intakeGain.connect(this.master);

    // ---------- Tires (iteration-1 design, rebalanced) ----------
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

    noise.start();
    flutter.start();
  }

  // Per-frame parameter drive — smooth ramps, no zipper noise.
  update(s: SoundState) {
    if (!this.ctx || !this.enabled || !this.engineNode) return;
    const C = SOUND_CONFIG;
    const t = this.ctx.currentTime;

    // ---- Firing rate from WHEEL speed (burnout = high revs) ----
    const rpmN = Math.pow(
      clamp(Math.abs(s.wheelSpeed) / C.rpmFullWheelSpeed, 0, 1), C.rpmCurve);
    const firing = C.idleFiringHz + rpmN * (C.maxFiringHz - C.idleFiringHz);
    this.engineNode.parameters.get('firingRate')!
      .setTargetAtTime(firing, t, 0.025);
    this.engineNode.parameters.get('throttle')!
      .setTargetAtTime(s.throttle, t, 0.02);

    // ---- Load character: brightness + swell ----
    this.loadFilter.frequency.setTargetAtTime(
      C.loadFilterBaseHz + s.throttle * C.loadFilterThrottleHz, t, 0.03);
    this.formant3Gain.gain.setTargetAtTime(
      C.formant3GainBase + s.throttle * C.formant3GainThrottle, t, 0.03);
    const vol = C.engineVolBase + s.throttle * C.engineVolThrottle;
    const rising = vol > this.engineGain.gain.value;
    this.engineGain.gain.setTargetAtTime(
      vol, t, rising ? C.attackTau : C.releaseTau);

    // ---- Dirt layers ----
    this.rustleGain.gain.setTargetAtTime(
      C.rustleVol * (0.35 + 0.65 * rpmN), t, 0.06);
    this.intakeGain.gain.setTargetAtTime(
      C.intakeVol * s.throttle * s.throttle, t, 0.04);

    // ---- Overrun pops: sharp lift at revs + sparse pops on coast ----
    const lifted = this.prevThrottle - s.throttle > C.popLiftThreshold;
    const coasting = s.throttle < 0.15 && rpmN > 0.35;
    if ((lifted && rpmN > 0.25) ||
        (coasting && Math.random() < C.popChancePerSec / 60)) {
      this.engineNode.port.postMessage('pop');
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
