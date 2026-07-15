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
  smokeRatePerWheel: 28,   // particles/s per wheel at full intensity (halved 55→28 = ~½ the smoke; scales burnout + slide together, keeping slide's ×0.75 relative)
  smokeLife: 1.1,          // s (± var)
  smokeLifeVar: 0.35,
  smokeSize: 1.24,         // m initial radius (Stage C1: real metres, ×2.96 for the 2.565 m car)
  smokeGrow: 4.44,         // m/s radius growth (Stage C1: ×2.96)
  smokeAlpha: 0.16,        // initial opacity — light & see-through (0.20→0.16, a touch
                           //   more transparent); real rubber smoke is airy, never hides
                           //   the car. Slide keeps its ×0.6 alphaMul (still thinner than burnout).
  smokeDrift: 0.8,         // m/s random drift velocity
  smokeInheritVel: 0.25,   // fraction of car velocity inherited

  // ---------- GRASS dust (circuit only, dig-gated) ----------
  // Grass does NOT billow like a flattrack: a wheel DIGGING into turf throws a small,
  // short brown puff, not a dust cloud. Same mechanism/colour family as the dirt oval,
  // dialled right down. Emission is strictly gated on digging (wheelspin OR lateral slip)
  // — rolling calmly over grass emits NOTHING. TUNE:
  grassDustScale: 0.28,    // × the dirt oval's emission rate (the ONE rate knob)
  grassDustSize: 0.8,      // × particle size (slightly smaller than rubber smoke)
  grassDustAlpha: 0.7,     // × opacity (slightly more transparent)

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
// Dug-up turf — the dirt oval's brown dust family, used by a wheel digging into grass.
export const GRASS_DUST_RGB: [number, number, number] = [170, 126, 84];

interface Particle {
  kind: 'smoke' | 'spark';
  x: number; y: number;     // meters
  vx: number; vy: number;   // m/s
  age: number; life: number;
  size: number;
  tint: [number, number, number];  // smoke colour (sparks ignore it)
  alphaMul: number;   // per-particle opacity scale (slide smoke is thinner)
}

export class Effects {
  private particles: Particle[] = [];
  private smokeCarry = 0;
  private shakeT = 0;
  private shakeMag = 0;

  // Emit smoke from a wheel position; intensity 0..1 scales the rate.
  //   inheritVel  fraction of the car's velocity a puff carries (BURNOUT ≈ 0.25 →
  //               billows behind the wheel; SLIDE = 0 → the puff is born at REST
  //               in world space and STAYS PUT while the car slides away — it
  //               marks where the tyre scrubbed the asphalt).
  //   alphaMul    per-particle opacity scale (SLIDE smoke is thinner than burnout).
  //   rateScale   scales the emission rate (SLIDE is a subtler wisp).
  emitSmoke(
    x: number, y: number, carVx: number, carVy: number,
    intensity: number, dt: number, sizeScale = 1,
    tint: [number, number, number] = DEFAULT_SMOKE_RGB,
    inheritVel: number = FX_CONFIG.smokeInheritVel, alphaMul = 1, rateScale = 1,
  ) {
    const C = FX_CONFIG;
    if (intensity <= 0) return;
    this.smokeCarry += C.smokeRatePerWheel * intensity * rateScale * dt;
    let n = Math.floor(this.smokeCarry);
    this.smokeCarry -= n;
    while (n-- > 0 && this.particles.length < C.maxParticles) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * C.smokeDrift;
      this.particles.push({
        kind: 'smoke',
        x: x + (Math.random() - 0.5) * 0.3,
        y: y + (Math.random() - 0.5) * 0.3,
        vx: carVx * inheritVel + Math.cos(a) * d,
        vy: carVy * inheritVel + Math.sin(a) * d,
        age: 0,
        // sizeScale keeps puffs MODEST near a slow/stationary car so a
        // standing burnout never fully obscures it (p10).
        life: C.smokeLife + (Math.random() - 0.5) * 2 * C.smokeLifeVar,
        size: C.smokeSize * (0.8 + Math.random() * 0.4) * sizeScale,
        tint,   // per-map surface colour (white smoke / brown dust / …)
        alphaMul,
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
          alphaMul: 1,
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
        p.size += FX_CONFIG.smokeGrow * dt;
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
        const a = FX_CONFIG.smokeAlpha * (1 - t) * p.alphaMul;
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
