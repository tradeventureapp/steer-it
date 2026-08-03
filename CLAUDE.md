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
play + a one-time **$6.90 Premium** (Stripe, real payments — see §6). Two cars exist today:
**Blitz RS** (the SIM car) and **Stee-Rex** (the arcade car); a third, **Fury 200 EVO**, is a
dev-only SIM test car (§13).

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
  and `circuitMap` (the winding road course: globally-smooth ribbon, GP kerbs, gravel traps,
  built-in start/finish + laps). Surface masks (`surfaceAt` / `markClassAt`) drive grass/gravel
  physics + tyre-mark class. `FLAT_LOGICAL` fixed-world scaling.
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
- `vehicles.ts` — vehicle IDENTITY + specs: `VehicleSpec` (`overrides`, `branch`, `arcade`, **`phys4`**,
  `dims`, `sprite`, `fxScale`), `ROAD_SPEC` (Blitz), `STEEREX_SILVER/BLACK`, `FURY_SPEC` + dims +
  colour palettes. Pure data — NO real make/model names anywhere.
- `steerex-sprite.ts` / `fury-sprite.ts` — the two SVG sprite cars, rasterised + cached (nose-up,
  centred on the rotation pivot, mipmap downscale). Fury sprite is a rough placeholder (to redo).
- `auth.ts` — HOST auth + entitlement (Supabase Auth): sign-up/in, email verify, password reset,
  `is_premium` (server truth, RLS), nickname (RPC-validated + 30-day cooldown), device cap (5).
  Phones NEVER import it — joining stays account-free.
- `email.ts` / `nickname.ts` — email normalise + disposable block; nickname format/cooldown helpers.
- `api/` (serverless, plain JS): `_lib.js` (env + Stripe client + `PRICE_ID`), `create-checkout-session.js`,
  `stripe-webhook.js` (grants premium), `verify-session.js` (ownership-checked fallback),
  `billing-debug.js`, `turn.js` (Cloudflare TURN creds, Origin-gated).

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
- **Track editor (E)** — per map type; on OPEN maps a place-elements editor, on CIRCUIT maps a
  laps/XP panel. **Locked to the Desktop map + PREMIUM only** (free users get the upsell).
- **Cars** — Blitz RS (vector), Stee-Rex (SVG sprite, 2 skins, arcade tune), Fury 200 EVO (SVG
  sprite, dev-only SIM, real AWD physics). Tyre smoke, colour-tinted skids, saturating tyre marks.
- **Keyboard driving** — arrow keys + Space drive a local slot-0 car through the identical physics
  path (for testing without a phone/Supabase).

**Front-end / UI**
- Synthwave design-token system (whole UI). Hero logo image asset. Neon phone UI. Main menu →
  mode select (ARCADE / SIM) → CAR & MAP select (data-driven tiles with rendered previews + spec
  flyouts) → START (fullscreen). Pause menu (resume/restart/exit). Clean surface + styled QR panel.

**Accounts & Payments (LIVE)**
- **Accounts** — Supabase Auth (email+password, verification, reset), nicknames (RPC-validated,
  30-day cooldown), 5-device cap, server-truth `is_premium`. See `auth.ts`.
- **Stripe LIVE end-to-end** — hosted checkout, webhook grants premium, verify-session fallback,
  consent modal. Managed Payments (MoR / EU VAT). See §6.
- **Free vs premium split enforced** (server-truth `is_premium`, defense-in-depth): SIM car + extra
  maps/modes + editor are premium; arcade + basic play are free.
- **Premium promo interstitial** (free/anon only): bold non-flashing, X after ~5 s, 3-min global cap,
  after Start / on Pause / on game-end; CTA → checkout or signup→checkout. Upsell banners show NO
  price (overflow fix); price shows on the landing pricing + game-menu.
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
2. **WebRTC/TURN live check** — P2P pairing over Supabase signaling, forced-relay (`?rtc=relay`),
   LTE fallback share; then the Cloudflare **TURN usage cap** before the scale push.

### Before leaderboards go live
3. **Leaderboard SECURITY DEFINER submit RPC** with a per-map/day cap — scores are currently
   client-authoritative; a signed server RPC is required before online leaderboards ship. (Today
   XP best + race results are LOCAL only.)

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
  - `verify-session` is **ownership-checked**; `turn.js` is **Origin-gated** (allow-list; env unset
    → 503 → STUN-only, nothing breaks).
- **SMTP:** live via **Resend** (support@ / steeritapp@gmail.com).
- **Realtime:** message usage **~12% of the 2M** plan.
- **TODO:** Cloudflare **TURN usage cap**; the **leaderboard SECURITY DEFINER submit RPC** (per-map/
  day cap) before scores go online (client-authoritative today — see §5).
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

- **Instagram:** @dyk_the_viking (personal, verified-eligible via MMA) + @steerit.
- **TikTok:** currently dead / throttled (0 views — likely new-account + outbound-links penalty).
- **Reddit:** r/playmygame posted (4 upvotes, ~2 visits).
- **Deferred:** itch.io + Product Hunt — until there's more content (the rallycross car + a track).
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
- **No car without a phone** — cars = slots, spawned on connect (the keyboard local car is the
  exception, for testing).
- **Leaderboards not online** — XP best + race results are LOCAL only; the online path needs the
  SECURITY DEFINER RPC (§5/§8).
- **The RAF-driven loop throttles** in a backgrounded / headless tab — matters for timing checks in preview.
- **The two deferred physics items (§15)** are known model simplifications, analysed, not yet fixed.
- **Fury sprite is rough placeholder art** (to redo); Fury is dev-only.

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

### Fury 200 EVO — dev-only SIM car (NEW, real AWD rallycross physics)
A Group-B rallycross special (Ford RS200 Evolution silhouette + Lombard-RAC-style white/blue
livery — internal reference only, public name "Fury 200 EVO"). **Gated to the dev host** (`isDev()`
= logged-in email ∈ `DEV_EMAILS` = `dykous94@gmail.com`); appears in the SIM car picker **only** for
that account. Invisible + unselectable + never even sprite-baked for any normal user.
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
  race coupé. Sprite = rough placeholder (§12). Physics awaits the phone feel-test.

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
  full-screen layer every frame (the tyre-marks cached-bgCanvas + dirty-rect fix).

---

*Note for Code: keep this file current. The context / rules / decisions / monetization / legal /
infra sections carry knowledge not readable from code — preserve them. Technical details (file and
function names, CONFIG keys, constants, prices, env vars, build/test commands) should be corrected
to match the actual repo whenever they drift. The chronological log lives in `docs/CLAUDE-history.md`
— append new significant steps there (or as concise entries), and promote anything that changes the
CURRENT picture up into these sections.*
