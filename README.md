# Steer It

Phone-as-steering-wheel mini-game. Open the desktop URL on your computer, scan
the QR with your phone, tilt the phone, and the car on the desktop turns
smoothly in real time.

This repo is the first vertical slice — just the core "tilt-to-steer" loop. No
obstacles, no scoring, no second player. Yet.

## Stack

- **Vite + TypeScript** (vanilla, no framework)
- **HTML Canvas 2D** for rendering
- **@supabase/supabase-js** Realtime broadcast as the phone → desktop transport
- **qrcode** for the join QR

## Run locally

1. Create a Supabase project (free tier is fine). In **Project Settings → API**,
   copy the **Project URL** and the **anon public key**.
2. Copy `.env.example` to `.env` and fill in:

   ```
   VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
   ```

3. Install and run:

   ```
   npm install
   npm run dev
   ```

4. Open `http://localhost:5173/` on your desktop. A QR code and a 4-character
   code appear in the top-right.

## Phone testing (HTTPS required)

The `deviceorientation` API only fires on **HTTPS**, and iOS additionally
requires an explicit user-gesture permission prompt (already wired up via the
**TAP TO STEER** button). For phone testing on real hardware:

- **Vercel preview deploy** (easiest): `vercel` then scan the QR on the deploy.
  This repo includes a `vercel.json` that rewrites `/play` → `/play.html`.
- **HTTPS tunnel** to your local dev server: e.g.
  `cloudflared tunnel --url http://localhost:5173` or
  `ngrok http 5173`, then open the tunnel URL on the desktop and scan its QR.

Plain `http://<your-LAN-ip>:5173` will **not** work on the phone — iOS will
silently drop the orientation events, Android will throw a permission error.

## How it works

- Desktop generates a random 4-char code and opens a Supabase Realtime channel
  named `steer:<CODE>`. It renders the QR (`/play?s=<CODE>`).
- Phone reads `?s=<CODE>` from the URL, joins the same channel, and broadcasts
  `{ type: "tilt", gamma }` at ~30/s where `gamma` is left/right tilt in
  degrees.
- Desktop maps `gamma` → a target turn rate (with a small deadzone) and eases
  the actual turn rate toward it each frame (`lerp ~ 0.15`). The render loop
  runs at 60fps via `requestAnimationFrame` and is fully decoupled from the
  network update rate, so motion stays smooth even if updates arrive choppy.

## Project layout

```
index.html          # desktop entry — canvas + QR
play.html           # phone entry — unlock button + tilt
src/
  desktop.ts        # render loop, smoothing, car drawing
  phone.ts          # tilt capture + throttled broadcast
  supabase.ts       # shared Realtime client
  style.css         # shared styles
vite.config.ts      # /play → /play.html rewrite (dev) + multi-page build
vercel.json         # /play → /play.html rewrite (prod)
```
