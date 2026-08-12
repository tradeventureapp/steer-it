// DEV-ONLY track authoring tool (track-editor.html — root page, served by `npm run
// dev`, NOT a build input so it never ships). Author a NEW circuit-family layout
// from scratch:
//
//   1. draw the centreline freehand (one closed stroke),
//   2. the stroke is simplified to CONTROL POINTS and fed through the REAL circuit
//      pipeline (maps.ts buildCircuitPath — Catmull-Rom → arc-length resample →
//      box-blur → finish-straight flatten; nothing reimplemented here),
//   3. drag / add (double-click) / delete (right-click) control points — the track
//      re-fits live, painted with the REAL surface painters (grass + tarmac),
//   4. tune the band width with the slider,
//   5. EXPORT emits the two constants maps.ts consumes (CIRCUIT_SKETCH + CS_BAND);
//      IMPORT parses a pasted export block / bare point array back in.
//
// The side panel shows the true in-game framing (FLAT_LOGICAL world + the same
// band/fit scale maths as CS_SCALE — kerb reach excluded, so a fit-capped layout
// previews a hair larger than it will ship).
import {
  buildCircuitPath, circuitBandScale, CIRCUIT_FIT, FLAT_LOGICAL, buildAuthoredKerbQuads,
  buildAuthoredEdgeLines, WHITE_LINE_INSET_M, WHITE_LINE_W_M, traceWornPolyline,
  drawBillboardShadow, drawBillboardBody, BILLBOARD_DIMS,
} from './maps';
import type { Pt, AuthoredKerb, AuthoredKerbQuad } from './maps';
import { SURFACES, preloadSurfaceAssets, onSurfaceAssetsReady, DIRT_LOOK, GRAVEL_LOOK } from './surfaces';
import type { SurfaceRC } from './surfaces';
import { CONFIG } from './vehicle-core';

// ---- canvas frame -----------------------------------------------------------------
// The edit canvas IS the in-game screen: the world's aspect (FLAT_LOGICAL) and the
// SAME mapping the game applies (fit scale + bounding-box centring), so the space
// you draw into is exactly the space the track occupies in-game, margins included.
// Before a track exists (freehand phase) the mapping is the band-bound one — the
// canvas edge-to-edge = one screen at the current band width.
const CW = 1408;
const CH = Math.round(CW * FLAT_LOGICAL.heightM / FLAT_LOGICAL.widthM);
const HIT_PX = 14;                                 // handle hit radius (canvas px)
const MIN_CTRL = 4, MAX_CTRL = 28;
const CAR_LEN_M = CONFIG.wheelbase * 0.865 * 2;    // Blitz length anchor (≈4.44 m)
const STORE_KEY = 'steer-track-editor-v1';

const cv = document.getElementById('cv') as HTMLCanvasElement;
const miniCv = document.getElementById('mini') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLElement;
const statsEl = document.getElementById('stats') as HTMLElement;
const widthEl = document.getElementById('width') as HTMLInputElement;
const widthOutEl = document.getElementById('width-out') as HTMLElement;
const gravelWidthEl = document.getElementById('gravel-width') as HTMLInputElement;
const gravelWidthOutEl = document.getElementById('gravel-width-out') as HTMLElement;
const bbWidthEl = document.getElementById('bb-width') as HTMLInputElement;
const bbWidthOutEl = document.getElementById('bb-width-out') as HTMLElement;
const outEl = document.getElementById('out') as HTMLTextAreaElement;

cv.width = CW; cv.height = CH;
const MINI_W = 340;
const MINI_H = Math.round(MINI_W * FLAT_LOGICAL.heightM / FLAT_LOGICAL.widthM);
miniCv.width = MINI_W; miniCv.height = MINI_H;

// The boss's current sketch — seeded on first open (no saved state) so refinement
// continues instead of redrawing. IMPORT replaces it with a pasted array any time.
const DEFAULT_SKETCH: Pt[] = [
  [1089,712],[911,710],[822,710],[758,618],[787,519],[875,480],[890,377],
  [777,278],[634,304],[519,441],[438,607],[187,626],[91,505],[80,271],
  [196,179],[421,249],[652,77],[965,100],[1016,307],[1061,475],[1278,492],
  [1343,145],[1573,79],[1685,196],[1620,322],[1535,361],[1531,505],[1675,562],
  [1656,712],[1520,715],[1397,710],[1271,712],
];
const DEFAULT_BAND = 134;

// ---- state ------------------------------------------------------------------------
let ctrl: Pt[] = [];                               // control points (closed loop, sketch units)
let band = DEFAULT_BAND;                           // ribbon width (sketch units) — the slider
let stroke: Pt[] = [];                             // freehand capture (draw mode = ctrl empty)
let drawing = false;
let dragIdx: number | null = null;
let hoverIdx: number | null = null;
// DIRT section — an arc [i0→i1] of the 1000-pt path (forward in drawing direction,
// wrap allowed), exactly the rallycross {i0,i1} model. null = all-asphalt track.
let dirt: { i0: number; i1: number } | null = null;
let dirtMode: 0 | 1 | 2 = 0;                       // 0 off · 1 awaiting start · 2 awaiting end
let dirtStart = 0;
// DIRT transition EDGES — 0–2 boundary polylines (one per dirt end, auto-assigned by
// proximity): clicked point by point across the band, connected STRAIGHT.
let dirtEdges: Pt[][] = [];
let dirtEdgeMode = false;
let dirtEdgePts: Pt[] = [];                        // the line being clicked right now
// GRAVEL run-off patches — closed polygons clicked point by point, connected STRAIGHT.
// GRAVEL run-off — FREEHAND strokes with an adjustable brush width (like drawing the
// track). Each committed stroke keeps the brush width it was drawn at.
interface GravelStroke { w: number; pts: Pt[] }
let gravels: GravelStroke[] = [];
let gravelMode = false;
let drawingGravel = false;
let gravelStroke: Pt[] = [];                       // the stroke being drawn right now
let gravelBrush = 70;                              // brush width (sketch units) — the slider
// BILLBOARDS — ad slots (sketch base position + per-board scale). Placed by click,
// moved by drag, sized by the "billboard velikost" slider (adjusts the selected one).
interface BillboardMark { sx: number; sy: number; scale: number }
let billboards: BillboardMark[] = [];
let billboardMode = false;
let billboardScale = 1;                            // scale for NEW boards / the selected one
let selectedBb: number | null = null;
let draggingBb = false;
let bbScaleGesture = false;                        // one undo step per slider gesture
// FINISH — a marked path index (one click); null = auto (derived from the lowest point).
let finishI: number | null = null;
let finishMode = false;
// KERBS — arcs on ONE asphalt edge, each marked with two clicks; the side (left/right
// of travel) is read from where the FIRST click lands relative to the centreline.
let kerbs: AuthoredKerb[] = [];
let kerbMode: 0 | 1 | 2 = 0;
let kerbStart = 0;
let kerbSide: -1 | 1 = 1;
// IDEAL LINE (STOPA) — freehand strokes over the track (sketch units + brush width).
// Render-only in-game: dark rubbered on tarmac, lighter worn tone on dirt.
interface LineStroke { w: number; pts: Pt[] }
let lines: LineStroke[] = [];
let lineMode = false;                              // toggle: draw strokes until switched off
let drawingLine = false;
let lineStroke: Pt[] = [];
const LINE_W_FRAC = 0.30;                          // brush width as a fraction of the band

// derived (computeAll)
let path: Pt[] | null = null;
interface Fit { scale: number; capped: boolean; bcx: number; bcy: number; w: number; h: number; }
let fit: Fit | null = null;
let kerbQuads: AuthoredKerbQuad[] = [];            // shared-builder geometry (sketch units)

// ---- view transform (sketch units → canvas px) ------------------------------------
// With a fitted track this is EXACTLY the game's placement (fit scale + bbox centre
// → screen centre); in the freehand phase it's the band-bound scale, origin 0,0.
interface ViewT { s: number; ox: number; oy: number; }
function viewT(): ViewT {
  const pxPerM = CW / FLAT_LOGICAL.widthM;
  if (path && fit) {
    const s = fit.scale * pxPerM;
    return { s, ox: CW / 2 - fit.bcx * s, oy: CH / 2 - fit.bcy * s };
  }
  return { s: circuitBandScale(band) * pxPerM, ox: 0, oy: 0 };
}

// ---- helpers ----------------------------------------------------------------------
const toCanvasPx = (e: PointerEvent | MouseEvent): [number, number] => {
  const r = cv.getBoundingClientRect();
  return [((e.clientX - r.left) * CW) / r.width, ((e.clientY - r.top) * CH) / r.height];
};
const toSketch = (e: PointerEvent | MouseEvent): Pt => {
  const [px, py] = toCanvasPx(e);
  const { s, ox, oy } = viewT();
  return [(px - ox) / s, (py - oy) / s];
};
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Nearest path index to a sketch point — a dirt click must land ON the ribbon.
function nearestPathIdx(p: Pt): number | null {
  if (!path) return null;
  let bi = 0, bd = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = (path[i][0] - p[0]) ** 2 + (path[i][1] - p[1]) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return Math.sqrt(bd) <= band * 0.75 ? bi : null;
}
// Which dirt end (0 = start i0, 1 = end i1) a boundary line belongs to — the nearer one.
function dirtEdgeEnd(line: Pt[]): 0 | 1 {
  if (!path || !dirt) return 0;
  const ms = line[Math.floor(line.length / 2)];
  const p0 = path[dirt.i0], p1 = path[dirt.i1];
  const dS = (ms[0] - p0[0]) ** 2 + (ms[1] - p0[1]) ** 2;
  const dE = (ms[0] - p1[0]) ** 2 + (ms[1] - p1[1]) ** 2;
  return dS <= dE ? 0 : 1;
}

// The dirt's full ALPHA SHAPE on its own layer: band over the arc (extended past a
// marked end), CUT to each marked boundary polyline (points connected STRAIGHT —
// the boss's spec), clipped to the ribbon. ONE source of truth for the ink tint,
// the mini's dirt paint and both worn-line clips — identical to the map's dirtShape.
function dirtLayer(wPx: number, hPx: number, s: number, ox: number, oy: number): HTMLCanvasElement | null {
  const pth = path, dt = dirt;
  if (!pth || !dt) return null;
  const cvL = document.createElement('canvas');
  cvL.width = wPx; cvL.height = hPx;
  const m = cvL.getContext('2d');
  if (!m) return null;
  const N = pth.length;
  const span = (dt.i1 - dt.i0 + N) % N;
  const d0 = dt.i0;
  let edgeStart: Pt[] | null = null, edgeEnd: Pt[] | null = null;
  let extStart = 0, extEnd = 0;
  const rawNearestIdx = (x: number, y: number): number => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = (pth[i][0] - x) ** 2 + (pth[i][1] - y) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  for (const line of dirtEdges) {
    if (line.length < 2) continue;
    const ms = line[Math.floor(line.length / 2)];
    const li = rawNearestIdx(ms[0], ms[1]);
    if (dirtEdgeEnd(line) === 0) {
      edgeStart = line;
      const back = (dt.i0 - li + N) % N;           // a line BEYOND the start MOVES it out to the line
      extStart = back < N / 2 ? back : 0;
    } else {
      edgeEnd = line;
      const fwd = (li - dt.i1 + N) % N;            // a line BEYOND the end MOVES it out to the line
      extEnd = fwd < N / 2 ? fwd : 0;
    }
  }
  const EXT = 12;                                  // cut margin past the line (path samples)
  const from = edgeStart ? -(extStart + EXT) : 0, to = span + (edgeEnd ? extEnd + EXT : 0);
  m.beginPath();
  for (let n = from; n <= to; n++) {
    const p = pth[((d0 + n) % N + N) % N];
    if (n === from) m.moveTo(ox + p[0] * s, oy + p[1] * s);
    else m.lineTo(ox + p[0] * s, oy + p[1] * s);
  }
  m.lineJoin = 'round'; m.lineCap = 'butt';
  m.lineWidth = band * s;
  m.stroke();
  // The cut is LOCALISED (intersected with the band segment around ITS end, the
  // [winFrom..winTo] index window) — the winding track can bring ANOTHER dirt
  // section close to the line, and an unbounded cut erased it there.
  const cutTo = (lineS: Pt[], backDir: 1 | -1, endIdx: number, winFrom: number, winTo: number): void => {
    const C = document.createElement('canvas');
    C.width = wPx; C.height = hPx;
    const cc = C.getContext('2d');
    if (!cc) return;
    cc.fillStyle = cc.strokeStyle = '#fff';
    const e = lineS.map(([x, y]) => [ox + x * s, oy + y * s] as Pt);
    const reach = band * s;
    const ext = (a: Pt, b: Pt): Pt => {
      const dx = a[0] - b[0], dy = a[1] - b[1];
      const L = Math.hypot(dx, dy) || 1;
      return [a[0] + (dx / L) * reach, a[1] + (dy / L) * reach];
    };
    const poly = [ext(e[0], e[1]), ...e, ext(e[e.length - 1], e[e.length - 2])];
    const bp = pth[((endIdx + backDir * 10) % N + N) % N], ep = pth[((endIdx % N) + N) % N];
    let bx = bp[0] - ep[0], by = bp[1] - ep[1];
    const bl = Math.hypot(bx, by) || 1;
    bx /= bl; by /= bl;
    const BIG = reach * 4;
    cc.beginPath();
    cc.moveTo(poly[0][0], poly[0][1]);
    for (let k = 1; k < poly.length; k++) cc.lineTo(poly[k][0], poly[k][1]);
    cc.lineTo(poly[poly.length - 1][0] + bx * BIG, poly[poly.length - 1][1] + by * BIG);
    cc.lineTo(poly[0][0] + bx * BIG, poly[0][1] + by * BIG);
    cc.closePath();
    cc.fill();
    cc.globalCompositeOperation = 'destination-in';
    cc.beginPath();
    for (let n = winFrom; n <= winTo; n++) {
      const p = pth[((n % N) + N) % N];
      if (n === winFrom) cc.moveTo(ox + p[0] * s, oy + p[1] * s);
      else cc.lineTo(ox + p[0] * s, oy + p[1] * s);
    }
    cc.lineJoin = 'round'; cc.lineCap = 'butt';
    cc.lineWidth = band * s * 1.3;
    cc.stroke();
    cc.globalCompositeOperation = 'source-over';
    m.globalCompositeOperation = 'destination-out';
    m.drawImage(C, 0, 0);
    m.globalCompositeOperation = 'source-over';
  };
  // window OVERSHOOTS the band end by 12 samples — with both butt faces at the same
  // index, AA left a half-erased 1px dirt sliver across the track there
  if (edgeStart) {
    cutTo(edgeStart, -1, ((d0 - extStart) % N + N) % N,
      d0 - extStart - EXT - 12, d0 + 40);
  }
  if (edgeEnd) {
    cutTo(edgeEnd, 1, (d0 + span + extEnd) % N,
      d0 + span - 40, d0 + span + extEnd + EXT + 12);
  }
  m.globalCompositeOperation = 'destination-in';
  traceClosed(m, pth, s, ox, oy);
  m.lineJoin = 'round'; m.lineCap = 'round';
  m.lineWidth = band * s;
  m.stroke();
  m.globalCompositeOperation = 'source-over';
  return cvL;
}

function handleAt(e: PointerEvent | MouseEvent): number | null {
  const [px, py] = toCanvasPx(e);
  const { s, ox, oy } = viewT();
  let best: number | null = null, bd = HIT_PX;
  ctrl.forEach((c, i) => {
    const d = Math.hypot(c[0] * s + ox - px, c[1] * s + oy - py);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

// Ramer–Douglas–Peucker (open polyline — the stroke's start stays a control point).
function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = pts[i0], b = pts[i1];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const ab2 = abx * abx + aby * aby;
    let far = -1, fd = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const t = ab2 > 1e-12 ? Math.max(0, Math.min(1, ((pts[i][0] - a[0]) * abx + (pts[i][1] - a[1]) * aby) / ab2)) : 0;
      const d = Math.hypot(pts[i][0] - a[0] - abx * t, pts[i][1] - a[1] - aby * t);
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([i0, far], [far, i1]); }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

function strokeToCtrl(raw: Pt[]): Pt[] | null {
  let arc = 0;
  for (let i = 1; i < raw.length; i++) arc += dist(raw[i - 1], raw[i]);
  if (raw.length < 8 || arc < 400) return null;    // too short to be a track
  let eps = 13, pts: Pt[] = [];
  for (let tries = 0; tries < 9; tries++) {
    pts = rdp(raw, eps);
    if (pts.length <= MAX_CTRL) break;
    eps *= 1.35;
  }
  // close the loop: the stroke end meets its start — drop a duplicate endpoint
  if (pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 60) pts = pts.slice(0, -1);
  if (pts.length < MIN_CTRL) return null;
  return pts.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt);
}

// ---- derived geometry (the REAL pipeline + the REAL fit maths) --------------------
function computeAll() {
  path = ctrl.length >= MIN_CTRL ? buildCircuitPath(ctrl) : null;
  if (!path) { fit = null; kerbQuads = []; renderStats(); return; }
  kerbQuads = buildAuthoredKerbQuads(path, band, kerbs);
  // TRUE drawn extent: ribbon ± band/2 PLUS every kerb vertex (the circuit's fit lesson)
  const half = band / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const p of path) { acc(p[0] - half, p[1] - half); acc(p[0] + half, p[1] + half); }
  for (const q of kerbQuads) for (const p of q.pts) acc(p[0], p[1]);
  const w = maxX - minX, h = maxY - minY;
  const bandS = circuitBandScale(band);
  const scale = Math.min(bandS,
    (FLAT_LOGICAL.widthM * CIRCUIT_FIT) / w,
    (FLAT_LOGICAL.heightM * CIRCUIT_FIT) / h);
  fit = { scale, capped: scale < bandS - 1e-9, bcx: (minX + maxX) / 2, bcy: (minY + maxY) / 2, w, h };
  renderStats();
}

function pathLenU(): number {
  if (!path) return 0;
  let L = 0;
  for (let i = 0; i < path.length; i++) L += dist(path[i], path[(i + 1) % path.length]);
  return L;
}

// Finish PATH INDEX: the marked one, else derived exactly like the map does it —
// centre of the flatten straight, falling back to the lowest path point.
function finishIdxNow(): number | null {
  if (!path) return null;
  const N = path.length;
  if (finishI !== null) return ((finishI % N) + N) % N;
  const straightY = Math.max(...ctrl.map((p) => p[1]));
  const fx = path.filter((p) => Math.abs(p[1] - straightY) < 1e-6).map((p) => p[0]);
  let tx: number, ty: number;
  if (fx.length >= 2) {
    tx = (Math.min(...fx) + Math.max(...fx)) / 2; ty = straightY;
  } else {
    let lo = 0;
    path.forEach((p, i) => { if (p[1] > path![lo][1]) lo = i; });
    tx = path[lo][0]; ty = path[lo][1];
  }
  let bi = 0, bd = Infinity;
  path.forEach((p, i) => {
    const d = (p[0] - tx) ** 2 + (p[1] - ty) ** 2;
    if (d < bd) { bd = d; bi = i; }
  });
  return bi;
}

// ---- rendering --------------------------------------------------------------------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function traceClosed(m: CanvasRenderingContext2D, pts: Pt[], s: number, ox = 0, oy = 0) {
  m.beginPath();
  m.moveTo(ox + pts[0][0] * s, oy + pts[0][1] * s);
  for (let i = 1; i < pts.length; i++) m.lineTo(ox + pts[i][0] * s, oy + pts[i][1] * s);
  m.closePath();
}

// ink=true → the WHITE drafting canvas (blank paper, black spline at band width);
// ink=false → the true in-game look (real surface painters) for the mini view.
function drawTrack(c: CanvasRenderingContext2D, wPx: number, hPx: number,
  s: number, ox: number, oy: number, pxPerM: number, ink: boolean) {
  if (ink) {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, wPx, hPx);
  } else {
    const rc: SurfaceRC = { wPx, hPx, pxPerM };
    SURFACES.grass.paint(c, (m, r) => { m.fillRect(0, 0, r.wPx, r.hPx); }, rc);
  }
  if (!path) return;
  const pts = path;
  // GRAVEL — freehand swaths UNDER the ribbon (overlap hides beneath it, circuit
  // order): real gravel surface in the game view, flat gravel-base tone on the ink
  // paper. Includes the stroke being drawn right now, at the current brush width.
  const gravelNow: GravelStroke[] = drawingGravel && gravelStroke.length > 1
    ? [...gravels, { w: gravelBrush, pts: gravelStroke }]
    : gravels;
  if (gravelNow.length) {
    const strokeAll = (m: CanvasRenderingContext2D) => {
      m.lineCap = 'round'; m.lineJoin = 'round';
      for (const st of gravelNow) {
        if (st.pts.length < 2) continue;
        m.lineWidth = Math.max(1, st.w * s);
        traceWornPolyline(m, st.pts, ([x2, y2]) => [ox + x2 * s, oy + y2 * s]);
        m.stroke();
      }
    };
    if (ink) {
      c.save();
      c.strokeStyle = `rgb(${GRAVEL_LOOK.base[0]},${GRAVEL_LOOK.base[1]},${GRAVEL_LOOK.base[2]})`;
      strokeAll(c);
      c.restore();
    } else {
      SURFACES.gravel.paint(c, (m) => strokeAll(m), { wPx, hPx, pxPerM });
    }
  }
  if (ink) {
    c.strokeStyle = '#111111';
    traceClosed(c, pts, s, ox, oy);
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.lineWidth = band * s;
    c.stroke();
  } else {
    // Flat lighter tarmac — matches drawAuthoredSurface exactly. NOT SURFACES.asphalt:
    // its image fill is the CIRCUIT's pre-rendered art (kerbs/gravel baked in) and
    // leaks the old track's features through any other ribbon shape.
    c.strokeStyle = '#3b3e44';
    traceClosed(c, pts, s, ox, oy);
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.lineWidth = band * s;
    c.stroke();
  }
  // DIRT — the full alpha shape (band + irregular edge cuts + ribbon clip) from the
  // ONE shared layer builder; the ink view tints it marker-brown, the game view
  // paints the real packed-earth surface through it.
  const dcv = dirtLayer(wPx, hPx, s, ox, oy);
  if (dcv) {
    if (ink) {
      const t = document.createElement('canvas'); t.width = wPx; t.height = hPx;
      const tc = t.getContext('2d');
      if (tc) {
        tc.drawImage(dcv, 0, 0);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = '#8a5a33';                    // marker brown — the mini shows the real tone
        tc.fillRect(0, 0, wPx, hPx);
        c.drawImage(t, 0, 0);
      }
    } else {
      SURFACES.dirt.paint(c, (m) => { m.drawImage(dcv, 0, 0); }, { wPx, hPx, pxPerM });
    }
  }
  // IDEAL LINE (STOPA). Ink view: translucent white (reads on the black band AND the
  // brown dirt). Game view: the map's two passes — dark rubbered clipped to the
  // ribbon, lighter worn tone clipped to the dirt — via scratch layers.
  const allStrokes: LineStroke[] = drawingLine && lineStroke.length > 1
    ? [...lines, { w: Math.round(band * LINE_W_FRAC), pts: lineStroke }]
    : lines;
  if (allStrokes.length) {
    const strokeAll = (m: CanvasRenderingContext2D, tone: string) => {
      m.lineCap = 'round'; m.lineJoin = 'round';
      m.strokeStyle = tone;
      for (const st of allStrokes) {
        if (st.pts.length < 2) continue;
        m.lineWidth = Math.max(1, st.w * s);
        traceWornPolyline(m, st.pts, ([x2, y2]) => [ox + x2 * s, oy + y2 * s]);
        m.stroke();
      }
    };
    if (ink) {
      c.save(); c.globalAlpha = 0.55; strokeAll(c, '#ffffff'); c.restore();
    } else {
      const layer = (tone: string, alpha: number, shapeFn: (m: CanvasRenderingContext2D) => void) => {
        const L = document.createElement('canvas'); L.width = wPx; L.height = hPx;
        const lc = L.getContext('2d');
        const M = document.createElement('canvas'); M.width = wPx; M.height = hPx;
        const mc2 = M.getContext('2d');
        if (!lc || !mc2) return;
        strokeAll(lc, tone);
        mc2.fillStyle = mc2.strokeStyle = '#fff';
        mc2.lineJoin = 'round'; mc2.lineCap = 'round';
        shapeFn(mc2);
        lc.globalCompositeOperation = 'destination-in';
        lc.drawImage(M, 0, 0);
        c.save(); c.globalAlpha = alpha; c.drawImage(L, 0, 0); c.restore();
      };
      // dark rubbered pass — clipped to the ribbon MINUS the dirt shape (the map
      // paints the dark pass under the dirt; here the dirt is already down)
      layer('#181a1e', 0.38, (m) => {
        traceClosed(m, pts, s, ox, oy);
        m.lineCap = 'round'; m.lineWidth = band * s; m.stroke();
        if (dcv) {
          m.globalCompositeOperation = 'destination-out';
          m.drawImage(dcv, 0, 0);
          m.globalCompositeOperation = 'source-over';
        }
      });
      if (dcv) {
        // lighter worn pass — clipped to the exact dirt shape (incl. irregular ends)
        layer(`rgb(${DIRT_LOOK.line[0]},${DIRT_LOOK.line[1]},${DIRT_LOOK.line[2]})`, 1, (m) => {
          m.drawImage(dcv, 0, 0);
        });
      }
    }
  }

  // WHITE EDGE LINES — thin boundary lines along both asphalt edges (shared builder,
  // kerb-aware insets); the kerbs paint OVER their seam right after.
  if (fit) {
    const lineWU = WHITE_LINE_W_M / fit.scale;
    const edgeLines = buildAuthoredEdgeLines(pts, band, kerbs, WHITE_LINE_INSET_M / fit.scale, lineWU);
    c.save();
    c.strokeStyle = 'rgba(238,240,242,0.7)';
    c.lineWidth = Math.max(1, lineWU * s);
    c.lineJoin = 'round';
    for (const line of edgeLines) {
      c.beginPath();
      for (let i = 0; i < line.length; i++) {
        if (i === 0) c.moveTo(ox + line[i][0] * s, oy + line[i][1] * s);
        else c.lineTo(ox + line[i][0] * s, oy + line[i][1] * s);
      }
      c.closePath();
      c.stroke();
    }
    c.restore();
  }

  // KERBS — the shared builder's quads; REAL colours in both views (they ARE the info).
  for (const q of kerbQuads) {
    c.fillStyle = q.fill;
    c.beginPath();
    for (let i = 0; i < 4; i++) {
      const x2 = ox + q.pts[i][0] * s, y2 = oy + q.pts[i][1] * s;
      if (i === 0) c.moveTo(x2, y2); else c.lineTo(x2, y2);
    }
    c.closePath(); c.fill();
  }
  // START/FINISH — one plain white line across the local travel direction (circuit
  // style, replaces the old checker) + the car-for-scale facing the travel direction.
  const fIdx = finishIdxNow();
  if (fIdx !== null) {
    const N = pts.length;
    const a = pts[((fIdx - 4) % N + N) % N], b2 = pts[(fIdx + 4) % N];
    const fwd = Math.atan2(b2[1] - a[1], b2[0] - a[0]);
    const f = pts[fIdx];
    const fx = ox + f[0] * s, fy = oy + f[1] * s;
    const qx = Math.cos(fwd + Math.PI / 2), qy = Math.sin(fwd + Math.PI / 2);
    const half2 = (band / 2) * s;
    c.save();
    c.strokeStyle = ink ? '#f2f2f6' : 'rgba(238,240,242,0.7)';
    c.lineWidth = fit ? Math.max(1.5, (0.34 / fit.scale) * s) : 2;
    c.lineCap = 'butt';
    c.beginPath();
    c.moveTo(fx - qx * half2, fy - qy * half2);
    c.lineTo(fx + qx * half2, fy + qy * half2);
    c.stroke();
    if (fit) {
      const carL = (CAR_LEN_M / fit.scale) * s, carW = carL / 2.4;
      c.translate(fx - Math.cos(fwd) * carL * 0.9, fy - Math.sin(fwd) * carL * 0.9);
      c.rotate(fwd);
      c.fillStyle = 'rgba(244,244,248,0.95)';
      c.strokeStyle = 'rgba(20,20,24,0.7)'; c.lineWidth = 1;
      c.beginPath();
      (c as CanvasRenderingContext2D & { roundRect(x: number, y: number, w: number, h: number, r: number): void })
        .roundRect(-carL / 2, -carW / 2, carL, carW, carW * 0.3);
      c.fill(); c.stroke();
      c.fillStyle = 'rgba(40,44,54,0.9)';                       // windscreen hint
      c.fillRect(carL * 0.08, -carW * 0.32, carL * 0.18, carW * 0.64);
    }
    c.restore();
  }

  // BILLBOARDS — drawn LAST (topmost, as they occlude cars in game): shadow then body,
  // at true metre scale. The selected board gets a dashed highlight (ink view only) so
  // the "billboard velikost" slider clearly targets it.
  if (billboards.length) {
    const pxM = wPx / FLAT_LOGICAL.widthM;
    billboards.forEach((b, i) => {
      const cx = ox + b.sx * s, cy = oy + b.sy * s;
      drawBillboardShadow(c, cx, cy, pxM * b.scale);
      drawBillboardBody(c, cx, cy, pxM * b.scale);
      if (ink && i === selectedBb) {
        const halfW = (BILLBOARD_DIMS.W_M / 2) * b.scale * pxM;
        const postH = BILLBOARD_DIMS.POST_H_M * b.scale * pxM;
        const boardH = BILLBOARD_DIMS.BOARD_H_M * b.scale * pxM;
        c.save();
        c.setLineDash([6, 4]); c.strokeStyle = '#ffd27a'; c.lineWidth = 2;
        c.strokeRect(cx - halfW - 4, cy - postH - boardH - 4, halfW * 2 + 8, postH + boardH + 10);
        c.setLineDash([]); c.restore();
      }
    });
  }
}

// Index of the billboard whose footprint (panel + posts + base) contains sketch point p.
function billboardAt(p: Pt): number | null {
  if (!fit) return null;
  const mPerS = fit.scale;   // metres per sketch unit
  for (let i = billboards.length - 1; i >= 0; i--) {
    const b = billboards[i];
    const halfW = (BILLBOARD_DIMS.W_M / 2) * b.scale / mPerS;
    const postH = BILLBOARD_DIMS.POST_H_M * b.scale / mPerS;
    const boardH = BILLBOARD_DIMS.BOARD_H_M * b.scale / mPerS;
    if (p[0] >= b.sx - halfW && p[0] <= b.sx + halfW && p[1] >= b.sy - postH - boardH && p[1] <= b.sy + 8) return i;
  }
  return null;
}

function render() {
  const c = cv.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, CW, CH);
  const vt = viewT();
  drawTrack(c, CW, CH, vt.s, vt.ox, vt.oy, 1, true);

  if (!path && stroke.length > 1) {                // draw mode: the raw stroke at band width
    c.strokeStyle = '#111111';
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.lineWidth = band * vt.s;
    c.beginPath(); c.moveTo(vt.ox + stroke[0][0] * vt.s, vt.oy + stroke[0][1] * vt.s);
    for (let i = 1; i < stroke.length; i++) c.lineTo(vt.ox + stroke[i][0] * vt.s, vt.oy + stroke[i][1] * vt.s);
    c.stroke();
  }

  if (dirtMode === 2 && path) {                    // dirt start marker while awaiting the end click
    const p = path[dirtStart];
    c.beginPath(); c.arc(vt.ox + p[0] * vt.s, vt.oy + p[1] * vt.s, 9, 0, Math.PI * 2);
    c.fillStyle = '#8a5a33'; c.fill();
    c.lineWidth = 2; c.strokeStyle = '#ffffff'; c.stroke();
  }
  if (kerbMode === 2 && path) {                    // kerb start marker (red = kerb colour)
    const p = path[kerbStart];
    c.beginPath(); c.arc(vt.ox + p[0] * vt.s, vt.oy + p[1] * vt.s, 9, 0, Math.PI * 2);
    c.fillStyle = '#c9382f'; c.fill();
    c.lineWidth = 2; c.strokeStyle = '#ffffff'; c.stroke();
  }
  // (the gravel stroke being drawn is rendered live inside the gravel layer above.)
  // Dirt boundary markers: committed lines show ONLY in OKRAJ DIRTU mode (they're
  // deletion targets there) — outside the mode the cut itself is the visual truth,
  // and the dashed overlays read as stray brown lines on the dirt (boss's report).
  if ((dirtEdgeMode && dirtEdges.length) || dirtEdgePts.length) {
    c.save();
    c.setLineDash([5, 4]);
    const poly = (line: Pt[]) => {
      c.beginPath();
      c.moveTo(vt.ox + line[0][0] * vt.s, vt.oy + line[0][1] * vt.s);
      for (let i = 1; i < line.length; i++) c.lineTo(vt.ox + line[i][0] * vt.s, vt.oy + line[i][1] * vt.s);
      c.stroke();
    };
    if (dirtEdgeMode) {
      c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1.5;
      for (const line of dirtEdges) if (line.length > 1) poly(line);
    }
    c.setLineDash([]);
    if (dirtEdgePts.length) {
      if (dirtEdgePts.length > 1) {
        c.setLineDash([5, 4]);
        c.strokeStyle = '#8a5a33'; c.lineWidth = 2;
        poly(dirtEdgePts);
        c.setLineDash([]);
      }
      for (const p of dirtEdgePts) {
        c.beginPath(); c.arc(vt.ox + p[0] * vt.s, vt.oy + p[1] * vt.s, 6, 0, Math.PI * 2);
        c.fillStyle = '#8a5a33'; c.fill();
        c.lineWidth = 2; c.strokeStyle = '#ffffff'; c.stroke();
      }
    }
    c.restore();
  }

  if (ctrl.length) {                               // finish-straight guide + control overlay
    const straightY = Math.max(...ctrl.map((p) => p[1]));
    c.strokeStyle = 'rgba(0,0,0,0.30)'; c.lineWidth = 1; c.setLineDash([6, 6]);
    c.beginPath(); c.moveTo(0, vt.oy + straightY * vt.s); c.lineTo(CW, vt.oy + straightY * vt.s); c.stroke();
    c.setLineDash([4, 5]); c.strokeStyle = 'rgba(0,0,0,0.40)'; c.lineWidth = 1.2;
    traceClosed(c, ctrl, vt.s, vt.ox, vt.oy); c.stroke();
    c.setLineDash([]);
    ctrl.forEach((p, i) => {                       // black points, white ring so they read on the band too
      c.beginPath(); c.arc(vt.ox + p[0] * vt.s, vt.oy + p[1] * vt.s, i === hoverIdx ? 10 : 8, 0, Math.PI * 2);
      c.fillStyle = '#000000';
      c.fill();
      c.lineWidth = 2; c.strokeStyle = '#ffffff'; c.stroke();
    });
  }

  // ---- mini in-game view (whole screen, true fit + centring like drawCircuitSurface)
  const mc = miniCv.getContext('2d')!;
  mc.setTransform(1, 0, 0, 1, 0, 0);
  mc.clearRect(0, 0, MINI_W, MINI_H);
  const miniPxPerM = MINI_W / FLAT_LOGICAL.widthM;
  if (path && fit) {
    const s2 = fit.scale * miniPxPerM;
    drawTrack(mc, MINI_W, MINI_H, s2, MINI_W / 2 - fit.bcx * s2, MINI_H / 2 - fit.bcy * s2, miniPxPerM, false);
  } else {
    SURFACES.grass.paint(mc, (m, r) => { m.fillRect(0, 0, r.wPx, r.hPx); }, { wPx: MINI_W, hPx: MINI_H, pxPerM: miniPxPerM });
  }
}

function renderStats() {
  widthOutEl.textContent = fit ? `${band} u ≈ ${(fit.scale * band).toFixed(1)} m` : `${band} u`;
  gravelWidthOutEl.textContent = fit ? `${gravelBrush} u ≈ ${(fit.scale * gravelBrush).toFixed(1)} m` : `${gravelBrush} u`;
  bbWidthOutEl.textContent = fit ? `${Math.round(billboardScale * 100)} % ≈ ${(BILLBOARD_DIMS.W_M * billboardScale).toFixed(0)} m` : `${Math.round(billboardScale * 100)} %`;
  if (!path || !fit) { statsEl.innerHTML = ''; return; }
  const fillW = (fit.w * fit.scale) / FLAT_LOGICAL.widthM;
  const fillH = (fit.h * fit.scale) / FLAT_LOGICAL.heightM;
  const rows: Array<[string, string]> = [
    ['šířka tratě', `${(fit.scale * band).toFixed(1)} m`],
    ['délka okruhu', `${Math.round(pathLenU() * fit.scale)} m`],
    ['kontrolní body', `${ctrl.length}`],
    ['zaplnění obrazovky', `${Math.round(Math.max(fillW, fillH) * 100)} %`],
    ['cílovka', finishI !== null ? `označená (bod ${finishI})` : 'auto (nejnižší bod kresby)'],
    ['kerby', String(kerbs.length)],
  ];
  statsEl.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')
    + (fit.capped
      ? '<div class="warn">⚠ trať přesahuje obrazovku → hra ji ZMENŠÍ (auto pak vyjde menší). Zmenši layout nebo rozšiř band.</div>'
      : '<div class="ok">✓ band-bound — auto má standardní velikost</div>');
}

// ---- UNDO history -----------------------------------------------------------------
// A snapshot of the authored state is pushed BEFORE every mutation (drag start, point
// add/delete, stroke fit, band gesture, dirt/finish/kerb marking, import, new track),
// so ZPĚT / Ctrl+Z walks back change by change. Capped at 100 steps.
interface Snapshot {
  ctrl: Pt[]; band: number; dirt: { i0: number; i1: number } | null;
  finishI: number | null; kerbs: AuthoredKerb[]; lines: LineStroke[]; dirtEdges: Pt[][];
  gravels: GravelStroke[]; billboards: BillboardMark[];
}
const history: Snapshot[] = [];
let bandGesture = false;                           // one history entry per slider gesture

function snap(): Snapshot {
  return {
    ctrl: ctrl.map(([x, y]) => [x, y] as Pt),
    band,
    dirt: dirt ? { ...dirt } : null,
    finishI,
    kerbs: kerbs.map((k) => ({ ...k })),
    lines: lines.map((st) => ({ w: st.w, pts: st.pts.map(([x, y]) => [x, y] as Pt) })),
    dirtEdges: dirtEdges.map((l) => l.map(([x, y]) => [x, y] as Pt)),
    gravels: gravels.map((st) => ({ w: st.w, pts: st.pts.map(([x, y]) => [x, y] as Pt) })),
    billboards: billboards.map((b) => ({ ...b })),
  };
}
function pushHistory() {
  history.push(snap());
  if (history.length > 100) history.shift();
}
// A drag that didn't move (a plain click on a point) leaves a no-op snapshot — drop it
// so ZPĚT never needs a dead press.
function dropNoopHistoryTop() {
  const top = history[history.length - 1];
  if (top && JSON.stringify(top) === JSON.stringify(snap())) history.pop();
}
// Leave every marking mode (buttons, cursors, half-finished clicks) — shared by the
// mode buttons, undo, import and NEW so modes can never overlap or leak.
function resetMarkModes() {
  finishMode = false; kerbMode = 0; dirtMode = 0;
  lineMode = false; drawingLine = false; lineStroke = [];
  dirtEdgeMode = false; dirtEdgePts = [];
  gravelMode = false; drawingGravel = false; gravelStroke = [];
  billboardMode = false; draggingBb = false; selectedBb = null;
  document.getElementById('line')!.classList.remove('active');
  document.getElementById('dirtedge')!.classList.remove('active');
  document.getElementById('gravel')!.classList.remove('active');
  document.getElementById('billboard')!.classList.remove('active');
}

function undo() {
  const s = history.pop();
  if (!s) { setStatus('ZPĚT: žádná další změna v historii.'); return; }
  ctrl = s.ctrl; band = s.band; dirt = s.dirt; finishI = s.finishI; kerbs = s.kerbs; lines = s.lines;
  dirtEdges = s.dirtEdges; gravels = s.gravels; billboards = s.billboards;
  widthEl.value = String(band);
  resetMarkModes();
  dragIdx = null; hoverIdx = null; stroke = []; drawing = false;
  cv.style.cursor = ctrl.length ? 'default' : 'crosshair';
  save(); refresh();
  setStatus(`ZPĚT ✓ (v historii zbývá ${history.length}). ` + HINT_EDIT);
}

// ---- persistence + export ---------------------------------------------------------
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, ctrl, band, dirt, finishI, kerbs, lines, dirtEdges, gravels, gravelBrush, billboards, billboardScale })); } catch { /* dev tool */ }
}
function restore(): boolean {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw) as {
      v: number; ctrl: Pt[]; band: number; dirt?: { i0: number; i1: number } | null;
      finishI?: number | null; kerbs?: AuthoredKerb[]; lines?: LineStroke[]; dirtEdges?: Pt[][];
      gravels?: GravelStroke[]; gravelBrush?: number;
      billboards?: BillboardMark[]; billboardScale?: number;
    };
    if (d.v !== 1 || !Array.isArray(d.ctrl) || d.ctrl.length < MIN_CTRL) return false;
    ctrl = d.ctrl.map(([x, y]) => [x, y] as Pt);
    band = typeof d.band === 'number' ? d.band : 124;
    dirt = d.dirt && typeof d.dirt.i0 === 'number' && typeof d.dirt.i1 === 'number'
      ? { i0: d.dirt.i0, i1: d.dirt.i1 } : null;
    finishI = typeof d.finishI === 'number' ? d.finishI : null;
    kerbs = Array.isArray(d.kerbs)
      ? d.kerbs.filter((k) => k && typeof k.i0 === 'number' && typeof k.i1 === 'number')
          .map((k) => ({ i0: k.i0, i1: k.i1, side: k.side === -1 ? -1 : 1 } as AuthoredKerb))
      : [];
    lines = Array.isArray(d.lines)
      ? d.lines.filter((st) => st && typeof st.w === 'number' && Array.isArray(st.pts) && st.pts.length >= 2)
          .map((st) => ({ w: st.w, pts: st.pts.map(([x, y]) => [x, y] as Pt) }))
      : [];
    dirtEdges = Array.isArray(d.dirtEdges)
      ? d.dirtEdges.filter((l) => Array.isArray(l) && l.length >= 2)
          .map((l) => l.map(([x, y]) => [x, y] as Pt))
      : [];
    gravels = Array.isArray(d.gravels)
      ? d.gravels.filter((st) => st && typeof st.w === 'number' && Array.isArray(st.pts) && st.pts.length >= 2)
          .map((st) => ({ w: st.w, pts: st.pts.map(([x, y]) => [x, y] as Pt) }))
      : [];
    if (typeof d.gravelBrush === 'number') gravelBrush = d.gravelBrush;
    gravelWidthEl.value = String(gravelBrush);
    billboards = Array.isArray(d.billboards)
      ? d.billboards.filter((b) => b && typeof b.sx === 'number' && typeof b.sy === 'number')
          .map((b) => ({ sx: b.sx, sy: b.sy, scale: typeof b.scale === 'number' ? b.scale : 1 }))
      : [];
    if (typeof d.billboardScale === 'number') billboardScale = d.billboardScale;
    bbWidthEl.value = String(Math.round(billboardScale * 100));
    widthEl.value = String(band);
    return true;
  } catch { return false; }
}

function exportText(): string {
  const pts = ctrl.map(([x, y]) => `[${x},${y}]`);
  const ptLines: string[] = [];
  for (let i = 0; i < pts.length; i += 7) ptLines.push('  ' + pts.slice(i, i + 7).join(',') + ',');
  const wM = fit ? (fit.scale * band).toFixed(1) : '?';
  const lM = fit ? String(Math.round(pathLenU() * fit.scale)) : '?';
  const dirtLine = dirt
    ? `const AUTHORED_DIRT: { i0: number; i1: number } | null = { i0: ${dirt.i0}, i1: ${dirt.i1} };`
    : 'const AUTHORED_DIRT: { i0: number; i1: number } | null = null;';
  const edgeLines = dirtEdges.length
    ? [
        'const AUTHORED_DIRT_EDGES: Array<Array<[number, number]>> = [',
        ...dirtEdges.map((l) => `  [${l.map(([x, y]) => `[${x},${y}]`).join(',')}],`),
        '];',
      ]
    : ['const AUTHORED_DIRT_EDGES: Array<Array<[number, number]>> = [];'];
  const gravelLines = gravels.length
    ? [
        'const AUTHORED_GRAVEL: Array<{ w: number; pts: Array<[number, number]> }> = [',
        ...gravels.map((st) => `  { w: ${st.w}, pts: [${st.pts.map(([x, y]) => `[${x},${y}]`).join(',')}] },`),
        '];',
      ]
    : ['const AUTHORED_GRAVEL: Array<{ w: number; pts: Array<[number, number]> }> = [];'];
  const bbLines = billboards.length
    ? [
        'const AUTHORED_BILLBOARDS: Array<{ sx: number; sy: number; scale: number; ad?: AdSlot }> = [',
        ...billboards.map((b) => `  { sx: ${b.sx}, sy: ${b.sy}, scale: ${+b.scale.toFixed(2)} },`),
        '];',
      ]
    : ['const AUTHORED_BILLBOARDS: Array<{ sx: number; sy: number; scale: number; ad?: AdSlot }> = [];'];
  const finishLine = `const AUTHORED_FINISH_I: number | null = ${finishI !== null ? finishI : 'null'};`;
  const lineLines = lines.length
    ? [
        'const AUTHORED_LINE: Array<{ w: number; pts: Array<[number, number]> }> = [',
        ...lines.map((st) => `  { w: ${st.w}, pts: [${st.pts.map(([x, y]) => `[${x},${y}]`).join(',')}] },`),
        '];',
      ]
    : ['const AUTHORED_LINE: Array<{ w: number; pts: Array<[number, number]> }> = [];'];
  const kerbLines = kerbs.length
    ? [
        'const AUTHORED_KERBS: AuthoredKerb[] = [',
        ...kerbs.map((k) => `  { i0: ${k.i0}, i1: ${k.i1}, side: ${k.side} },`),
        '];',
      ]
    : ['const AUTHORED_KERBS: AuthoredKerb[] = [];'];
  return [
    '// ── Track authored in the Steer It track editor (track-editor.html) ──────────',
    '// Sketch units are arbitrary — the game re-fits via the bbox+band scale, so only',
    '// proportions matter. REPLACES AUTHORED_SKETCH + AUTHORED_BAND + AUTHORED_DIRT',
    '// in maps.ts (Circuit II). Dirt = path-index arc i0→i1, forward, wrap allowed.',
    `// track width ≈ ${wM} m · lap length ≈ ${lM} m · ${ctrl.length} control points`,
    'const AUTHORED_SKETCH: Array<[number, number]> = [',
    ...ptLines,
    '];',
    `const AUTHORED_BAND = ${band};`,
    dirtLine,
    ...edgeLines,
    ...gravelLines,
    ...bbLines,
    finishLine,
    ...kerbLines,
    ...lineLines,
    '',
  ].join('\n');
}

// ---- interactions -----------------------------------------------------------------
function setStatus(t: string) { statusEl.textContent = t; }
const HINT_EDIT = 'Táhni body · dvojklik na čáru = přidat bod · pravý klik na bod = smazat · šířka sliderem.';

function refresh() { computeAll(); scheduleRender(); }

cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = toSketch(e);
  if (billboardMode) {                             // BILLBOARD: select+drag an existing one, else place a new one
    pushHistory();
    const hit = billboardAt(p);
    if (hit !== null) {
      selectedBb = hit;
      billboardScale = billboards[hit].scale;
      bbWidthEl.value = String(Math.round(billboardScale * 100));
    } else {
      billboards.push({ sx: Math.round(p[0]), sy: Math.round(p[1]), scale: billboardScale });
      selectedBb = billboards.length - 1;
    }
    draggingBb = true;
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    renderStats(); scheduleRender();
    setStatus(`BILLBOARD: táhni = přemísti · slider „billboard velikost" = velikost · pravý klik = smazat. (${billboards.length} celkem)`);
    return;
  }
  if (dirtEdgeMode) {                              // OKRAJ DIRTU: collect boundary points
    dirtEdgePts.push([Math.round(p[0]), Math.round(p[1])]);
    scheduleRender();
    setStatus(`OKRAJ DIRTU: ${dirtEdgePts.length} bodů — dvojklik = hotovo, pravý klik = zrušit.`);
    return;
  }
  if (gravelMode) {                                // GRAVEL: freehand swath over the map
    drawingGravel = true; gravelStroke = [p];
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    return;
  }
  if (lineMode && path) {                          // STOPA: freehand stroke over the track
    drawingLine = true; lineStroke = [p];
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    return;
  }
  if (finishMode) {                                // one click on the ribbon = the finish
    const idx = nearestPathIdx(p);
    if (idx === null) { setStatus('CÍL: klikni PŘÍMO na trať.'); return; }
    pushHistory();
    finishI = idx; finishMode = false;
    cv.style.cursor = 'default';
    save(); refresh();
    setStatus('Cílovka označena ✓ — ' + HINT_EDIT);
    return;
  }
  if (kerbMode) {                                  // two clicks on ONE asphalt edge
    const idx = nearestPathIdx(p);
    if (idx === null || !path) { setStatus('KERB: klikni na OKRAJ asfaltu (na trať).'); return; }
    if (kerbMode === 1) {
      kerbStart = idx;
      const N = path.length;
      const a = path[((idx - 2) % N + N) % N], b = path[(idx + 2) % N];
      const tx = b[0] - a[0], ty = b[1] - a[1];
      // which side of the centreline the click landed on = the kerb's edge
      kerbSide = (-ty * (p[0] - path[idx][0]) + tx * (p[1] - path[idx][1])) >= 0 ? 1 : -1;
      kerbMode = 2;
      setStatus('KERB: …a teď klikni na KONEC kerbu (po směru kreslení, stejný okraj).');
      scheduleRender();
    } else {
      pushHistory();
      kerbs.push({ i0: kerbStart, i1: idx, side: kerbSide });
      kerbMode = 0;
      cv.style.cursor = 'default';
      save(); refresh();
      setStatus(`Kerb přidán ✓ (celkem ${kerbs.length}) — ` + HINT_EDIT);
    }
    return;
  }
  if (dirtMode) {                                  // dirt marking eats clicks (no point drag)
    const idx = nearestPathIdx(p);
    if (idx === null) { setStatus('DIRT: klikni PŘÍMO na trať.'); return; }
    if (dirtMode === 1) {
      dirtStart = idx; dirtMode = 2;
      setStatus('DIRT: …a teď klikni na KONEC úseku (vede od začátku PO SMĚRU kreslení). Pravý klik = smazat dirt.');
      scheduleRender();
    } else {
      pushHistory();
      dirt = { i0: dirtStart, i1: idx };
      dirtMode = 0;
      cv.style.cursor = 'default';
      save(); refresh();
      setStatus('Dirt úsek nastaven ✓ — ' + HINT_EDIT);
    }
    return;
  }
  if (!ctrl.length) {
    drawing = true; stroke = [p];
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    return;
  }
  const hi = handleAt(e);
  if (hi !== null) {
    pushHistory();                                 // drag start (a no-move click is dropped on release)
    dragIdx = hi;
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  }
});

cv.addEventListener('pointermove', (e) => {
  const p = toSketch(e);
  if (draggingBb && selectedBb !== null) {         // move the selected billboard's base
    billboards[selectedBb] = { ...billboards[selectedBb], sx: Math.round(p[0]), sy: Math.round(p[1]) };
    scheduleRender();
    return;
  }
  if (drawingGravel) {
    if (dist(gravelStroke[gravelStroke.length - 1], p) > 2.5) { gravelStroke.push(p); scheduleRender(); }
    return;
  }
  if (drawingLine) {
    if (dist(lineStroke[lineStroke.length - 1], p) > 2.5) { lineStroke.push(p); scheduleRender(); }
    return;
  }
  if (drawing) {
    if (dist(stroke[stroke.length - 1], p) > 2.5) { stroke.push(p); scheduleRender(); }
    return;
  }
  if (dragIdx !== null) {
    ctrl[dragIdx] = [Math.round(p[0]), Math.round(p[1])];
    refresh();
    return;
  }
  if (billboardMode) { cv.style.cursor = billboardAt(p) !== null ? 'grab' : 'crosshair'; return; }
  if (dirtMode || kerbMode || finishMode || dirtEdgeMode || gravelMode) { cv.style.cursor = 'crosshair'; return; }
  const hi = handleAt(e);
  if (hi !== hoverIdx) { hoverIdx = hi; cv.style.cursor = hi !== null ? 'grab' : (ctrl.length ? 'default' : 'crosshair'); scheduleRender(); }
});

function endPointer() {
  if (draggingBb) { draggingBb = false; dropNoopHistoryTop(); save(); return; }
  if (drawingGravel) {
    drawingGravel = false;
    if (gravelStroke.length >= 2) {
      pushHistory();
      gravels.push({ w: Math.round(gravelBrush), pts: gravelStroke.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt) });
      save();
      setStatus(`GRAVEL: štěrk přidán ✓ (${gravels.length} tahů). Kresli dál, pravý klik = smazat poslední, GRAVEL tlačítko = konec.`);
    }
    gravelStroke = [];
    refresh();
    return;
  }
  if (drawingLine) {
    drawingLine = false;
    if (lineStroke.length >= 2) {
      pushHistory();
      lines.push({ w: Math.round(band * LINE_W_FRAC), pts: lineStroke.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt) });
      save();
      setStatus(`STOPA: tah přidán ✓ (${lines.length} tahů). Další tah, pravý klik = smazat poslední, STOPA tlačítko = konec.`);
    }
    lineStroke = [];
    refresh();
    return;
  }
  if (drawing) {
    drawing = false;
    const fitCtrl = strokeToCtrl(stroke);
    stroke = [];
    if (fitCtrl) {
      pushHistory();
      ctrl = fitCtrl;
      save();
      setStatus(HINT_EDIT);
    } else {
      setStatus('Moc krátký tah — nakresli celý okruh jedním tahem.');
    }
    refresh();
    return;
  }
  if (dragIdx !== null) { dragIdx = null; dropNoopHistoryTop(); save(); }
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);

cv.addEventListener('dblclick', (e) => {
  if (dirtEdgeMode) {                              // dblclick = commit the boundary line
    // the double-click's two pointerdowns appended duplicate tail points — drop them
    while (dirtEdgePts.length >= 2 && dist(dirtEdgePts[dirtEdgePts.length - 1], dirtEdgePts[dirtEdgePts.length - 2]) < 3) {
      dirtEdgePts.pop();
    }
    if (dirtEdgePts.length >= 2 && dirt) {
      pushHistory();
      const myEnd = dirtEdgeEnd(dirtEdgePts);
      dirtEdges = dirtEdges.filter((l) => dirtEdgeEnd(l) !== myEnd);   // one line per end
      dirtEdges.push(dirtEdgePts.map(([x, y]) => [x, y] as Pt));
      dirtEdgePts = [];
      save(); refresh();
      setStatus(`OKRAJ DIRTU: hranice ${myEnd === 0 ? 'ZAČÁTKU' : 'KONCE'} dirtu uložena ✓. Označ druhý konec, nebo režim vypni tlačítkem.`);
    } else {
      dirtEdgePts = [];
      scheduleRender();
      setStatus('OKRAJ DIRTU: potřebuju aspoň 2 body — klikej přes trať a pak dvojklik.');
    }
    return;
  }
  if (gravelMode) return;                          // gravel is freehand — dblclick does nothing
  if (!ctrl.length) return;
  const p = toSketch(e);
  if (handleAt(e) !== null) return;                // double-click ON a point does nothing
  // insert on the nearest control-polygon segment
  let bi = 0, bd = Infinity;
  for (let i = 0; i < ctrl.length; i++) {
    const a = ctrl[i], b = ctrl[(i + 1) % ctrl.length];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const ab2 = abx * abx + aby * aby;
    const t = ab2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / ab2)) : 0;
    const d = Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
    if (d < bd) { bd = d; bi = i; }
  }
  pushHistory();
  ctrl.splice(bi + 1, 0, [Math.round(p[0]), Math.round(p[1])]);
  save(); refresh();
});

cv.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (billboardMode) {                             // right-click on a billboard = delete it (else exit)
    const hit = billboardAt(toSketch(e));
    if (hit !== null) {
      pushHistory();
      billboards.splice(hit, 1);
      selectedBb = null;
      save(); refresh();
      setStatus(`BILLBOARD: smazán (${billboards.length} zbývá).`);
    } else {
      resetMarkModes();
      cv.style.cursor = 'default';
      scheduleRender();
      setStatus('BILLBOARD: režim ukončen. ' + HINT_EDIT);
    }
    return;
  }
  if (gravelMode) {                                // right-click = delete the last swath (else exit)
    if (gravels.length) {
      pushHistory();
      gravels.pop();
      save(); refresh();
      setStatus(`GRAVEL: poslední tah smazán (${gravels.length} zbývá).`);
    } else {
      resetMarkModes();
      cv.style.cursor = 'default';
      scheduleRender();
      setStatus('GRAVEL: režim ukončen. ' + HINT_EDIT);
    }
    return;
  }
  if (dirtEdgeMode) {
    if (dirtEdgePts.length) {                      // discard the half-clicked line
      dirtEdgePts = [];
      scheduleRender();
      setStatus('OKRAJ DIRTU: rozklikaná čára zrušena.');
    } else if (dirtEdges.length) {                 // delete the boundary nearest the click
      pushHistory();
      const pcl = toSketch(e);
      let bi = 0, bd = Infinity;
      dirtEdges.forEach((l, i) => {
        const ms = l[Math.floor(l.length / 2)];
        const d = (ms[0] - pcl[0]) ** 2 + (ms[1] - pcl[1]) ** 2;
        if (d < bd) { bd = d; bi = i; }
      });
      dirtEdges.splice(bi, 1);
      save(); refresh();
      setStatus(`OKRAJ DIRTU: hranice smazána (${dirtEdges.length} zbývá).`);
    } else {
      resetMarkModes();
      cv.style.cursor = 'default';
      scheduleRender();
      setStatus('OKRAJ DIRTU: režim ukončen. ' + HINT_EDIT);
    }
    return;
  }
  if (lineMode) {                                  // right-click in STOPA mode = delete the last stroke
    if (lines.length) {
      pushHistory();
      lines.pop();
      save(); refresh();
      setStatus(`STOPA: poslední tah smazán (${lines.length} zbývá).`);
    } else {
      lineMode = false;
      cv.style.cursor = 'default';
      setStatus('STOPA: režim ukončen. ' + HINT_EDIT);
    }
    return;
  }
  if (finishMode) {                                // right-click in CÍL mode = back to auto
    if (finishI !== null) pushHistory();
    finishI = null; finishMode = false;
    cv.style.cursor = 'default';
    save(); refresh();
    setStatus('Cílovka vrácena na AUTO (nejnižší bod kresby). ' + HINT_EDIT);
    return;
  }
  if (kerbMode) {                                  // right-click while marking a kerb = cancel
    kerbMode = 0;
    cv.style.cursor = 'default';
    scheduleRender();
    setStatus('KERB: označování zrušeno. ' + HINT_EDIT);
    return;
  }
  if (dirtMode) {                                  // right-click while marking = remove the dirt
    if (dirt !== null) pushHistory();
    dirt = null; dirtMode = 0;
    cv.style.cursor = 'default';
    save(); refresh();
    setStatus('Dirt smazán — trať je celá asfalt. ' + HINT_EDIT);
    return;
  }
  if (!ctrl.length) return;
  const hi = handleAt(e);
  if (hi === null) {
    // no control point under the cursor — right-click ON a kerb arc deletes that kerb
    const idx = nearestPathIdx(toSketch(e));
    if (idx !== null && path) {
      const N = path.length;
      const ki = kerbs.findIndex((k) => ((idx - k.i0 + N) % N) <= ((k.i1 - k.i0 + N) % N));
      if (ki >= 0) {
        pushHistory();
        kerbs.splice(ki, 1);
        save(); refresh();
        setStatus(`Kerb smazán (zbývá ${kerbs.length}). ` + HINT_EDIT);
      }
    }
    return;
  }
  if (ctrl.length <= MIN_CTRL) { setStatus(`Minimum je ${MIN_CTRL} body — míň by nebyl okruh.`); return; }
  pushHistory();
  ctrl.splice(hi, 1);
  hoverIdx = null;
  save(); refresh();
});

gravelWidthEl.addEventListener('input', () => {
  gravelBrush = Number(gravelWidthEl.value);
  renderStats();
  if (gravelMode) scheduleRender();                // live-preview the new brush width
});

bbWidthEl.addEventListener('input', () => {
  billboardScale = Number(bbWidthEl.value) / 100;
  if (selectedBb !== null && billboards[selectedBb]) {
    if (!bbScaleGesture) { bbScaleGesture = true; pushHistory(); }   // one undo step per gesture
    billboards[selectedBb] = { ...billboards[selectedBb], scale: billboardScale };
  }
  renderStats(); scheduleRender();
});
bbWidthEl.addEventListener('change', () => { bbScaleGesture = false; save(); });

widthEl.addEventListener('input', () => {
  if (!bandGesture) { bandGesture = true; pushHistory(); }   // one undo step per slider gesture
  band = Number(widthEl.value);
  refresh();
});
widthEl.addEventListener('change', () => { bandGesture = false; save(); });

document.getElementById('undo')!.addEventListener('click', undo);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    // leave the textarea's/input's own native undo alone
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    undo();
  }
});

document.getElementById('line')!.addEventListener('click', () => {
  if (!path) { setStatus('STOPA: nejdřív nakresli trať.'); return; }
  const on = !lineMode;
  resetMarkModes();
  lineMode = on;
  document.getElementById('line')!.classList.toggle('active', lineMode);
  cv.style.cursor = lineMode ? 'crosshair' : 'default';
  setStatus(lineMode
    ? 'STOPA: kresli ideální stopu volnou rukou přes trať (klidně víc tahů). Pravý klik = smazat poslední tah, STOPA tlačítko = konec.'
    : 'STOPA: režim ukončen. ' + HINT_EDIT);
});

document.getElementById('dirtedge')!.addEventListener('click', () => {
  if (!path) { setStatus('OKRAJ DIRTU: nejdřív nakresli trať.'); return; }
  if (!dirt) { setStatus('OKRAJ DIRTU: nejdřív vyznač DIRT úsek.'); return; }
  const on = !dirtEdgeMode;
  resetMarkModes();
  dirtEdgeMode = on;
  document.getElementById('dirtedge')!.classList.toggle('active', dirtEdgeMode);
  cv.style.cursor = dirtEdgeMode ? 'crosshair' : 'default';
  setStatus(dirtEdgeMode
    ? 'OKRAJ DIRTU: klikej body PŘES trať od kraje ke kraji (u začátku nebo konce dirtu), dvojklik = hotovo. Pravý klik = zrušit/smazat hranici.'
    : 'OKRAJ DIRTU: režim ukončen. ' + HINT_EDIT);
});

document.getElementById('billboard')!.addEventListener('click', () => {
  if (!path) { setStatus('BILLBOARD: nejdřív nakresli trať.'); return; }
  const on = !billboardMode;
  resetMarkModes();
  billboardMode = on;
  document.getElementById('billboard')!.classList.toggle('active', billboardMode);
  cv.style.cursor = billboardMode ? 'crosshair' : 'default';
  bbWidthEl.value = String(Math.round(billboardScale * 100));
  renderStats(); scheduleRender();
  setStatus(billboardMode
    ? 'BILLBOARD: klikni na trávu = umísti (nohama na zem) · táhni = přemísti · slider „billboard velikost" = velikost · pravý klik = smazat.'
    : 'BILLBOARD: režim ukončen. ' + HINT_EDIT);
});

document.getElementById('gravel')!.addEventListener('click', () => {
  if (!path) { setStatus('GRAVEL: nejdřív nakresli trať.'); return; }
  const on = !gravelMode;
  resetMarkModes();
  gravelMode = on;
  document.getElementById('gravel')!.classList.toggle('active', gravelMode);
  cv.style.cursor = gravelMode ? 'crosshair' : 'default';
  setStatus(gravelMode
    ? 'GRAVEL: kresli štěrk volnou rukou (klidně přes okraj tratě, schová se pod ni). Tloušťku měň sliderem „gravel štětec". Pravý klik = smazat poslední tah.'
    : 'GRAVEL: režim ukončen. ' + HINT_EDIT);
});

document.getElementById('finish')!.addEventListener('click', () => {
  if (!path) { setStatus('CÍL: nejdřív nakresli trať.'); return; }
  resetMarkModes();
  finishMode = true;
  cv.style.cursor = 'crosshair';
  setStatus('CÍL: klikni na trať, kde má být cílová čára. (Pravý klik = vrátit na auto.)');
});

document.getElementById('kerb')!.addEventListener('click', () => {
  if (!path) { setStatus('KERB: nejdřív nakresli trať.'); return; }
  resetMarkModes();
  kerbMode = 1;
  cv.style.cursor = 'crosshair';
  setStatus('KERB: klikni na ZAČÁTEK kerbu na OKRAJI asfaltu — strana se bere z kliknutí. (Pravý klik na hotový kerb = smazat.)');
});

document.getElementById('dirt')!.addEventListener('click', () => {
  if (!path) { setStatus('DIRT: nejdřív nakresli trať.'); return; }
  resetMarkModes();
  dirtMode = 1;
  cv.style.cursor = 'crosshair';
  setStatus('DIRT: klikni na trať = ZAČÁTEK úseku. (Pravý klik kdykoliv = smazat dirt.)');
});

document.getElementById('new')!.addEventListener('click', () => {
  if (ctrl.length && !confirm('Zahodit rozdělanou trať a začít znovu? (ZPĚT ji umí vrátit)')) return;
  if (ctrl.length) pushHistory();
  ctrl = []; stroke = []; hoverIdx = null; dragIdx = null;
  dirt = null; finishI = null; kerbs = []; lines = []; dirtEdges = []; gravels = []; billboards = [];
  resetMarkModes();
  outEl.value = '';
  save();
  setStatus('Nakresli JEDNÍM tahem uzavřený okruh. Spodek kresby = cílová rovinka (pipeline ji sám zarovná).');
  cv.style.cursor = 'crosshair';
  refresh();
});

document.getElementById('import')!.addEventListener('click', () => {
  // Accept a full export block OR a bare point array — every [x,y] pair in the text
  // counts; CS_BAND is picked up when present.
  const txt = outEl.value;
  // Control points come ONLY from the AUTHORED_SKETCH block when one exists — the
  // export also carries AUTHORED_LINE stroke points, which must NOT leak in here.
  // A bare pasted array (no markers) still imports as before.
  const skBlock = /AUTHORED_SKETCH[^=]*=\s*\[([\s\S]*?)\];/.exec(txt);
  const src = skBlock ? skBlock[1] : txt;
  const pts: Pt[] = [];
  const re = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(src))) pts.push([Math.round(Number(mt[1])), Math.round(Number(mt[2]))]);
  if (pts.length < MIN_CTRL) {
    setStatus(`IMPORT: v poli dole nevidím aspoň ${MIN_CTRL} body [x,y] — vlož pole bodů nebo celý export.`);
    return;
  }
  pushHistory();
  const bm = /(?:CS_BAND|AUTHORED_BAND)\s*=\s*(\d+(?:\.\d+)?)/.exec(txt);
  ctrl = pts;
  if (bm) { band = Math.max(60, Math.min(220, Number(bm[1]))); widthEl.value = String(band); }
  const dm = /AUTHORED_DIRT[^=]*=\s*\{\s*i0:\s*(\d+)\s*,\s*i1:\s*(\d+)/.exec(txt);
  dirt = dm ? { i0: Number(dm[1]), i1: Number(dm[2]) } : null;
  const fm = /AUTHORED_FINISH_I[^=]*=\s*(\d+|null)/.exec(txt);
  finishI = fm && fm[1] !== 'null' ? Number(fm[1]) : null;
  kerbs = [];
  const kre = /\{\s*i0:\s*(\d+)\s*,\s*i1:\s*(\d+)\s*,\s*side:\s*(-?1)\s*\}/g;
  let km: RegExpExecArray | null;
  while ((km = kre.exec(txt))) kerbs.push({ i0: Number(km[1]), i1: Number(km[2]), side: Number(km[3]) === -1 ? -1 : 1 });
  lines = [];
  const lineBlock = /AUTHORED_LINE[^=]*=\s*\[([\s\S]*?)\];/.exec(txt);
  if (lineBlock) {
    const sre = /\{\s*w:\s*(\d+(?:\.\d+)?)\s*,\s*pts:\s*\[((?:\s*\[[^\]]*\]\s*,?)*)\]\s*\}/g;
    let sm: RegExpExecArray | null;
    while ((sm = sre.exec(lineBlock[1]))) {
      const spts: Pt[] = [];
      const pre = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
      let pm: RegExpExecArray | null;
      while ((pm = pre.exec(sm[2]))) spts.push([Math.round(Number(pm[1])), Math.round(Number(pm[2]))]);
      if (spts.length >= 2) lines.push({ w: Number(sm[1]), pts: spts });
    }
  }
  dirtEdges = [];
  const deBlock = /AUTHORED_DIRT_EDGES[^=]*=\s*\[([\s\S]*?)\];/.exec(txt);
  if (deBlock) {
    const lre = /\[((?:\s*\[[^\]]*\]\s*,?)+)\]/g;
    let lm2: RegExpExecArray | null;
    while ((lm2 = lre.exec(deBlock[1]))) {
      const lpts: Pt[] = [];
      const pre2 = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
      let pm2: RegExpExecArray | null;
      while ((pm2 = pre2.exec(lm2[1]))) lpts.push([Math.round(Number(pm2[1])), Math.round(Number(pm2[2]))]);
      if (lpts.length >= 2) dirtEdges.push(lpts);
    }
  }
  gravels = [];
  const gvBlock = /AUTHORED_GRAVEL[^=]*=\s*\[([\s\S]*?)\];/.exec(txt);
  if (gvBlock) {
    const gsre = /\{\s*w:\s*(\d+(?:\.\d+)?)\s*,\s*pts:\s*\[((?:\s*\[[^\]]*\]\s*,?)*)\]\s*\}/g;
    let gsm: RegExpExecArray | null;
    while ((gsm = gsre.exec(gvBlock[1]))) {
      const gpts: Pt[] = [];
      const pre3 = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
      let pm3: RegExpExecArray | null;
      while ((pm3 = pre3.exec(gsm[2]))) gpts.push([Math.round(Number(pm3[1])), Math.round(Number(pm3[2]))]);
      if (gpts.length >= 2) gravels.push({ w: Number(gsm[1]), pts: gpts });
    }
  }
  billboards = [];
  const bbBlock = /AUTHORED_BILLBOARDS[^=]*=\s*\[([\s\S]*?)\];/.exec(txt);
  if (bbBlock) {
    const bre = /\{\s*sx:\s*(-?\d+(?:\.\d+)?)\s*,\s*sy:\s*(-?\d+(?:\.\d+)?)\s*,\s*scale:\s*(\d+(?:\.\d+)?)/g;
    let bm2: RegExpExecArray | null;
    while ((bm2 = bre.exec(bbBlock[1]))) billboards.push({ sx: Math.round(Number(bm2[1])), sy: Math.round(Number(bm2[2])), scale: Number(bm2[3]) });
  }
  hoverIdx = null; dragIdx = null; stroke = []; drawing = false;
  resetMarkModes();
  save(); refresh();
  setStatus(`IMPORT: ${ctrl.length} bodů${bm ? `, šířka ${band}` : ''}${dm ? ', dirt' : ''}${dirtEdges.length ? `, ${dirtEdges.length}× okraj dirtu` : ''}${gravels.length ? `, ${gravels.length}× gravel` : ''}${billboards.length ? `, ${billboards.length}× billboard` : ''}${kerbs.length ? `, ${kerbs.length}× kerb` : ''}${finishI !== null ? ', cílovka' : ''}${lines.length ? `, stopa (${lines.length} tahů)` : ''} ✓ — ` + HINT_EDIT);
  cv.style.cursor = 'default';
});

document.getElementById('export')!.addEventListener('click', async () => {
  if (!ctrl.length) { setStatus('Není co exportovat — nejdřív nakresli trať.'); return; }
  const txt = exportText();
  outEl.value = txt;
  try {
    await navigator.clipboard.writeText(txt);
    setStatus('Export zkopírován do schránky ✓ (a je i v poli dole).');
  } catch {
    outEl.select();
    setStatus('Zkopíruj export z pole dole (schránka nedostupná).');
  }
});

// ---- boot -------------------------------------------------------------------------
// Headless-verification hook (rAF never fires in a hidden tab): force a synchronous
// render + peek at the derived state from the console.
(window as unknown as { __trackEditor?: unknown }).__trackEditor = {
  forceRender: () => { computeAll(); render(); },
  state: () => ({ ctrl, band, dirt, dirtEdges, gravels, gravelBrush, billboards, finishI, kerbs, lines, kerbQuads: kerbQuads.length, pathPts: path ? path.length : 0, fit }),
  view: () => viewT(),
  pathAt: (i: number) => (path ? path[((i % path.length) + path.length) % path.length] : null),
};
preloadSurfaceAssets();
onSurfaceAssetsReady(scheduleRender);              // re-render once the tarmac PNG decodes
if (restore()) {
  setStatus(HINT_EDIT + ' (obnovena poslední trať — NOVÁ TRAŤ začne znovu)');
  cv.style.cursor = 'default';
} else {
  // first open on this machine → seed the boss's sketch so refinement continues
  ctrl = DEFAULT_SKETCH.map(([x, y]) => [x, y] as Pt);
  band = DEFAULT_BAND;
  widthEl.value = String(band);
  save();
  setStatus(HINT_EDIT + ' (načten výchozí sketch)');
  cv.style.cursor = 'default';
}
refresh();
