// =============================================================================
//  DIAGNOSTICS — one copy-pasteable block a player can send back.
//
//  Built for the "works on my machine" class of bug: it reports the things that
//  DIFFER between machines (screen size + aspect, DPI, window size, GPU, what a
//  canvas allocation ACTUALLY returned after read-back) and, critically, every
//  error we caught — the defensive try/catch blocks keep the game running, but
//  they must never make a failure invisible.
//
//  Deliberately dependency-free (no imports) so any module can record into it
//  without creating an import cycle; the host assembles the final report.
// =============================================================================

export interface DiagError { stage: string; message: string; stack?: string; at: string; }
export interface DiagCanvas {
  tag: string; reqW: number; reqH: number; gotW: number; gotH: number; ok: boolean;
}

const errors: DiagError[] = [];
const canvases: DiagCanvas[] = [];
const steps: Array<{ stage: string; ok: boolean; ms: number }> = [];
const MAX = 60;   // bounded — a long session can't grow this unboundedly

/** Record a CAUGHT error. Call this everywhere we swallow one to keep running. */
export function noteError(stage: string, err: unknown): void {
  const e = err as Error | undefined;
  errors.push({
    stage,
    message: String(e?.message ?? err),
    stack: e?.stack ? String(e.stack).split('\n').slice(1, 3).join(' | ') : undefined,
    at: new Date().toISOString(),
  });
  if (errors.length > MAX) errors.splice(0, errors.length - MAX);
}

/** Record a canvas allocation: what we ASKED for vs what the browser actually gave. */
export function noteCanvas(tag: string, reqW: number, reqH: number, cv: { width: number; height: number }): void {
  const rw = Math.max(1, Math.round(reqW)), rh = Math.max(1, Math.round(reqH));
  const ok = cv.width === rw && cv.height === rh;
  // Keep every MISMATCH (those are the interesting ones) but only a few successes.
  if (!ok || canvases.filter((c) => c.ok).length < 12) {
    canvases.push({ tag, reqW: rw, reqH: rh, gotW: cv.width, gotH: cv.height, ok });
    if (canvases.length > MAX) canvases.splice(0, canvases.length - MAX);
  }
}

/** Time a bake step and record whether it threw (the error is re-thrown for the caller). */
export function noteStep<T>(stage: string, fn: () => T): T {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
  try {
    const out = fn();
    steps.push({ stage, ok: true, ms: Math.round(((typeof performance !== 'undefined' ? performance.now() : 0) - t0) * 10) / 10 });
    return out;
  } catch (err) {
    steps.push({ stage, ok: false, ms: Math.round(((typeof performance !== 'undefined' ? performance.now() : 0) - t0) * 10) / 10 });
    noteError(stage, err);
    throw err;
  }
}

export function diagErrors(): DiagError[] { return errors; }
export function diagCanvases(): DiagCanvas[] { return canvases; }
export function diagSteps(): typeof steps { return steps; }

/** GPU string via WEBGL_debug_renderer_info (best effort — some browsers mask it). */
function gpuInfo(): string {
  try {
    const cv = document.createElement('canvas');
    const gl = (cv.getContext('webgl') || cv.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'no webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter((ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL) : null;
    const v = ext ? gl.getParameter((ext as { UNMASKED_VENDOR_WEBGL: number }).UNMASKED_VENDOR_WEBGL) : null;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    return `${v ?? '?'} / ${r ?? 'masked'} (maxTexture ${maxTex})`;
  } catch { return 'gpu probe failed'; }
}

/** Largest square canvas the browser actually honours — the real practical limit. */
function probeCanvasLimit(): string {
  const tryDim = (d: number) => {
    try {
      const cv = document.createElement('canvas');
      cv.width = d; cv.height = d;
      const ok = cv.width === d && cv.height === d;
      const ctx = ok ? cv.getContext('2d') : null;
      // a clamped canvas often still reports the size but fails to paint
      if (ok && ctx) { ctx.fillStyle = '#fff'; ctx.fillRect(d - 2, d - 2, 2, 2); }
      cv.width = 1; cv.height = 1;   // release
      return ok;
    } catch { return false; }
  };
  for (const d of [16384, 8192, 4096, 2048]) if (tryDim(d)) return `${d}px square OK`;
  return 'under 2048px (!)';
}

export interface DiagSections {
  /** Anything the host wants to add: layer sizes, memory stats, map geometry… */
  [section: string]: Record<string, unknown>;
}

/** Build the one copy-pasteable block. */
export function collectDiag(extra: DiagSections = {}): string {
  const L: string[] = [];
  const pad = (k: string) => (k + ':').padEnd(22);
  L.push('===== STEER IT DIAGNOSTICS =====');
  L.push(pad('when') + new Date().toISOString());
  try { L.push(pad('url') + location.href); } catch { /* ignore */ }

  const sw = window.screen?.width ?? 0, sh = window.screen?.height ?? 0;
  L.push('--- display ---');
  L.push(pad('screen') + `${sw} x ${sh}  (aspect ${(sw / Math.max(1, sh)).toFixed(3)})`);
  L.push(pad('window inner') + `${window.innerWidth} x ${window.innerHeight}`);
  L.push(pad('devicePixelRatio') + String(window.devicePixelRatio));
  try {
    const vv = window.visualViewport;
    if (vv) L.push(pad('visualViewport') + `${Math.round(vv.width)} x ${Math.round(vv.height)} @scale ${vv.scale}`);
  } catch { /* ignore */ }
  L.push(pad('fullscreen') + String(!!document.fullscreenElement));
  L.push(pad('colorDepth') + String(window.screen?.colorDepth));

  L.push('--- environment ---');
  L.push(pad('userAgent') + navigator.userAgent);
  L.push(pad('platform') + String((navigator as { platform?: string }).platform ?? '?'));
  L.push(pad('cores / memory') + `${navigator.hardwareConcurrency ?? '?'} / ${(navigator as { deviceMemory?: number }).deviceMemory ?? '?'}GB`);
  L.push(pad('gpu') + gpuInfo());
  L.push(pad('canvas limit') + probeCanvasLimit());
  L.push(pad('reduced motion') + String(matchMedia('(prefers-reduced-motion: reduce)').matches));

  for (const [name, obj] of Object.entries(extra)) {
    L.push(`--- ${name} ---`);
    for (const [k, v] of Object.entries(obj)) {
      L.push(pad(k) + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
  }

  L.push('--- canvas allocations (requested vs actual) ---');
  if (!canvases.length) L.push('  (none recorded yet — open a map first)');
  for (const c of canvases) {
    L.push(`  ${c.ok ? 'ok  ' : 'MISMATCH'} ${c.tag.padEnd(20)} asked ${c.reqW}x${c.reqH} → got ${c.gotW}x${c.gotH}`);
  }

  L.push('--- bake steps ---');
  if (!steps.length) L.push('  (none recorded yet)');
  for (const s of steps) L.push(`  ${s.ok ? 'ok  ' : 'THREW'} ${s.stage.padEnd(24)} ${s.ms}ms`);

  L.push('--- errors caught (NOT swallowed) ---');
  if (!errors.length) L.push('  none');
  for (const e of errors) L.push(`  [${e.stage}] ${e.message}${e.stack ? `\n      ${e.stack}` : ''}`);

  L.push('===== END =====');
  return L.join('\n');
}
