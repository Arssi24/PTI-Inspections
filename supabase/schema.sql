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

alter table public.profiles enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles for select
  using (id = auth.uid());

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (id = auth.uid());


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

drop policy if exists "Managers can insert their own fleet" on public.fleets;
create policy "Managers can insert their own fleet"
  on public.fleets for insert
  with check (manager_id = auth.uid());


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
