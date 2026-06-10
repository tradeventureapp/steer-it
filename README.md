# Steer It

Phone-as-steering-wheel mini-game. Open the desktop URL on your computer, scan
the QR with your phone, **rotate the phone to landscape**, then:

- **Right side of phone** = throttle (press to accelerate)
- **Left side of phone**  = brake
- **Tilt** the phone left/right to steer

The desktop runs a GRID-style 2D vehicle model (proper longitudinal +
lateral tire dynamics) — heavy car, gradual acceleration, coast on momentum,
and a catchable rear-bias drift when you push it too hard into a corner.

This is still a pre-game vertical slice. No obstacles, no scoring, no second
player. The point of this slice is to nail the **driving feel**.

## Stack

- **Vite + TypeScript** (vanilla)
- **HTML Canvas 2D** for rendering
- **@supabase/supabase-js** Realtime broadcast as the phone → desktop transport
- **qrcode** for the join QR

## Run locally

1. Create a Supabase project (free tier is fine). In **Project Settings → API**
   copy the **Project URL** and the **anon public key**.
2. Copy `.env.example` to `.env` and fill it in:

   ```
   VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
   ```

3. Install and run:

   ```
   npm install
   npm run dev
   ```

4. Open `http://localhost:5173/` on your desktop. The QR appears top-right
   with a 4-character join code.

## Phone testing (HTTPS required)

`deviceorientation` only fires over **HTTPS**, and iOS requires an explicit
user-gesture permission prompt (already wired up via the **TAP TO STEER**
button). For phone testing on real hardware:

- **Vercel preview deploy** (easiest): `vercel`. `vercel.json` rewrites
  `/play` → `/play.html` for you.
- **HTTPS tunnel** to your local dev server, e.g.
  `cloudflared tunnel --url http://localhost:5173`, then open the tunnel URL on
  the desktop and scan its QR with the phone.

Plain `http://<your-LAN-ip>:5173` will **not** work on phone — iOS silently
drops the orientation events, Android throws a permission error.

## How the physics work

`src/physics.ts` is a 2D bicycle model with split longitudinal & lateral
forces.

- **Wheelspin drives the drift**: the engine spins the REAR WHEEL, not the
  body — rear wheel speed is tracked separately from ground speed and force
  is transmitted through tire friction. Throttle can spin the rear faster
  than the ground (slip ratio), especially at launch or mid-corner.
- **Friction circle**: the rear tire has one grip budget shared between
  longitudinal (wheelspin / braking) and lateral (cornering) force. Wheelspin
  consumes the budget → lateral grip collapses → the rear steps out. Lift →
  the wheel grips up → the budget swings back to lateral → the car
  straightens. **Throttle steers the drift angle.**
- **Handbrake** locks the rear wheel; the locked wheel's slip eats the
  friction budget the same way, snapping the rear loose for drift entries.
- **Front lateral**: linear cornering force `F = -stiffness * slip` capped at
  a peak; past the cap a kinetic-friction multiplier applies. Front grip is
  strong so countersteer has the authority to catch slides.
- **Steering**: tilt sets a *target* front-wheel angle. The actual front
  wheels ease toward target at `steerSpeed` rad/s. Authority tapers at high
  speed via `steerSpeedFalloff`.
- **Fixed timestep**: physics runs at 60 Hz inside an accumulator loop,
  fully decoupled from `requestAnimationFrame`. The stiff wheel-speed
  dynamics are integrated implicitly so they're stable at any frame rate.

### Tuning

Every knob lives in the `CONFIG` object at the top of `src/physics.ts`. Pick
one number, save, hot-reload. Common tweaks:

| To make the car... | Change |
| --- | --- |
| Heavier / less nimble | `mass ↑` or `inertiaScale ↑` |
| More accelerative | `enginePower ↑` |
| Coast longer | `dragCoeff ↓`, `rollingResistance ↓` |
| Easier to break into drift | `tireGripBudgetRear ↓` or `slipRatioPeak ↓` |
| More violent burnout launches | `lowSpeedTorqueBoost ↑` |
| Sharper throttle→drift response | `wheelSpinInertia ↓` |
| Drift retains more energy | `driftFriction ↑` |
| Softer handbrake | `handbrakeLockForce ↓` |
| Snappier steering | `steerSpeed ↑` |
| Less twitchy on phone tilt | `tiltSensitivity ↑` (more tilt for same input) |

### Visual feedback

- **Speedometer** (bottom-left) — fake km/h from `speed * 3.6`.
- **GRIP/DRIFT badge** plus live **SLIP** (rear slip angle) and **WSPIN**
  (rear wheelspin %) readouts for tuning.
- **Skid marks** are drawn to a persistent offscreen canvas every physics
  step from each rear wheel while sliding — including straight-line burnout
  marks when the rear is lit up. Skids are the single best signal for
  whether the drift feels right.

## Project layout

```
index.html          # desktop entry — canvas + QR + HUD
play.html           # phone entry — unlock + landscape pedals
src/
  desktop.ts        # control input, fixed-step loop, render, skids
  phone.ts          # tilt + landscape pedals (multi-touch) + broadcast
  physics.ts        # CONFIG + bicycle-model step()
  supabase.ts       # shared Realtime client
  style.css         # shared styles (white desktop, dark phone)
vite.config.ts      # /play → /play.html dev rewrite + multi-page build
vercel.json         # /play → /play.html prod rewrite
```
