-- PTI Inspections — Supabase schema
-- Paste this whole file into the Supabase SQL Editor (your project -> SQL Editor -> New query) and click Run.
-- Safe to re-run: each statement either uses IF NOT EXISTS or is wrapped so re-running won't duplicate data.

-- ============ PROFILES ============
-- One row per signed-up user (driver or fleet manager), linked 1:1 to Supabase's built-in auth.users.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  role text not null check (role in ('driver', 'manager')),
  fleet_code text not null,
  created_at timestamptz not null default now()
);

-- Added after the table already existed in some projects — safe to re-run.
alter table public.profiles add column if not exists assigned_unit text;

alter table public.profiles enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles for select
  using (id = auth.uid());
-- A second policy on profiles (fleet managers reading their drivers' rows) is added
-- further down, after current_fleet_code() exists — see below.

-- No client-side insert policy: profiles are created exclusively by the
-- handle_new_user() trigger below (SECURITY DEFINER, bypasses RLS). This is what makes
-- email-confirmation-required signups work — the client has no session yet at signup
-- time, so it couldn't pass an `auth.uid()` check even if we gave it an insert policy.
drop policy if exists "Users can insert own profile" on public.profiles;


-- ============ FLEETS ============
-- One row per fleet manager's company. The "code" is what drivers type in at sign-up to link to this fleet.
create table if not exists public.fleets (
  code text primary key,
  manager_id uuid not null references auth.users(id) on delete cascade,
  manager_name text not null,
  created_at timestamptz not null default now()
);

alter table public.fleets enable row level security;

-- Deliberately public read: a driver signing up isn't authenticated yet, so we need an
-- unauthenticated way to check "does this fleet code exist". Fleet codes are invite codes,
-- not secrets, so this is fine (same trust level as a Wi-Fi guest password).
drop policy if exists "Anyone can look up a fleet code" on public.fleets;
create policy "Anyone can look up a fleet code"
  on public.fleets for select
  using (true);

-- No client-side insert policy here either — see the comment on public.profiles above.
-- Fleets are created by the same handle_new_user() trigger, in the same transaction as
-- the profile, so a manager's fleet_code exists before they've even confirmed their email.
drop policy if exists "Managers can insert their own fleet" on public.fleets;


-- Helper: the fleet_code of whoever is currently logged in. SECURITY DEFINER lets this
-- read profiles (bypassing that table's RLS) so it can be reused inside other policies
-- below without circular-RLS problems.
create or replace function public.current_fleet_code()
returns text
language sql
security definer
stable
as $$
  select fleet_code from public.profiles where id = auth.uid()
$$;

drop policy if exists "Managers can read their fleet's driver profiles" on public.profiles;
create policy "Managers can read their fleet's driver profiles"
  on public.profiles for select
  using (fleet_code = public.current_fleet_code());

-- Managers can remove a driver from their own fleet's roster (revokes their access —
-- the driver's login account still exists, it just has no profile/fleet tie anymore).
-- Scoped to role = 'driver' so this can never be used to remove a manager, including
-- accidentally removing yourself.
drop policy if exists "Managers can remove their fleet's drivers" on public.profiles;
create policy "Managers can remove their fleet's drivers"
  on public.profiles for delete
  using (fleet_code = public.current_fleet_code() and role = 'driver');

-- Lets a manager edit a driver's display name and assigned truck/trailer. Same row scope
-- as the delete policy above (their own fleet's drivers only, never another manager).
drop policy if exists "Managers can edit their fleet's drivers" on public.profiles;
create policy "Managers can edit their fleet's drivers"
  on public.profiles for update
  using (fleet_code = public.current_fleet_code() and role = 'driver')
  with check (fleet_code = public.current_fleet_code() and role = 'driver');


-- ============ AUTO-CREATE PROFILE (AND FLEET, IF MANAGER) ON SIGNUP ============
-- Fires inside the same database transaction as the auth.users row itself, so it runs
-- whether or not "Confirm email" is turned on — there's never a gap where a confirmed
-- user exists without a profile. SECURITY DEFINER lets it write to profiles/fleets even
-- though the signing-up client has no session yet (can't pass an auth.uid() RLS check).
-- name/phone/role/fleet_code are passed from the client via supabase.auth.signUp's
-- `options.data`, which Postgres receives as new.raw_user_meta_data.
--
-- A manager can either create a brand-new fleet (v_fleet_code arrives empty) or join an
-- existing one as an additional manager (v_fleet_code arrives already set, same as how a
-- driver joins). Access everywhere else is governed purely by profiles.fleet_code matching
-- current_fleet_code(), not by fleets.manager_id — so a second manager on the same code
-- automatically gets full dashboard visibility with no other schema changes needed.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(new.raw_user_meta_data->>'role', 'driver');
  v_name text := coalesce(new.raw_user_meta_data->>'name', '');
  v_phone text := new.raw_user_meta_data->>'phone';
  v_fleet_code text := new.raw_user_meta_data->>'fleet_code';
  v_candidate text;
  v_attempt int := 0;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if v_role = 'manager' then
    if v_fleet_code is not null and v_fleet_code <> '' then
      if not exists (select 1 from public.fleets where code = v_fleet_code) then
        raise exception 'Fleet code not found';
      end if;
    else
      loop
        v_attempt := v_attempt + 1;
        v_candidate := 'F';
        for i in 1..5 loop
          v_candidate := v_candidate || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
        end loop;
        begin
          insert into public.fleets (code, manager_id, manager_name) values (v_candidate, new.id, v_name);
          v_fleet_code := v_candidate;
          exit;
        exception when unique_violation then
          if v_attempt >= 6 then
            raise exception 'Could not generate a unique fleet code, try signing up again';
          end if;
        end;
      end loop;
    end if;
  end if;

  insert into public.profiles (id, name, email, phone, role, fleet_code)
  values (new.id, v_name, new.email, v_phone, v_role, v_fleet_code);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============ UNITS (trucks & trailers) ============
create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  unit text not null,
  kind text not null check (kind in ('truck', 'trailer')),
  fleet_code text not null references public.fleets(code) on delete cascade,
  created_at timestamptz not null default now(),
  unique (fleet_code, unit)
);

alter table public.units enable row level security;

drop policy if exists "Fleet members can read their fleet's units" on public.units;
create policy "Fleet members can read their fleet's units"
  on public.units for select
  using (fleet_code = public.current_fleet_code());

drop policy if exists "Fleet members can add units" on public.units;
create policy "Fleet members can add units"
  on public.units for insert
  with check (fleet_code = public.current_fleet_code());

drop policy if exists "Fleet members can remove units" on public.units;
create policy "Fleet members can remove units"
  on public.units for delete
  using (fleet_code = public.current_fleet_code());


-- ============ INSPECTIONS ============
create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('PTI', 'HOOK', 'DROP')),
  unit text not null,
  driver_id uuid not null references auth.users(id),
  driver_name text not null,
  driver_email text not null,
  driver_phone text,
  fleet_code text not null references public.fleets(code) on delete cascade,
  duration_sec integer not null,
  defects jsonb not null default '[]',
  video_path text,
  lat double precision,
  lng double precision,
  location_accuracy_m integer,
  created_at timestamptz not null default now()
);

alter table public.inspections enable row level security;

drop policy if exists "Fleet members can read their fleet's inspections" on public.inspections;
create policy "Fleet members can read their fleet's inspections"
  on public.inspections for select
  using (fleet_code = public.current_fleet_code());

drop policy if exists "Drivers can insert their own inspections" on public.inspections;
create policy "Drivers can insert their own inspections"
  on public.inspections for insert
  with check (fleet_code = public.current_fleet_code() and driver_id = auth.uid());


-- ============ STORAGE (video + defect photos) ============
insert into storage.buckets (id, name, public)
values ('inspection-media', 'inspection-media', false)
on conflict (id) do nothing;

-- Files are stored at paths like "<fleet_code>/<inspection_id>/video.webm", so the first
-- folder segment tells us which fleet a file belongs to.
drop policy if exists "Fleet members can read their fleet's media" on storage.objects;
create policy "Fleet members can read their fleet's media"
  on storage.objects for select
  using (
    bucket_id = 'inspection-media'
    and (storage.foldername(name))[1] = public.current_fleet_code()
  );

drop policy if exists "Fleet members can upload to their fleet folder" on storage.objects;
create policy "Fleet members can upload to their fleet folder"
  on storage.objects for insert
  with check (
    bucket_id = 'inspection-media'
    and (storage.foldername(name))[1] = public.current_fleet_code()
  );
