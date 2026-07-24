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

-- ---- ADMIN HELPERS (run manually to grant/revoke premium until Stripe lands) --
-- Grant premium to an email (run as the service role in the SQL editor):
--   update public.profiles set is_premium = true
--    where id = (select id from auth.users where email = 'someone@example.com');
-- Revoke:
--   update public.profiles set is_premium = false where id = '<uuid>';
