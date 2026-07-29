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

-- Recreate the signup trigger so it also claims the nickname (from the signup
-- metadata). nickname_reason + the CHECK + the unique index all apply on INSERT,
-- so a profane/invalid/taken nickname makes the whole signup fail (rolls back the
-- auth user) — the client pre-checks, so this is the race/abuse backstop.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare nick text := nullif(new.raw_user_meta_data->>'nickname', '');
begin
  if nick is not null and public.nickname_reason(nick) is not null then
    raise exception 'invalid nickname';
  end if;
  insert into public.profiles (id, email, nickname, last_nickname_change)
    values (new.id, new.email, nick, case when nick is not null then now() else null end)
    on conflict (id) do nothing;
  return new;
end; $$;

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
