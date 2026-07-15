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
- **Realtime transport (three-tier, recent — see the running log):** originally Supabase
  Realtime Broadcast only (WSS:443 passes school firewalls). Since extended to WebRTC P2P
  as the primary tier — phone↔desktop tilt over a DataChannel (`src/rtc.ts`), with Supabase
  used ONLY for signaling; a Cloudflare TURN relay (`api/turn.js`) for NAT-blocked players;
  and Supabase Realtime as the final fallback. Order: direct P2P → TURN relay → Realtime.
  This makes Realtime signaling-only for everyone (closes the quota problem). A Step-1 send
  DEADBAND (idle control 30→5 msg/s) also cut Realtime traffic. AWAITING a live 2-phone test.
- **Hosting:** Vercel (paid Pro plan)
- **Repo:** github.com/tradeventureapp/steer-it (PRIVATE)

### Entry points
- `index.html` → loads `src/desktop.ts` (the PC / game surface).
- `play.html` → loads `src/phone.ts` (the phone controller). The QR points at
  `${VITE_PUBLIC_BASE_URL}/play?s=<CODE>`.
- `src/style.css` — all styling (desktop HUD, QR panel, editor, phone UI). Every
  surface derives from ONE synthwave design-token block at the top (`:root`):
  the SUNSET hero language (matches the Claude-designed "Steer It Hero"): logo
  fill `--grad-accent` = vertical gold→orange→pink→magenta; CTA `--grad-cta` =
  horizontal orange→pink→VIOLET; `--screen-bg` = a sunset BLOOM (orange core →
  pink → purple, behind the hero) + faint tinted grid; `--gold` secondary
  (REPLACED the retired neon-cyan accent — no cyan anywhere in the app);
  functional `--ok` green; glow tokens (`--glow-hero` vs `--glow-subtle` for
  crisp in-game chrome); font tokens (`--font-display` = Orbitron headings /
  `--font-body` = UI text + all numbers/HUD / `--font-mono` = debug terminals).
  The HERO WORDMARK treatment (shared by `.menu-logo`, `#qr-logo`, `#pause-title`,
  `.rf-title`, `#unlock`): a sunset-gradient text FILL with a fat WHITE outline +
  stacked dark 3D EXTRUDE + outer glow, painted behind by a `::before` that
  mirrors the text via a `data-text` attribute (em-based offsets so it scales per
  wordmark). The MAIN MENU is a cardless full-bleed hero (`#main-menu .menu-card`
  bg/border/shadow removed) so the bloom sits directly behind STEER IT; the
  tagline is "DRIFT YOUR DESKTOP" (italic, outlined). Map-select/pause/results
  keep their card. Change the look here, not per-rule.

### Key files (all source under `src/`)
- `physics.ts` — vehicle model (drift physics). THE CORE — see rules below. Exports
  `CONFIG`, `makeCar`, `step`, `collideWithRects`, `bodyToWorld`, types `CarState`/`Inputs`.
  DRIFT MODEL SPLIT (p23): the sustained-drift code is split into TWO selectable
  branches via `CONFIG.driftMode` ('arcade' | 'sim', default 'arcade'), chosen in
  `step()`. **`arcadeDriftSustain()`** = the existing governed-drift model (betaTarget
  angle governor + vTarget speed governor + latch + spin-arm), extracted VERBATIM and
  FROZEN byte-identical to HEAD (proven: arcade==HEAD = 0.0 across grip/launch/drift/
  spin/handbrake/footbrake). It is frozen FOR NOW so the sim work can't regress it —
  NOT permanently locked; revisitable by choice. **`simDriftSustain()`** = the new
  drift, built p24 as **RAW EMERGENT FRONT-CARVE, PURE PHYSICS, NO assists** (the
  deliberate foundation to tune arcade FROM). Inside a drift (sim+`driftActive`-gated,
  so arcade/grip stay byte-identical) the front wheels are UN-NEUTERED — `alignGate` +
  the front-slip limiter are relaxed by `driftFrontCarve` (1.0=full) — so the front's
  lateral force CARVES the path and the radius EMERGES (`R = v²/a_lat`).
  `simDriftSustain` itself only runs the LATCH (gates the carve), an honest SCRUB
  (`driftScrubRate`, default 0 = pure physics; NO held-speed thrust), and the SPIN-ARM
  (the ONE retained non-physics term — additive `spinYawRate` so full-lock-held reaches
  the 360°). NO governor / β-target / curvature controller / `driftAssist` scaling — β,
  radius and speed all fall out of the tyre forces. `driftSpeedSensitivity` (1.0 = full
  v²) is RESERVED, not wired.
  **p25 — SIM REAR-GRIP FIX (mid-steer drop-out → sustain):** p24 dropped out at
  moderate steer because rear KINETIC reaction (`budget·rearDriftFriction` = 16200·0.65
  = 10530 N) > engine drive (~9000 N) → the wheel couldn't stay spun → rear regripped →
  grip turn (only full-lock's lateral slip kept it lit). FIX = a SIM-gated lower rear
  kinetic friction `CONFIG.driftSimRearGrip` (default **0.50**, vs arcade 0.65), swapped
  into `fk = budget·grip` ONLY when `driftMode==='sim' && car.driftActive` (one value at
  physics.ts:1182, feeding BOTH the slide force AND the wheel re-integration). Reaction
  16200·0.50 = 8100 N < 9000 drive → the wheel STAYS spun under throttle → `rho>1` → rear
  lateral grip stays collapsed → the slide SUSTAINS, throttle-driven (real physics: a
  drift-setup car has a lower-grip rear; NO β-target/assist). Arcade uses
  `rearDriftFriction` unchanged → byte-identical (proven 0.0e+0 full suite).
  **HONEST MEASURED RESULT (the key finding):** the grip fix WORKS — the drift now
  LATCHES 100% across the steer range (no more drop-out) — BUT raw sim **SPINS at any
  steer ≥ ~0.5 at every grip 0.40–0.65** (continuous rotation ω≈5 rad/s, not a held
  angle). The spin is NOT from rear grip — it's the **front-carve relaxation removing the
  auto-countersteer (`alignGate`)**: nothing pulls the heading back to the velocity, so
  the provoked yaw runs away. There is **NO raw `driftSimRearGrip` value that both
  sustains AND avoids spinning at moderate steer** (only 0.25 steer / ~20 km/h grips
  without spinning). Recovery is CLEAN (lift+straighten → ω→0, β→0, regrips — at all
  grips 0.40/0.45/0.50), so it's twitchy/spinny, NOT a soft-lock. CONCLUSION: raw sim
  needs the **CATCH-ASSIST brought forward = re-introduce scaled auto-countersteer
  (`alignGate`) via `driftAssist`** to convert the sustained-but-spinning slide into a
  held drift — exactly the deferred assist. NOT added here (per the raw-only constraint);
  flagged for the next pass. Default left 0.50 (sustains + recovers cleanly). Speed-pinned
  radius @0.50 is controllable (R 1.1–3.8 m steer 0.5–1.0, wide only at 0.25); scrub
  honest (62→5 km/h full-lock). Foot-brake edge: a broken-loose foot brake drops
  `driftActive` (so it leaves the sim path almost immediately) → negligible. Both pure
  per-car functions (deterministic, N-car safe; no new module state). Dev toggle
  (arcade⇄sim) + `driftFrontCarve`/`driftScrubRate`/`driftSimRearGrip` on the PC 'D'
  tuner; NO player menu yet. (An earlier yaw-rate-target attempt was REVERTED — it
  imposed yaw, didn't stabilise β.)
  **p26 — SIM CATCH-ASSIST (added, but MEASURED INERT — real blocker found):** added
  `CONFIG.driftSimCatch` (0..1, default 0.45) + the one β-gated line `alignGate *= (1 −
  driftFrontCarve·(1 − driftSimCatch))` (physics.ts:984, sim+driftActive-gated) to
  re-apply a tunable fraction of the auto-countersteer. PROVEN SAFE: catch=0 is
  byte-identical to the pre-change sim build (no-op floor), arcade byte-identical to
  HEAD, 360° still reachable, post-spin recovery clean. **BUT the catch has ZERO
  measurable effect at ANY value (0→1.0 identical β/R/ω in every steady-state cell).**
  ROOT CAUSE (the key finding): the raw sim drift **scrubs its speed away** (40–60 km/h
  → **5–10 km/h**) and settles into a STABLE **on-the-spot donut** (β 50–77°, R 0.3–0.6 m,
  ω≈4.5, ωsd≈0.05 = steady, NOT a runaway spin — the earlier "spin" was a `rev>1.25`
  metric mislabelling steady circling). At that walking-pace speed the EXISTING
  `alignGate` low-speed gate (`clamp((speed−2)/2)`, ≈0 below ~2 m/s) — plus the spin-arm's
  `spinRelease` — already hold the countersteer at ~0, so the catch has nothing to scale.
  **The missing lever is SPEED RETENTION, not countersteer.** Proof: the SPEED-PINNED
  sweep (speed artificially held) gives a CONTROLLABLE radius (R 1.1–3.8 m, steer 0.5–1.0);
  the FREE-RUN collapses only because the raw model loses the speed. So the real next pass
  is a **scaled SPEED-HOLD** — bring back a fraction of the `vTarget` held-speed thrust
  removed in p24 (scaled like the catch/grip knobs) so the drift TRAVELS instead of
  donuting in place; THEN the catch (un-gated by the now-higher speed) can fine-tune the
  angle. The catch line is shipped as the proven foundation (inert until speed holds),
  live on the D tuner.
  **p27 — SIM SPEED-HOLD WAVE (Verze 2, the fix that made the drift TRAVEL):** added a
  β-faded, throttle-driven, handbrake-excluded, entry-capped speed-hold correction along
  VELOCITY in `simDriftSustain` (after the scrub block) + `CONFIG.driftSimSpeedHold`
  (default **0.5**, window 0.4–0.7) + per-car `CarState.driftEntrySpeed` (captured at the
  latch). `betaFactor = clamp((|β|−20°)/(40°−20°),0,1)` → FULL in deep β (open drift →
  retains momentum → TRAVELS), FADES to 0 as β closes 40°→20° → hands back to normal
  UNCAPPED engine drive which accelerates the car out past entry. One-sided cap at
  `driftEntrySpeed` (refills toward entry, never net-gains). `SPEEDHOLD_REF = 26` m/s².
  **MEASURED — all guardrails + the wave PASS:** (a) arcade byte-identical to HEAD
  (0.0e+0); (b) speedHold=0 byte-identical to pre-change sim (floor); **(d) THE WAVE works
  — entry 55 → open drops to ~14 km/h → straighten+throttle ACCELERATES out to 62 km/h
  (≥ entry) via normal drive**; (e) deep-β anti-boost cap holds (full-lock never exceeds
  entry: 44<60 km/h); (f) handbrake guardrail EXACT — speedHold contribution 0.0e+0 under
  handbrake, hb+gas scrubs to ~1 km/h (boost-donut dead); (g) off-throttle scrubs, 360°
  reachable, recovery clean; (h) determinism + per-car (no module state). **The drift now
  TRAVELS and HOLDS:** moderate steer settles at a bounded **β≈37° @ ~12 km/h** (vs p26's
  collapsing donut at 5–10 km/h with wild β50–77°) — nothing spins, the angle is held by
  the speed-hold/grip equilibrium. **HONEST CAVEATS:** (1) the **catch (`driftSimCatch`)
  is STILL inert** — catch 0 vs 0.45 identical even now, because the spin-arm's
  `spinRelease` (armed by the handbrake provoke, sustained at steer ≥0.47) zeroes
  `alignGate` ahead of the catch; it is NOT currently needed (the drift holds without it),
  but to make it bite the sim spin-arm SUSTAIN threshold must be raised so moderate steer
  lets it decay (flagged, not done). (2) Travel speed is **modest** (~12 km/h, R≈0.7 m =
  a tight traveling donut, not the 20–35 km/h target) — raising `SPEEDHOLD_REF` or the
  knob pushes it up to the entry cap; left for feel-tuning. Live on the D tuner alongside
  the other sim knobs.
  **p28 — SIM DRIFT-BUILD POWER-TO-GRIP (throttle now WILLINGLY spins the rear):** the
  audit found the car couldn't power-slide because steady drive (9000 N) sits BELOW both
  the static grip budget (16200 N) and the kinetic reaction (budget·rearDriftFriction =
  10530 N) — deliberate (grippy corners), but it means pure throttle never breaks the rear
  loose. FIX = a SIM-gated drift-build engine (a car PARAMETER, applied whenever
  `driftMode==='sim'`, NOT driftActive-gated): `CONFIG.driftSimEnginePower` **12500 N**
  (+1970 over the 10530 reaction → willing wheelspin that STAYS spun, yet 3700 UNDER the
  16200 static budget → straight-line still GRIPS, no rocket) + `CONFIG.driftSimBoostFadeSpeed`
  **40 m/s** (vs arcade 14 → the steer-gated launch boost stays alive at mid/high speed so
  the power-slide works moving, not just at standstill). Wired at the `driveBoost`/
  `powerLimitedForce` block (`simEngine`/`simFade` locals, sim-gated). PAIRED with a
  sim+driftActive-gated **total-speed slip normalisation** (`sDenom = max(floor, |v_total|)`
  inside a sim drift, vs `|forwardVel|` otherwise) so the slip-ratio denominator/stiffness
  can't collapse when `forwardVel→0` sideways. **MEASURED:** (a) ARCADE byte-identical to
  HEAD (0.0e+0 across cornering/launch/brake/drift/handbrake/top-speed — engine/fade/slip
  all gated off in arcade); **(b) SIM POWER-SLIDE works — throttle+steer (NO handbrake)
  breaks the rear loose and holds wheelSpin 100% / rho>1 across 20/40/60/80 km/h** (not
  just standstill); (d) NOT A ROCKET — sim straight-line GRIPS (0% wheelspin, no burnout),
  0–50 km/h 1.42 s (vs arcade 1.98 s — stronger but sane), top speed 124 km/h = arcade
  (the P/v crossover is unchanged); (e) determinism + per-car, NO global `slipDenomFloor`
  change (the total-speed denom is sim+driftActive-gated). **HONEST NOTE:** the total-speed
  slip-normalisation (#4) measures as **no behavioural change** — `driftSimRearGrip` (0.50,
  already shipped) keeps the rear lit at deep β, and wheelSpin%/longitudinal force saturate
  at `maxSlipRatio` regardless of the denominator, so the deep-β wheelspin is already
  healthy; the term is kept as a harmless, more-correct normalisation + a safety net if
  rear grip is raised, but the ACTIVE levers are the drift-build power + fade. Power-to-grip
  live-tunable on the D tuner (`driftSimEnginePower` 12500 / `driftSimBoostFadeSpeed` 40).
  Trademark-safe: internal wording is generic "drift-build reference" only — NO real make/model names
  anywhere.
  **p29 — SIM DRIFT TWO-GAP CLOSE (the TRAVELING DEEP drift, by tuning existing forces only):**
  a STEP-0 sensitivity sweep (perturb each existing force, measure Δ equilibrium β) proved the
  ONE lever that moves held β is the **front sliding-grip** (`peakLatGripFront·frontDriftFriction`):
  ×0.7→β67°; catch/rearGrip/carve/yaw/inertia all INERT (≤0.1° Δ); `autoCounterStart` minor
  (6°). Closed both gaps with multiplicative scales on existing forces (NO new terms):
  • **(b) DEEPEN + TRAVEL = the win.** Raised the existing sim speed-hold (`SPEEDHOLD_REF`
    26→40, `driftSimSpeedHold` 0.5→0.7) → a provoked free-run drift now **TRAVELS**: 40 km/h
    entry → sustained **33 km/h @ β45°**, 55 entry → **49 km/h @ β43°** (was scrubbing to ~14
    km/h @ β28°). Depth + travel both hit the 30–45° target. The shallow "~20°" was always the
    scrubbed-to-low-speed donut; holding speed deepens it. + `CONFIG.driftSimFrontSlide` 0.9
    (the swept β lever; mild — cliffs <0.78 at steer 0.6; cleans up the high-steer cases
    55→40°). Low entries retain entry speed by the anti-boost cap (15 entry → 8.7 km/h, a
    tighter donut — EXPECTED, the cap is logic, left alone).
  • **(a) LOW-SPEED FRONT AUTHORITY — WEAK, honestly reported.** `CONFIG.driftSimFrontAuthority`
    1.5 (a low-speed-faded ×scale on the existing `frontLatForce`, faded out by 8 m/s). Measured
    only MARGINAL: steer 0.7 @ 15 km/h β 8→14° (pinned), steer 0.8 free-run 12→14°; **moderate
    steer 0.4–0.6 STILL burns out at low speed (β 2–6°)** — gap (a) is NOT fully closed. Honest
    physics resists a low-speed moderate-lock drift; the real drift path is **provoke (lock/
    handbrake) → it travels deep**. Kept as a live knob (helps a bit, tunable), not oversold.
  • **reversedSpin GUARD (the one logic change, sim-gated):** `reversedSpin` now also requires
    `!(sim && |bodyBeta| ≥ driftModeFull)` so a deep slide's `forwardVel`-noise can't spuriously
    un-latch the drift; a genuine low-speed reverse still drops it (proven). Arcade latch
    byte-identical.
  **MEASURED:** (a) ARCADE byte-identical to HEAD (0.0e+0, full suite — all p29 scales gated on
  `sim && driftActive`); traveling drift 33–49 km/h @ β43–45°; full-lock 360° still reachable;
  NOT a rocket (sim 0–50 1.42 s, top 124 = arcade); determinism + per-car, NO global
  `slipDenomFloor`/`enginePower`/front-grip change. **CATCH A/B (`driftSimCatch` 0.45 vs 0.80):
  IDENTICAL β 45±24° — still inert, kept 0.45 per the measurement rule.** Knobs live on the D
  tuner (`driftSimFrontAuthority` / `driftSimFrontSlide` / raised `driftSimSpeedHold`).
  **KNOWN CAVEATS:** the traveling drift β oscillates (~±24° around 45°) — deep + traveling but
  not rock-steady (the catch can't damp it — inert); and gap (a) low-speed moderate-steer
  initiation stays a burnout (needs lock/provoke).
  **p30 — SIM DRIFT NOW HOLDABLE (spin-arm threshold raise — the catchable drift):** the phone
  feel-test found the p29 traveling drift couldn't be HELD — it spun out and countersteer
  couldn't catch it. MEASURED ROOT CAUSE: during a normal moderate-lock drift the **spin-arm
  was armed the whole time** (`spinTimer` 0.15, `spinRelease` 1.0), which (1) zeroed `alignGate`
  → killed the auto-catch, and (2) **injected `spinYawRate` the player couldn't overcome** → β
  ran away (−88→+87°, ω 5.5). The spin-arm armed because the handbrake provoke (steer 0.9 ≥
  `spinReleaseThresholdHB` 0.90) armed it and holding steer 0.7 sustained it. FIX = sim-gated
  higher arm thresholds (value change only, NO new force term): `CONFIG.driftSimSpinArm` **0.95**
  (vs arcade `spinReleaseThreshold` 0.78) + `driftSimSpinArmHB` **0.97** (vs `spinReleaseThresholdHB`
  0.90), swapped at the `armThreshold` site only when `driftMode==='sim'`. Now a moderate-lock
  drift never arms the spin-arm → `spinRelease` stays 0 → `alignGate` + the player's countersteer
  regain authority. **MEASURED:** (a) ARCADE byte-identical to HEAD (0.0e+0, full suite —
  thresholds sim-gated); **(b) DRIFT HOLDS — hold steer 0.7 → β −42° held, ω 5.5→1.0 (no runaway,
  β bounded ±36 vs ±88); β TRACKS steer (ease 0.4→β3, 0.6→β16, 0.7→β42) = controllable**;
  (c) 360° still reachable at committed full lock via the HB provoke (arms at |steer|≥0.97);
  (d) CATCH A/B 0.45 vs 0.70 STILL identical (β16±1.8) → kept 0.45 — still inert because the
  SETTLED drift sits at β≈16° BELOW `alignGate`'s 20° engagement (`autoCounterStart`); (e) not a
  rocket (sim 0-50 1.42s, top 124), determinism + per-car, NO global spin-arm threshold change.
  **KNOWN CAVEATS:** holdable + controllable but still oscillates somewhat (ω 1–1.4, not
  rock-steady); a HARD opposite countersteer flick transitions the drift (expected = a
  Scandinavian flick), gentle countersteer controls the angle cleanly; the catch stays inert
  until the held β exceeds 20° (lowering sim `autoCounterStart` is the next lever for a steadier
  auto-damp). Knobs (`driftSimSpinArm`/`driftSimSpinArmHB`) live on the D tuner.
  **p31 — SIM THROTTLE→GRIP cleanup (no inversion + no false low-speed burnout):** phone test
  found two unhealthy low-speed behaviours on a STRAIGHT pull-away. **(A) throttle→grip inversion:**
  `rearLoadFactor` (p19b `loadTransferGain` 0.35) ADDS rear lateral grip under acceleration (0.3
  throttle→×1.16, 1.0→×1.35) → more throttle = MORE grip, inverting the player's force-vs-grip
  principle. FIX = sim-gated `CONFIG.driftSimLoadTransferGain` **0** (arcade keeps 0.35 →
  byte-identical) so throttle ONLY removes grip via the friction circle (monotonic). **(B) false
  low-speed burnout + false skids:** `rearSlip = atan2(rearLat, max(MIN_LONG 0.5, |forwardVel|))`
  — at low speed a HAIR of lateral reads as a huge slip angle → `nLat>1` → `rho>1` → false
  `isRearSliding` → the rear longitudinal reaction collapses → drive spins the wheel UNOPPOSED at
  any throttle → a 4 m burnout that then cruises (the car still accelerates — false visual/feel).
  FIX = sim-gated **REAR-ONLY** slip-angle floor `CONFIG.driftSimRearSlipFloor` **4.0** (front
  `MIN_LONG` 0.5 untouched). MAGNITUDE-SENSITIVE (the key): `atan2(0.3, 4)=4°` (a hair → grips, no
  burnout) but `atan2(3, 4)=37°` (full lock → still slides) → the false burnout dies WHILE the
  real full-lock low-speed drift SURVIVES. Acts only below ~4 m/s `|forwardVel|`; above it `|fwd|`
  dominates → no-op. **MEASURED:** (a) ARCADE byte-identical to HEAD (0.0e+0, full suite — both
  sim-gated); **(b) ACCEPTANCE TEST PASSES — hair-steer (0.05) + 20–30% throttle: 100%→0%
  wheelspin, drives cleanly to ~17–26 km/h** (no 4 m burnout); (c) throttle→grip MONOTONIC at all
  speeds; **(e) ⚠️ LOW-SPEED FULL-LOCK DRIFT SURVIVES — β 27/21/21° at 10/15/20 km/h UNCHANGED**
  before vs after (the magnitude floor preserved it); (f) false skid 5→0 frames; (g) drift exit
  hooks up (lift 100→23% wheelspin); not a rocket (0-50 1.42s, top 124). **FIX A proven INERT in
  the wave-exit + straight-accel** (ltGain 0 vs 0.35 → identical 45 km/h exit, 1.42s 0-50) — it
  ONLY removes the inversion, no regression. **CHECK-(d) CLARIFICATION:** the p29 "traveling 33–49
  km/h @ β43–45" was the PRE-p30 SPINNING car (β45 = mean of a rotating car); **p30 already
  settled it to a held β≈16° @ ~15 km/h** — p31 preserves that exactly (not a p31 regression; the
  check compared a stale baseline). Knobs (`driftSimLoadTransferGain` 0 / `driftSimRearSlipFloor`
  4.0) live on the D tuner; determinism + per-car.
  **p32 — SIM SPEED-HOLD WAVE REMOVED (rocket donut killed; drift speed now honest throttle-vs-
  scrub):** phone video of a deliberate spin (hodiny) at full throttle showed the car HOLDING
  65–74 km/h THROUGHOUT the spin (never-slowing rotating carousel, huge looping skids) — physically
  wrong (a spin = enormous scrub → must bleed). ROOT (measured): the p27 speed-hold `wave`
  (`driftSimSpeedHold`) is `betaFactor`-gated to DEEP β, i.e. ONLY the SPIN regime, where it pumps
  speed back to `driftEntrySpeed` every frame → holds 70 km/h. FIX = `CONFIG.driftSimSpeedHold`
  **default 0** (wave OFF; block kept = proven no-op, reversible on D). p28's drift-build power
  makes the wave REDUNDANT for the normal drift. **MEASURED:** (a) ARCADE byte-identical (0.0e+0,
  wave sim-only); **(b) SPIN BLEEDS — full-lock+throttle from 70 km/h: wave-on held 53→70 (rocket)
  → wave-off BLEEDS 52→6 km/h ✓**; (c) normal drift still sustains on HONEST DRIVE (17 km/h, not
  scrub-to-stop); **(h) DRIFT EXIT ACCELERATES — straighten+throttle CLIMBS 5→69 km/h** (aligned
  nose → drive aligned → propels; runs on honest drive, NOT the wave); acceptance test (hair 0.05 +
  20% throttle = 0% wheelspin) + arcade identity intact; determinism + per-car.
  **HONEST SIDE EFFECTS (reported, the accepted trade):** the wave WAS what made a deep drift
  "travel" — removing it means the sustained drift is now **honest throttle-vs-scrub: ~16–18 km/h
  at ANY angle** (both shallow steer 0.55 AND deep 0.8 bleed 50→~16–18 from a fast entry — the
  drive points along HEADING, ~60–80° off velocity at drift angle, so it CANNOT hold drift speed at
  any angle on 1/3-scale; this is PHYSICS, not an `enginePower` bug — confirmed, NOT chased). The
  held drift is also **shallower + a tighter low-speed donut** than with the wave (β≈9° @ ω≈3.4 vs
  the p30 β16/ω1) — β stays BOUNDED (controllable tight donut, NOT a spin-out), just slower→tighter.
  So: **spins BLEED, the straighten-throttle EXIT accelerates hard, the drift HOLDS but slow/shallow
  — the "fast deep traveling drift" was the artificial wave and is gone by choice** (the player
  chose honest physics over the rocket). (Earlier p29 "traveling 33–49 @ β43" = this wave holding a
  spinning car — corrected.) `driftSimSpeedHold` live on D (raise to re-enable the wave).
  **NEXT: feel-test on phone (spins bleed, exit accelerates, no rocket); if the slow/shallow
  sustained drift feels weak, that's the depth item — needs a NON-wave lever (or accept honest
  physics); Handbrake drift behaviour = Pass 3.**
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
  STEERING = PITCH-INVARIANT ROLL (`steeringRollDeg`): steer is read purely from
  the gravity component along the device's LONG axis (`lastAy` = device Y = the
  screen's horizontal / left-right axis in landscape), as `asin(ay/|g|)` in
  degrees, then the existing deadzone(3°)+range(55°)+expo(1.0)+`STEER_SIGN`
  mapping. Because PITCH (tilting toward/away from you) is a rotation ABOUT that
  same long axis, it cannot change the axis's own gravity component → pure pitch
  contributes ZERO steer; only true left/right ROLL moves it. Level = 0 for
  EVERYONE with NO baseline / no per-user neutral snapshot (symmetric about
  level). This REPLACED the old cross-dot-vs-captured-neutral approach, which
  mixed pitch into the reading and needed a drive-start re-center; ALL of that
  (`calibrate`/`calibAx`/`calibAy`/`calibrated`/`recalibrating`/`driveStarted`/
  `noteDriveStart`/`maybeAutoRecenter`) is REMOVED. The full 3-axis magnitude
  normalises the angle so pitch (which only bleeds gravity into Z) never scales
  the centre. `STEER_SIGN` (default +1) flips left/right globally if a device
  reads mirrored (the long-axis gravity sign depends on which way the phone was
  turned into landscape). CANNOT be tested headless (no sensors + Supabase env
  gate) — verify on a real phone. 3-finger tap toggles the orientation debug
  strip (shows `roll=…° steer=X.XX rng=70°`). The steering RANGE (full-lock roll
  angle) is BAKED at `const TILT_RANGE_DEG = 70` (chosen by on-phone feel
  testing); the temporary live range tuner — the "range −/+" tap buttons + the
  mutable `tiltRangeDeg`/clamp/step state — has been REMOVED. Deadzone (3°), expo
  (1.0), `STEER_SIGN` (-1), and the asin roll math are unchanged.
- `world.ts` — the drawn desktop: `layoutDesktop`, `drawWallpaper`, `drawOverlay`,
  `drawClock`, collision rects (`rebuildRects`), icon hit-test/drag
  (`iconAt`/`clampIconToBounds`/`resolveIconDrop`), types `DesktopWorld`/`DesktopIcon`.
- `maps.ts` — MAP SYSTEM. `MapDefinition` (background/obstacles/spawn/bounds/wrap/
  drag), a registry (`registerMap`/`getMap`/`listMaps`/`hasMap`, `DEFAULT_MAP_ID`),
  `desktopMap` (map 1, delegating to `world.ts`), and the STADIUM-oval family
  (maps 2 + 3 — a wide oval via `computeStadium`/`stadiumPath`/`stadiumBarriers`:
  straights + semicircle turns; barriers ONLY on the inner/outer edges (straights
  = thin rects, turns = small squares strictly off-band) so the band drives
  freely; grandstands (crowd only) + floodlights decor; grid spawn on the start
  line. NO ads yet — all placeholder banners removed; real ad surfaces come later
  beside the stands + in the infield. Band widened ~⅓ INWARD (outer edge fixed,
  inner moved toward centre)).
  STADIUM FACTORY — both ovals are built by ONE `makeStadiumMap({id,name,surface,
  smokeColor})` factory so they share a SINGLE source of truth for geometry,
  barriers, spawn grid, bounds, `fixedWorld`, `startLine`, and decor (proven
  mathematically identical: 182 barrier rects / startLine / 8-spawn grid all
  match). The ONLY per-map inputs are VISUALS — the racing-ring `surface`
  ('dirt'|'asphalt') and the `smokeColor`; NO physics/grip override is taken or
  applied (every stadium map inherits the single locked tune identically —
  per-surface grip comes LATER, on the dirt side; asphalt is the grippy
  baseline). The ring surface is painted by ONE shared `drawTrackSurface`-style
  routine (`drawStadiumSurface(ctx,wPx,hPx,style)`) keyed by `SURFACE_STYLES`
  (only the ring gradient + groove tints differ), and decor by one shared
  `drawStadiumDecor`. The two maps: **`flatTrackMap`** (id `'flat'`, "Flat Track")
  = warm-brown DIRT ring + brown dust; **`asphaltTrackMap`** (id `'asphalt'`,
  "Asphalt Oval") = dark tarmac-grey ASPHALT ring (subtle rubbered-in racing
  line, NO lane markings/kerbs) + white rubber smoke. Both register, both appear
  as their OWN map-select tile with a real preview; `steerSwitchMap('asphalt')`
  works. An asphalt↔dirt hover toggle is DEFERRED.
  Per-map smoke tint via `MapDefinition.smokeColor` ([r,g,b], default white
  `[248,248,251]`): desktop = white rubber smoke, asphalt = white rubber smoke,
  flat = brown dust `[170,126,84]` (`effects.ts` stores the tint per particle).
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
  **MAP 4 — the WINDING CIRCUIT (`circuitMap`, id `'circuit'`, "Circuit")** — a
  technical road course from the boss's hand-drawn sketch (17 control points), in
  OUR asphalt-on-grass style (the oval's `SURFACE_STYLES.asphalt` tones + green
  surround). NO barriers / NO collision — grass all around, drive off freely
  (`createWorld` returns `rects: []`); `trackType: 'open'` (no built-in start line
  yet). `fixedWorld = FLAT_LOGICAL` (= one screen) so it renders exactly like the
  oval and the whole track fits one screen at the STANDARD car size (see the camera
  rule in §3). Track width = 2/3 of the oval band.
  **GEOMETRY PIPELINE (why it's smooth — the key lesson):** per-node spline tweaks
  only RELOCATE kinks; the fix is GLOBAL. `CIRCUIT_PATH` (computed once at load) =
  control points → dense CENTRIPETAL Catmull-Rom → arc-length RESAMPLE to 1000 EVEN
  points → circular box-blur SMOOTH (r14×2) → resample again = ONE globally-smooth
  ribbon, no sharp point anywhere (measured max turn <2°/pt, min radius > band/2).
  **FINISH/BOTTOM STRAIGHT:** the spline OVERSHOOTS below the straight entering the
  corners (a dip = a visible outward bulge); fixed by CLAMPING every dip up to the
  straight level (`CIRCUIT_STRAIGHT_Y`) + a light re-smooth → DEAD-flat + horizontal
  with no kink; sits near the bottom edge; spawn (`CIRCUIT_FINISH`) on its flat
  centre, heading +x.
  **KERBS (`CIRCUIT_KERBS`) — visual-only + DRIVABLE (NO grip/bump physics yet):**
  red/white striped kerbs on the OUTER (grass-side) edge as track EXTENSIONS — they
  ADD surface OUTWARD into the grass, the asphalt width is UNTOUCHED (they never eat
  asphalt). A solid BLUE strip on the grass side of each kerb (asphalt → red/white →
  blue → grass). Stripes are a CONSTANT PHYSICAL size via KERB-EDGE ARC LENGTH
  (`KERB_STRIPE` ≈2.2 m — centreline arc would COMPRESS them on tight corners).
  Gradual TAPERED entry/exit (no abrupt start/stop). Placed on: the corner apexes
  (concave `turnSign` normal) + ONE continuous OUTER-PERIMETER run (left sweep +
  bottom straight + right sweep, on the OUTWARD normal) — all built by ONE unified
  `emitKerb(sStart, sEnd, normFn, blueOnly?)` helper. The red/white stripes END with a
  HARD CUT snapped to a whole stripe block (last block full-size, no shrink/taper); the
  BLUE does NOT stop with them — it runs over `[sStart−TAIL, sEnd+TAIL]` and CONTINUES
  past each stripe end as a TAIL (`KERB_BLUE_TAIL` ≈2.5 blocks): past the stripes the
  blue slides onto the asphalt edge (fills in, like the blue-only zone) and its width
  TAPERS to 0 → it "flows onto the asphalt and dissolves" (no hard blue end). BLUE-ONLY
  sections (`KERB_BLUE_ONLY`, the bottom of the outer run): stripes removed (hard cut),
  the blue holds the FULL kerb width out to the same grass edge (asphalt → blue → grass,
  continuous). The grass edge is FIXED (`KERB_WIDTH + KERB_BLUE_WIDTH`), asphalt width
  untouched. Per-kerb `KERB_CUTS`/`KERB_EXTENDS` trim/lengthen
  specific kerbs to the boss's marks. Drawn in `drawCircuitSurface`; physics.ts
  untouched throughout (the many kerb passes were all render-only, tuned by the boss
  over photos/marks — the running log has the blow-by-blow). Kerb grip/bump physics
  + a start/finish line + laps are DEFERRED (§5).
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
  (`FX_CONFIG.maxParticles`); emission stops at the cap. **SMOKE is split BURNOUT vs
  SLIDE (render-only, physics byte-identical):** burnout (longitudinal wheelspin) =
  DENSE, emitted BEHIND the wheel, inherits ~25% of car velocity (`inheritVel` 0.25)
  → billows off the tyre; slide (lateral scrub) = THINNER (lower `alphaMul` + rate),
  WORLD-anchored at the CONTACT POINT (`inheritVel` 0) so it STAYS PUT and the car
  slides away from it (marks where the tyre scrubbed the asphalt). Overall smoke was
  cut ~½ + made more transparent for the restrained SIM look (`smokeRatePerWheel`
  55→28, `smokeAlpha` 0.20→0.16).
- `sound.ts` — `SoundEngine` (WebAudio). OFF by default; toggled by the M key / button.
- `supabase.ts` — Supabase client + `channelName(code)` + `createResilientChannel`.
  Realtime client config: 15s heartbeat with **`worker: true`** (the heartbeat
  runs in an inline-blob Web Worker so it ISN'T throttled when the host tab is
  unfocused — that background-tab `setInterval` throttling was the ~60s socket
  idle-drop root cause) + fast `reconnectAfterMs` (250ms→2.5s). The wrapper
  auto-reconnects: on CLOSED/TIMED_OUT/CHANNEL_ERROR it removes + re-creates +
  re-wires + re-subscribes a fresh channel for the same room (250ms→3s backoff) —
  no QR rescan. Throws if env vars missing (gates the whole app; headless preview
  without env vars won't boot). **Connection resilience is now governed by ONE
  model — `RESILIENCE` in `lobby.ts` (Phase 1)** — the single source of truth that
  replaced three separate point-patches (de1f475, 47319e6, respawn-at-start) and
  reconciled every scattered timeout. Per phone, age = time since its last packet
  drives one ordered lifecycle: `≤ INPUT_COAST_MS` (400ms) CONNECTED = hold last
  input; `… INPUT_NEUTRAL_BY_MS` (1000ms) RECONNECTING = ramp input linearly to
  neutral (no twitch, no runaway, handbrake released); `… PRESENCE_GRACE_MS`
  (20000ms) RECONNECTING = **car/slot/race/XP PRESERVED IN PLACE** (the car is
  never removed, never teleported to start, never loses laps/XP — a reconnect-by-id
  reclaims the SAME car); `≥ PRESENCE_GRACE_MS` DEPARTED = free slot, remove car,
  finalize race (`raceManager.remove` — `isComplete` ignores departed cars so the
  podium never deadlocks). INVARIANT: `INPUT_COAST < INPUT_NEUTRAL_BY <
  PRESENCE_GRACE`, and PRESENCE_GRACE must exceed the worst transport reconnect so
  a recoverable reconnect is NEVER mistaken for a departure. The desktop still
  gates the DEPARTURE sweep on its OWN channel health (`channelReady` + a
  PRESENCE_GRACE reconnect grace) so a desktop drop never mass-frees slots.
  Verified by a Node test (29 assertions: preserve-in-place, clean depart ≥20s,
  reconnect-by-id, no race deadlock, ramp). Phase 2 (reconnect jitter / packet
  idempotency / lobby-broadcast debounce / phone-side downlink watchdog) and
  Phase 3 (uplink↔downlink channel split + send-rate cut, with load-testing) are
  PENDING/DEFERRED — not urgent. D-debug logs packet gaps, RECONNECTING/LIVE
  transitions, and long frames.
  KNOWN REMAINING ISSUE (transport, not logic): the phone still sees an
  intermittent control dropout every few minutes — the underlying mobile-WS
  reconnect (heartbeat-timeout / network blip). Phase 1 makes it GRACEFUL (car
  preserves in place, input ramps to neutral then resumes — no respawn, no
  runaway), so it's a brief blip, not a break. It is "shrinkable, not eliminable"
  and the fix is Phase 2 (above). CONFIRMED (June 2026, around the a7c0e40 car
  redesign) that this dropout is the pre-existing TRANSPORT issue, NOT a
  regression from the cosmetic car/colour commit — diffs proved that commit
  touched only `drawCar` + the colour list, with `physics.ts` and ALL of the
  resilience/sweep/lastSeen logic byte-identical.
- `rtc.ts` — WebRTC P2P layer (recent). Phone initiates a PC + two DataChannels
  ("control" unreliable-unordered tilt stream = the EV.control payload shape;
  "state" reliable = lobby/join both ways); signaling rides the existing
  `steer:<code>` Supabase channel (`rtc-offer`/`answer`/`ice`). On control-DC open
  the phone LEAVES Realtime (`rc.stop()`); 8 s fallback to Realtime if P2P never
  opens; reconnect-by-id. Injectable PeerFactory → unit-tested headless. TURN creds
  from `api/turn.js` (Cloudflare, TTL 600 s; env-unset → 503 → STUN-only). Desktop
  logs per-pairing `via direct | relay (TURN) | fallback (Realtime)`. Transport-
  agnostic seam: the desktop/phone EV handlers are called from BOTH the Realtime
  wire and the rtc callbacks. LIVE test PENDING (no local Supabase/NAT here).
- `api/turn.js` — Vercel serverless fn (plain JS, OUTSIDE tsc/Vite) that POSTs
  Cloudflare `credentials/generate` for short-lived TURN iceServers; Origin
  allow-list; needs `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` in Vercel env.

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
- `CAR_COLORS` — the Blitz RS palette (12 muted retro/90s colours), defined in
  `vehicles.ts` as `BLITZ_RS_COLORS` and re-exported by `lobby.ts` as `CAR_COLORS`
  (so the phone picker + per-slot defaults + roster names all read it).
  `defaultColorForSlot` wraps for N > 12.
- `RESILIENCE` (lobby.ts) — connection lifecycle single source of truth:
  `INPUT_COAST_MS 400` / `INPUT_NEUTRAL_BY_MS 1000` / `PRESENCE_GRACE_MS 20000` /
  `HEARTBEAT_MS 1200`. (Replaces the old `STALE_INPUT_MS` + `IDLE_TIMEOUT_MS`.)
- `NAME_MAX = 12`, `PHONE_HEARTBEAT_MS = RESILIENCE.HEARTBEAT_MS`,
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
- **FOOT BRAKE — grip-relative target-slip (p21).** `brakeForce = 38000` (BAKED from
  feel-test: 21000→30000→38000) + `brakeGripFraction = 0.85` (physics.ts). The foot
  brake was reworked from an
  explicit per-frame wheel-speed DECREMENT into a force inside the friction circle:
  it pulls the rear wheel toward the slip that yields EXACTLY its demanded force
  (`sTarget = −(Fbrake/budget)·slipRatioPeak`, `Fbrake = brake·brakeForce·brakeRearShare`)
  and breaks the rear loose only when `Fbrake > brakeGripFraction·budget·longHeadroom`
  (`longHeadroom = sqrt(1−nLat²)`). This is **Fix 1** (grip decides WHEN it lets go,
  not just force) and inherently delivers **Fix 2** (the old `Δwheelspeed ÷ shrinking
  sDenom` artifact that locked a sustained LIGHT brake at low speed ~11-22 km/h is
  gone — slip is now ∝ Fbrake, speed-INDEPENDENT). Force is LINEAR in pedal, constant
  vs speed (longer stop from higher speed falls out of physics). Near-full pedal on
  asphalt CAN break loose → skid (NO ABS); light/medium keeps grip. The whole new
  path is gated behind `brake>0 && !handbrake && !reverseMode`; a broken-loose foot
  brake is added to the wheel lock-force decrement so it locks + sustains via the
  SAME path the handbrake uses. Handbrake / throttle-wheelspin / launch / pivot /
  steering / `slipDenomFloor` / cornering + power-over breakaway are UNTOUCHED
  (verified: brake==0 byte-IDENTICAL across idle/launch/cornering/donut/spin;
  handbrake drift+donut byte-identical; sweep: OLD locks 10% brake at 5-20 km/h, NEW
  never locks at any speed). **BAKED defaults** `brakeForce 38000` / `brakeGripFraction
  0.85`: near-full rear demand `0.35·38000 = 13300 N` sits at the breakaway boundary
  (`0.85·budget = 13770 N` straight), so a near-full pedal breaks the rear loose →
  skid under any steering (where `longHeadroom < 1` lowers the threshold); light/medium
  keeps grip at all speeds. **Both stay LIVE-TUNABLE on the PC `D` debug HUD**
  (`#brake-tuner` +/- steppers mutating CONFIG in-memory, reset on reload — so the
  CONFIG defaults ARE the baseline). The tuner + `D` HUD are intentionally still ON
  (dev-only gating deferred until accounts/email exist). Per-surface DIRT brake-skid
  comes later, free, by
  lowering the rear grip budget (the breakaway is now budget-relative). `brakeRearShare
  = 0.35` unchanged.
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
  lift/straighten → recovers. KINETIC friction (the grip a tyre keeps once SLIDING — NOT
  static cornering grip) is SPLIT front/rear (p18c) because a single value pulled turn-in
  and drift opposite ways: **`frontDriftFriction` 0.83** = FRONT cap → sharp TURN-IN (high
  = the front bites, no understeer; the shared 0.50 in p18 washed it out → yaw ~halved,
  radius 2-3× wider, sim-verified vs 8f2a69f, + cost launch); **`rearDriftFriction` 0.65**
  = REAR circle magnitude → DRIFT slip (lower = looser/stronger/longer slides; 0.65 = strong
  drift that still catches cleanly ~0.8 s). Front 0.83 restores turn-in EXACTLY (180/166/102
  °/s = OLD) at any rear. Feel-tune the REAR by hand: 0.60 looser/deeper (~1.0 s catch) …
  0.70 more catchable. Rear kinetic reaction (budget·rear ≈ 10530 > 9000 engine cap) keeps
  the anti-perma-burnout. With the grippy front the drift is STRONG but more "catch-or-ride"
  than finely proportional (front-grip trait — turn-in and fine-proportionality can't fully
  coexist). All other hybrid wins hold (recovery ~0.8 s, corners grip 1.8°, governor-
  sustained drift, launch 1.9 s, spin fires, rocket settles at assist=1). Holding a 40°+
  drift sits near the spin-arm threshold (tunable via `driftAngleMax` /
  `spinReleaseThreshold`).
- **p20 STEER-GATED POWER-OVER (current, post-p19b — AWAITING phone feel-test).**
  Solves the two long-standing low-speed defects (the "locked donut" and weak
  pure-throttle power-over) with ONE honest gate, no new latches. The low-speed
  torque boost (`lowSpeedTorqueBoost`, the thing that tips the rear into wheelspin
  off the line) is now **STEER-GATED** instead of throttle-only, and the standing
  pivot is **neutralised** (`standingPivot 0` — the governed drift now owns low
  speed): STRAIGHT wheel (|steer| ≤ `boostSteerDead` 0.10) → no boost → drive
  stays under the kinetic reaction → clean **TRACTION** (realistic launch + the
  p19b straighten+throttle EXIT re-grips); TURNED wheel (≥ `boostSteerFull` 0.45)
  → full boost → drive exceeds reaction → wheelspin → a governed **MOVING**
  power-over drift whose SIZE the steering sets — never a locked on-the-spot donut.
  New tunable CONFIG (all p20): `lowSpeedTorqueBoost` 1.2→2.0, `torqueBoostFadeSpeed`
  5→14, `boostSteerDead` 0.10, `boostSteerFull` 0.45, `standingPivot` 0,
  `powerOverSpeed` 16 / `powerOverWheelspin` 0.25 / `powerOverThrottle` 0.45 (the
  low-speed power-over PROVOKE term that engages governed drift). Sim-verified
  OLD(p19b) vs NEW: launch 100%→**0% wheelspin** (traction, 2.0s/50km/h); throttle
  donut 1.5m on-spot→**9.4m moving** drift (β31°); steering sets size **β
  1/24/35/39/54°** across steer 0.2..1.0 (was 0.4..11° — pure-throttle power-over
  was the known-weak caveat, now fixed); exit gate intact (straighten 2.6° /
  hold 34.9°); recovery 0.4s; corner grip 2.0°; **handbrake hold @ real drift
  speed β38.8° @ 46.9km/h = byte-identical to OLD**; rocket settles, spin reachable
  (37.7°). **KEY FINDING:** the "(i) handbrake holds 63° at steer 0.7" reading was
  OLD's standing pivot SPIKING at <4 km/h — the exact on-the-spot locked donut
  Problem 1 removed; they are the SAME mechanism. At every real drift speed the
  handbrake drift is identical OLD=NEW, so removing the pivot loses ONLY the
  walking-pace on-the-spot spin (user chose "ship pivot-off"). DEFERRED to Path B
  (need the betaTarget rework, not urgent): continuous throttle→size, continuous
  power-over band speed-taper, full ~33km/h handoff-dip smoothing. Debug HUD now
  reads the effective steer-gated boost multiplier (was the stale throttle-only
  gate). Commit `3e3731c`. **AWAITING phone feel-test.**
- Physics was LOCKED at the pre-rewrite "good enough" version (tag `pred-prepisem-fyziky`);
  the p18 HYBRID is a SMALL, targeted change on top of it (no rewrite — governor restructured
  behind one assist gain + two tunables). Don't touch with big rewrites — only small targeted
  parameter changes.

### Multiplayer / general
- **Build for N, not hardcoded for 2.** Slots, cars, colors = array/map keyed by slot.
  Player cap = a single config (`PLAYER_CAP`). Target ~10 players, tested with 2.
- **CAMERA: the WHOLE track is ALWAYS visible on ONE screen; the CAR SIZE is a
  CONSTANT.** Steer It is local multiplayer on ONE shared monitor (several phones,
  one screen), so a FOLLOW-CAMERA is NOT allowed — it would force splitscreen. (A
  follow camera WAS tried for the circuit and REVERTED for exactly this reason.)
  Rule: the car renders at a fixed on-screen size, NEVER scaled to fit a track; the
  TRACK is sized to fit the screen at that standard car size (fixed-world maps use
  `FLAT_LOGICAL` = the screen, one uniform scale-to-fit). New tracks MUST fit one
  screen (the circuit's shape was designed in the editor to do so).
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
  (arcade→sim). Kinetic friction SPLIT: `frontDriftFriction` 0.83 (turn-in =
  OLD) + `rearDriftFriction` 0.65 (drift slip, feel-tunable).
  **p19b (race-feel, post-feel-test, AWAITING re-test):** the feel-test kept ONLY
  the throttle-assisted drift EXIT and the 50° lock; everything else from the p19
  Tier-1 prototype was reverted. THROTTLE REAR-RE-GRIP (`loadTransferGain` 0.35)
  is now the ACCEL-ONLY half of the load transfer (`axNorm` clamped ≥0, rear-only):
  while accelerating, the rear's lateral grip is scaled up so STRAIGHTEN+THROTTLE
  pulls a drift cleanly back to grip (incl. full throttle — used to sustain ~27°).
  The lift/brake→rear-lighten half is GONE → no lift-off, no trail-brake entry, no
  moderate-steer eagerness (fine control back to d2fd2e1: s0.5 grips, not 65°).
  `engineBraking` 0 (off), `inertiaScale` 8.0, `maxYawRate` 3.2 (all reverted to
  pre-p19); `maxSteerAngle` 0.873 (50°) KEPT. Sim-verified 3-way vs d2fd2e1 &
  p19-full: exit kept (full-throttle NEVER→0.6s), lift-off/trail-brake/eagerness
  gone, recovery 0.7s, grip 1.7°, launch/brake/sustain/spin/rocket all intact.
  Known minor side effect (tunable): rear is slightly grippier under throttle than
  pre-p19 (the exit aid is always-on when accelerating) — drop `loadTransferGain`
  0.35→0.25 if it feels too strong/grippy. AWAITING phone feel-test. (~85%.)
- **Phone controls** — gyro steering (gravity vector, orientation-agnostic, force-landscape,
  auto-calibration), analog pedals (finger position = value, top 1/4 = saturation),
  handbrake. Steering expo curve (`STEER_EXPO = 1.7`).
- **Fake desktop** — retro Win-XP vibe (green hills, sun), yellow folders with humorous
  English names ("DO NOT DELETE!!!", "taxes_2024_final_v3"...), recycle bin, taskbar.
  Icons = solid obstacles (arcade bounce). **Icons are mouse-draggable** (= live track building).
- **Tire smoke** on drift/burnout (particles, capped at `FX_CONFIG.maxParticles = 340`).
  Split BURNOUT (dense, behind the wheel, inherits ~25% car vel) vs SLIDE (thinner,
  world-anchored at the contact point, `inheritVel` 0 — stays put as the car slides
  away); overall amount cut ~½ + slightly more transparent (SIM restraint). Render-
  only (`effects.ts`), physics byte-identical.
- **Car** — the **Blitz RS**, a top-down early-90s RWD drift coupe (vector-drawn
  in `drawCar`, recolours per slot via `shadeHex`): sculpted boxy 3-box
  silhouette (long hood / short deck), twin round headlights + slim slat grille,
  chrome window/bumper trim, boxy door mirrors, a ducktail, and **dark tyre-tops
  only** (no rim from a bird's-eye view), gloss/AO/drop-shadow shading. Roof
  number = slot number (1-based). Footprint unchanged (1.5 m × 0.617 m).
  ALL marks original — evokes the era, copies no real car; **no real make/model
  name appears anywhere in the code or build** (public identity = Blitz RS only).
  Shipped + confirmed working live (commit a7c0e40). The redesign was
  COSMETIC-ONLY: `physics.ts` stayed BYTE-IDENTICAL (git diff empty), the
  footprint/collision is unchanged, and the car drives exactly as the p19b tune.
  Paired with the retro palette below — the 12-colour **`BLITZ_RS_COLORS`**
  (`vehicles.ts`) wired through `lobby.ts` `CAR_COLORS` to the phone picker +
  per-slot defaults + roster; the old bright neon car colours are gone.
- **Unified synthwave design tokens (whole-UI restyle)** — ALL UI chrome now
  derives from one `:root` token block in `style.css` (see the file's key-files
  entry above): the title-screen language (pink→magenta→orange gradient, purple
  grid background, hero vs subtle glow, Orbitron display + readable body fonts) is
  applied across EVERY surface — main menu, map-select tiles + the Stadium Oval
  Asphalt|Flattrack switcher, QR/lobby/roster, race HUD, finish banner, pause,
  XP HUD + end card, finish-feed + podium, the in-race debug HUD (speed/DRIFT/
  SLIP/WSPIN/pedals/steer), and the phone controller (TAP TO STEER, pedals,
  lobby, colour picker, debug strip). The OLD neon-cyan accent is fully RETIRED —
  replaced by a warm `--gold`; functional greens (connected/ready/gas) stay.
  In-game readouts use the SUBTLE glow + body font so numbers stay crisp in
  motion. The QR matrix is left high-contrast white (scannable) — only its frame
  is themed. Verified by rendering the real `style.css` against static harness
  pages (menu/map-select/HUD/podium/phone) in the dev server + screenshots; no
  cyan remains. CSS/markup-only: `physics.ts` byte-identical, the canvas render /
  track art / car / smoke untouched (the canvas race-gate marker `RACE_CYAN` in
  desktop.ts is part of the render path, left per the no-render-changes rule).
- **Logo** — the STEER IT + "DRIFT YOUR DESKTOP" lockup is a real IMAGE ASSET
  (`public/logos/steer-it-logo.png`, transparent; a `-black-` variant is the
  spare), drawn in the design tool with the correct rounded-italic font + baked
  dark outline + sunset gradient. It is NOT CSS-styled text (an earlier attempt to
  fake it with Orbitron + a text-stroke/extrude looked wrong and was scrapped).
  `index.html` uses `<img class="hero-logo">` on the main menu. The QR join panel
  uses a SEPARATE logo-ONLY mark (no tagline, `steer-it-mark.png`) so the QR stays
  large; that asset is on a BLACK background, dropped via `mix-blend-mode: screen`
  on `#qr-logo img`. PAUSED / FINISH are plain sunset-gradient text (no outline).
  Assets in `public/logos/`: `steer-it-logo.png` (full lockup, transparent — the
  hero), `steer-it-mark.png` (logo-only, black-bg — the QR panel),
  `steer-it-logo-black.png` (spare). To swap a wordmark, replace the PNG.
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
  SURFACE-GROUP TILES (presentation only): maps sharing a `MapDefinition.
  surfaceGroup.key` collapse into ONE select tile (titled `surfaceGroup.title`)
  with an in-tile segmented surface switcher. The two ovals (`'flat'` +
  `'asphalt'`) merge into a single **"Stadium Oval"** tile whose switcher reads
  **Asphalt | Flattrack** (order via `surfaceGroup.order`; Asphalt =
  `isDefault`). The tile holds the selected surface in module memory
  (`groupSurface` Map, SESSION-only — NO storage), DEFAULT `'asphalt'`; the
  mini-preview re-renders the selected surface's `drawBackground`. The switcher
  reveals on HOVER (pointer hosts) and is always visible + TAP-toggleable on
  touch (`@media (hover:none)`); a segment click sets the surface (stops
  propagation), the tile BODY click launches the selected id via `chooseMap →
  switchMap`. Both maps stay independently `registerMap`'d and are resolved by
  their own id at launch/in multiplayer — the merge is purely the select tile.
  Other maps (e.g. Desktop) keep their own tiles. Dev hooks
  `steerSwitchMap('asphalt')` / `steerSwitchMap('flat')` both still work (they
  call `switchMap` directly, bypassing the tile). A future asphalt↔dirt
  per-surface GRIP difference is still deferred (to the dirt side).
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
  resets the (per-map) race track, exits the editor, and respawns cars. **Maps 2
  + 3 = the STADIUM-oval twins**, both built by the ONE `makeStadiumMap` factory
  (shared geometry/barriers/spawn/bounds/`fixedWorld`/`startLine`/decor —
  guaranteed identical), differing ONLY in the racing-ring surface + smoke:
  **`flatTrackMap`** ('flat', 90s DIRT oval): brown dirt ring + brown DUST smoke;
  **`asphaltTrackMap`** ('asphalt', "Asphalt Oval"): dark tarmac-grey ASPHALT ring
  (subtle rubbered-in line, NO markings/kerbs) + white rubber smoke. Both share
  green infield + purple night ground, tyre-wall barriers (FIXED, edge-only AABB
  rects), grandstands (crowd only — NO ads yet) + floodlights, 2-wide grid spawn
  on the start/finish line. NO per-map physics/grip override — the asphalt twin
  inherits the locked tune byte-for-byte (physics.ts unchanged; per-surface grip
  deferred to the dirt side). In the START RACE map-select the two ovals are
  MERGED into one **"Stadium Oval"** tile via `surfaceGroup` (hover/tap switcher
  **Asphalt | Flattrack**, default asphalt — see the Main-menu DONE entry); both
  ids stay independently registered + launched. `steerSwitchMap('flat')` /
  `steerSwitchMap('asphalt')` dev hooks work. A per-surface GRIP difference is
  DEFERRED.
- **Map 4 — the WINDING CIRCUIT (`circuitMap`)** — a technical road course from the
  boss's sketch, in our asphalt-on-grass style, NO barriers (drive off onto the
  grass freely). Globally-smooth ribbon (control points → centripetal Catmull-Rom →
  arc-length resample to 1000 pts → box-blur → resample; no sharp edges). Dead-flat
  horizontal FINISH straight near the bottom edge; spawn on it. Fits ONE screen at
  the standard car size (a follow-camera was tried + REVERTED — §3). **F1-style
  KERBS** (`CIRCUIT_KERBS`, visual + drivable): red/white striped kerbs on the OUTER
  (grass-side) edge as track EXTENSIONS (asphalt width intact) with a solid BLUE
  strip on the grass side, CONSTANT arc-length stripes, tapered transitions, and
  BLUE-ONLY sections (stripes removed, blue holds the full width) — on the corner
  apexes + one continuous outer-perimeter run, all tuned to the boss's marks. Kerb
  grip/bump physics + start/finish + laps DEFERRED. Appears as its own "Circuit"
  map-select tile; `steerSwitchMap('circuit')` works. (See the §2 maps.ts entry +
  the running log for the full geometry/kerb detail.)
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
6b. **Circuit-map follow-ups** — the Winding Circuit (map 4) is a drivable
   asphalt-on-grass course with kerbs, but still to add: kerb GRIP/BUMP physics
   (currently the kerbs are visual + freely drivable, no effect); a START/FINISH
   line + lap counting (it's `trackType: 'open'` with no built-in start line yet);
   optionally gravel run-off / more decor. Physics untouched by all the kerb work.
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

## 9. PHYSICS FOUNDATION — physics4.ts (the per-wheel SIM engine)

- `physics4.ts` = a full PER-WHEEL vehicle model (4 contact points). The game now runs TWO live
  drive models toggled by **X** (`DriveMode` in desktop.ts): **`arcadeModel.ts`** = a simple
  KINEMATIC arcade controller (6 laws, owns v/φ/θ; forgiving; the current default), and
  **`physics4.ts`** = this per-wheel SIMULATION (absolute realism, drift emergent only, never a
  tuned-in feature). Every physics4 change keeps the arcade model byte-identical (0.0e+0). The old
  `physics.ts` (the p1–p33 arcade + sim-real history in the running log) is RETIRED/unreferenced by
  the drive loop — kept in git. A forgiving arcade car ON the physics4 engine is still planned (§10).
- **GUIDING ORDER (core lesson): REALITY sets the numbers; the physics is tuned AROUND them, never
  the reverse.** When a behavior is wrong, find the real physical cause. Don't pick a number just to
  unlock a behavior, and don't paper over a missing mechanism with an artificial damper/gate
  ("band-aid") — every band-aid we added was masking a real missing physical effect.
- **Physics pillars (12):** 1. grip ∝ load with diminishing returns (load sensitivity); 2. load
  transfer (long + lateral, reduces total axle grip); 3. slip (lateral angle + longitudinal κ, per
  wheel); 4. friction circle (shared budget, per wheel, elongated for slicks); 5. three tools +
  countersteer (throttle=rear wheelspin, brake=weight forward, handbrake=locks rear); 6. yaw
  (front/rear + left/right, bounded via real self-aligning torque); 7. inertia/weight;
  8. longitudinal (torque→wheel→drive, power limited at WHEEL speed); 9. forward-heading thrust
  (drift carries speed); 10. surface (asphalt only for now); 11. collisions (later); 12. car spec
  (see §10).
- **Key mechanisms & lessons:**
  * **Self-aligning torque / pneumatic trail, REAR-ONLY:** Mz=−Fy·t, trail max near center,
    collapses past the grip peak. Rear-only because the front's self-aligning acts through the
    steering (kinematic input), not the chassis. Gives progressive grip loss + catchability + killed
    the oval limit-cycle. Replaced an arcade `driftYawDamp` band-aid.
  * **Directional stability = a real STABILITY MARGIN, not a damper:** at 50/50 the neutral-steer-
    point sits on the CoM → throttle tips into divergent power-oversteer; the fix every real RWD has
    is a slight FRONT weight bias → NSP behind the CoM → stable. (An oversized `yawDampConst` was
    masking this — removed.)
  * **Wheel-speed power limit:** the engine revs WITH the driven wheel, so the drive power limit
    uses WHEEL surface speed (ω·r), not car speed. Car speed let a spun-up wheel keep full torque →
    runaway wheelspin → constant smoke at speed. Wheel speed → a slipping wheel drops power →
    self-limits and hooks up.
  * **Wheel inertia (drive) sets hook-up speed:** low inertia → wheel runs away (long spin); raising
    it → brief launch chirp then BITE (correct for slicks; a long low-speed burnout is a worn-tire
    trait).
  * **Friction ellipse elongated for slicks (~1.3× longitudinal):** too round an ellipse lets
    throttle crush the rear's LATERAL grip to zero on corner exit → spin-out; elongated → catapults
    out gripped.
  * **Four-wheel slide is the target past-limit behavior:** whole car slides (both axles), holds
    heading, catchable — not a rear-only snap-spin. From matching the steering lock to the front
    grip peak + a neutral-enough balance.
  * **Trail-braking is subtle by nature:** a directionally-stable car resists foot-brake rotation
    (real stable race cars do too); dramatic past-limit rotation comes from the four-wheel slide, not
    oversized transfer.
  * **Feedback — burnout vs slide smoke:** burnout (longitudinal wheelspin) = dense, behind the
    wheel, inherits ~25% car velocity; slide (lateral scrub) = thinner, emitted at the contact point
    into WORLD space (`inheritVel` 0) so it stays put and the car slides away from it. Render-only
    (`effects.ts`), physics byte-identical.
- **Verification:** physics4 can't run in the browser preview without a connected phone/Supabase;
  verified via an esbuild + Node headless harness (bundle the real module, fixed inputs, measure
  κ/slip/β/grip-g/stability). All changes keep the arcade model byte-identical (0.0e+0).
- **Phase plan:** 0 per-wheel foundation DONE; 1 drive tools DONE; 2 folded into the realism work
  (drift emerges from real physics); 3 gameplay (input tilt curve, feedback smoke/sound/skids,
  forgiveness/assist = the future arcade car) IN PROGRESS. Two-car strategy: this SIM car first, a
  forgiving ARCADE car on the same engine afterward.

## 10. CARS

Each car is a spec (values) running on the physics engine (§9); the physics is tuned AROUND a car's
realistic values, not the reverse.

### Blitz RS — the SIM car (current)
A race-bred coupe: light, powerful, on slicks. Runs on `physics4.ts`. Character: planted, precise,
grips and corners hard, catapults out of corners; past the limit it four-wheel-slides and is
catchable. Drift is emergent, not a feature.
- **Character/stats:** Mass ~1020 kg (light race coupe); ~370 hp inline-six (strong power, NO
  traction control); weight distribution ~53% front (the stability margin, ~52/48 + race bias);
  steering lock 0.56 rad (~32°, sharp race lock, fronts near grip peak); slicks (broad grip peak,
  high longitudinal grip); peak cornering ~1.85-1.97 g; 0-100 ~3.0 s; top ~246 km/h; braking
  ~1.21 g; reverse top speed ~50 km/h (realistic ceiling ~40, 50 = deliberate practical choice).
- **physics4 knobs (current realistic values, reconciled with `physics4.ts`):** `massKg` 1020,
  `weightDistFront` 0.53, `maxSteer` 0.56, `muNom` 1.90, `tireB`/`tireC` 10/1.45, `tireBx` 12,
  `tireEllipseLong` 1.3, `pneumaticTrail` 0.06, `yawDampConst` 150, `loadTransferLongGain` 1.5,
  `loadSensitivity` 0.05, `wheelInertiaDrive` 8, `enginePower` 276000 (≈370 hp), `peakThrust` 13000,
  `brakeForce` 13500 (≈1.21 g), `reverseSpeed` 14 m/s (≈50 km/h; realistic ceiling ~40, 50 = a
  deliberate practical choice for reversing out on-track).
- **Palette:** retro/90s 12-colour set in `vehicles.ts` (`BLITZ_RS_COLORS`).

### Arcade car — PLANNED (the second car)
A forgiving arcade car built on the SAME physics engine, AFTER the sim car proves the physics. This
is where the forgiveness/assist gameplay layer lives (arcade-friendly handling, easy provokable
drift, possibly faster reverse). Not yet built.

---

*Note for Code: keep this file current. The context / rules / decisions / monetization
sections carry knowledge not readable from code — preserve them. Technical details (file
and function names, CONFIG keys, constants, build/test commands) should be corrected to
match the actual repo whenever they drift.*

---
**p33 — SIM front longitudinal-brake knob (added, but the deep+fast goal is PHYSICALLY UNREACHABLE
— honest negative result):** the FREE-RUN decomposition (p32 follow-up) proved the spinning rear
propels +8000 N along velocity (constant, NOT collapsed) but the front cornering force projected
to body-X brakes −6600 N (shallow β) to −15000 N (deep β) → the drift crawls. Added
`CONFIG.driftSimFrontLongDrag` (0..1, sim+driftActive ×scale on `frontForceBodyX = −frontLatForce·
sin(steer)`, the front's along-heading brake; body-Y/cornering/yaw UNTOUCHED — body-X isn't in the
yaw torque so the turn is unaffected). **MEASURED the value sweep — and it does NOT deliver the
goal:** cutting the front brake DOES raise sustained speed (scale 1.0→0.1: 16→24 km/h) **BUT it
SHALLOWS the drift** (β 14°→7°), because the car re-aligns to a shallower/faster equilibrium — it
never holds a DEEP (β25–35°) drift at speed. Root: a DEEP drift inherently bleeds because the rear
propulsion is MISALIGNED from velocity (`cosβ` small) → less along-velocity drive → slow; cutting
the front brake just lets it settle shallower-faster, not deep-fast. So **deep+fast is the same
physical wall the wave faked** (the wave pumped speed along velocity → rocket; honest physics gives
deep=slow OR shallow=fast, not both). Spin still bleeds (5–10 km/h at all scales ✓), shallow
doesn't runaway (≤21 km/h ✓) — but the DEEP-sustain goal fails. **Per the prompt's own "STOP and
report if one value can't satisfy all" clause, DEFAULT LEFT 1.0 (no-op, proven BYTE-IDENTICAL to
HEAD in both arcade AND sim) — NOT shipped as an active change.** The knob is live on the D tuner
(dial ~0.2 for a faster-but-shallower drift IF that's an acceptable trade). **HONEST CONCLUSION:
a held deep cornering drift at 30–40 km/h is not achievable on the honest 1/3-scale model without
an artificial along-velocity term (the removed wave). The real options are: accept deep=slow /
shallow=fast (honest), OR re-introduce a *bounded, non-spin* speed assist (a wave that's killed in
a spin), OR rescale the whole car (Verze 3). Flagged for a decision — not patched.**

---
**VERZE 3 — STAGE i (sim-real branch added, byte-identical alias of sim — pure plumbing):** the
approved real-size-physics rebuild begins. `CONFIG.driftMode` union extended to
`'arcade' | 'sim' | 'sim-real'`; the D-toggle now cycles **arcade ⇄ sim ⇄ sim-real** (label
"SIM-REAL (wip)"). Implementation = ONE line at the top of `step()`: `if (c.driftMode==='sim-real')
c = { ...c, driftMode: 'sim' };` — a per-call shallow copy that normalises sim-real to sim for the
WHOLE step (every driftMode gate, the dispatch, `simDriftSustain`, `inertia()` all then see 'sim').
CONFIG is NEVER mutated (multi-car safe, deterministic). **MEASURED — all four identity proofs
0.0e+0:** (a) arcade vs HEAD = 0; (b) sim vs HEAD = 0; (c) **sim-real == sim = 0** (exact alias this
stage); (d) determinism = 0, CONFIG.driftMode unmutated after step, multi-car independent. Zero
behaviour change — sim-real behaves exactly like sim. tsc + build clean; trademark clean (Blitz
RS). **NEXT: Stage ii — swap the YAW/SLIP geometry to real-size (physWheelbase 2.6 / halfWB 1.3 /
real inertia 676, drop inertiaScale) gated on the ORIGINAL mode (captured before the normalise),
render+collision stay visual/small (car looks identical); CHECK lateral scrub −12→−2 m/s² + arcade/
sim still 0. Then Stage iii band-aid drops, Stage iv re-tune, Stage v realistic handbrake.**

---
**VERZE 3 — STAGE ii (sim-real runs REAL-SIZE yaw/slip geometry — the keystone, DECISIVE PROOF
passed):** sim-real now runs the physics yaw/slip geometry at real size while render/collision/HUD
stay visual-small (car pixel-identical). Implementation (sim-real-gated, arcade+sim byte-identical):
`const isSimReal = c.driftMode==='sim-real'` captured BEFORE the Stage-i normalise; `CONFIG.simRealWheelbase
= 2.6` (PHYSICS-ONLY); `halfWB = (isSimReal ? simRealWheelbase : wheelbase)/2` (1.3 vs 0.433 — the
ONE definition feeds the yaw torque arm, axle slip velocities `rearLat/frontLat = lateralVel ∓
ω·halfWB`, frontVelAngle, pivot); inertia `= isSimReal ? mass·simRealWheelbase²/12 (=676) : inertia(c)`
(drops the inertiaScale 8.0 hack, else byte-identical). RENDER/COLLISION UNTOUCHED: `desktop.ts`
(car draw + skid wheel offsets) reads `CONFIG.wheelbase` (0.867, unmutated) and collision reads
`carCollisionRadius` — `simRealWheelbase` lives ONLY in the step() physics locals → car looks +
collides identical, same on-screen speed; ONLY the yaw↔slide coupling changes. trackWidth confirmed
render-only (not in the force math). **MEASURED — DECISIVE:** **lateral scrub rate (β30 @ 40 km/h,
same forces): SIM −12.13 m/s² → SIM-REAL −2.15 m/s² = 5.6× slower → the yaw↔slide coupling is
RESTORED** (the root cause is fixed). (a) arcade vs HEAD 0.0e+0; (b) sim vs HEAD 0.0e+0; (e) raw deep
drift sim-real settles 23k@β11 + holds the deep entry longer (β67→52) vs sim 18k@β9 — **INTENTIONALLY
WILD/over-eager (real 1.3 m arm = ~2.7× yaw accel/N), the Stage-iv re-tune tames it**; (f) determinism
0, multi-car independent, CONFIG.wheelbase unmutated (0.867). tsc + build clean; trademark clean
(Blitz RS). **NEXT: Stage iii — drop the 1/3-symptom band-aids one at a time in sim-real (inertiaScale
already gone; then the wave/frontLongDrag/frontAuthority; reconsider frontCarve/frontSlide/
rearSlipFloor), measuring after each (deep drift still holds? spin still bleeds?). Then Stage iv
re-tune (feel, phone), Stage v realistic handbrake.**

---
**VERZE 3 — STAGE iv (sim-real spin-arm-gated yaw-ceiling split — held-drift over-rotation TAMED):**
the real 1.3 m arm made the held drift over-rotate (measured peak ω 4.8 ≈ 2× the physical path-bound
ceiling a_lat/v ≈ 2.5 at 20 km/h). FIX (sim-real-gated, one clamp site + one knob): the yaw soft-clamp
ceiling is now spin-arm-gated — `simRealDrift = isSimReal && spinRelease<0.5`; `yawCeiling = simRealDrift
? driftSimDriftYawCeiling : maxYawRate`. **REFINEMENT (the prompt's soft-clamp-only left peak 4.3 — the
soft decay 16.7%/frame can't catch the real-moment impulse): the sim-real HELD drift HARD-clips to the
ceiling (`rate = simRealDrift ? 1 : softYawClampRate·dt`)** — a held drift's yaw is genuinely path-bound,
so a hard clip is physical; arcade/sim and the committed SPIN keep the SOFT decay (entry headroom).
`CONFIG.driftSimDriftYawCeiling = 2.6` (computed physical drift ceiling). **MEASURED:** (a) arcade vs
HEAD 0.0e+0; (b) sim vs HEAD 0.0e+0; (c) **HELD DRIFT TAMED — peak ω 4.8 → 2.6, sustained 2.4,
spinRelease 0.00** (no over-rotation into accidental spin); (d) **COMMITTED SPIN UNCHANGED — sustained
3.2, spinRelease 1.00** (full hodiny); (e) **β NOT clamped — held drift still reaches β42° deep**, spin
β84° (caps the spin-RATE, not the drift-ANGLE → deep drift reachable via active countersteer, entry just
builds progressively); (f) exit accelerates (7→56), determinism 0, multi-car independent. Live on the D
tuner (`driftSimDriftYawCeiling`, range 2.4–2.9). arcade+sim byte-identical; independent of the band-aids
(Stage iii). **NEXT: PHONE FEEL-TEST sim-real (held drift controllable + not twitchy, deliberate spin
still works, deep angle holdable with active countersteer); then Stage iii band-aid drops + force re-tune.**

---
**⚠️ REVERTED (the grip-scale step below was undone — sim-real grip is back to the inflated values).
The phone feel-test of the real-grip sim-real car drove badly, so the player returned to the plain
'sim' branch. This step was reverted (commit removing `simRealGripBudgetRear`/`simRealPeakLatGripFront`/
`simRealStiffnessScale` + their step() gating + the D-tuner rows). KEPT: Stage ii geometry (real
`simRealWheelbase` 2.6 / halfWB 1.3 / inertia 676) and the Stage iv yaw-ceiling split
(`driftSimDriftYawCeiling`). Sim-real now = byte-identical to the pre-grip commit (`c1ceb57`): real
geometry + yaw ceiling + the OLD inflated grip (so it "barely drifts" again — that was the point of
the grip step, now undone). Arcade + sim byte-identical throughout (the grip gating was sim-real-only).
The entry below is retained for history.**

**VERZE 3 — STAGE iv (REAL-GRIP scale in sim-real — the car finally DRIFTS; geometry + yaw + grip
complete):** the keystone investigation found the grip model was inflated ~2–2.6× real tyre μ (front
static μ 3.44, rear 2.75, front kinetic 2.57, rear 1.38 — vs real 1.3–1.5 static / 0.7–1.0 kinetic)
AND the front OUT-gripped the rear (static ratio 1.25 → the front over-bit: held the angle but BRAKED
the attitude away → the drift died in <1s). Stage ii fixed the GEOMETRY to real size but left the GRIP
inflated → still a hybrid. **The honest completion = bring the grip to real μ too, CONSISTENTLY** (the
WHOLE static-grip set scaled together, front ≤ rear like a real RWD — single-lever cuts were measured to
just straighten/shallow, never live). Three sim-real-gated CONFIG values (each a ternary whose else = the
EXACT inflated constant → arcade + sim byte-identical): `simRealGripBudgetRear` **8100** (μ_static_rear
~1.38, vs 16200), `simRealPeakLatGripFront` **6500** (μ ~1.10, < rear → fixes the over-bite, vs 20250),
`simRealStiffnessScale` **0.5** (×scale on front+rear `corneringStiffness` so the peak-grip slip angle
budget/stiffness is preserved). KINETIC FRACTIONS KEPT (`driftSimRearGrip` 0.50 / `frontDriftFriction`
0.83 / `driftSimFrontSlide` 0.9 / `rearDriftFriction` — already ~real 0.5–0.6). Wired as gated locals at
the front-force site (`peakLatGripFront`/`stiffFront`, physics.ts ~1119) + the rear `budget`/`alphaPeakRear`
(physics.ts ~1263); `isSimReal` captured at the top (Stage ii) is in scope at both. **MEASURED:** (a)
ARCADE identity vs HEAD **0.0e+0** (full suite: grip corner / launch / provoke+sustain / spin / handbrake
/ foot brake); (b) SIM identity vs HEAD **0.0e+0** (sim keeps the inflated grip); **(c) THE KEYSTONE — the
car finally drifts: inflated→real-grip took a provoked drift from lifetime 0.7s / β2° / 51k to lifetime
1.8s / β15° / 17k** (under active countersteer) — the drift now LIVES (2.6× longer), is DEEP + HOLDABLE
(β2→15°), and TRAVELS at a visible ~17 km/h (not on-the-spot); (d) MECHANISM confirmed — the rear CARRIES
at real kinetic μ (doesn't snap back to grip) + the front (now ≤ rear) STEERS without over-braking the
attitude; (e) SPIN STILL BLEEDS 63→16k over 3s (no rocket); (f) CORNERING in sim-real is now LOOSER —
steer0.4+gas0.5 breaks to β53° (vs arcade β1° grippy), yaw 1.19 = still corners (a real race coupe slides willingly,
SIM-REAL ONLY → arcade/sim corners stay grippy byte-identical); (g) EXIT is GENTLER (real low-grip) — from
a deep drift, straighten+throttle dips through the de-rotation (25k→1k as β69→2°) then ACCELERATES out
1→31k over 3s; straight-line 0–50 in 4.7s (vs the inflated rocket); (h) Stage-iv yaw ceiling holds,
determinism 0, multi-car independent. Live-tunable on the D tuner (`simRealGripBudgetRear` /
`simRealPeakLatGripFront` / `simRealStiffnessScale`). Trademark-clean (NO brand strings in code/comments;
"Blitz RS" only). **ACCEPTED TRADE-OFFS (confirmed, not bugs, ALL sim-real-only): the deep drift travels
at MODERATE speed (~17 km/h, not 30 — the 30 was the wave's fiction; a real deep drift scrubs speed too,
the geometry wall `drive·cosβ < scrub` is SOFTENED not removed), the power-exit is gentler, and grippy
cornering is looser. arcade/sim keep the grippy race feel.** Verze 3 (geometry + yaw + grip) is now
COMPLETE — **sim-real = realistic, and it genuinely drifts.** **NEXT: phone feel-test sim-real (provoke →
hold a deep drift ~2s with countersteer → power out; deliberate spin still bleeds; looser corners +
gentler exit feel right). If it feels right, sim-real becomes the player drift mode; Stage iii band-aid
cleanup (drop the now-redundant 1/3-symptom knobs in sim-real) is independent and can follow.**

---
**SIM-BRANCH SMART WAVE (sim-real felt bad in-hand on the phone → back to the plain 'sim' branch with
an honest arcade assist):** the sim-real real-grip car DRIFTED but felt wrong to drive, so the player
returned to the **plain 'sim'** branch and accepted ONE bounded arcade assist to make its drift TRAVEL.
The old p27 speed-hold `wave` (`driftSimSpeedHold`, removed p32) was β-gated → it also fired in a SPIN →
rocket. **The fix = re-enable it spin-safely.** An AUDIT first proved (a) the discriminator is CLEAN:
`spinRelease` (=|spinTimer|/spinReleaseHold) is **binary — 0.00 in a held drift (entry AND settled),
1.00 in a committed spin**, no overlap (a raw-ω gate would be risky: drift entry ω 3.5 vs spin 5.5); and
(b) the wave is the biggest single win but NOT the whole drift — the **catch (`driftSimCatch`) is dead**
(settled β ~9° sits below the 20° `autoCounterStart`; tested — lowering `autoCounterStart` does NOT wake
it and shortens lifetime → it's a deeper dead mechanism, a SEPARATE pass, not touched here). IMPLEMENTED
(plain-sim only, re-using the existing wave block — NO new force term): (1) **SIM-ONLY GATE** — the wave
fires only when `!isSimReal`; since `isSimReal` (captured in `step()` at the Stage-i normalise) is NOT in
scope inside `simDriftSustain`, it was **plumbed in as a new param** (`simDriftSustain(…, isSimReal)`,
passed from the call site) — arcade never reaches `simDriftSustain` (dispatch), sim-real is the normalised
'sim' but `isSimReal=true` → excluded → arcade + sim-real BYTE-IDENTICAL; (2) **SPIN GATE** —
`× (1 − spinRelease)` → in a spin spinRelease→1 → the wave term → 0 → speed bleeds identical to wave-OFF
→ **algebraically can't rocket**; (3) **ENTRY CAP** kept (one-sided clamp at `car.driftEntrySpeed`, never
pumps above entry); (4) **THROTTLE FADE** kept (∝ `driftIntent` → lift = scrubs/exits); (5)
`CONFIG.driftSimSpeedHold` default **0 → 0.5**; (6) the `betaFactor` lower bound relaxed **20°→10°** via
new `CONFIG.driftSimWaveBetaMin` (10, live on D) so the traveling slide (~β9°) stays in the wave window
longer (safe now that spinRelease guards the spin). **MEASURED:** (a) ARCADE vs HEAD **0.0e+0**; (b)
**SIM-REAL vs HEAD 0.0e+0** (the gating-trap check — wave does NOT leak into the frozen branch); (c) SPIN
**BLEEDS** (full-lock+HB+throttle 54→5k over 3s — NO rocket, vs the old β-gated wave's 54→60k); (d) DRIFT
**TRAVELS** — lifetime **0.7→1.7s (2.4×)**, deep-fast entry (β70@50k) → traveling slide (~β8@23k) instead
of the on-spot donut; (e) lift SCRUBS (42→24k) + straighten-throttle EXIT ACCELERATES (24→64k); (f)
determinism 0, multi-car (per-car `driftEntrySpeed`). tsc + build clean; trademark clean (Blitz RS).
**HONEST SCOPE:** this gives a **punchy arcade drift that TRAVELS** (deep-fast entry → traveling slide →
clean exit), NOT a stable deep SUSTAINED drift — the angle still washes to shallow (~β9°) and the
**auto-catch stays dead** (separate pass, flagged, not bundled). `driftSimSpeedHold` (0.5) +
`driftSimWaveBetaMin` (10°) live on the D tuner. **Arcade + sim-real FROZEN. NEXT: phone feel-test the
sim drift (provoke → it kicks out deep+fast and travels → catch with countersteer → power out; deliberate
spin still bleeds, no rocket). If the manual-countersteer feel is too twitchy, reviving the dead catch is
the next (separate) item.**

---
**SIM-REAL LOW-SPEED SLIDE GATE (fix #1 — kills the low-speed false burnout + smoke + false drift-latch):**
phone video (HUD-confirmed) showed a sim-real low-speed pathology: at 7–15 km/h, near-full steer, MINIMAL
throttle (0.15) → WSPIN 53% (a BURNOUT on almost no gas), the car barely turns ("stiff stick"), and smoke
forms. DIAGNOSIS (instrumented, measured): the cluster is **sim-real ONLY** (arcade + sim turn cleanly,
no smoke) — NOT the `slipDenomFloor`/`driftSimRearSlipFloor` blow-up the symptom suggested (those floors
are inactive/mitigating here). ROOT = the **real arm** (`simRealWheelbase`/halfWB 1.3 m, 3× the 1/3 arm):
the rear slip angle `atan2(lateralVel − ω·halfWB, …)` blows up at low speed because `ω·halfWB` is large →
any rotation (ω≈1) inflates the rear-axle lateral velocity → rho>1 → a FALSE slide → (a) SMOKE (skid
trigger = `isRearSliding`), (b) `driftActive` latches → the rear goes KINETIC (`driftSimRearGrip` 0.5,
low) so the 12500 sim-engine ×1.27 boost spins the wheel on 0.15 throttle → WSPIN 74% (reproduced, matches
the video). It's the flip side of what makes sim-real drift at 40 km/h (a feature at speed, a bug at
12 km/h). FIX #1 = `CONFIG.driftSimLowSpeedGripSpeed` **5.0** m/s + a sim-real-gated **rearYawFactor =
clamp(speed / driftSimLowSpeedGripSpeed, 0, 1)** that fades the `ω·halfWB` (yaw) contribution to the REAR
slip in over 0..5 m/s (`rearLat = lateralVel − ω·halfWB·rearYawFactor`, physics.ts ~1222) — so below the
gate the rear stays GRIPPING (rho<1, no false slide) and above it the full real coupling returns (drift
intact). ONLY the LATERAL/yaw term is touched → LONGITUDINAL wheelspin (launch, handbrake lock — both
nLong-driven) is UNAFFECTED. **MEASURED:** (a) ARCADE vs HEAD **0.0e+0**; (b) SIM vs HEAD **0.0e+0** (gate
is `isSimReal`-only); **(c) KEYSTONE — WSPIN 39→0%, rho 1.34→0.24, smoke ON→OFF** at the video state (the
rear grips; `driftActive` may still flag but with rho<1 it's harmless — no kinetic burnout); (d) LAUNCH
0–50 1.42s unchanged + low-speed handbrake spin preserved (WSPIN 58%, nLong-driven); (e) HIGH-SPEED drift
(provoke 50k) lifetime/β **identical to HEAD** (factor=1 above 5 m/s); (f) SMOOTH — `rearYawFactor` is a
continuous ramp (no snap); (g) foot brake unaffected, determinism 0, multi-car. tsc + build clean;
trademark clean. Live on the D tuner (`driftSimLowSpeedGripSpeed`, 2–10). **RESIDUAL (honest, fix #2
DEFERRED):** the low-speed TURN-AMOUNT (~54° vs arcade 81°) is geometry + the stronger sim engine, NOT the
latch — the gate fixes the burnout/smoke/false-slide but not the turn amount (a separate pass: tame the
low-speed sim engine/boost, or accept the real-geometry turn). **NEXT: phone test sim-real low speed
(no burnout on light throttle, no smoke crawling, turns as a grip turn not a latched slide).**

---
**SIM-REAL IS NOW THE DRIFT BRANCH — gentle wave moved from plain-sim → sim-real (controllable
traveling drift):** an instrumented re-measurement found the earlier "sim countersteer is DEAD /
deepens the drift" conclusion was a **SIGN-ERROR test artifact** — the test controller (`cs()`)
steered INTO the slide (`−sign(β)`) instead of toward velocity (the auto-countersteer direction
`+sign(β)`). With the CORRECT countersteer sign, **sim-real's real arm (1.3 m) genuinely CATCHES**
(β 40→0, bounded peak 54°) and HOLDS a target angle (commanded 20/30/40° → settled 25/37/49°),
while plain-sim overshoots to 72° (the real arm is what makes it *hold*). So sim-real + the wave =
the controllable traveling drift the player wanted: provoke → travel → hold/adjust with countersteer
→ exit by straightening → re-enter. **CHANGE:** the smart wave was re-gated from plain-sim
(`!isSimReal`) → **SIM-REAL** (`isSimReal`) at the wave block (physics.ts ~1061), and made much
GENTLER — `CONFIG.driftSimSpeedHold` **0.5 → 0.20** (0.5 rammed the drift to ~50 km/h; 0.20 lightly
compensates the scrub so it TRAVELS at a moderate, controllable speed). The proven safety structure
carries over unchanged: **×(1−spinRelease)** spin gate (rocket-proof — spin bleeds 63→12k), the
**entry-speed cap** (no pump), the **throttle fade**, and `driftSimWaveBetaMin` 10°. The **low-speed
gate (fix #1, `driftSimLowSpeedGripSpeed` 5.0)** still applies in sim-real (complementary — grip
below 5 m/s, wave above). **MEASURED:** (a) ARCADE vs HEAD **0.0e+0**; (b) **PLAIN-SIM back to
pre-wave** (vs the pre-smart-wave baseline 38d1c61~1 = **0.0e+0** — the wave LEFT plain sim, which
returns to its no-wave behaviour) + arcade byte-identical; (c) GENTLE wave on sim-real travels
(lifetime 0.7→1.4s, β1→15°) at a gentler hold-speed (target-30° drift travels **36k vs the 0.5
version's 50k**); (d) COUNTERSTEER **catches + holds** (β 40→0 bounded; holds ~36° under modulation);
(e) SPIN BLEEDS 63→12k (no rocket); (f) low-speed gate intact (WSPIN 0%, no false burnout),
determinism 0, multi-car. tsc + build clean; trademark clean. `driftSimSpeedHold` live on D
(0.10–0.40). **Arcade + plain-sim FROZEN. NEXT: phone feel-test sim-real (provoke → travels gently →
countersteer catches/holds an angle → straighten to exit → turn in to re-enter; deliberate spin
bleeds, no rocket; low speed = grip turn, no burnout). Dial `driftSimSpeedHold` on D if the travel
feels too weak/strong.**

---
**sim-real-2 — STAGE 1 (new FULL-REALISM branch: geometry + mass + real inertia + own dispatch):** the
approved real-car-sim rebuild (reference: a ~238 hp / 175 kW, ~1200 kg, 2.565 m-wheelbase RWD coupe;
ONLY non-real concession = auto gearbox, arrives Stage 2). `CONFIG.driftMode` union += `'sim-real-2'`;
D-toggle now cycles arcade ⇄ sim ⇄ sim-real ⇄ **sim-real-2** ("SIM-REAL-2 (real)"). Stage 1 = geometry
skeleton only (engine/grip/brakes/steering/handbrake/load-transfer = Stage 2/3). Implementation, all
`isSimReal2`-gated (ternary else = exact current expr → arcade/sim/sim-real BYTE-IDENTICAL):
`const isSimReal2 = c.driftMode==='sim-real-2'` captured BEFORE the Stage-i normalise and **deliberately
NOT normalised to 'sim'** — so every `=== 'sim'` band-aid gate (wave, rear-slip floor, sim grip, front
carve/catch/authority, sim engine) is FALSE for it; **`halfWB`** = `simRealWheelbase2/2` = **1.2825 m**
(real 2.565 wheelbase); **inertia** = `mass·1.25²` = **≈1875 kg·m²** (real radius-of-gyration k≈1.25 m —
NOT the rod model, NOT `inertiaScale`); **driveBoost = 1** (the power-over launch boost band-aid OFF);
**OWN dispatch** — a new first branch `if (isSimReal2){ car.spinTimer=0; }` runs the PURE friction-circle
core (NOT arcadeDriftSustain/governor, NOT simDriftSustain/wave+spin-arm, NOT the standing pivot).
`CONFIG.simRealWheelbase2` 2.565 / `simRealTrackWidth2` 1.46 / `simRealCoGHeight2` 0.5 added — the latter
two UNUSED until Stage 3 (load transfer). **RENDER/COLLISION DECOUPLED:** `simRealWheelbase2` lives ONLY
in physics.ts (CONFIG + the step() halfWB local) — desktop render reads `CONFIG.wheelbase` 0.867 + skid
offsets, collision reads `carCollisionRadius` 0.85 → car looks + collides PIXEL-IDENTICAL, same on-screen
speed. **MEASURED:** (a) ARCADE / (b) SIM / (c) SIM-REAL vs HEAD all **0.0e+0** (full suite: grip corner /
launch / provoke+sustain / spin / foot brake / launch-then-turn); (e) sim-real-2 geometry ACTIVE (halfWB
1.2825, inertia 1875 vs sim-real 676 / arcade 601; provoke ω/β 2.87/44° vs arcade 2.35/40° = real arm +
inertia live); (f) dispatch clean — spinTimer stays 0 after provoke+hold (spin-arm/sustain never ran);
(g) determinism 0, 4 modes independent. tsc + build clean; trademark clean (no brand strings). **sim-real-2
is INTENTIONALLY RAW/WILD** (inflated arcade grip/engine/drag/brakes + real arm + no governor + no
low-speed gate yet → will over-rotate / low-speed burnout — EXPECTED, fixed in Stage 2/3). **NEXT: STAGE 2
— real engine (175 kW + torque curve + auto gearbox + rpm + wheel/gear inertia) + drag/aero + brakes
(1 g front-biased + ABS) + engine braking + reverse gear; measure 0-100 (~6.5 s), top speed (~245, report
gear/rpm), brake-g (~1 g). Arcade/sim/sim-real stay frozen.**

---
**sim-real-2 — STAGE 2 (real drivetrain + drag/aero + brakes + engine braking, all isSimReal2-gated):**
the full longitudinal model. **Engine** = a real torque curve (`simReal2EngineTorque`: idle 160 → peak
**240 Nm @ 4750**, ~flat to **redline 7000** → ~175 kW @ 7000 by construction; the P/v `enginePeakPowerW`
path is NOT read in sim-real-2) through an **automatic gearbox** (`car.gear` per-car state; ratios 3.72/
2.02/1.32/1.00/0.80, **final 3.15**, **reverse 3.50**; `simReal2RollingRadius` 0.30; rpm = wheelSpeed×
gear×final/(2π·r); auto up-shift @6800 / down @3000 — **hysteresis gap → no hunting**). Wheel force =
`(driveTorque·throttle − compressionTorque·(1−throttle))·gear·final·**drivetrainEff 0.88**/r`, fed into
the EXISTING wheel/friction-circle (so wheelspin emerges when force > grip). **Engine braking** = the
closed-throttle compression term (through the drivetrain, in `simReal2Drive` — the body `engineBrakeForce`
stays off for sim-real-2 to avoid double-count). **Reverse** = the real reverse gear (brake pedal =
reverse throttle at standstill; the arcade `reverseForce` body term gated off). **Drag** `Cd→0.35`;
**rolling resistance → CONSTANT 200 N** (Crr·m·g, not ∝v; tapered to 0 near rest). **Aero downforce**
`budget×(1+downforceCoeff 0.20·v²/mg)` — feeds the rear grip via LOAD (the correct mechanism), ~1.3% at
oval speed = negligible (real grip magnitude + front-axle aero + full load transfer = Stage 3). **Brakes**
`simReal2BrakeForce 11800` (≈1 g) at **40/60 rear/front** bias + **ABS** (rear-brake demand capped at the
grip limit → never locks, modulates at max braking). `simReal2SlipRatioPeak 0.12`. **MEASURED:** (a) ARCADE
/ (b) SIM / (c) SIM-REAL vs HEAD all **0.0e+0**; **(e) TOP SPEED 241 km/h** (5th, 5443 rpm, drag-limited,
no clamp ✓ ~245 target); **(d) 0-100 6.3 s** (shifts 1→2 @63k/6841rpm, 2→3 @118k — ⚠ PRELIMINARY/grip-bound,
but engine/gearing-limited so already ~real; real grip Stage 3 may add 1st-gear wheelspin); **(f) BRAKE
1.04 g, rear NOT locked (ABS modulates)** ✓ (inflated grip may shift the limit at Stage 3); **(h) engine
braking active** (coast-down 0.99 m/s²); (i) rolling constant 200 N; (j) aero ×1.013 @28m/s (load, not flat
grip); (g) reverse works (−2.7 m/s); (k) determinism 0, multi-car (per-car gear). tsc + build clean; no
brand strings. **HONEST DEVIATIONS/SIMPLIFICATIONS (reported):** added **drivetrain efficiency 0.88**
(audit addition — without it top was ~259; 0.88 → 241, realistic); **ABS modulates the REAR only** (the
sole modeled wheel — the front brake is a body force; a front friction-circle = audit H#4, Stage 3);
**no kickdown** (downshift is rpm-based, not load — hysteresis still prevents hunting); idle-creep skipped
(optional; no NaN at rest). **STILL STAGE 3:** real GRIP (real μ, front≤rear, LSD), correct low-speed slip
(relaxation length — the current `slipDenomFloor` low-speed artifact is UNFIXED, sim-real-2 still has the
low-speed blow-up), load transfer (long+lat), steering 40° + remove yaw clamps, real handbrake. **NEXT:
phone-check sim-real-2 (top speed feel, shifting, braking, reverse) — but it's still RAW until Stage 3
grip; arcade/sim/sim-real frozen.**

---
**sim-real-2 — STAGE 3a (REAL GRIP + Pacejka-lite + relaxation-length slip, all isSimReal2-gated):** the
tyre model goes real. **Real μ:** `simReal2BudgetRear` 8800 (μ_static_rear **1.50**), `simReal2PeakFront`
7600 (μ_static_front **1.29, ≤ rear → the front>rear inversion is FIXED**); per-axle load ~5886 N.
**Pacejka-lite** (`simReal2Pacejka`: Fy=D·sin(C·atan(B·|α|)), B=tan(π/2C)/αPeak, **C 1.6**, αPeak front 6°
/ rear 7°) **REPLACES** the front linear-then-HARD-CLAMP (measured Fy 2°→5117, **6°→7600 peak**, 10°→7188,
20°→6163 N = rises→peak→**falls**, not linear-clamp; the old clamp + sim front-scaling are OVERWRITTEN, so
countersteer can't re-pin). The post-peak falloff IS the kinetic regime → **μ_kinetic front 0.76 / rear
0.88** (no separate kinetic fraction). **Rear** Pacejka is kept INSIDE the friction circle: lateral cap =
√(budget²−rearLong²) (measured 100%→89%→42% as drive/brake load the tyre = combined slip preserved); the
rear wheel/traction loop is untouched (`rearLatForce` is a leaf). **Relaxation-length slip** (audit H#1,
the PROPER low-speed fix, NO rearSlipFloor for sim-real-2): the slip ANGLE is low-passed toward the raw
value with τ=relaxLength 0.5 m / max(v, 0.5) → lateral force builds over ~0.5 m of travel → the real-arm
low-speed atan2 spike can't make a huge transient force (per-car `frontSlipState`/`rearSlipState`). The
relaxed angle is then mapped through Pacejka. **MEASURED:** (a) ARCADE / (b) SIM / (c) SIM-REAL vs HEAD all
**0.0e+0**; **(e) KEYSTONE — low-speed (12 km/h, steer 0.9, throttle 0.15): WSPIN 0%, NO false burnout, NO
false drift-latch** (rearSliding false) via relaxation, not a floor ✓; **(g) high-speed CRISP** (relax α=1.0
at 30/60 m/s = instant; smoothing only at crawl ✓); (j) friction circle preserved; (l) determinism 0,
multi-car (per-car slip state). **(h) DRIFT — the honest result: at real μ the car GRIPS.** The engine
(~8250 N at peak torque in 1st) sits just BELOW rear grip (8800 N) → **no launch wheelspin, no throttle
power-over** — realistic for a grippy RWD on sport tyres. The inflated-grip OVER-ROTATION the plan
anticipated is GONE (replaced by real grip); cornering is best at moderate steer and **washes out
(understeers) at full lock** (Pacejka front falloff = real washout). **Drift now needs PROVOCATION** —
handbrake (3c) or lift-off/trail-brake via load transfer (3b) — not yet present. **(i) LSD = NO-OP**
(reported honestly, NOT implemented): the model is a single-rear-wheel bicycle (S1) — an LSD couples two
rear wheels, which don't exist here; a real LSD effect needs a 4-wheel model (out of scope). No dead
config added. tsc + build clean; no brand strings. **HONEST NOTES:** handbrake rear-grip-kill is BYPASSED
for sim-real-2 (so the handbrake doesn't provoke a slide until 3c); the fake `loadTransferGain` + handbrake
lat-kill modifiers are OVERWRITTEN by the Pacejka rear (real load transfer = 3b); at rear μ 1.5 the car
won't power-oversteer on throttle alone — if easier power-over is wanted later, rear μ ~1.3 (budget ~7600)
lets the engine break it loose (a feel choice). **NEXT: STAGE 3b — load transfer (longitudinal accel→rear/
brake→front, lateral cornering→outer) replacing the fake gain + a front longitudinal/friction-circle
channel (so the front brakes through grip + front combined slip); then 3c steering 40° + remove yaw clamps
+ real handbrake. Arcade/sim/sim-real frozen.**

---
**sim-real-2 — STAGE 3b (real LOAD TRANSFER + front longitudinal channel + front friction circle, all
isSimReal2-gated):** the provocation physics. **Longitudinal load transfer:** `ΔFz_long = m·a_long·
CoG/wheelbase`, a_long = the PREV-frame smoothed accel (reuses `car.axLong`) → no algebraic loop. Accel
→ rear loads; **brake/lift → front loads + REAR UNLOADS**. Composes additively on axle Fz = static (m·g/2)
± ΔFz + aero (downforce/2 per axle); **Fz clamped ≥ 0**, and **ΔFz clamped to ±staticAxle** (the physical
max transfer — can't shift >100%; also bounds the cold-start `prevForwardVel` spike). Grip scales with
Fz/staticAxle → feeds BOTH the 3a Pacejka peak (D) and the friction-circle cap, front + rear. **Front
longitudinal channel + friction circle (audit H#4):** the front brake (~60% share) now runs through the
FRONT TYRE (not a body force) — ABS caps it at the front grip (no lock), the front lateral Pacejka is
capped by √(frontPeakLoaded²−frontLong²) (same √ structure as the 3a rear), both rotated by the steer
angle (a steered front brake also yaws); the pedal body-force front share is gated to 0 for sim-real-2.
**⚠️ LATERAL load transfer = NO-OP** on the single-point-per-axle bicycle model (no L/R, constant μ) —
reported, NOT faked (same honesty as the LSD). **MEASURED:** (a) ARCADE / (b) SIM / (c) SIM-REAL vs HEAD
all **0.0e+0**; (f) ΔFz **2295 N at 1 g (39% of static)**, clamped ±static, Fz≥0, no blow-up; (g) front
friction circle — lateral cap 100%→75%→0% as the front brake grows (combined slip ✓); **(h) BRAKE 1.03 g
through the new front channel, rear NOT locked (ABS)** ✓ (the initial 0.44 g reading was a `prevForwardVel`
cold-start artifact — fixed by the ΔFz clamp + natural spin-up); **(e) TRAIL-BRAKE WORKS — at a limit
corner (40 km/h, steer 0.5) trail-braking ROTATES the car to β19°** (rear unloads → rear lat cap →37% of
static → steps out) = real trail-brake oversteer entry; **(d) lift-off alone is GENTLE** (β +1°, no slide —
HONEST: engine-brake decel ~1 m/s² → small ΔFz, exactly as predicted; trail-brake/1 g is the strong entry);
(i) STABLE (prev-frame load transfer, ω spread 0.039 over 50 frames — no oscillation/divergence); (j)
low-speed still clean (WSPIN 0%, no regression of the 3a relaxation fix); (k) determinism 0, multi-car.
tsc + build clean; no brand strings. **HONEST SCOPE:** the load-transfer + front-circle MECHANISM is
correct and validated (trail-brake rotates at a limit corner). **At HIGH speed the car is understeer/
front-washout-limited** — front μ 1.29 ≤ rear 1.5 + the 50° steering lock put the front past its Pacejka
peak before the rear loads → it pushes rather than oversteers; the full high-speed trail-brake drift
emerges once **3c** lowers the steering to 40° + real ratio and removes the yaw clamps. **NEXT: STAGE 3c —
steering 40° + real rack ratio, REMOVE angularDamping / spinYawRate / maxYawRate (yaw emerges from real
tyre forces × the real arm + load), real handbrake (rear-grip kill → tightens + scrubs). Arcade/sim/
sim-real frozen.**

---
**sim-real-2 — STAGE 3c (FINAL): steering 40° + ALL artificial yaw terms removed + real handbrake →
sim-real-2 COMPLETE as a full real-car sim.** All isSimReal2-gated (arcade/sim/sim-real byte-identical).
**Steering:** `simReal2MaxSteer` 0.698 (40° factory lock vs 50°) at all four maxSteerAngle sites (target/
align/slip-cap) → keeps the front inside its Pacejka peak at speed → **fixes the 3b high-speed understeer**.
The input→steer EXPO is KEPT (it's the phone-tilt input curve for controllability, not a physical rack
term — reported, decided to keep). **Yaw now EMERGES from real tyre forces — all 3 band-aids removed:**
`angularDamping` 1.7→0 (yaw damping comes from the tyres — a yawing car develops resisting slip angles),
the `maxYawRate` 3.2 soft-clamp REMOVED (`if (yawExcess>0 && !isSimReal2)`), and `spinYawRate` never runs
(sim-real-2's own dispatch sets `spinTimer=0`, no spin-arm). Yaw rate = ∫(halfWB·(frontFy−rearFy))/I.
**Real handbrake** (in the rear-force override): the rear LOCKS → kinetic grip points along the SLIP
VELOCITY (mostly longitudinal scrub, tiny lateral) — `rearLong = −kF·fwd/|slip|`, `rearLat = −kF·rearLat/
|slip|`, kF = budget·rearDriftFriction (0.65·μ), inside the friction circle by construction → rear lateral
~vanishes → TIGHTER rotation + speed SCRUBS (NOT the boost-donut; no power-over — driveBoost is 1). On
release the rear returns to Pacejka(rearSlipEff) and grip recovers over the relaxation length (no snap).
**MEASURED:** (a) ARCADE / (b) SIM / (c) SIM-REAL vs HEAD all **0.0e+0**; **(d) STABILITY (critical, no
clamps) — straight tracks (max|ω| 0.000), steady corner STABLE (ω spread 0.001 / 5 s), S-curves settle,
NO slow divergence** (the tyre forces self-damp the yaw — removing the clamps did NOT destabilise); **(e)
HIGH-SPEED DRIFT UNLOCKED — 70 km/h + handbrake → DRIFTS (β 50→88°), understeer fixed** (40° keeps the
front in peak); **(f) REAL HANDBRAKE — mid-corner radius 18.8→3.0 m, ω 0.77→4.0, speed 52→43 km/h =
TIGHTENS + SCRUBS** (real, not boost-donut); **(i) SPIN RECOVERY — spins from β 25/87/60° all RECOVER via
countersteer** (bounded by real physics, recoverable, no clamp); (g) yaw emerges (a drift's ω is purely
tyre-torque/inertia); (h) countersteer catches off-power (recovers; under power it oscillates with a crude
fixed-gain controller — a human modulates); (j) low-speed clean (WSPIN 0%), brake 1 g, trail-brake, real
grip/load-transfer all intact; (k) determinism 0, multi-car. tsc + build clean; no brand strings.
**sim-real-2 IS COMPLETE — a full real-car sim:** real geometry (2.565 m, halfWB 1.2825, inertia 1875) +
drivetrain (175 kW torque curve + 5-spd auto + real reverse, top 241, 0-100 6.3 s) + drag/aero + brakes
(1 g + ABS, front-biased) + real grip (Pacejka μ front 1.29 ≤ rear 1.5, kinetic 0.76/0.88, relaxation-
length slip) + load transfer (long, ΔFz clamped) + front friction circle + 40° steering + yaw from tyres +
real handbrake. **HONEST SIMPLIFICATIONS (flagged):** bicycle model (S1 — 2 axles, no per-wheel; LSD +
lateral load transfer are no-ops here), quasi-static load transfer (S2 — no suspension transient), no tyre
thermal/wear (S3). It will feel like a real grippy sports car: grips, needs provocation (handbrake/trail-
brake/lift) to drift, real-weighty, longer braking, looser at the limit — NOT arcade. arcade/sim/sim-real
remain the frozen arcade modes. **NEXT: PHONE FEEL-TEST sim-real-2 end-to-end (D → SIM-REAL-2): drive,
corner, trail-brake + handbrake to provoke a drift, countersteer to hold/catch, recover; top speed,
shifting, braking. Then decide whether sim-real-2 becomes a selectable mode + feel-tuning.**

---
**sim-real-2 — HANDBRAKE OVER-LONG SLIDE FIX (load-transfer accel source: use the true fore-aft g, not
d(forwardVel)/dt):** the phone test found the handbrake slide carried too long. DIAGNOSED (not the
suspected relaxation length — release recovery was already ~0.5 s — and not a weak scrub — 0.5 g when
loaded): the longitudinal load transfer read its accel from `car.axLong = d(forwardVel)/dt`, which in a
slide MISREADS the **forwardVel collapse from the β rotation** (the velocity vector turning off the
heading) as a HUGE phantom deceleration (−47 m/s² vs the true −7). That unloaded the rear to the ±static
clamp → **rear grip budget collapsed 8800→~20** → the scrub force (budget·μ_kin) AND the rear lateral grip
both died → the rear became a frictionless point → free, speed-not-bled, over-long slide. FIX (sim-real-2-
gated): a new `CarState.axLongBody` = the **Coriolis-corrected** longitudinal accel `axInstant −
ω·lateralVel` (= the real body-frame fore-aft g = `bodyForceX/mass`), smoothed like `axLong`; `dFzLong`
reads `axLongBody` instead of `axLong`. The β-rotation term is stripped → the rear stays loaded in a slide
→ the scrub PERSISTS. **MEASURED:** (a) ARCADE / (b) SIM / (c) SIM-REAL vs HEAD all **0.0e+0** (axLongBody
computed for all modes but only sim-real-2 reads it); **HB slide now SCRUBS — speed 50→40 km/h in the
0.5 s hold (was barely bleeding), β builds to ~59° (still steps out → tightens), hooks up (β<10°) 0.6 s
after release** = the short scrub-heavy real handbrake slide; NO regression (brake 1.02 g, steady corner
stable spread 0.022, low-speed WSPIN 0%, high-speed handbrake still provokes β46°, determinism 0). tsc +
build clean; no brand strings. **Also a latent fix for every sim-real-2 slide** (the rear was over-
unloading whenever β was high — the handbrake just made it blatant). sim-real-2 COMPLETE + this correction.
**NEXT: phone re-test the handbrake (short scrub-heavy slide now) + the full drift loop.**

---
**sim-real-2 — FREE-ROLLING REAR ON COAST (handbrake-exit false-burnout / "rear throw" fix):** the phone
test found the handbrake EXIT (release, no throttle) threw the rear like a burnout with zero throttle.
DIAGNOSED: the rear friction circle's kinetic branch (rho>1) re-integrates the wheel explicitly against
`fk·nLong/rho` — a longitudinal recovery force DILUTED by the lateral `rho` (the deep-β slide). So a
just-released LOCKED rear (wv≈0) couldn't re-sync to ground speed; it crept up slowly while `vg=forwardVel`
COLLAPSED (the β-rotation), then OVERSHOT it → slip flipped from negative (lock) to **POSITIVE (+28% — a
false burnout, no throttle)** → the rear stayed low-grip → β deepened (39→87°) → oscillation/throw. NOT a
drift latch (`driftActive` stays false), NOT the relaxation. FIX (sim-real-2-gated, physical): a free-
rolling wheel has ~zero longitudinal slip EVEN while sliding laterally, so when COASTING — `drive ≤ 0`
(throttle lifted, incl. engine braking), NO foot brake, NO handbrake — **SKIP the slow explicit kinetic
re-integration and KEEP the fast implicit `wv`** (the stage-1 update, which re-syncs toward `vg` AND
carries the engine-braking `drive`). One gate `const wheelCoast = isSimReal2 && drive<=0 && !footActive &&
!input.handbrake` wrapping the explicit re-integration. **MEASURED:** (a) ARCADE / (b) SIM / (c) SIM-REAL
vs HEAD all **0.0e+0**; **(d) KEYSTONE — handbrake exit false burnout +28% → 0% positive-slip, wv re-syncs
to vg with NO overshoot (slip −0.674→−0.003), β hooks up cleanly (no throw)**; **PROOF the fix is surgical
— sim-real-2 NEW vs HEAD BYTE-IDENTICAL (0.0e+0) on launch / full-throttle+steer / partial-throttle corner
/ high-speed-handbrake / trail-brake** (the fix only acts on `drive≤0` coast — under throttle the wheelspin
path is untouched); (e) the throttle→WSPIN gradient is flat 0% — the PRE-EXISTING real-grip behaviour (3a:
engine ~8250N < rear grip 8800N → grips, drift needs provocation), byte-identical to HEAD, NOT this fix;
(f) ENGINE BRAKING intact (coast-down 0.92 m/s² — straight coast is the GRIP branch, untouched); (g) FOOT
BRAKE 1.04 g + ABS intact; (h) PRIOR FIXES intact (handbrake tightens ω 0.78→3.58 + scrubs 52→42k, the
Coriolis load-transfer fix, low-speed WSPIN 0%, stability spread 0.022); (j) determinism 0, multi-car.
tsc + build clean; no brand strings. **vg-REFERENCE ROOT (the forwardVel-collapse at deep β behind this +
the over-long-slide + load-transfer bugs): assessed, DEFERRED** — `vg=forwardVel` has ~9 consumers (slip,
sDenom, footTargetWv, wheel update, bodyBeta, front geometry, handbrake scrub, the prior Coriolis fix);
a global β-robust reference risks regressing the working handbrake-scrub / load-transfer fixes, so the
targeted wheel-sync fix is shipped and the global vg root is left for a dedicated pass. **NEXT: phone
re-test the handbrake EXIT (no burnout/throw on release) + the full drift loop.**

---
**sim-real-2 — vg/forwardVel ROOT FIX (β-robust slip-ratio denominator) + free-roll REVERTED (Step A+B+C
in one pass, all isSimReal2-gated):** the diagnosis isolated the ROOT of the recurring deep-β handbrake
pathologies to ONE bugged consumer — the slip-ratio DENOMINATOR. `slipRef` (feeding `sDenom` + `kSlip`
+ the overspeed clamp, physics.ts ~1556) used `|vg| = |forwardVel|`, which COLLAPSES toward 0 (and
inverts negative) as β builds → `sDenom` floors → the slip ratio `s=(wv−vg)/sDenom` false-spikes
POSITIVE (zero-throttle burnout) when a locked/creeping wheel overshoots the collapsing reference. FIX =
the SAME proven **p28** mechanism, extended to sim-real-2: `slipRef = totalSpeed (|v|=hypot(vx,vy))`
(β-robust — never collapses) via the gate `((driftMode==='sim' && driftActive) || isSimReal2)`. The slip
NUMERATOR keeps `vg=forwardVel` (the real rolling speed); the slip ANGLES (bodyBeta, rear/front) and the
Stage-3c handbrake `slipMag=hypot(forwardVel,rearLat)` correctly keep forwardVel (the slipMag is already
β-robust — the rearLat term holds its magnitude in deep β). **Step A REVERTED the free-roll `wheelCoast`
gate** (commit 9a0a52a) back to the explicit kinetic re-integration — it fought the collapsing reference
(re-synced the wheel to the swinging forwardVel) and the player felt it WORSE (longer slide + oscillation).
**MEASURED (esbuild-bundled real physics, 6 variants, Node):** (a/b/c) ARCADE / SIM / SIM-REAL vs HEAD all
**0.0e+0** (MIX suite — gate is isSimReal2/sim-only); (d) **STEP A CLEAN BASE proven — curNoRoot(sim-real-2)
== aeb86e7 base = 0.0e+0** across MIX/DEEPB/HBEXIT (the revert restores the exact pre-free-roll state); (e)
**LOW-β SELF-CHECK — cur==base 0.0e+0 on a STRAIGHT run (max|β|=0°), diverges only at deep β** (DEEPB
max|diff| 2.87 @ wv) → the fix acts ONLY at deep β, byte-identical otherwise; **(f) HANDBRAKE-EXIT
KEYSTONE — HONEST RESULT: on the NORMAL handbrake exit the root is BODY-INERT** (cur vs base body motion
1.74e-2 ≈ identical; no positive burnout in EITHER — the wheel LOCKS, negative slip), because at deep-β
`rho>1` the kinetic branch overwrites `wv` independent of `sDenom`, and the hook-up happens at low β. The
root DOES halve the REPORTED deep-β slip (cleaner wspin/smoke/HUD: frame-159 s 0.5→0.2). **(f2) DEEP-SPIN
EXIT (forwardVel<0, the regime the root actually targets) — root CUTS the false burnout: positive slip /
wspin BASE 0.90 → CUR 0.68**, WITHOUT the free-roll feel-regression (HEAD free-roll gets 0.04 but at the
cost of the longer-slide/oscillation the player rejected). So the net body change to the normal exit is the
free-roll REVERT (back to base); the root is the correct β-robust denominator that reduces the spin-regime
burnout + cleans the reported slip. (g) NO REGRESSION — handbrake tightens+scrubs (ω 0.54→1.10, 18→8 km/h),
trail-brake rotates (β 0.4→8.4°), brake 1.02 g + ABS (rear maxWspin 0.00), low-speed WSPIN 0.00, launch
low-β identity cur vs base 0.0e+0, steady-corner ω spread 0.080. **(h) STEP C — Coriolis + scrub KEPT,
proven by isolated revert:** (1) Coriolis reverted (dFzLong reads axLong) → handbrake provoke bleeds LESS
(Δ13 vs Δ20 km/h = over-long slide returns) → **KEEP** (corrects ACCELERATION, a different quantity); (2)
handbrake scrub reverted (Pacejka under HB) → rear steps out LESS (β −20° vs −72°) → **KEEP** (the locked-
rear model; the root does NOT subsume it). **(i) CONTINGENCY NOT ADDED:** the root reduces but doesn't
fully kill the SPIN-regime burnout (0.68 residual in a hard deliberate spin-out, forwardVel negative
throughout); the NORMAL exit has no burnout, so the next lever (referencing the kinetic re-integration to
the bounded sDenom) is NOT measured-necessary and was NOT added pre-emptively (avoids risking the proven-
clean state). (j) determinism 0, multi-car, tsc + build clean, no brand strings. **NET:** free-roll
REVERTED (feel-regression gone), root = correct β-robust slip-ratio denominator (spin-burnout cut
0.90→0.68 + clean reported slip), Coriolis + scrub kept (proven real-physics). **HONEST SCOPE: the normal
handbrake-exit body trajectory is the BASE behaviour — the root is a correctness/reporting fix + spin-burnout
reduction, not a normal-exit body change.** D-tuner unchanged (no new knob). **NEXT: PHONE feel-test
sim-real-2 — handbrake exit (release, no throttle → no burnout/throw, clean hook-up) + a deliberate spin
(should bleed, no rocket) + the full drift loop (provoke → travel → countersteer → recover). If the exit
still feels off, the deep-β wheel-recovery dynamics (the kinetic re-integration) is the next dedicated pass.**

---
**sim-real-2 — BUG #1 FIX (coast free-roll wheel — kills the false coast-burnout/smoke):** the player's
wheel-rolling model was verified physically CORRECT and the root reconciled: the rear wheel re-spins to the
ALONG-WHEEL ground speed `vg = rearLong = forwardVel = |v|·cosβ` (small when sideways) — so `forwardVel` is
the RIGHT re-spin target + slip-angle longitudinal; it was only ever WRONG as the slip-ratio DENOMINATOR
(sDenom, already fixed). BUG #1 (separate from the BUG #2 yaw-wave): on COAST during a deep slide the
explicit kinetic re-integration `wv = wv0 + dt/mw·(drive − rearLongForce)` + the overspeed clamp drove the
free wheel PAST `vg` to the `vg − maxSlipRatio·sDenom` pin (≈ **−10 m/s backward overspin**) as `forwardVel`
went negative in the spin → false POSITIVE-then-pinned slip → **`wspin` 1.0 = coast-burnout SMOKE at zero
throttle**. FIX (sim-real-2-gated, kinetic-branch + COAST only): `wheelCoast = isSimReal2 && drive ≤ 0 &&
!footActive && !input.handbrake`; on coast set **`wv = vg` directly** (free-rolling = zero longitudinal slip)
instead of the explicit re-integration. `(wv−vg)=0` EXACTLY → `s=0` by construction → **NO kSlip in the coast
path** → it CANNOT chase/glue/oscillate. **This is fundamentally DIFFERENT from the reverted free-roll**
(which KEPT the implicit `wv` CHASING `vg` via `kSlip`, which blew up on the collapsing sDenom — and which a
3-way measurement proved was ALREADY clean on the deep exit, i.e. root did NOT rescue it, so it was a true
recycle — rejected). For `vg < 0` (β>90°) `wv = vg < 0` = the LEGITIMATE backward roll (s=0, no force, no
smoke) — NOT clamped ≥0 (would fake a forward slip), NOT the −10 artifact. **MEASURED (cur vs HEAD e330808):**
(a/b/c) ARCADE/SIM/SIM-REAL identity **0.0e+0**; **(d) KEYSTONE matches the plan — coast handbrake exit:
wvMin −10.4→−3.0, max|s| 2.50→0.00, maxWspin 1.00→0.00, smoke 30→0 frames** (vg<0 settle: wv≈vg, s=0.00, no
backward overspin); **(e) ENGINE BRAKING INTACT — straight coast decel 0.83 m/s² = HEAD identical** (the
`drive≤0` gate does NOT kill it: small-β coast stays in the GRIP branch where wv keeps the implicit value
carrying `drive`; the fix is kinetic-branch only); **(f) ANGLE-DEPENDENCE PRESERVED — light β−10° self-hooks
0f, med 32f, heavy 42f → grips small / stays sideways large = unchanged** (fix runs only in the rho>1 kinetic
branch); **(g) BUG #2 yaw-wave essentially unchanged** (ω-waves 3 vs 3; over-rotation 17°→19°, a 2° nudge from
removing the artifact — the yaw-wave is the next SEPARATE pass); (h) PRESERVE byte-identical 0.0e+0 —
launch/wheelspin, throttle corner, handbrake DOWN, foot brake, trail-brake; determinism 0; tsc + build clean;
no brand strings. **NET: false coast-burnout/smoke GONE at the root (wv settles onto vg, s=0 by construction),
correct from first principles (no kSlip, immune to the failure mode), engine braking + angle-dependence +
throttle/brake/handbrake all intact, BUG #2 untouched.** **NEXT: PHONE feel-test sim-real-2 — coast/handbrake
exit (no smoke or burnout at zero throttle, wheel rolls clean), then the BUG #2 yaw-wave damping pass if the
deep-exit over-rotation/wave still feels off.**

---
**sim-real-2 — REVERTED to the finished 5-stage build (27af7f4); recent handbrake/coast fixes removed:**
the phone feel-test of the post-fix handbrake felt worse, so sim-real-2 physics was reverted to exactly
the FINISHED BUILD state — commit **27af7f4** "sim-real-2 Stage 3c (FINAL): 40deg steering + yaw from
tyres + real handbrake" (the clean post-5-stage build: real geometry + real drivetrain + real grip/
Pacejka/relaxation + load transfer + front channel + 40° lock + real handbrake), BEFORE the recent fix
run. Removed (all sim-real-2-gated, so arcade/sim/sim-real were never affected): **Coriolis load-transfer**
(axLongBody → axLong, aeb86e7), the **free-roll** attempt (9a0a52a, already reverted in e330808), the
**root fix** (slipRef `|| isSimReal2` → back to the sim-only gate, e330808), and the **coast wheel
free-roll** (`wv = vg` on coast, ea21fbf). Method: `git checkout 27af7f4 -- src/physics.ts` (the entire
27af7f4..HEAD physics diff was proven 100% sim-real-2-specific — axLongBody field/compute, the dFzLong
isSimReal2 ternary, the slipRef `|| isSimReal2`, the wheelCoast block — so restoring the file reverts
sim-real-2 only). **VERIFIED:** (A) sim-real-2 (reverted) == 27af7f4 finished build **0.0e+0** (MIX +
handbrake exit); (B) ARCADE/SIM/SIM-REAL == HEAD ea21fbf **0.0e+0** (untouched throughout); (C) sim-real-2
vs HEAD handbrake exit max|diff| 6.73 (the revert is real). tsc + build clean. **The bisect that motivated
this: the recent fixes did NOT lengthen the handbrake slide — Coriolis SHORTENED it (19.3→14.5 m) but
added 1 recovery fishtail swing (baseline spins out cleanly, 0 swings); root + coast were INERT on the
handbrake. The player chose to go back to the finished-build feel (longer, clean spin-out, no fishtail).**
NEXT: phone-test the reverted sim-real-2 handbrake (finished-build feel restored).

---
**sim-real-2 — UNIFIED REAL-SIZE SCALE + made the DEFAULT (the 1/3 render/physics split removed for it):**
sim-real-2's physics already ran at the REAL wheelbase (`simRealWheelbase2` 2.565 m) but the car was still
DRAWN + collided at the 1/3 size (`CONFIG.wheelbase` 0.867 m) — render and physics in different scales, so
"slide = N car-lengths" was meaningless. UNIFIED to one real-metre scale for sim-real-2: it now draws +
collides at its real 2.565 m size, and is the **default `driftMode`**. ONE source of truth —
`carScale(c)` (physics.ts) = `driftMode==='sim-real-2' ? simRealWheelbase2/wheelbase : 1` (**≈2.96**);
the frozen arcade/sim/sim-real are genuine 1/3 cars → scale 1 → byte-identical. Applied to: the car body
draw (`drawCar` adds `ctx.scale(vs,vs)` after the metre scale — the 1/3-tuned art uniformly scaled up, look
+ proportions preserved), the skid wheel offsets (`rearWheelPositions`), the obstacle/wall collision radius
(`collideWithRects` `R *= carScale`), the car-car collision radius + the spawn grid (`cars.ts`
`collidePairCars`/`collideCars`/`spawnOffset`). Default `CONFIG.driftMode` `'arcade'` → **`'sim-real-2'`**.
**DRIVING PHYSICS UNTOUCHED — `step()` was NOT modified**, so forces/yaw/drift/handbrake are byte-identical
in every mode (proven 0.0e+0 vs HEAD across arcade/sim/sim-real/sim-real-2 on the full MIX suite). The only
behavioural change is the (intended) real-size COLLISION radius for sim-real-2. **MEASURED:** (1) on-screen
car **33 px → 98 px** (footprint 1.5 m→4.44 m, wheelbase **2.565 m**) — the car is intentionally ~3× bigger
(drawn at real size, the player's chosen "Option A"); (2) sim-real-2 driving physics byte-identical 0.0e+0;
(3) collision radius 0.85 m → **2.52 m** (real), spawn grid ×2.96; (4) arcade/sim/sim-real unchanged
(carScale 1, 0.0e+0); (5) tsc + build clean. **HONEST CONSEQUENCE (flagged):** the WORLD/track stayed at
its current metre size, so the real-size car is now ~3× bigger RELATIVE to the track (more prominent / the
oval band is proportionally tighter). If the track should also be real-scale (a bigger world so the
car-to-track ratio is realistic), that's a follow-up the player can request. **NEXT: phone/desktop feel-test
the real-size sim-real-2 (default) — drive, drift, handbrake; check the car size + track proportions feel
right, decide whether to also scale the world.**

---
**sim-real-2 — VISUAL/TRIGGER SCALING COMPLETED (the last 3 bits joining render/collision/spawn from
b4ba5bc):** with the real-size 2.565 m car (b4ba5bc), three remaining elements were still on the 1/3
scale; all now ×`carScale()` (≈2.96, sim-real-2 only; arcade/sim/sim-real → carScale 1 → byte-identical).
**RENDER SCALE RE-VERIFIED LIVE IN CODE** (not memory): `carScale()` returns 2.565/0.867≈2.96 for
sim-real-2, `drawCar` applies `ctx.scale(vs,vs)`, default `driftMode='sim-real-2'`, nothing overrides it on
load → the car DOES draw real-size (~98 px); a small car on screen = a STALE BUILD (hard-refresh / rebuild),
not a code bug. **The 3 scaled (all measured):** (1) **SKID line width** 3 px → **8.9 px** (desktop.ts,
`3*carScale()`) — matches the 3× tyres, not absurd; (2) **SMOKE** — initial `smokeSize` 0.42→**1.24 m** AND
growth `smokeGrow` 1.5→**4.44 m/s** (via a new per-particle `grow` field in effects.ts + a `growScale` param,
default 1 ⇒ arcade `grow=smokeGrow` byte-identical) → final puff 2.07→**6.13 m**, **smoke-to-car ratio
1.38× UNCHANGED** (proportional, not a track-swallowing cloud; alpha 0.20 light); (3) **GATE radius**
`RACE_CONFIG.gateRadius` 1.7→**5.03 m** (desktop.ts RaceManager construction + draw). **LAP COUNTING VERIFIED
INTACT:** the OVAL startLine uses an EXPLICIT band-relative radius (`bandW/2`, maps.ts) so gateRadius scaling
does NOT touch it (oval lap counting unchanged + correct); a full armed circuit counts a lap, a re-cross
WITHOUT reaching the far point does NOT (anti-cheat holds — no premature lap); overlapping editor checkpoints
(5 m radius) co-collect but do NOT break lap logic (laps count on the single start line only). **CHECKS:**
(a) render scale live (code-confirmed); (b) arcade/sim/sim-real byte-identical (carScale 1 → skid 3 px /
gate 1.7 m / smoke grow = smokeGrow); (c) the 3 values above; (d) lap counting intact (oval band-relative,
anti-cheat, no overlap break); (e) physics 0.0e+0 (step() untouched — visual/trigger only); (f) tsc + build
clean, no brand strings, multi-car safe. **The real-size scaling is now COMPLETE: render + physics +
collision + spawn (b4ba5bc) + skid + smoke + gate. NEXT: hard-refresh to get the live build, then phone/
desktop feel-test the real-size sim-real-2 (car ~98 px, proportional skids/smoke, lap counting on the oval).**

---
**sim-real-2 — REAL-SCALE via mode-aware RPM (car 33px, oval fills, world 258m, ~25MB):** the real-size
2.565 m car looked absurd at 98 px (pxPerMeter 22). FIX = a mode-aware **render px-per-metre `RPM() =
CONFIG.pxPerMeter / carScale()`** (sim-real-2: 22/2.96 = **7.43**; arcade/sim/sim-real: carScale 1 → **22**,
unchanged). Decouples the RENDER scale from the WORLD-SIZE so the world can grow without a layer-memory
blowup. Wired in desktop.ts: `logicalMeters()` ×carScale (world → ~258 m), `logicalPx = wM·RPM()`
(= screen px → layers stay ~1920 px / **~25 MB**, no blowup — carScale ×, RPM ÷ cancel), `PX() = RPM()`
(car/fx/skid/gate render), `screenToWorld` ÷RPM (editor mouse → 258 m world), `drawObstacles`/
`drawForeground`/`fx.draw` pass RPM, initial world uses RPM. **Skid lineWidth reverted to 3 px** (the lower
RPM already sizes it). KEPT (world-metre / real-size, scale correctly): car-draw / smoke / gate / collision
/ spawn carScale (carScale·RPM = 22 → original pixel sizes, real-metric in the 258 m world). World rebuilt
on the D-toggle (`switchMap`) for the right RPM per mode. maps.ts `drawStadiumSurface` was already
px-cancel-safe (computeStadium(wPx/px)·px) → background aligns with the world·RPM collision at any RPM.
**RESULT (1080p): car ~33 px (like the original 1/3 look), oval FILLS the screen (258 m·7.43 = 1920 px),
layers ~25 MB.** **The world/track grew 87 m→258 m → corners 21 m→62 m (~1.72× faster, more room) — this is
the fix for the real-car-on-a-tiny-87m-oval understeer; the car's FORCE MODEL (`step()`) is BYTE-IDENTICAL
(0.0e+0) — only the world/track size changed, NOT the physics.** **VERIFIED:** (a) only desktop.ts changed
→ physics/effects/race/cars byte-identical (step 0.0e+0); (b) arcade/sim/sim-real RPM=22/world 87 m/car 33 px
→ unchanged; (c) layers logicalPx=1920 px ~25 MB (no blowup); (d) world 258 m, corner 62 m, car 33 px, oval
fills; (e) collision/screenToWorld at RPM (math-aligned; **render unverified headless**); (f) UI = HTML
screen-space → untouched; (g) car px CONSTANT (33) on every resolution + oval fills every screen + uniform
scale (no squash) — the track's METRE size scales with screen (existing FLAT_LOGICAL: one host = one world
= internally fair; **NOT** a strictly-constant car-to-track ratio across DIFFERENT monitors — a bigger
monitor shows a bigger track, pre-existing, unchanged in character); (h) tsc + build clean, no brand strings,
multi-car. **⚠️ RENDER UNVERIFIABLE HEADLESS (no Supabase) — phone-test watch: car ~33 px not off-screen,
oval fills + aligns with collision, editor mouse mapping correct, skids/smoke/gates aligned, corners feel
faster/roomier.** NEXT: hard-refresh + phone/desktop test.

---
**CLEANUP Stage A — REVERTED src/ to the finished 5-stage build (27af7f4) + default = sim-real-2:** the
RPM real-scale (72c0d31) drove like a "shopping cart" (the 258 m world made the real car feel slow/floaty),
so the approved cleanup begins by reverting to the clean baseline. `git checkout 27af7f4 -- src/` — AUDITED
first: the ENTIRE 27af7f4..HEAD src/ diff is **100% scale/handbrake cruft** (carScale, RPM, smoke-grow,
collision/spawn scaling, default-mode) across only 4 files (physics/desktop/cars/effects); the handbrake
fixes (Coriolis/root/free-roll/coast) were already reverted at 7c6023c (physics.ts == 27af7f4); NO
unrelated UI/bug/feature work exists in the range → nothing good lost. CLAUDE.md (this history) is NOT in
src/ → preserved. The ONE addition on top of the pure revert: `CONFIG.driftMode` default `'arcade'` →
**`'sim-real-2'`** (so it boots into the kept mode for the phone-test; the only diff vs 27af7f4). RESULT:
sim-real-2 force model = the finished-build feel (untouched), car renders ~33 px (CONFIG.wheelbase 0.867
art at pxPerMeter 22, NO carScale/RPM), world 87 m, layers ~25 MB, all 4 modes still present (deleted in
Stage B). tsc + build clean. **NEXT (after phone-test): Stage B — delete arcade/sim/sim-real (modes/gates/
band-aids/rod-inertia/driftSim knobs/D-toggle/SIM-DRIFT tuner), KEEP sim-real-2, prove sim-real-2 step()
0.0e+0; then Stage C (micro-staged scale rebuild) + Stage D (desktop icons).**

---
**KEYBOARD driving for LOCAL TESTING (no phone / no Supabase) — desktop.ts only:** the Supabase quota is
maxed (pairing blocked), so to test the cleanup (feel/cornering/scale) on the desktop alone, arrow keys +
Space now drive a LOCAL car through the IDENTICAL physics path as the phone tilt. `keyDrive` state (↑
throttle / ↓ brake-reverse / ←→ steer / Space handbrake) is set by keydown/keyup (preventDefault so
arrows/space don't scroll; ignored while typing in an `<input>`). `driveKeyboard()` (called once per frame
at the top of the `!isPaused` block) lazy-spawns a `local:true` car at slot 0 on the first key press in
gameplay and sets its **`target` Inputs exactly like the phone's `applyInputs`** → the loop smooths
`target→current` (inputLerp) and `step()`s it identically, so keyboard tests the REAL driving. `lastInputAt`
is refreshed each frame so the connection-lifecycle ramp-to-neutral never triggers. The local car is exempt
from `syncCars` removal (`!cars.get(slot)?.local`) so it survives with an empty lobby. **Phone control is
UNTOUCHED:** a paired phone owns slot 0 (not `local`) → keyboard goes inert; the `EV.control` router /
physics / cars / effects are byte-identical (only desktop.ts changed). Works with NO phone/QR/Supabase:
load desktop → START RACE → press an arrow → car spawns + drives. tsc + build clean. (Render of the live
drive is unverifiable headless — phone/desktop test.)

---
**CLEANUP Stage B — DELETED arcade / sim / sim-real entirely; sim-real-2 is the ONLY physics model
(proven byte-identical 0.0e+0):** the three legacy drift modes + all their band-aids are gone.
**physics.ts 2008 → 1522 lines (−486); desktop.ts −82; 594 deletions total.** Removed: the 3 drift
functions (`inertia()` rod model + `inertiaScale`, `arcadeDriftSustain()` governor, `simDriftSustain()`
wave/spin-arm — ~320 lines), the standing-pivot block (`standingPivot 0` → always dead), the whole
3-way dispatch (now just `car.spinTimer = 0` before the sim-real-2 friction-circle core), ALL ~29
mode-gates collapsed to the sim-real-2 branch (each was `isSimReal2 ? real : …` → kept the real branch;
`isSimReal`/`=== 'sim'` → the never-taken else, deleted), and **29 dead CONFIG knobs** (every `driftSim*`,
`inertiaScale`, `standingPivot`, `driftAssist`, `driftFrontCarve`, `driftScrubRate`, `angularDamping`,
`maxYawRate`, `softYawClampRate`, all `burnoutPivot*`). `driftMode` union narrowed to `'sim-real-2' as
const`. **desktop.ts:** the SIM-DRIFT tuner block + the arcade⇄sim⇄sim-real⇄sim-real-2 mode-cycle button
+ the dead `brakeForce`/`brakeGripFraction` rows deleted; the D-debug-HUD tuner panel now holds a clean
sim-real-2 set (`simReal2BrakeForce` / `simReal2BudgetRear` / `simReal2PeakFront`) for Stage-C feel-tuning.
**KEPT (sim-real-2 reads them):** every `simReal2*` + `simRealWheelbase2`/`TrackWidth2`/`CoGHeight2`,
`rearDriftFriction`, `enginePower`/`torqueBoostFadeSpeed`, `loadTransferGain`, `spinReleaseThreshold(HB)`,
`lowSpeedTorqueBoost`, `carCollisionRadius`/`slipDenomFloor`/`maxSlipRatio`/`restSpeed`/`pxPerMeter`/
`wheelbase` (render), AND the keyboard-driving code (verified intact). **THE D KEY** investigated first =
debug-HUD toggle ONLY (KEPT); the mode-cycle was a separate tuner button (deleted). **BYTE-IDENTITY PROOF
(esbuild-bundled real physics, Node diff vs HEAD 1ac04ea, after EVERY sub-step): sim-real-2 step()
0.0e+0 across launch / corner / drift / handbrake / brake / mix — all 0.** Only branches sim-real-2 never
executes were deleted. tsc clean, `npm run build` clean. **HONEST NOTE:** ~20 now-stale CONFIG comment
paragraphs (describing the deleted knobs/gates) were left in place — cosmetic, harmless; polish in Stage C.
**NEXT: keyboard-test sim-real-2 (drives identically to the finished build). Then Stage C — micro-staged
scale rebuild (world/track size + render scale), phone-test each step; then Stage D — desktop map/icons.**

---
**CLEANUP Stage C1 — THE ONE RULER: ONE wheelbase (2.565 m) + ONE pxPerMeter (7.5), render-vs-physics
split DELETED and grep-proven structurally impossible:** the whole game now measures by a SINGLE
real-metre scale anchored on the car = 2.565 m. **The split is gone because there is physically ONE
number:** a module const `WB = 2.565` (physics.ts) is the single source — `CONFIG.wheelbase = WB`,
and car dims are BOUND to it as multiples (`trackWidth = WB*0.569 ≈ 1.46`, `carCollisionRadius =
WB*0.98 ≈ 2.515`, drawCar `L/W = CONFIG.wheelbase*0.865/0.356`) so they can't drift either. **DELETED:**
the old `wheelbase: 2.6/3` (0.867), `trackWidth: 1.6/3` (0.533), the dead `simRealWheelbase` (2.6), and
`simRealWheelbase2`/`simRealTrackWidth2` (renamed/folded into the one wheelbase/trackWidth). The two
physics reads (`halfWB`, load-transfer) now read `c.wheelbase`. **GREP PROOF (in src/):** `0.867`,
`2.6/3`, `1.6/3`, `simRealWheelbase2`, `simRealWheelbase`, `simRealTrackWidth2`, `carScale`, `RPM(`
appear **NOWHERE**; exactly ONE `wheelbase:` (= WB 2.565) and ONE `pxPerMeter:` (7.5) exist → the
split can never return (no second number to drift). **CALIBRATION:** the 1/3 car's axle drew at
0.867×22 = 19.07 px; 19.07/2.565 = 7.43 → rounded to a clean **pxPerMeter 7.5** (car = 2.565×7.5 =
19.24 px, **+0.9 % = sub-pixel/invisible**). **THE RULER (1920×1080):** world (oval, screen/pxm) =
**256 × 144 m** (was 87×49); corner radius outer **61.9 m** / inner 20.6 m / band 41.3 m (was 21/7/14)
→ ~3× the room → fixes the real car's understeer. **Everything on the one ruler (real metres):**
wheelbase 2.565, car length 4.44 / width 1.83, trackWidth 1.46, car-car + wall collision 2.515, world
256×144, corner 61.9, band 41.3, spawn gap 7.1 (cars.ts ×2.96), gate 5.03 (race.ts ×2.96), smoke
1.24/4.44 (effects.ts ×2.96). **MEASURED:** (a) **`step()` force model BYTE-IDENTICAL to HEAD 0.0e+0**
across launch/corner/drift/handbrake/brake/mix (esbuild bundle + Node diff — the rename is just a name,
same 2.565 value/sites; `step()` never reads pxPerMeter/trackWidth/collision); cornering changes ONLY
via world size, NOT a retune. (b) tsc + build clean. (c) **layers ~25 MB at any pxPerMeter** (`world_m ×
pxm = (screen/pxm)×pxm = screen_px` ≈ 1920 px always — no blowup). (d) visual ≈ as now (car +0.9 %,
oval fills screen); keyboard driving + UI untouched (UI is screen-space HTML). Physics power/grip left
AS-IS per the plan. **HONEST — FLOATY RISK (expected, to iterate):** at pxm 7.5 a 60 km/h car moves
16.7×7.5 = 125 px/s on screen (vs 367 at pxm 22) → 3× slower screen-pace → likely feels floaty/slow.
The two iteration levers (next): raise `pxPerMeter` toward ~11–14 (smaller world, faster pace, tighter
corners) and/or raise car power/grip (punchier real car). Tyre stance is ~7 % narrower (real
track/wheelbase ratio 0.569 vs the old art's 0.615 — minor, more correct). **NEXT: keyboard-test the
unified-ruler car (expect floaty); then iterate pxPerMeter + power/grip to the sweet spot. Then Stage C2
feel-tune, Stage D desktop map/icons.**

---
**CLEANUP Stage D — DESKTOP + TRACK on the ONE ruler (desktop bound to wheelbase, drift-proof; track
audited consistent):** the desktop map and the oval are now both real-metre on the single C1 ruler
(pxPerMeter 7.5), so the 2.565 m car drifts among them in correct proportion. **DESKTOP (world.ts) —
BOUND TO `CONFIG.wheelbase` (one source, can't drift):** `const WB = CONFIG.wheelbase`; every desktop
length is a WB-multiple = the original 1/3-era metre re-expressed in wheelbases (restores the SHIPPED
look, icon ≈ 1.45× the car, now real): ICON_SIZE `WB*2.53` ≈ 6.5 m, BIN_SIZE `WB*3.35` ≈ 8.6 m,
COL/ROW_SPACING `WB*8.65/6.46` ≈ 22.2/16.6 m, MARGIN_X/Y `WB*2.31/1.85` ≈ 5.9/4.7 m, TASKBAR_M
`WB*2.08` ≈ 5.3 m, spawnClear `WB*5.19` ≈ 13.3 m; the inline fit/bin/grab/clamp offsets bound to WB too;
jitter baked ×2.96 (real m); glyph `u=s/24` + hitbox-inset fraction auto-scale (untouched). **VERIFIED
(layoutDesktop(256×144)):** 12/12 icons placed, icon 6.49 m, bin 8.59 m bottom-right, all in-bounds,
spawn-clear respected, **car-to-icon ratio 1.46 = the shipped look.** **TRACK AUDIT (maps.ts) — each
constant + verdict:** band width / corners / barriers / startLine are FRACTION-driven from
`computeStadium(world)` → already on the ruler (auto-scale; fullscreen oval byte-unchanged). The
old-scale fixed metres found + fixed: **spawn grid** `cx - 1.5 - row*2.6` (cars would OVERLAP at real
size) → **bound to WB** (`back WB*1.73`, `rowPitch WB*3.0`); `computeStadium` floors (sx `2→5.9`, band
`3.2→9.5`/`1.0→3.0`/`0.6→1.8`) + barrier thickness floor (`1.0→3.0`) + desktop wrap margin (`2→WB*2.31`,
`0.2→WB*0.23`) + oval wrap (`0.5→1.5`) → real metres (the band floors are INERT at the real world size,
so the oval is unchanged; they only bind on tiny windows, now proportionally). Grandstand/floodlight/
clock offsets are PIXEL-based (drawn off the px track outline) → screen-consistent, untouched. **ONE
RULER EVERYWHERE confirmed:** desktop AND track = real-metre constants × the single `pxPerMeter` (7.5);
no `carScale`/`RPM(`/second px-scale anywhere; exactly ONE `wheelbase:` (WB 2.565) + ONE `pxPerMeter:`
(grep-proven, incl. comments) → the split can't return for desktop OR track. **MEASURED:** (a)
**physics.ts UNTOUCHED** (empty diff) → `step()` BYTE-IDENTICAL to HEAD **0.0e+0** (launch/drift/handbrake)
— only world.ts + maps.ts changed; (b) tsc + build clean; (c) **layers ~25 MB** (`world_m × pxm =
screen_px` ≈ 1920, scaling icon metres doesn't change layer size); (d) keyboard driving + UI (menu/QR/HUD)
untouched. **NEXT: keyboard-test — car drifts among the 6.5 m icons + the oval, all in correct real-metre
proportion (car-to-icon = shipped look). Then the floaty-iteration (pxPerMeter + power/grip) remains open.**

---
**FLOATY ITERATION #1 — pxPerMeter 7.5 → 15 (the one ruler knob; STARTING value, iterate):** the floaty
feel (car too small/slow, track too big) is tuned by raising the single ruler number. **One line**
(`CONFIG.pxPerMeter`). At 15 (1920-px screen): **world 256 → 128 m** (track AND desktop), **car axle 19.2
→ 38.5 px (2× bigger on screen)**, corners tighter, screen-pace ~2× faster. The car stays **2.565 m
physically**; only its on-screen size + the world's metre-count change. Both maps update from the one
pxPerMeter; desktop icons (bound to `CONFIG.wheelbase`) scale WITH it → **car-to-icon ratio UNCHANGED**
(icons bigger too) — the car is bigger vs the WORLD, same vs the icons. **MEASURED:** step() BYTE-IDENTICAL
0.0e+0 (step never reads pxPerMeter); layers ~25 MB at any pxm (`world_m × pxm = screen_px ≈ 1920`);
speedometer honest (km/h from real m/s, unaffected); tsc + build clean. **WHAT IT FIXES vs NOT:** raising
pxm fixes the *on-screen* floaty — bigger car, faster pace, tighter corners (looks slow/small/track-too-big).
It does NOT change how the car *responds* (grip, throttle, weight = the car's physics, unchanged) — if the
RESPONSE/feel is also off, that's the SECOND lever (power/grip), separate from pxPerMeter. **NEXT:
keyboard-test BOTH maps — still floaty → raise pxm higher; too zoomed-in → lower. Iterate this ONE number.**

---
**RALLY VARIANT via VehicleSpec (parameterized per-car physics, NOT forked) — road byte-identical 0.0e+0:**
the car is now a switchable PARAMETER SET on the ONE sim-real-2 model. `vehicles.ts` gains `VehicleSpec`
(`{ name, liveryColor?, overrides: Partial<Config> }`) + `ROAD_SPEC` (name 'Blitz RS', `overrides:{}` → cfg
= CONFIG) + `RALLY_SPEC` (name 'Blitz RS Rally'). The Car holds `spec` + a cached `cfg` (= CONFIG for road,
`{...CONFIG, ...overrides}` for rally) + `liveryColor`; `step(car.state, current, FIXED_DT, car.cfg)` reads
it. `applyVariant(car, spec)` rebuilds cfg/livery in place. **RALLY overrides (gravel period-race build, all
real units on the one ruler — starting values, tune on phone):** `mass 1100` (−100, inertia 1875→1719),
`simReal2PeakTorque 287`/`IdleTorque 191` (+20% → ~285 hp), `simReal2BudgetRear 4600` (gravel µ_rear ~0.85
vs road 8800/µ1.49), `simReal2PeakFront 3900` (µ_front ~0.72, front<rear → oversteer-happy), `simReal2FinalDrive
4.4` (short rally gearing). Livery = rally white `#eaf0f5` (drawCar uses `liveryColor ?? color`). **⚠️ Overrides
do NOT touch `wheelbase`/`pxPerMeter`** → rally inherits 2.565 m, draws the SAME size, one ruler intact, no
second scale. **D-key UX:** D stays the debug HUD; **C cycles the variant** (road↔rally) live, re-spec'ing
every car in place; the debug HUD shows `CAR: <name>`. New cars spawn in `currentVariant`. **MEASURED:** (a)
**ROAD step() BYTE-IDENTICAL to HEAD 0.0e+0** (launch/corner/drift/handbrake/brake — road cfg = CONFIG, no
overrides; physics.ts UNTOUCHED, empty diff); (b) RALLY runs (a NEW cfg path, never touches road); tsc +
build clean; no brand strings (Blitz RS / Blitz RS Rally only). **HONEST NOTE (tuning):** at µ0.85 + short
gearing + +20% power the rally is **wheelspin-happy** → currently it accelerates SLOWER in a straight line
than road (rear lights up; ~100 vs 131 km/h over a fixed test) and the loose/slidey feel shows under PROVOKE
(handbrake/aggressive), not gentle cornering. That's the gravel character; for more straight-line punch raise
the grip budget toward µ1.0–1.1, for more slide drop it toward µ0.5 — the lever the player tunes next.
**NEXT: keyboard-test both (C to switch) — road = grippy asphalt, rally = loose gravel; tune the rally grip/
gearing to taste.**

---
**SIZE ITERATION — pxPerMeter 15 → 10 (smaller car, step ONE = size only):** lowered the one ruler knob
to make the car SMALLER (reverses the floaty-iteration's 7.5→15). At 10 (1920-px screen): **world 128 →
192 m** (track AND desktop), **car footprint 67 → 44 px (smaller)**, tyre 13.3 → 8.9 px (still visible +
proportional via the wheelbase-bound `ctx.scale(ART)`), maps still FILL the screen (oval/desktop), more
metres on screen, car-to-icon ratio preserved (icons shrink with the ruler). Car stays **2.565 m
physically**. **MEASURED:** step() BYTE-IDENTICAL 0.0e+0 (never reads pxPerMeter); layers ~25 MB
(`world_m × pxm = screen_px ≈ 1920`); speedometer honest (km/h from real m/s); both cars draw right (same
ART); tsc + build clean. **EXPECTED SIDE EFFECT:** smaller car + bigger world ⇒ on-screen pace SLOWER
(calmer/quieter look) — that's inherent to lowering pxm; **SPEED is the NEXT, SEPARATE step (engine
power/grip), not this one.** **NEXT: keyboard-test BOTH maps for SIZE — too big → lower pxm; too
small/zoomed-out → raise; then do speed (power/grip) separately.**

---
**HANDBRAKE LOCKED-REAR STABILISER (3 spin/wobble bugs fixed — gated-on-steer yaw damping + handbrake
rest):** the diagnosis found straight handbrake (steer≈0) was an UNSTABLE equilibrium — the locked rear
kills rear lateral grip, so the front-dominated yaw torque `halfWB·(frontFy−rearFy)` (NO damping since
Stage 3c) AMPLIFIES any tiny perturbation (a 0.01 steer / a 0.05 yaw → full spin; corner-release leftover
yaw runs away; a near-stopped car rocks ±forever). Root = locked-rear oversteer instability with no
stabilising term (NOT spin-arm/yaw-kick/asymmetry — sign follows the perturbation; foot brake is stable).
**FIX (sim-real-2, handbrake-gated so non-HB is byte-identical):** (A) a yaw damping
`angularVel -= angularVel · clamp(handbrakeYawDamp·steerFade·lowSpeedBoost·dt)` under handbrake, where
`steerFade = max(0, 1 − |steer|/handbrakeYawDampSteer)` FADES the damping OUT as you steer (steer 0 = full
damping → straight HB slides straight + big yaw decays to control; |steer| ≥ `handbrakeYawDampSteer` 0.15 →
ZERO damping → handbrake-drift-WITH-steering untouched), and `lowSpeedBoost = 1 + 2·max(0,1−speed/restSpeed)`
ramps it ~3× as speed→0; (B) a **handbrake REST** (`hbRest`: handbrake + throttle<0.02 + |v|<restSpeed →
zero vx/vy/yaw) so a near-stopped held-handbrake car SETTLES instead of wobbling (the non-HB `idle` rest is
unchanged → byte-identical). New CONFIG: `handbrakeYawDamp 12.0`, `handbrakeYawDampSteer 0.15`. **MEASURED:**
(a) straight HB steer −0.01: HEAD ω −3.60 SPINS → FIX ω 0.00 straight; (b) corner-release ω −2.0: HEAD runs
to −4.28 → FIX damps to 0.00; **(c) HB+steer 0.7: ω 9.20 / rearSlip −68° IDENTICAL HEAD=FIX → drift fully
preserved** (fade=0 above thresh); (d) low-speed: HEAD 15 sign-flips WOBBLES → FIX 0 flips, ω/|v| 0 RESTS
CLEAN; (e) **non-HB launch/corner/drift/footbrake BYTE-IDENTICAL 0.0e+0**; rally works with the SAME
k/thresh (straight HB straight, HB+steer drifts rearSlip −42°). tsc + build clean; physics-only (render
untouched). **NEXT: keyboard-test — straight HB slides straight + slows, corner-release catches, HB+steer
still drifts, car rests cleanly at low speed (no wobble); both cars.**

---
**HANDBRAKE STABILISER REVERTED (9bdb997 fully undone — realistic layer back to pure finished build):**
the gated yaw-damping + hbRest added in 9bdb997 were an ARCADE assist, not realism — in reality a
locked-rear car on the handbrake going straight IS directionally unstable (it spins if you don't hold the
wheel exactly straight), so suppressing that doesn't belong in the realistic layer. **Reverted via
`git checkout da1b717 -- src/physics.ts`** (da1b717 = the pre-stabiliser parent): a PURE removal of the 3
added blocks (30 lines, 0 additions) — the gated yaw-damping block, the hbRest low-speed snap, and the 2
CONFIG knobs (`handbrakeYawDamp`/`handbrakeYawDampSteer`) + comments. **hbRest reverted too (measured
call):** the finished-build physics ALREADY settles a clean straight handbrake to rest (|v|=0, yaw=0, 0
wobble) — hbRest was only acting on the perturbed/spin-tail case, and keeping it would break byte-identity
with the finished build; a genuine low-speed numerical wobble (if it ever surfaces) is a separate
numerical-hygiene pass. **MEASURED — sim-real-2 step() BYTE-IDENTICAL to finished build 27af7f4 0.0e+0**
across launch / corner / drift / brake / straight_hb / hb_drift / hb_lowspeed; tsc + build clean.
**REALISTIC LAYER CONFIRMED (all REAL, kept):** straight handbrake = UNSTABLE (spins from a perturbation);
scrub = real ~4.15 m/s² rear-only (weak, long slide); handbrake-drift-with-steering = real finished-build
drift. **The ARCADE layer (yaw-stability assist + a tunable scrub multiplier) is a SEPARATE deliberate
pass LATER, behind an arcade/sim toggle — NOT in the realistic physics.**

---
**REAL-HANDBRAKE REBUILD (two-term model — kills the "ice + propeller", realistic-target handbrake):**
the finished-build handbrake was wrong (rear-only scrub ~4.15 m/s² → 37 m ice-slide; front-dominated yaw
torque with NO energy dissipation → propeller to yaw 5.9–9.2 that never bled). REBUILT with TWO physical
terms, both handbrake-gated (non-HB byte-identical): **(1) LONGITUDINAL SCRUB BOOST** — the locked rear
drags harder: `rearLongForce = -kF · hbScrubBoost · forwardVel/slipMag` (longitudinal only; slightly
exceeds the friction circle BY DESIGN so stop distance tunes independently of rotation) → realistic decel
~8 m/s² → stop ~22 m from 70 km/h. **(2) YAW ENERGY DISSIPATION ∝ slide** — the sliding tyres scrub
rotational energy (real dissipation, power ∝ ω², NOT a clamp): `slideSp = hypot(forwardVel, lateralVel);
dampC = hbYawDampLin + hbYawDampSlide·min(1, slideSp/6); angularVel -= angularVel·min(1, dampC·dt)` —
removes ONLY rotational energy (front grip / steering untouched), so the propeller is BOUNDED + BLEEDS
OUT while a controlled drift still rotates. **3 CONFIG knobs (per-car overridable via VehicleSpec):**
`hbScrubBoost 2.0` (stop distance), `hbYawDampLin 1.0` (catchability), `hbYawDampSlide 3.0` (bounds the
spin). **MEASURED:** (a) **non-HB launch/corner/drift/brake BYTE-IDENTICAL 0.0e+0** (all gated on
`input.handbrake`); ROAD (from 64 km/h): **stop 22 m** (was 37), **straight HB max yaw 0.9** (was 5.9
propeller — slides ~straight, bounded), **HB+steer drift −66° / yaw 2.3** (deep + controllable, was yaw
9.2), **spin 2.7 → countersteer → 1.18** (bleeds + catchable); RALLY: stop 9 m (from 34 km/h — rally's
weak straight-line started lower), straight HB 0.1, drift −82°/yaw 1.9, **spin caught 0.00**. tsc + build
clean. **HONEST:** NOT byte-identical to the finished build on handbrake — intentional (the finished
build was ice+propeller). Rally may want its OWN `hbScrubBoost` (its grip budget 4600 → lower kF → a
different decel) via a VehicleSpec override — left at the shared default for now. The 3 knobs are the
realistic-target set; a future ARCADE pass can dial them per-car behind an arcade/sim toggle. **NEXT:
keyboard-test both cars — handbrake scrubs + stops sensibly, controllable slide, bounded rotation (no
propeller), no ice-glide, drift-with-steer works.**

---
**ARCADE BRANCH (X toggle — faster/oversteer/catchable, ZERO new step() code, SIM byte-identical):** a
second physics "mode" built as a PURE parameter transform on the realistic sim-real-2 model — NO governor/
sustain/wave/band-aids, and **NO new force term in step()** (so SIM is byte-identical trivially). `physics.ts`
gains `applyArcade(base: Config): Config` + 5 live CONFIG knobs; `desktop.ts` adds `arcadeMode` + the **X**
key (D = debug HUD, C = car road/rally, **X = arcade⇄sim**; HUD shows `MODE: ARCADE/SIM`). **Mechanism:**
`car.cfg = arcadeMode ? applyArcade(base) : base` where base = CONFIG (road) or {...CONFIG,...rally} →
ARCADE multiplies the base's params + boosts the EXISTING auto-countersteer; SIM uses base untouched →
step() runs the realistic config → **0.0e+0**. **applyArcade =** `simReal2PeakTorque/IdleTorque ×arcadePowerScale`
(1.4 → faster/punch), `simReal2DragCoeff ×arcadeDragScale` (0.8 → higher top), `simReal2PeakFront ×arcadeFrontGripScale`
(1.25 → SHARP turn-in), `simReal2BudgetRear ×arcadeRearGripScale` (0.7 → OVERSTEER/drift/donut), and the
**catch** = `arcadeCatchAssist` (0.6) interpolating the existing `autoCounterStart/Strength/Trim` +
`frontSlipLimitOptimal` toward a stronger arcade auto-countersteer (engages sooner, more front authority,
more player trim) — **amplifies the player's countersteer, NO β-target governor**. Composes per-car
(rally-arcade = rally × arcade). **MEASURED:** (a) **SIM byte-identical vs HEAD 0.0e+0** (launch/corner/
drift/handbrake/brake — step() untouched, sim cfg = CONFIG); ROAD-arcade: **top 277 km/h** (vs sim 239),
**corner yaw 1.20** (vs 0.83 = sharper), **DONUT yaw 2.4 / sd 0.50 = CONTROLLED, exits −0.23** (catchable);
RALLY-arcade: top 225, slidier (rally's low grip × arcade), controlled donut yaw 1.3. tsc + build clean.
**Targets met:** faster + punch, sharp cornering, oversteer drift, controllable donuts (full-lock+throttle →
steady spin that exits on straighten/lift), catchable (boosted auto-countersteer), drift around icons
(controllable slides), both cars. **HONEST TRADEOFF (tunable):** `arcadeRearGripScale 0.7` (oversteer for
drift/donut) makes the LAUNCH wheelspin-happy → 0-50 slower than SIM; raise it toward ~0.85 for a punchier
launch at the cost of easy throttle-drift, or lower it for slidier. All 5 knobs live on the D-tuner
(re-spec every car on change). **NEXT: keyboard-test arcade (X) — faster, sharp corners, whole-corner
power-slide drift, controllable donuts, drift around icons, catchable; both cars; then dial the 5 knobs.**

---
**ARCADE RETUNE (satisfying drift dialed in — + an HONEST measured tradeoff flagged):** retuned the 5
arcade defaults toward a TOP drift: `arcadePowerScale 1.4→1.55`, `arcadeFrontGripScale 1.25→1.3`,
`arcadeRearGripScale 0.7→0.8`, `arcadeCatchAssist 0.6→0.45` (drag 0.8 kept). **MEASURED (ROAD-arcade):**
top 295 km/h, **power-drift 45° with SMOKE**, **controllable DONUT yaw 2.2 / sd 0.45 / 84° slip / SMOKE /
exits clean** (catchable), sharp corner. RALLY-arcade = extra-slidy (rally's low grip × arcade — may want
its OWN higher arcadeRearGripScale). **SIM byte-identical 0.0e+0** (defaults only touch applyArcade; step()
untouched). tsc + build clean. **⚠️ THE HONEST TRADEOFF (measured, NOT solved — flagged for the player):**
the satisfying BIG drift + donut + smoke needs the rear to break loose easily (LOW `arcadeRearGripScale`
≤ ~0.85) → which INHERENTLY WHEELSPINS the launch (0-50 with wheelspin); a clean no-wheelspin launch needs
HIGH grip (≥ ~1.1) → which then GRIPS and won't power-slide at all (measured: rr1.1 = 0% wheelspin launch
but drift dies to ~2°). **No single grip/power value gives BOTH** — at cornering speed the gearing drops
wheel torque below high grip, and the friction-circle break-loose either snaps (low grip) or never
happens (high grip). The current defaults LEAN to the drift (the "TOP arcade experience" + 40-60°+smoke
the player asked for), accepting the wheelspin launch. **Breaking the tradeoff needs a LAUNCH
TRACTION-CONTROL assist** (arcade-only, low-speed + straight-gated: cap rear wheelspin on a straight
launch so it hooks up, while a STEERED/provoked slide still breaks loose) — a clean real assist, NOT a
governor; OFFERED, not built (awaiting the go-ahead). **KNOBS to dial (live on the D-tuner, MODE=ARCADE):**
`arcadeRearGripScale` = the master feel dial (↑ cleaner launch + grippier / ↓ slidier + easier drift+donut);
`arcadePowerScale` = speed + how hard it breaks loose; `arcadeFrontGripScale` = turn-in sharpness;
`arcadeCatchAssist` = catch/hold (↑ smaller+stabler slide / ↓ bigger+looser). **NEXT: keyboard-test arcade
(X) — feel the 45° smoky drift + donut; dial arcadeRearGripScale for your launch-vs-drift balance; tell me
if you want the launch traction-control assist to get clean launch AND easy drift together.**

---
**WEBRTC STEP 1 — CONTROL DEADBAND quick win (quota: idle 30→5 msg/s, measured on the real code):**
the phone's 30 Hz control loop now only SENDS when the input changed. Pure, unit-testable logic in
`lobby.ts`: `quantizeControl` (0.01 steps — kills gyro micro-jitter that would defeat the deadband) +
`shouldSendControl(prev, next, msSinceLastSend)` (send iff first packet | ≥`CONTROL_KEEPALIVE_MS` 200 ms
keepalive floor | any field changed) + `ControlSample`. `phone.ts`: the 30 Hz `setInterval` now calls
`sendControlTick()` (deadband path); pedal/handbrake EDGE events + watchdog/reset keep calling
`sendControlNow()` = FORCE send (a state change is on the wire immediately). Payload shape unchanged
(`{id, slot, steer, throttle, brake, handbrake}`) → desktop untouched on the receive side. Also
`LOBBY_SYNC_MS` 2000→**5000** (the periodic roster fan-out was the safety net; on-change broadcasts carry
the real-time updates). **MEASURED (real `shouldSendControl` driven at 30 Hz, gyro noise ±0.004 riding
the signal):** IDLE **5.0 msg/s** (was 30), ACTIVE tilting **28.4 msg/s** (full rate preserved), slow
drift 16.7; **max send gap 233 ms < INPUT_COAST_MS 400 → the desktop NEVER mistakes an idle phone for a
drop (no coast/neutral ramp regression, guaranteed by the 200 ms keepalive floor)**. tsc + build clean.
⚠️ LIVE Supabase verification pending — no Docker/supabase CLI on this machine (local stack unavailable);
the decision logic is measured on the real bundled code, and the wire-level check (idle ~5 msg/s in the
Realtime inspector) should be done when the local stack or the prod quota is available. **NEXT: STEP 2 —
WebRTC V1 (phone-initiated PC per player, signaling over steer:<code>, control DataChannel
{ordered:false, maxRetransmits:0} + reliable state channel, 8 s fallback to Realtime, reconnect by id).**

---
**WEBRTC STEP 2 — V1 P2P TRANSPORT (tilt phone↔desktop over a DataChannel; Supabase = signaling only,
measured 10 msgs/pairing):** new `src/rtc.ts` — the WebRTC layer with an INJECTABLE PeerFactory (the
RTCPeerConnection surface is a minimal structural interface), so the whole signaling/pairing flow is
unit-tested HEADLESS on the real bundled code. **Topology:** N phones → 1 desktop; the PHONE initiates
(creates the PC + BOTH DataChannels + sends the offer); the desktop runs `createRtcHost` with a
`Map<clientId, peer>` (join/leave mid-game; a FRESH offer for a known id REPLACES the old peer =
reconnect). **Signaling** rides the existing `steer:<code>` channel as `rtc-offer`/`rtc-answer`/`rtc-ice`
(trickle). **Channels (one SDP):** `"control"` `{ordered:false, maxRetransmits:0}` — the tilt stream,
EXACTLY the EV.control payload shape (Step-1 deadband/keepalive applies unchanged — the seam is inside
`sendSample`); `"state"` reliable — BOTH directions: desktop→phone `lobby`/`full`, phone→desktop `join`
heartbeat/`color`/`name`/`leave` (framed `{ev, payload}` with the SAME EV names → same handlers).
**Channel-leave:** on control-open the phone calls `rc.stop()` (new `stop()`/`resume()` on
ResilientChannel in supabase.ts — deliberate leave that SUPPRESSES the auto-reconnect) → zero Realtime
traffic from P2P phones; the DESKTOP channel stays subscribed forever (serves new joiners' signaling).
**Fallback:** control DC not open in `RTC_FALLBACK_MS` 8 s → phone stays on Realtime (today's path,
playable for everyone). **Reconnect:** ICE failed/DC closed → `onDead` → `rc.resume()` → onReady →
`startRtc()` fresh offer → host replaces the peer → same-car reclaim by id (RESILIENCE grace).
Screen-lock: `visibilitychange hidden` → best-effort NEUTRAL packet (car parks, grace window preserves
it); `visible` → resume + retry P2P. **STUN** google ×2; NO TURN in V1 (`RTC_ICE_SERVERS` extensible —
config-only later). **Transport-agnostic seam:** desktop EV handler bodies extracted to
`handleJoin/Color/Name/Leave/Control` — called from BOTH the Realtime wire and the rtcHost callbacks
(DC control → the same `applyInputs`+`lastInputAt` path); phone `handleLobby/handleFull` ditto.
**MEASURED (headless, fake linked PC pair driving the real bundled rtc.ts — 15/15):** pairing opens;
**signaling = 10 msgs/pairing (1 offer + 1 answer + 8 ICE)** within the 6–15 target; control payload
arrives byte-equal through the DC seam; join/color one-shots + full/lobby downlink over the state DC
both directions; reconnect replaces (peerCount stays 1, old PC closed, control flows on the new peer);
onDead fires when the open DC dies; fallback timer fires when P2P never opens. physics/cars/race/render/
RESILIENCE constants untouched (empty diff). tsc + build clean. **⚠️ AWAITING LIVE TEST (can't verify
here — no Docker/local Supabase, no real NAT/sensors):** real pairing over Supabase signaling, wire-level
quota drop, iOS screen-lock/return behavior, NAT fallback share, 2-phone multiplayer over mixed
transports. **NEXT: live 2-phone test after the quota reset (or local stack); TURN (V3) before the scale
push — config-only in RTC_ICE_SERVERS.**

---
**OLD FEEL / NEW SCALE — STAGE A (arcade pace + cornering retuned to the measured old-arcade
screen-space targets; parameters only):** the boss verdict was "drives weak" — measured root: the old car
(27af7f4 era) looked 2.2× quicker purely from pxPerMeter 22 vs today's 10, plus today's arcade broke into
a spin at full lock. Stage A rebakes the arcade override set so the car is GENUINELY ~2× faster in m/s
(the ruler stays untouched): `arcadePowerScale 1.55→4.0`, `arcadeRearGripScale 0.8→3.4`,
`arcadeFrontGripScale 1.3→3.0` (front/rear 0.76 — front BELOW rear is what makes full-lock at speed
CARVE instead of spin; f/r≈1.0 measured to swap ends at 100+ km/h), `arcadeDragScale 0.8→2.8` (caps top
at ~840 px/s ≈ the old 762), + NEW `arcadeBrakeScale 2.0` (`simReal2BrakeForce ×` in applyArcade; brakes
keep pace with 4× power: 100→0 in 21 m). Grip is deliberately arcade-fantasy (µ~4): the old 1/3 model was
already 2–2.6× real AND on the 2.2× ruler. **HIT TABLE (target=old-arcade, screen-space):** screen-cross
**5.3 s = 5.3 ✓**, launch **0.20 scr/2s ≥ 0.16 ✓** (0-50 **0.63 s, 0% wheelspin** — the wheelspin-launch
tradeoff is GONE at high grip), top **839 px/s** ≈ old 762 ✓, corner radius **144 px ≈ 150 ✓**,
**full-lock @100+140 km/h βmax 3° CARVES ✓** (was 179° spin), brake 21 m ✓. **HONEST MISSES:** corner yaw
1.36 vs old 1.81 and corner speed 196 vs 270 px/s — the price of the high-speed carve (raising front grip
to match yaw makes it spin); the RADIUS (the visual) matches. **SIM byte-identical 0.0e+0** (knobs only
touch applyArcade); ruler/pxPerMeter/transport untouched; D-tuner rows rescaled for the new ranges
(+arcadeBrakeScale row). tsc + build clean. **NEXT: STAGE B — `arcadeDriftHold` (the clean arcade-gated
β-target governor) for the old held-drift 33°±0 + travel + catch + donut; drift/donut are NOT expected to
work well in Stage A alone (high grip = grips).**

---
**OLD FEEL / NEW SCALE — STAGE B (`arcadeDriftHold` — the clean ARCADE drift governor; old held-drift
feel restored, SIM 0.0e+0):** ONE stateless relaxation law in step(), gated `if (c.arcadeDriftHold > 0)`
where the gate is set ONLY by applyArcade (from `arcadeDriftHoldGain`, the D-tuner knob) — base CONFIG
keeps 0 → SIM never runs it (byte-identical by construction, proven). **The law:** in a PROVOKED
(|β| > `arcadeDriftEnter` 8°) throttle-on slide, relax ω toward `ω_des = dφ/dt + k·(β − β_target(steer))`
(dφ/dt computed statelessly from this step's body force: κ = (v×a)/v²) — steer SETS the drift angle
(`β_target = −steer·arcadeDriftAngle`, 0.94 rad ≈ 54° at full lock → steer 0.6 ≈ 32°), straightening →
β_target 0 → clean exit; + a held-speed push along velocity (`arcadeDriftSpeed` 22 × throttle, cap 30
m/s², from below only, off during the handbrake flick) so the drift TRAVELS; near full lock a `lockFade`
(floor 0.45) fades the held speed so the β-target-as-donut stays a TIGHT fast circle (ω≈µg/v). Smooth
engagement ramps (β 8→14°, throttle 0.2→0.5, speed 2→4) — no latches. Internal rates `ARCADE_DRIFT_KBETA
6 / RELAX 20 / ACCEL 30` (module consts; KBETA/RELAX had to be this fast or the µ4 rear re-gripped before
the governor caught the slide — measured: enter 12° or KBETA 4 → the steer-0.6 drift DIED to β 1°).
**ENTRY (reported):** deliberate but not hard — a HANDBRAKE FLICK at speed (reaches β ~10° > the 8° gate;
pure throttle grips at µ4 — Stage A's clean launch is untouched); the standstill donut engages from
full-lock + full-throttle once rolling. **HIT TABLE (target = old-arcade):** held drift steer 0.6 **β
−32° ± 0.1** (old 33 ± 0 ✓), travel **171 px/s** (old 178 ✓), steer 1.0 → β −52° (deep, full lock = the
donut command, travel fades by design); **CATCH: steer→0 → β 0°, yaw 0.00** (old 0.00 ✓ clean exit);
**DONUT: yaw 3.0 ± 0.00 rock-steady** @ β 51°, exits to 0.00 on straighten (old 2.5 ± 1.97 wobbly —
ours slightly snappier and perfectly steady; the yaw-ceiling split was NOT needed — the donut doesn't
run away, lockFade bounds it); **Stage-A regression: cross 5.3 s ✓, full-lock @100 βmax 3° CARVES ✓**
(the governor's 8° gate never engages in grip cornering). D-tuner rows added: `arcadeDriftHold`(Gain) /
`arcadeDriftAngle` / `arcadeDriftSpeed`. SIM byte-identical 0.0e+0 (full suite); ruler + transport
untouched; tsc + build clean. **NEXT: keyboard-test the complete arcade (X): pace, corner, drift
(flick → hold → steer sets angle → straighten exits), donut (lock + throttle), launch — then feel-iterate
the knobs.**

---
**WEBRTC STEP 3 — TURN relay (Cloudflare, three-tier transport complete; 16/16 headless):** the ~10–20%
of players whose NAT blocks P2P now get a TURN relay instead of falling back to Supabase Realtime →
Realtime carries ONLY signaling for everyone. **Pieces:** `api/turn.js` — a Vercel serverless function
(plain JS, OUTSIDE tsc/Vite — tsconfig includes src/ only; vercel.json's /play rewrite doesn't shadow
/api) that POSTs Cloudflare `credentials/generate` and returns short-lived (TTL 600 s) TURN iceServers;
Origin allow-list (steerit.app + steer-it.vercel.app) as the light abuse guard; **env vars NOT set →
503 → the phone silently proceeds STUN-only** (nothing breaks before the Cloudflare/Vercel setup is
done — needs `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` in Vercel). `rtc.ts` — `makePeerFactory(iceServers,
relayOnly)` (the V1 config extension point realised), optional `getStats` on PeerLike +
`connectionPathOf(pc)` (nominated candidate-pair → 'direct'|'relay'|'unknown'), `fetchTurnServers`
(injectable fetch, 2 s abort → null on ANY failure), `createFallbackTracker` (pure), host
`onPeerConnected(id, pc)` hook (fires on control-DC open, handles already-open). `phone.ts` — startRtc
now fetches TURN creds first (guarded by `rtcStarting`, still one attempt per (re)connect); **`?rtc=relay`
query param → `iceTransportPolicy: 'relay'`** = the forced-TURN test switch. `desktop.ts` — per-pairing
console log: `[rtc] <iso> player <id> connected via direct | relay (TURN)` (via getStats after DC open)
and `via fallback (Realtime)` (Realtime control packets for an id with no RTC peer after 12 s, once per
id; fed ONLY from the Realtime wire so DC control can't false-trigger). **Order: P2P direct → TURN relay
→ Realtime fallback** (direct-first is inherent to ICE candidate priority; TURN in iceServers never slows
a direct pairing). **MEASURED (headless, 16/16 on the bundled rtc.ts):** factory passes STUN+TURN + relay
policy; fetchTurnServers valid/array shapes → servers, 503 (unconfigured)/bad shape/network error/timeout
→ null (STUN-only); connectionPathOf relay/direct/unknown; onPeerConnected fires with (id, pc) through
the fake-PC pairing; fallback tracker logs once after grace, never twice, resets on peer presence. tsc +
build clean; physics/transport-V1 flows untouched. **COST (est.):** ~13 MB/player-h relayed, 10–20 %
share → ~$0.01/h @100 concurrent, ~$0.10/h @1000 (Cloudflare ~$0.05/GB). **⚠️ AWAITING (user setup +
live):** Cloudflare TURN key + Vercel env vars; then the forced-relay check (`steerit.app/play?s=CODE&rtc=relay`
→ desktop console must log `via relay (TURN)`) and an LTE (WiFi-off) real-phone test; fallback line
appears if a phone stays on Realtime ≥12 s. **Realtime is now signaling-only for every tier → the quota
problem is closed.**

---
**NEW ARCADE DRIVING MODEL (`arcadeModel.ts`) — kinematic arcade controller, DEFAULT mode; sim-real-2 =
hidden SIM (X toggles), physics.ts UNTOUCHED (0.0e+0):** the boss-approved quality spec built as SIX
simple laws where the feel is the equation — NO Pacejka/load-transfer/emergent tyres. The model owns
(v, φ, θ) = speed, motion direction, heading; CarState.vx/vy stay the source of truth so the EXISTING
collision systems (cars.ts pair bounce, collideWithRects walls) keep mutating them and the next step
absorbs the impulse. Per-car model state lives in a WeakMap keyed by the CarState object (respawn = new
object = fresh state) → NO physics.ts change at all. **LAWS:** L1 thrust `dv=th·aMax·(1−(v/vTop)²)` (hard
[0,vTop], punchy→flattening = aspirational top); L2 steering `ω_cmd=steer·ωMax·min(1,v/vRef)`, `dω=(ω_cmd−ω)/τ_steer`
(τ_steer = rotation WEIGHT; first-order → no overshoot, collision ω decays); L3 grip `dφ=clamp(kGrip·sin(θ−φ),
±aLatMax/v)` + **the PROJECTION `θ := φ+clamp(θ−φ,±sMax)`** (FIX 1 — grip slip invariant ≤9° by construction,
excess steer just widens the arc); L4 drift = EXPLICIT state (enter: e-brake + |steer|≥0.25 + v≥8; steer SETS
δ_target ∈ [δMin 15°, δMax 50°] hard-clamped; path `ω_path=dir·(0.9+|steer|·1.3)`; `dv=−bleed+th·feed ≤ 0` →
every slide bleeds; exit: steer→centre OR v<6, δ→0 @ kExit; **heading CHASES φ+δ through τ_body 0.10 s**
(FIX 3 — collision hits turn the body smoothly, no teleport)); L5 collisions = impulses into vx/vy/ω only →
all decay to clamped targets; L6 reverse = brake at standstill (existing convention), mirrored steer, no
drift in reverse. **VERIFIED (headless, 18/18 with the corrected speed-pinned fit tests):** slip invariant
9.0° ≤ 9° at ALL speeds full-lock; T-bone in grip decays (slip 0.3°, ω 0.01, no spin); drift hit = smooth
(max Δθ 0.089 rad/frame, bounded 34°≤50°); drift ALWAYS exits (release → grip 1.5°; off-throttle bleeds out
5.4 s); donut R 4.9 m + exits; **fit table EXACT: grip R@15 = 18.8 m (theory 18.75 — does NOT thread the
10 m gap), @11 = 10.1 (threads it), DRIFT R@12 = 5.5 (3× tighter = THE GAMEPLAY LOOP), R@19.3 = 31.2 = oval
band centre**; launch deterministic + spam ≤ hold; reverse + re-hook; **sim-real-2 vs HEAD 0.0e+0**. Pace:
top 162 km/h (45 m/s, oval straight ends at 124 = mid-band, top never reached on-map ✓), 0-50 1.68 s,
launch 0.86 g, cruise cross 5.5 s, brake 100→0 32 m. **CarState synthesis:** rearSlip=δ (drift) / θ−φ ≤9°
(grip) → skids/smoke/XP work; isRearSliding=DRIFT; wheelSpin=drift·throttle·0.8 (launch 0 → no lottery);
rearWheelSpeed=sound proxy; driftActive/spinTimer set; no consumer breaks. **Wiring:** desktop
`arcadeMode=true` default, X→SIM; `applyVariant` builds BOTH car.cfg (sim) + car.arcadeParams
(ARCADE defaults × spec.arcade — rally: vTop 38, aLatMax 9, kGrip 4.5, δMax 57°, bleed/feed 4.5);
**D-tuner = all 20 law knobs** (mutate live ARCADE + re-apply variants). Old `applyArcade` +
`arcadeDriftHold` governor left in physics.ts but OFF the active path (gate 0 in sim; nothing calls
applyArcade) — in git. **NEXT: keyboard smoke-test (X=SIM check, drive/drift/donut/reverse), then the
boss feel-tunes on TILT (the 20 knobs).**

---
**ARCADE L4/HANDBRAKE REDESIGN (boss live-test defects — the e-brake is now the DRIFT TOOL: causes,
TIGHTENS, and BRAKES; overrotation risk EXISTS):** three law fixes in `arcadeModel.ts`, rest of the model
untouched. **(1) hb = brake, never boost (the third-model curse ended by INVARIANT):** in DRIFT
`dv = −driftBleed + throttle·driftFeedCap·driftBleed − (hbHeld ? hbDecel : 0)` — `driftFeedCap 0.7 < 1`
hard-capped in code (throttle offsets at MOST 70% of the bleed) → **dv/dt < 0 in a drift ALWAYS**
(measured: full throttle + held hb = −7.1 m/s² every frame; full throttle no hb still bleeds). The e-brake
also BRAKES in grip (`hbDecel 6` added to the grip decel). **(2) held e-brake TIGHTENS:** `st.tight` grows
at `hbTightenRate 0.35 rad/s` while held (clamped `hbTightenMax 0.4`), decays 2× on release; it ADDS to
δ_target → the angle closes past the steer target (measured: held vs released after 1.3 s = 48° vs 25°,
and scrubs 43 vs 71 km/h); the radius also tightens geometrically (R = v/ω, v scrubbed). Tap = enter
(immediate, same frame), hold = tighten + scrub, release = drift lives on steered by tilt. **(3) SPIN-OUT
exists:** δ_target past `deltaSpin 1.05 (60°)` (reachable ONLY by holding the e-brake deep — full lock
alone targets δMax 50° < 60° so the approved controllable DONUT survives; the risk rides the hb hold per
the boss's "hold too long" mechanic) → third state SPINOUT: ω := spinYaw 4.5 decaying exponentially at
`spinDecay 0.8` (**total rotation FINITE = spinYaw/spinDecay ≈ 320°**), v scrubs at `spinBleed 6`, throttle
ignored; recovery at |ω|<0.8 hands the FULL residual angle to exit (unclamped — clamping snapped the body)
and `EXIT_RATE_CAP 3.5 rad/s` unwinds it spin-smoothly (kExit alone would yank 16 rad/s on a 120° residual).
**Two spin bugs found+fixed by the harness:** reverse-detection killed the spin at 90° body-vs-path (rev
now evaluated ONLY in grip mode) and the exit handover/projection snapped the heading. **(4) self-
termination:** held-forever e-brake drift ENDS in 2.4 s (scrub → exit/spin). **VERIFIED 16/16:** both dv<0
invariants; tighten (48° vs 25°); spin exists, lasts 2.1 s, rotates 257°, ENDS, recovers to grip; held-
forever terminates; regressions green (slip invariant 9°, collision decay grip+drift, release exit, donut
R 3.5 m for 3.9 s then self-terminates BY DESIGN — feed<bleed means donuts need re-provoking; note
vMinDrift 6 / vMinEnter 8 gap makes an ended donut need speed to re-enter, a feel-tuning knob pair),
launch determinism, **sim-real-2 0.0e+0**. New D-tuner knobs: `driftFeedCap · hbDecel · hbTightenRate ·
hbTightenMax · deltaSpin · spinYaw · spinDecay · spinBleed` (rally: deltaSpin 1.2). tsc + build clean.
**NEXT: boss tests the handbrake loop on TILT — tap→drift, hold→tighten+scrub, hold too long→spin-out,
release→steer the drift; donut lifetime + the vMinDrift/vMinEnter gap are the first feel knobs to dial.**

---
**ARCADE L4 FUNDAMENTAL REDESIGN — the handbrake is the MECHANISM (locked rear wheels), drift is a
CONSEQUENCE, not a gated state:** the boss's failing test ("straight, slow, pull the lever — nothing
happens") exposed the root error: the e-brake was an abstract drift button gated on steer+speed. Rebuilt
around the REAR-WHEEL REGIME (still kinematic — a simple 3-way condition, NOT tyre simulation):
**ROLLING** (default) = the grip/slide laws as built; **LOCKED** (lever held) = strong friction braking
ALWAYS (`hbDecel 6` in every mode — straight+slow+lever now simply BRAKES: 20 km/h → stop in 0.6 s/1.8 m,
heading unchanged) + the rear loses lateral hold: moving with ANY turn intent (|steer|>0.05 OR |ω|>0.25 —
no steer threshold, no speed gate, entry seed δ=0.06 that GROWS at `hbSwingRate 0.9·min(1,v/8)` — the
swing is progressive, a mechanism not a jump) → the angle CLOSES/tightens while speed scrubs; growth is
unbounded = crossing `deltaSpin` breaks into the SPIN-OUT (hold too long = the risk, unchanged);
**SPINNING** (throttle in a slide, lever released) = the drive FEEDS the slide (`driftFeedCap 0.7 < 1` —
sustained, never accelerating), steering AIMS the angle. **Lock DOMINATES throttle** (design call:
stopped wheels can't be driven — lever+full gas = feed 0 + hbDecel, measured dv −9.5 → −6 m/s², never ≥0).
Removed: `driftEnterSteer`/`vMinEnter` gates + the `tight` accumulator (`hbTightenRate/Max` → ONE
`hbSwingRate` knob). Locked slide exits only near-stop (v<1) or via spin — releasing mid-slide hands to
SPINNING/exit as before. **VERIFIED 21/21 (the boss's 6 tests as invariants + regressions):** B1 THE test
✓ (brakes, no phantom rotation); B2 straight fast: 100→0 in 5 s/45 m, stays straight (bounded-wiggle
flavor SKIPPED — knob later if wanted); B3 mid-corner lever: angle 5→43° over 1 s of hold + 69→35 km/h
scrub; B4 spinning: drift lives on throttle, steer aims (0.35→21° vs 0.95→38°), dv<0 without AND with
full throttle; B5 lock dominates; B6 release-all regrips (0.3°); regressions: slip invariant 9°, T-bone
decay, donut R 5.1 m for 5.0 s, spin-out exists/ends 1.8 s/recovers, held-forever ends 2.0 s, launch
determinism, **sim-real-2 0.0e+0**. (3 interim FAILs were test bugs: a worst-accumulator init, an
over-tight 0.33 s threshold vs the τ_body onset, and a too-slow donut entry speed — the model was right.)
D-tuner: `hbSwingRate` replaces the tighten pair. tsc + build clean. **NEXT: the boss's tilt test — the
lever now brakes ALWAYS, swings the rear in any turn, tightens while held, spins if held too deep.**

---
**CAR SCALE — Option A (car 44→33 px = the reference video's 1.7%; world +33% in metres, on-screen tempo
IDENTICAL):** measured the reference (old-mode desktop, 1918×1078): old 1/3 car 1.5 m × pxm 22 = 33 px =
**1.72% of screen width**; today's 4.44 m car × pxm 10 = 44 px = 2.31% → the car is 1.34× too big vs the
video. **⚠️ The prompt said "raise pxPerMeter" but the codebase math is the opposite** (`world_m =
screen/pxm`, car fixed 4.44 m → `car_px = 4.44·pxm`), so LOWERING pxm shrinks the car AND grows the
metre-world. Shrink factor **F = 1.333, pxPerMeter 10 → 7.5**. **Changes:** (1) `CONFIG.pxPerMeter 7.5`
(car 33 px, world 192→256 m; the oval is screen-derived → auto-grows, no code change); (2) desktop
icons/taskbar (world.ts) scaled × F via a documented unit `const U = WB·(4/3)` (all the WB-multipliers →
U-multipliers: ICON 6.5→8.7 m, COL_SPACING 22.2→29.6 m, taskbar, margins, spawn-clear, drag clamps) → the
icons keep the SAME on-screen px while growing in metres, so the fixed-4.44 m car has proportionally MORE
ROOM; (3) **re-fit the arcade model = scale the LINEAR knobs × F** (vTop 45→60, aMax 8.5→11.33, aBrake
12→16, coastDecel 2.5→3.33, vRef 4→5.33, aLatMax 12→16, driftBleed 3.5→4.67, vMinDrift 6→8, hbDecel 6→8,
spinBleed 6→8, vRevMax 7→9.33) + the hardcoded low-speed metre constants × F (rest-snap 0.15→0.2, reverse
0.3→0.4 / 0.4→0.53 / 0.05→0.067, drift-entry v>1.5→2.0, locked-exit v<1→1.33, hbSwing ramp v/8→v/10.67,
dphi speed floor 1→1.33); LEFT the ANGULAR/RATE knobs (ωMax, τ_steer, kGrip, kDelta, δ angles, hbSwingRate,
ωDrift*, spin rates, sMax) unchanged (rotation is scale-free → scaling would change the tempo). Rally arcade
overrides scaled the same way. Model LAWS unchanged. **MEASURED (harness, TODAY pxm10 vs SCALED pxm7.5,
ON-SCREEN):** cross-screen 7.63 = 7.63 s, launch 168 ≈ 167 px, oval corner 193 = 193 px/s, donut 35 = 35 px,
drift path 55 = 55 px, top 450 = 450 px/s — **ALL IDENTICAL** → the re-fit holds; only the car is smaller
(33 vs 44 px). **HONEST metre-side consequence:** HUD numbers grow × 1.33 (top 162→216 km/h, launch 0.87→
1.15 g) — on-screen pace unchanged, metric speeds higher (top is aspirational). Fit confirmed in the 256 m
world: oval corner 25.7 m/s @ R41, desktop 13.3 m gap grips ≤14.6 m/s or drifts R≈7.3 m (1.8× room), donut
R 4.6 m < icon 8.7 m. **sim-real-2 step() 0.0e+0** (pxPerMeter is render-only; step() unchanged); transport
untouched; tsc + build clean. **NEXT: keyboard/desktop look (small car in a spacious map = the video) →
boss tilt-checks; if he wants the car even smaller, drop pxm further with the same ×F recipe.**

---
**DESKTOP LOOK RESTORED — icon/taskbar × 4/3 undone (`world.ts` U = WB·(4/3) → U = WB):** the previous
car-scale task had inflated the desktop icons ×1.333 (for "more room"); with the car now at 33 px (the
video size) that made the icons 1.34× too big vs the old mode (icon-to-car 1.95 vs the old 1.47). Reverted
to WB-bound (the WB-multipliers already encode the shipped ~1.46 ratio) → at pxm 7.5 the desktop renders
at the OLD-mode / video px within ~1%: ICON 48.7 (old 48.4), BIN 64.4 (63.8), TASKBAR 40.0 (39.6),
COL_SPACING 171 (165), car-to-icon 1.46 (1.47). Only `world.ts` changed; car 33 px + arcade knobs ×1.333
+ sim-real-2 + transport + oval (screen-derived) all UNTOUCHED. **Fit (harness):** car 33 px fits the
tightest 57 px gap; donut R 35 px < icon 49 px; drift path R 55 px threads the tightest 57 px gap — but
that TIGHTEST gap is 7.5 m so the drift margin there is only 1.04× (barely; most gaps wider; grip threads
≤11 m/s) = the old-video tight-gap-threading feel. tsc + build clean. **NEXT: look at the desktop (video
proportions) + keyboard/tilt test.**

---
**COLLISION REVERT — cooldown heading-lock (frontal-bounce end-swap 171° → 5°, OLD feel restored;
normal driving byte-identical):** the boss saw the car SWAP ENDS on a frontal/reverse hit. DIAGNOSED
(harness, read-only): the collision code (`collideWithRects` physics.ts + `collidePairCars` cars.ts) is
UNCHANGED since pre-today (`d466cef`) — both mutate only vx/vy (car-car also damps ω ×0.92), never the
heading. The NEW arcade model was re-deriving φ (motion dir) from the BOUNCED velocity every frame
(arcadeModel.ts:167) and re-aiming θ to it via (a) the reverse-flip (:175, `cos(φ,θ)<0` → treats a
>90° bounce as reverse) + (b) the grip projection (θ := φ+clamp), so a frontal bounce (φ jumps ~180°)
swung the nose **171°** (OLD sim-real-2 = **0°**, heading is an independent integrated state). Lateral/
glancing hits were ~identical in both (not the issue); the scale change was NOT the cause. **FIX
(arcadeModel.ts only):** a per-car collision detector — the model records its OWN end-of-step velocity
(`st.ownVx/ownVy`); if the next step reads a divergent `car.vx/vy` (`|Δ|>HIT_EPS 1e-4`), an external
impulse hit → arm `st.hitTimer = HIT_LOCK_S 0.3 s`. While locked: (1) the reverse-flip (:175) is
SUPPRESSED (a bounce can't false-trigger reverse), (2) the grip projection correction is rate-capped to
`HIT_PROJ_CAP 0.3 rad/s` → **θ FROZEN** against the bounce (no nose swap), (3) the path φ is actively
realigned to θ at `HIT_REALIGN 8 rad/s` (the grip sin() stalls at an exact 180°, so a floor realign
returns the velocity to forward without moving the heading) — the OLD "shove + slide straight" feel.
**VERIFIED 6/6:** frontal bounce pre-fix 171° → **fixed 5°** (≈ OLD 0°); lateral/glancing mild + unchanged;
**normal driving byte-identical (0.0e+0 vs pre-fix)** — the detector never fires without a collision (the
model reads back exactly what it wrote); car-car ω impulse still decays (peak 1.9 → 0.00, no pirouette).
KEPT untouched: the new arcade model normal physics/feel, scale (pxm 7.5), desktop restore, sim-real-2,
transport, the collision code itself. **HONEST NOTE:** a LATERAL shove now yields 0° heading change (vs
OLD's 8°) because the lock also freezes θ on a sideways hit — negligible/cleaner (the car is shoved
sideways keeping its facing), not the end-swap. tsc + build clean. **NEXT: boss tests collisions (hit a
wall/icon/car head-on → shove + slide, no end-swap; lateral bump → nudge).**

---
**FASE 0 — 4-WHEEL (per-wheel) FOUNDATION (`physics4.ts`) — the bicycle model's ceiling replaced:**
the new per-wheel base, behind the X toggle (**ARCADE reference ⇄ PHYSICS4 new**). Built per the approved
architecture. **Model (Fase 0 = chassis only, NO throttle/brake/handbrake):** 4 contact points from real
geometry (WB 2.565 / track 1.46, CoM→axle from `weightDistFront` 0.52); **static load** 52/48 front +
**dynamic transfer** (ΔFz_long = m·a_x·h/WB accel→rear, ΔFz_lat = m·a_y·h/T →outer; prev-frame body accel,
clamped ±static, per-wheel Fz≥0); **grip = f(load) with DIMINISHING RETURNS** (`μ(Fz)=muNom−loadSens·(Fz−
Fz_static)/Fz_static`, μ floor 0.3) → transferring load DROPS total axle grip = the drama; **relaxation-
length slip** per wheel (low-pass τ=relaxLength/|vlong|, kills the low-speed blowup) → **Magic-Formula
lateral** (`Fy=−D·sin(C·atan(B·α))`, peak-then-falloff) inside a **friction ellipse** with a GENEROUS
longitudinal axis (Fx=0 in Fase 0; ready so Fase 1 drive keeps forward-bite → the sim-real speed-bleed is
designed out, fully verified in Fase 1); forces **sum to net force + yaw torque** about the CoM (yaw now
from front/rear AND **left/right** grip diffs), integrated with mass 1200 + **Iz=m·k² ≈1875**; **low-speed
kinematic blend** (<2.5 m/s → blend ω to the bicycle-kinematic yaw + nudge velocity to heading) +
rest-snap. **Heading is an INDEPENDENT state** (θ+=ω·dt, NOT re-derived from velocity) → the arcade 171°
collision end-swap CANNOT recur. Per-car state (4 relaxation slips + prev accel) in a WeakMap → physics.ts
UNTOUCHED. **CarState mapping:** rearSlip=max(|α_RL|,|α_RR|), frontSlip=max fronts, isRearSliding=rear
tyre ≥0.95·D or |rearSlip|>0.15, wheelSpin=0 (Fase 0), rearWheelSpeed=|v| proxy; +exported `wheelDebug()`
(per-wheel load/slip for HUD). **VERIFIED 13/13 (headless):** (1) load transfer DROPS axle grip 8476→8171 N
(−3.6%, diminishing returns — the break-loose enabler; tunable via loadSensitivity); (2) LOW-SPEED STABLE
— parking |v|max 0.000/still, slow donut ωmax 0.9 no NaN/shoot-off, low-speed coast yaw jitter 0.000
(no shake); (3) yaw emerges — corner loads outer side 11068 N vs inner 732 N (huge L/R diff), ω develops;
(4) **BREAK-LOOSE reachable + HONEST: Fase 0 (no throttle) UNDERSTEERS at a moderate limit** (front washes
31°, rear grips — real RWD-without-throttle), the rear breaks loose at high speed (140 km/h) / on a flick,
recovers cleanly (ω→0, a slide bleeds energy) — **oversteer/drift ON DEMAND is Fase 1**; (5) deterministic
+ cold-start clamped (no ΔFz spike); (6) frontal bounce heading swing **0°** (no end-swap); (7) **ARCADE
byte-identical 0.0e+0** (untouched). **CLEANUP: sim-real-2 + RALLY retired from the active path** —
desktop.ts dispatch is now `arcade ⇄ physics4` only (X), C-key/rally removed, `car.cfg`/`Config` import/3
sim-real-2 tuner rows dropped, `RALLY_SPEC`/`VEHICLE_SPECS[rally]` removed from vehicles.ts (all in git;
physics.ts `step()` body stays as the shared CONFIG/makeCar/collideWithRects host, unreferenced — a later
pass can strip it). **D-tuner** swaps to the active model's knobs (arcade set OR the 14 physics4 knobs:
massKg/weightDistFront/cgHeight/yawInertiaK/loadTransferLong/Lat/muNom/loadSensitivity/tireB/tireC/
tireEllipseLong/relaxLength/lowSpeedBlend/maxSteer) — no bloat. tsc + build clean; multi-car; one ruler.
**⚠️ KNOWN (tuning, expected):** lateral transfer is strong (inner nearly lifts at the limit — dial
cgHeight/loadTransferLatGain); Fase 0 has no forward thrust so the car only COASTS (throw speed to test).
**TOGGLE-REMOVAL PLAN:** once physics4 wins the feel test (Fase 3), delete arcade + arcadeModel.ts →
physics4 the only model, no toggle. **NEXT: boss tests PHYSICS4 on phone (X) — throw speed, corner, feel
the WEIGHT / load transfer / understeer-at-limit / break-loose at speed. Then Fase 1 (throttle + handbrake
+ brake + longitudinal friction-circle).**

---
**FASE 1 — DRIVE TOOLS on physics4 (throttle / brake / handbrake, all through the per-wheel friction
circle; 17/17):** the per-wheel car now DRIVES. Built on the Fase-0 foundation (physics.ts still
UNTOUCHED — everything in physics4.ts + the WeakMap state). **THROTTLE → rear wheelspin:** each rear wheel
has an angular velocity `rearOmega` (WeakMap); drive torque `= engineForce(faded)·r/2` spins it → slip
ratio `κ=(ω·r−vlong)/max(|vlong|,3)` → longitudinal Magic-Formula `Fx=D·sin(Cx·atan(Bx·κ))`. **FRICTION
ELLIPSE (the one principle):** the tyre budget D is shared — `demand=hypot(Fx/(D·ellipseLong), Fy/D)`,
over 1 scales BOTH down → throttle's Fx eats the circle → rear lateral drops → **power-oversteer**; the
GENEROUS longitudinal axis (`tireEllipseLong` 1.0) keeps forward bite → **drift CARRIES speed** (measured
80→58 km/h held, NOT the sim-real bleed-to-zero). **BRAKE:** front-biased (0.6) brake force opposes motion
through the circle + forward load transfer (Fase-0 a_x) → front bites, rear lightens (measured front 4025
vs rear 1861 N) = trail-brake rotation. **HANDBRAKE = LOCKED rear** (`ω` pinned 0 → the lock OVERRIDES
drive torque; κ=−vlong/… → kinetic scrub ALWAYS opposing motion + eats the circle → rear lateral→0 =
drift entry). **⚠️ HANDBRAKE INVARIANT PROVEN** (failed 3× before as "boost"): dv/dt<0 EVERY frame
straight AND with FULL throttle (worst −3.82 m/s² — the lock beats drive by construction). **LAUNCH
traction control:** below `tractionSpeed` 4 m/s a SOFT TC cuts drive torque once the wheel reaches
`tractionSlipCap` 0.12 (holds the slip, delivers grip) + `wheelInertia` **22** (big = engine/drivetrain
reflected inertia → no spin-up oscillation) → **clean, deterministic, fair launch** (wspin ≤12%, 0→50
km/h ~3 s, two launches byte-identical). **DRIFT EXIT:** lift+straighten → κ→0 → rear regains the full
lateral budget → regrips (measured rearSlip 43°→0.8°, ω→−0.02 in 2 s — always terminates). CarState:
`wheelSpin`=rear κ (smoke), `rearWheelSpeed`=|ω·r| (sound RPM), `isRearSliding`=rear circle saturated.
**VERIFIED 17/17 headless:** clean+deterministic launch, throttle power-oversteer (rear breaks loose),
drift carries speed (no bleed collapse), drift exits (always terminates), **HB always brakes (dv/dt<0
straight + full throttle)** + enters drift, brake load-shifts forward, low-speed still stable (parking
still, donut/burnout bounded no NaN), determinism (drive+brake+hb), **ARCADE byte-identical 0.0e+0**. New
D-tuner knobs (physics4): engineForce/engineFadeSpeed/rollRadius/wheelInertia/brakeForce/brakeBiasFront/
tractionSpeed/tractionSlipCap/tireBx/tireCx. tsc + build clean; multi-car; one ruler; heading still an
independent state (no collision end-swap). **⚠️ THE TUNING KNOB (boss's phone job):** `tireEllipseLong`
is the ROCKET-vs-BLEED window — higher = drift carries more speed (toward rocket), lower = bleeds (toward
sim-real collapse); 1.0 is the start. **NEXT: boss tests PHYSICS4 (X) on phone — launch (clean, no
lottery), throttle-drift (power-over, carries speed), handbrake (locks + always brakes + entry), brake
(front bite/trail rotation), counter-steer to catch, exit on release. Tune tireEllipseLong for the
carry-vs-bleed feel. Then Fase 2 (reverse, engine curve/gears if wanted) + Fase 3 gameplay.**

---
**FASE 1 HANDBRAKE FIX — locked-rear KINETIC SCRUB (was 0.66·D rolling-MF weak → now full-budget scrub;
10/10):** the boss felt the handbrake do almost nothing. DIAGNOSED (read-only harness): the lock pinned
rear ω→0 INSTANTLY (wheelInertia 22 NOT the cause), but the locked wheel's force used the rolling
`MF(κ)` at κ≈−1, where the longitudinal Magic-Formula is POST-PEAK = only **0.66·D** → the friction
ellipse then left the rear ~**0.83·D LATERAL** grip → the rear kept gripping (β only −4°→−11° mid-corner,
held-HB β −6° vs released −9° = the angle did NOT open). FIX: a locked wheel SLIDES on its whole contact
patch → its force is KINETIC friction = the **full grip budget × `hbKineticMu` (0.9) directed OPPOSITE
the contact slip velocity**, replacing BOTH the rolling MF(κ) longitudinal AND the slip-angle lateral for
the locked rear (`Fx = −Dkin·vlong/slipMag`, `Fy = −Dkin·vlat/slipMag`, `slipMag = max(hypot(vlong,vlat),
1)`); the friction ellipse is SKIPPED for the locked rear (already at the full budget by construction).
Rear wheels only, under handbrake only; rolling/normal driving UNCHANGED. **MEASURED 10/10:** (1) instant
lock (ω 0.000 in 1 frame); (2) rear lateral COLLAPSES mid-corner → drift entry (β −4°→**−38°**, rearSlip
7°→**44°**); (3) held HB **OPENS the angle** (β **116° held vs 57° released** — tail swings way out,
counter-steerable); (4) ALWAYS brakes — dv/dt<0 straight AND with FULL throttle (worst −4.81 m/s²),
**deeper** (5.1 m/s² vs the old 0.66·D weak); (5) low-speed stable (parking with HB |v|max 0.000, HB
donut ωmax 1.4 no NaN — the `slipMag` floor + low-speed blend hold); (6) determinism + **ARCADE
0.0e+0**. New D-tuner knob `hbKineticMu` (0.9). physics.ts untouched. **⚠️ NOTE:** the lock is now STRONG
(held-HB β 116° ≈ a big tail-out that can spin if over-held) — dial `hbKineticMu` down on the phone if
too eager. tsc + build clean. **NEXT: boss tests the handbrake on phone (X → PHYSICS4): tap = drift
entry, hold = tail swings out + scrub-brakes, counter-steer to hold the angle; then continue tuning
tireEllipseLong (carry-vs-bleed) + hbKineticMu (lock strength). Then Fase 2/3.**

---
**FASE 1 COAST + SMOKE FIX (throttle-release: no coast decel + persistent smoke; 13/13):** two bugs on
throttle release. **BUG 1 — frictionless coast:** physics4 had NO drag/rolling/engine-brake → at
throttle 0 the car held speed (measured 25→25.0 over 5 s, decel 0.000). FIX: **coast forces along
−velocity** — aero drag `Fdrag = dragCoef·v²` (0.8) + rolling resistance `Froll = rollResist` const
(200 N, tapered to 0 near rest so a parked car can't be pushed). Now coast decel −2.25 m/s² @25 m/s,
25→13.7 km/h... in 5 s, rolls to a full stop (8→0 in 10 s). **BUG 2 — smoke persists on release:**
DIAGNOSED — rearOmega actually TRACKS rolling (not stuck) but decayed only via the slow tyre −Fx·r, AND
`wheelSpin` (smoke) = the raw `vlong` slip-ratio which BLOWS UP in a sideways drift (vlong collapses →
κ huge → 40-81% fake burnout smoke). TWO fixes: (a) **engine braking** — a closed-throttle drag torque
`(1−throttle)·engineBrakeTorque` (500 N·m) on rearOmega → on release the wheel drops to rolling in
**0.12 s** (κ→0, driven-spin smoke stops) and below rolling it brakes the car (adds to coast); (b)
**honest wheelSpin** = the ACTUAL driven over-spin `(ω·r − car.speed)/max(speed,3)` clamped ≥0 (how much
the wheel surface outruns the ground) — **NOT** the vlong slip-ratio → a sideways drift no longer fakes
burnout smoke (measured **0%** vs 40-81% before); the drift's own smoke still comes from `isRearSliding`
(lateral slip, unchanged). Handbrake lock → wheelSpin 1 (full scrub smoke). **MEASURED 13/13:** coast
decel clearly negative + rolls to stop; engine braking pulls rearOmega to rolling in 0.12 s → burnout
wheelSpin→0 on release; drift smoke holds while actually sliding (isRearSliding + rearSlip 36°) but
burnout wheelSpin stays 0 in the slide; launch clean+deterministic, handbrake+throttle still ALWAYS
brakes, drift still carries speed, low-speed stable, determinism, **ARCADE 0.0e+0**. New D-tuner knobs:
`dragCoef` 0.8 / `rollResist` 200 / `engineBrakeTorque` 500. Additive longitudinal + wheelSpin mapping
only — lateral/yaw untouched; physics.ts untouched. tsc + build clean. **NEXT: boss phone-tests coast
(car slows when you lift) + smoke (stops on release, drift smoke only while sliding). Keep tuning
tireEllipseLong / hbKineticMu; then Fase 2 (reverse, engine curve) + Fase 3.**

---
**FASE 1 STATIONARY-HANDBRAKE SMOKE FIX (locked ≠ smoking; 8/8):** holding the handbrake on a STILL car
smoked continuously — wrong (a locked wheel at zero speed has zero contact slip → no scrub → no smoke).
CAUSE: the mapping set `wheelSpin = 1` and `rearSaturated = lockedRear` whenever the handbrake was DOWN,
regardless of motion. (The scrub FORCE was already fine — `Fx = −Dkin·vlong/slipMag` → 0 at rest.) FIX:
gate the locked-rear SMOKE + skid on the real contact slip speed — `wheelSpin = clamp((car.speed−0.6)/1.4,
0,1)` under handbrake (ramps in 0.6→2 m/s → 0 at rest), and `rearSat = lockedRear && v > 0.6` for
isRearSliding. **MEASURED 8/8:** stationary HB → wheelSpin 0%, isRearSliding never true, car sits still
(|v| 0.000); moving HB → smokes (wheelSpin 100%, sliding) = real scrub; HB+steer still enters the drift
(rearSlip 26°); HB+full throttle still ALWAYS brakes (dv/dt<0); parking with HB still; **ARCADE 0.0e+0**.
Smoke-gate only — scrub force / drift entry / brake / lateral / yaw / physics.ts untouched. tsc + build
clean. **NEXT: boss phone-tests — parked handbrake = no smoke; moving handbrake = smoke + drift as before.**

---
**FASE 1 COMPLETE — reverse + shaped accel curve + rpm-sound (no gears); smoke A re-verified; 18/18:**
**(A) stationary-handbrake smoke** — re-confirmed the slip-speed gate (`wheelSpin = clamp((car.speed−0.6)
/1.4,0,1)` under HB, `rearSat = lockedRear && v>0.6`): parked HB = 0% smoke / no skid / still; moving HB
= smoke. **(B1) REVERSE** — per-car `reversing` + `brakeHoldT`: engages ONLY after `v<0.5 && brake>0.5 &&
throttle<0.05 && !hb` held for `reverseDelay` 0.5 s (timer resets on motion / brake-release) → a normal
braking stop / wall-bump-with-brake NEVER reverses (verified: brake 0.4 s = no reverse, held 0.5 s →
reverses). In reverse the brake pedal is the reverse throttle (`brakeEff=0` so it doesn't also brake) → a
backward BODY force `brake·reverseForce`, capped at `reverseSpeed` 7 m/s; **steering mirrored**; the rear
tyre longitudinal Fx is forced 0 (free-rolls backward — else the ω≥0 clamp fought it); rest-snap +
kinematic-blend made reverse-aware. Exits on throttle>0.05 (→forward) or brake-release near rest.
Un-sticks a nosed-in car (5.5 m). **(B2) SHAPED ACCEL CURVE (no gears)** — `drive = throttle · min(peakThrust
9000, enginePower 172000/max(v,powerFloorSpeed 5))`: torque-limited flat low (punchy) → power-limited ∝1/v
high (flattening) = one smooth curve, **NO shift points / NO mid-drift jerk**. **ANALOG PROVEN**: at speed
half-throttle = **exactly 50%** of full drive (linear → feeds the drift angle). 0-50 2.7 s, 0-100 5.9 s,
top 208 km/h (power/drag limited). Launch traction limit intact (wspin 12%, no lottery). **(B3) RPM-sound**
— `rearWheelSpeed = max(|ω·r|, v)` = rear-wheel surface speed = the engine-revs proxy: rises smoothly &
monotonically with speed, spikes on wheelspin, **no gear sawtooth** (0 backward jumps measured). **MEASURED
18/18** + regressions: launch clean+deterministic, handbrake+throttle ALWAYS brakes, drift carries speed,
coast slows, low-speed stable, **ARCADE 0.0e+0**. New D-tuner knobs: `peakThrust`/`enginePower`/
`powerFloorSpeed` (replaced engineForce/engineFadeSpeed) + `reverseSpeed`/`reverseForce`/`reverseDelay`.
Additive longitudinal + reverse + mapping only — lateral/yaw + physics.ts untouched. tsc + build clean.
**FASE 1 is COMPLETE.** **NEXT: boss feel-tests Fase 1 complete on phone (X → PHYSICS4): drive (punchy
pull, no shift jerk, analog throttle), reverse (stop + hold brake 0.5s → backs up, mirrored, un-sticks),
handbrake/drift/coast/smoke, engine sound rising with speed. Then Fase 3 (gameplay: pick the winning
model, retire the toggle) or further tuning.**

---
**FASE 1 reverse SPEED-UP (crawl → brisk RWD-coupe reverse):** the reverse was too slow. Raised
`reverseForce` 6000→**10000** (~8.3 m/s² backward = quick pickup, not a crawl) + `reverseSpeed` 7→**9 m/s
(≈32 km/h)** (a real early-90s RWD coupe reverses briskly). **MEASURED:** reaches the 9 m/s cap in **1.07 s**
after engaging (final 33 km/h); GATING UNCHANGED (engages only after brake held ~0.5 s from a stop;
braked-to-stop + 0.4 s brake → still NOT reversing); steering still mirrored, still un-sticks. Both remain
D-tuner knobs. tsc + build clean. **NEXT: boss feel-tests reverse speed on phone; dial reverseForce/
reverseSpeed if wanted.**

---
**FASE 1 DRIFT-SUSTAIN fix (throttle can now HOLD a drift — the equilibrium hole closed; 14/14):**
DIAGNOSED (read-only): the drift SPUN at every throttle incl. 0 (no equilibrium). Root = (1) throttle→
wheelspin GAP — engine braking (500 N·m) + big `wheelInertia` 22 made the rear BRAKE (κ=−1) at low/mid
throttle, wheelspin (κ>0) only at ~0.5 → no smooth partial-wheelspin band; (2) no yaw stability → the
marginally-stable drift oscillated/spun. Handoff ruled out (rear stays sliding through release, no regrip
gap). **FIX (longitudinal-rear + yaw-damp only; lateral/geometry untouched):** all SMOOTH-faded on the
REAR LATERAL slip depth (`SLIDE_SLIP_LO 9°→HI 23°`, so a straight launch burnout = ~0 lateral = NOT a
slide → launch protected). **(A)** `engineBrakeSlideFade` 0.9 — engine-braking fades off as the rear
slides → low/partial throttle gives κ≈0→progressive wheelspin (opens the bottom of the sustain range).
**(B)** `wheelInertiaSlideFactor` 0.55 — effective wheel inertia drops in a slide (22→~12) → partial
throttle = proportional wheelspin = a held angle (not a sluggish step); measured SMOOTH (0 κ direction-
flips, no oscillation — the launch-inertia window respected). **(C)** `driftYawDamp` 500 — mild
slide-gated yaw-rate damping (physical: tyre relaxation resisting yaw) widens the stable hold band so the
drift SETTLES instead of spinning. **MEASURED (damp 500):** low throttle 0.3 SUSTAINS |β| ~22° (was: spin
at every throttle); more throttle OPENS it (t0.45 → deeper); excess (full throttle + little counter) SPINS
(|β| 95° — the risk); counter-steer CATCHES it back to grip (β→0, controllable/recoverable). **GUARDS all
pass:** (1) in-slide wheelspin SMOOTH (0 flips); (2) grip↔slide SMOOTH FADE (max yaw jerk 5 rad/s³, no
entry/exit step); (3) LAUNCH clean + distinguished (straight = 0° lateral slip → no fade → wspin 12%,
deterministic). Regressions: handbrake ALWAYS brakes, stationary-HB no smoke, drift carries speed, coast
slows, low-speed stable, determinism, **ARCADE 0.0e+0**. New D-tuner knobs: `engineBrakeSlideFade` /
`wheelInertiaSlideFactor` / `driftYawDamp`. **⚠️ HONEST SCOPE:** the sustain is now a controllable **skill
window** (throttle+counter-steer holds a moderate-deep drift, excess spins, catch recovers) — NOT a wide
forgiving band. Fixed-input harness WANDERS (±17°) because a drift is a driver-held equilibrium (feedback
holds it — the CATCH test proves control); on the phone the analog throttle + real-time counter-steer will
hold it. A WIDER/more-forgiving band is limited by FRONT counter-authority (the front washes post-peak at
deep β), which is LATERAL grip — the boss ring-fenced lateral/geometry, so a wider band is a possible
FOLLOW-UP on front grip, flagged not done. tsc + build clean; physics.ts untouched. **NEXT: boss
feel-tunes the sustain on the phone (X → PHYSICS4): flick/handbrake in → hold with counter-steer +
partial throttle → more throttle opens, ease closes, excess spins, counter-steer catches. Dial
driftYawDamp (stability↔depth), engineBrakeSlideFade + wheelInertiaSlideFactor (throttle response).**

---
**FASE 1 THROTTLE-RELEASE + FEED fix (release winds down not spins; throttle feeds; 10/10):** the
sustain fix (a5051e3) engine-brake fade killed TWO merged effects — it should only have killed one.
DIAGNOSED (read-only): on throttle RELEASE mid-drift the car SPUN OUT (β −42°→177°) instead of the rear
regripping (smoke = the persistent DRIFT/spin slide, not literal wheelspin — rearOmega did decay); and
throttle NEVER fed forward (accel −10.4 m/s² at throttle 0 → still −4.85 at full, never positive; κ only
0.14 at full = weak break-loose). Root: the engine-brake fade removed BOTH "engine-braking the CAR"
(good to fade in a slide) AND "the wheel spinning DOWN to rolling" (must NOT fade → without it the rear
never returns to grip). **FIX 1 (longitudinal-rear only):** a new SLIDE-GATED-OFF-NOT wheel SPIN-DOWN —
`wheelReturnRate` 10 relaxes rearOmega toward the rolling speed (`vlong/rr`) at LOW throttle (`throttleOff`
ramps it off by throttle 0.2), removing ONLY excess spin (ω > rolling, never below → can't fight the
car-brake or the drive), NOT faded in a slide → on lift κ→0 → the rear REGAINS grip → the drift WINDS
DOWN (β −30°→−7°, ω→0, was spin to 177°) + burnout smoke stops (κ 0.15, wspin 0%). **FIX 2 (falls out):**
with the mid-throttle engine-braking interference gone, rising throttle now BREAKS the rear loose (κ
−0.99→+0.54) → the friction-ellipse forward bite FEEDS the drift (accel −10.4→−4.1 m/s², clearly improves
with throttle). **HONEST (flagged + fine):** at a DEEP angle (β 40°+) the drift still nets negative accel
(a deep drift physically scrubs — the drive along heading projects weakly onto the sideways velocity);
throttle-CARRY (net-positive) works up to a MODERATE angle (β ~20-25° where cos β carries), exactly as the
boss accepted. **MECHANIC = the balance:** throttle 0 → return-to-rolling dominates (regrip/wind-down);
throttle > 0 → drive overcomes (feed/break-loose) = "fuel vs release". **MEASURED 10/10:** release winds
down + κ→rolling + smoke stops; throttle feeds (accel + κ rise); sustain still holds (|β| 34°, no spin);
launch clean+deterministic, handbrake ALWAYS brakes, stationary-HB no smoke, coast slows, low-speed
stable, **ARCADE 0.0e+0**. New D-tuner knob: `wheelReturnRate` (spin-down/wind-down rate). Longitudinal-
rear only; lateral/yaw/geometry + physics.ts untouched. tsc + build clean. **NEXT: boss feel-tests on
phone (X → PHYSICS4): drift → LIFT throttle = winds down + regrips (no spin, smoke stops); ADD throttle =
feeds/carries the drift (best at a moderate angle); partial throttle still holds. Dial wheelReturnRate
(wind-down speed) + the sustain knobs.**

---
**PHYSICS4 — GRIP FIX + 370 HP + TC REMOVED (race drift special; 13/13):** three changes.
**(1) GRIP BUG @50 km/h — DIAGNOSED + FIXED:** the car held only ~1.3g before breaking loose AND the
rear let go first (52/48 front bias → less rear grip → oversteer). Worse, the `isRearSliding` flag fired
at `demand > 0.98` — so a GRIPPED 1.27g corner (β steady 1°, holding its line) still flagged sliding →
smoke/skids showed → LOOKED like "losing grip at 50." FIXES: `muNom` 1.5→**1.75** (outer wheels hold
~1.5g → 1.0-1.3g corners GRIP; measured steer 0.4-0.7 now holds **1.5g understeer**, was 1.3g sliding);
`weightDistFront` 0.52→**0.50** (front-limited = mild understeer, rear no longer first — measured frontα
17° ≥ rearα 4°); **`isRearSliding` threshold `demand 0.98`→`1.1` + slip-angle 0.15→0.20 rad** (only flags
a GENUINE slide, not a gripped near-limit corner → the false 50 km/h smoke is gone). Provoked break-loose
kept (throttle/handbrake add longitudinal demand that eats the circle regardless). **(2) 370 HP race
special:** `enginePower` 172000→**276000** (276 kW), `peakThrust` 9000→**13000** (sharper low-end +
willing power-over). **(3) TRACTION CONTROL REMOVED** — the `tractionSpeed`/`tractionSlipCap` launch
wheelspin cap DELETED (params + omega-loop logic + 2 D-tuner rows gone). Raw power: the rears spin on
launch, power-over is raw. The big `wheelInertia` 22 keeps that launch wheelspin STABLE (measured heading
drift **0.0°** — no shoot-off, **deterministic** — no lottery, no κ shudder). **⚠️ MEASURED ACCEL
(0-50 / 0-100 / top):** BEFORE (230hp, TC) **2.70 s / 5.92 s / 210 km/h** → AFTER (370hp, no TC, new grip)
**1.85 s / 3.88 s / 248 km/h**. Launch wheelspin is a modest **19%** (the big wheelInertia caps how fast
the wheel spins up — stable, not a dramatic burnout; drop wheelInertia for more visible launch spin at the
oscillation risk). On the maps: 0-100 in 3.88 s reaches 100 km/h on a decent straight; top 248 is
high-speed-only (aspirational, not hit on the oval). **VERIFIED 13/13:** gripped corners no longer false-
smoke, front-limited understeer (rear not first), launch spins-but-stable + deterministic, power-over
willing (rearSlip 33°), accel faster, sustain/handbrake/stationary-HB/reverse/coast/low-speed all intact,
**ARCADE 0.0e+0**. tsc + build clean; physics.ts untouched. **NEXT: boss feel-tests (X → PHYSICS4): 50
km/h corner GRIPS (no early slide), launch spins the rears but tracks straight, 370hp pulls hard,
power-over willing. Dial muNom (grip), peakThrust/enginePower (power), wheelInertia (launch spin drama).**

---
**RACE-SPEC SIM RE-SPEC (the race reference / touring-car anchor; the honest per-wheel sim benchmark; 16/16):** the
physics4 car re-tuned to a realistic early-90s circuit race special (public name Blitz RS). **Numbers,
all physically consistent:** `massKg` 1200→**1020** (stripped race weight), `yawInertiaK` 1.25→**1.20**
(Iz = 1020·1.2² ≈ 1469, agile), `cgHeight` 0.5→**0.45** (lowered → less transfer → planted),
`weightDistFront` **0.50** (neutral-mild-understeer), `muNom` 1.75→**1.90** (race slicks ~1.6g),
`loadSensitivity` 0.15→**0.12** (slicks consistent under load), `tireB` 11→**14** (sharper rise, peak
~5.7°), `tireC` 1.5→**1.65** (DECISIVE slick breakaway — grips hard then lets go, not a padded road-tyre
falloff), `brakeForce` 14000→**15000** (1.34g measured), `brakeBiasFront` 0.6 (front-biased, trail
transfer), power/thrust as-is (370 hp). **WEIGHT-REGRESSION re-tune (1200→1020):** `driftYawDamp`
500→**375** (lower Iz makes it relatively stronger); wheelInertia 22 / engineBrakeTorque 500 /
wheelReturnRate 10 / hbKineticMu 0.9 verified fine at the new mass. **MEASURED:** 0-50 **1.65 s**, 0-100
**3.48 s** (was 3.88 @1200kg), top **248 km/h**, braking **1.34g** (100→0 ≈ 30 m). **70 km/h BUG =
already fixed** (d2c9fd7); now grips even firmer — peak **1.79g**, understeer, holds its line, no false
smoke. **VERIFIED 16/16:** 70 km/h grips trivially (1.79g); hard cornering grips (front-limited
understeer, rear not first); break-loose ONLY on provocation (throttle → rearSlip 27°); race brakes 1.34g
+ trail-brake shifts load FORWARD (front 3547 N > rear 1536 N = rear lightens, real transfer); **weight-
regression stack OK** — sustain HOLDS a drift with skill (throttle 0.9 breaks the high slick grip loose,
counter-steer 0.45-0.65 holds β ~33-73° — a real skill-window sim drift, NOT arcade-easy), handbrake
locks+enters+brakes, release winds down, launch stable+deterministic; accel/top reasonable; reverse/coast/
low-speed/parking intact; **ARCADE 0.0e+0**. **⚠️ HONEST (sim character, flagged):** the slick drift is a
SKILL WINDOW — it needs high throttle (drive must overcome the higher grip) + precise counter-steer to
hold; ease off and the slick regrips (correct). Trail-brake LIGHTENS the rear (real load transfer) but
oversteer-on-trail is SUBTLE at 1.9μ slick grip — the primary drift provocations are handbrake + throttle
power-over; a stronger trail-brake would want a lower `brakeBiasFront` (tuning lever). tsc + build clean;
physics.ts untouched; arcade toggle model untouched. **NEXT: boss feel-tests the race-spec SIM on phone
(X → PHYSICS4): grips hard through fast corners, race brakes, drift needs commitment (full throttle +
counter-steer = skill), decisive slick edge, 370 hp pulls. Dial muNom/tireB/tireC (grip+edge),
brakeBiasFront (trail-brake), driftYawDamp (drift stability). Then the separate forgiving ARCADE car.**

---
**RACE-SPEC SIM — brakeForce set to the APPROVED 13500 + RACE-CAR priority confirmed (16/16):** the
re-spec (7a0698b) is confirmed as the race-car benchmark (grip/precision/braking priority, drift a
secondary emergent by-product — NOT tuned toward easy drift). `brakeForce` set to the boss's approved
**13500** (was my 15000). **MEASURED RACE METRICS:** cornering **max gripped 1.77-1.79g** at 50/70/90
km/h (precise — β 1.6° through a 90 km/h corner; front-limited neutral-mild-understeer, rear never first);
break-loose ONLY on real provocation (throttle → rearSlip 27°, handbrake → 30°); **braking 1.21g,
100→0 in 33 m / 2.4 s**; trail-brake shifts load FORWARD (front 3483 > rear 1598 N); launch stable+
deterministic; **0-50 1.65 s / 0-100 3.48 s / top 248 km/h**; drift mechanics FUNCTION (throttle 0.9 +
counter-steer holds a β ~45° skill-window drift — provoked, not easy); reverse/coast/low-speed intact;
**ARCADE 0.0e+0**. **⚠️ TWO HONEST NOTES vs the boss's targets (both D-tuner knobs, boss's approved
numbers kept):** (1) `brakeForce` 13500 delivers **1.21g** — a touch under the stated ~1.35g target;
**15000 = 1.34g** if the boss wants exactly 1.35g. (2) `muNom` 1.90 holds **~1.79g** — a touch above the
~1.4-1.6g slick target; **muNom ~1.65 = ~1.55g** if the boss wants exactly 1.4-1.6g. Both are the exact
approved numbers — flagged so the boss can dial to taste on the D-tuner. tsc + build clean; physics.ts +
arcade toggle untouched. **NEXT: boss feel-tests the race-spec SIM as a RACE CAR (X → PHYSICS4): grip,
precision, braking, cornering speed first; drift secondary. Dial muNom (grip level), brakeForce (braking
g), tireB/tireC (edge), brakeBiasFront (trail-brake). Then the separate forgiving ARCADE car.**

---
**physics4 SPEED-DEPENDENT TRACTION — κ∝1/v revived (wheelInertia band-aid removed, drive ODE sub-stepped;
11/11):** the diagnosis proved the rear never broke loose (even at full throttle = 137% of rear grip, peak
κ 0.07) because `wheelInertia 22` (a launch-oscillation band-aid) stopped the wheel spinning up → the κ∝1/v
slip dynamics (B) were DORMANT, and the (A) torque curve is flat below 76 km/h → the only break-loose was
the lateral cornering circle (wrong sign, harder at speed). FIX (approach 1+2, isSimReal2-era physics4 only):
**(1)** an on-throttle `wheelInertiaDrive` **5** (real reflected inertia) replaces the base 22 for the DRIVE
spin-up → κ∝1/v is LIVE; **(2)** the stiff low-inertia drive ODE is **sub-stepped** (`wheelSubsteps` 6, ω
only, recomputing Fx(κ) through the friction ellipse each sub-step; body forces stay 60 Hz) → stable, no
oscillation. **CRITICAL ISOLATION:** the sub-step + low inertia run ONLY when `throttle>0.01 && brake≈0 &&
!reversing`; **braking / coast / engine-braking / reverse keep the ORIGINAL single-step at base
wheelInertia 22 → BYTE-IDENTICAL to HEAD** (proven 0.0e+0: BRAKE, COAST, BRAKE+STEER, REVERSE; a first
attempt that sub-stepped braking too made the rear LOCK κ→−1 + shifted braking 1.21→1.40g — caught and
isolated). **MEASURED — the fix (straight full-throttle κ): OLD 0.07/0.06/0.05/0.03 (dead) → NEW 5.72 @30 /
2.56 @50 / 0.08 @80 / 0.03 @120** = the rear now spins violently at low speed and grips at high speed (B
live). Launch STABLE (0° drift, 0 κ-flips) WITH real wheelspin (κ 1.0 — raw, TC-removed intent); wheelspin
SMOOTH in a sustained corner (0 flips, sub-step stable). **KEEP all intact:** cornering 1.79g, precision β
1.6°, braking 1.21g (byte-identical, rear ABS-ok no lock), drift sustain β~46° skill-window, handbrake
always brakes, reverse; top 248; **ARCADE byte-identical 0.0e+0**. **HONEST — 0-100 3.48→4.37 s** (the
launch now spins the rears = the real cost of raw wheelspin the boss chose by removing TC; 0-50 1.65→2.12).
New D-tuner knobs `wheelInertiaDrive` (5) / `wheelSubsteps` (6). **⚠️ MEASURED BREAK-LOOSE CURVE vs the
~104 km/h anchor (report for sign-off) — straight-line throttle-% to break loose: 30 km/h 95% · 50 km/h
100% · 80/100/120 HOLD (grips); the boss's 80 km/h + moderate-steer + 50% corner HOLDS (the original
complaint FIXED).** Two honest deviations from the literal anchor: **(a)** low-speed break-loose is at ~95%
throttle, NOT partial — partial-throttle low-speed wheelspin needs real GEARING (1st-gear torque
multiplication = the missing (A)), deliberately skipped; without gears the force balance (drive vs grip)
sets a ~95% threshold at low speed, and the κ (B) makes that spin, once triggered, violent + speed-graded.
**(b)** the traction crossover (grips above) is ~70-80 km/h, BELOW the static 104 anchor, because
full-throttle LOAD TRANSFER plants the rear (grip 4753→~6600 N/wheel), which the static anchor ignored —
physically MORE correct, just lower. So the car is grippier-at-speed than the literal anchor (the right
direction — the complaint was too-easy break-loose at speed) and spins hard at low speed on full throttle,
but does not spin at PARTIAL throttle at low speed (that's gearing). **NEXT: boss feel-tests physics4 (X)
— low-speed full throttle lights the rears, high speed grips, 80/50% corner holds + accelerates out;
launch spins then hooks up. If the boss wants partial-throttle low-speed wheelspin OR the crossover pushed
to 104, that's real GEARING (A) or a load-transfer/grip tune — flagged, not done.**

---
**physics4 REAL SELF-ALIGNING TORQUE (pneumatic trail) — the OVAL snap/limit-cycle FIXED, arcade
driftYawDamp REMOVED (13/13):** the deep audit found the model had NO self-aligning torque and was
under-damped in yaw → a **yaw LIMIT-CYCLE** on a sustained corner + throttle (the car built a β-46° slide,
recovered, rebuilt — repeatedly), masked by the slide-gated arcade `driftYawDamp` whose on/off gating
FED the cycle. That is the boss's "oval oversteer that can't be caught." FIX = real physics:
**(1) per-wheel SELF-ALIGNING TORQUE (pneumatic trail):** `Mz = -Fy·t`, trail `t = pneumaticTrail ·
clamp(1−|α|/trailPeakSlip, −0.15, 1) · loadScale` — MAX at centre, COLLAPSES to 0 (then slightly negative)
as slip passes the ~5.8° force peak (the real "steering goes light at the limit"), scales with load
(∝ contact patch). Summed into the yaw torque = an always-on restoring moment → directional stability +
progressive breakaway + natural catch. **REAR-ONLY** (the key correctness call): a real FRONT tyre's
aligning moment reacts through the STEERING system (self-centring feel), not the chassis — and here
steering is a kinematic input, so a front Mz on the chassis would be spurious understeer; the REAR has no
steering DOF so its Mz genuinely acts on the chassis. `pneumaticTrail` 0.22 / `trailPeakSlip` 0.13.
**(2) REMOVED the slide-gated `driftYawDamp` entirely** (the arcade band-aid) → replaced by a TINY
NON-gated `yawDampConst` 60 (numerical hygiene only, no on/off edge). **(3) slide-fades assessed:**
`engineBrakeSlideFade`/`wheelInertiaSlideFactor` are LONGITUDINAL drift-feel aids (smooth-ramped) — with
them off the oval wobble is unchanged (0°), so they do NOT drive the yaw cycle → KEPT.
**GRIP RESTORE:** the rear aligning adds mild understeer (grip 1.79→1.69) → `loadSensitivity` 0.12→**0.05**
(slicks are genuinely low load-sensitivity) restores it to **1.75g** WITHOUT touching muNom → the last
task's low-speed traction curve stays ALIVE. **MEASURED before→after:** OVAL sustained-corner+throttle
wobble **39/26/15° → 0°** (holds a steady β−1° line = limit-cycle GONE); lift+countersteer **catches**
β20/40/60° deep slides; directional stability β6° perturbation **decays** at throttle 0/0.5/1.0; grip
**1.75g**; **traction κ∝1/v ALIVE** (κ 5.6 @30 km/h → 0.03 @120); braking 1.22g; 0-50 2.08s top 248;
still **driftable** on provocation (hb+throttle holds a deep catchable slide); **ARCADE 0.0e+0**. New
D-tuner knobs `pneumaticTrail`/`trailPeakSlip`/`yawDampConst` (replaced `driftYawDamp`). **HONEST:** grip
1.75g (vs the 1.79 target — within 2%; `loadSensitivity` 0.04 → ~1.77, 0.03 → 1.78 if the boss wants it
exact). The self-aligning is a big real-physics change (not a param tweak) as the boss approved.
**NEXT: boss feel-tests the OVAL (X → PHYSICS4) vs Project CARS — throttle-on it should HOLD a line, and
if pushed past grip slide PROGRESSIVELY + catch on lift+countersteer (no limit-cycle wobble, no
un-catchable snap, planted not pendulum). Dial pneumaticTrail (stability↔agility) / loadSensitivity
(grip) on the D tuner.**

---
**physics4 REALISTIC RACE-SPEC rebuild (path B — root fix: directional-stability MARGIN, band-aids GONE):**
the "trail-brake does nothing + spins instead of four-wheel-sliding" investigation found the REAL root
(read-only): the car was **directionally UNSTABLE UNDER THROTTLE at 50/50** — with weightDistFront 0.50 the
neutral-steer-point sits ON the CoM, so throttle's friction-circle rear-grip loss tips it into **divergent
power-oversteer** (steer 0.2 + throttle 0.3 → 180° spin; no-throttle → stable 3°). This is what the huge
pneumaticTrail 0.22 / yawDampConst 1100 band-aids were MASKING. Ruled OUT as the cause: prev-frame accel
lag, relaxation length, longitudinal transfer, friction ellipse (all no-effect); lateral transfer ~half.
**REAL FIX = a stability margin via slight front weight bias** (textbook: neutral-steer-point BEHIND the
CoM = every real RWD car). **REALISTIC VALUES, each real-world justified:** `weightDistFront` 0.50→**0.53**
(a real race coupe ~52/48 + race setup = the stability margin), `maxSteer` 0.52→**0.56** (32° real race coupe front
lock), `tireB`/`tireC` 14/1.65→**10/1.45** (real slick BROAD peak ~11°, not a narrow 5.8° cliff → the
fronts work over a wide slip range → no premature washout at the 32° lock), `pneumaticTrail` 0.22→**0.06 m**
(REAL trail; the band-aid GONE), `trailPeakSlip`→**0.19** (collapses at the broad-slick peak), `yawDampConst`
60→**150** (SMALL, physically-legit = real suspension ROLL DAMPING a point-model omits — NOT the 1100
band-aid), `loadTransferLongGain` 1.0→**1.5** (for trail-brake), `loadSensitivity` **0.05** (oval
stability). **MEASURED (12/12 harness):** (a) **sub-limit STABLE under throttle** (the root fix — was 180°
spin, now 3°); (b) oval NO limit-cycle; (c) **FOUR-WHEEL slide** past the limit (both axles fS34/rS35,
β-30, holds heading) — not a rear-only snap; (d) **DRIVES OUT** (provoke → countersteer → recovers); (e)
inject β45 lift+countersteer catches; (f) brake→throttle CATCHABLE with a driver (β caught, not instant
spin); (g) grip **~1.85-1.97g**; (h) low-speed traction κ∝1/v ALIVE; (i) braking 1.21g; (j) top 248, 0-50
2.0s; (k) **ARCADE 0.0e+0**. The 0.22-trail / 1100-damp band-aids are REPLACED by real vehicle dynamics.
**⚠️ HONEST TENSION (reported, deep rabbit-hole per the boss's stop-clause):** **TRAIL-BRAKE is SUBTLE**
(Δβ ~−2.7°, rear becomes mobile 5→8°) at the stable config. It's a genuine 3-way coupling —
STABILITY needs high rear grip (muNom ~1.90; lower → power-oversteer), a STRONG trail-brake needs low rear
grip / high loadSensitivity, and high loadSensitivity RE-BREAKS the oval limit-cycle. A directionally-
stable (understeer-margin) race car inherently RESISTS trail-brake rotation — the subtle rotation is
realistic; the DRAMATIC past-limit rotation comes from the four-wheel slide under power (which works). A
stronger trail-brake would need an oversized transfer (LTL ~1.65) or a less-stable balance (re-introducing
the power-oversteer spin) — not shipped. Grip ~1.9g is a hair above the 1.8 slick target (coupled to the
stability-critical muNom; the LTL 1.5 inflates the reading). D-tuner: `pneumaticTrail`/`trailPeakSlip`/
`yawDampConst` + the balance knobs. **NEXT: phone feel-test sim-real (X → PHYSICS4) as a a real race coupe
vs Project CARS — planted/precise, grips, four-wheel-slides past the limit + drives out, catchable, no
uncatchable snap, no oval limit-cycle. Feel whether the subtle trail-brake is enough or if it needs the
stronger (less-stable/oversized) variant.**

---
**physics4 WHEEL-SPEED POWER LIMIT (constant full-throttle smoke FIXED — the engine revs WITH the wheel;
12/12):** the "rears smoke continuously at full throttle even at speed" symptom was **REAL over-spin**
(measured free-accel κ 5.9/6.0/6.2/5.2 @30/50/80/120 km/h; wheel surface ωr ran 5× the ground speed;
`isRearSliding` FALSE so NOT false smoke). ROOT (read-only): the drive power limit `enginePower/max(v,…)`
used the **CAR/ground speed** — when the rear spun up at launch, the engine kept delivering full power-
limited torque based on the slow car speed → the wheel ran away on the falling longitudinal tyre curve (a
bistable trap: past-peak → less force → more net torque → more slip) → continuous spin until ~130 km/h
where car-speed power finally drops. **FIX (physically correct): the ENGINE REVS WITH THE DRIVEN WHEEL** —
the power limit is set by the engine RPM, which tracks the wheel surface speed `ω·r` through the drivetrain,
NOT the ground speed. Recomputed inside the drive sub-step: `driveForce = throttle·min(peakThrust,
enginePower/max(v, ω·r, powerFloorSpeed))`. When the wheel spins (ω·r ≫ v) the engine revs into the power
taper → drive torque DROPS 84% → the spin self-limits and HOOKS UP (a real car can't hold infinite
wheelspin — power caps it). Below rolling (ω·r ≤ v) it equals the car-speed value → launch/low-speed
wheelspin unchanged. **PAIRED: `tireBx` 18→12** (longitudinal peak κ 0.08→0.12, a realistic slick — broader
→ the spin→grip hook-up is a gentler surge, not a jerk). **MEASURED before→after (free full-throttle
accel):** κ **5.9/6.0/6.2/5.2 (spin forever) → 4.2/2.1/0.18/0.04** @20/40/80/120 km/h; wheelSpin/smoke
**100% everywhere → 100/100/14/4%** (lights up low, hooks up by ~90 km/h); **PERFECTION CHECKS:** (1)
spin→grip SMOOTH — κ decays as a gradient, hook-up jerk **5.11→3.51 m/s²** (a mild realistic surge as the
rears hook up, not a lurch; tireBx 12 broadened the peak); (2) **NO runaway window** — partial throttle
(0.3/0.5/0.7) AND in a corner (steer 0.3) across 30-120 km/h, ZERO high-speed κ>3 traps; (3) **speed-
dependent break-loose INTACT** — κ still decays 30:2.98→120:0.04 (easy spin slow, hooks up fast). **KEEP:**
launch spin preserved (κ 4.6), four-wheel slide (fS30/rS31), drives out, handbrake drift (β-75), grip
1.97g, sub-limit stable, braking 1.21g, top 246, **0-100 3.37s (FASTER — drives instead of smoking, was
4.05)**, ARCADE 0.0e+0. **HONEST:** the hook-up jerk is REDUCED (5.11→3.51) not zero — a broader tyre
(tireBx 10) flattens it to 2.93 but softens the launch spin (κ 3.9); tireBx 12 keeps a strong launch spin
(κ 4.6) with a mild surge = the realistic balance (a real car does surge slightly when the rears hook up).
D-tuner: `tireBx`. **NEXT: phone feel-test (X → PHYSICS4) — full throttle: rears light up from low speed
then HOOK UP and drive at speed (no continuous smoke), smooth surge (no hard jerk) as they catch, still
spins easy at low speed, four-wheel slide + drift + grip unchanged.**

---
**physics4 SLICK HOOK-UP (wheelInertiaDrive 5→8 — brief chirp then BITE, no more 2.65s launch spin;
11/11):** the "rears smoke like crazy / spin out on corner exit" was REAL low-speed over-spin lasting
**2.65 s** from a standstill (measured; real slick chirp = 0.3-0.7 s) — a worn-tyre/dragster behaviour,
wrong for the race reference RACE SLICKS which hook up almost instantly. ROOT (read-only): `wheelInertiaDrive`
5 (lowered earlier for the low-speed κ∝1/v spin) let the wheel spin up so eagerly it ran away past the
tyre peak (bistable trap) and took 2.65 s to hook up; the slow-corner-exit shares that low-speed regime →
the sustained smoke + occasional spin-out. Sharp bistable threshold measured: iw 6 → 2.60 s (runaway) /
iw 7-8 → 0.08 s (hooks up). FIX = **`wheelInertiaDrive` 5→8** (above the runaway threshold, the cleaner/
sharper bite). **MEASURED before→after:** launch chirp **2.65 s (κ 4.6) → 0.07 s (κ 0.3)** = a brief 370hp
chirp then BITE; slow corner-exit(20 km/h) hooks up 0.07 s, NO spin-out (β 6); **0-100 3.37→3.03 s
(FASTER — drives instead of spinning)**; four-wheel slide fS30/rS30 preserved; drives out, handbrake drift
β-75, grip 1.97g, sub-limit stable, braking 1.21g, top 246, **ARCADE 0.0e+0**. **INTENTIONAL:** the
low-speed κ∝1/v spin built earlier is reduced to a brief chirp — CORRECT for slicks (slick ≠ worn road
tyre; a brief 370hp chirp is realistic, sustained low-speed smoke is not). The speed-dependent traction
still decays with speed (just hooks up much faster). D-tuner `wheelInertiaDrive`. **NEXT: phone feel-test
(X → PHYSICS4) — slicks hook up and CATAPULT out of corners: brief chirp off the line then bite, corner
exit with the wheel near-straight + throttle → hooks up and fires out (no continuous smoke, no spin-out),
still huge traction; four-wheel slide / drift / handbrake unchanged.**

---
**physics4 FRICTION-CIRCLE fix (corner-exit spin-out cured — the rear keeps its lateral grip; 12/12):**
the boss's "rears spin MORE on a fast-oval exit + it spins the car out" was diagnosed (read-only) as NOT
longitudinal wheelspin — on a fast-corner exit + full throttle the rear **κ stays LOW (~0.10)**, but the
rear **LATERAL slip blows to 80° → power-oversteer SPIN-OUT (β 96-143°)**. ROOT (the combined-slip
friction circle): at full throttle @80 km/h the rear drive force is **6210 N/wheel = 139% of the rear grip
D** — with the too-round ellipse (`tireEllipseLong` 1.0) that longitudinal demand ALONE crushes the ellipse
→ **rear lateral grip → 0%** → the rear loses all cornering grip → oversteer spin-out. The boss's chain was
right; the mechanism is the circle crushing the lateral, not wheelspin. FIX = **`tireEllipseLong` 1.0→1.3**
(the REAL slick value — μ_long ≈ 1.3× μ_lat; the ellipse is elongated longitudinally so throttle doesn't
crush the lateral). **MEASURED before→after (80 km/h, steer 0.3, FULL throttle exit):** no-countersteer
spin **β128 (uncatchable) → β48 (a catchable slide)**; WITH countersteer **β31 → β0 CAUGHT**; rear lateral
slip on exit **blew to 80° → stays 6° (the rear KEEPS its grip)**. **KEEP:** progressive exit (throttle
0.6) GRIPS (β3) and catapults out; standstill launch unchanged (chirp 0.07s, no spinout); four-wheel slide
(throttle) **fS17/rS15 preserved** (1.3 keeps it stronger than 1.5's fS12/rS10); handbrake drift β-64
(locked rear, ellipse-independent); past-limit drives out; trail-brake rotates (Δβ-7.6); grip 1.97g;
sub-limit stable; braking 1.25g; 0-100 3.03s, top 246; **ARCADE 0.0e+0**. **ONE fix cured both** the
corner-exit "smoke" (the lateral slide, not wheelspin) and the spin-out — same root (the lateral collapse).
Slick-realistic: grips out of normal corners, oversteers only when you overdrive the throttle at the limit,
and it's CATCHABLE when it does. **NEXT: phone feel-test fast asphalt-oval exits (X → PHYSICS4) — progressive
throttle catapults out gripped, full throttle at the limit slides but catches on countersteer + lift (no
uncatchable spin), standstill launch + four-wheel slide + handbrake unchanged.**

---
**CIRCUIT MAP — CAR SIZE FIX (follow camera; car now pixel-identical to the oval; render-only,
physics 0.0e+0):** the circuit rendered the car ~11 px vs ~19 px on the oval — a BUG (car size is a
CONSTANT, never scaled to fit a track). ROOT: the circuit's `fixedWorld` (462×221 m) is bigger than the
screen, and desktop.ts SCALE-TO-FITS a fixed world into the viewport → the whole scene (car included)
shrank by `min(W/3466, H/1659) ≈ 0.554`. The oval doesn't shrink because its `fixedWorld` (`FLAT_LOGICAL`
= `window.screen / pxPerMeter`) equals the screen → viewScale ≈ 1. FIX = a **FOLLOW CAMERA** for
big-world maps (NEW `MapDefinition.followCam?: boolean`, set on `circuitMap`): (1) render at the OVAL's
scale `viewScale = min(W/screen.width, H/screen.height)` (car = STANDARD size at any resolution — same
reference the oval uses), NOT scale-to-fit; (2) `updateCamera()` (called per-frame in `render()`) sets
`viewOffX/Y` to keep the lead car (`primaryCar()`) centred, clamped to the world edges — all downstream
render + `screenToWorld` already read `viewOffX/Y`, so nothing else changed; (3) the offscreen layers
back the FULL world (3466×1659 px) so the pre-rendered track + persistent skids scroll under the camera,
with a `layerDprEff = min(dpr, 4096/maxDim)` cap so a layer never exceeds the ~4096 px canvas/texture
limit (would blank on some GPUs) — the blit scales the backing store to CSS px regardless, so only the
pre-render sharpness is capped; the car/HUD keep full dpr (main canvas). **The car is NOT scaled; the
WORLD is bigger than one screen and the camera follows it.** Track width stays 2/3 of the oval band (the
shape/geometry from the sketch is unchanged). **MEASURED (formula, 1920×1080 fullscreen):** oval car
**19.24 px**; circuit BEFORE **10.66 px** (viewScale 0.554) → circuit AFTER **19.24 px** (viewScale 1.000)
= **pixel-identical to the oval**; layer backing 4096 px wide (≤ limit). **Non-follow-cam maps
(oval/desktop) UNCHANGED** — `followCam` false → the scale-to-fit branch + `layerDprEff = dpr` are the
exact old code (byte-identical). **physics.ts UNTOUCHED** → `step()` 0.0e+0 (render-only change; only
desktop.ts + maps.ts). tsc + build clean. **⚠️ RENDER UNVERIFIABLE HEADLESS (no Supabase/browser) —
phone/desktop test: on the Circuit the car is the SAME size as on the oval, the camera follows it as it
drives, the track scrolls, no shrunk car.** **KNOWN (flagged, not this task):** the editor (E) on a
follow-cam world can only reach the centred region (no camera pan while editing) — deferred with the
other circuit follow-ups (kerbs / start-finish / grass-grip).

---
**CIRCUIT MAP — NEW SHAPE (boss's editor export) + FITS ONE SCREEN (oval-style, no camera scroll):**
the boss redesigned the circuit in the track editor (17 control points, viewBox 1760×780, band 124) so it
FITS one screen at 2/3-oval width, and sent the coords. Rebuilt `circuitMap` (maps.ts only): new
`CIRCUIT_SKETCH` (17 pts) + `CS_BAND 124`. **KEY CHANGE — the world is now SCREEN-SIZED** (`CIRCUIT_LOGICAL
= FLAT_LOGICAL`, not the old sketch-sized 462×221 m), because the shape was designed to fit: it renders
exactly like the oval (uniform scale-to-fit ⇒ **car = STANDARD size, whole track visible, grass fills the
screen, NO camera scroll**). `followCam` DROPPED from the circuit (the prior follow-cam infra in desktop.ts
stays for a future too-big track). The sketch is mapped at the FIXED 2/3-oval scale (`CS_SCALE =
CIRCUIT_TRACK_W / CS_BAND`, `CIRCUIT_TRACK_W = oval bandW × 2/3`) — NEVER scale-to-fit (that would change
the track width) — and CENTRED on the world via the sketch bbox centre (`circuitToWorld(sx,sy)`, shared by
`drawCircuitSurface` + `spawn`). **MEASURED (formula):** oval band 41.28 m → track **27.52 m (2/3)** =
206 px in-game; track extent **246.8×140.3 m** fits the **256×144 m** world (grass margin 4.6 m sides /
1.9 m top-bottom — tight by design, the boss squeezed it to fill the screen); spawn on the bottom straight
`circuitToWorld(1000,625)` = (113.4, 125.5) m, heading 0 (+x = the racing direction, sketch
747→1016→1377). Style unchanged (asphalt-on-grass, oval `SURFACE_STYLES.asphalt` + worn line, no barriers/
collision). **physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **⚠️ RENDER
UNVERIFIABLE HEADLESS — phone/desktop test: the new shape is centred, fills the screen, car is the SAME
size as the oval, whole track visible without scrolling. NOTE: it fits on a ≥1920×1080 host; on a bigger
monitor the track keeps its metre size (more grass around) — car stays standard.** KNOWN (deferred): kerbs
/ start-finish line / grass-grip still to come.

---
**CIRCUIT MAP — GEOMETRY POLISH (smooth corners via centripetal spline + horizontal finish straight):**
two shape fixes from the boss's annotated screenshot (couldn't fetch it here — the shared folder isn't
reachable in this environment — so both were done from the geometry itself). **(1) KINKY CORNERS →
CLEAN ARCS:** the corners were irregular/kinked because `traceCircuit` used a UNIFORM Catmull-Rom spline
(tangent `(c−a)/6`), which OVERSHOOTS through unevenly-spaced control points (a long segment beside a
short one). Replaced with **CENTRIPETAL Catmull-Rom** (Barry–Goldman non-uniform → Bézier, knot spacing =
chord-length^0.5): each tangent is chord-weighted by its neighbours, so curvature stays even and there are
NO cusps/kinks — clean regular racing-line arcs — WITHOUT moving a single control point (layout identical).
Applies to all three strokes (edge/asphalt/line). MEASURED: worst control-arm/segment ratio **0.36** (no
overshoot). This smooths EVERY corner including the yellow-marked ones. **(2) FINISH STRAIGHT → HORIZONTAL:**
the bottom-straight points were at different y (612/632/610 = a sag/tilt). Levelled to a single **y=620**
across FOUR collinear points (`[747,620],[980,620],[1180,620]` + the `[1377,620]` corner) → the tangents at
the inner two are **exactly horizontal (y=0, measured)** → a truly HORIZONTAL, dead-straight finish segment;
kept at ~the same distance from the bottom (levelled to the mean, ±~2 m). Spawn moved to the flat middle
(`circuitToWorld(1080,620)`), heading 0. Pixel render (canvas harness) confirmed the straight's lower edge
is constant y across x = horizontal. Track now 18 pts; bbox 976×484, extent **246.8×137.6 m** still fits the
256×144 world (grass 4.6/3.2 m). Style/width/no-barriers/one-screen all unchanged. **physics.ts UNTOUCHED**
→ `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **⚠️ phone/desktop test: corners are smooth even arcs
(no jagged bends), the bottom finish straight is level + straight; whole track on one screen, car standard
size.** (If a specific yellow corner still reads off, tell me which — I smoothed globally, blind to the marks.)

---
**CIRCUIT MAP — GLOBAL RESAMPLE-SMOOTH (replaces the per-corner spline; whole ribbon evenly rounded, no
sharp edge anywhere):** the previous centripetal-spline pass only RELOCATED kinks (per-node tangent tweaks
can't remove them). Redone as a global resample+smooth pipeline, computed ONCE at load (`CIRCUIT_PATH`,
1000 pts): (1) `sampleSpline` — dense centripetal Catmull-Rom through the 18 layout nodes (48/seg); (2)
`resampleClosed` — arc-length UNIFORM resample to 1000 evenly-spaced pts (no bunching); (3) `smoothClosed`
— circular box-blur (radius 14, 2 passes) low-passes the whole loop so curvature can't spike at any node;
(4) `resampleClosed` again to stay even. `drawCircuitSurface` now strokes this dense polyline via
`tracePolyline` (moveTo+lineTo ×1000 + round joins = perfectly smooth ribbon); `traceCircuit` removed.
**MEASURED (pipeline output):** max turn-angle **1.78°/pt** everywhere (was a 74° cusp) → NO sharp edge
anywhere; min radius of curvature **93 sketch-u > band/2 (62)** → the wide 2/3-oval band fits with no
inner-edge pinch; segments even (2.8–10 u). **FINISH LINE — horizontal, kink-free:** `CIRCUIT_FINISH`
finds the nearest-to-bottom point (max y) and TAPERED-blends the contiguous near-bottom run to a single y —
FLAT (weight 1) in the centre = a perfectly LEVEL, straight finish segment (~17 m, measured y-spread
**0.0**), smootherstep taper → weight 0 at both ends = ZERO-slope joins into the corners so NO junction cusp
(a hard flatten cusped at 74°; the taper keeps max turn at 1.78°). Spawn sits on that flat run, heading +x.
Centre from the SMOOTH path bbox; extent **247.0×136.6 m** still fits the 256×144 world. Style/width/no-
barriers/one-screen/standard-car all unchanged. **physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only).
tsc + build clean. **⚠️ browser screenshots hang in this env (renderer), so verified NUMERICALLY on the
pipeline output (turn/pt < 2° everywhere = provably no sharp edges) — phone/desktop check: the whole track
is one smoothly-rounded ribbon, the bottom finish is level + straight, whole track on one screen.** Tunable
if wanted: smoothing radius/passes (rounder vs tighter), taper fraction (finish-straight length).

---
**CIRCUIT MAP — FINISH-STRAIGHT BULGE FIXED (clamp-the-overshoot, not taper):** the phone render showed the
bottom finish straight bulging OUTWARD (downward). ROOT (measured the y-profile): the centripetal spline
OVERSHOOTS below the straight entering/leaving the corners — the control straight sits at y=620 but the
smoothed centreline dips to **y≈630 at x≈820 (left) and ≈627 at x≈1300 (right)**, while the middle stays at
620 → an asymmetric downward bulge. The previous tapered-blend flattened to `fy=maxY` (the 630 DIP) over a
short centre → it PUSHED the straight down to the dip (made it worse). FIX (in the `CIRCUIT_PATH` build,
after the resample+smooth): **(1) CLAMP** every bottom point that dips below the straight line up onto it
(`y > CIRCUIT_STRAIGHT_Y=620 && near-bottom → y=620`) → the whole bottom is flat AND nothing sits below the
line (corners rise UP from it, no outward bulge); **(2) light global re-smooth** (`smoothClosed r4 ×3`)
rounds the clamp junctions into the corners — and since averaging values that are all ≤ the line can NEVER
produce one below it, it cannot re-create a bulge; **(3) re-clamp** so the middle stays dead-flat after the
smooth lifts the junctions up into the corners. `CIRCUIT_FINISH` = the centre of the exactly-620 flat run.
**MEASURED (pipeline output, the shipped algorithm):** the finish straight is **120 m DEAD FLAT** (188 pts
at exactly y=620, x 792→1331 ≈ corner-to-corner), **max turn 1.93°/pt** everywhere (no kink at the
junctions — the earlier hard-flatten cusped 34–74° here; the clamp+resmooth is what keeps it smooth),
**min radius 83 u > band/2 (62)** (no pinch), and **0 points below the line** (bulge GONE, vs the ~9 u dip
the taper left). Rest of the ribbon unchanged/smooth; extent 246.9×134.2 m still fits 256×144. Style/width/
no-barriers/one-screen/standard-car all unchanged. **physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-
only). tsc + build clean. **⚠️ browser screenshots hang in this env — verified NUMERICALLY on the exact
pipeline output (whole bottom y=620 constant, nothing below it, turn <2°/pt): the finish straight is dead
straight + level with no bulge. Phone/desktop check the bottom straight is flat corner-to-corner.**

---
**CIRCUIT MAP — APEX KERBS (red/white striped curbs on the inside of the corners):** added real-circuit-
style red/white striped apex kerbs along the INSIDE (concave) edge of the corners, following the smooth
1000-pt ribbon. Visual-only + drivable this pass (the surface has no collision; no bump/grip effect yet).
Built once at load (`CIRCUIT_KERBS`, in maps.ts): (1) per-point "cornerness" = the smoothed |turn|/pt of
CIRCUIT_PATH; (2) contiguous arcs above `KERB_TURN_TH` 0.5°/pt and ≥ `KERB_MIN_PTS` 30 pts = the corners
(straights excluded); (3) along each, a striped band on the CONCAVE inner edge — unit normal ⟂ to the
tangent, oriented toward the chord midpoint (always the apex side, auto-flips through the esses), placed at
the asphalt inner edge (`CS_BAND/2`) reaching `KERB_WIDTH` (0.11·band ≈ 3 m) onto the track, width
smootherstep-TAPERED to a point at each end; (4) alternating red/white by arc-length bucket
(`KERB_STRIPE` 14 u ≈ 3 m) — each quad is a perpendicular slice so the stripes are clean + follow the
curve. Drawn in `drawCircuitSurface` ON TOP of the asphalt (after the racing line), sketch→px like
everything else (scale-agnostic). **RESULT: 5 corners kerbed** — the top-right hump (~1372,141), the middle
apex (~979,464), the top-left hump (~591,243), and the two finish-straight corners (bottom-left ~729,608,
bottom-right ~1477,551); 709 striped quads. Colours `#c9382f` red / `#e8e8ee` white. **VERIFIED** (canvas
pixel harness, since browser screenshots hang in this env): kerbs render as red AND white pixels sitting on
the asphalt at the corners (1633 red / 1191 white px, balanced), and scans across the corners show
ALTERNATING stripes (`RWWWRWRWRWWWRW` etc.) — not solid blocks. Finish straight / smooth ribbon / style /
grass / no-barriers / one-screen / standard car all unchanged. **physics.ts UNTOUCHED** → `step()` 0.0e+0
(maps.ts-only; kerbs are drivable — no collision added). tsc + build clean. **⚠️ phone/desktop check: the
corners have red/white striped kerbs on their inner edge, following the curve, drivable.** Tunable:
`KERB_TURN_TH`/`KERB_MIN_PTS` (which corners), `KERB_WIDTH`/`KERB_STRIPE` (size/stripe). Kerb grip/bump =
a later pass.

---
**CIRCUIT MAP — KERB TRANSITIONS + LENGTHS (gradual ease in/out + shorten the over-long ones):** per the
boss's annotated screenshot (RED = make transitions gradual, BLACK lines = cut the over-long kerbs). Two
changes to the `CIRCUIT_KERBS` builder (maps.ts): **(1) LONG GRADUAL TAPER** — the width now ramps 0→full
over `KERB_TAPER_FRAC` 0.42 of the kerb length at EACH end (smootherstep), replacing the old fixed 10-pt
taper → every kerb eases IN and OUT as a long wedge (measured width 0.00 → 13.6 → 0.00, so no abrupt
start/end edge anywhere). **(2) TRIM TO THE APEX CORE** — each detected corner (turn ≥ 0.5°/pt, ≥30 pts)
is trimmed to the contiguous CORE around its peak-cornerness point where cornerness ≥ `KERB_TRIM_TH` 0.68
(bridging small dips) → the gentle LEGS of the big sweepers are dropped, shortening the over-long kerbs to
hug the apex, while genuinely tight corners stay long. **MEASURED (builder output):** RIGHT hump 212→**72**
pt (46 m), LEFT hump 211→**121** pt (78 m), bottom-RIGHT 108→**25** pt (16 m) — all shortened (the three
BLACK-line kerbs); MIDDLE apex stays **137** pt (88 m, tight throughout, unmarked); bottom-LEFT **22** pt
(short corner). Each kerb keeps a full-width core (5–35 pt) with long tapered ramps (9–58 pt/side). Concave
inner-edge placement, red/white striping, on-asphalt, drivable, no-collision all unchanged. **physics.ts
UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **⚠️ browser screenshots hang in this env
— verified NUMERICALLY on the exact builder output (width 0 at both ends = gradual; hump/entry lengths cut;
middle kept). Phone/desktop check: kerbs ease in and out smoothly (wedge, no pop-on/off) and the humps +
bottom-right are shorter.** Tunable: `KERB_TAPER_FRAC` (ramp length), `KERB_TRIM_TH` (how much leg is cut).

---
**CIRCUIT MAP — KERBS MOVED TO THE OUTER EDGE (grass side, as a track EXTENSION) + lengths restored:**
three fixes per the boss's red-outlined screenshot. **(1) REVERTED the blanket shortening** — removed the
`KERB_TRIM_TH` core-trim; kerbs are full corner length again. **(2) MOVED inner→OUTER edge** — the kerb
normal is now the globally-OUTWARD normal (⟂ tangent, away from the loop interior), not the concave/inner
one, and it extends OUTWARD: the striped band sits at the asphalt OUTER edge (`CS_BAND/2`) and reaches
`KERB_WIDTH` (≈3 m) into the GRASS — an EXTENSION of the track, so the **full asphalt width is untouched**
(no longer eats drivable surface). Outward sign is calibrated once (at the bottom-most point, "out of loop"
= +y). **(3) COVERAGE for the red outer perimeter** — lowered `KERB_TURN_TH` 0.5→0.4 so the corners merge
into **3 continuous kerbs**: the whole LEFT outer sweep (top-left hump → far-left → bottom-left), the whole
RIGHT outer sweep (bottom-right → far-right → top-right) — these trace the boss's red left+right perimeter
— plus the MIDDLE dip (kept, existing). Gradual `KERB_TAPER_FRAC` 0.42 ease-in/out preserved. **VERIFIED**
(canvas pixel harness): horizontal scans show `grass → RED kerb → asphalt` on the far-left and `asphalt →
WHITE kerb → grass` on the right = kerb on the OUTER/grass edge with the asphalt intact INSIDE it; 3
regions, 771 striped quads, balanced red/white. Drivable (run wide onto the kerb; no collision/grip this
pass). **physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **HONEST NOTE:** the
dead-straight FINISH bottom is left UNKERBED (a straight — real circuits don't kerb mid-straight, and the
finish was just cleaned up); if the boss wants the straight's outer edge kerbed too, it's an easy add.
**⚠️ browser screenshots hang in this env — verified via the pixel harness. Phone/desktop check: red/white
kerbs on the OUTER grass edge of the left+right sweeps, extending outward, asphalt full width, drivable.**
Tunable: `KERB_TURN_TH` (how much perimeter), `KERB_WIDTH` (reach into grass), `KERB_TAPER_FRAC` (ramp).

---
**CIRCUIT MAP — KERBS BACK TO ORIGINAL (apex) + WIDEN (extend into grass, don't eat asphalt):** the boss
wanted the ORIGINAL kerbs restored, but as a track WIDENING instead of a narrowing. Reverted the builder to
the original a375a6f version EXACTLY — CONCAVE (inner/apex) normal (toward the chord midpoint), `KERB_TURN_TH`
0.5, full corner length (no trim), fixed `KERB_END_TAPER` 10-pt ease-in/out → the original **5 apex kerbs**
(right hump, middle, left hump, bottom-left, bottom-right). The ONE change vs the original: the offset
direction — the kerb sits at the asphalt inner edge (`CS_BAND/2`) and extends **OUTWARD by `w` into the
infield GRASS** (`CS_BAND/2 + w`) instead of inward into the asphalt (`CS_BAND/2 − w`). So the striped kerb
ADDS surface at the apex (widens the track) rather than eating drivable asphalt (which narrowed it). **The
full asphalt width is untouched.** **VERIFIED** (canvas pixel harness): a vertical scan through the left-
hump apex reads `grass → asphalt(hump, intact) → RED → WHITE → grass(infield)` — the asphalt is full width,
the kerb is the red/white strip added at the inner edge INTO the infield grass; 5 regions, 709 striped
quads. Drivable (run onto the widened kerb). **physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc
+ build clean. **⚠️ browser screenshots hang in this env — verified via the pixel harness. Phone/desktop
check: the original 5 apex kerbs are back, now extending INTO the grass (widening the apex), asphalt full
width, drivable.** Tunable: `KERB_WIDTH` (how far it widens), `KERB_END_TAPER` (ramp), `KERB_TURN_TH` (which
corners).

---
**CIRCUIT MAP — KERB BLUE BORDER (F1-style red/white + blue outer strip):** per the boss's reference photo
(red/white kerb with a solid BLUE border on the grass side). Added a second, solid-blue quad strip beyond
the red/white on each kerb: per point the kerb now has THREE offsets — asphalt inner edge (`CS_BAND/2`) →
red/white outer (`+KERB_WIDTH·taper`) → blue outer (`+KERB_BLUE_WIDTH·taper`), all on the concave/apex
normal, extending into the infield GRASS (still a track WIDENING, asphalt untouched). The blue
(`KERB_BLUE` #2f6fca, `KERB_BLUE_WIDTH` 0.045·band ≈ 1.2 m) is a CONTINUOUS solid border (not striped) and
tapers with the kerb (fades to a point at each end with the red/white). `KerbQuad` now carries a `fill`
string (red/white by arc bucket, or blue). **VERIFIED** (pixel harness): a scan across the left-hump kerb
reads `grass → asphalt(intact) → RED → WHITE → BLUE → grass(infield)` = red/white kerb with the blue border
on the outer grass edge, matching the photo; 5 apex kerbs, 1418 quads, red/white/blue all present.
**physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **⚠️ browser screenshots hang
— verified via pixel harness. Phone/desktop check: kerbs look like the reference (red/white + blue trim).**
Tunable: `KERB_BLUE_WIDTH` / `KERB_BLUE`.

---
**CIRCUIT MAP — KERB TAPER MOVED TO THE BLUE (red/white constant width):** the boss wanted the red/white
kerb graphically as-is but at CONSTANT full width, with the gradual ease-in/out on the BLUE border instead
of on the stripes. One-line change in the builder: `w` (red/white radial width) = `KERB_WIDTH` constant
(no per-point taper → full-width stripes with crisp, defined ends), while `bw` (blue width) =
`KERB_BLUE_WIDTH · taper` — so the BLUE fades from full in the middle to 0 at each end (the gradual
transition now lives entirely on the blue). Everything else identical to the blue-border build (concave/
apex placement, extends OUTWARD into the infield grass = widening, asphalt untouched, 5 apex kerbs,
red/white striped by arc bucket, blue #2f6fca solid). **physics.ts UNTOUCHED** → `step()` 0.0e+0
(maps.ts-only). tsc + build clean. **⚠️ browser screenshots hang — phone/desktop check: red/white kerb is
full width along its length (crisp ends), the blue border eases in/out.** Tunable: `KERB_BLUE_WIDTH`.

---
**CIRCUIT MAP — KERB CONSTANT-SIZE STRIPES (arc measured on the kerb, not centreline) + blue-side
confirmed:** **(2) CONSTANT STRIPE SIZE (the fix):** the stripe bucket used `arc[k]` = cumulative
CENTRELINE distance; but the stripes sit on the concave kerb, whose inside-of-corner radius is much shorter
than the centreline — so a fixed centreline-arc stripe COMPRESSED on tight corners (measured kerb-edge arc
= 0.61× centreline on the tight middle vs 0.72× on the gentle right → different block sizes per corner).
FIX: bucket by the KERB-EDGE arc (accumulate `hypot(edge[k]−edge[k−1])`, the band/2 offset curve) so every
block is a constant PHYSICAL size regardless of corner sharpness; `KERB_STRIPE` 14→10 (≈2.2 m). MEASURED
(pixel harness): block size now RIGHT 2.22 / MID 2.23 / LEFT 2.22 / botL 2.18 / botR 2.23 m — equal
everywhere (was ~0.61–0.72× varying). The tapered end leaves a clean partial block (floor bucket). **(1)
BLUE ON THE GRASS SIDE:** already correct in the build and re-CONFIRMED (pixel scans read `asphalt →
red/white → BLUE → grass`) — the blue is the OUTERMOST strip (concave normal, deepest into the infield
grass), between the kerb and the grass, never between asphalt and kerb. No change needed; if the boss's
screenshot showed otherwise it was a stale/cached build (close tab + rescan). Everything else unchanged
(outer/grass-edge extension = widening, asphalt intact, gradual blue taper, 5 apex kerbs, drivable).
**physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **⚠️ browser screenshots
hang — verified via pixel harness. Phone/desktop check: blocks are the same size on every corner; blue
strip sits on the grass edge.** Tunable: `KERB_STRIPE` (block size).

---
**CIRCUIT MAP — SHORTEN TWO KERBS (boss's orange marks):** the boss scribbled ORANGE over the part of two
kerbs to remove. Mapped each orange blob to a path fraction (region screen-position vs the orange image-
fraction) and added a `KERB_CUTS` step in the builder that trims a fraction off the region END nearest a
reference point: **(a) LEFT hairpin** — `near [626,526]`, removeFrac **0.40** → the region 211→127 pts,
dropping the descending-LEFT leg (new end ~(570,299), the far-left before it descends); **(b) LOWER-RIGHT
corner** — `near [1547,415]`, removeFrac **0.30** → 108→76 pts, dropping the UPPER part (new end
~(1516,501), part-way up from the bottom-right). Matched by endpoint proximity (<55 u), so ONLY these two
regions are touched; the other three (right hump, middle dip, bottom-left) are byte-unchanged. The new
(shortened) ends get the existing taper automatically (blue eases out, red/white crisp — same as every
other kerb end). **VERIFIED** (pixel-box scan): the removed areas now have **0** kerb pixels (LEFT
descending-leg 0, RIGHT upper 0) while the kept parts still render (LEFT hairpin-top 1176, RIGHT
lower-corner 674 kerb px). Blue grass-side strip + constant arc-length stripes continue correctly to the
new tapered ends. **physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **⚠️
browser screenshots hang — verified via pixel scan. Phone/desktop check: the left hairpin + lower-right
kerbs are shorter (orange parts gone), tapered ends.** Tunable: the two `removeFrac` values in `KERB_CUTS`.

---
**CIRCUIT MAP — EXTEND TWO KERBS along the finish straight (boss's blue marks):** the boss scribbled BLUE
where two kerbs should be LENGTHENED. Added a `KERB_EXTENDS` step (mirror of the cuts): grow the region END
nearest a ref point by `addPts`, extending it along the bottom straight — **(a) BOTTOM-LEFT** `near
[780,620]`, +**24** pts → new end ~(849,620) (extends RIGHT into the straight); **(b) BOTTOM-RIGHT** `near
[1345,620]`, +**30** pts (extends the START LEFT) → new start ~(1259,620). Extends map from the blue image
positions. **KEY FIX for straight extensions:** the per-point concave normal used a chord-midpoint test
that's DEGENERATE on a straight (midpoint ≈ point → the kerb would flip to the wrong side). Replaced it
with a per-region `turnSign` (sign of the summed signed curvature) → `normal = turnSign·(−ty, tx)`, which
keeps the kerb on the corner's apex side ALL along, including the straight extension. Proven **100%
identical** to the chord test at every existing corner (208/208, 141/141, 207/207, 34/34, 104/104
agreement) so no other kerb changes; robust where the chord test fails. New ends taper out via the existing
blue taper. **VERIFIED** (pixel harness): the straight extensions render `grass → BLUE → red/white →
asphalt` (kerb on the infield side, blue on the grass edge, R/W stripes continue), full kerb present at the
extension midpoints (botL R632/W306/B372, botR R582/W357/B399), clear beyond the new ends. Only these two
kerbs changed; the other three + the two prior cuts unchanged. **physics.ts UNTOUCHED** → `step()` 0.0e+0
(maps.ts-only). tsc + build clean. **⚠️ browser screenshots hang — verified via pixel harness. Phone/
desktop check: the bottom-left + lower-right kerbs now extend along the straight, tapered ends.** Tunable:
the two `addPts` in `KERB_EXTENDS`.

---
**CIRCUIT MAP — OUTER-PERIMETER KERB RUN (boss's blue: the whole lower/outer loop):** added ONE continuous
kerb along the entire outer edge the boss marked — far-left → down the left sweep → the long bottom straight
→ up the right sweep → far-right. Built as a separate pass appended to `CIRCUIT_KERBS`: find the far-LEFT
(min-x, idx~665 ≈ (564,359)), far-RIGHT (max-x, idx~119 ≈ (1553,349)) and bottom-most points; the run is the
arc between far-left and far-right that PASSES the bottom-most point (the lower/outer loop, length ~455 pts,
not the top). Placed on the OUTWARD normal `oSign·(−ty, tx)` (away from the loop interior — the OPPOSITE
side to the apex kerbs — no chord-degeneracy on the straight), extending into the OUTFIELD grass; SAME
styling — red/white constant-arc stripes + solid BLUE border on the grass side + `KERB_END_TAPER` tapered
ends. Blends with the existing apex kerbs by being on the opposite edge (no overlap) with tapered ends where
it approaches the left-hairpin / right-hump kerbs at the far-left/far-right. **VERIFIED** (pixel harness):
the bottom straight reads `asph → red/white → BLUE → grass` continuously across its length (x800→1320); the
left + right outfield sweeps are full kerb (left R412/W396/B327, right R483/W365/B350); the existing kerbs
(e.g. middle dip R591/W418/B439) + the two cuts + two extends are all still present/unchanged. **physics.ts
UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **⚠️ browser screenshots hang — verified
via pixel harness. Phone/desktop check: a continuous red/white+blue kerb rings the whole outer perimeter
(left sweep, bottom straight, right sweep), blue on the grass edge, tapered ends, existing kerbs intact.**

---
**CIRCUIT MAP — BLUE-ONLY sections on the outer run (boss's blue: strip the stripes, keep the blue):** the
boss marked the BOTTOM of the outer-perimeter run to lose its red/white stripes but keep the blue strip.
Added a `KERB_BLUE_ONLY` zone (fraction of the outer run) inside the outer-run loop: a per-point
`stripeFactor` = 1 (full stripes) outside the zone, 0 (blue-only) inside `[start 0.15, end 0.85]` — i.e.
the bottom-left corner + the whole bottom straight + the bottom-right corner — with smootherstep `ramp`
(0.05) fades at each boundary. The red/white stripe width `w = KERB_WIDTH · stripeFactor` (fades to 0 in
the zone → stripes vanish); the BLUE strip is unchanged (`mid = band/2 + w`, so as the stripes fade the
blue simply shifts in to sit right at the asphalt edge → `asphalt → blue → grass`), staying CONTINUOUS the
whole way. The left/right SWEEPS (fraction 0–0.15, 0.85–1.0) keep the full striped kerb. ONLY the outer run
is touched — the corner apex kerbs (+ cuts/extends) are unchanged (the blue-only logic lives only in the
outer-run loop). **VERIFIED** (pixel harness, perpendicular scans along the run): left sweep f0.08 `asph →
R → BLUE → grass` + right sweep f0.92 `asph → W → BLUE → grass` (full kerb); bottom f0.25/f0.50/f0.75 all
`asph → BLUE → grass` (blue-only, no stripes); blue present in every sample (continuous). **physics.ts
UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. **⚠️ browser screenshots hang — verified
via pixel harness. Phone/desktop check: the bottom of the outer ring is blue-only, the left/right sweeps
keep red/white, stripes fade in/out smoothly, blue continuous.** Tunable: `KERB_BLUE_ONLY.start/end/ramp`.

---
**CIRCUIT MAP — BLUE-ONLY WIDTH FIX (blue fills the full strip+kerb width, grass stays put):** the blue-
only sections rendered a THIN blue strip then grass — the grass had moved inward into the vacated kerb
space. ROOT: the outer (grass) edge was `out = o(w + bw)`, and `w = KERB_WIDTH·stripeFactor` → in the
blue-only zone `w→0` so `out→band/2+bw` (grass edge pulled in). FIX (one term, outer-run only): fix the
outer edge at the FULL width `out = o(KERB_WIDTH + bw)` regardless of the stripe fade. Now red/white =
edge→mid (`band/2 → band/2+w`) and blue = mid→out (`band/2+w → band/2+KERB_WIDTH+bw`): as the stripes fade
(`w→0`) the BLUE expands to fill the whole space out to the SAME grass edge (`band/2+KERB_WIDTH+bw`), which
never moves. Full-kerb sections are unchanged (there `w=KERB_WIDTH` so `w+bw == KERB_WIDTH+bw`); the corner
apex kerbs untouched (their `w` is already constant `KERB_WIDTH`). **VERIFIED** (pixel harness,
perpendicular scans): BLUE-ONLY straight `asph → BLUE → grass` with blue spanning offset **62→80** (asphalt
edge → grass edge); FULL-KERB sweep `asph → R → BLUE → grass` spanning **63→81** — the grass edge matches
(~80–81) so no grass encroaches; the blue-only fill = the full strip+kerb width. Tapered transitions
between striped and blue-only intact. **physics.ts UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc +
build clean. **⚠️ browser screenshots hang — verified via pixel harness. Phone/desktop check: the blue-only
bottom is now a FULL-width blue band out to the same grass edge as the striped kerbs, no grass gap.**

---
**CIRCUIT MAP — KERB STRIPE ENDS = HARD CUT (only the blue tapers):** the boss flagged (yellow marks) that
in the `KERB_BLUE_ONLY` zone the red/white stripes FADED OUT gradually (the smootherstep `stripeFactor`
width ramp) — wrong. Rule now: red/white stripes END WITH A HARD CUT (last block full-size, then stop dead,
like the crisp apex-kerb ends); ONLY the blue eases. Rebuilt the outer-run rendering: (1) snap the blue-
only zone's arc boundaries to the KERB-STRIPE grid (`cutStart`/`cutEnd = round(arc/KERB_STRIPE)·KERB_STRIPE`
→ whole blocks, no sliver); (2) per-QUAD BINARY choice `stripe = arc[k] < cutStart || arc[k] >= cutEnd`
(replaces the smootherstep `sf`); (3) red/white drawn as FULL-WIDTH blocks only where `stripe` (no per-point
width taper); (4) the BLUE inner edge STEPS hard between `midFull` (after stripes) and `edge` (asphalt edge,
full-width blue) — the outer/grass edge stays fixed at `KERB_WIDTH + bw`. Removed `KERB_BLUE_ONLY.ramp`.
The apex/corner kerbs were already crisp (the reference) — untouched. **VERIFIED** (pixel harness):
along-run scan at the outer red/white radial reads full R/W blocks then abruptly BLUE (`…RRWW|BBBB…`, cut
over ~one segment, no gradual thin); perpendicular scans one segment apart = `asph→W→blue→grass` (full kerb)
→ `asph→blue→grass` (full-width blue); blue continuous both sides, grass edge unmoved. **physics.ts
UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean.

---
**CIRCUIT MAP — BLUE TAIL past every stripe end (unified `emitKerb`):** the boss wanted the blue to NOT
stop with the red/white stripes but CONTINUE past the stripe end as a tapering tail that flows onto the
asphalt and dissolves (green target he drew on the right hairpin; red X = the old "blue stops dead"). Both
kerb passes (apex corners + the outer-perimeter run) were UNIFIED into one `emitKerb(sStart, sEnd, normFn,
blueOnly?)`. Mechanism: red/white blocks over the STRIPE range `[sStart, sEnd]` with the existing HARD CUT
(snapped to whole blocks); the BLUE runs over `[sStart−TAIL_PTS, sEnd+TAIL_PTS]` where TAIL_PTS = round(
`KERB_BLUE_TAIL` 25 / avg-seg) ≈ 9 — inner edge = the stripe outer edge where stripes exist, else the
asphalt edge (fills in); OUTER edge = the FIXED grass edge (`FULL_W = KERB_WIDTH + KERB_BLUE_WIDTH`) scaled
by a smootherstep taper `tf` that is 1 across the stripe range and → 0 over the TAIL past each end. So past
the hard cut the blue slides to the asphalt edge at full width, then its width dissolves to 0 over the tail.
Replaced `KERB_END_TAPER` with `KERB_BLUE_TAIL`. **VERIFIED** (pixel harness, perpendicular scans along the
right-hump kerb's trailing end, arc-offset from the stripe end): −5 `asph→R→BLUE→grass` (thin blue in the
kerb); +3 `asph→BLUE→grass` bluePx 18 (full-width blue on the asphalt edge, stripes gone); +10 bluePx 7
(tapering); +18/+26 `asph→grass` bluePx 0 (dissolved). Blue-only zone still continuous full-width. Applies
GLOBALLY (all apex kerbs incl. the cut/extended ends + the outer-run ends, one helper). **physics.ts
UNTOUCHED** → `step()` 0.0e+0 (maps.ts-only). tsc + build clean. Tunable: `KERB_BLUE_TAIL`.

---
**CIRCUIT MAP — BLUE TAILS LONGER + GENTLER (no blob):** the blue tails worked but read as a short abrupt
BLOB (they ballooned to FULL kerb width at the stripe cut, then tapered over a short ~2.5-block tail). Boss
wants a noticeably LONGER tail that starts at the blue's NORMAL slim width and thins out very gradually
along the asphalt edge. Two changes (maps.ts `emitKerb` only): (1) `KERB_BLUE_TAIL` 25→**70** (~7 stripe
blocks, 2.8×); (2) the tail no longer fills to full width — a per-point `blueEdges(k)`: in the kerb BODY it's
the width-fix blue (thin outside stripes / full in a blue-only sub-range, out to the fixed grass edge); in
the TAIL past a stripe end it hugs the asphalt edge (inner 0) at the blue's NORMAL slim width KERB_BLUE_WIDTH
and only NARROWS to 0 via `KERB_BLUE_WIDTH·(1−smoother(t²))` — the `t²` bias keeps it near-full for the first
part of the tail then fades late. The WIDTH is continuous across the cut (slim→slim), so there is no bulge
and no width jump; only the POSITION slides in to the asphalt edge (the intended "slides onto the asphalt").
**VERIFIED** (pixel harness, trailing tail of the right-hump kerb, geometric blue width vs arc-offset from
the stripe cut): 0→5.58, 5→5.58, 10→5.58, 15→5.57, 20→5.55, 25→5.46, 30→5.25, 35→4.79, 40→4.44, 45→3.43,
50→2.09, 55→1.40, 60→0.30, 65→0.05, 70→0 = starts at exactly KERB_BLUE_WIDTH (5.58, the slim width — NOT the
old full 13.6 blob), monotonically narrowing to 0 over the full 70u tail, stays near-full for the first ~15u
then fades. Pixel scans: hard stripe cut → slim blue on the asphalt edge (6→4→1 px) → gone. Applies globally
(all apex + outer-run kerb ends, one `emitKerb`). **physics.ts UNTOUCHED** → `step()` 0.0e+0. tsc + build
clean. Tunable: `KERB_BLUE_TAIL`.

---
**CIRCUIT MAP — BLUE TAIL = WEDGE (full band at the cut → steady taper to 0):** the boss corrected the tail
shape: it must START at the FULL kerb+blue band (not the slim width) and WEDGE down. Rewrote `blueEdges`'s
tail branch (maps.ts `emitKerb` only): past a stripe end the blue INNER edge is pinned to the asphalt edge
(0) the whole way, and the OUTER (grass-side) edge = `FULL_W · (1 − t)` (t = dist/`KERB_BLUE_TAIL`, LINEAR —
no plateau) → right at the hard cut the blue fills the ENTIRE vacated band (asphalt edge → the SAME grass
edge as the striped kerb, = band/2 + KERB_WIDTH + bw, consistent with the blue-only zone), then the grass-
side edge tapers STEADILY inward to nothing = a clean wedge. `KERB_BLUE_TAIL` 70→**35** (~3.5 stripe blocks;
clamp keeps a tail off its neighbours). The kerb BODY (thin blue border beside the stripes / full width in a
blue-only sub-range) is unchanged; only the past-stripe tail differs. Removed the now-unused local `smoother`.
**VERIFIED** (pixel harness, trailing tail of the right-hump kerb): geometric blue width at the cut **17.64**
(inner 0, outer to the grass edge = full band) → monotonic **16.4, 15.14, 12.55, 11.22, 9.87, 8.48, 7.08,
4.17, 2.67, 1.14, 0** over the 35u tail (inner pinned to the asphalt edge throughout); perpendicular pixel
scans: thin border beside stripes → hard cut → FULL-band blue (17 px, asphalt→grass) → wedging in (12→9→4
px) → 0. Applies globally (all apex + outer-run kerb ends; blue-only-zone boundaries read as stripes-cut →
the zone's already-full-width blue continues, naturally consistent). **physics.ts UNTOUCHED** → `step()`
0.0e+0. tsc + build clean. Tunable: `KERB_BLUE_TAIL`.

---
**CIRCUIT MAP — KERB SEAM FIX + SOFT EDGES (boss close-up: grass sliver at the stripe↔blue seam + razor
edges):** two render-only polish fixes (maps.ts only; geometry/lengths/cuts/tails/colours unchanged).
**(1) GAP FIX** — the close-up showed a thin GRASS sliver between the red/white band and the blue band (a
canvas AA hairline where two separately-filled quads share an edge, worse through curves where per-point
normals round differently). Fix = OVERLAP + back-to-front draw: `KERB_SEAM` 0.8 sketch-u (≈1 render px); the
BLUE inner edge is pulled KERB_SEAM UNDER its neighbour (KERB_WIDTH−SEAM under the stripes, −SEAM under the
asphalt rim in the tail/blue-only), the STRIPE inner edge is pulled −SEAM under the asphalt rim, and quads
carry a `z` (0 blue, 1 stripes) + `quads.sort((a,b)=>a.z−b.z)` so ALL blue draws first (underneath) and the
stripes/asphalt paint over the overlap → no seam can show. **(2) SOFT EDGES** — each kerb quad is now FILLED
*and* lightly STROKED in its own colour (`softPx = max(0.8, twPx·0.02)` ≈1 px, round joins/caps already set)
→ subtly rounded/feathered edges (not knife-edged, still crisp) everywhere (apex kerbs, outer run, blue-only,
tails); the stroke also overlaps neighbours = extra seam insurance. **VERIFIED** (pixel harness, perpendicular
scans): STRAIGHT (bottom-extended kerb, meanY 607) + CURVE (right-hump apex, meanY 220) every scan reads
`asph → R/W → BLUE → grass`; **seam-gap count = 0 across 48 scans** (no grass sandwiched between the stripe
and blue on straights OR curves). **physics.ts UNTOUCHED** → `step()` 0.0e+0. tsc + build clean. Tunable:
`KERB_SEAM` (overlap), the `softPx` factor (edge feather).

---
**CIRCUIT MAP — UNIFORM BLUE WEDGE at every kerb end (was fat-stub-vs-slim variation):** the boss circled
the middle-dip end as THE reference and flagged that the other kerb-end wedges looked different (fat stubs
vs slim). ROOT CAUSE (found + fixed): the blue tail buffer was `[sStart−TAIL_PTS, sEnd+TAIL_PTS]` = a FIXED
POINT COUNT, but the wedge tapers over `KERB_BLUE_TAIL` of EDGE-ARC — and edge-arc COMPRESSES on the concave
side of a curve (up to ~4× on the tightest apex), so the fixed count covered far less arc there → the wedge
was TRUNCATED into a fat stub; on straights/convex it fully tapered → slim. FIX (maps.ts `emitKerb` only):
replaced the fixed `TAIL_PTS` with a per-side WALK — `tailPts(from, dir)` steps outward along the LOCAL edge
(band/2 offset via `edgeAt`, per-point normals) accumulating edge-arc until it reaches `KERB_BLUE_TAIL`
(bounded by `TAIL_PTS_CAP`) → `leftPts`/`rightPts` differ per end so the VISIBLE wedge is exactly
KERB_BLUE_TAIL edge-arc with the identical taper profile at EVERY termination (both ends of every apex kerb
incl. cut/extended ends, the outer-run ends, and consistent across the blue-only-zone boundaries), following
the local track-edge direction on straights, curves, and the outer run. The wedge formula (full band at the
hard cut → linear taper to 0, inner on the asphalt edge) is unchanged; stripes/hard-cuts/blue-only body/
asphalt/grass all unchanged. Neighbour clamp: the arc-length tail self-limits to ~KERB_BLUE_TAIL and
`TAIL_PTS_CAP` bounds the walk — no tail reaches another kerb here (apex concave vs outer convex are on
opposite edges; same-side ends face long straights). **VERIFIED** (pixel harness, width-vs-edge-arc profile
at all 12 kerb ends — curved meanY 296–367, straight meanY 620, outer-run): every end starts at ~FULL_W
(18.5–20.0, full band asphalt→grass) and tapers monotonically to ~0 by ~32–35 arc-u; **max deviation from
the mean profile = 1.05 sketch-u (~1.8 px)** = uniform within a couple px (was fat-stub-vs-slim). **physics.ts
UNTOUCHED** → `step()` 0.0e+0. tsc + build clean. Tunable: `KERB_BLUE_TAIL` (the one wedge length).

---
**CIRCUIT MAP — REMOVED THE PROTRUDING TIP ON THE BLUE WEDGES (boss close-up: a blue spike past the wedge
end):** every wedge ended with a small blue tip sticking out past the kerb silhouette. TWO causes, both
fixed (maps.ts only): **(1) geometry residual** — the tail's inner edge stayed at `−KERB_SEAM` while the
outer reached 0, leaving a ~0.8-wide blue nub at the tip. Fix: BOTH tail edges now scale by the same `w =
1 − min(1, dist/KERB_BLUE_TAIL)` → `[−KERB_SEAM·w, FULL_W·w]`, so the wedge (incl. the −SEAM overlap)
converges to a single POINT exactly ON the asphalt edge — width EXACTLY 0, no residual, no overshoot.
**(2) the soft-edge STROKE** — `softPx = max(0.8, twPx·0.02)` is ~4 px at game scale, and its round join on
the near-zero-width tail-tip quads spiked a blue speck past the geometry (and thickened the tail's outer
edge outward). Fix: `KerbQuad.soft` flag — the feather stroke is applied ONLY to the FULL-WIDTH blue body +
the stripe blocks (`soft: inBody(k) || inBody(k+1)` for blue, `true` for stripes); the tapering tail is
FILL-ONLY, so nothing strokes past its converging point. Arc-length tail uniformity (previous pass) intact;
stripes/hard-cuts/blue-only body/asphalt/grass unchanged. **VERIFIED** (pixel harness at GAME scale,
rendering the real fill+conditional-stroke, all 12 kerb ends): **0 blue pixels beyond any tail tip** (scans
of path points past the buffer end) and **0 tail scans with blue outside the kerb silhouette** (blue never
exceeds the grass edge FULL_W=19.2 anywhere along a tail). **physics.ts UNTOUCHED** → `step()` 0.0e+0. tsc
+ build clean.

---
**CIRCUIT MAP — BLUE WEDGE IS NOW A SMOOTH TANGENTIAL CURVE (was an angular facet/kink at the cut):** the
previous LINEAR taper `w = 1 − dist/KERB_BLUE_TAIL` made the outer edge leave the flat blue body (offset
FULL_W, slope 0) at a constant slope −FULL_W/TAIL → a SLOPE DISCONTINUITY = a visible ~29° KINK at the
stripe cut (the wedge read as a separate straight-edged triangle). FIX (maps.ts `blueEdges` tail, one line):
`w = 1 − smootherstep(min(1, dist/KERB_BLUE_TAIL))` (smootherstep `t³(t(6t−15)+10)`, whose derivative is 0
at BOTH ends). Now the outer edge leaves the band's grass edge TANGENTIALLY at the cut (w′=0 → zero kink,
one continuous curve, same offset FULL_W at the shared joint point) and eases FLUSH onto the asphalt edge
(w′=0, w=0 at the end → width exactly 0, the no-protruding-tip fix preserved). Both edges still scale by w
(converge to a point); per-point density unchanged (as smooth as the kerb band); stripes/hard-cut/blue-only
body/arc-length uniformity/soft-stroke-flag all unchanged. **VERIFIED** (pixel harness, outer-edge world
polyline turn-angle across the joint): LINEAR had a single **29.05° spike** at the cut (ambient ~0.8°);
SMOOTHERSTEP replaces it with a **gradual ramp, max 9.97°** distributed over ~8 vertices (0.84→6.35→9.89→
9.97→7.82→5.05→2.47→…) — no sharp corner, no facet; width profile smooth + monotonic to exactly 0 (near-full
tangential start 20.0→19.6→18.9 vs linear's steep 20.0→17.4→16.0). **physics.ts UNTOUCHED** → `step()`
0.0e+0. tsc + build clean.

---
**CIRCUIT MAP — WEDGE = EXACT SPEC + I ACTUALLY SAW THE RENDER (built a PNG-export "eyes" harness):** the
boss re-sent the reference (`public/ster it blue.png`, green circle = target) with EXACT math and the
(correct) point that I had never SEEN my own render (browser screenshots hang; pixel scans can't tell a
faceted triangle from a smooth wedge). Fixed the blind spot: since the offscreen CANVAS renders fine (only
the screenshot action hangs), the harness now does `canvas.toDataURL('image/png')` → the base64 is written
to a PNG on disk → I open it with the image Read tool. Rendered the full circuit (same draw code) + 5×-zoom
crops of 4 wedge ends and LOOKED at them against the reference. **They match**: each wedge is stripes-hard-
cut → blue starting at the full band width → a SMOOTH curved ease-out down to a point on the asphalt edge
(no facet, no kink, no protruding tip). Aligned maps.ts to the EXACT spec (was `[-KERB_SEAM·w, FULL_W·w]`):
tail inner edge EXACTLY on the asphalt edge (offset 0) the whole length; `width(s) = FULL_W ·
smootherstep(1 − s/L)`, outer = asphalt edge + width(s). (The outer edge is algebraically identical to the
prior smootherstep commit — `FULL_W·smootherstep(1−s/L) = FULL_W·(1−smootherstep(s/L))` — so the verified
no-kink [k18: single 29° facet → gradual ≤10° ramp] and no-tip [k17] results carry over; only the inner
edge moved from −SEAM·w to 0 per the spec.) FULL_W = KERB_WIDTH + KERB_BLUE_WIDTH → the cut width = the kerb
band's width (tangential, one continuous shape); width ≤ FULL_W always (inside the silhouette); width 0 at
s=L (flush, no tip). Arc-length uniformity / hard cut / blue-only body / neighbour clamp all unchanged.
**physics.ts UNTOUCHED** → `step()` 0.0e+0. tsc + build clean. (Reusable PNG-export harness kept in the
session scratchpad as `k19.html`.)

---
**CIRCUIT MAP — REVERTED the kerb blue wedge to the PRE-TIP-FIX state (boss's decision, the protruding
"ocásky" back):** the boss chose to roll the kerb blue back to when the wedge ends still had the small
protruding tips. The tip-removal fix was commit **77308d1** ("remove protruding tip on blue wedges"); the
commit immediately BEFORE it is **a274563** ("uniform blue wedge at every kerb end — arc-length tail").
Restored via `git checkout a274563 -- src/maps.ts` (NOT hand-edited — exact from history). AUDITED first:
the ENTIRE a274563→HEAD maps.ts diff is 100% kerb-wedge code (the `KerbQuad.soft` flag, the tail
`blueEdges` smootherstep/exact-spec rewrite, the conditional soft-stroke) — NO unrelated change to
re-apply. So the restore loses nothing else. Result: the tail is back to the LINEAR taper
`[-KERB_SEAM, FULL_W·(1−t)]` (inner pinned at −KERB_SEAM → the ~0.8-wide protruding tip nub) with the
arc-length-uniform tails + seam fix + soft-stroke-on-all-quads (b6601f8) intact; the smootherstep
tangential curve (750b29d), the tip removal (77308d1), and the exact-math rewrite (2314937) are all undone.
**VERIFIED:** working tree `git diff a274563 -- src/maps.ts` = EMPTY (byte-identical to a274563).
**physics.ts UNTOUCHED** → `step()` 0.0e+0. tsc + build clean. (The pre-tip state also has the smooth
ribbon / kerbs / cuts / extends / outer run / blue-only zone — only the wedge-END tip behaviour reverted.)

---
**CIRCUIT MAP — WEDGE TIPS TRIMMED + ROUNDED (boss's black mark; ONE tunable):** the reverted wedge ran out
to a long needle tip; now every wedge ENDS EARLY and is closed with a rounded nose. **THE ONE KNOB:
`KERB_TIP_CLIP` = 0.40** = a fraction of `KERB_BLUE_WIDTH` — the wedge is clipped where its outer reach from
the asphalt edge falls to `KERB_TIP_CLIP · KERB_BLUE_WIDTH` (**W_CLIP = 2.23 sketch-u**, ≈0.5 m). HIGHER =
trims more / blunter nose · LOWER = longer, finer tip (0 = no trim). Because the taper is linear
(`outer(dist) = FULL_W·(1 − dist/L)`), the clip sits at a CONSTANT arc past every hard cut —
**DIST_CLIP = 30.94 of KERB_BLUE_TAIL 35 → the last 4.06 arc-u (11.6 % of the tail) is removed** — so all
12 ends are trimmed identically (canonical, like the arc-length tail itself). Implementation (maps.ts only,
in `emitKerb`): quads wholly inside the clip are emitted BYTE-IDENTICALLY; the segment straddling the clip
emits a part-quad to an INTERPOLATED clip cross-section (lerped path point + renormalised normal, so the
clip lands exactly at W_CLIP, not at a quad boundary); quads beyond it are skipped (the old needle);
`emitCap` then closes it with a **half-disc** across the end cross-section (`−KERB_SEAM → +W_CLIP`),
bulging along the outward path direction, swept θ 0→π from the outer edge round to the asphalt edge as a
12-segment triangle fan (`CAP_SEGS`) → a smooth convex nose, no sharp corner, no straight chop.
**VERIFIED BY EYE** (the k19/k20 PNG-export harness — canvas → toDataURL → PNG on disk → opened it):
rendered the circuit + 7×-zoom crops of 4 wedge ends (curved apex ends AND the bottom-straight end) —
every one ends in a clean rounded nose, needle gone, taper before the clip unchanged. Stripes / hard cuts /
full width at the cut / blue-only zone / arc-length uniformity / seam fix / soft stroke all untouched.
**physics.ts UNTOUCHED** → `step()` 0.0e+0. tsc + build clean.

---
**CIRCUIT MAP — DARK RIM REMOVED + SOFT ASPHALT→GRASS EDGE (the track no longer reads as "drawn"):** the
cosmetic dark rim under the ribbon (the `'#1d1f24'` stroke at `twPx + max(3, twPx·0.06)`) is DELETED — the
tarmac now sits DIRECTLY on the grass, no outline. To stop that becoming a razor "scissors" cut, the edge is
FEATHERED: **two slightly-wider, low-alpha asphalt passes** (the same tarmac gradient) are stroked UNDER the
solid surface, ramping the tarmac into the grass. **TUNE BY THESE NUMBERS:** `CIRCUIT_EDGE_FEATHER` **0.012**
(reach PER SIDE = twPx × this, clamped by `CIRCUIT_FEATHER_MIN_PX` **1** / `CIRCUIT_FEATHER_MAX_PX` **3** →
**≈2.5 px at game scale**, twPx≈206), `CIRCUIT_FEATHER_ALPHA_OUT` **0.15** (outermost pass, lineWidth
`twPx + 2·feather` → reaches feather past the edge) and `CIRCUIT_FEATHER_ALPHA_IN` **0.30** (lineWidth
`twPx + feather` → reaches feather/2, overlaps the outer pass). Net ramp beyond the asphalt edge ≈ **40 % →
15 % → 0 over ~2.5 px** — soft + organic, NOT a glow/halo, NOT a re-drawn outline. `globalAlpha` is restored
to 1 before the solid surface/racing line/kerbs. **SEAMS RE-CHECKED after the rim removal** (the kerbs were
tucked under the old rim via the `KERB_SEAM` inner overlap): perpendicular pixel scans across EVERY stripe
quad's inner edge — **CURVE 504 quads → 0 slivers (`asph|R|BLUE|grass`)**, **STRAIGHT (finish-straight
kerbs) 67 quads → 0 slivers (`asph|W|BLUE|grass`)**; the KERB_SEAM overlap still covers the join, no rim
needed. The feather shows no band under the kerbs either (kerbs draw after and reach FULL_W ≈ 32 px out,
far past the ~2.5 px feather). **VERIFIED BY EYE** (PNG-export harness, 13× crops of kerb-free edge): the
dark line is gone and the asphalt blends softly into the grass. **CIRCUIT ONLY** — the ovals
(`drawStadiumSurface`) are untouched; `grep '1d1f24'` now returns nothing in maps.ts (the rim was its only
use). **physics.ts UNTOUCHED** → `step()` 0.0e+0. tsc + build clean.
