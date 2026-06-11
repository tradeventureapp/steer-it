// =============================================================================
//  Steer It — 2D arcade vehicle physics  (clean-room rewrite)
// -----------------------------------------------------------------------------
//  ONE coherent model. Read top to bottom; every quantity is computed in
//  exactly one place. No stacked governors, latches, or spin subsystems.
//
//  CHARACTER: arcade-with-weight. The car has real mass and yaw inertia (you
//  feel momentum), but it grips predictably and is forgiving. It slides only
//  when PROVOKED — and every way of provoking it falls out of one tyre model.
//
//  ── FORCE FLOW (the whole model, in order) ─────────────────────────────────
//
//   inputs ─▶ steering (eased, speed-limited so the front never becomes a
//             brake at high lock+speed)
//
//   body velocity ─▶ split into FORWARD (vlong) and SIDEWAYS (vlat); yaw rate ω
//
//   FRONT tyre:  slip angle αf = (atan of front-patch velocity) − steer
//                lateral force = smooth saturating curve (tanh) toward a peak.
//                This is pure cornering grip + the player's steering / catch.
//
//   REAR tyre:   the engine drives the REAR WHEEL (its own spin state). Throttle
//                → torque → wheel spins relative to ground → longitudinal slip
//                ratio s. The rear also has a slip ANGLE αr (sideways).
//                Both share ONE grip budget via a COMBINED-SLIP FRICTION CIRCLE:
//                   nLong = s/slipPeak,  nLat = αr/slipPeak,  ρ = hypot(nLong,nLat)
//                   ρ ≤ 1  → grip:   F = grip·(nLong, −nLat)
//                   ρ > 1  → slide:  F = grip·μslide·(nLong, −nLat)/ρ
//                This single rule produces EVERYTHING:
//                  • Handbrake locks the wheel → s≈−1 → nLong huge → ρ huge →
//                    lateral term collapses → the rear snaps OUT. (slide-starter)
//                  • Throttle mid-corner → wheelspin → nLong grows → lateral
//                    shrinks → rear steps out (power-over); MORE throttle = wider
//                    angle, LESS = the wheel regrips and the angle tightens.
//                  • Launch: at rest, full throttle drive exceeds the budget →
//                    wheelspin (burnout); half throttle stays under it → clean
//                    grip launch. The threshold is exactly `burnoutThrottle`
//                    (drive is sized so throttle·peak = budget at that value).
//                  • Anti-perma-burnout: once the wheel spins up, the power-
//                    limited drive (P/wv) falls BELOW the sliding reaction, so a
//                    spinning wheel always decelerates back to grip. No gate.
//
//   BODY:        sum tyre + drag + rolling forces in the body frame (with the
//                vlat·ω / vlong·ω cornering coupling), integrate vlong/vlat;
//                yaw torque = a·F_front_lat − b·F_rear_lat → integrate ω;
//                rotate to world, integrate position.
//
//   THE ONE ASSIST (CONFIG.stabilityAid): the player steers by tilting a phone
//   and cannot make fast micro-corrections, so a real unstable drift would be
//   uncatchable. We add ONE gentle, isolated aid: QUADRATIC YAW DAMPING — a
//   torque −k·ω·|ω| that is negligible during normal cornering (small ω) but
//   firmly resists a fast spin-up (large ω). It only ever REMOVES rotational
//   energy — it never points the car or adds motion the player didn't command.
//   Toggle it off with stabilityAid:false and the raw tyre model remains.
//
//  All units SI: metres, seconds, kilograms, newtons, radians.
//  Heading 0 = +x, +π/2 = +y. Steer +1 = right. Tunables live in CONFIG.
// =============================================================================

export const CONFIG = {
  // ---------- Mass / geometry ----------
  mass: 1200,                 // kg
  wheelbase: 2.6 / 3,         // m, front↔rear axle distance (1/3-scale car)
  trackWidth: 1.6 / 3,        // m, left↔right wheel distance (render only)
  // Yaw inertia = yawInertiaScale · m · L²/12. The 1/3 wheelbase makes L² tiny,
  // so without the scale the car would snap around the instant the rear stepped
  // out. ~600 kg·m² gives the rotation WEIGHT — a slide builds, it doesn't flick.
  yawInertiaScale: 9.0,

  // ---------- Engine ----------
  // The rear drive force vs WHEEL speed is a two-region curve:
  //   force = min(peakDrive, enginePower / max(1, |wheelSpeed|))
  // peakDrive is DERIVED so a standing launch breaks traction exactly at
  // `burnoutThrottle`: peakDrive = rearGrip / burnoutThrottle  (see step()).
  // Below burnoutThrottle the launch grips; at/above it the rear lights up.
  burnoutThrottle: 0.9,       // throttle at which a standing launch starts to spin
  enginePower: 85000,         // W — sets the power-limited falloff + top speed

  // ---------- Brakes / reverse ----------
  brakeForce: 20000,          // N, service brake (front+rear share)
  brakeRearShare: 0.35,       // fraction of the brake applied at the rear WHEEL
  handbrakeForce: 32000,      // N of rear-wheel brake torque — locks it decisively
  reverseForce: 4500,         // N of reverse drive once stopped on the brake
  maxReverseSpeed: 6,         // m/s reverse cap
  reverseEngageSpeed: 0.4,    // m/s — at/below this, a held brake means REVERSE

  // ---------- Rear tyre (driven, friction circle) ----------
  rearGrip: 15000,            // N — the shared long/lat grip budget (~1.25g). High enough that
                              //   normal cornering stays PLANTED and throttle-controlled drifts
                              //   are smoothly controllable (vs a lower budget that makes the rear
                              //   twitchy). Throttle-only power-over is therefore mild — the
                              //   handbrake is the deliberate, primary slide-starter.
  muSlide: 0.55,              // kinetic/peak grip while SLIDING (ρ>1). Lower than 1 gives the
                              //   grip→slide hysteresis that lets a provoked drift SUSTAIN on
                              //   throttle (the loose rear stays loose) and recover on lift —
                              //   it only touches the sliding region, so normal grip is untouched.
  slideEase: 0.35,            // smooths the grip→slide knee (no kink at ρ=1)
  slipRatioPeak: 0.15,        // longitudinal slip ratio at the grip limit
  rearSlipPeak: 0.28,         // rad (~16°) — lateral slip angle at the grip limit
                              //   (low = STIFF rear → planted, low-slip cornering; the big
                              //   rearGrip budget still gives a late break-loose)
  wheelMass: 15,              // effective rear-wheel inertia (as linear mass)
  slipDenomFloor: 3.0,        // m/s floor under the slip-ratio denominator
  maxSlipRatio: 2.5,          // clamp on wheel over/under-speed

  // ---------- Front tyre (steered, pure lateral) ----------
  frontGrip: 11000,           // N peak lateral — turn-in + countersteer authority
  frontSlipPeak: 0.20,        // rad — softer than the rear → mild forgiving understeer

  // ---------- Steering ----------
  // Max lock shrinks with FORWARD speed so a steered front at speed can't demand
  // a huge slip angle (which would point its force backward = a brake — the real
  // bug this prevents). Gating on FORWARD speed means a deep drift (low vlong,
  // high sideways speed) keeps full lock for countersteer.
  maxSteer: 0.62,             // rad (~36°) full lock at low speed
  maxSteerAtSpeed: 0.20,      // rad (~11°) lock at/above steerLimitHigh — gentle, stable lock at
                              //   speed; keeps the front well short of the high-lock angle where
                              //   it would act as a brake, and preserves countersteer feel
  steerLimitLow: 4.0,         // m/s — below: full lock
  steerLimitHigh: 17.0,       // m/s — at/above: maxSteerAtSpeed
  steerEaseRate: 8.0,         // rad/s — how fast the wheel actuates to target

  // ---------- Resistance ----------
  dragCoeff: 2.5,             // air drag  F = dragCoeff · v · |v|
  rollingResistance: 55,      // rolling drag  F = rollingResistance · v

  // ---------- THE ONE STABILITY AID ----------
  // Quadratic yaw damping (see header). Set stabilityAid:false to disable.
  stabilityAid: true,
  yawDamp: 0.20,              // torque/inertia coeff: −yawDamp·ω·|ω| (rad/s²)

  // ---------- HUD / skid reporting (consumed by the renderer) ----------
  slipThresholdForSkid: 0.12, // rad rear slip → DRIFT badge + skid marks
  slipReportSpeedGate: 1.5,   // m/s — reported lateral slip reads 0 below this…
  slipReportRampWidth: 0.6,   // …ramping to full over this band (kills park noise)

  // ---------- Obstacle collision (arcade bounce) ----------
  carCollisionRadius: 0.85,   // m
  collisionRestitution: 0.35, // normal bounce (0..1)
  collisionTangentFriction: 0.12,
  collisionPushOut: 0.02,     // m extra separation after push-out
  collisionYawDamp: 0.35,     // yaw kill at a full-strength impact

  // ---------- Render / input bridge (unchanged; not physics) ----------
  pxPerMeter: 22,
  inputLerp: 0.18,            // desktop steer smoothing (read by desktop.ts)
};

export type Config = typeof CONFIG;

export interface CarState {
  // Pose
  x: number;                  // m
  y: number;                  // m
  heading: number;            // rad

  // Motion
  vx: number;                 // m/s (world)
  vy: number;                 // m/s (world)
  angularVel: number;         // rad/s (yaw rate)

  // Actuators / wheel state
  steerAngle: number;         // rad, front wheel angle (eased toward target)
  rearWheelSpeed: number;     // m/s, rear contact-patch speed (the spin state)

  // Derived each step (renderer / HUD / sound / skids consume these)
  speed: number;              // m/s, |velocity|
  forwardSpeed: number;       // m/s, body-forward velocity (signed)
  frontSlip: number;          // rad, front slip angle (gated, signed)
  rearSlip: number;           // rad, rear slip angle (gated, signed) — DRIFT/skid
  slipRatio: number;          // rear longitudinal slip (+ spin, − lock)
  wheelSpin: number;          // 0..1, |slipRatio| clamped — HUD "WSPIN %", smoke
  isFrontSliding: boolean;
  isRearSliding: boolean;     // friction circle saturated (ρ > 1)
}

export interface Inputs {
  steer: number;              // -1..1, +1 = full right
  throttle: number;           // 0..1
  brake: number;              // 0..1
  handbrake: boolean;
}

export function makeCar(x: number, y: number, heading: number = -Math.PI / 2): CarState {
  return {
    x, y, heading,
    vx: 0, vy: 0, angularVel: 0,
    steerAngle: 0,
    rearWheelSpeed: 0,
    speed: 0, forwardSpeed: 0,
    frontSlip: 0, rearSlip: 0,
    slipRatio: 0, wheelSpin: 0,
    isFrontSliding: false, isRearSliding: false,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// =============================================================================
//  step(): one fixed-timestep update. Call with a FIXED dt (e.g. 1/60).
// =============================================================================
export function step(car: CarState, input: Inputs, dt: number, c: Config = CONFIG) {
  const halfWB = c.wheelbase / 2;                 // CG↔axle (symmetric)
  const yawInertia = c.yawInertiaScale * c.mass * c.wheelbase * c.wheelbase / 12;

  // ---- 1. Body-frame velocity --------------------------------------------
  const cosH = Math.cos(car.heading), sinH = Math.sin(car.heading);
  let vlong =  car.vx * cosH + car.vy * sinH;     // forward (+ = ahead)
  let vlat  = -car.vx * sinH + car.vy * cosH;     // sideways (+ = left)
  const omega = car.angularVel;
  const speed = Math.hypot(car.vx, car.vy);

  // ---- 2. Steering: ease toward a SPEED-LIMITED target -------------------
  // Lock shrinks with FORWARD speed so the front can't over-slip into a brake;
  // a deep drift (low forward speed) keeps full lock for countersteer.
  const lockT = clamp(
    (Math.abs(vlong) - c.steerLimitLow) / (c.steerLimitHigh - c.steerLimitLow), 0, 1);
  const maxSteerNow = c.maxSteer + (c.maxSteerAtSpeed - c.maxSteer) * lockT;
  const steerTarget = clamp(input.steer, -1, 1) * maxSteerNow;
  const dSteer = clamp(steerTarget - car.steerAngle,
    -c.steerEaseRate * dt, c.steerEaseRate * dt);
  car.steerAngle += dSteer;
  const delta = car.steerAngle;
  const sinD = Math.sin(delta), cosD = Math.cos(delta);

  // ---- 3. Slip angles ----------------------------------------------------
  // The slip angle is between a wheel's heading and the velocity OF ITS contact
  // patch. Computing it in the WHEEL frame makes it (and its force) vanish at
  // rest — a wheel turned while parked must make NO force (the old bug: a raw
  // −delta term drove a parked car sideways). A small denominator floor keeps
  // it finite at very low speed.
  const fpx = vlong, fpy = vlat + omega * halfWB;          // front patch (body)
  const fwLong = fpx * cosD + fpy * sinD;                  // …into wheel frame
  const fwLat  = -fpx * sinD + fpy * cosD;
  const frontSlip = Math.atan2(fwLat, Math.max(0.6, Math.abs(fwLong)));
  const rearLatV = vlat - omega * halfWB;                  // rear patch (no steer)
  const rearSlip = Math.atan2(rearLatV, Math.max(0.6, Math.abs(vlong)));

  // ---- 4. FRONT tyre: smooth saturating lateral force (wheel frame) -------
  // tanh curve → no kink at the limit (smoothness), saturates at ±frontGrip.
  const frontForce = -c.frontGrip * Math.tanh(frontSlip / c.frontSlipPeak);
  const isFrontSliding = Math.abs(frontSlip) > c.frontSlipPeak * 1.5;

  // ---- 5. REAR wheel: engine drive vs brake, then the friction circle ----
  const reverseMode = input.brake > 0.05 && !input.handbrake &&
    vlong <= c.reverseEngageSpeed;

  // Drive force at the rear contact patch (cut by handbrake / reverse so the
  // wheel can actually lock). peakDrive is sized so throttle == burnoutThrottle
  // puts the launch drive exactly at the grip budget.
  const peakDrive = c.rearGrip / c.burnoutThrottle;
  const wv = car.rearWheelSpeed;
  const drive = (input.handbrake || reverseMode) ? 0 :
    input.throttle * Math.min(peakDrive, c.enginePower / Math.max(1, Math.abs(wv)));

  // Brake torque on the rear wheel (service share + handbrake lock).
  const wheelBrake = (reverseMode ? 0 : input.brake * c.brakeForce * c.brakeRearShare) +
    (input.handbrake ? c.handbrakeForce : 0);
  const dwBrake = (dt / c.wheelMass) * wheelBrake;
  const brakeWheel = (w: number) => w > 0 ? Math.max(0, w - dwBrake) : w;

  const denom = Math.max(c.slipDenomFloor, Math.abs(vlong));
  const nLat = rearSlip / c.rearSlipPeak;

  // Wheel-speed update. The grip region is numerically stiff (tiny wheel inertia
  // vs a steep force/slip slope), so integrate it IMPLICITLY for stability:
  //   reaction = k·(wv − vlong),  k = rearGrip / (slipPeak · denom)
  const k = c.rearGrip / (c.slipRatioPeak * denom);
  let wvNew = (wv + (dt / c.wheelMass) * (drive + k * vlong)) / (1 + (dt * k) / c.wheelMass);
  wvNew = brakeWheel(wvNew);

  let s = (wvNew - vlong) / denom;
  let nLong = s / c.slipRatioPeak;
  let rho = Math.hypot(nLong, nLat);
  const isRearSliding = rho > 1;

  let rearLong: number, rearLat: number;
  if (!isRearSliding) {
    // Grip: linear inside the circle.
    rearLong =  c.rearGrip * nLong;
    rearLat  = -c.rearGrip * nLat;
  } else {
    // Slide: force saturates at the kinetic level, smoothly (no knee), pointed
    // opposite the COMBINED slip vector. scale(1)=1 (continuous with grip),
    // decaying toward muSlide/ρ as the slide deepens.
    const scale = (c.muSlide + (1 - c.muSlide) * Math.exp(-(rho - 1) / c.slideEase)) / rho;
    rearLong =  c.rearGrip * scale * nLong;
    rearLat  = -c.rearGrip * scale * nLat;
    // The implicit predictor assumed the full linear reaction; while saturated
    // the real reaction is the smaller kinetic force — re-integrate the wheel
    // explicitly against it (this is where the wheel actually SPINS UP).
    wvNew = wv + (dt / c.wheelMass) * (drive - rearLong);
    if ((wv - vlong) * (wvNew - vlong) < 0) wvNew = vlong; // clamp the crossing
    wvNew = brakeWheel(wvNew);
  }

  // Clamp wheel over/under-speed and recompute the reported slip.
  wvNew = clamp(wvNew, vlong - c.maxSlipRatio * denom, vlong + c.maxSlipRatio * denom);
  car.rearWheelSpeed = wvNew;
  s = (wvNew - vlong) / denom;

  // ---- 6. Front force into body frame (force ⟂ to the steered wheel) -----
  // A steered front force has a backward (drag) component −F·sin δ; the speed-
  // limited lock above keeps δ small at speed so this never becomes a brake.
  const frontBodyX = -frontForce * sinD;
  const frontBodyY =  frontForce * cosD;

  // ---- 7. Reverse drive (arcade): a held brake at rest backs the car up --
  let reverseBodyX = 0;
  if (reverseMode && vlong > -c.maxReverseSpeed) {
    reverseBodyX = -input.brake * c.reverseForce;
  }

  // ---- 8. Resistance (opposes velocity) ----------------------------------
  const dragX = -c.dragCoeff * speed * vlong - c.rollingResistance * vlong;
  const dragY = -c.dragCoeff * speed * vlat  - c.rollingResistance * vlat;

  // ---- 9. Newton: body-frame accelerations (with cornering coupling) -----
  const Fx = rearLong + frontBodyX + reverseBodyX + dragX;
  const Fy = rearLat  + frontBodyY + dragY;
  vlong += (Fx / c.mass + vlat * omega) * dt;
  vlat  += (Fy / c.mass - vlong * omega) * dt;

  // ---- 10. Yaw: tyre torque, then the ONE stability aid -------------------
  const torque = halfWB * frontBodyY - halfWB * rearLat;
  let omegaNew = omega + (torque / yawInertia) * dt;
  // Quadratic yaw damping — the single declared assist. Negligible at small ω
  // (normal cornering), firm at large ω (catches a spin). Pure energy removal.
  if (c.stabilityAid) {
    omegaNew -= c.yawDamp * omegaNew * Math.abs(omegaNew) * dt;
  }
  car.angularVel = omegaNew;

  // ---- 11. Integrate pose -------------------------------------------------
  car.vx = vlong * cosH - vlat * sinH;
  car.vy = vlong * sinH + vlat * cosH;
  car.heading += omegaNew * dt;
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  // ---- 12. Snap to a clean rest state ------------------------------------
  if (Math.abs(car.vx) < 0.01) car.vx = 0;
  if (Math.abs(car.vy) < 0.01) car.vy = 0;
  if (Math.abs(car.angularVel) < 0.004) car.angularVel = 0;

  // ---- 13. Derived state for HUD / skids / sound / smoke ------------------
  car.speed = Math.hypot(car.vx, car.vy);
  car.forwardSpeed = vlong;
  // Lateral slip is meaningless near standstill (atan2 of noise) — gate it so a
  // parked car shows no phantom DRIFT / smoke. Longitudinal wheelspin is NOT
  // gated (a standing burnout legitimately spins at zero ground speed).
  const slipGate = clamp(
    (car.speed - (c.slipReportSpeedGate - c.slipReportRampWidth)) / c.slipReportRampWidth, 0, 1);
  car.frontSlip = frontSlip * slipGate;
  car.rearSlip = rearSlip * slipGate;
  car.slipRatio = s;
  car.wheelSpin = isRearSliding ? Math.min(1, Math.abs(s)) : 0;
  car.isFrontSliding = isFrontSliding && car.speed > 1;
  car.isRearSliding = isRearSliding && car.speed > 0.3;
}

// =============================================================================
//  World helpers (unchanged behaviour — geometry/collision, not the car model)
// =============================================================================
export function bodyToWorld(car: CarState, bx: number, by: number): { x: number; y: number } {
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  return { x: car.x + bx * c - by * s, y: car.y + bx * s + by * c };
}

export interface ObstacleRect { x: number; y: number; w: number; h: number; }

// Car-as-circle vs axis-aligned rects: positional push-out + arcade bounce
// (restitution on the normal, light friction on the tangent, yaw calmed by
// impact strength). Returns the strongest normal impact speed (0 = no hit).
export function collideWithRects(
  car: CarState, rects: ObstacleRect[], c: Config = CONFIG,
): number {
  const R = c.carCollisionRadius;
  let strongest = 0;
  for (const r of rects) {
    const px = clamp(car.x, r.x, r.x + r.w);
    const py = clamp(car.y, r.y, r.y + r.h);
    const dx = car.x - px, dy = car.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) continue;

    let nx: number, ny: number, pen: number;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      nx = dx / d; ny = dy / d; pen = R - d;
    } else {
      const left = car.x - r.x, right = r.x + r.w - car.x;
      const top = car.y - r.y, bottom = r.y + r.h - car.y;
      const m = Math.min(left, right, top, bottom);
      if (m === left)       { nx = -1; ny = 0; pen = R + left; }
      else if (m === right) { nx =  1; ny = 0; pen = R + right; }
      else if (m === top)   { nx = 0; ny = -1; pen = R + top; }
      else                  { nx = 0; ny =  1; pen = R + bottom; }
    }

    car.x += nx * (pen + c.collisionPushOut);
    car.y += ny * (pen + c.collisionPushOut);
    const vn = car.vx * nx + car.vy * ny;
    if (vn < 0) {
      const tx = car.vx - vn * nx, ty = car.vy - vn * ny;
      const tf = 1 - c.collisionTangentFriction * Math.min(1, -vn / 5);
      const bounce = -vn * c.collisionRestitution;
      car.vx = tx * tf + nx * bounce;
      car.vy = ty * tf + ny * bounce;
      car.angularVel *= 1 - c.collisionYawDamp * Math.min(1, -vn / 10);
      strongest = Math.max(strongest, -vn);
    }
  }
  return strongest;
}
