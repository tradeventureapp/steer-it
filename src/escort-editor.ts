// =============================================================================
//  ESCORT PATH EDITOR — a lightweight, in-page tool to DRAW the page-escort car's
//  loop for each section below the hero.
//
//  Author-only, gated behind the URL hash `#escort-edit` (see desktop.ts). It
//  overlays the landing page: click to drop waypoints around a section, drag to
//  move them, right-click to delete. The escort car follows the drawn loop LIVE
//  (Catmull-Rom spline, closed + rounded — the same one the car laps), so you can
//  tweak until it looks right, then Export the final per-section points to hand
//  back. The hero loop (section 0) is locked (computed, untouched).
//
//  Nothing here ships to normal visitors — it only wakes on the hash, and it
//  reuses the escort's own coordinate maps so what you draw is exactly what laps.
// =============================================================================
import type { PageEscortHandle, Waypoint } from './page-escort';

const GRAB_PX = 15;          // click within this of a point → grab it

export interface EscortEditorHandle { destroy(): void; }

export function startEscortEditor(
  escort: PageEscortHandle, scroller: HTMLElement, sectionNames: string[],
): EscortEditorHandle {
  // Non-hero loops (index k ↔ section k+1). Mutated locally, pushed live to the car.
  let loops: Waypoint[][] = escort.getLoops();
  let sel: { li: number; pi: number } | null = null;
  let dragging = false;
  let lastSection = 1;         // section a click last landed in (for "Clear section")
  let raf = 0;

  escort.setDebugPath(true);

  // ---- overlay canvas (over the scroller, capturing pointer events) ----------
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;z-index:100000;touch-action:none;cursor:crosshair;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let dpr = 1;

  function layout() {
    const r = scroller.getBoundingClientRect();
    canvas.style.left = `${r.left}px`; canvas.style.top = `${r.top}px`;
    canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- toolbar ---------------------------------------------------------------
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:100001;'
    + 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center;'
    + 'padding:8px 12px;border-radius:12px;background:rgba(8,4,18,.92);'
    + 'border:1px solid rgba(255,45,149,.5);box-shadow:0 6px 24px rgba(0,0,0,.5);'
    + 'font-family:system-ui,sans-serif;font-size:12px;color:#f3e9ff;max-width:94vw;';
  const info = document.createElement('span');
  info.style.cssText = 'letter-spacing:.3px;';
  const mkBtn = (label: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'appearance:none;cursor:pointer;font:inherit;font-weight:700;'
      + 'padding:6px 12px;border-radius:8px;color:#fff;border:1px solid rgba(255,45,149,.55);'
      + 'background:linear-gradient(100deg,#ff8a3d,#ff2d8f);';
    return b;
  };
  const bExport = mkBtn('Export');
  const bClear = mkBtn('Clear section');
  const bDone = mkBtn('Done');
  bClear.style.background = 'rgba(255,255,255,.08)';
  bDone.style.background = 'rgba(255,255,255,.08)';
  const help = document.createElement('span');
  help.style.cssText = 'opacity:.75;';
  help.textContent = 'Click = add · drag = move · right-click = delete · scroll / PgDn = next section · hero locked';
  bar.append(info, bExport, bClear, bDone, help);
  document.body.appendChild(bar);

  // Export panel (textarea, copy-to-clipboard).
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:100001;'
    + 'display:none;flex-direction:column;gap:6px;padding:10px;border-radius:10px;width:min(560px,92vw);'
    + 'background:rgba(8,4,18,.96);border:1px solid rgba(255,45,149,.5);font-family:system-ui,sans-serif;';
  const ta = document.createElement('textarea');
  ta.style.cssText = 'width:100%;height:200px;background:#100a22;color:#cfe;border:1px solid #40305a;'
    + 'border-radius:8px;font-family:ui-monospace,monospace;font-size:12px;padding:8px;resize:vertical;';
  const panelHint = document.createElement('div');
  panelHint.style.cssText = 'font-size:11px;color:#c5b6e6;';
  panelHint.textContent = 'Copied to clipboard — paste this back to lock the loops in.';
  panel.append(ta, panelHint);
  document.body.appendChild(panel);

  function setInfo() {
    const nm = sectionNames[lastSection] || `section ${lastSection}`;
    const n = loops[lastSection - 1]?.length ?? 0;
    info.textContent = `Editing: ${nm}  (${n} pts)`;
  }

  // ---- coordinate helpers (viewport → scroller-relative → content) -----------
  function localXY(e: PointerEvent) {
    const r = scroller.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function handleAt(x: number, y: number): { li: number; pi: number } | null {
    for (let li = 0; li < loops.length; li++) {
      for (let pi = 0; pi < loops[li].length; pi++) {
        const c = escort.contentToClient(loops[li][pi].xf, loops[li][pi].yf);
        if (Math.hypot(c.x - x, c.y - y) <= GRAB_PX) return { li, pi };
      }
    }
    return null;
  }
  function sectionAt(x: number, y: number): number {
    const cc = escort.clientToContent(x, y);
    return escort.sectionForYf(cc.yf);
  }
  function commit() { escort.setLoops(loops); setInfo(); }

  // ---- pointer interaction ---------------------------------------------------
  function onDown(e: PointerEvent) {
    const { x, y } = localXY(e);
    const h = handleAt(x, y);
    if (h) { sel = h; dragging = true; lastSection = h.li + 1; setInfo(); return; }
    const sec = sectionAt(x, y);
    if (sec <= 0) { info.textContent = 'Hero loop is locked — pick a section below.'; return; }
    lastSection = sec;
    const li = sec - 1;
    if (!loops[li]) loops[li] = [];
    const cc = escort.clientToContent(x, y);
    loops[li].push({ xf: cc.xf, yf: cc.yf });
    sel = { li, pi: loops[li].length - 1 };
    dragging = true;
    commit();
  }
  function onMove(e: PointerEvent) {
    if (!dragging || !sel) return;
    const { x, y } = localXY(e);
    const cc = escort.clientToContent(x, y);
    loops[sel.li][sel.pi] = { xf: cc.xf, yf: cc.yf };
    commit();
  }
  function onUp() { dragging = false; }
  function onContext(e: MouseEvent) {
    e.preventDefault();
    const r = scroller.getBoundingClientRect();
    const h = handleAt(e.clientX - r.left, e.clientY - r.top);
    if (h) { loops[h.li].splice(h.pi, 1); sel = null; commit(); }
  }
  function onKey(e: KeyboardEvent) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault();
      loops[sel.li].splice(sel.pi, 1); sel = null; commit();
    } else if (e.key === 'Escape') { close(); }
    // Keyboard scrolling — the overlay would otherwise trap it (so PageDown / arrows
    // still move you down to the next section while editing).
    else if (e.key === 'PageDown') { e.preventDefault(); scroller.scrollBy(0, scroller.clientHeight * 0.85); }
    else if (e.key === 'PageUp') { e.preventDefault(); scroller.scrollBy(0, -scroller.clientHeight * 0.85); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); scroller.scrollBy(0, 90); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); scroller.scrollBy(0, -90); }
    else if (e.key === 'Home') { e.preventDefault(); scroller.scrollTo(0, 0); }
    else if (e.key === 'End') { e.preventDefault(); scroller.scrollTo(0, scroller.scrollHeight); }
  }
  // The overlay canvas sits over the whole page and would swallow the wheel, so
  // forward it to the scroller — that's how you move DOWN to the next section while
  // editing. (deltaMode 1 = lines → scale up to pixels.)
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    scroller.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  }

  function exportLoops() {
    const body = loops.map((lp, li) => {
      const nm = sectionNames[li + 1] || `section ${li + 1}`;
      const pts = lp.map((w) => `{ xf: ${w.xf.toFixed(3)}, yf: ${w.yf.toFixed(3)} }`).join(', ');
      return `  [ ${pts} ],   // ${nm}`;
    }).join('\n');
    const text = `[\n${body}\n]`;
    ta.value = text;
    panel.style.display = 'flex';
    try { void navigator.clipboard?.writeText(text); } catch { /* ignore */ }
    // eslint-disable-next-line no-console
    console.log('[escort-edit] loops:\n' + text);
  }

  bExport.addEventListener('click', exportLoops);
  bClear.addEventListener('click', () => { if (loops[lastSection - 1]) { loops[lastSection - 1] = []; sel = null; commit(); } });
  bDone.addEventListener('click', () => close());

  // ---- draw the handles each frame (follows scroll) --------------------------
  function drawPt(c: { x: number; y: number }, n: number, hot: boolean) {
    if (!ctx) return;
    ctx.beginPath(); ctx.arc(c.x, c.y, hot ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = hot ? '#ffd24a' : '#ff2d95';
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(n), c.x, c.y - 13);
  }
  function draw() {
    raf = requestAnimationFrame(draw);
    if (!ctx) return;
    const r = scroller.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    for (let li = 0; li < loops.length; li++) {
      const lp = loops[li];
      if (!lp.length) continue;
      // guide polygon (the spline rounds these — shown for placement)
      ctx.beginPath();
      for (let i = 0; i < lp.length; i++) {
        const c = escort.contentToClient(lp[i].xf, lp[i].yf);
        if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
      }
      ctx.closePath();
      ctx.setLineDash([5, 6]); ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(255,45,149,.55)'; ctx.stroke(); ctx.setLineDash([]);
      for (let i = 0; i < lp.length; i++) {
        drawPt(escort.contentToClient(lp[i].xf, lp[i].yf), i + 1, !!sel && sel.li === li && sel.pi === i);
      }
    }
  }

  function close() { destroy(); try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ } }

  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);

  layout(); setInfo(); draw();

  function destroy() {
    cancelAnimationFrame(raf);
    escort.setDebugPath(false);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('contextmenu', onContext);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKey);
    canvas.remove(); bar.remove(); panel.remove();
  }

  return { destroy };
}
