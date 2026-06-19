// =============================================================================
//  Steer It — visual effects: tire smoke, impact sparks, screen shake.
//
//  Particle positions live in METERS (world space) and are drawn into the
//  main canvas each frame after the car, inside the screen-shake transform.
//  Pool is hard-capped; emission simply stops at the cap.
// =============================================================================

export const FX_CONFIG = {
  maxParticles: 340,

  // ---------- Tire smoke (p11 polish: clearly visible drift trail) ----------
  smokeRatePerWheel: 55,   // particles/s per wheel at full drift intensity
  smokeLife: 1.1,          // s (± var)
  smokeLifeVar: 0.35,
  smokeSize: 0.42,         // m initial radius
  smokeGrow: 1.5,          // m/s radius growth
  smokeAlpha: 0.20,        // initial opacity — light & see-through (was 0.38);
                           //   real rubber smoke is airy, never hides the car
  smokeDrift: 0.8,         // m/s random drift velocity
  smokeInheritVel: 0.25,   // fraction of car velocity inherited

  // ---------- Impact sparks ----------
  sparkImpactMin: 4,       // m/s normal impact needed to spawn sparks
  sparkCount: 10,          // at full impact (scaled down for lighter hits)
  sparkLife: 0.32,         // s
  sparkSpeed: 8,           // m/s burst velocity
  sparkSize: 0.10,         // m

  // ---------- Screen shake ----------
  shakeMagPx: 4,           // px at full impact
  shakeDur: 0.16,          // s
  shakeFullImpulse: 14,    // m/s normal impact = full magnitude
};

// Default tire-smoke tint — whitish warm grey (the desktop surface). Maps can
// override per emission (e.g. the dirt oval kicks up brown dust).
export const DEFAULT_SMOKE_RGB: [number, number, number] = [248, 248, 251];

interface Particle {
  kind: 'smoke' | 'spark';
  x: number; y: number;     // meters
  vx: number; vy: number;   // m/s
  age: number; life: number;
  size: number;
  grow?: number;            // per-particle radius growth (m/s); smoke only, falls back to FX_CONFIG.smokeGrow
  tint: [number, number, number];  // smoke colour (sparks ignore it)
}

export class Effects {
  private particles: Particle[] = [];
  private smokeCarry = 0;
  private shakeT = 0;
  private shakeMag = 0;

  // Emit smoke from a wheel position; intensity 0..1 scales the rate.
  emitSmoke(
    x: number, y: number, carVx: number, carVy: number,
    intensity: number, dt: number, sizeScale = 1,
    tint: [number, number, number] = DEFAULT_SMOKE_RGB,
    growScale = 1,   // sim-real-2 (real-size car) scales radius growth too, so the puff stays proportional
  ) {
    const C = FX_CONFIG;
    if (intensity <= 0) return;
    this.smokeCarry += C.smokeRatePerWheel * intensity * dt;
    let n = Math.floor(this.smokeCarry);
    this.smokeCarry -= n;
    while (n-- > 0 && this.particles.length < C.maxParticles) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * C.smokeDrift;
      this.particles.push({
        kind: 'smoke',
        x: x + (Math.random() - 0.5) * 0.3,
        y: y + (Math.random() - 0.5) * 0.3,
        vx: carVx * C.smokeInheritVel + Math.cos(a) * d,
        vy: carVy * C.smokeInheritVel + Math.sin(a) * d,
        age: 0,
        // sizeScale keeps puffs MODEST near a slow/stationary car so a
        // standing burnout never fully obscures it (p10).
        life: C.smokeLife + (Math.random() - 0.5) * 2 * C.smokeLifeVar,
        size: C.smokeSize * (0.8 + Math.random() * 0.4) * sizeScale,
        grow: C.smokeGrow * growScale,   // growScale 1 (arcade) ⇒ exactly C.smokeGrow ⇒ byte-identical
        tint,   // per-map surface colour (white smoke / brown dust / …)
      });
    }
  }

  // Collision feedback: sparks at the contact area + screen shake.
  impact(x: number, y: number, strength: number) {
    const C = FX_CONFIG;
    const k = Math.min(1, strength / C.shakeFullImpulse);
    this.shakeMag = Math.max(this.shakeMag, C.shakeMagPx * k);
    this.shakeT = C.shakeDur;

    if (strength >= C.sparkImpactMin) {
      const n = Math.max(3, Math.round(C.sparkCount * k));
      for (let i = 0; i < n && this.particles.length < C.maxParticles; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = C.sparkSpeed * (0.3 + Math.random() * 0.7);
        this.particles.push({
          kind: 'spark',
          x, y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          age: 0,
          life: C.sparkLife * (0.6 + Math.random() * 0.8),
          size: FX_CONFIG.sparkSize,
          tint: DEFAULT_SMOKE_RGB,   // unused by sparks (they draw a fixed colour)
        });
      }
    }
  }

  update(dt: number) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) { ps.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'smoke') {
        p.size += (p.grow ?? FX_CONFIG.smokeGrow) * dt;
        p.vx *= 1 - 1.5 * dt;
        p.vy *= 1 - 1.5 * dt;
      } else {
        p.vx *= 1 - 6 * dt;
        p.vy *= 1 - 6 * dt;
      }
    }
    if (this.shakeT > 0) this.shakeT -= dt;
    else this.shakeMag = 0;
  }

  // Random offset in PIXELS, decaying over the shake duration.
  shakeOffset(): { x: number; y: number } {
    if (this.shakeT <= 0) return { x: 0, y: 0 };
    const k = (this.shakeT / FX_CONFIG.shakeDur) * this.shakeMag;
    return {
      x: (Math.random() * 2 - 1) * k,
      y: (Math.random() * 2 - 1) * k,
    };
  }

  draw(ctx: CanvasRenderingContext2D, px: number) {
    for (const p of this.particles) {
      const t = p.age / p.life;
      if (p.kind === 'smoke') {
        // Airy, see-through surface smoke/dust: a SOFT radial gradient per puff
        // (opaque core fading to fully transparent at the rim) keeps the car
        // visible THROUGH it. Colour is the emitting map's surface tint (white
        // rubber smoke on the desktop, brown dust on the dirt oval, …).
        const a = FX_CONFIG.smokeAlpha * (1 - t);
        const cx = p.x * px, cy = p.y * px, r = p.size * px;
        const [tr, tg, tb] = p.tint;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0,    `rgba(${tr}, ${tg}, ${tb}, ${a.toFixed(3)})`);
        g.addColorStop(0.55, `rgba(${tr}, ${tg}, ${tb}, ${(a * 0.5).toFixed(3)})`);
        g.addColorStop(1,    `rgba(${tr}, ${tg}, ${tb}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(255, 214, 107, ${(0.9 * (1 - t)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x * px, p.y * px, p.size * px * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
