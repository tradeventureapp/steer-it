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

Live at **`steerit.app`** (the QR is built from `VITE_PUBLIC_BASE_URL`, not the
deployment-hash URL); `steer-it.vercel.app` also serves it.

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
  handbrake, lobby UI (slot/color/name pick), control broadcast. Force-landscape
  is **pure CSS** now: `#phone-stage` is sized 100vmax×100vmin and `@media
  (orientation: portrait)` sets `--rot: 90deg` to rotate it to landscape
  (player turns the phone LEFT; flip the sign to swap turn direction) —
  viewport-driven, so it works with NO device-motion permission and NEVER leaves
  a broken portrait layout (the old gravity-driven JS `computeRot` returned 0°
  for the portrait case → the bug). Gravity is still read for STEERING only.
  3-finger tap toggles the orientation debug strip (hidden by default).
- `world.ts` — the drawn desktop: `layoutDesktop`, `drawWallpaper`, `drawOverlay`,
  `drawClock`, collision rects (`rebuildRects`), icon hit-test/drag
  (`iconAt`/`clampIconToBounds`/`resolveIconDrop`), types `DesktopWorld`/`DesktopIcon`.
- `maps.ts` — MAP SYSTEM. `MapDefinition` (background/obstacles/spawn/bounds/wrap/
  drag), a registry (`registerMap`/`getMap`/`listMaps`/`hasMap`, `DEFAULT_MAP_ID`),
  `desktopMap` (map 1, delegating to `world.ts`), and `flatTrackMap` (map 2 — a
  STADIUM dirt oval via `computeStadium`/`stadiumPath`/`stadiumBarriers`: straights
  + semicircle turns; barriers ONLY on the inner/outer edges (straights = thin
  rects, turns = small squares strictly off-band) so the band drives freely;
  grandstands (crowd only) + floodlights decor; grid spawn on the start line.
  NO ads yet — all placeholder banners removed; real ad surfaces come later
  beside the stands + in the infield. Band widened ~⅓ INWARD (outer edge fixed,
  inner moved toward centre)).
  Per-map smoke tint via `MapDefinition.smokeColor` ([r,g,b], default white):
  desktop = white rubber smoke, flat = brown dust (`effects.ts` stores the tint
  per particle).
  FIXED-WORLD scaling via `MapDefinition.fixedWorld` ({widthM,heightM}): when set
  (the oval), the map is ALWAYS built at that exact logical size — so
  `computeStadium` yields the SAME wide oval regardless of window — and desktop.ts
  renders it with a SINGLE UNIFORM scale-to-fit (`viewScale`, letterbox/pillarbox),
  never stretching an axis. A bigger window zooms the whole world up (oval + car +
  stands together), a smaller one down; shape constant, lap effort constant.
  CRITICAL — `FLAT_LOGICAL` = the ACTUAL fullscreen size (`window.screen.width/
  height` in CSS px) / pxPerMeter, NOT a hardcoded 1920×1080. This makes the
  car-to-oval RATIO equal the ORIGINAL pre-scaling fullscreen ratio on any display:
  at fullscreen viewScale≈1 ⇒ the oval fills the screen and the car is its original
  on-screen size (the tuned drift look); a smaller window scales the whole scene
  down together (ratio constant). A hardcoded 1920 was the bug — a 1920 panel at
  125% Windows scaling reports 1536 CSS px, so the fixed oval was ~25% too big and
  the car rendered ~80% size. (Falls back to 1920×1080 off-DOM for unit tests.)
  Maps WITHOUT fixedWorld (the desktop) keep the old behaviour: world = viewport,
  fills the screen, wraps. (Also fixes the oval squashing when exiting fullscreen.)
  desktop.ts reads everything through the active `MapDefinition`; `switchMap(id)`
  swaps it. Dev hooks: `window.steerMaps()` / `window.steerSwitchMap(id)`.
- `lobby.ts` — N-player lobby state machine (`LobbyState`): slots, colors, names,
  join/leave/sweep/reclaim. Pure (no DOM/transport). Config + `EV` event names live here.
- `cars.ts` — multiplayer math (pure): `spawnOffset`/`spawnPose` (non-overlapping
  spawn grid), `collidePairCars`/`collideCars` (clamped arcade bounce), `applyInputs`
  (clamp/merge for the control router).
- `race.ts` — race logic (pure): `RaceState` (start/checkpoint/finish passage
  detection, laps, sprint/circuit). Circuit anti-cheat: a lap only counts on a
  FORWARD crossing of the start line (`RaceElement.forward`, fed the car velocity
  via `update(x,y,now,vx,vy)`) that is ARMED — armed only once the car reaches the
  circuit's far point (`farX`/`farY`/`farRadius`), so reverse-spam / tiny circles
  at the line never progress a lap. Editor mutators (`placeElement`,
  `removeElementAt`, `clearElements`, `findElementIndexAt`, `renumberCheckpoints`,
  `countCheckpoints`), `isCircuitTrack`, `formatRaceTime`, `RACE_CONFIG`.
  MULTI-CAR: `RaceManager` (pure) holds one `RaceState` per slot (each races the
  same elements/laps independently) + a finishing ORDER. `update(slot,…)` per car;
  `finishers()` → `Finisher[]` (slot, 1-based position, finishMs, in finish order);
  `isComplete(connectedSlots)` true when every CONNECTED car has finished;
  `remove(slot)` on disconnect (a gone car never blocks the end; a finished one
  keeps its result); `reset()` for rematch. desktop.ts feeds every car, shows a
  live corner finish feed + a podium (top-3 steps, winner centre) with REMATCH.
- `xp.ts` — XP MODE logic (pure, unit-testable; the third circuit mode beside
  LAPS). `XpRunState` + `makeXpRun`/`updateXpRun(run,dt,speed,slipRad,crashed)`.
  Drive without crashing → XP accrues (rate ∝ speed × drift multiplier); a
  sustained DRIFT (|rearSlip|) builds the multiplier (length-of-slide, scaled by
  speed/slip depth, caps at `multMax`, decays when gripping); drop below
  `slowSpeedFrac`×`maxSpeed` for `slowGraceMs` → run ends (`warning` blinks first,
  launch-grace so a standing start never trips it); crash (impact > `crashImpact`)
  → instant end. All feel-numbers in `XP_CONFIG`. It only READS speed/slip — never
  writes physics. desktop.ts owns the localStorage best (`steerit.xp.best.<map>`),
  the HUD (`#xp-hud` score+`×mult`, blink, `#xp-end` card + RETRY), the circuit
  editor LAPS/XP toggle (`circuitMode`), and feeds it the SOLO (lowest-slot) car.
- `effects.ts` — particles (tire smoke, impact sparks, screen shake). Global hard cap
  (`FX_CONFIG.maxParticles`); emission stops at the cap.
- `sound.ts` — `SoundEngine` (WebAudio). OFF by default; toggled by the M key / button.
- `supabase.ts` — Supabase client + `channelName(code)` + `createResilientChannel`.
  Realtime client config: 15s heartbeat with **`worker: true`** (the heartbeat
  runs in an inline-blob Web Worker so it ISN'T throttled when the host tab is
  unfocused — that background-tab `setInterval` throttling was the ~60s socket
  idle-drop root cause) + fast `reconnectAfterMs` (250ms→2.5s). The wrapper
  auto-reconnects: on CLOSED/TIMED_OUT/CHANNEL_ERROR it removes + re-creates +
  re-wires + re-subscribes a fresh channel for the same room (250ms→3s backoff) —
  no QR rescan. Throws if env vars missing (gates the whole app; headless preview
  without env vars won't boot). The desktop gates its idle-sweep on channel health
  (`channelReady` + reconnect grace) so its OWN dropped channel never mass-frees
  slots. Controls HOLD their last value through normal jitter AND a brief
  reconnect blip (the car coasts on it); they're zeroed ONLY after a SUSTAINED
  packet gap (`STALE_INPUT_MS` 1500ms) — a genuine disconnect — so a car never
  runs away yet never twitches mid-drive. (It deliberately does NOT zero on
  `channelReady=false`: a transient blip recovers in ~250ms and the per-car
  staleness already catches a real disconnect — that instant-zero was the
  fraction-of-a-second control "dropout".) D-debug logs packet gaps, stale
  LOST/RESTORED transitions, and long frames.

### Build / test / run commands
- `npm run dev` — Vite dev server (port 5173).
- `npm run build` — `tsc && vite build` (type-check THEN bundle).
- `npm run preview` — serve the production build.
- Type-check only: `npx tsc --noEmit`.
- **Env:** copy `.env.example` → `.env` with `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`, and (for prod) `VITE_PUBLIC_BASE_URL`. `.env` is gitignored.
- **Tests:** no test runner is configured (no `test` script, no vitest/jest). The pure
  modules (`lobby.ts`, `race.ts` incl. `RaceManager`, `cars.ts`, `xp.ts`, and the
  pure `computeViewport`/`carRenderPx` in `maps.ts`) are written to be unit-testable
  and are smoke-tested ad-hoc by bundling the REAL module with esbuild into a temp
  `.mjs` and asserting in Node (these scratch test files are not committed). esbuild
  ships with Vite.

### Key constants (read from code — change these, not hidden gates)
- `PLAYER_CAP = 8` (lobby.ts) — max simultaneous players (built for N; tested with 2).
- `CAR_COLORS` — 10 neon colors (lobby.ts); `defaultColorForSlot` wraps for N > 10.
- `NAME_MAX = 12`, `IDLE_TIMEOUT_MS = 6000`, `PHONE_HEARTBEAT_MS = 1200`,
  `LOBBY_SYNC_MS = 2000` (lobby.ts).
- `STEER_EXPO = 1.7` (phone.ts) — tilt expo curve `steer = sign(t)·|t|^1.7`.
- `RACE_CONFIG = { laps: 1, maxCheckpoints: 5, gateRadius: 1.7 }` (race.ts); laps clamped 1–10.
- `SPAWN_GAP = 2.4` m (cars.ts) — > 2× `carCollisionRadius`, so spawns never overlap.
- `CONFIG.restSpeed = 0.6` m/s (physics.ts) — static-friction HARD PARK: with no
  throttle/brake/handbrake below this, linear vel AND yaw are locked to exactly 0
  every frame so a coasting/just-braked car fully STOPS (the coast tail sits
  ~0.4-0.5 m/s, so 0.35 was too low to catch it → it crept several metres over
  10+ s; 0.6 catches it). Gated on idle+low-speed, so driving/throttle-crawl/drift
  are untouched. `phys-debug` (D) shows `|v|`/`yaw`/`rest=Y` to verify 0 at rest.
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
  drift mode" in `step()` (slip-angle + speed governor) plus auto-countersteer — both
  layered on the honest tire forces, neither adds energy.
- **DRIFT ASSIST IS ONE TOGGLABLE KNOB (`CONFIG.driftAssist`, p18 HYBRID).** Single
  source of truth, 0..1: `1` = full arcade assist (the default — fine-control governor
  on), `0` = pure EMERGENT sim drift (governor fully off → raw friction-circle physics,
  the ~60° free slide). It SCALES every governor term (angle-hold + speed) so they
  collapse cleanly to the emergent model at 0. The DELIBERATE SPIN ("hodiny") and the
  Fix-2 reversed-thrust gate are applied INDEPENDENTLY and work at EVERY level. Built so a
  future player-facing **Arcade↔Sim** drift toggle (or difficulty) wires straight to this
  one number with NO further physics rework. When changing drift feel, prefer nudging the
  governed gains; don't reintroduce a tower of latches.
- **EMERGENT-DRIFT MODEL (p18 HYBRID — current).** `betaTarget` is PROPORTIONAL to
  steer-into and ZERO at neutral/countersteer: steering SETS the drift angle (fine
  control) and straightening commands β→0 (recovers even with throttle held — fixed the
  old recovery defect where the ~40° `driftBaseAngle` floor pinned β). The drift is
  SUSTAINED at the default `driftAssist=1` by the governor (angle-hold while on throttle);
  lift/straighten → recovers. `driftFriction` stays at **0.83** (the original tuned
  value): a brief p18 experiment dropped it to 0.50 to decouple a pure-physics throttle-
  sustain, but that value ALSO governs the FRONT tyre's kinetic grip → it washed out in
  hard corners at speed (understeer, yaw ~halved / radius 2-3× wider, sim-verified vs
  8f2a69f) and cost ~0.3 s of launch, so it was REVERTED in p18b. Turn-in + launch now
  match the OLD tuned feel exactly; all hybrid wins are independent of it (proportional
  betaTarget, recovery fix ~0.6 s, governor-sustained drift, corners grip 1.8°). The only
  thing 0.83 gives up is the PURE-SIM (`driftAssist=0`) throttle-sustain — the far end of
  the future Arcade↔Sim toggle, not the default. (Tunable: 0.75 keeps ~86% of turn-in for
  a slightly looser drift.) Holding a 40°+ drift sits near the spin-arm threshold (tunable
  via `driftAngleMax` / `spinReleaseThreshold`). LOW-SPEED power-over + steering-ONLY
  transitions stay deferred to the handbrake-tap (Step B) — the front-slip limiter blocks
  throttle-only break-loose at low speed by design; transitions DO chain when provoked
  (handbrake-tap). **AWAITING phone feel-test.**
- Physics was LOCKED at the pre-rewrite "good enough" version (tag `pred-prepisem-fyziky`);
  the p18 HYBRID is a SMALL, targeted change on top of it (no rewrite — governor restructured
  behind one assist gain + two tunables). Don't touch with big rewrites — only small targeted
  parameter changes.

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
  in corner, flick), holds, throttle/steer control the angle. p18 HYBRID emergent
  model: steer SETS the drift angle (fine control), straighten → recovers, the
  governor sustains a provoked slide at `driftAssist=1`, one `driftAssist` knob
  (arcade→sim). `driftFriction` 0.83 (turn-in + launch = OLD tuned feel).
  Sim-verified; AWAITING phone feel-test. (~85%.)
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
  Force-landscape is pure CSS (viewport `--rot`, gravity/permission-independent;
  steering calibration reads gravity only in the landscape pose). Buttons polished:
  depth/bevel, neon-tube borders, press feedback (active glow), the E-BRAKE sits
  INSET into the GAS/BRAKE fills (no black gap), thin neon GAS/BRAKE divider.
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
  **D** = debug HUD (speedo/slip/wspin/pedals), **Q** = hide QR panel, **P**/**Esc** =
  pause menu, **E** = editor, **M** = sound on/off (sound OFF by default).
- **Pause MENU (P / Esc)** — freezes simulation + timer (not render); phones stay
  connected. Synthwave card (reuses the main-menu styling) with **RESUME**,
  **RESTART** (respawn all cars at the map spawn + `raceManager.reset()` + clear the
  finish feed/podium → laps/time/checkpoints zero; track + editor elements stay; also
  the **REMATCH** action on the podium), and **EXIT TO MENU** (back to the
  main menu; lobby/cars preserved, QR held until a map is re-picked — no rescan).
  Shares one freeze gate with the editor + main menu + the race-results podium
  (`refreshFreeze` in desktop.ts).
- **Race core (`race.ts`)** — start/checkpoint/finish, passage detection, time, laps,
  **sprint vs circuit** (circuit = start only, no finish, so start = finish too),
  lap count 1–10 (open) / 0–99 (circuit). Circuit anti-cheat: a lap counts only on
  a FORWARD, ARMED start-line crossing (armed by reaching the far point) — no
  reverse-spam, no near-line circling. Tested live (FINISH 0:15.3).
- **Multi-car race (`RaceManager` in `race.ts`)** — per-car independent lap
  counting (one `RaceState` per slot) + a finishing ORDER. Desktop shows a LIVE
  finish feed (unobtrusive corner `✓ P1 NAME time` as each car finishes — does NOT
  block still-racing cars) and, once EVERY connected car has finished, a 90s-arcade
  PODIUM (3 steps, winner centre/tallest, 4th+ listed below with times) with
  **REMATCH** (reuses RESTART) + EXIT. Disconnect = ignored (a gone car never
  blocks the end; a finished-then-left car keeps its result). Unit-tested (15
  cases). AWAITING a 2-phone live test.
- **XP MODE (`xp.ts`)** — the third circuit mode (editor toggle LAPS / XP). Endless
  SOLO score run: XP accrues ∝ speed × a drift multiplier (a sustained slide builds
  `×mult`, caps + decays); the run ARMS only once the car first reaches the min
  speed (45% of `maxSpeed`); dropping below that blinks then ends after a 2 s grace;
  a crash ends instantly. Big top-centre counter + `×mult`, end card (final + best +
  NEW RECORD) + RETRY; best in localStorage per map. All tunables in `XP_CONFIG`
  (`slowSpeedFrac 0.45`, `slowGraceMs 2000`, `multMax`, …). Only READS speed/slip —
  physics/drift untouched.
- **Fixed render scale (car size consistent across maps)** — `RENDER_PX_PER_M`
  (= `CONFIG.pxPerMeter`) is the ONE metres→pixels scale every map renders at, so
  the car is the same on-screen size everywhere. `computeViewport(map,w,h)` (pure)
  returns the world-pixel rect + centring offset, always at that scale. Fixed-world
  (circuit) maps are sized to the ACTUAL fullscreen (`window.screen`) so at
  fullscreen the oval fills the screen and the car-to-oval ratio matches the
  ORIGINAL tuned look on any display/DPI; smaller windows uniformly scale the whole
  scene (never crop/squash). Load-time assertion in desktop.ts catches any map that
  renders the car at a different scale.
- **Fullscreen on START RACE** — the host page requests fullscreen (standard API +
  webkit fallback) on the START RACE / map-tile click (a user gesture). Rejection is
  swallowed; a manual Esc-exit isn't fought; the pause menu still works.
- **Vercel Web Analytics** — `inject()` (framework-agnostic, NOT the React
  component) at the top of BOTH entries (`desktop.ts` + `phone.ts`), so desktop
  visits and phone joins are both counted. Enable Web Analytics in the Vercel
  dashboard for data to flow.
- **Track editor (E) — per map type** (`MapDefinition.trackType`):
  - OPEN maps (desktop): full place-elements editor — palette
    [START][FINISH][CHECKPOINT][DELETE][CLEAR ALL] + a LAPS 1–10 control. Click =
    place, drag = move, delete removes. Status e.g. "SPRINT · START ✓ · FINISH ✓ ·
    CP 2/5 · LAPS 1". Default surface empty.
  - CIRCUIT maps (flat oval): NO place palette — just a **LAPS 0–99** panel
    (type-able number input + steppers) on the map's BUILT-IN start/finish line
    (`MapDefinition.startLine`). LAPS 0 = free-roam (no timer, drift the loop);
    LAPS N = N-lap timed race (circuit mode, the oval's start line = start AND
    finish). Status "CIRCUIT · FREE ROAM" / "CIRCUIT · RACE · 3 LAPS".
  - Lap clamp raised to 1–99 in race.ts; `body.circuit-edit` hides the palette.
  - A **LAPS / XP MODE** toggle (`#editor-mode`) sits in the circuit editor.
    XP MODE = endless SOLO score run (see `xp.ts`): big top-centre XP counter +
    `×mult`, blinks red on the slow warning, end card (final + best + NEW RECORD)
    with RETRY; best saved in localStorage. Picking XP hides the laps panel + the
    lap/timer HUD; LAPS restores them. Physics/drift untouched (XP only reads).
- **Lobby (`lobby.ts`)** — N-slot, QR join, color pick (10 colors), rename, on-desktop
  roster, connect/disconnect/reclaim/full. Tested live (2nd player joined, named, readied).
- **N-car multiplayer (`cars.ts`)** — car per slot, spawn in center with offset (function
  of slot index, slot 0 dead-centre), color from slot, independent input routing,
  car-car collisions (clamped arcade bounce), connect/disconnect/reclaim. Per-car skids
  (color-tinted) + smoke. Verified through the real channel pipeline; AWAITING a
  two-device live test.
- **Map system (`maps.ts`)** — the map is a switchable `MapDefinition` (background,
  obstacles+collision, spawn, bounds+wrap, `trackType` 'open'|'circuit', optional
  decor + `smokeColor` + `fixedWorld`, draggable flag). The desktop is map 1
  (`desktopMap`, 'open'). `switchMap(id)` rebuilds world + layers, clears skids,
  resets the (per-map) race track, exits the editor, and respawns cars. **Map 2 =
  `flatTrackMap`** ('flat', 'circuit', 90s dirt oval): brown dirt ring + green
  infield + purple night ground, tyre-wall barriers (FIXED, edge-only AABB rects),
  grandstands (crowd only — NO ads yet) + floodlights, 2-wide grid spawn on the
  start/finish line, brown DUST `smokeColor`. Maps are picked via the START RACE →
  map-select tiles (real previews); `steerSwitchMap('flat')` dev hook still works.
- **Vercel/QR blocker FIXED** — the QR pointed to a protected deployment-hash URL
  (login wall for other players). Fix: the QR is built from env var `VITE_PUBLIC_BASE_URL`
  (= production domain), not window.location.origin. + disable Vercel Authentication.

---

## 5. STATUS — PENDING

### Next (live verification — needs real phones)
1. **2-phone live test of the multi-car race** — two real phones racing the flat
   oval: the live finish feed (P1 then P2…), the podium once both finish (correct
   order + times), REMATCH, and a mid-race disconnect being ignored. The logic is
   unit-tested (15 cases) and the podium/feed render correctly in preview, but the
   driving + transport can't be tested headless. **Scheduled for the next session.**
2. **General live multiplayer test** — two cars steering simultaneously, car-car
   collisions, disconnect/reclaim, all through real Supabase (preview has no real
   WebSocket). The pipeline is verified via simulated messages only.

### Deferred (do later, in this order)
3. **Monetization** — Stripe; free vs premium split (see §6). Deferred until the
   reel confirms interest.
4. **Accounts + global leaderboards/records** (XP scores + lap times, online) —
   deferred, to be built TOGETHER WITH monetization (accounts gate paid features +
   persist records; today XP best is local-only `localStorage`).
5. **Onboarding** (first-run guidance / how-to-play) — deferred until after the
   monetization / free-vs-premium decision (what to show free users depends on it).

### Other planned (still on the roadmap)
6. **Interactive taskbar** — turn the bottom bar into a control panel (launch
   editor/pause/laps via buttons instead of keys). UI shell over existing functions.
7. **REEL** — a 10–20s viral video (phone-as-wheel in the first 2s, multiple cars
   racing the desktop). Primarily TikTok / YT Shorts.
8. **Scaling check** — BEFORE the reel, verify how many concurrent games the
   Supabase Realtime plan holds under a viral spike (e.g. 3000 people in 2–3s).
   Vercel Pro serves fine; Supabase is the bottleneck. Upgrade if needed.

### After the reel (once interest is confirmed)
- More maps, screenshot-your-own-desktop background, saving/library of tracks.
- Steam wishlist page; influencer key platforms (Keymailer/Woovit/Lurkit — once
  there's a Steam build; for now browser = direct TikTok/influencer outreach).
- Sound (4 synthesis attempts failed — deferred; WAV pipeline stays, just drop a
  CC0 recording into public/audio/. Sound is OFF by default.)
- Discord, Ludum Dare, itch.io devlogs.

---

## 6. MONETIZATION (plan — do not implement until the reel confirms interest)

- **Payments:** Stripe.
- **Free:** 1 map (desktop), 2-player multiplayer, basic race mode.
  (Principle: with party games, let people taste the main fun — don't hide it all behind a paywall.)
- **Premium $4.99:** 3–4+ players, all maps, track editor, battle mode, chaos mode, future content.
- **Accounts + global leaderboards/records** (online XP scores + lap times) are
  built TOGETHER WITH monetization — accounts gate the paid features and persist
  records (today XP best is local-only `localStorage`). Onboarding lands after the
  free-vs-premium split is decided.

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
- Race: lap detection is now PER-CAR (`RaceManager`). The single engine SOUND and the
  lap/timer HUD readout still follow the PRIMARY (lowest-slot) car only — intentional
  (one engine, one timer readout); the live feed/podium cover all cars.
- XP best + the race results are LOCAL only (`localStorage` / in-memory) — no accounts
  or online leaderboards yet (deferred, see §5/§6).
- The START gate in the editor can be hard to see against the sky (cosmetic, to polish).
- The simulation loop is `requestAnimationFrame`-driven, so it throttles in a backgrounded /
  headless tab — keep that in mind when verifying timing-dependent behavior in preview.

---

*Note for Code: keep this file current. The context / rules / decisions / monetization
sections carry knowledge not readable from code — preserve them. Technical details (file
and function names, CONFIG keys, constants, build/test commands) should be corrected to
match the actual repo whenever they drift.*
