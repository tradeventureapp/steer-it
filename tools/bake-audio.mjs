// =============================================================================
//  bake-audio.mjs — offline-renders the game's audio loops to WAV.
//
//  Sourcing note (2026-06): direct download of CC0 recordings failed from
//  this environment — freesound's API requires an auth token (401), pixabay
//  blocks non-browser clients (403), and Wikimedia Commons audio hits are
//  field recordings unsuited to seamless loops (and largely OGG, which
//  Safari cannot decode). Per the fallback in the spec, these loops are
//  PROCEDURALLY BAKED with heavy offline processing instead — layered
//  sources, cascaded filters, saturation — quality over realtime limits.
//
//  Outputs (44.1 kHz, 16-bit PCM mono, seamless via equal-power seam fade):
//    public/audio/engine_idle.wav   2.0 s  ~30 firings/s combustion + tone
//    public/audio/engine_high.wav   2.0 s  ~150 firings/s + harmonic stack
//    public/audio/tire_squeal.wav   1.6 s  narrow resonant squeal w/ wow
//
//  Each render prints QC metrics (peak, RMS, high-frequency energy ratio,
//  loop-seam discontinuity) and the script exits non-zero if any metric is
//  out of bounds — "no static, no clicks" is enforced numerically.
//
//  Run:  node tools/bake-audio.mjs
// =============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 44100;

// ---------- Tiny DSP toolkit (RBJ cookbook biquads) ----------
function biquad(type, f0, Q, dbGain = 0) {
  const A = Math.pow(10, dbGain / 40);
  const w0 = 2 * Math.PI * f0 / SR;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': // constant peak gain
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    default: throw new Error(type);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filterRun(x, coef) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = coef.b0 * x[i] + coef.b1 * x1 + coef.b2 * x2 -
      coef.a1 * y1 - coef.a2 * y2;
    x2 = x1; x1 = x[i];
    y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

const filt = (x, type, f0, Q, db) => filterRun(x, biquad(type, f0, Q, db));

function saturate(x, drive) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = Math.tanh(x[i] * drive);
  return y;
}

function normalize(x, peakTarget = 0.71) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? peakTarget / peak : 1;
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  return y;
}

// Render `n + fadeN` samples, then equal-power-fold the tail into the head
// so sample N-1 → sample 0 is seamless by construction.
function loopify(x, n, fadeN) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = x[i];
  for (let i = 0; i < fadeN; i++) {
    const w = i / fadeN;
    y[i] = y[i] * Math.sqrt(w) + x[n + i] * Math.sqrt(1 - w);
  }
  return y;
}

function writeWav(path, x) {
  const n = x.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

// ---------- QC ----------
function rms(x) {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

function qc(name, x, { maxHfRatio }) {
  const hf = filt(x, 'highpass', 4000, 0.707);
  const hfRatio = rms(hf) / (rms(x) || 1);
  // Click test: the wrap-around step (x[N-1] → x[0]) must look like any
  // other sample-to-sample step in the signal. An absolute threshold
  // would false-alarm on high-frequency content where consecutive
  // samples legitimately differ a lot.
  let meanStep = 0;
  for (let i = 1; i < x.length; i++) meanStep += Math.abs(x[i] - x[i - 1]);
  meanStep /= x.length - 1;
  const seamRatio = Math.abs(x[0] - x[x.length - 1]) / (meanStep || 1);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  console.log(
    `${name}: peak=${peak.toFixed(3)} rms=${rms(x).toFixed(3)} ` +
    `hfRatio=${hfRatio.toFixed(3)} seamRatio=${seamRatio.toFixed(2)}x`);
  if (hfRatio > maxHfRatio) {
    throw new Error(`${name}: high-frequency ratio ${hfRatio.toFixed(3)} > ${maxHfRatio} — would read as static`);
  }
  if (seamRatio > 3) {
    throw new Error(`${name}: seam step ${seamRatio.toFixed(2)}x the typical step — would click`);
  }
}

// ---------- Engine renderer ----------
// Layered: a combustion impulse train (pre-filtered noise cracks + sine
// thumps, randomized per pulse) + a bandlimited harmonic stack at the
// firing fundamental for tonal center, through a resonant body chain.
function renderEngine({ firingHz, dur, brightLp, harmMix, thumpHz }) {
  const fadeN = Math.floor(0.25 * SR);
  const N = Math.floor(dur * SR) + fadeN;
  const out = new Float64Array(N);

  // Pre-filtered noise for the cracks — no raw white noise anywhere.
  let crackSrc = new Float64Array(N);
  for (let i = 0; i < N; i++) crackSrc[i] = Math.random() * 2 - 1;
  crackSrc = filt(crackSrc, 'lowpass', 900, 0.9);

  // Combustion pulses.
  let tFire = 0;
  while (tFire < dur + 0.3) {
    const i0 = Math.floor(tFire * SR);
    const amp = 0.85 + Math.random() * 0.3;
    const f = thumpHz * (0.92 + Math.random() * 0.16);
    const sTau = 0.012, nTau = 0.004;
    const len = Math.min(Math.floor(0.06 * SR), N - i0);
    for (let i = 0; i < len; i++) {
      const a = i / SR;
      out[i0 + i] += amp * (
        Math.exp(-a / sTau) * Math.sin(2 * Math.PI * f * a * (1 + a * 6)) * 0.9 +
        Math.exp(-a / nTau) * crackSrc[i0 + i] * 1.4
      );
    }
    tFire += (1 / firingHz) * (1 + 0.08 * (Math.random() - 0.5));
  }

  // Harmonic stack at the firing fundamental (bandlimited "exhaust note").
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const vib = 1 + 0.008 * Math.sin(2 * Math.PI * 4.7 * t);
    let s = 0;
    for (let h = 1; h <= 6; h++) {
      s += Math.sin(2 * Math.PI * firingHz * vib * h * t) / h;
    }
    out[i] += s * harmMix;
  }

  // Resonant body + polish.
  let y = filt(out, 'peaking', 90, 1.2, 8);
  y = filt(y, 'peaking', 220, 1.5, 5);
  y = filt(y, 'lowpass', brightLp, 0.8);
  y = saturate(y, 1.6);
  y = filt(y, 'highpass', 38, 0.707);
  y = filt(y, 'lowpass', brightLp, 0.8);

  return normalize(loopify(y, Math.floor(dur * SR), fadeN));
}

// ---------- Squeal renderer ----------
// Narrow resonant noise around ~1.9 kHz with pitch wow and tremolo —
// reads as rubber, not wind, because the band is NARROW and HIGH.
function renderSqueal({ dur }) {
  const fadeN = Math.floor(0.2 * SR);
  const N = Math.floor(dur * SR) + fadeN;
  let x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.random() * 2 - 1;

  // Time-varying narrow resonator: process in 1024-sample chunks with the
  // center frequency wobbling (wow) — cascade twice for narrowness.
  const chunk = 1024;
  for (let pass = 0; pass < 2; pass++) {
    const y = new Float64Array(N);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let c0 = 0; c0 < N; c0 += chunk) {
      const t = c0 / SR;
      const f0 = 1900 + 170 * Math.sin(2 * Math.PI * 7.3 * t) +
        90 * Math.sin(2 * Math.PI * 1.7 * t + 1.3);
      const k = biquad('bandpass', f0, 13);
      const end = Math.min(c0 + chunk, N);
      for (let i = c0; i < end; i++) {
        const v = k.b0 * x[i] + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
        x2 = x1; x1 = x[i];
        y2 = y1; y1 = v;
        y[i] = v;
      }
    }
    x = y;
  }

  // A lighter fixed companion resonance + tremolo + polish.
  const hi = filt(x, 'bandpass', 2600, 8);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const trem = 1 - 0.12 + 0.12 * Math.sin(2 * Math.PI * 11 * t);
    x[i] = (x[i] + hi[i] * 0.45) * trem;
  }
  let y = saturate(x, 2.2);
  y = filt(y, 'highpass', 1200, 0.707);

  return normalize(loopify(y, Math.floor(dur * SR), fadeN));
}

// ---------- Bake everything ----------
mkdirSync('public/audio', { recursive: true });

const idle = renderEngine({
  firingHz: 30, dur: 2.0, brightLp: 1900, harmMix: 0.16, thumpHz: 76,
});
qc('engine_idle', idle, { maxHfRatio: 0.10 });
writeWav('public/audio/engine_idle.wav', idle);

const high = renderEngine({
  firingHz: 150, dur: 2.0, brightLp: 3300, harmMix: 0.30, thumpHz: 88,
});
qc('engine_high', high, { maxHfRatio: 0.14 });
writeWav('public/audio/engine_high.wav', high);

const squeal = renderSqueal({ dur: 1.6 });
qc('tire_squeal', squeal, { maxHfRatio: 0.55 }); // it's high-pitched by design
writeWav('public/audio/tire_squeal.wav', squeal);

console.log('Baked to public/audio/.');
