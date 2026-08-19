-- =============================================================================
--  STEER IT — auth + entitlement + leaderboard schema.
--
--  Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query → paste
--  → Run). It is idempotent (safe to re-run). It creates:
--    • profiles   — one row per auth user, holds the is_premium entitlement flag.
--    • devices    — the 5-device rolling cap per account.
--    • scores     — the leaderboard, writable ONLY by premium accounts (RLS).
--  plus the RLS policies + triggers that make the paywall server-authoritative:
--  a user CANNOT self-grant premium or write a score from the console.
--
--  The entitlement is flipped to TRUE only by the SERVICE ROLE (a future Stripe
--  webhook / an admin), never by the client — that is the whole point of the RLS.
-- =============================================================================

-- ---- PROFILES: the entitlement lives here -----------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  is_premium  boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user may READ their own profile (to learn is_premium). Nothing else.
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);

-- NOTE: there is deliberately NO insert/update policy for the anon/authenticated
-- role. Rows are created by the trigger below (security definer), and is_premium
-- is flipped only by the service role (payment webhook). So the client can never
-- grant itself premium — the paywall is server-authoritative.

-- Auto-create a profile row when a user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- DEVICES: rolling 5-device cap per account ------------------------------
create table if not exists public.devices (
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_id     text not null,
  user_agent    text,
  last_seen_at  timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table public.devices enable row level security;

-- A user may see + drop their OWN devices (e.g. a "sign out other devices" UI).
drop policy if exists "devices: read own" on public.devices;
create policy "devices: read own" on public.devices
  for select using (auth.uid() = user_id);
drop policy if exists "devices: delete own" on public.devices;
create policy "devices: delete own" on public.devices
  for delete using (auth.uid() = user_id);

-- Register THIS device for the caller and enforce the cap: the current device is
-- always kept (its last_seen is bumped to now), and only the 5 most-recently-seen
-- devices survive — a 6th active device rolls the oldest off. Returns the caller's
-- live device count (after pruning). SECURITY DEFINER so it can prune rows the
-- RLS delete policy also allows, atomically.
create or replace function public.register_device(p_device_id text, p_user_agent text)
returns integer language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n integer;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  insert into public.devices (user_id, device_id, user_agent, last_seen_at)
    values (uid, p_device_id, p_user_agent, now())
    on conflict (user_id, device_id)
      do update set last_seen_at = now(), user_agent = excluded.user_agent;
  -- keep only the 5 most-recently-seen devices for this user
  delete from public.devices d
   where d.user_id = uid
     and d.device_id not in (
       select device_id from public.devices
        where user_id = uid order by last_seen_at desc limit 5);
  select count(*) into n from public.devices where user_id = uid;
  return n;
end; $$;

-- ---- SCORES: the leaderboard, premium-write only (server-side gate) ----------
create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  map_id      text not null,
  mode        text not null,
  score       integer not null check (score >= 0),
  created_at  timestamptz not null default now()
);

alter table public.scores enable row level security;

-- Anyone (even logged out) may READ the leaderboard.
drop policy if exists "scores: public read" on public.scores;
create policy "scores: public read" on public.scores for select using (true);

-- A score may be INSERTED only by its owner AND only if that owner is PREMIUM.
-- This is the concrete server-side paywall: a non-premium (or forged) client
-- cannot write to the leaderboard no matter what the UI is hacked to do.
drop policy if exists "scores: premium insert own" on public.scores;
create policy "scores: premium insert own" on public.scores
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_premium)
  );

-- =============================================================================
--  NICKNAME (display name) — used in-game + on the leaderboard. Safe to re-run.
--
--  ALL rules are enforced in the DATABASE, not just the UI:
--   • 3–20 chars, [A-Za-z0-9_-] only ......... CHECK constraint
--   • UNIQUE, case-insensitive ............... unique index on lower(nickname)
--   • basic profanity filter ................. nickname_reason() (server-side)
--   • change only once / 30 days ............. set_nickname() reads/writes
--                                              last_nickname_change atomically
--  There is NO update RLS policy for nickname, so a client can NEVER write it
--  directly: it is set by the signup trigger and changed only through the
--  SECURITY DEFINER set_nickname() RPC — so uniqueness + the cooldown hold even
--  against a hacked client or a race between two signups.
-- =============================================================================

alter table public.profiles add column if not exists nickname text;
alter table public.profiles add column if not exists last_nickname_change timestamptz;

-- Format: 3–20 letters / digits / underscore / hyphen. NULL = "not set yet"
-- (existing rows, or a signup that somehow omitted it).
alter table public.profiles drop constraint if exists profiles_nickname_format;
alter table public.profiles add constraint profiles_nickname_format
  check (nickname is null or nickname ~ '^[A-Za-z0-9_-]{3,20}$');

-- Case-insensitive uniqueness. NULLs are distinct, so many rows may stay unset;
-- this index is the RACE-PROOF guard — two signups can't both take "Viking".
create unique index if not exists profiles_nickname_lower_key
  on public.profiles (lower(nickname));

-- Shared validation (trigger + both RPCs). Returns an error CODE
-- ('format' | 'profane') or NULL when clean. Separators are stripped so
-- "f-u-c-k" can't slip through; the list is deliberately small + root-based
-- ("reasonable, not overzealous") — edit the alternation to tune it.
create or replace function public.nickname_reason(p_nick text)
returns text language plpgsql immutable set search_path = public as $$
declare bare text;
begin
  if p_nick is null or p_nick !~ '^[A-Za-z0-9_-]{3,20}$' then return 'format'; end if;
  bare := lower(regexp_replace(p_nick, '[_-]', '', 'g'));
  if bare ~ '(fuck|shit|cunt|bitch|bastard|pussy|nigger|nigga|faggot|whore|rapist|molester|hitler|retard|asshole|arsehole|dumbass|jackass|pedophile|dildo|wanker|bollock|jizz|kkk)'
    then return 'profane';
  end if;
  return null;
end; $$;

-- MARKETING EMAIL CONSENT (GDPR opt-in) — captured on the post-signup nickname prompt.
-- UNCHECKED by default; the *_at timestamp records WHEN consent was given (GDPR requires it),
-- null when not consented. Optional + not tied to any reward. Written ONLY server-side (the
-- signup trigger for the email/password path, set_marketing_consent() for the OAuth path) —
-- the client can't write profiles directly (no update grant). Consented users are queryable
-- for a future (lawful) send: `select email, nickname from public.profiles where marketing_opt_in`.
-- (A later "email preferences" UI will add a separate marketing_opt_out_at rather than
-- overwriting marketing_opt_in_at, so both consent + withdrawal records are kept.)
alter table public.profiles add column if not exists marketing_opt_in boolean not null default false;
alter table public.profiles add column if not exists marketing_opt_in_at timestamptz;

-- Recreate the signup trigger so it also claims the nickname AND the marketing opt-in (both
-- from the signup metadata). nickname_reason + the CHECK + the unique index all apply on INSERT,
-- so a profane/invalid/taken nickname makes the whole signup fail (rolls back the auth user) —
-- the client pre-checks, so this is the race/abuse backstop. The opt-in defaults false when the
-- metadata omits it (log-in, or a signup that didn't tick the box).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  nick  text    := nullif(new.raw_user_meta_data->>'nickname', '');
  optin boolean := coalesce((new.raw_user_meta_data->>'marketing_opt_in')::boolean, false);
begin
  if nick is not null and public.nickname_reason(nick) is not null then
    raise exception 'invalid nickname';
  end if;
  insert into public.profiles (id, email, nickname, last_nickname_change, marketing_opt_in, marketing_opt_in_at)
    values (new.id, new.email, nick,
            case when nick is not null then now() else null end,
            optin,
            case when optin then now() else null end)
    on conflict (id) do nothing;
  return new;
end; $$;

-- OAuth path: a signed-in user records their marketing consent from the nickname prompt.
-- SECURITY DEFINER because the client cannot write profiles directly (RLS + revoked grants).
-- The *_at timestamp is set ONLY when opting in (null otherwise), so we hold a GDPR record of
-- WHEN consent was given. Idempotent; reflects the checkbox state at submit.
create or replace function public.set_marketing_consent(p_opt_in boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  update public.profiles
     set marketing_opt_in = coalesce(p_opt_in, false),
         marketing_opt_in_at = case when coalesce(p_opt_in, false) then now() else null end
   where id = uid;
  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.set_marketing_consent(boolean) from public;
grant  execute on function public.set_marketing_consent(boolean) to authenticated;

-- Live availability + validity check for the UI (callable logged-out, for signup).
-- Returns { ok, reason, available }; reason ∈ format|profane|taken|null.
create or replace function public.check_nickname(p_nick text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r text := public.nickname_reason(p_nick); taken boolean;
begin
  if r is not null then
    return jsonb_build_object('ok', false, 'reason', r, 'available', false);
  end if;
  select exists(
    select 1 from public.profiles
     where lower(nickname) = lower(p_nick)
       and (auth.uid() is null or id <> auth.uid())
  ) into taken;
  return jsonb_build_object('ok', not taken,
    'reason', case when taken then 'taken' else null end, 'available', not taken);
end; $$;

-- Change the caller's nickname, enforcing (server-side): validity, profanity, the
-- 30-day cooldown, and case-insensitive uniqueness. Returns { ok, reason, days_left };
-- reason ∈ auth|format|profane|cooldown|taken|null.
create or replace function public.set_nickname(p_nick text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text; last timestamptz; days int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  r := public.nickname_reason(p_nick);
  if r is not null then return jsonb_build_object('ok', false, 'reason', r); end if;
  select last_nickname_change into last from public.profiles where id = uid;
  if last is not null and now() - last < interval '30 days' then
    days := ceil(extract(epoch from (last + interval '30 days' - now())) / 86400.0);
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'days_left', days);
  end if;
  begin
    update public.profiles set nickname = p_nick, last_nickname_change = now() where id = uid;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end;
  return jsonb_build_object('ok', true, 'nickname', p_nick);
end; $$;

grant execute on function public.check_nickname(text) to anon, authenticated;
grant execute on function public.set_nickname(text)   to authenticated;

-- Public id → nickname map for the (future) leaderboard: exposes ONLY id +
-- nickname (nickname is meant to be public), nothing else on profiles. The view
-- runs with the owner's rights, so it is readable without a per-row RLS policy.
create or replace view public.player_names as
  select id, nickname from public.profiles;
grant select on public.player_names to anon, authenticated;

-- =============================================================================
--  DEFENCE IN DEPTH — lock down the table/function GRANTS, not just RLS.
--
--  The anon key ships in the client bundle, so anyone can get a real user JWT and
--  hit PostgREST directly. RLS already DENIES the dangerous writes (there is no
--  permissive INSERT/UPDATE policy for the client roles), BUT Supabase grants
--  anon + authenticated ALL privileges on new public tables by default — so those
--  roles technically HOLD an UPDATE grant on profiles, gated ONLY by RLS. One day a
--  well-meaning "let users edit their own row" UPDATE policy added without a column
--  filter would instantly expose is_premium (exactly the pentest's finding-a).
--
--  Removing the write grants makes that impossible: the client roles get SELECT
--  (plus the few writes RLS genuinely scopes), and EVERY privileged write goes
--  through a SECURITY DEFINER function (set_nickname / register_device — they run as
--  the owner, so REVOKE here does NOT affect them) or the service role (the Stripe
--  webhook — it bypasses RLS entirely). Idempotent; safe to re-run.
-- =============================================================================

-- PROFILES → the client is READ-ONLY. is_premium is written only by the service
-- role (webhook); nickname/last_nickname_change only by set_nickname()/the signup
-- trigger (SECURITY DEFINER). No client role may write any column, ever.
revoke insert, update, delete on public.profiles from anon, authenticated;

-- DEVICES → the client may SELECT + DELETE its own rows (RLS-scoped, e.g. "sign out
-- other devices"), but NEVER insert/update directly: register_device() (SECURITY
-- DEFINER) does the insert + enforces the 5-device rolling cap. Revoking INSERT is
-- what actually makes the cap unbypassable from a direct PostgREST call.
revoke insert, update on public.devices from anon, authenticated;

-- SCORES → anon reads the board only. authenticated may INSERT (RLS still requires
-- own row + is_premium) and read; never UPDATE/DELETE a score (no policy anyway).
revoke insert, update, delete on public.scores from anon;
revoke update, delete on public.scores from authenticated;

-- FUNCTIONS → least privilege. Postgres grants EXECUTE to PUBLIC by default, which
-- includes anon; pin each SECURITY DEFINER function to exactly the role that needs it.
revoke all on function public.nickname_reason(text)          from public;   -- internal helper only
revoke all on function public.register_device(text, text)    from public;
grant  execute on function public.register_device(text, text) to authenticated;
revoke all on function public.set_nickname(text)             from public;
grant  execute on function public.set_nickname(text)          to authenticated;
revoke all on function public.check_nickname(text)           from public;
grant  execute on function public.check_nickname(text)        to anon, authenticated;  -- needed pre-session (signup)

-- ---- ADMIN HELPERS (run manually to grant/revoke premium until Stripe lands) --
-- Grant premium to an email (run as the service role in the SQL editor):
--   update public.profiles set is_premium = true
--    where id = (select id from auth.users where email = 'someone@example.com');
-- Revoke:
--   update public.profiles set is_premium = false where id = '<uuid>';

-- =============================================================================
--  LEADERBOARD — Phase 2 step 1 (Time Attack now; XP-ready by design). Idempotent.
--
--  ONE table holds BOTH modes: `mode` = 'timeattack' (lap ms, LOWER is better) now,
--  'xp' (score, HIGHER is better) later — no schema change to add XP, only wiring.
--  There is exactly ONE best row per (user, mode, track, car, surface): a better
--  result UPSERTS over the previous, so the board shows each player once.
--
--  The whole anti-cheat is the SECURITY DEFINER submit_score() RPC below — the ONLY
--  write path. The client roles get PUBLIC READ but NO insert/update/delete, so a
--  hacked client cannot write a row directly (RLS + revoked grants), and every
--  accepted write has passed auth + a sanity floor + a per-user rate limit.
--
--  ⚠️ `surface` is NOT NULL DEFAULT '' (not nullable): the upsert key is a UNIQUE
--  constraint over (user, mode, track, car, surface), and Postgres treats NULLs as
--  DISTINCT — a nullable surface would let two "same key" rows coexist and break the
--  one-best-per-key guarantee. '' means "none / already encoded in track_id" (today
--  the oval's asphalt vs dirt are SEPARATE track_ids, so surface stays '' for now).
-- =============================================================================
create table if not exists public.leaderboard (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  nickname   text,                                  -- denormalised for display; written SERVER-side (never trusted from the client)
  mode       text not null,                         -- 'timeattack' | 'xp'
  track_id   text not null,
  car_key    text not null,
  surface    text not null default '',              -- '' = none / encoded in track_id
  value      bigint not null check (value >= 0),    -- timeattack: lap ms (lower=better). xp: score (higher=better).
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, mode, track_id, car_key, surface)   -- ONE best row per key = the upsert target
);

alter table public.leaderboard enable row level security;

-- PUBLIC READ: anyone (even logged out) may browse the board.
drop policy if exists "leaderboard: public read" on public.leaderboard;
create policy "leaderboard: public read" on public.leaderboard for select using (true);
-- NOTE: there is deliberately NO insert/update/delete policy — the only write path is
-- submit_score() (SECURITY DEFINER, runs as owner). The revokes at the bottom make that real.

-- "top N for (mode, track, car, surface)" ordered by value — the hot query for both views.
create index if not exists leaderboard_board_idx
  on public.leaderboard (mode, track_id, car_key, surface, value);
-- "this user's entries" (own-best / own-rank lookups).
create index if not exists leaderboard_user_idx on public.leaderboard (user_id);

-- ---- Rate-limit audit log: one row per ACCEPTED submit attempt (post-auth) --------
-- The leaderboard is upsert (best-only) so it keeps no history to rate-limit on; this
-- lightweight log does. No client access at all (RLS on, zero policies = deny), and
-- submit_score() (SECURITY DEFINER) owns every read/write/prune of it.
create table if not exists public.leaderboard_submits (
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.leaderboard_submits enable row level security;
create index if not exists leaderboard_submits_idx on public.leaderboard_submits (user_id, created_at);

-- ---- Per-(mode,track,car) sanity-floor OVERRIDE -----------------------------------
-- Tighten a floor by INSERTING a row here — no function redeploy. Empty by default, so
-- only the global floor in submit_score() applies until you seed real per-track values,
-- e.g.:  insert into public.leaderboard_limits values ('timeattack','circuit2','blitz', 18000);
create table if not exists public.leaderboard_limits (
  mode      text not null,
  track_id  text not null,
  car_key   text not null,
  min_value bigint not null,
  primary key (mode, track_id, car_key)
);

-- ---- THE anti-cheat gate: the SECURITY DEFINER submit RPC -------------------------
-- Enforces, in order: (1) auth — reject anon; (2) input validity — known mode, non-empty
-- track/car, positive & within an absolute sanity bound; (3) rate limit — ≤ RATE_MAX
-- accepted attempts per user per minute; (4) mode plausibility — TA: value ≥ the floor and
-- ≤ a 1 h upper bound; XP: value ≤ the ceiling — each with an optional per-(track,car)
-- override in leaderboard_limits; (5) STRUCTURAL zone / proof-of-play on p_proof — TA: all 6
-- zone splits present + monotonic; XP: the zone/lap data is internally consistent (no score
-- without play, a completed loop passes all 6 zones, contiguous traversal). Then a MODE-AWARE
-- best-only UPSERT (TA keeps the MIN, XP keeps the MAX). The stored nickname is read from
-- profiles (server truth), never taken from the client. Returns { ok, updated?, reason? }.
--   RATE_MAX  = 10 / user / minute (submits fire only on a new personal best → generous).
--   TA_MIN_MS = 3000 ms — deliberately LOW so no legit lap is ever rejected on day one
--               (nothing on these tracks laps under 3 s); tighten per track via the table.
--   TA_CEIL_MS= 3,600,000 ms (1 h) — a lap can't take longer; reject garbage-huge times.
--   XP_MAX    = 10,000,000 — deliberately HIGH so no legit run is rejected day one (max XP
--               rate ~664/s ⇒ a huge legit run is well under 1M); catches hacked billions.
--   ⚠️ leaderboard_limits.min_value is interpreted PER MODE: for 'timeattack' it is the FLOOR
--      (reject below it); for 'xp' it is the CEILING (reject above it). Same column, two roles.
--   ZONES: STRUCTURAL only for now (NO per-segment speed floors) — the TA splits are stored in
--      the payload so per-segment MINIMUM-TIME checks can be added later (a leaderboard_limits-
--      style table keyed by (track,car,segment)) with ZERO client change; left OFF today.
--   ⚠️ p_proof default '{}' + the DROP below keep ONE function (not a dangling 5-arg overload),
--      so an old cached 5-arg client still resolves (empty proof ⇒ its TA submit fails the zone
--      check until it reloads — fire-and-forget, no gameplay impact).
drop function if exists public.submit_score(text, text, text, text, bigint);
create or replace function public.submit_score(
  p_mode text, p_track_id text, p_car_key text, p_surface text, p_value bigint,
  p_proof jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid  uuid   := auth.uid();
  surf text   := coalesce(p_surface, '');
  lim  bigint;
  cur  bigint;
  nick text;
  recent int;
  zt jsonb; zi bigint; zprev bigint; i int; zc int; laps int; ordok boolean;
  RATE_MAX   constant int    := 10;
  TA_MIN_MS  constant bigint := 3000;
  TA_CEIL_MS constant bigint := 3600000;
  XP_MAX     constant bigint := 10000000;
  ABS_MAX    constant bigint := 1000000000000;   -- 1e12 — overflow/garbage guard (both modes)
begin
  -- (1) AUTH
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  -- (2) INPUT VALIDITY (basic sanity, mode-agnostic)
  if p_mode not in ('timeattack','xp')
     or p_track_id is null or p_track_id = ''
     or p_car_key  is null or p_car_key  = ''
     or p_value is null or p_value <= 0 or p_value > ABS_MAX
    then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;

  -- (3) RATE LIMIT (checked before recording; this attempt is then logged)
  select count(*) into recent from public.leaderboard_submits
   where user_id = uid and created_at > now() - interval '1 minute';
  if recent >= RATE_MAX then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  insert into public.leaderboard_submits (user_id) values (uid);
  delete from public.leaderboard_submits where created_at < now() - interval '10 minutes';  -- cheap prune

  -- (4) MODE PLAUSIBILITY — per-(track,car) override else the global bound.
  select min_value into lim from public.leaderboard_limits
    where mode = p_mode and track_id = p_track_id and car_key = p_car_key;
  if p_mode = 'timeattack' then
    -- FLOOR: a lap can't be faster than this (and can't be longer than 1 h).
    if p_value < coalesce(lim, TA_MIN_MS) or p_value > TA_CEIL_MS
      then return jsonb_build_object('ok', false, 'reason', 'floor'); end if;
  else  -- 'xp'
    -- CEILING: a run can't earn more than this.
    if p_value > coalesce(lim, XP_MAX)
      then return jsonb_build_object('ok', false, 'reason', 'ceiling'); end if;
  end if;

  -- (5) STRUCTURAL ZONE / PROOF-OF-PLAY (no speed checks yet — proves the drive happened).
  if p_mode = 'timeattack' then
    -- TA: exactly 6 split ms, all present, monotonic non-decreasing (all zones, in order).
    zt := p_proof->'z';
    if zt is null or jsonb_typeof(zt) <> 'array' or jsonb_array_length(zt) <> 6
      then return jsonb_build_object('ok', false, 'reason', 'zones'); end if;
    zprev := -1;
    for i in 0..5 loop
      zi := (zt->>i)::bigint;
      if zi is null or zi < zprev then return jsonb_build_object('ok', false, 'reason', 'zones'); end if;
      zprev := zi;
    end loop;
  else  -- 'xp' proof-of-play: partial runs OK; only contradictory / no-play data is rejected.
    zc    := coalesce((p_proof->>'zc')::int, -1);
    laps  := coalesce((p_proof->>'laps')::int, -1);
    ordok := coalesce((p_proof->>'ord')::boolean, false);
    if zc < 0 or laps < 0            then return jsonb_build_object('ok', false, 'reason', 'proof'); end if;
    if p_value > 0 and zc = 0        then return jsonb_build_object('ok', false, 'reason', 'noproof'); end if;      -- a score with no play
    if laps > 0 and zc < 6           then return jsonb_build_object('ok', false, 'reason', 'inconsistent'); end if; -- a loop passes all zones
    if not ordok                     then return jsonb_build_object('ok', false, 'reason', 'order'); end if;        -- teleport / fabricated feed
  end if;

  -- nickname = SERVER truth (never client-supplied)
  select nickname into nick from public.profiles where id = uid;

  -- BEST-ONLY UPSERT (mode-aware direction: TA keeps the MIN, XP keeps the MAX)
  select value into cur from public.leaderboard
    where user_id = uid and mode = p_mode and track_id = p_track_id and car_key = p_car_key and surface = surf;
  if cur is not null and
     ((p_mode = 'timeattack' and p_value >= cur) or (p_mode = 'xp' and p_value <= cur))
    then return jsonb_build_object('ok', true, 'updated', false, 'reason', 'not_better'); end if;

  insert into public.leaderboard (user_id, nickname, mode, track_id, car_key, surface, value)
    values (uid, nick, p_mode, p_track_id, p_car_key, surf, p_value)
  on conflict (user_id, mode, track_id, car_key, surface)
    do update set value = excluded.value, nickname = excluded.nickname, updated_at = now();
  return jsonb_build_object('ok', true, 'updated', true);
end; $$;

-- GRANTS: reads are PUBLIC (anon + authenticated may SELECT the board — this grant is REQUIRED;
-- without it a fresh project 403s on every board read). Writes go ONLY through the RPC, and only
-- for a signed-in user.
grant  select on public.leaderboard to anon, authenticated;
revoke insert, update, delete on public.leaderboard from anon, authenticated;
revoke all on function public.submit_score(text, text, text, text, bigint, jsonb) from public;
grant  execute on function public.submit_score(text, text, text, text, bigint, jsonb) to authenticated;

-- =============================================================================
--  GHOSTS (Ghost Phase 2) — a downloadable replay of each TOP-10 Time Attack lap.
--  Idempotent. submit_score() above is DELIBERATELY UNTOUCHED — ghost upload rides
--  ALONGSIDE it through its own RPC. Storage is HARD-CAPPED at the TOP 10 per
--  (track,car,surface): the primary key keeps one ghost per user per combo, and
--  submit_ghost() evicts every ghost whose owner is no longer in the top 10 on each
--  write. Because a top-10 TIME always comes with a mandatory ghost upload, a player
--  pushed out of the top 10 is evicted by the very submission that displaces them —
--  so the board and the ghost library stay matched without touching submit_score().
--  ⚠️ TA-only (ghosts are a Time Attack feature), so no `mode` column; surface '' as
--  in the leaderboard (the ovals' asphalt/dirt are already separate track_ids).
-- =============================================================================
create table if not exists public.ghosts (
  user_id    uuid not null references auth.users(id) on delete cascade,
  track_id   text not null,
  car_key    text not null,
  surface    text not null default '',
  value      bigint not null check (value >= 0),   -- the TA lap ms this ghost is for (== the leaderboard row)
  nickname   text,                                  -- denormalised for display; written SERVER-side
  ghost      jsonb not null,                        -- the serializeGhost() object {v,dt,x,y,h}
  updated_at timestamptz not null default now(),
  primary key (user_id, track_id, car_key, surface) -- ONE ghost per user per combo (mirrors the one leaderboard row)
);
alter table public.ghosts enable row level security;
-- PUBLIC READ: anyone (even logged out) may download a top-10 ghost to race against.
drop policy if exists "ghosts: public read" on public.ghosts;
create policy "ghosts: public read" on public.ghosts for select using (true);
-- No insert/update/delete policy — submit_ghost() (SECURITY DEFINER) is the only write path.
create index if not exists ghosts_combo_idx on public.ghosts (track_id, car_key, surface);

-- submit_ghost(): store the caller's ghost for a TA lap, but ONLY if that exact time is a genuine
-- leaderboard entry of theirs AND currently ranks in the TOP 10 for the combo; then evict every
-- ghost whose owner is no longer in the top 10 (the hard cap). Mirrors submit_score's gate style
-- (auth + input/size + rate limit) but never touches it. Returns { ok, reason? }.
--   GHOST_MAX_BYTES = 65536 — a top-10 lap ~14 KB; a hard ceiling on the payload.
--   RATE_MAX        = 10 / user / minute (shares the leaderboard_submits log; a PB = score+ghost = 2).
--   TOP_N           = 10 — the storage cap per (track,car,surface).
create or replace function public.submit_ghost(
  p_track_id text, p_car_key text, p_surface text, p_value bigint, p_ghost jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  surf text := coalesce(p_surface, '');
  nick text;
  recent  int;
  better  int;
  has_row int;
  GHOST_MAX_BYTES constant int := 65536;
  RATE_MAX        constant int := 10;
  TOP_N           constant int := 10;
begin
  -- (1) AUTH
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  -- (2) INPUT VALIDITY + SIZE CAP
  if p_track_id is null or p_track_id = '' or p_car_key is null or p_car_key = ''
     or p_value is null or p_value <= 0
     or p_ghost is null or jsonb_typeof(p_ghost) <> 'object'
     or octet_length(p_ghost::text) > GHOST_MAX_BYTES
    then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  -- (3) RATE LIMIT (shares the leaderboard_submits audit log with submit_score)
  select count(*) into recent from public.leaderboard_submits
   where user_id = uid and created_at > now() - interval '1 minute';
  if recent >= RATE_MAX then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  insert into public.leaderboard_submits (user_id) values (uid);
  delete from public.leaderboard_submits where created_at < now() - interval '10 minutes';  -- cheap prune
  -- (4a) The time must be a REAL leaderboard entry OF THE CALLER (no fabricated ghosts; this is
  --      also what lets an existing local ghost attach to an already-listed time on import).
  select 1 into has_row from public.leaderboard
    where user_id = uid and mode = 'timeattack' and track_id = p_track_id
      and car_key = p_car_key and surface = surf and value = p_value;
  if has_row is null then return jsonb_build_object('ok', false, 'reason', 'no_entry'); end if;
  -- (4b) ...and it must currently rank in the TOP 10 (fewer than 10 strictly-better times exist).
  select count(*) into better from public.leaderboard
    where mode = 'timeattack' and track_id = p_track_id and car_key = p_car_key
      and surface = surf and value < p_value;
  if better >= TOP_N then return jsonb_build_object('ok', false, 'reason', 'not_top10'); end if;
  -- (5) nickname = SERVER truth (never client-supplied)
  select nickname into nick from public.profiles where id = uid;
  -- (6) UPSERT the ghost (one per user per combo)
  insert into public.ghosts (user_id, track_id, car_key, surface, value, nickname, ghost)
    values (uid, p_track_id, p_car_key, surf, p_value, nick, p_ghost)
  on conflict (user_id, track_id, car_key, surface)
    do update set value = excluded.value, nickname = excluded.nickname,
                  ghost = excluded.ghost, updated_at = now();
  -- (7) EVICT every ghost whose owner is no longer in the top 10 for this combo (the hard cap).
  delete from public.ghosts g
    where g.track_id = p_track_id and g.car_key = p_car_key and g.surface = surf
      and g.user_id not in (
        select l.user_id from public.leaderboard l
          where l.mode = 'timeattack' and l.track_id = p_track_id
            and l.car_key = p_car_key and l.surface = surf
          order by l.value asc, l.updated_at asc
          limit TOP_N);
  return jsonb_build_object('ok', true);
end; $$;

grant  select on public.ghosts to anon, authenticated;
revoke insert, update, delete on public.ghosts from anon, authenticated;
revoke all on function public.submit_ghost(text, text, text, bigint, jsonb) from public;
grant  execute on function public.submit_ghost(text, text, text, bigint, jsonb) to authenticated;

-- =============================================================================
--  REVIEWS + GRANTED PREMIUM — "leave a review → get premium free" (manual approval).
--  Idempotent. Legally clean: premium is for LEAVING a review (ANY rating qualifies),
--  never for a positive one; publish consent is SEPARATE and does NOT gate the reward.
--
--  ⚠️ GRANTED PREMIUM IS A SEPARATE FLAG FROM is_premium (the Stripe-paid flag). The app's
--  effective premium = is_premium OR granted_premium (read in auth.ts refreshEntitlement).
--  Stripe / billing ONLY ever touch is_premium; nothing here (and nothing Stripe-side) writes
--  granted_premium except admin_approve_review. So a review-granted (or comped) user can NEVER
--  be wiped by any present OR future Stripe revoke/refund/reconcile logic, and is never counted
--  as a paying customer (paid = `where is_premium`; comped = `where granted_premium`).
-- =============================================================================
alter table public.profiles add column if not exists granted_premium boolean not null default false;
alter table public.profiles add column if not exists granted_premium_at timestamptz;

create table if not exists public.reviews (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  nickname        text,                                   -- denormalised for display; written SERVER-side
  rating          int  not null check (rating between 1 and 5),
  body            text not null,                          -- the review text ('body', not the type-name 'text')
  publish_consent boolean not null default false,
  consent_at      timestamptz,                            -- set ONLY when publish_consent = true (GDPR: when consent was given)
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz
);
-- ONE pending-or-approved review per user (a REJECTED one may be resubmitted). The unique index
-- is the race-proof backstop; submit_review() also checks it for a clean message.
create unique index if not exists reviews_one_active_per_user
  on public.reviews (user_id) where status in ('pending','approved');

alter table public.reviews enable row level security;
-- READS: your OWN reviews (any status, so the UI can show pending/approved) OR the PUBLIC subset
-- (approved AND consented — for a future website showcase). Pending / rejected / non-consented
-- rows are visible to no one but their owner. RLS policies OR together (permissive).
drop policy if exists "reviews: read own" on public.reviews;
create policy "reviews: read own" on public.reviews for select using (auth.uid() = user_id);
drop policy if exists "reviews: public approved+consented" on public.reviews;
create policy "reviews: public approved+consented" on public.reviews
  for select using (status = 'approved' and publish_consent = true);
-- No client insert/update/delete (revoked below) — submit_review() is the only write path.

-- ---- SUBMIT (user-callable, SECURITY DEFINER) ----
-- Enforces: auth; rating 1..5; body 10..2000 chars; ONE active (pending/approved) review per
-- user; a light rate cap (<=5 submissions/hour) against rejected-resubmit spam. Nickname is read
-- from profiles (server truth). Sets status='pending' — NEVER grants premium (that is manual).
-- consent_at is stamped ONLY when publish_consent is true; consent does NOT affect the reward.
create or replace function public.submit_review(p_rating int, p_body text, p_consent boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); nick text; recent int; b text := btrim(coalesce(p_body, ''));
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then return jsonb_build_object('ok', false, 'reason', 'rating'); end if;
  if length(b) < 10 or length(b) > 2000 then return jsonb_build_object('ok', false, 'reason', 'text'); end if;
  if exists (select 1 from public.reviews where user_id = uid and status in ('pending','approved'))
    then return jsonb_build_object('ok', false, 'reason', 'exists'); end if;
  select count(*) into recent from public.reviews where user_id = uid and created_at > now() - interval '1 hour';
  if recent >= 5 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  select nickname into nick from public.profiles where id = uid;
  insert into public.reviews (user_id, nickname, rating, body, publish_consent, consent_at)
    values (uid, nick, p_rating, b, coalesce(p_consent, false),
            case when coalesce(p_consent, false) then now() else null end);
  return jsonb_build_object('ok', true);
end; $$;

-- ---- ADMIN approve / reject (NOT user-callable — service role / SQL editor only) ----
-- APPROVE = the ONLY thing that grants premium, and it sets the SEPARATE granted_premium flag
-- (never is_premium). Gated on status='pending' so re-running is a no-op. REJECT just marks it.
create or replace function public.admin_approve_review(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  update public.reviews set status = 'approved', reviewed_at = now()
    where id = p_id and status = 'pending' returning user_id into uid;
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  update public.profiles set granted_premium = true, granted_premium_at = now() where id = uid;
  return jsonb_build_object('ok', true, 'user', uid);
end; $$;

create or replace function public.admin_reject_review(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.reviews set status = 'rejected', reviewed_at = now()
    where id = p_id and status = 'pending';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0);
end; $$;

-- GRANTS: reads via the RLS SELECT policies (own + public-approved-consented); writes ONLY via
-- submit_review (authenticated). The admin functions are granted to NO client role — only the
-- owner / service role (the SQL editor) can approve/reject.
grant  select on public.reviews to anon, authenticated;
revoke insert, update, delete on public.reviews from anon, authenticated;
revoke all on function public.submit_review(int, text, boolean)   from public;
grant  execute on function public.submit_review(int, text, boolean) to authenticated;
revoke all on function public.admin_approve_review(bigint) from public, anon, authenticated;
revoke all on function public.admin_reject_review(bigint)  from public, anon, authenticated;

-- ---- ADMIN WORKFLOW (run manually in the SQL editor) ----
--   select id, nickname, rating, body, publish_consent, created_at
--     from public.reviews where status = 'pending' order by created_at;
--   select public.admin_approve_review(123);   -- approves + grants premium (granted_premium)
--   select public.admin_reject_review(124);    -- rejects, no grant
--   -- website showcase candidates:
--   select nickname, rating, body from public.reviews where status = 'approved' and publish_consent;
--
-- ---- MIGRATE johny.frajer (and any comped user) onto granted_premium ----
-- Move his comped grant off the Stripe-shared is_premium onto granted_premium, so all comped
-- users are on the one mechanism (immune to any future Stripe is_premium reset). Run once with
-- his REAL email:
--   update public.profiles set granted_premium = true, granted_premium_at = now(), is_premium = false
--    where id = (select id from auth.users where email = 'johny.frajer@example.com');
-- (Effective premium = is_premium OR granted_premium, so clearing is_premium here does NOT
--  remove his access — it just reclassifies him from "paid" to "comped".)
