import QRCode from 'qrcode';
import { supabase, channelName } from './supabase';

// ---------- Session ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const code = Array.from(
  { length: 4 },
  () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
).join('');

const playUrl = `${window.location.origin}/play?s=${code}`;

const qrCanvas = document.getElementById('qr') as HTMLCanvasElement;
const codeText = document.getElementById('code-text') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

codeText.textContent = code;
QRCode.toCanvas(qrCanvas, playUrl, { width: 160, margin: 1 }).catch(console.error);

// ---------- Canvas ----------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', resize);

// ---------- Car / steering state ----------
const car = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
  heading: -Math.PI / 2, // facing up
};

const SPEED = 200;            // px/s — constant forward speed
const TILT_MAX_DEG = 45;      // degrees of tilt for full turn rate
const DEADZONE_DEG = 3;       // ignore tiny tilts
const MAX_TURN_RATE = 2.6;    // rad/s at full tilt (~150°/s)
const SMOOTHING = 0.15;       // lerp factor toward target steering per frame

let targetSteer = 0; // rad/s, updated by network
let currentSteer = 0; // rad/s, eased toward target each frame

// ---------- Supabase channel ----------
const channel = supabase.channel(channelName(code), {
  config: { broadcast: { self: false } },
});

let connected = false;
function markConnected() {
  if (connected) return;
  connected = true;
  statusEl.textContent = 'Connected';
  statusEl.classList.add('connected');
}

channel.on('broadcast', { event: 'tilt' }, ({ payload }) => {
  const gamma = Number((payload as { gamma?: unknown })?.gamma);
  if (!Number.isFinite(gamma)) return;
  markConnected();

  // Map gamma → target turn rate with deadzone + normalization.
  const sign = Math.sign(gamma);
  const mag = Math.max(0, Math.abs(gamma) - DEADZONE_DEG);
  const norm = Math.min(1, mag / (TILT_MAX_DEG - DEADZONE_DEG));
  targetSteer = sign * norm * MAX_TURN_RATE;
});

channel.subscribe();

// ---------- Render loop ----------
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Smooth the steering — independent of network update rate.
  currentSteer += (targetSteer - currentSteer) * SMOOTHING;

  // Apply steering and drive forward.
  car.heading += currentSteer * dt;
  car.x += Math.cos(car.heading) * SPEED * dt;
  car.y += Math.sin(car.heading) * SPEED * dt;

  // Wrap edges.
  const W = window.innerWidth;
  const H = window.innerHeight;
  const M = 30;
  if (car.x < -M) car.x = W + M;
  else if (car.x > W + M) car.x = -M;
  if (car.y < -M) car.y = H + M;
  else if (car.y > H + M) car.y = -M;

  // Draw.
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);
  drawCar(car.x, car.y, car.heading);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Drawing ----------
function drawCar(x: number, y: number, heading: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);

  // Body
  ctx.fillStyle = '#e6edf3';
  roundRect(ctx, -24, -15, 48, 30, 8);
  ctx.fill();

  // Nose (clearly marks "front")
  ctx.fillStyle = '#ff7b72';
  ctx.beginPath();
  ctx.moveTo(24, -11);
  ctx.lineTo(38, 0);
  ctx.lineTo(24, 11);
  ctx.closePath();
  ctx.fill();

  // Windshield hint
  ctx.fillStyle = '#58a6ff';
  roundRect(ctx, 4, -10, 14, 20, 3);
  ctx.fill();

  ctx.restore();
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
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
