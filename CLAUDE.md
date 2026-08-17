# CLAUDE.md — Steer It

> Claude Code reads this file at the start of every session. It holds context, rules,
> status, and key decisions so work doesn't start from zero and old mistakes aren't repeated.
> **Rule: update this file after every significant step.**
>
> The full chronological development log (physics p1–p33, sim-real/sim-real-2, the
> circuit/kerb/grid saga, all the tuning measurements) lives in
> [`docs/CLAUDE-history.md`](docs/CLAUDE-history.md). It is HISTORY — much of it describes
> code that no longer exists. This file is the CURRENT primer; §16 distils the lessons.

---

## 1. What the project is

**Steer It** — a viral browser game. The player drifts a car across a fake "desktop"
environment; the phone is the steering wheel (tilt / gyro steering). Local multiplayer:
several people around ONE monitor, each phone = their own car. Target: "two–three people
at school / on a work break scan a QR and play together."

Core hook: **phone as a steering wheel + drifting across a desktop + zero-friction QR join.**

Live at **`steerit.app`** (the QR is built from `VITE_PUBLIC_BASE_URL`, not the deployment-hash
URL; `steer-it.vercel.app` also serves it, `noindex`ed). **Business model is LIVE:** free to
play + a one-time **$6.90 Premium** (Stripe, real payments — see §6). Three cars: **Blitz RS** and
**Fury 200 EVO** (SIM, both premium) and **Stee-Rex** (arcade, free). All three share ONE 8-colour
palette picked on the phone (§13).

---

## 2. Stack & architecture

- **Frontend:** Vite + vanilla TypeScript + Canvas 2D (no framework, no Phaser).
- **Realtime transport (three-tier):** WebRTC P2P is the PRIMARY tier — phone↔desktop tilt over
  a DataChannel (`src/rtc.ts`), with Supabase used ONLY for signaling; a Cloudflare TURN relay
  (`api/turn.js`) for NAT-blocked players; and Supabase Realtime as the final fallback. Order:
  direct P2P → TURN relay → Realtime. A Step-1 send DEADBAND (idle 30→5 msg/s) cut traffic.
  Realtime message usage sits ~12% of the 2M plan.
- **Backend:** Supabase (Auth email+password, Postgres, RLS) + Vercel serverless functions
  (`api/`, plain JS, outside tsc/Vite) for Stripe + TURN.
- **Hosting:** Vercel (paid Pro plan). **Repo:** github.com/tradeventureapp/steer-it (PRIVATE).

### Entry points
- `index.html` → `src/desktop.ts` (the HOST / game surface + all account/menu/payment UI).
- `play.html` → `src/phone.ts` (the phone controller). QR points at `${VITE_PUBLIC_BASE_URL}/play?s=<CODE>&m=<mode>`.
- `terms.html` / `privacy.html` / `refund.html` → the legal pages (rewrites in `vercel.json`; §7).
- `src/style.css` — all styling. Every surface derives from ONE synthwave design-token block
  (`:root`): sunset hero language (`--grad-accent` gold→orange→pink→magenta wordmark fill;
  `--grad-cta` orange→pink→violet; `--screen-bg` sunset bloom; `--gold` secondary; Orbitron
  display font / system body font). Change the look here, not per-rule.

### Key files (all source under `src/`)
- `vehicle-core.ts` — the shared VEHICLE DATA layer: `CONFIG`, `Config`, `CarState`, `Inputs`,
  `makeCar`, `bodyToWorld`, `ObstacleRect`, `collideWithRects`. **This is the former `physics.ts`,
  renamed** and stripped of the dead p1–p33 / sim-real `step()` model. `WB = 2.565` (the ONE
  wheelbase = the single source of car scale); `pxPerMeter 7.5`.
- `physics4.ts` — **THE drive model.** A full PER-WHEEL vehicle model (4 contact points). `step4()`
  is the sole step; there is NO drive-mode toggle. Per-car handling via `Physics4Params` (see §14).
  Two branches: `branch: 'sim'` (Blitz RS, Fury) and `'arcade'` (Stee-Rex) — arcade divergence is
  gated behind `p.branch === 'arcade'`, so sim is byte-identical.
- `desktop.ts` — the HOST: fixed-timestep loop, per-slot car map, render, collisions, HUD, editor,
  lobby wiring, QR, race standings/podium, and ALL the account / payments / menu / upsell UI.
- `phone.ts` — controller: pitch-invariant ROLL gyro steering (`steeringRollDeg`, level-for-everyone,
  no per-user baseline), analog pedals, handbrake, lobby UI. Force-landscape is pure CSS
  (`#phone-stage`). `TILT_RANGE_DEG 70`, deadzone 3°, expo 1.0, `STEER_SIGN -1`.
- `world.ts` — the drawn desktop map (`layoutDesktop`, wallpaper/overlay, collision rects, icon drag).
- `maps.ts` — MAP SYSTEM: `MapDefinition`, registry, and the maps — `desktopMap` (open),
  the STADIUM-oval twins `flatTrackMap` (dirt) + `asphaltTrackMap` (both from `makeStadiumMap`),
  `circuitMap` (the winding road course: globally-smooth ribbon, GP kerbs, gravel traps,
  built-in start/finish + laps), and `authoredCircuitMap` ('circuit2' / "Circuit II" — the
  boss's track-editor layout: asphalt ribbon + grass, procedural oval-style tarmac,
  derived finish/far/spawn/mask, optional `AUTHORED_DIRT` `{i0,i1}` arc (dirt physics +
  packed-earth render, rallycross model), optional `AUTHORED_FINISH_I` (marked finish path
  index; null = auto lowest point; drawn as the circuit-style plain white line), and
  WHITE EDGE LINES along both asphalt edges (shared `buildAuthoredEdgeLines` — circuit
  language: 0.34 m line, 0.55 m inset on free stretches, tucked to the kerb seam under
  kerbs with a ±3-sample eased transition, runs across the dirt like the rallycross,
  kerbs paint over the joint), and `AUTHORED_KERBS` `{i0,i1,side}[]` (shared `buildAuthoredKerbQuads`; kerbs are baked into
  the 3-tone mask as rideable 'kerb' class → asphalt physics, on-track, kerb tyre marks;
  kerb vertices count toward the fit extent) — DEV-GATED in desktop.ts until sign-off; a
  new editor export drops in by replacing the five AUTHORED_* constants). Surface masks (`surfaceAt` /
  `markClassAt`) drive grass/gravel physics + tyre-mark class. `FLAT_LOGICAL` fixed-world
  scaling. ⚠️ `SURFACES.asphalt`'s image fill is the designer's pre-rendered CIRCUIT art
  (kerbs/gravel baked in) — NEVER use it to paint a different ribbon shape; paint procedurally
  (see `drawAuthoredSurface`).
- `surfaces.ts` — the surface LIBRARY (`SurfaceDef` joins renderer + physics binding + effects
  identity; grass/gravel/asphalt). The circuit paints the designer's `track-surfaces.png` bitmap
  (asphalt), procedural fallback until decoded (WebKit decode-gate fix).
- `marks.ts` — TYRE MARKS: threshold-gated + per-surface SATURATING (multiply layer, capped),
  fixed offscreen layers, NOT unbounded. `MARK` tunables. (The legacy unbounded skid path is kept
  as a future `paint` MarkMode, inactive.)
- `effects.ts` — particles (smoke split burnout/slide; grass dust; gravel/stone spray). Global cap
  `FX_CONFIG.maxParticles = 340`. Smoke rendered from a baked sprite (perf).
- `sound.ts` — `SoundEngine` (WebAudio). OFF by default (M key).
- `supabase.ts` — client + `channelName` + `createResilientChannel` (worker heartbeat, auto-reconnect).
- `rtc.ts` — WebRTC P2P (injectable PeerFactory, unit-tested headless); signaling over `steer:<code>`.
- `lobby.ts` — N-player lobby state machine (pure), `RESILIENCE` connection lifecycle (single source
  of truth), `EV` event names, `PLAYER_CAP`, `paletteForMode`, control deadband helpers.
- `cars.ts` — multiplayer math (pure): spawn grid, car-car collision bounce, input router.
- `race.ts` — race logic (pure): `RaceState` + `RaceManager` (per-slot laps, finish order, DNF),
  circuit anti-cheat (armed forward crossing), `RACE_CONFIG`, editor mutators, `formatRaceTime`.
- `xp.ts` — XP MODE (pure): endless solo score run, drift multiplier. Only READS speed/slip.
  **Off-track = TRACK GEOMETRY, never surface material** (`maps.onTrackAt` → `wheelsOffTrack`
  in desktop.ts) — see the rule in §3.
- `time-attack.ts` — TIME ATTACK (pure): `TimeAttackRun` + `formatLapTime`. Rolling solo lap
  timing. It does NOT re-implement crossing detection — it OWNS a `race.ts` `RaceState` built
  from the map's own `startLine()`, so the line-plane sweep, the FORWARD-only test and the
  ARMED far-point full-lap rule are literally Race mode's. What it adds is the ROLLING part
  (Race stops at its lap limit and reports one total; Time Attack times every lap back to
  back), plus OFF-TRACK LAP INVALIDATION that reuses XP's detection (`wheelsOffTrack` count +
  `XP_CONFIG.offTrackWheels` threshold — an invalid lap never records). DOM/storage-free like
  `xp.ts` — the best lap is passed in and handed back out.
- `zones.ts` — LEADERBOARD ZONES (pure): `ZoneTracker` + `xpProofValid`. Splits a track's
  CENTRELINE (the map's `zonePath` — arc-length-even, finish-anchored, forward-oriented) into 6
  EQUAL arc-length buckets; "which zone" = nearest-centreline point, so a zone is the FULL RIBBON
  width by construction (generous — legit driving never misses one; only a real shortcut does).
  TA: `lapComplete()` / `lapSplits()` (all 6 in order this lap → the submit proof). XP: `xpProof()`
  = {distinct zones, loops, contiguity} proof-of-play. Fed the car nose on the fixed step (both
  modes) in desktop.ts; DOM/physics-free. Structural only — no per-segment speed floors yet (the
  TA splits are stored so those can be added server-side later with no client change).
- `leaderboard.ts` — LEADERBOARD client data layer (Phase 2, Time Attack + XP): `submitScore`
  (→ the SECURITY DEFINER `submit_score` RPC, the only write path), `fetchBoard` (paginated menu
  board), `fetchTopAndOwn` (compact top-10 + caller's own row/rank). Thin Supabase wrapper (like
  `auth.ts`); reads are public, writes are RPC-only; every call swallows errors so a network hiccup
  never breaks gameplay. `mode`-parameterised: TA ('timeattack', lower better, asc) and XP ('xp',
  higher better, desc) share the same queries. DB schema + RPC live in `supabase/schema.sql`; the two
  views (menu mode-toggle + selection quick-view) are rendered in `desktop.ts`.
- `vehicles.ts` — vehicle IDENTITY + specs: `VehicleSpec` (`overrides`, `branch`, `arcade`, **`phys4`**,
  `dims`, `sprite`, `fxScale`), `ROAD_SPEC` (Blitz), `STEEREX_SILVER/BLACK`, `FURY_SPEC` + dims +
  colour palettes. Pure data — NO real make/model names anywhere.
- `steerex-sprite.ts` / `fury-sprite.ts` — the two SVG sprite cars, rasterised + cached (nose-up,
  centred on the rotation pivot, mipmap downscale). Fury recolours from ONE base + `Fury-mask.png`
  (§13) — Stee-Rex is vector per-skin, Blitz uses an arithmetic body test.
- `auth.ts` — HOST auth + entitlement (Supabase Auth): sign-up/in, email verify, password reset,
  **effective premium = `is_premium` (Stripe-paid) OR `granted_premium` (review/comp)** — the ONE
  place that OR is read; every gate inherits it (server truth, RLS), nickname (RPC-validated +
  30-day cooldown), device cap (5), marketing consent (`setMarketingConsent` RPC + `signUp`'s
  opt-in metadata param). Phones NEVER import it — joining stays account-free.
- `reviews.ts` — REVIEWS client data layer ("leave a review → get premium free"): `submitReview`
  (→ the SECURITY DEFINER `submit_review` RPC, the only write path) + `fetchMyReview` (own row →
  show pending/approved state). Thin Supabase wrapper; errors swallowed.
- `email.ts` / `nickname.ts` — email normalise + disposable block; nickname format/cooldown helpers.
- `api/` (serverless, plain JS): `_lib.js` (env + Stripe client + `PRICE_ID`), `create-checkout-session.js`,
  `stripe-webhook.js` (grants premium), `verify-session.js` (ownership-checked fallback),
  `billing-debug.js`, `turn.js` (Cloudflare TURN creds, Origin-gated).
- `track-editor.html` + `src/track-editor.ts` — DEV-ONLY track authoring tool (root page,
  served by `npm run dev`, NOT a build input → never ships). Author a NEW circuit-family
  layout: freehand centreline → simplified to control points → fed through the REAL
  pipeline (`buildCircuitPath`) → drag / dblclick-add / rightclick-delete points, band-width
  slider. Main canvas = blank WHITE paper, stroke/spline/points in black ink (boss's spec),
  and it is WYSIWYG: world aspect + the game's own placement transform (fit scale + bbox
  centring), so drawn space ≡ in-game space. Seeds the boss's current sketch on first open;
  IMPORT parses a pasted export block / bare `[x,y]` array (+ optional CS_BAND) back in;
  the side mini view renders the true in-game look (real surface painters, true fit) →
  EXPORT emits the `CIRCUIT_SKETCH` + `CS_BAND` constants maps.ts consumes (1760×780 frame).
  maps.ts exports for it (zero-behavior refactor, fingerprint-proven identical):
  `buildCircuitPath(sketch)` (the former inline CIRCUIT_PATH builder), `circuitBandScale(band)`
  (the `_bandScale` formula), `CIRCUIT_FIT`, `FLAT_LOGICAL`, `type Pt`.

### Build / test / run
- `npm run dev` (Vite, 5173) · `npm run build` (`tsc && vite build`) · `npm run preview` · `npx tsc --noEmit`.
- **Env:** `.env` (gitignored): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PUBLIC_BASE_URL`.
  Vercel prod env: see §6/§8.
- **Tests:** no runner configured. The pure modules (`lobby`, `race`, `cars`, `xp`, `rtc`, and
  `physics4` via an esbuild+Node harness) are smoke-tested ad-hoc — bundle the REAL module and assert
  in Node (scratch files, not committed). The physics4 "golden" harness is how Blitz's 0.0e+0 is proven.

### Key constants (current — read from code, not hidden gates)
- `PLAYER_CAP = 8` (lobby.ts).
- `RESILIENCE` (lobby.ts): `INPUT_COAST_MS 400` / `INPUT_NEUTRAL_BY_MS 1000` / `PRESENCE_GRACE_MS 20000`
  / `HEARTBEAT_MS 1200`. Invariant: COAST < NEUTRAL_BY < PRESENCE_GRACE.
- `WB = 2.565` m, `pxPerMeter 7.5` (vehicle-core.ts) — the one ruler (render = physics).
- `FX_CONFIG.maxParticles = 340` (effects.ts).
- `RACE_CONFIG = { laps: 1, maxCheckpoints: 5, gateRadius: 1.7 }` (race.ts).
- `DEV_EMAILS = ['dykous94@gmail.com']` (desktop.ts) — the dev gate (see Fury, §13).
- `STEEREX_SKIN_COLORS` (8, vehicles.ts) = the SHARED phone palette for BOTH Blitz RS + Stee-Rex
  (`paletteForMode` returns it for `sim` and `arcade`). `BLITZ_RS_COLORS` (12) is legacy — retired
  from the draw path, kept only for old-hex name lookup.

### Multiplayer architecture principle
**The desktop (HOST) is the authority.** It owns world state (slots, positions, colours, names)
and assigns slots. Phones only send input + receive state. Control packets are tagged with the
phone's `id`; the desktop routes each by its OWN `id → slot` map (a phone's self-reported slot is
not trusted). `EV` events: phone→desktop `join|color|name|leave|control`; desktop→phone `lobby|full`.

---

## 3. RULES & PRINCIPLES (so old mistakes aren't repeated)

### Physics
- **A car must behave like a car.** Honest physics: throttle → engine torque → wheels → tyre
  friction (friction circle) → body forces.
- **Character is tuned via PARAMETERS** (power, grip, mass, geometry), NEVER via artificial
  gates / if-then patches in the force path.
- **NO PATCHES.** The pre-rewrite `step()` model died of this — 15+ passes of governors/latches/
  thresholds that interacted badly, then a failed rewrite. `physics4.ts` is the clean per-wheel
  replacement. Don't reintroduce a tower of band-aids; find the real physical cause.
- **REALITY SETS THE NUMBERS, never reversed.** When a behaviour is wrong, find the real physical
  cause and tune the real parameter; don't pick a number just to unlock a feel, and don't paper
  over a missing mechanism with a damper/gate.
- **Assists may exist, but: named, isolated, toggleable, last resort.** An assist may amplify/
  stabilise what the player does — never add motion/energy they didn't command. The ARCADE branch
  is where forgiveness assists live (Stee-Rex); SIM (Blitz, Fury) stays honest.
- **Blitz RS is the golden benchmark.** Its physics4 output is byte-identical (0.0e+0) to a saved
  baseline; new cars are added as per-car param overrides that leave Blitz's numbers untouched.
  Any change to the SHARED force path breaks that and must be a deliberate, re-baselined decision.

### Track / surfaces
- **ASK GEOMETRY, NOT MATERIAL.** "Am I on the track?" is answered by the track MASK (am I inside
  the drivable ribbon?), never by "is this wheel on asphalt?". A material allow-list ROTS: the same
  bug shipped THREE times (dirt oval, then the rallycross dirt section) because each new surface was
  off-track until someone remembered to list it. Fixed at the root in `0ac65ad` — `trackSurfaces`
  (the whitelist) is deleted; `MapDefinition.onTrackAt(x,y)` is the one check. Ribbon **and kerbs**
  = on track whatever they're paved with; grass + gravel run-off = off. A NEW surface painted on the
  ribbon is on-track for free — there is no list to update, so it cannot regress again. Maps with no
  ribbon geometry (desktop, the barrier-bounded ovals) are on-track everywhere by definition.

### Multiplayer / general
- **Build for N, not hardcoded for 2.** Slots/cars/colours keyed by slot; cap = `PLAYER_CAP`.
- **CAMERA: the WHOLE track is ALWAYS on ONE screen; car size is a CONSTANT.** Local multiplayer on
  one shared monitor ⇒ a follow-camera is NOT allowed (would force splitscreen; it was tried on the
  circuit and reverted). The track is sized to fit the screen at the standard car size.
- **Test live, not just in sim.** Claude Code has no real Supabase in preview → live transport MUST
  be smoke-tested on real devices. Keep logic in pure testable modules.
- **Logic first, UI/tool second. One thing at a time, test, then next.**

### Workflow
- Jakub runs prompts + pushes via git. Communication informal Czech (chat); code/commits/this file
  in English. Push only on explicit "push". After push: Vercel auto-rebuild → test on phone (cache:
  close tab + rescan QR). No real make/model/sponsor names anywhere in code or comments.

---

## 4. STATUS — DONE

**Game core**
- **Drift physics** — per-wheel `physics4.ts` (§14). Blitz RS is the tuned SIM benchmark; Stee-Rex
  the arcade car; Fury the dev-only AWD SIM car.
- **Phone controls** — pitch-invariant roll steering, analog pedals, handbrake, force-landscape (CSS).
- **Maps** — desktop (open, draggable icons), the two stadium ovals (dirt + asphalt, `makeStadiumMap`),
  and the winding **circuit** (smooth ribbon, GP kerbs, gravel traps, grass — all with real surface
  physics: per-wheel grip + drag on grass/gravel/dirt). Fixed render scale (car constant across maps).
- **Race** — full: start/checkpoint/finish, sprint vs circuit, laps, standing grid + 3-2-1 countdown,
  **live standings** (top-left, all players, laps→progress ordered, finished-lock, throttled ~11 Hz),
  **DNF / finish-timeout**, finish feed, **podium + rematch**, per-car `RaceManager`. `playerName`
  resolver: host = account nickname (locked, drives the keyboard/local car), guests = phone name or
  "Player N". (Host-via-phone recognition deliberately NOT built.)
- **XP MODE** — endless solo score run (drift multiplier), best in localStorage per map.
- **TIME ATTACK (Phase 1)** — SOLO rolling lap timing on every map that has a start/finish line
  (both ovals, Circuit, Circuit II; the Desktop free-roam surface is excluded — no line). The
  FIRST forward crossing STARTS the clock (spawn→line is not timed — that crossing IS the start
  line); every later valid crossing ends the lap and immediately starts the next, so the player
  just keeps driving and each lap is timed continuously — no manual reset. Validity is `race.ts`'s
  own, not a copy: line-plane sweep + FORWARD-only + ARMED far point, so wiggling on the line or
  reversing over it logs nothing. Fed the car's NOSE on the fixed physics step, exactly as RACE is
  ⇒ lap times are frame-rate independent (measured identical at 30/120/240 Hz). **OFF-TRACK
  INVALIDATION mirrors XP:** the run is fed the SAME per-wheel count XP is (`wheelsOffTrack()` —
  each wheel vs the map's `onTrackAt` geometry) and applies XP's OWN threshold
  (`> XP_CONFIG.offTrackWheels`, i.e. >2 = 3+ wheels off); going that far off DURING a lap marks
  the lap INVALID. An invalid lap still finishes and still records its crossing (the next lap
  starts correctly) but can NEVER set the record, however fast; the flag is STICKY within a lap
  and resets to VALID at each start/finish crossing (a fresh lap is clean). The HUD shows it live —
  the lap clock turns red + an "INVALID · OFF TRACK" label — so the player sees why no record was
  set. (Where XP ENDS the run on the same condition, Time Attack only invalidates the lap; `xp.ts`
  is pure so `time-attack.ts` importing `XP_CONFIG` is a safe read, and a future change to the
  threshold or to `wheelsOffTrack` hits both modes.) Best lap is LOCAL
  ONLY — `localStorage` `steerit.ta.best.<carKey>.<mapId>`, keyed by CAR + TRACK, mirroring the XP
  best (`xpBestKeyFor`): the Fury and the arcade Stee-Rex keep SEPARATE bests on the same line, so
  a slower car is still worth driving and a future leaderboard stays per-car meaningful. The oval's
  asphalt/dirt are DISTINCT map ids (`asphalt`/`flat`), so car+mapId also separates surface for
  free — no extra key part. (Old track-only keys `steerit.ta.best.<mapId>` are left unread; Phase-1
  local data isn't precious, nothing migrates.) Shown in-game as a top-left HUD (live lap clock,
  BEST, the just-finished LAST lap, a "NEW BEST!" flash) — the BEST/records are the CURRENT car +
  track (+ surface) — and on the **track-select tiles**, where each tile shows the SELECTED car's
  record for that track (`--` when unset / no car chosen, hidden on maps that can't host it;
  `selectCar` repaints the tiles so switching car re-shows that car's records).
  Premium-gated like RACE/XP (`FREE_MODE_KEYS`), and it builds NO race elements ⇒ `isRaceLive()`
  is false ⇒ no countdown, no standing start, no race HUD. RESTART is the existing pause-menu
  button — **no new hotkey** (`R` stays the dev recorder's). The `localStorage` best is still the
  live-HUD reference; the ONLINE board (below) is now wired on top of it.
- **LEADERBOARD (Phase 2) — LIVE for TIME ATTACK + XP.** An online board on top of each mode's
  local best. ONE Supabase table `public.leaderboard` holds BOTH modes (`mode` = `'timeattack'` |
  `'xp'`): `(id, user_id→auth.users, nickname [denormalised for display, written server-side], mode,
  track_id, car_key, surface, value bigint, created_at, updated_at)`. `value` = lap ms for TA (LOWER
  better, sorted ASC, shown `m:ss.mmm`) or run score for XP (HIGHER better, sorted DESC, shown as a
  comma number) — direction + format are parameterised by `mode`. ⚠️ `surface NOT NULL DEFAULT ''`
  (not nullable — a nullable column breaks the upsert unique key since Postgres treats NULLs as
  distinct); `''` = none, and the ovals' asphalt/dirt are already SEPARATE track_ids so surface
  stays `''`. **ONE best row per `(user, mode, track, car, surface)`** (unique key = the upsert
  target), so the board shows each player once per mode. **RLS: public read** (signed-out can browse;
  ⚠️ needs `grant select on public.leaderboard to anon, authenticated` — now IN schema.sql, was a
  live hotfix); **NO client insert/update/delete** — the ONLY write path is the **SECURITY DEFINER
  `submit_score()` RPC** (the real anti-cheat gate), which enforces, in order: (1) **auth** — reject
  anon (`auth.uid()`; NOT premium, though TA/XP are premium-gated to play so submitters are premium
  in practice); (2) **input validity** — known mode, non-empty track/car, `0 < value ≤ ABS_MAX 1e12`
  (overflow guard); (3) **rate limit** — ≤ **10 accepted submits / user / minute** (via a
  `leaderboard_submits` audit log the RPC prunes); (4) **mode plausibility** — TA `value ≥ floor`
  (`TA_MIN_MS = 3000`, deliberately LOW) **and** `≤ TA_CEIL_MS 3,600,000 ms` (1 h); XP `value ≤
  ceiling` (`XP_MAX = 10,000,000`, deliberately HIGH so no legit run is rejected day one — max XP
  rate ~664/s ⇒ a huge run is well under 1M), each with an optional per-`(track,car)` override in
  `leaderboard_limits` (⚠️ that table's `min_value` is read PER MODE: FLOOR for TA, CEILING for XP —
  same column, two roles; empty by default → tighten by inserting a row, no redeploy); then a
  **mode-aware best-only UPSERT** (TA keeps the MIN, XP keeps the MAX). Nickname is read from
  `profiles` server-side (never client-supplied). The client data layer is `src/leaderboard.ts`
  (`submitScore` / `fetchBoard` [paginated] / `fetchTopAndOwn`), already mode-parameterised; every
  call swallows errors so a network hiccup never breaks gameplay. **Two views over that one query:**
  (A) the **MENU board** (game-menu `LEADERBOARDS`) — a **TIME ATTACK / XP mode toggle** + TRACK +
  CAR pickers (the menu isn't tied to a selection; the track list is mode-scoped), **paginated
  25/page** (Prev/Next + count), own row highlighted gold; (B) the **selection QUICK-VIEW** — a
  "VIEW LEADERBOARD" button (shown when Time Attack OR XP + car + map are picked) opens a compact
  **top-10 + your own row/rank** (own shown even if outside the top), no pagination. Both: signed-out
  can VIEW (public read) and see a "sign in to submit" note. **SUBMIT** (`submitLeaderboardBest`)
  fires ONLY on a new LOCAL personal best — TA at `done.isBest`; XP at `handleXpEnd`'s `isRecord` —
  signed-in only, fire-and-forget, keyed `(mode, currentMap.id, xpCarKey(), '')`, and now carrying
  **ZONE proof** (below). Migration lives in `supabase/schema.sql` (idempotent, run in the SQL
  editor). A **total-lifetime-XP** board (vs today's best-single-run XP) is a separate future step.
  The old unused `scores` table is left in place (superseded by `leaderboard`).
- **CHECKPOINT-ZONE anti-cheat (Phase 2, both modes) — LIVE.** Each racing track's CENTRELINE (the
  map's `zonePath(world)` — the ribbon/oval midline, arc-length-even, anchored at the finish,
  oriented forward) is split by `zones.ts` into **6 EQUAL arc-length ZONES**, full ribbon width
  (which-zone = nearest-centreline point). It's ONE validity rule for local best AND leaderboard:
  **TA** — a lap sets the record + submits ONLY if all 6 zones were entered IN ORDER (this feeds
  `TimeAttackRun.update`'s new `zonesValid` param alongside the off-track flag; the submit carries
  `{z:[6 split ms]}`). **XP** — a survival run needn't finish, so zones are PROOF-OF-PLAY, not a
  gate: the submit carries `{zc:distinct-zones, laps:loops, ord:contiguous}` and the run records +
  submits only if that's internally consistent (`xpProofValid`). Combined with off-track (>2 wheels
  off) it catches shortcuts whether they cut across grass OR reverse on the ribbon. The
  `submit_score` RPC gained a **`p_proof jsonb`** param + a **STRUCTURAL** check (TA: 6 present +
  monotonic; XP: no-play/contradiction/teleport rejected) — the 5-arg function is DROPPED and
  replaced by a 6-arg with `p_proof default '{}'` so an old cached client still resolves (its submit
  fails the zone check until it reloads — fire-and-forget, no gameplay impact). ⚠️ **STRUCTURAL
  ONLY — no per-segment speed floors yet**: the TA splits are stored so a future per-`(track,car,
  segment)` MINIMUM-TIME check (a `leaderboard_limits`-style table) drops in server-side with ZERO
  client change. `race.ts`'s dormant checkpoint machinery is UNTOUCHED (XP builds no RaceState, so
  zones are a standalone module serving both modes; full-width arc-length bands also avoid the
  false-invalidation a proximity circle risks on a sweeping corner).
- **Track editor (E)** — per map type; on OPEN maps a place-elements editor, on CIRCUIT maps a
  laps/XP panel. **Locked to the Desktop map + PREMIUM only** (free users get the upsell).
- **Track AUTHORING tool (dev)** — `track-editor.html` (see §2): draw a new circuit layout
  freehand, refine control points + band width live through the real circuit pipeline, export
  drop-in `AUTHORED_SKETCH`/`AUTHORED_BAND`/`AUTHORED_DIRT`/`AUTHORED_FINISH_I`/`AUTHORED_KERBS`.
  Marking tools (each a toolbar button + clicks on the ribbon, right-click cancels/clears):
  DIRT (two clicks → `{i0,i1}` path-index arc, forward in drawing direction, wrap allowed),
  OKRAJ DIRTU (TOGGLE: click points across the band at a dirt end, dblclick commits — points
  connected STRAIGHT per boss's spec → `AUTHORED_DIRT_EDGES` 0–2 polylines, auto-assigned to
  the NEARER end, a new one replaces it; a line BEYOND an end MOVES that end out to the
  line — the band stretches to reach it, is destination-out CUT to the exact polyline
  (+EXT=12-sample margin), and the dirt PHYSICS border follows to the line's nearest path
  index (`AUTHORED_DIRT_EDGE_INFO` extStart/extEnd) so grip and render agree to within the
  polyline's irregularity, the rallycross-accepted divergence; `AUTHORED_GRAVEL` run-off
  polygons (gravel physics via the 4-tone mask, off-track, under-ribbon paint); ⚠️ the cut polygon is
  LOCALISED — intersected with the band segment around ITS end (index window) — because the
  winding track can bring ANOTHER dirt section close to the line and an unbounded
  destination-out cut erased it there (boss-reported bug, fixed in both map and editor);
  the editor's `dirtLayer` is the ONE shared shape for ink tint, mini paint and both
  worn-line clips),
  GRAVEL (TOGGLE: FREEHAND swaths — draw with the mouse like drawing the track, adjustable
  brush width via the "gravel štětec" slider; multiple strokes; right-click deletes the last,
  or exits → `AUTHORED_GRAVEL` `{w,pts}[]` strokes stroked at brush width (traceWornPolyline
  smoothing), painted UNDER the tarmac circuit-style so ribbon overlap hides, baked into the
  4-tone mask as class 3 → real 'gravel' physics + gravel marks, OFF-track),
  BILLBOARD (place an ad slot by click — feet on the grass — drag to move, "billboard velikost"
  slider sizes the SELECTED board, right-click deletes → `AUTHORED_BILLBOARDS` `{sx,sy,scale}[]`;
  same machinery as the circuit's: shared `drawBillboardBody`/`drawBillboardShadow`/`BILLBOARD_DIMS`,
  leg-ground collision arcs, drive-under-to-hide draw order; `ad:` added by hand in maps.ts later),
  CÍL/finish (ONE click → `AUTHORED_FINISH_I` path index; null = auto lowest-point; rendered
  as the circuit's plain white line, no checker), KERB (two clicks ON AN ASPHALT EDGE →
  `{i0,i1,side}`; the side (+1 left/−1 right of travel) is read from where the first click
  lands vs the centreline; multiple kerbs; right-click on a kerb deletes it), STOPA/ideal
  line (TOGGLE mode: freehand strokes over the track, brush = band×0.30, right-click deletes
  the last stroke, "stopa šířka" slider sets the brush width (per-stroke, adjustable) →
  `AUTHORED_LINE` `{w,pts}[]`; render-only in-game — dark rubbered band on
  tarmac, DIRT_LOOK.line worn tone on dirt, both scratch-layer clipped, rallycross language,
  drawn via the shared `traceWornPolyline` (1-2-1 blur ×3 + quadratics through midpoints, so
  the stroke's sides don't show hand jitter — data stays raw, smoothing is render-time);
  ⚠️ the export now carries stroke points, so IMPORT scopes ctrl parsing to the
  AUTHORED_SKETCH block). Kerb geometry
  comes from ONE shared builder (`buildAuthoredKerbQuads` in maps.ts — circuit kerb language,
  red/white + blue, every dimension a FRACTION of the band ⇒ proportionally smaller on a
  narrower road), used by both the editor and the map so they render identically. The builder
  RAYCAST-clamps each sample's reach to HALF the grass gap along its normal (prefilter skips
  open grass), so two kerbs facing each other across a thin tongue (the tight hairpin before
  the finish) meet cleanly at its middle and run out along the tongue's rounded tip instead
  of crossing into a deformed tangle — an unclamped version deformed there (boss report),
  and a nearest-point clamp falsely thinned ordinary inside kerbs (own-corner distance reads
  as "opposing"; the raycast doesn't, because the ray moves AWAY from the own path). UNDO:
  ZPĚT button + Ctrl+Z, snapshot history (cap 100) pushed before EVERY mutation (drag,
  add/delete point, stroke fit, band gesture = one step, dirt/finish/kerb marking, import,
  new track); a no-move click on a point is dropped so it never eats a step.
- **Circuit II ('circuit2') — LIVE, PUBLIC PREMIUM** (de-gated; `DEV_MAP_IDS` is now empty).
  The boss's first authored track, a playable premium map like the circuit/rallycross: asphalt
  ribbon on grass + his marked DIRT arc (i0 205→664), full race wiring (start gate + forward
  derived from the path tangent, far-point arming, 2-column standing grid that FOLLOWS THE RIBBON
  — a straight-line grid put P8 on grass when the finish sat near a corner, laps, XP) all derived
  from his exported sketch, PLUS a PAINTED starting grid (`drawAuthoredGrid`: 8 boxes = 2 lanes ×
  4 deep, drawn at the `authoredGridPose` poses oriented to the local racing direction, circuit
  half-frame look, track-paint under the cars). ⚠️ The finish derives from the LOWEST drawn point
  — his `[1740,719]` sits ~7 u below the long straight (~710–715), so the line sits at the
  straight's right end; levelling the bottom points would centre it (left as-is, boss's call).
  `flatFinishOf` / `lapFarPointOf` extracted from the circuit's inline derivations (fingerprint-
  proven identical, incl. startLine + spawns: `738f2808`).
- **Cars** — Blitz RS (vector), Stee-Rex (SVG sprite, 2 skins, arcade tune), Fury 200 EVO (SVG
  sprite, dev-only SIM, real AWD physics). Tyre smoke, colour-tinted skids, saturating tyre marks.
- **Keyboard driving** — arrow keys + Space drive a local slot-0 car through the identical physics
  path (for testing without a phone/Supabase).
- **Screen-recording mode (DEV-ONLY)** — a capture tool for the dev to make vertical 9:16 social
  clips. Gated by `isDev()` (DEV_EMAILS); for every non-dev host the keys do nothing and nothing
  appears. **`R`** toggles capture. **Zoom is measured in integer STEPS above a DEFAULT floor**:
  the **default (step 0) = the least magnification that still FILLS THE ENTIRE 9:16 frame with map,
  NO letterbox** (`recFloorZoom() = max(REC_W/logicalPxW, REC_H/logicalPxH)` — the crop
  `REC_W×REC_H ÷ recZoom` must fit inside the world on BOTH axes; on a landscape map the portrait
  crop's HEIGHT is the limiting axis, so at the floor the crop height exactly equals the world
  height and the wider axis pans). This is the most-track / least-zoom framing that never shows
  black bars — e.g. Circuit II (256×144 m ⇒ 1920×1080 logical px) floors at **recZoom 1.778**.
  **`+`** zooms in one step (×1.15 = +15%/step, ceiling 24 steps); **`-`** steps back out but is
  **clamped at the floor** (wider would introduce black bars). Each take starts at step 0. A
  small dev-only **`ZOOM +N`** indicator sits next to the REC chip (+0 at the floor). It renders a
  SECOND, OFF-SCREEN 1080×1920 view that follows the host car (`primaryCar`) and records it via
  `recCanvas.captureStream(60)` + `MediaRecorder` (video-only, no audio track — music is added in
  the editor later; ~16 Mbps VP9/VP8 webm); pressing `R` again stops and auto-downloads a
  timestamped `steerit-YYYYMMDD-HHMMSS.webm`. The follow-cam CLAMPS to the world bounds (same
  standard clamp as the on-screen `updateCamera`, here with the 9:16 crop `REC_W×REC_H` at the
  current `recZoom`): it centres the host car while it can, but near a map edge the camera STOPS at
  the world boundary and the car goes OFF-CENTRE toward the frame edge — the crop never leaves the
  map. Per-axis + derived from the real world size (`logicalPxW/H`) and the current crop size
  (`crop = REC_W/H ÷ recZoom`), so the margin shrinks as you zoom in (clamps closer to the edge at
  higher zoom). Where the crop is larger than the world on an axis (e.g. the portrait 9:16 crop is
  taller than a landscape map at minimum zoom) it centres that axis — unavoidable at min zoom;
  zooming in fills it. Implemented by factoring the world paint out of
  `render()` into `paintWorld(W,H,shake)` and running it a second time with the module `ctx` + the
  `viewScale/viewOffX/viewOffY` camera globals swapped to the off-screen canvas for one synchronous
  pass, then restored — so cars/fx/gates re-rasterise crisply at the recording scale while the track
  BITMAP softens with zoom (its 7.5 px/m ceiling; sharper than crop-upscale, which would blur the
  car too). **⚠️ This does NOT change the on-screen shared view: the reverted follow-cam rule (§3 —
  whole track always visible, constant car size, no follow/zoom/scale) stays intact.** The only
  on-screen change while recording is a small "REC ● · ZOOM +N" HTML chip (top-right). Physics
  untouched (only desktop.ts render/recording code; Blitz golden 0.0e+0 byte-identical).

**Front-end / UI**
- Synthwave design-token system (whole UI). Hero logo image asset. Neon phone UI. Main menu →
  mode select (ARCADE / SIM) → CAR & MAP select (data-driven tiles with rendered previews + spec
  flyouts) → START (fullscreen). Pause menu (resume/restart/exit). Clean surface + styled QR panel.

**Accounts & Payments (LIVE)**
- **Accounts** — Supabase Auth (email+password, verification, reset), nicknames (RPC-validated,
  30-day cooldown), 5-device cap, server-truth `is_premium`. See `auth.ts`.
- **Marketing email opt-in (GDPR)** — a checkbox on the post-signup **nickname prompt** ("Send me
  updates about new tracks, cars and features" + "Unsubscribe anytime."), **UNCHECKED by default**,
  optional (blocks nothing), **tied to NO reward** (freely given). Reaches ALL new registrations
  because it's on BOTH nickname entry points: the OAuth prompt (`#oauth-optin` → `setMarketingConsent`
  RPC after the nickname saves) AND the sign-up form (`#signup-optin`, signup-mode only via
  `applyAuthMode` → `signUp`'s `marketing_opt_in` metadata → the `handle_new_user` trigger). Stored
  on `profiles`: `marketing_opt_in boolean default false` + `marketing_opt_in_at timestamptz` (set to
  `now()` ONLY when opting in — the GDPR "when consent was given" record; null otherwise). Written
  SERVER-SIDE only (SECURITY DEFINER trigger/RPC — the client can't write profiles). Consented users
  are queryable for a future (lawful) send: `select email, nickname from profiles where
  marketing_opt_in`. Migration in `supabase/schema.sql` (idempotent). ⚠️ NOT tied to the separate
  review-for-premium idea. A later "email preferences" UI will add a distinct `marketing_opt_out_at`
  (keep both records) rather than overwriting `marketing_opt_in_at`.
- **Review for free premium** — a signed-in NON-premium user leaves an HONEST review (1–5 stars,
  text ≥10 chars) which, after **MANUAL approval**, grants premium. **Legally clean**: premium is
  for LEAVING a review — **ANY rating qualifies, never a positive one** (no rating threshold in the
  grant); copy says "share your honest feedback — any rating qualifies". A **separate default-
  unchecked publish-consent** checkbox governs ONLY a future website showcase and does **NOT** gate
  the reward (consent stays freely given). **NO auto-grant**: `submit_review` sets `status='pending'`;
  premium is granted ONLY by the manual `admin_approve_review(id)` (owner/service-role, run in the
  SQL editor — never client-callable). **⚠️ GRANTED PREMIUM IS A SEPARATE FLAG** — `profiles
  .granted_premium` (+ `granted_premium_at`), NOT `is_premium`. Effective premium (auth.ts) =
  `is_premium OR granted_premium`; Stripe/billing ONLY ever touch `is_premium`, so a granted/comped
  user can NEVER be wiped by any present/future Stripe revoke/refund/reconcile logic and is never
  counted as a paying customer (paid = `where is_premium`; comped = `where granted_premium`). Table
  `public.reviews` (id, user_id, nickname [server-side], rating, body, publish_consent, consent_at,
  status, created_at, reviewed_at), RLS: own-read + PUBLIC read of approved+consented only (for the
  showcase), RPC-only write. Button `#gm-review` (game-menu, gated to signed-in non-premium via the
  existing `free` flag), modal `#review-modal` (`reviews.ts` client). One active (pending/approved)
  review per user + ≤5 submits/hour. Migration + admin workflow SQL in `supabase/schema.sql`
  (idempotent) — incl. the one-time `johny.frajer` migration onto `granted_premium`.
- **Stripe LIVE end-to-end** — hosted checkout, webhook grants premium, verify-session fallback,
  consent modal. Managed Payments (MoR / EU VAT). See §6. ⚠️ Stripe/webhook/`setPremium`/verify
  ONLY ever set `is_premium = true` (no revoke path exists) — and NEVER touch `granted_premium`.
- **Free vs premium split enforced** (server-truth `is_premium`, defense-in-depth): SIM car + extra
  maps/modes + editor are premium; arcade + basic play are free.
- **⚠️ TEMPORARY EXPERIMENT — TA + XP free for signed-in users** (`FREE_TA_XP_ENABLED = true` in
  desktop.ts, data-gathering; flip to `false` to revert with NO other change). Opens ONLY the MODE
  gate (`isModeLocked`) for `timeattack`/`xp` to a **signed-in NON-premium** user; the SIM-car
  section (Blitz+Fury, via `isSimLocked`) and premium/locked TRACKS (via `isMapLocked`) are checked
  INDEPENDENTLY and stay gated — so a free user gets TA/XP with the ARCADE car (Stee-Rex) on FREE
  tracks only. RACE stays premium. SIGNED-IN required (to appear on the board); a signed-out user
  still hits the sign-in prompt (the upsell reframes to "Play … free — sign in", CREATE ACCOUNT /
  LOG IN). TA/XP mode rows show a gold **FREE** badge (`freeBadge`, replaces the lock badge for
  non-premium) instead of the lock. Leaderboard keys by `car_key`, so free Stee-Rex (`steerex`) and
  premium SIM (`blitz`/`fury`) are SEPARATE boards — no mixing. The leaderboard table/RPC/zone
  validation are untouched (free runs submit through the same auth-only gate). The landing
  **FREE VS PREMIUM** table reflects this: the FREE column tags the temporary items with quiet
  qualifier pills — **`limited`** (temporarily free: Rallycross map) and **`signed limited`**
  (temporarily free + needs sign-in: XP, Time Attack, and the now-`✓` Leaderboard) — a subtle
  outlined `.pr-tag` (opposite weight to the loud `.pr-badge` "more coming"). The tags exist so
  the table stays HONEST when `FREE_TA_XP_ENABLED` is flipped off (nothing there claims permanent
  free access). PREMIUM column also refreshed: Cars **3** (Stee-Rex/Blitz/Fury), Game Modes
  `+ Race, + Time Attack, + XP` (always, no sign-in/limit). Price + BEST VALUE unchanged.
- **Premium promo interstitial** (free/anon only): bold non-flashing, X after ~5 s, 3-min global cap,
  after Start / on Pause / on game-end; CTA → checkout or signup→checkout. Upsell banners show NO
  price (overflow fix); price shows on the landing pricing + game-menu.
- **One-time registration prompt** (`#reg-prompt`, signed-out only): after **~75 s of ACTIVE
  Free Ride play** (accumulated on the existing 500 ms free-ride sampler — counts only
  visible-tab + actually-driving time, PAUSES on hide/menu/idle; independent of the analytics
  session so it survives tab switches), a **non-blocking** bottom-anchored card invites them to
  sign in for the now-free TA/XP + leaderboard. "Enjoying it? Sign in **free** to unlock Time
  Attack, XP & the global leaderboard." Create account / Sign in reuse the normal auth flow
  (`authMode` + `openAuthModal('form')`); X / "Maybe later" dismiss. **Once ever** — a
  `localStorage` flag (`steerit.regprompt.seen`) is set the moment it shows, so dismiss OR
  reload never re-shows it. **Signed-in users NEVER see it** (the accumulator gates on
  `!getAuthState().user`), and it **won't stack** on any open modal/menu/pause. Non-blocking:
  the container is `pointer-events:none` so the game keeps running + drivable underneath — no
  pause, no stolen control. Free Ride has no "finish", so a time trigger is the right shape.
- **OPTIONS** — nickname + Log Out gate on LOGIN state (not premium); anonymous users see neither.

**Infra / discoverability**
- **Legal** — /terms /privacy /refund live + linked (§7). **Security** — RLS default-deny + GRANT
  hardening + headers + verify-session ownership + gated TURN (§8). **SEO** — full pass live (§9).
  **SMTP** via Resend. **Vercel Web Analytics** `inject()` on both entries.

**Perf**
- **Tyre marks** — the saturating multiply composite was running FULL-SCREEN every frame after any
  mark; now a **cached bgCanvas + dirty-rect** composite (committed + pushed), pixel-identical, big
  GPU fill-rate win. Distinct from the earlier **HiDPI DPR-cap (1.5) + baked-smoke-sprite** perf fix.

---

## 5. STATUS — PENDING

### Needs real phones (live verification)
1. **2-phone live multiplayer test** — two cars steering simultaneously, car-car collisions,
   disconnect/reclaim, the live standings + podium order + rematch, and a mid-race DNF — all through
   real Supabase (preview has no real WebSocket). Logic is unit-tested; transport isn't headless-testable.
2. **WebRTC P2P — ✅ VERIFIED LIVE (`ed3b79c`).** A real iPhone + Edge desktop on the same WiFi logs
   `connected via **direct**`. The three-tier transport works end to end with the `e67621c` TURN gate
   in place. **Still to check:** forced-relay (`?rtc=relay`) and the LTE/cellular share (i.e. the
   RELAY tier specifically — only the direct tier is proven), and that the 600 s TTL re-pairs
   transparently mid-session.
   ⚠️ **Debugging lesson — check the DEVICE before the code.** The long fallback hunt was **iOS
   LOCKDOWN MODE**, which disables WebRTC outright; the code was fine. That path is now handled
   gracefully (see §12) and self-reports in one line. Any future "P2P won't pair" report: rule out
   Lockdown Mode / an in-app WKWebView browser (a QR scanner or Instagram, not Safari proper) FIRST.

### Security — OPEN whitehat findings (analysed + confirmed against the code)
The XSS/takeover half of Finding 1 is **FIXED + pushed** (`0eb7300`, see §8). These remain:

3a. **Controller identity impersonation — MITIGATED (`19b5870`), Realtime path still open.**
   DONE: (B) **P2P id binding** — the host routes control/join/colour/name/leave by the
   **DataChannel's verified peer id** (bound at pairing, never re-read from a message), via
   `actingId()` in desktop.ts; a payload claiming a different id is DROPPED. ⚠️ `handleControl`'s
   legacy id-less branch is checked on the RAW payload BEFORE `actingId`, so a rejected spoof can't
   fall through and be handed slot 0 — keep that order. (B2) **offer-hijack guard** — `acceptOffer`
   used to `close(id)` unconditionally, letting a forged offer tear down a victim's live peer; an id
   is now protected while IN USE (`lastSeen` + `PEER_HIJACK_GUARD_MS` 3 s), liveness-based so a
   genuine reconnect still works. (F) **room secret** — a 24-char (~144-bit) crypto key rides in the
   QR (`&k=`) and is part of the Realtime **TOPIC** (`steer:<code>-<key>`), NOT a payload token:
   broadcast is public, so a token in messages would be readable by exactly the attacker it excludes.
   Enumerating the 4-char code no longer allows subscribing, observing ids, or publishing. Code gen
   moved to `crypto.getRandomValues`. Join is QR-only, so zero UX cost — but a phone reaching `/play`
   **without `k`** (old QR / hand-typed link) lands on a different topic and won't see the room; a
   rescan fixes it.
   **STILL OPEN:** Supabase **broadcast carries no attested sender**, so on the REALTIME FALLBACK a
   participant already on the topic can still forge another player's id. The attacker is now narrowed
   to someone actually shown the QR. Closing it needs (C) **TOFU keypair** — phone id = hash(pubkey),
   host binds on first sight (real fix, NO server) — or (D) server-issued token + session registry
   (also fixes 3b).
3b. **Unauthenticated TURN credential issuance — MITIGATED (`e67621c`), not fully closed.**
   DONE: `?s=` is now a HARD GATE (no well-formed `CODE_RE` code → 403 *before* the Cloudflare call,
   generic body); `TTL_SECONDS` 1800 → **600**; rate limits on **three axes** (per-IP 60→30, NEW
   per-code 24/min, NEW per-instance breaker 600/min), checked before any is recorded, recording
   ATTEMPTS (each costs a CF API call), pruning expired entries instead of clearing the whole map.
   **STILL OPEN:** the gate is a **FORMAT** check, not a **liveness** check — a well-formed
   *invented* code still passes, because there is **no server-side session registry** (no room/code
   tracking in `api/`; only `profiles` + `devices` tables; the code is generated client-side in
   desktop.ts and never leaves the client). Closing it = a `sessions` table the host writes on start
   + a lookup in turn.js (~1-2 days) — the same registry option (D) in 3a would need. Also open: the
   limiters are **per warm instance**, so the true global ceiling is higher; a real distributed
   limiter needs Upstash / Vercel KV (~3-5 h, new infra). See the Cloudflare cap caveat in §8.
3c. **Leaderboard SECURITY DEFINER submit RPC + CHECKPOINT-ZONE anti-cheat — DONE for TA + XP.**
   `public.submit_score()` (in `supabase/schema.sql`) is the server-side write gate: auth + input
   validity + rate limit (10/user/min) + mode plausibility (TA floor `TA_MIN_MS 3000` + 1 h ceiling;
   XP ceiling `XP_MAX 10,000,000`; per-`(track,car)` override table) + **STRUCTURAL zone proof**
   (`p_proof jsonb`: TA 6 splits present + monotonic; XP no-play/contradiction/teleport rejected) +
   mode-aware best-only upsert (TA MIN / XP MAX); public read, RPC-only write. Zones = 6 full-width
   arc-length bands off each track's centreline (`zones.ts` + `maps.zonePath`), passed in order for
   TA / proof-of-play for XP, combined with the off-track (>2 wheels) gate. **STILL OPEN:** (a) still
   client-authoritative in that a hacked client could fabricate *plausible* zone splits — the real
   next hardening is **per-segment split-TIME (speed) floors** server-side (the splits are already
   captured + sent; add a `leaderboard_limits`-style `(track,car,segment)` floor, zero client
   change), (b) the rate limit is not a per-map/day cap yet, and (c) the XP board is best-single-run;
   a **total-lifetime-XP** board is a separate future step. Race results stay LOCAL.

### Content / cars
4. **Fury 200 EVO finish** — redo the rough sprite; the physics is real but awaits the phone
   feel-test (and a decision whether it becomes a public/premium car vs staying dev-only).
5. **Reel / killer content** — a 10–20 s gameplay video WITH A PARTY (phone-as-wheel in the first
   2 s, several cars racing). Primarily TikTok / YT Shorts. This is the missing growth unlock (§10).
6. **Roadmap** — interactive taskbar (buttons over the key bindings), circuit follow-ups (kerb grip/
   bump physics), more maps, screenshot-your-own-desktop background, saved tracks, sound (CC0 WAV).

### Physics (analysed, deferred — see §15)
7. **(a) Combined-slip friction-ellipse fix** and **(b) weight-transfer transient (damper) model** —
   both analysed in full, both SIM-only, both break Blitz golden + need a re-tune. Deferred by choice.

### Scaling
8. **Supabase Realtime scaling check** before a viral spike (currently ~12% of the 2M plan).

---

## 6. MONETIZATION & PAYMENTS (LIVE)

- **Model:** free to play + a **one-time $6.90 Premium** (NOT a subscription). The `$4.99` in old
  notes was wrong — the live price is **$6.90**, matching `STRIPE_PRICE_ID` and live transactions.
- **Stripe LIVE end-to-end** — real payments work: hosted Checkout (no publishable key — hosted
  page), the **webhook** (`api/stripe-webhook.js`) grants `is_premium` server-side, and
  `api/verify-session.js` is an ownership-checked fallback that confirms on return. `api/_lib.js`
  reads `PRICE_ID()` from env (REQUIRED, no fallback).
- **Managed Payments is DEFAULT-ON on the account** (confirmed at transaction level: tax line +
  "Managed Payments"), so **Stripe is merchant of record and remits EU VAT**. ⚠️ We do NOT pass
  `managed_payments[enabled]` in code — default-on handles it, and adding the param risks a 400.
- **Checkout consent modal** — immediate-delivery + 14-day withdrawal waiver — gates `beginCheckout`
  and is recorded in the session metadata.
- **Live env vars (Vercel):** `STRIPE_SECRET_KEY` (sk_live), `STRIPE_WEBHOOK_SECRET` (live whsec),
  `STRIPE_PRICE_ID` (`price_1TxueV3OHReYNJwvyU5hMyxx`). No publishable key used.
- **Free vs Premium** (enforced server-side via `is_premium`, defense-in-depth on the locked tiles):
  - **Free:** the arcade car (Stee-Rex), the desktop + basic maps, basic race — taste the main fun.
  - **Premium ($6.90):** the SIM car (Blitz RS), extra maps/modes, the track editor, future content.
  - Price shows on the **landing pricing** + the **game-menu**; the in-app **upsell banners show NO
    price** (an overflow fix). Locked tiles + `chooseMode`/`launchSelected`/editor all re-check
    `is_premium` (a click can't bypass the UI).

---

## 7. LEGAL & COMPLIANCE

- **Pages:** `/terms`, `/privacy`, `/refund` (English) — live, linked from the footer + in-app OPTIONS.
- **Controller:** Jakub Dyk, IČO **02167484**, Zhořelecká 414/19, Liberec, Czech Republic. **Not a
  VAT payer.** Contact **steeritapp@gmail.com**.
- **VAT:** handled by **Stripe Managed Payments (merchant of record)** — Stripe collects/remits EU
  VAT, so the not-a-VAT-payer controller doesn't have to. The legal wording relies on this.
- **ADR body:** ČOI (Czech Trade Inspection). **Minimum age:** 15+ for accounts.
- Refund policy reflects the digital-goods immediate-delivery + 14-day withdrawal-waiver consent.

---

## 8. INFRA, SECURITY & DEPLOY

- **Security audit done** against a real pentest pattern of the same stack (pull the public
  `SUPABASE_URL` + anon key from the bundle, sign up, hit PostgREST/API directly):
  - **RLS default-deny confirmed** on `profiles` / `devices` / `scores`.
  - **GRANT hardening applied** — `REVOKE insert/update/delete` from `anon` + `authenticated` (ran
    in Supabase; the client can never write `is_premium` — only the service-role webhook can).
  - **Security headers** (`vercel.json`): `frame-ancestors 'self'`, `X-Content-Type-Options`,
    `Referrer-Policy`, `X-Frame-Options SAMEORIGIN`, `Permissions-Policy`. ⚠️ `frame-ancestors 'self'`
    will need per-portal relaxing IF we ever embed on CrazyGames etc.
  - `verify-session` is **ownership-checked**. `turn.js` (`e67621c`) is **session-code-gated**
    (no well-formed `?s=` → 403 *before* the Cloudflare call, so a rejected request never bills the
    key), **TTL 600 s**, and rate-limited on **three axes** (per-IP 30 / per-code 24 / per-instance
    600 per minute) — plus the Origin allow-list. Env unset → 503 → STUN-only, nothing breaks; any
    non-ok response degrades a phone to STUN-only rather than failing the join. Remaining gaps +
    the registry/KV work are tracked in §5 3b.
- **PHONE INPUT IS UNTRUSTED — the colour path is hardened (`0eb7300`).** A phone-supplied colour
  used to be stored + rendered verbatim into the host's **`innerHTML`** sinks ⇒ script execution in
  the HOST origin ⇒ its Supabase session (localStorage) was readable = account/entitlement takeover.
  Now: `sanitizeColor()` (lobby.ts) clamps to the shipped palette at the transport boundary
  (`handleColor` **and** `handleJoin`) **and** inside `LobbyState.join`, so `p.color` cannot hold a
  non-palette string; `cssColor()` guarantees only a literal `#rrggbb` reaches CSS; the roster
  swatch label is escaped and `colorName()` never echoes an unknown string. **Rule: any new
  phone-supplied field gets the same treatment — validate at the boundary, escape at the sink.**
  ⚠️ The site CSP is `frame-ancestors` only (**no `script-src`**), so nothing blocks injected script
  as a second line of defence — a real `script-src` would be worth adding.
- **SMTP:** live via **Resend** (support@ / steeritapp@gmail.com).
- **Realtime:** message usage **~12% of the 2M** plan.
- **TODO:** the two OPEN whitehat findings in §5. The **leaderboard submit RPC is now LIVE for Time
  Attack AND XP** (`public.submit_score`, SECURITY DEFINER: auth + mode plausibility [TA floor+1h /
  XP ceiling] + rate-limit + mode-aware best-only upsert, public read / RPC-only write — §4).
  Remaining leaderboard hardening: per-segment split-TIME (speed) floors (the zone splits are
  captured + sent; the server floor check is the designed-in future step), a
  per-map/day cap, and a total-lifetime-XP board. **⚠️ Re-run `supabase/schema.sql` in the SQL editor
  after this deploy** — it's idempotent; it **DROPs the 5-arg `submit_score` and creates a 6-arg one
  with `p_proof jsonb`** (the zone/proof structural check) and keeps the `grant select on
  public.leaderboard`. Until it runs, the new client's submits fail gracefully (fire-and-forget) —
  push first, run the SQL immediately to keep the gap short.
  ⚠️ Cloudflare docs expose **no per-key hard usage/spend cap** for Realtime TURN (only per-allocation
  rate limits: >5 new IP/s, 5-10 kpps, 50-100 Mbps; $0.05/real-time GB standalone). So the old
  "set a TURN usage cap" TODO is **not achievable as a hard cap** — use billing alerts + monitoring,
  treat **key rotation as the kill switch**, and make the app-side issuance gate the real control.
- **Deploy:** Vercel Pro, auto-rebuild on push to `main`. `vercel.json` holds the rewrites (legal
  pages, `/play`) + headers + the `steer-it.vercel.app` `X-Robots-Tag: noindex`.

---

## 9. SEO & DISCOVERABILITY

- **Full SEO pass live + verified:** title/meta description, Open Graph (`og-image.jpg`, sharing
  cards verified), **JSON-LD `VideoGame` schema** (0 errors), `sitemap.xml` + `robots.txt`,
  canonical URL, `steer-it.vercel.app` `noindex`ed (only `steerit.app` indexes).
- **Performance:** hero image 661 KB → **70 KB WebP**.
- **Google Search Console** verified + indexed.
- **No analytics at launch** beyond Vercel Web Analytics + Stripe — the privacy policy states none
  (no third-party trackers).

---

## 10. GROWTH / MARKETING state (context, not code)

- **Instagram:** @dyk_the_viking (personal, verified-eligible via MMA) + **@steerit.app** — the
  ONE social account linked from the site. Two links, both to `instagram.com/steerit.app`, both an
  inline SVG glyph (no icon dependency, no external request): **under the hero CTA** (`.ig-link`,
  "Follow us" — it replaced the Product Hunt launch badge, which is gone from index.html/style.css/
  desktop.ts) and **in the footer row** (`.ig-foot`, beside Contact). Instagram ONLY — no TikTok/X.
- **TikTok:** currently dead / throttled (0 views — likely new-account + outbound-links penalty).
- **Reddit:** r/playmygame posted (4 upvotes, ~2 visits).
- **Product Hunt:** LAUNCHED **11 Aug 2026** — underwhelming (~3 visits). The launch badge that sat
  under the hero CTA has been removed from the site. Treat PH as spent, not pending.
- **itch.io:** RULED OUT — not viable for this game. Not "deferred until more content" but a
  decision; don't re-open it by default. (The 630×500 cover art made for it is still sitting in
  the untracked local `itch-cover/`, never committed.)
- **The missing killer content = a gameplay video with a real party** (several people, one screen,
  phones as wheels). That reel is the growth unlock (§5).
- In-game **billboards / ad holders** exist as future direct-sold ad surfaces; a real ad network
  only makes sense at volume.

---

## 11. KEY DECISIONS

- **Browser-first, NOT native/download** (zero-friction QR). Steam possibly later (packaged Electron),
  after traction.
- **The fake desktop is drawn art** (a browser can't read the real desktop — security).
- **Cars/tracks may EVOKE a 90s rally look, but NO real logos/names/liveries — in the CODE too**
  (no real make/model/parts/championship/tyre/sponsor names in comments or strings). Public
  identities: Blitz RS, Stee-Rex, Fury 200 EVO only.
- **Track type is driven by the presence of a FINISH** (finish = sprint A→B; start only = circuit).
- **Local multiplayer on ONE screen** ⇒ constant car size, whole track visible, no follow-cam.
- **Success metric:** "If you show it to three people at school, do they immediately want to scan the
  QR and play?" — not physics realism.

---

## 12. KNOWN ISSUES / CAVEATS

- **Transport:** the phone still sees an intermittent control dropout every few minutes (the
  underlying mobile-WS reconnect). The RESILIENCE lifecycle makes it GRACEFUL (car preserved in
  place, input ramps to neutral then resumes — no respawn, no runaway). Shrinkable, not eliminable.
- **⚠️ SIGNALING IS A ONE-SHOT — never publish it with `rc.send()` (`8087df8`).** `send()` silently
  DROPS while the channel is between instances; that is right for the 30 Hz control stream (the next
  tick supersedes) and WRONG for WebRTC offer/answer/ICE, which nothing re-sends. A dropped offer
  meant the desktop never called `acceptOffer`, so `hasPeer()` stayed false and the phone was
  stranded on the Realtime fallback for the WHOLE session — on the same WiFi, where direct P2P needs
  no TURN at all. **Rule: anything that must not be lost goes through `rc.sendQueued()`** (holds it,
  flushes on the next SUBSCRIBED, bounded 24 + 10 s TTL so a stale offer can't clobber a fresh peer).
  Pairing also now retries 3× (1.2 s apart) before conceding. The desktop prints ONE line per
  pairing: `player <id> connected via direct | relay (TURN) | fallback (Realtime)`.
- **WebRTC may be ABSENT even on a modern browser — handled, don't "fix" it again (`2ae2f95`).**
  **iOS Lockdown Mode disables WebRTC outright**, and some in-app WKWebView browsers (a QR-scanner
  app, Instagram — not Safari proper) don't expose it either. `peerConnectionCtor()` resolves
  `RTCPeerConnection ?? webkitRTCPeerConnection ?? mozRTCPeerConnection`; if none exists the phone
  logs one line, skips the retry budget, and plays over Realtime. **Never reference a bare
  `RTCPeerConnection`** — it throws ReferenceError inside `startRtc`'s promise chain, and without the
  `.catch()` there that is SWALLOWED into a silent permanent fallback. (SDP/ICE are passed as plain
  objects, so no `RTCSessionDescription`/`RTCIceCandidate` constructors exist to break.)
- **No car without a phone** — cars = slots, spawned on connect (the keyboard local car is the
  exception, for testing).
- **Leaderboards not online** — XP best + race results are LOCAL only; the online path needs the
  SECURITY DEFINER RPC (§5/§8).
- **The RAF-driven loop throttles** in a backgrounded / headless tab — matters for timing checks in preview.
- **The two deferred physics items (§15)** are known model simplifications, analysed, not yet fixed.
- **Fury art is the designer's Tradeventure render** (public + premium, 8 mask-driven colours — §13).

---

## 13. CARS

Each car = a spec (values) running on the ONE physics engine (`physics4.ts`, §14). The physics is
tuned AROUND a car's realistic values, not the reverse. Selection: the menu **mode** picks the
family — SIM → Blitz RS, ARCADE → Stee-Rex; within SIM the dev host also sees Fury in the car picker.

### Blitz RS — the SIM car (the golden benchmark)
Early-90s RWD race coupe on slicks: planted, precise, grips + corners hard, catapults out, past the
limit four-wheel-slides and is catchable. `branch: 'sim'`, no overrides ⇒ its effective params ARE
`PHYS4` ⇒ **byte-identical golden 0.0e+0.** Key `PHYS4`: `massKg 1020`, `weightDistFront 0.53`,
`cgHeight 0.45`, `yawInertiaK 1.20`, `muNom 1.90` (slicks), `maxSteer 0.56` (~32°), `enginePower
276000` (~370 hp), `peakThrust 13000`, `brakeForce 13500`, RWD (`driveSplitFront 0`), slick
`muScale {asphalt 1.0, grass 0.28, gravel 0.35, dirt 0.50}`. RENDERED AS A PNG SPRITE now
(`public/BlitzRS.png`, white body + sunset stripe) — recoloured into the **8 SHARED body colours**
(`STEEREX_SKIN_COLORS`, `BLITZ_SPECS`/`blitzSkinForColor`): a masked multiply tints only the light+
desaturated body panels (shading kept), leaving the stripe/glass/wheels/lights intact — the SAME
phone picker as Stee-Rex. Every skin has no `dims`/`phys4` ⇒ golden intact. (The old vector body +
12-colour `BLITZ_RS_COLORS` are retired from the draw path; the array lingers for legacy hex lookup.)
**Premium.**

### Stee-Rex — the ARCADE car (shipped, free)
The designer's arcade widebody sprite (2 skins: Silver / Graphite). `branch: 'arcade'` + the
`STEEREX_ARCADE` `Physics4Params` override → a forgiving 4WD hyper-arcade tune (AWD 40/60, ~893 hp
lore / hard 300 km/h limiter, easy provokable drift, catchable). The arcade branch adds grip-cut /
drift-assist knobs (`arcadeSpinGrip`, `arcadeDriftGrip`, `arcadeHbLatGrip`, `arcadeDriftAssist`, …)
gated behind `branch === 'arcade'` so SIM is untouched. Dims 4.027 × 2.000 m, `fxScale 1.7`. **Free.**

### Fury 200 EVO — PREMIUM SIM car (real AWD rallycross physics)
A Group-B rallycross special (Ford RS200 Evolution silhouette + Tradeventure white/blue livery —
internal reference only, public name "Fury 200 EVO"). **Public + premium** — it sits in the SIM car
picker for everyone (`furySelected()` is just `selectedCarKey === 'fury'`; the old `isDev()` gate is
gone — `isDev` now only guards `DEV_MAP_IDS` and the dirt-edit tool).
- **8 COLOURS, mask-driven (`d5dc7d2`).** Same 8 swatches as Blitz/Stee-Rex, same phone picker.
  Blitz's arithmetic "light + desaturated = body" rule CANNOT work here and must not be reused:
  Fury's GLASS (saturation 36) falls inside it, and its white decals are the EXACT same RGB as
  white bodywork, so no colour-only test separates them (a connected-component rule fails too —
  the bodywork itself splits into several large regions). The body region is therefore stated
  explicitly by **`public/Fury-mask.png`** (WHITE = recolour, BLACK = keep; greyscale, pixel-aligned,
  13 KB). Protected: glass, chevrons, logo tile, taillights, vents, blue wordmarks. Taking the body
  colour BY DESIGN: pinstripes, logo arrow, the white "Trade" on the spoiler — livery accents.
  One source bitmap ⇒ the 8 colours are geometrically identical (no drift); the hitbox is
  `FURY_DIMS`, never the art. `fury-sprite.ts` refuses a mask whose size doesn't match the sprite
  (logs + disables recolour) rather than smearing colour over the branding.
  ⚠️ Known + accepted: on Graphite the dark hood/spoiler text loses contrast, on Blue the navy
  chevrons sit close to the body. Inherent to fixed branding over a variable body, invisible at
  in-game size, and the car-select tile shows white.
- **Mechanism:** a `VehicleSpec.phys4: Partial<Physics4Params>` (the sim analogue of `arcade`)
  layered on `PHYS4` by `physFor`; the physics4 AWD path is gated on `driveSplitFront > 0` (NOT on
  branch), so a SIM car drives all four wheels **with no engine change**. Blitz has no `phys4` →
  `physFor` returns the exact `PHYS4` reference → **Blitz stays byte-identical golden.**
- **Real params (anchored to the RS200 rallycross):** `driveSplitFront 0.37` (permanent 4WD, 37/63
  rear-biased; the equal L/R per-axle split already models the viscous LSDs), `massKg 1100`,
  `weightDistFront 0.50` (50/50), `cgHeight 0.48`, `yawInertiaK 1.02` (LOW polar moment, Iz≈1144),
  `muNom 1.55` + `tireB 9` + `tireC 1.35` (compromise universal tyre — lower tarmac peak, broader),
  `muScale {asphalt 1.0, grass 0.60, gravel 0.70, dirt 0.85}` (keeps grip off-tarmac), `peakThrust
  21000` + `enginePower 485000` (~650 hp / ~590 hp/tonne, no turbo-lag model), `maxSteer 0.58`,
  `brakeForce 14000`, `brakeBiasFront 0.58`, geometry `wheelbase 2.53` / `trackWidth 1.50`.
- **Measured emergent character** (harness, Fury vs Blitz): 0-100 **2.40 vs 3.03 s** with **less
  wheelspin** (AWD traction); cornering **1.45 vs 1.84 g** (lower tarmac peak) but planted mid-corner;
  power-on tail-out **β 41° vs 28°** and lift-off **β 38° vs 5°** (eager, hard-to-gather rotation —
  low polar moment + 50/50 + rear-biased AWD). No NaN, bounded. An AWD rally monster vs the RWD
  race coupé. Physics awaits the phone feel-test.

---

## 14. PHYSICS FOUNDATION — physics4.ts (the per-wheel model)

`physics4.ts` = a full PER-WHEEL vehicle model (4 contact points) and **THE ONLY drive model** —
every car, every map, always. `step4(car, input, dt, p: Physics4Params, surfaceAt?)` is the sole
step; there is no drive-mode toggle (the old kinematic `arcadeModel.ts` + the `step()` model in the
former `physics.ts` are deleted — git only). The shared vehicle data layer lives in `vehicle-core.ts`.

- **Per-car params (`Physics4Params`):** geometry (`wheelbase`, `trackWidth`), mass/balance (`massKg`,
  `weightDistFront`, `cgHeight`, `yawInertiaK`), tyre (`muNom`, `tireB/C`, `tireBx/Cx`,
  `tireEllipseLong`, `loadSensitivity`, `relaxLength`, `tire.muScale` per surface), drivetrain
  (`driveSplitFront`, engine/brake), + the `branch: 'sim' | 'arcade'` flag and the ARCADE-only knobs
  (read ONLY when `branch === 'arcade'`).
- **How a car gets its params (`physFor` in desktop.ts):**
  - arcade → `{ ...PHYS4, ...spec.arcade, branch: 'arcade' }`
  - sim with a `phys4` override (Fury) → `{ ...PHYS4, ...spec.phys4, branch: 'sim' }`
  - sim with none (Blitz) → **the exact `PHYS4` reference** (byte-identical golden).
- **Physics pillars:** grip ∝ load with diminishing returns (load sensitivity); load transfer
  (long + lat, quasi-static, per-car — see §15b); per-wheel slip (lateral angle + longitudinal κ);
  friction ellipse (shared budget, per wheel — see §15a); throttle/brake/handbrake tools; yaw from
  front/rear AND left/right grip diffs + real self-aligning torque (pneumatic trail, rear-only);
  wheel-speed power limit (engine revs with the wheel); relaxation-length slip (kills low-speed
  blow-up); per-surface μ owned by the TYRE; forward-heading thrust so a drift carries speed.
- **Verification:** can't run in the browser preview without a phone/Supabase → an esbuild + Node
  headless harness bundles the real module, feeds fixed inputs, and measures κ/slip/β/g/stability.
  Every change is checked to keep Blitz's golden fingerprint **0.0e+0**.

---

## 15. DEFERRED — analysed, not yet implemented

Two real model simplifications, each fully analysed (read-only passes). Both are **SIM-only**, both
would **break Blitz's golden 0.0e+0** (they touch the shared force path), and both need a re-tune +
recovery verification afterward. Deferred by choice. Arcade (Stee-Rex) has its own knobs and would
be left untouched (gate on `branch !== 'arcade'`).

### (a) Combined-slip friction-ellipse bug — "spin wrongly INCREASES lateral grip"
- **Where:** `physics4.ts`, per-wheel loop. Grip budget `D = mu·Fz` (~L485). Lateral `Fy =
  -D·sin(tireC·atan(tireB·α))` (~L551, from slip ANGLE only). Rear longitudinal `Fx =
  D·sin(tireCx·atan(tireBx·κ))` (~L598, from slip RATIO only). The ellipse: `demand =
  hypot(Fx/(D·tireEllipseLong), Fy/D); if (demand>1) { Fx/=demand; Fy/=demand; }` (~L615). The
  SAME ellipse is re-applied in the sub-stepped rear-wheel ω ODE (~L764).
- **What's wrong:** Fx and Fy are computed from INDEPENDENT single-slip Magic Formulas, then the
  ellipse only CAPS the resultant vector. It's a genuine ellipse *cap*, but NOT a real combined-slip
  model. The longitudinal curve is **non-monotonic** — it peaks at κ≈0.124 (`Fx = D`) then FALLS to
  `≈0.588·D` at deep wheelspin. So as the rear spins DEEPER, Fx falls → the ellipse sees LESS
  longitudinal demand → it frees budget back to lateral → **lateral grip RISES with spin.** Backwards:
  a tyre in deep longitudinal slip is in the kinetic regime and its lateral component should collapse.
  Most active at low speed / heavy throttle (launches, standing power-over, corner-exit mash). (The
  locked-handbrake rear already does the CORRECT thing — one kinetic vector opposite the total slip —
  but only for the handbrake.)
- **Correct model:** couple on SLIP, monotonically — either a slip-vector/kinetic form (one force
  magnitude directed opposite the total slip velocity, so lateral shrinks as κ grows) or Pacejka
  weighting functions (`Fy = Fy0(α)·Gyκ(κ)`, `Gyκ` decays with |κ|). Must fix BOTH sites (body force
  ~L615 AND the ω sub-step ~L764) consistently.
- **Per-car impact:** Blitz — `tireEllipseLong 1.3` was DELIBERATELY chosen so throttle-on-exit
  doesn't crush the rear's lateral grip (the current bug working in its favour); fixing it → more
  power-oversteer, snappier rear, corner-exit mash steps out where it now hooks up, harder launches
  may slide. Fury — same, softened by AWD (front drive stabilises) but its low-polar-moment character
  amplifies "snappier." Arcade — runs the same ellipse but its `arcadeSpinGrip`/`arcadeDriftGrip`/
  `arcadeThrottleCut` knobs already approximate "spin loses grip"; leave it as-is.
- **Scope:** SIM-only via the `branch` gate is clean (arcade already has its own layer). **Breaks
  Blitz golden** (shared hot path — cannot be additively-invisible). Risks: spins that don't catch,
  cars that won't corner under power, launch flips to wheelspin — needs a re-tune (`tireEllipseLong`,
  `muNom`, `tireB/C/Bx/Cx`, `wheelInertiaDrive`, the drift-sustain gates) + recovery verification.
- **Why deferred:** it's a genuine, feel-changing physics change requiring a Blitz re-baseline + tune;
  not a quick fix.

### (b) Weight-transfer transient (no damper model)
- **The good news (already true):** load transfer IS modelled, algebraic/quasi-static, and **fully
  per-car.** `physics4.ts` ~L403–414: `dLong = clamp(m·prevAx·cgHeight/WB·loadTransferLongGain, ±static)`,
  `dLat = m·prevAy·cgHeight/T·loadTransferLatGain`; applied per wheel (~L457–461) as `Fz = FzStatic ±
  dz ± dzLat`, `Fz ≥ 0`. Static `FzF/FzR` from `weightDistFront·m·g/2`. Every term is per-car — mass,
  `weightDistFront`, wheelbase, track, **`cgHeight` (Blitz 0.45 vs Fury 0.48)** — so Blitz and Fury
  transfer load DIFFERENTLY (Fury ~17% more per g longitudinally, ~12% more laterally, from a 50/50
  base vs Blitz's 53/47). Trail-braking rotates, lift-off rotates (Fury lift β 38° vs Blitz 5°), CG
  height is a real lever. **This is not missing.**
- **The simplification:** there are **NO springs/dampers/suspension** — the transfer is the
  quasi-static value computed every frame from the (prev-frame) acceleration, applied instantly. No
  transient: no dive-and-settle, no pitch/roll oscillation, no weight-settling time. (`dLat` is not
  clamped like `dLong` — only `Fz ≥ 0` catches over-transfer.)
- **Fix (if ever):** a first-order lag — a per-car load STATE that relaxes toward the quasi-static
  target with a time constant `τ` (a new per-car param + a WeakMap state field, exactly the
  `prevAx` pattern). CONTAINED mechanically (~a few lines), gives dive settle-time + rotation lag.
- **Why deferred:** it's on the Blitz hot path → **breaks golden** + needs a re-tune, and the
  instantaneous transfer is defensible for a top-down game (predictable, no wobble). The transient
  mostly adds nuance, not correctness. Deferred by choice.

---

## 16. PHYSICS & CIRCUIT EVOLUTION — key lessons (the distilled history)

The full blow-by-blow is in [`docs/CLAUDE-history.md`](docs/CLAUDE-history.md). The lessons worth
carrying forward:

- **The `step()` era (p1–p33) died of patches.** A single-body drift model accreted governors,
  latches, β-targets, spin-arms and thresholds that fought each other; sim-real / sim-real-2 tried
  to bolt real-size geometry + real grip onto it. It sort-of worked but was a tower of band-aids and
  was never trustworthy. **Lesson: tune real parameters, don't add gates.**
- **The rewrite to `physics4.ts` (per-wheel) is what stuck.** Four contact points, honest friction
  circle, real self-aligning torque (pneumatic trail, rear-only) replacing yaw-damper band-aids,
  wheel-speed power limit (engine revs with the wheel, kills runaway wheelspin), relaxation-length
  slip (kills the low-speed blow-up), directional stability from a real weight-distribution margin
  (not a damper). Then the kinematic arcade model + the whole `step()` were deleted — physics4 is the
  one model, with `branch: sim|arcade` for the two feels.
- **Cars are parameter sets, not forks.** Blitz = `PHYS4`; Stee-Rex = arcade override; Fury = sim
  `phys4` override. Blitz's golden 0.0e+0 is the invariant that keeps every addition honest.
- **The circuit was a long render saga** (all `maps.ts`, physics untouched): globally-smooth ribbon
  (control points → centripetal Catmull-Rom → arc-length resample → box-blur), GP kerbs (red/white +
  blue, constant arc-length stripes, tapered wedges — dozens of tuning passes to the boss's marks),
  gravel traps (marked discs − dilate(track+kerbs) − smooth − min-area, with a wheelspin-scaled dig),
  then real per-wheel grass/gravel/dirt PHYSICS, a starting grid + countdown + nose-crossing lap
  timing. **Lesson: verify by MEASUREMENT (mask A/B, pixel harness, PNG-export "eyes") — browser
  screenshots hang here; the physics golden proves no regression.**
- **Perf lessons:** cap the backing-store DPR (1.5), bake the smoke sprite, and never composite a
  full-screen layer every frame (the tyre-marks cached-bgCanvas + dirty-rect fix). Also: any canvas
  you `getImageData` from must be created with `getContext('2d', { willReadFrequently: true })` —
  attributes are fixed at the FIRST `getContext`, so setting it at the read site is a NO-OP if the
  context already exists (swept in `19b5870`: mask/bake canvases in maps/surfaces/steerex-sprite).

---

*Note for Code: keep this file current. The context / rules / decisions / monetization / legal /
infra sections carry knowledge not readable from code — preserve them. Technical details (file and
function names, CONFIG keys, constants, prices, env vars, build/test commands) should be corrected
to match the actual repo whenever they drift. The chronological log lives in `docs/CLAUDE-history.md`
— append new significant steps there (or as concise entries), and promote anything that changes the
CURRENT picture up into these sections.*
