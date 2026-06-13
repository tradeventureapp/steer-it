# CLAUDE.md — Steer It

> Claude Code reads this file at the start of every session. It holds context, rules,
> status, and key decisions so work doesn't start from zero and old mistakes aren't repeated.
> **Rule: update this file after every significant step.**

---

## 1. What the project is

**Steer It** — a viral browser game. The player drifts a car across a fake "desktop"
environment; the phone is the steering wheel (tilt / gyro steering). Multiplayer:
several people around one monitor, each phone = their own car. Target situation:
"two–three people at school / on a work break scan a QR and play together."

Core hook: **phone as a steering wheel + drifting across a desktop + zero-friction QR join.**

Domain (goal): `steerit.app`. Currently running on `steer-it.vercel.app`.

---

## 2. Stack & architecture

- **Frontend:** Vite + vanilla TypeScript + Canvas 2D (no framework, no Phaser)
- **Realtime transport:** Supabase Realtime Broadcast (phone <-> desktop). Chosen over
  WebRTC because WSS:443 passes through school firewalls.
- **Hosting:** Vercel (paid Pro plan)
- **Repo:** github.com/tradeventureapp/steer-it (PRIVATE)

### Entry points
- `index.html` → loads `src/desktop.ts` (the PC / game surface).
- `play.html` → loads `src/phone.ts` (the phone controller). The QR points at
  `${VITE_PUBLIC_BASE_URL}/play?s=<CODE>`.
- `src/style.css` — all styling (desktop HUD, QR panel, editor, phone UI).

### Key files (all source under `src/`)
- `physics.ts` — vehicle model (drift physics). THE CORE — see rules below. Exports
  `CONFIG`, `makeCar`, `step`, `collideWithRects`, `bodyToWorld`, types `CarState`/`Inputs`.
- `desktop.ts` — game surface (authority): fixed-timestep loop, per-slot car map,
  render, obstacle + car-car collisions, car drawing, HUD, skids/smoke, the track
  editor (key E), lobby wiring, QR.
- `phone.ts` — phone controller: gyro steering (gravity vector), analog pedals,
  handbrake, lobby UI (slot/color/name pick), control broadcast.
- `world.ts` — the drawn desktop: `layoutDesktop`, `drawWallpaper`, `drawOverlay`,
  `drawClock`, collision rects (`rebuildRects`), icon hit-test/drag
  (`iconAt`/`clampIconToBounds`/`resolveIconDrop`), types `DesktopWorld`/`DesktopIcon`.
- `maps.ts` — MAP SYSTEM. `MapDefinition` (background/obstacles/spawn/bounds/wrap/
  drag), a registry (`registerMap`/`getMap`/`listMaps`/`hasMap`, `DEFAULT_MAP_ID`),
  `desktopMap` (map 1, delegating to `world.ts`), and `flatTrackMap` (map 2 — a
  STADIUM dirt oval via `computeStadium`/`stadiumPath`/`stadiumBarriers`: straights
  + semicircle turns; barriers ONLY on the inner/outer edges (straights = thin
  rects, turns = small squares strictly off-band) so the band drives freely;
  grandstands/neon banners/floodlights decor; grid spawn on the start line).
  Per-map smoke tint via `MapDefinition.smokeColor` ([r,g,b], default white):
  desktop = white rubber smoke, flat = brown dust (`effects.ts` stores the tint
  per particle).
  desktop.ts reads everything through the active `MapDefinition`; `switchMap(id)`
  swaps it. Dev hooks: `window.steerMaps()` / `window.steerSwitchMap(id)`.
- `lobby.ts` — N-player lobby state machine (`LobbyState`): slots, colors, names,
  join/leave/sweep/reclaim. Pure (no DOM/transport). Config + `EV` event names live here.
- `cars.ts` — multiplayer math (pure): `spawnOffset`/`spawnPose` (non-overlapping
  spawn grid), `collidePairCars`/`collideCars` (clamped arcade bounce), `applyInputs`
  (clamp/merge for the control router).
- `race.ts` — race logic (pure): `RaceState` (start/checkpoint/finish passage
  detection, laps, sprint/circuit), editor mutators (`placeElement`,
  `removeElementAt`, `clearElements`, `findElementIndexAt`, `renumberCheckpoints`,
  `countCheckpoints`), `isCircuitTrack`, `formatRaceTime`, `RACE_CONFIG`.
- `effects.ts` — particles (tire smoke, impact sparks, screen shake). Global hard cap
  (`FX_CONFIG.maxParticles`); emission stops at the cap.
- `sound.ts` — `SoundEngine` (WebAudio). OFF by default; toggled by the M key / button.
- `supabase.ts` — Supabase client + `channelName(code)` + `createResilientChannel`
  (auto-reconnect wrapper: 15s heartbeat keepalive, and on CLOSED/TIMED_OUT/
  CHANNEL_ERROR it removes + re-creates + re-wires + re-subscribes a fresh channel
  for the same room with backoff — survives the ~60s Realtime idle drop without a
  QR rescan). Throws if `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are missing
  (this gates the whole app, so headless preview without env vars won't boot).
  The desktop gates its idle-sweep on channel health (`channelReady` + a reconnect
  grace) so its OWN dropped channel never mass-frees every slot.

### Build / test / run commands
- `npm run dev` — Vite dev server (port 5173).
- `npm run build` — `tsc && vite build` (type-check THEN bundle).
- `npm run preview` — serve the production build.
- Type-check only: `npx tsc --noEmit`.
- **Env:** copy `.env.example` → `.env` with `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`, and (for prod) `VITE_PUBLIC_BASE_URL`. `.env` is gitignored.
- **Tests:** no test runner is configured (no `test` script, no vitest/jest). The pure
  modules (`lobby.ts`, `race.ts`, `cars.ts`) are written to be unit-testable and are
  smoke-tested ad-hoc by bundling the REAL module with esbuild into a temp `.mjs` and
  asserting in Node (these scratch test files are not committed). esbuild ships with Vite.

### Key constants (read from code — change these, not hidden gates)
- `PLAYER_CAP = 8` (lobby.ts) — max simultaneous players (built for N; tested with 2).
- `CAR_COLORS` — 10 neon colors (lobby.ts); `defaultColorForSlot` wraps for N > 10.
- `NAME_MAX = 12`, `IDLE_TIMEOUT_MS = 6000`, `PHONE_HEARTBEAT_MS = 1200`,
  `LOBBY_SYNC_MS = 2000` (lobby.ts).
- `STEER_EXPO = 1.7` (phone.ts) — tilt expo curve `steer = sign(t)·|t|^1.7`.
- `RACE_CONFIG = { laps: 1, maxCheckpoints: 5, gateRadius: 1.7 }` (race.ts); laps clamped 1–10.
- `SPAWN_GAP = 2.4` m (cars.ts) — > 2× `carCollisionRadius`, so spawns never overlap.
- `CONFIG.pxPerMeter = 22`, `CONFIG.carCollisionRadius = 0.85` (physics.ts). Physics
  body is the 1/3-scale car (`wheelbase 2.6/3`, `trackWidth 1.6/3`).
- `FX_CONFIG.maxParticles = 340` (effects.ts) — shared cap across all cars.
- Car-car bounce (cars.ts): restitution `0.35`, impulse clamp `6`, 2 relaxation passes.

### Multiplayer architecture principle
**The desktop (PC) is the authority.** It owns world state (slots, car positions, colors,
names). Phones only send input and receive state. The desktop assigns slots (no race
conditions; a phone never self-assigns a slot). Control packets are tagged with the
phone's `id`; the desktop routes each by its OWN `id → slot` map (the phone's
self-reported slot is not trusted). Broadcast events (`EV` in lobby.ts):
phone→desktop `join | color | name | leave | control`; desktop→phone `lobby | full`.

---

## 3. RULES & PRINCIPLES (important — so old mistakes aren't repeated)

### Physics
- **A car must behave like a car.** Model = honest physics: throttle -> engine torque
  -> wheels -> tire friction (friction circle) -> body forces.
- **The car's character is tuned via PARAMETERS** (power, grip, mass), NEVER via
  artificial gates / conditions / if-then patches in the force path.
- **NO PATCHES.** This lesson cost ~a week: 15 physics passes accumulated into a tower
  of governors/latches/thresholds that interacted badly. It ended in a full rewrite
  (which also failed and was reverted). Goal: realistic physics + satisfying drift,
  achieved by tuning parameters.
- **Assists may exist, but: named, isolated from the core, toggleable, and a last resort.**
  An assist may AMPLIFY/STABILIZE what the player is doing — never add motion/energy the
  player didn't command. (Drift is an unstable equilibrium; on phone-tilt it needs one
  gentle stability aid — that's OK, it's isolated.) The declared assist is the "governed
  drift mode" in `step()` (slip-angle + speed governor, latches on a provoked slide) plus
  auto-countersteer — both layered on the honest tire forces, neither adds energy.
- Physics is currently LOCKED at a "good enough" version (pre-rewrite state, tag
  `pred-prepisem-fyziky`). Don't touch with big rewrites — only small targeted parameter changes.

### Multiplayer / general
- **Build for N, not hardcoded for 2.** Slots, cars, colors = array/map keyed by slot.
  Player cap = a single config (`PLAYER_CAP`). Target ~10 players, tested with 2.
- **Test live, not just in sim.** Claude Code has NO real Supabase in preview (placeholder
  creds = no WebSocket), so live transport (multiple phones connecting, sync) MUST be
  smoke-tested on real devices. Isolate logic into pure testable modules (lobby.ts,
  race.ts, cars.ts are pure and unit-tested ad-hoc — see Build/test commands).
- **Logic first, UI/tool second.** E.g. race detection -> then the editor that writes into
  it. Pause/editor (functions) -> then the interactive taskbar (the shell).
- **One thing at a time, test, then next.** Not three big things in parallel.

### Workflow
- Claude (chat) writes prompts and strategy. **Claude Code does all implementation.**
- Jakub runs prompts and pushes via git. Communication: informal Czech (chat), but
  code, commits, and this file are in English.
- Don't write Code prompts without an explicit go-ahead.
- After push: Vercel auto-rebuild -> test on phone (cache: close tab + rescan QR).

---

## 4. STATUS — DONE

- **Drift physics** — controllable; drift is provoked (handbrake primary, throttle
  in corner, flick), holds, throttle controls the angle. Locked at "good enough" (~80–85%).
- **Phone controls** — gyro steering (gravity vector, orientation-agnostic, force-landscape,
  auto-calibration), analog pedals (finger position = value, top 1/4 = saturation),
  handbrake. Steering expo curve (`STEER_EXPO = 1.7`).
- **Fake desktop** — retro Win-XP vibe (green hills, sun), yellow folders with humorous
  English names ("DO NOT DELETE!!!", "taxes_2024_final_v3"...), recycle bin, taskbar.
  Icons = solid obstacles (arcade bounce). **Icons are mouse-draggable** (= live track building).
- **Tire smoke** on drift/burnout (particles, capped at `FX_CONFIG.maxParticles = 340`).
- **Car** — top-down rally hatchback (blue / gold wheels / wing, no trademarks),
  roof number = slot number (1-based), per-slot color.
- **Logo** — retro-synthwave "STEER IT" (chrome + magenta->orange gradient, neon).
- **Neon phone UI** — TAP TO STEER + GAS/BRAKE/E-BRAKE pedals, synthwave style.
- **Main menu + map select (host front-end)** — at startup the desktop shows a
  synthwave main menu (STEER IT logo + START RACE; extensible `.menu-actions` for
  OPTIONS/LEADERBOARDS later). START RACE → map-select tiles built from
  `listMaps()`, each with a REAL rendered mini-preview; clicking a tile calls
  `switchMap(id)` and drops into gameplay. The menu freezes the sim (`menuOpen` in
  the freeze gate) and hides the QR; the QR/join panel shows only once a map is
  loaded. Host picks the map for everyone; phones are controllers only. Dev hooks
  (`steerSwitchMap`) still work. (HTML `#main-menu`/`#map-select` in index.html,
  styling in style.css, wiring in desktop.ts.)
- **Clean surface** — default shows only the game world + styled QR panel. Keys:
  **D** = debug HUD (speedo/slip/wspin/pedals), **Q** = hide QR panel, **P** = pause,
  **E** = editor, **M** = sound on/off (sound OFF by default).
- **Pause (P)** — freezes simulation + timer (not render), PAUSED overlay, phone stays
  connected. Shares one freeze gate with the editor (`refreshFreeze` in desktop.ts).
- **Race core (`race.ts`)** — start/checkpoint/finish, passage detection, time, laps,
  **sprint vs circuit** (circuit = start only, no finish, so start = finish too),
  lap count 1–10. Tested live (FINISH 0:15.3).
- **Track editor (E)** — palette [START][FINISH][CHECKPOINT][DELETE][CLEAR ALL] + a
  +/- LAPS stepper (1–10). Click = place, drag = move, delete tool removes. Status line
  shows the mode, e.g. "CIRCUIT · START ✓ · CP 0/5 · LAPS 3" or
  "SPRINT · START ✓ · FINISH ✓ · CP 2/5 · LAPS 1". No saving yet. Default surface empty.
- **Lobby (`lobby.ts`)** — N-slot, QR join, color pick (10 colors), rename, on-desktop
  roster, connect/disconnect/reclaim/full. Tested live (2nd player joined, named, readied).
- **N-car multiplayer (`cars.ts`)** — car per slot, spawn in center with offset (function
  of slot index, slot 0 dead-centre), color from slot, independent input routing,
  car-car collisions (clamped arcade bounce), connect/disconnect/reclaim. Per-car skids
  (color-tinted) + smoke. Verified through the real channel pipeline; AWAITING a
  two-device live test.
- **Map system (`maps.ts`)** — the map is a switchable `MapDefinition` (background,
  obstacles+collision, spawn, bounds+wrap, optional decor, draggable flag). The
  desktop is map 1 (`desktopMap`), behaviour byte-identical to before.
  `switchMap(id)` rebuilds world + layers, clears skids, resets the (per-map) race
  track, exits the editor, and respawns cars. **Map 2 = `flatTrackMap`** ('flat',
  90s dirt oval): brown dirt ring + green infield + purple night ground, tyre-wall
  barriers (FIXED, tessellated AABB rects), grandstands + neon ad banners (fake
  funny brands) + floodlights, 2-wide grid spawn on the start/finish line. Switch
  via `steerSwitchMap('flat')`. Dev hooks only, no menu yet.
- **Vercel/QR blocker FIXED** — the QR pointed to a protected deployment-hash URL
  (login wall for other players). Fix: the QR is built from env var `VITE_PUBLIC_BASE_URL`
  (= production domain), not window.location.origin. + disable Vercel Authentication.

---

## 5. STATUS — PENDING

1. **Two-device live test** — two cars, two real phones, steering simultaneously,
   collisions, disconnect. (Pipeline verified via simulated messages; full 2-device test missing.)
2. **Multi-car race** — race detection currently runs only on the PRIMARY (lowest-slot)
   car. Needed: per-car detection, ranking (1st/2nd/3rd), **finish/race-end only after
   ALL players finish** (not after the first), winner/ranking display, rematch.
3. **Interactive taskbar** — turn the bottom bar into a control panel (settings, launching
   editor/pause/laps via buttons instead of keys). UI shell over existing functions.
4. **REEL** — film a viral video (phone as a wheel -> multiple cars racing across the
   desktop), 10–20s, show the phone-as-wheel in the first 2s. Primarily TikTok / YT Shorts.
5. **Scaling** — BEFORE the reel verify: how many concurrent games the Supabase plan can
   hold (Realtime connection limits) under a viral spike (e.g. 3000 people in 2-3s). Vercel
   Pro handles serving; the bottleneck is Supabase. Upgrade if needed.

### After the reel (once interest is confirmed)
- More maps, screenshot of one's own desktop as background, saving/library of tracks
- Premium tier, Steam wishlist page, influencer key platforms (Keymailer/Woovit/Lurkit —
  once there's a Steam build; for now browser = direct TikTok/influencer outreach)
- Sound (4 synthesis attempts failed — deferred; the WAV pipeline stays, just drop a CC0
  recording into public/audio/. Sound is OFF by default.)
- Discord, Ludum Dare, itch.io devlogs

---

## 6. MONETIZATION (plan — do not implement until the reel confirms interest)

- **Free:** 1 map (desktop), 2-player multiplayer, basic race mode.
  (Principle: with party games, let people taste the main fun — don't hide it all behind a paywall.)
- **Premium $4.99:** 3–4+ players, all maps, track editor, battle mode, chaos mode, future content.

---

## 7. KEY DECISIONS

- Browser-first, NOT native/download (zero-friction QR; Steam possibly later as packaged
  Electron, after traction).
- The fake desktop is drawn art (the browser can't read the real desktop — security).
- Cars/tracks: may EVOKE a WRC/Impreza look+feel, but NO real logos/names/liveries.
- Spawn on the desktop map = center, multiple cars offset (no overlap).
- Track type is driven by the presence of a FINISH (finish = sprint A->B; start only = circuit).
- Success is measured by: "If you show it to three people at school, do they immediately
  want to scan the QR and play too?" — not by physics or realism.

---

## 8. KNOWN ISSUES / CAVEATS

- Physics: pure-throttle power-over is mild (race grip); drift is provoked mainly via the
  handbrake. Tunable via a parameter (`enginePower` vs the grip budget), but it trades
  against grippy corners — left as is.
- Multiplayer: with no phone connected there's no car on the surface (cars = slots, spawned
  on connect). If the host should have a car even without a phone, that's to be resolved.
- Race: detection currently runs on the PRIMARY (lowest-slot) car only — and so does the
  single engine sound / HUD / race timer (see pending item 2).
- The START gate in the editor can be hard to see against the sky (cosmetic, to polish).
- The simulation loop is `requestAnimationFrame`-driven, so it throttles in a backgrounded /
  headless tab — keep that in mind when verifying timing-dependent behavior in preview.

---

*Note for Code: keep this file current. The context / rules / decisions / monetization
sections carry knowledge not readable from code — preserve them. Technical details (file
and function names, CONFIG keys, constants, build/test commands) should be corrected to
match the actual repo whenever they drift.*
