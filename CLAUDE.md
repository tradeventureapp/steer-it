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
  Trademark-safe: internal wording is generic "drift-build reference" only — NO BMW/E30/325i
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
  **p19b (BMW-feel, post-feel-test, AWAITING re-test):** the feel-test kept ONLY
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
steer0.4+gas0.5 breaks to β53° (vs arcade β1° grippy), yaw 1.19 = still corners (real-E30 slides willingly,
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
