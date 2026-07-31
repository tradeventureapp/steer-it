// =============================================================================
//  DIRT-EDIT — a DEV-ONLY overlay to mark the Rallycross dirt section.
//
//  Lazy-loaded (dynamic import) + dev-gated by the caller, so normal visitors
//  never load it. The dirt stretch is a contiguous index range [i0,i1] on the
//  arc-length-even CIRCUIT_PATH (shared with the circuit). You click "SET START"
//  / "SET END" and then click the track — the nearest path index becomes that
//  endpoint. A live PREVIEW overlay (brown arc + start/end markers) shows the
//  range on the real track; EXPORT prints `i0/i1` to paste into RALLYCROSS_DIRT
//  in maps.ts (same preview-then-lock pattern as the page-escort editor). The
//  final baked darker-packed dirt appears once the range is locked + reloaded.
// =============================================================================

export interface DirtEditDeps {
  /** world metres → viewport (client) px, using the game's live camera transform. */
  worldToScreen(wx: number, wy: number): { x: number; y: number };
  /** viewport (client) px → world metres. */
  screenToWorld(clientX: number, clientY: number): { x: number; y: number };
  /** the circuit path in world metres. */
  pathWorld(): Array<[number, number]>;
  /** nearest path index to a world point. */
  nearest(wx: number, wy: number): number;
  pathLen(): number;
  getRange(): { i0: number; i1: number };
  /** set the live range (updates the physics mask); the preview reads getRange each frame. */
  setRange(i0: number, i1: number): void;
}

export interface DirtEditHandle { destroy(): void; }

export function startDirtEdit(deps: DirtEditDeps): DirtEditHandle {
  let editing: 'start' | 'end' = 'start';

  // ---- overlay canvas (on top of the game, non-interactive) ----
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');

  // ---- control panel (interactive) ----
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'right:14px', 'top:14px', 'z-index:9999', 'width:220px',
    'background:rgba(16,8,26,0.92)', 'border:1px solid #ff479e', 'border-radius:10px',
    'padding:12px', 'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace', 'color:#f3e9ff',
    'box-shadow:0 8px 30px #000', 'user-select:none',
  ].join(';');
  panel.innerHTML =
    '<div style="font-weight:800;letter-spacing:1px;color:#ffc24a;margin-bottom:8px">DIRT EDIT · Rallycross</div>'
    + '<div style="display:flex;gap:6px;margin-bottom:8px">'
    + '<button id="de-start" style="flex:1;padding:6px 4px;border-radius:6px;border:1px solid #2f8f52;background:#153;color:#dfff0e6;cursor:pointer">SET START</button>'
    + '<button id="de-end" style="flex:1;padding:6px 4px;border-radius:6px;border:1px solid #a33;background:#411;color:#ffe6e6;cursor:pointer">SET END</button>'
    + '</div>'
    + '<div id="de-info" style="margin-bottom:8px;color:#c5b6e6"></div>'
    + '<div style="display:flex;gap:6px">'
    + '<button id="de-export" style="flex:1;padding:6px 4px;border-radius:6px;border:1px solid #ff8a3d;background:#3a1e10;color:#ffd8a8;cursor:pointer">EXPORT</button>'
    + '<button id="de-close" style="padding:6px 8px;border-radius:6px;border:1px solid #665;background:#221;color:#ddd;cursor:pointer">✕</button>'
    + '</div>'
    + '<div id="de-out" style="margin-top:8px;font-size:11px;color:#8fd18f;word-break:break-all"></div>'
    + '<div style="margin-top:8px;font-size:10.5px;color:#9a8cc0">Pick a mode, then click the track. Green = start, red = end. Then EXPORT and paste into RALLYCROSS_DIRT.</div>';
  document.body.appendChild(panel);

  const $ = (id: string) => panel.querySelector('#' + id) as HTMLElement;
  const btnStart = $('de-start'), btnEnd = $('de-end'), info = $('de-info'), out = $('de-out');

  function refreshButtons() {
    btnStart.style.outline = editing === 'start' ? '2px solid #6f9' : 'none';
    btnEnd.style.outline = editing === 'end' ? '2px solid #f88' : 'none';
    const { i0, i1 } = deps.getRange();
    const n = deps.pathLen();
    info.textContent = `i0 ${i0} · i1 ${i1}  (${Math.abs(i1 - i0)} / ${n} pts)`;
  }

  btnStart.addEventListener('click', () => { editing = 'start'; refreshButtons(); });
  btnEnd.addEventListener('click', () => { editing = 'end'; refreshButtons(); });
  $('de-export').addEventListener('click', () => {
    const { i0, i1 } = deps.getRange();
    const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
    const snippet = `const RALLYCROSS_DIRT = { i0: ${lo}, i1: ${hi} };`;
    out.textContent = snippet;
    // eslint-disable-next-line no-console
    console.log('[dirt-edit] paste into maps.ts:\n' + snippet);
    if (navigator.clipboard) navigator.clipboard.writeText(snippet).catch(() => {});
  });
  $('de-close').addEventListener('click', () => handle.destroy());

  // ---- click the track → set the active endpoint to the nearest path index ----
  const onDown = (e: PointerEvent) => {
    if (panel.contains(e.target as Node)) return;   // clicks on the panel are UI, not track picks
    const w = deps.screenToWorld(e.clientX, e.clientY);
    const idx = deps.nearest(w.x, w.y);
    const r = deps.getRange();
    if (editing === 'start') deps.setRange(idx, r.i1); else deps.setRange(r.i0, idx);
    refreshButtons();
  };
  window.addEventListener('pointerdown', onDown, { passive: true });

  // ---- preview render loop ----
  let raf = 0, running = true;
  function measure() {
    cv.width = Math.round(window.innerWidth);
    cv.height = Math.round(window.innerHeight);
  }
  const onResize = () => measure();
  window.addEventListener('resize', onResize);
  measure();

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const path = deps.pathWorld();
    if (path.length) {
      // faint full ribbon centreline
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const p = deps.worldToScreen(path[i][0], path[i][1]);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.closePath(); ctx.stroke();
      // the dirt arc, thick brown
      const { i0, i1 } = deps.getRange();
      const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
      ctx.lineWidth = 10; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(120,80,48,0.85)';
      ctx.beginPath();
      for (let i = lo; i <= hi; i++) {
        const p = deps.worldToScreen(path[i][0], path[i][1]);
        i === lo ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      // start (green) + end (red) markers
      const mark = (i: number, col: string, label: string) => {
        const p = deps.worldToScreen(path[i][0], path[i][1]);
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.fill();
        ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '700 12px ui-monospace,monospace';
        ctx.fillText(label, p.x + 11, p.y + 4);
      };
      mark(i0, '#39f06a', 'START ' + i0);
      mark(i1, '#f0503a', 'END ' + i1);
    }
    if (running) raf = requestAnimationFrame(draw);
  }
  refreshButtons();
  raf = requestAnimationFrame(draw);

  const handle: DirtEditHandle = {
    destroy() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', onResize);
      cv.remove(); panel.remove();
    },
  };
  return handle;
}
