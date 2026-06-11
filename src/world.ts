// =============================================================================
//  Steer It — the fake desktop world.
//
//  A retro late-90s desktop VIBE (rolling-hills wallpaper, grey taskbar,
//  scattered icons) — all artwork original; nothing trademarked is copied.
//
//  The icon layout lives in ICON_SPECS (grid slots + jitter + label) so the
//  arrangement is data, not code — easy to redesign or feed from a level
//  editor later. layoutDesktop() instantiates it against the current world
//  size in METERS and produces the collision rects (icon hitboxes ~10%
//  smaller than the visual glyph; labels are not solid).
//
//  Rendering is layered by the caller:
//    wallpaper (static)  →  skid marks  →  overlay (icons + taskbar, static)
//    →  clock (dynamic)  →  car
// =============================================================================

import type { ObstacleRect } from './physics';

export type IconType = 'folder' | 'file' | 'image' | 'zip' | 'bin';

export interface DesktopIcon {
  type: IconType;
  label: string;
  x: number;      // meters, top-left of the square glyph
  y: number;
  size: number;   // meters — glyph is size × size, label sits below
}

export interface DesktopWorld {
  width: number;          // meters
  height: number;
  taskbarHeight: number;  // meters
  icons: DesktopIcon[];
  rects: ObstacleRect[];  // collision: shrunk icon boxes + the taskbar wall
}

// ---------- Layout tuning (meters) ----------
const ICON_SIZE = 2.2;
const BIN_SIZE = 2.9;
const COL_SPACING = 7.5;
const ROW_SPACING = 5.6;
const MARGIN_X = 2.0;
const MARGIN_Y = 1.6;
export const TASKBAR_M = 1.8;
// Hitboxes are inset ~10% of the glyph for forgiveness.
const HITBOX_INSET_FRAC = 0.05; // per side

// ---------- The desktop's contents ----------
// Roughly grid-aligned columns from the top-left like a real (slightly
// messy) desktop; jx/jy add the mess. Gaps between columns are drift lines.
const ICON_SPECS: Array<{
  col: number; row: number; jx?: number; jy?: number;
  type: Exclude<IconType, 'bin'>; label: string;
}> = [
  { col: 0, row: 0,                    type: 'folder', label: 'Documents' },
  { col: 0, row: 1, jx: 0.3,           type: 'folder', label: 'vacation pics' },
  { col: 0, row: 2, jx: -0.2,          type: 'folder', label: 'DO NOT DELETE!!!' },
  { col: 0, row: 3, jy: 0.4,           type: 'file',   label: 'passwords.txt' },
  { col: 1, row: 0, jx: 0.5,           type: 'file',   label: 'taxes_2024_final_v3' },
  { col: 1, row: 1,                    type: 'folder', label: 'New folder (2)' },
  { col: 1, row: 2, jx: 0.8, jy: 0.3,  type: 'zip',    label: 'backup_FINAL.zip' },
  { col: 2, row: 0, jy: 0.2,           type: 'image',  label: 'lunch_photo.jpg' },
  { col: 2, row: 1, jx: -0.4,          type: 'folder', label: 'old stuff' },
  { col: 3, row: 0, jx: 0.2,           type: 'file',   label: 'essay_v8_FINAL.doc' },
  // A couple of strays mid-desktop so the open field has something to orbit.
  { col: 6, row: 2, jx: 1.2, jy: 0.8,  type: 'folder', label: 'definitely not games' },
  { col: 8, row: 1, jx: 0.4, jy: -0.3, type: 'file',   label: 'todo_URGENT.txt' },
];

export function layoutDesktop(width: number, height: number): DesktopWorld {
  const icons: DesktopIcon[] = [];
  const usableBottom = height - TASKBAR_M - 1.2;

  // The car spawns at the world center — keep a clear circle around it so
  // it never materializes inside (or pressed against) an icon.
  const spawnX = width / 2, spawnY = height / 2, spawnClear = 4.5;

  for (const s of ICON_SPECS) {
    const x = MARGIN_X + s.col * COL_SPACING + (s.jx ?? 0);
    const y = MARGIN_Y + s.row * ROW_SPACING + (s.jy ?? 0);
    // Skip icons that don't fit the current window (small screens).
    if (x + ICON_SIZE > width - 2 || y + ICON_SIZE + 0.8 > usableBottom) continue;
    if (Math.hypot(x + ICON_SIZE / 2 - spawnX, y + ICON_SIZE / 2 - spawnY) < spawnClear) continue;
    icons.push({ type: s.type, label: s.label, x, y, size: ICON_SIZE });
  }

  // Recycle bin in the classic corner — bottom-right, above the taskbar.
  icons.push({
    type: 'bin', label: 'Recycle Bin',
    x: width - BIN_SIZE - 2.2,
    y: height - TASKBAR_M - BIN_SIZE - 2.4,
    size: BIN_SIZE,
  });

  const world: DesktopWorld = {
    width, height, taskbarHeight: TASKBAR_M, icons, rects: [],
  };
  rebuildRects(world);
  return world;
}

// Recompute collision rects from the icons array — call after any icon
// moves (icons are the single source of truth; rects are derived).
export function rebuildRects(world: DesktopWorld) {
  world.rects = world.icons.map((ic) => {
    const inset = ic.size * HITBOX_INSET_FRAC;
    return {
      x: ic.x + inset, y: ic.y + inset,
      w: ic.size - 2 * inset, h: ic.size - 2 * inset,
    };
  });
  // Taskbar — a solid wall spanning the full bottom edge (overshoot the
  // sides so the corner can't be squeezed through).
  world.rects.push({
    x: -10, y: world.height - TASKBAR_M, w: world.width + 20, h: TASKBAR_M + 10,
  });
}

// ---------- Icon dragging support ----------

// Topmost icon under a point (meters), with a small grab margin.
export function iconAt(world: DesktopWorld, x: number, y: number): DesktopIcon | null {
  const m = 0.2;
  for (let i = world.icons.length - 1; i >= 0; i--) {
    const ic = world.icons[i];
    if (x >= ic.x - m && x <= ic.x + ic.size + m &&
        y >= ic.y - m && y <= ic.y + ic.size + m) {
      return ic;
    }
  }
  return null;
}

// Keep an icon inside the desktop: off the taskbar, label row visible.
export function clampIconToBounds(world: DesktopWorld, ic: DesktopIcon) {
  ic.x = Math.min(Math.max(ic.x, 0.3), world.width - ic.size - 0.3);
  ic.y = Math.min(Math.max(ic.y, 0.3),
    world.height - world.taskbarHeight - ic.size - 1.0);
}

// On drop: nudge out of (most) overlaps with other icons, forgivingly —
// icons may sit close, just not on top of each other. Iterative separation
// along the axis with the smaller push.
export function resolveIconDrop(world: DesktopWorld, ic: DesktopIcon) {
  clampIconToBounds(world, ic);
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    for (const other of world.icons) {
      if (other === ic) continue;
      // Forgiving: required center separation is 80% of touching distance.
      const need = 0.8 * (ic.size + other.size) / 2;
      const dx = (ic.x + ic.size / 2) - (other.x + other.size / 2);
      const dy = (ic.y + ic.size / 2) - (other.y + other.size / 2);
      if (Math.abs(dx) < need && Math.abs(dy) < need) {
        if (Math.abs(dx) >= Math.abs(dy)) {
          ic.x += (dx >= 0 ? 1 : -1) * (need - Math.abs(dx));
        } else {
          ic.y += (dy >= 0 ? 1 : -1) * (need - Math.abs(dy));
        }
        moved = true;
      }
    }
    clampIconToBounds(world, ic);
    if (!moved) break;
  }
}

// =============================================================================
//  Drawing — all in PIXEL space (caller's ctx already DPR-scaled).
// =============================================================================

// ---------- Wallpaper: sky + rolling green hills, low contrast ----------
export function drawWallpaper(ctx: CanvasRenderingContext2D, w: number, h: number) {
  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.7);
  sky.addColorStop(0, '#8ec7e8');
  sky.addColorStop(1, '#d8ecd8');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Soft sun glow, upper area
  const sun = ctx.createRadialGradient(w * 0.72, h * 0.16, 10, w * 0.72, h * 0.16, h * 0.25);
  sun.addColorStop(0, 'rgba(255, 246, 200, 0.85)');
  sun.addColorStop(1, 'rgba(255, 246, 200, 0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h * 0.5);

  // Back hill (darker, hazier)
  ctx.fillStyle = '#7fae62';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.52);
  ctx.quadraticCurveTo(w * 0.28, h * 0.34, w * 0.55, h * 0.50);
  ctx.quadraticCurveTo(w * 0.78, h * 0.62, w, h * 0.46);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  // Front hill (lighter, the main "lawn")
  const lawn = ctx.createLinearGradient(0, h * 0.45, 0, h);
  lawn.addColorStop(0, '#9cc873');
  lawn.addColorStop(1, '#7eb259');
  ctx.fillStyle = lawn;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.62);
  ctx.quadraticCurveTo(w * 0.35, h * 0.42, w * 0.72, h * 0.58);
  ctx.quadraticCurveTo(w * 0.9, h * 0.66, w, h * 0.6);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
}

// ---------- Icons + taskbar chrome (static overlay) ----------
// `lifted` (the icon currently being dragged) renders LAST, slightly
// scaled with a drop shadow — the classic picked-up-icon look.
export function drawOverlay(
  ctx: CanvasRenderingContext2D, world: DesktopWorld, px: number,
  lifted: DesktopIcon | null = null,
) {
  for (const ic of world.icons) {
    if (ic !== lifted) drawIcon(ctx, ic, px, false);
  }
  drawTaskbar(ctx, world, px);
  if (lifted) drawIcon(ctx, lifted, px, true);
}

function drawIcon(
  ctx: CanvasRenderingContext2D, ic: DesktopIcon, px: number, lifted: boolean,
) {
  const x = ic.x * px, y = ic.y * px, s = ic.size * px;
  ctx.save();
  if (lifted) {
    const cx = x + s / 2, cy = y + s / 2;
    ctx.translate(cx, cy);
    ctx.scale(1.08, 1.08);
    ctx.translate(-cx, -cy);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 7;
  }
  switch (ic.type) {
    case 'folder': drawFolder(ctx, x, y, s); break;
    case 'file':   drawFile(ctx, x, y, s); break;
    case 'image':  drawImageFile(ctx, x, y, s); break;
    case 'zip':    drawZip(ctx, x, y, s); break;
    case 'bin':    drawBin(ctx, x, y, s); break;
  }
  ctx.restore();

  // Label — classic desktop style: white text with a dark drop shadow.
  const cx = x + s / 2;
  const ly = y + s + 13;
  let label = ic.label;
  if (label.length > 24) label = label.slice(0, 23) + '…';
  ctx.font = '11px "Segoe UI", Tahoma, Verdana, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0, 40, 0, 0.75)';
  ctx.fillText(label, cx + 1, ly + 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx, ly);
  ctx.textAlign = 'left';
}

function drawFolder(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const u = s / 24; // pixel-art unit
  ctx.fillStyle = '#8a6d1f';
  rr(ctx, x + 1 * u, y + 4 * u, 22 * u, 17 * u, 2 * u); ctx.fill();   // outline
  ctx.fillStyle = '#d9a93c';
  rr(ctx, x + 2 * u, y + 5 * u, 20 * u, 15 * u, 1.5 * u); ctx.fill(); // body back
  ctx.fillStyle = '#d9a93c';
  rr(ctx, x + 2 * u, y + 2.5 * u, 9 * u, 5 * u, 1.5 * u); ctx.fill(); // tab
  ctx.fillStyle = '#f7d154';
  rr(ctx, x + 2 * u, y + 8 * u, 20 * u, 12 * u, 1.5 * u); ctx.fill(); // front flap
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(x + 3 * u, y + 9 * u, 18 * u, 1.2 * u);                // shine
}

function drawFile(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const u = s / 24;
  const fx = x + 4 * u, fy = y + 1.5 * u, fw = 16 * u, fh = 21 * u, fold = 5 * u;
  ctx.fillStyle = '#8a8a8a';
  rr(ctx, fx - u * 0.7, fy - u * 0.7, fw + 1.4 * u, fh + 1.4 * u, u); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(fx + fw - fold, fy);
  ctx.lineTo(fx + fw, fy + fold);
  ctx.lineTo(fx + fw, fy + fh);
  ctx.lineTo(fx, fy + fh);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#c9c9c9';                                          // folded corner
  ctx.beginPath();
  ctx.moveTo(fx + fw - fold, fy);
  ctx.lineTo(fx + fw, fy + fold);
  ctx.lineTo(fx + fw - fold, fy + fold);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#9db3c8';                                          // text lines
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(fx + 2.5 * u, fy + (7 + i * 2.8) * u, fw - 5 * u, 1.1 * u);
  }
}

function drawImageFile(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  drawFile(ctx, x, y, s);
  const u = s / 24;
  // Tiny landscape thumbnail over the text lines
  const tx = x + 6 * u, ty = y + 7 * u, tw = 12 * u, th = 9 * u;
  ctx.fillStyle = '#9fd0ea';
  ctx.fillRect(tx, ty, tw, th);
  ctx.fillStyle = '#7eb259';
  ctx.beginPath();
  ctx.moveTo(tx, ty + th);
  ctx.quadraticCurveTo(tx + tw * 0.4, ty + th * 0.35, tx + tw, ty + th * 0.85);
  ctx.lineTo(tx + tw, ty + th);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffe27a';
  ctx.beginPath();
  ctx.arc(tx + tw * 0.75, ty + th * 0.3, 1.6 * u, 0, Math.PI * 2);
  ctx.fill();
}

function drawZip(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  drawFolder(ctx, x, y, s);
  const u = s / 24;
  // Zipper teeth down the middle of the flap
  ctx.fillStyle = '#8a6d1f';
  const zx = x + 11.4 * u;
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(zx + (i % 2 === 0 ? 0 : 1.2 * u) - 0.6 * u, y + (9 + i * 2.2) * u, 1.4 * u, 1.4 * u);
  }
}

function drawBin(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const u = s / 24;
  // Crumpled paper peeking out
  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.arc(x + 9 * u, y + 4.5 * u, 2.6 * u, 0, Math.PI * 2);
  ctx.arc(x + 14 * u, y + 4 * u, 2.2 * u, 0, Math.PI * 2);
  ctx.fill();
  // Rim
  ctx.fillStyle = '#7d8e9b';
  rr(ctx, x + 4 * u, y + 5 * u, 16 * u, 3 * u, 1.4 * u); ctx.fill();
  // Body — slightly tapered basket
  ctx.fillStyle = '#a9bcc9';
  ctx.beginPath();
  ctx.moveTo(x + 5 * u, y + 8 * u);
  ctx.lineTo(x + 19 * u, y + 8 * u);
  ctx.lineTo(x + 17.5 * u, y + 22 * u);
  ctx.lineTo(x + 6.5 * u, y + 22 * u);
  ctx.closePath();
  ctx.fill();
  // Ribs
  ctx.strokeStyle = '#7d8e9b';
  ctx.lineWidth = u;
  for (let i = 0; i < 3; i++) {
    const bx = x + (8.5 + i * 3.5) * u;
    ctx.beginPath();
    ctx.moveTo(bx, y + 9.5 * u);
    ctx.lineTo(bx, y + 20.5 * u);
    ctx.stroke();
  }
}

// ---------- Taskbar ----------
function drawTaskbar(ctx: CanvasRenderingContext2D, world: DesktopWorld, px: number) {
  const w = world.width * px;
  const tb = world.taskbarHeight * px;
  const y = world.height * px - tb;

  // Bar with a classic 3D top bevel
  ctx.fillStyle = '#c9c6bd';
  ctx.fillRect(0, y, w, tb);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, y, w, 1.5);
  ctx.fillStyle = '#8e8b84';
  ctx.fillRect(0, y - 1, w, 1);

  // Start-ish button (original generic logo: hill + sun, matches wallpaper)
  const bh = tb - 8, bx = 5, by = y + 4, bw = 86;
  bevelRect(ctx, bx, by, bw, bh, true);
  const lx = bx + 8, lcy = by + bh / 2;
  ctx.fillStyle = '#9fd0ea';
  ctx.beginPath(); ctx.arc(lx + 7, lcy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7eb259';
  ctx.beginPath();
  ctx.moveTo(lx - 1, lcy + 7);
  ctx.quadraticCurveTo(lx + 7, lcy - 3, lx + 15, lcy + 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffe27a';
  ctx.beginPath(); ctx.arc(lx + 10, lcy - 3.5, 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.font = 'bold 13px "Segoe UI", Tahoma, sans-serif';
  ctx.fillStyle = '#2b2b2b';
  ctx.fillText('Start', lx + 20, lcy + 4.5);

  // Sunken clock tray (the time itself is drawn dynamically each frame)
  const cw = 72;
  bevelRect(ctx, w - cw - 5, by, cw, bh, false);
}

// Dynamic clock — call every frame AFTER the overlay layer.
export function drawClock(
  ctx: CanvasRenderingContext2D, world: DesktopWorld, px: number,
) {
  const w = world.width * px;
  const tb = world.taskbarHeight * px;
  const y = world.height * px - tb;
  const bh = tb - 8, by = y + 4, cw = 72;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  ctx.font = '12px "Segoe UI", Tahoma, sans-serif';
  ctx.fillStyle = '#2b2b2b';
  ctx.textAlign = 'center';
  ctx.fillText(`${hh}:${mm}`, w - cw / 2 - 5, by + bh / 2 + 4);
  ctx.textAlign = 'left';
}

// ---------- Small helpers ----------
function rr(
  c: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function bevelRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, raised: boolean,
) {
  ctx.fillStyle = raised ? '#d6d3ca' : '#bdbab1';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = raised ? '#ffffff' : '#8e8b84';
  ctx.fillRect(x, y, w, 1.5);
  ctx.fillRect(x, y, 1.5, h);
  ctx.fillStyle = raised ? '#8e8b84' : '#ffffff';
  ctx.fillRect(x, y + h - 1.5, w, 1.5);
  ctx.fillRect(x + w - 1.5, y, 1.5, h);
}
