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

-- Helper: is the current user a fleet manager? Used to restrict destructive actions
-- (like deleting an inspection) to managers, not any driver in the fleet.
create or replace function public.current_is_manager()
returns boolean
language sql
security definer
stable
as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'manager', false)
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
  fleet_code text not null references public.fleets(code) on delete cascade on update cascade,
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
  fleet_code text not null references public.fleets(code) on delete cascade on update cascade,
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

-- Only fleet managers can delete an inspection (frees up storage space) — not drivers,
-- so there's no way for a driver to quietly delete their own submission.
drop policy if exists "Managers can delete their fleet's inspections" on public.inspections;
create policy "Managers can delete their fleet's inspections"
  on public.inspections for delete
  using (fleet_code = public.current_fleet_code() and public.current_is_manager());


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

-- Only managers can delete media (matches the inspections-table delete policy above).
drop policy if exists "Managers can delete their fleet's media" on storage.objects;
create policy "Managers can delete their fleet's media"
  on storage.objects for delete
  using (
    bucket_id = 'inspection-media'
    and (storage.foldername(name))[1] = public.current_fleet_code()
    and public.current_is_manager()
  );


-- ============ MANAGER: EDIT A DRIVER'S NAME / LOGIN / PASSWORD ============
-- Lets a fleet manager change a driver's name, the login (email) the driver types, and set a new
-- password, all in one call. Runs with elevated rights because passwords live in auth.users, but
-- only for a manager editing a driver in their OWN fleet. Passwords are stored scrambled (bcrypt),
-- exactly like a normal sign-up, so they can be replaced but never read back.
create or replace function public.manager_update_driver(
  p_driver_id uuid, p_name text, p_email text, p_password text, p_unit text
) returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_fleet text;
  v_old_email text;
  v_email text;
begin
  if not public.current_is_manager() then
    raise exception 'Only fleet managers can do this';
  end if;
  select fleet_code, email into v_fleet, v_old_email
    from public.profiles where id = p_driver_id and role = 'driver';
  if v_fleet is null or v_fleet <> public.current_fleet_code() then
    raise exception 'Driver not found in your fleet';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Name cannot be empty';
  end if;
  v_email := lower(trim(coalesce(p_email, '')));
  if v_email = '' then v_email := lower(v_old_email); end if;
  if position('@' in v_email) < 2 then
    raise exception 'The login must look like name@gmail.com';
  end if;

  if v_email <> lower(v_old_email) then
    if exists (select 1 from auth.users where lower(email) = v_email and id <> p_driver_id) then
      raise exception 'That login is already used by someone else';
    end if;
    update auth.users
       set email = v_email, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
     where id = p_driver_id;
    update auth.identities
       set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_email)), updated_at = now()
     where user_id = p_driver_id and provider = 'email';
  end if;

  if coalesce(p_password, '') <> '' then
    if length(p_password) < 6 then
      raise exception 'Password must be at least 6 characters';
    end if;
    update auth.users
       set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now()
     where id = p_driver_id;
    -- sign the driver out everywhere so the new password is needed
    delete from auth.sessions where user_id = p_driver_id;
  end if;

  update public.profiles
     set name = trim(p_name), email = v_email, assigned_unit = nullif(trim(coalesce(p_unit, '')), '')
   where id = p_driver_id;
  update public.inspections
     set driver_name = trim(p_name), driver_email = v_email
   where driver_id = p_driver_id;
end;
$$;

revoke all on function public.manager_update_driver(uuid, text, text, text, text) from public, anon;
grant execute on function public.manager_update_driver(uuid, text, text, text, text) to authenticated;


-- ============ MANAGER SECURITY CODE ============
-- Two codes per fleet:
--   1) the fleet code (public-ish, drivers type it at sign-up to pick the fleet)
--   2) a MANAGER SECURITY CODE that only fleet managers know. A new manager who wants to join an
--      existing fleet must enter BOTH. Without it nobody (including a driver who knows the fleet
--      code) can sign up as a manager of that fleet. Managers can change the security code any time.
-- The security code lives in its own table with NO read policy, so it can never be looked up by the
-- app directly; only the SECURITY DEFINER functions below can touch it.

create table if not exists public.fleet_secrets (
  fleet_code text primary key references public.fleets(code) on delete cascade on update cascade,
  manager_code text not null,
  updated_at timestamptz not null default now()
);
alter table public.fleet_secrets enable row level security;
-- (intentionally no policies: direct access is denied for everyone except the functions below)

create or replace function public.gen_manager_code() returns text
language plpgsql
volatile
as $$
declare
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
begin
  for i in 1..8 loop
    v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
  end loop;
  return v_code;
end;
$$;

-- Every fleet that already exists gets its first security code now.
insert into public.fleet_secrets (fleet_code, manager_code)
select f.code, public.gen_manager_code() from public.fleets f
on conflict (fleet_code) do nothing;

-- Sign-up check (works before login): is this fleet code + security code pair right?
create or replace function public.check_manager_code(p_fleet text, p_code text) returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.fleet_secrets
    where fleet_code = trim(p_fleet) and upper(manager_code) = upper(trim(p_code))
  )
$$;
revoke all on function public.check_manager_code(text, text) from public;
grant execute on function public.check_manager_code(text, text) to anon, authenticated;

-- A signed-in manager reads their own fleet's current security code.
create or replace function public.get_manager_code() returns text
language plpgsql
security definer
set search_path = public
stable
as $$
declare v text;
begin
  if not public.current_is_manager() then raise exception 'Only fleet managers can do this'; end if;
  select manager_code into v from public.fleet_secrets where fleet_code = public.current_fleet_code();
  return v;
end;
$$;
revoke all on function public.get_manager_code() from public, anon;
grant execute on function public.get_manager_code() to authenticated;

-- A signed-in manager makes a brand-new security code (the old one stops working immediately).
create or replace function public.regenerate_manager_code() returns text
language plpgsql
security definer
set search_path = public
as $$
declare v text := public.gen_manager_code();
begin
  if not public.current_is_manager() then raise exception 'Only fleet managers can do this'; end if;
  insert into public.fleet_secrets (fleet_code, manager_code)
  values (public.current_fleet_code(), v)
  on conflict (fleet_code) do update set manager_code = excluded.manager_code, updated_at = now();
  return v;
end;
$$;
revoke all on function public.regenerate_manager_code() from public, anon;
grant execute on function public.regenerate_manager_code() to authenticated;

-- Sign-up trigger: now enforces the security code when a manager joins an existing fleet,
-- and creates the code when a manager starts a new fleet.
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
  v_manager_code text := new.raw_user_meta_data->>'manager_code';
  v_candidate text;
  v_attempt int := 0;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if v_role = 'manager' then
    if v_fleet_code is not null and v_fleet_code <> '' then
      if not exists (select 1 from public.fleets where code = v_fleet_code) then
        raise exception 'Fleet code not found';
      end if;
      if not public.check_manager_code(v_fleet_code, coalesce(v_manager_code, '')) then
        raise exception 'Wrong manager security code';
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
          insert into public.fleet_secrets (fleet_code, manager_code) values (v_candidate, public.gen_manager_code());
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


-- ============ SECURITY HARDENING ============
-- Safe to re-run. Closes the gaps found in the security review:
--   1. Strangers could list EVERY fleet code (and manager names) with only the public key.
--   2. Drivers could read every other driver's inspections (names, phones, GPS) in their fleet, and add/delete trucks.
--   3. Anyone logged in could upload any file type.
--   4. The manager security code could be guessed without limit.
--   5. Removing a driver left their login alive.
--   6. A driver could type any name/email into an inspection they submit.

-- ---------- 1) fleets: no public listing; sign-up uses a yes/no lookup instead
drop policy if exists "Anyone can look up a fleet code" on public.fleets;
drop policy if exists "Members can read their own fleet" on public.fleets;
create policy "Members can read their own fleet"
  on public.fleets for select
  using (code = public.current_fleet_code());

create or replace function public.find_fleet(p_code text) returns text
language sql
security definer
stable
set search_path = public
as $$
  select code from public.fleets where lower(code) = lower(trim(p_code)) limit 1
$$;
revoke all on function public.find_fleet(text) from public;
grant execute on function public.find_fleet(text) to anon, authenticated;

-- ---------- 2a) units: only managers add / remove trucks and trailers (everyone in the fleet can still read)
drop policy if exists "Fleet members can add units" on public.units;
drop policy if exists "Fleet members can remove units" on public.units;
drop policy if exists "Managers can add units" on public.units;
drop policy if exists "Managers can remove units" on public.units;
create policy "Managers can add units"
  on public.units for insert
  with check (fleet_code = public.current_fleet_code() and public.current_is_manager());
create policy "Managers can remove units"
  on public.units for delete
  using (fleet_code = public.current_fleet_code() and public.current_is_manager());

-- ---------- 2b) inspections: managers see the whole fleet, drivers see only their own
drop policy if exists "Fleet members can read their fleet's inspections" on public.inspections;
drop policy if exists "Managers can read their fleet's inspections" on public.inspections;
drop policy if exists "Drivers can read their own inspections" on public.inspections;
create policy "Managers can read their fleet's inspections"
  on public.inspections for select
  using (fleet_code = public.current_fleet_code() and public.current_is_manager());
create policy "Drivers can read their own inspections"
  on public.inspections for select
  using (driver_id = auth.uid());

-- ---------- 2c) stored videos/photos: managers read the fleet's files, drivers read only what they uploaded
drop policy if exists "Fleet members can read their fleet's media" on storage.objects;
drop policy if exists "Managers can read their fleet's media" on storage.objects;
drop policy if exists "Drivers can read their own uploads" on storage.objects;
create policy "Managers can read their fleet's media"
  on storage.objects for select
  using (
    bucket_id = 'inspection-media'
    and (storage.foldername(name))[1] = public.current_fleet_code()
    and public.current_is_manager()
  );
create policy "Drivers can read their own uploads"
  on storage.objects for select
  using (bucket_id = 'inspection-media' and owner_id = (select auth.uid())::text);

-- ---------- 3) uploads: only videos and photos, max 500 MB
update storage.buckets
   set file_size_limit = 524288000,
       allowed_mime_types = array['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg', 'image/png']
 where id = 'inspection-media';

-- ---------- 4) manager security code: stop guessing (15 wrong tries per fleet per 10 minutes, then locked for a while)
create table if not exists public.manager_code_failures (
  fleet_code text not null,
  at timestamptz not null default now()
);
create index if not exists manager_code_failures_idx on public.manager_code_failures (fleet_code, at);
alter table public.manager_code_failures enable row level security;

create or replace function public.check_manager_code(p_fleet text, p_code text) returns boolean
language plpgsql
security definer
volatile
set search_path = public
as $$
declare
  v_fleet text := trim(coalesce(p_fleet, ''));
  v_ok boolean;
begin
  if (select count(*) from public.manager_code_failures
       where fleet_code = v_fleet and at > now() - interval '10 minutes') >= 15 then
    return false;
  end if;
  select exists (
    select 1 from public.fleet_secrets
    where fleet_code = v_fleet and upper(manager_code) = upper(trim(coalesce(p_code, '')))
  ) into v_ok;
  if not v_ok then
    insert into public.manager_code_failures (fleet_code) values (v_fleet);
    delete from public.manager_code_failures where at < now() - interval '1 day';
  end if;
  return v_ok;
end;
$$;
revoke all on function public.check_manager_code(text, text) from public;
grant execute on function public.check_manager_code(text, text) to anon, authenticated;

-- ---------- 5) removing a driver now removes their LOGIN too (their past inspections stay as company records)
alter table public.inspections alter column driver_id drop not null;
alter table public.inspections drop constraint if exists inspections_driver_id_fkey;
alter table public.inspections
  add constraint inspections_driver_id_fkey foreign key (driver_id) references auth.users(id) on delete set null;

create or replace function public.manager_remove_driver(p_driver_id uuid) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_fleet text;
begin
  if not public.current_is_manager() then raise exception 'Only fleet managers can do this'; end if;
  select fleet_code into v_fleet from public.profiles where id = p_driver_id and role = 'driver';
  if v_fleet is null or v_fleet <> public.current_fleet_code() then
    raise exception 'Driver not found in your fleet';
  end if;
  delete from auth.users where id = p_driver_id;   -- the profile goes with it (cascade)
end;
$$;
revoke all on function public.manager_remove_driver(uuid) from public, anon;
grant execute on function public.manager_remove_driver(uuid) to authenticated;

-- ---------- 6) an inspection always carries the real name/email/phone of the driver who submitted it
create or replace function public.stamp_inspection_driver() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare p record;
begin
  select name, email, phone into p from public.profiles where id = new.driver_id;
  if found then
    new.driver_name := p.name;
    new.driver_email := p.email;
    new.driver_phone := p.phone;
  end if;
  if new.duration_sec < 0 or new.duration_sec > 14400 then new.duration_sec := greatest(0, least(new.duration_sec, 14400)); end if;
  return new;
end;
$$;
drop trigger if exists stamp_inspection_driver_trg on public.inspections;
create trigger stamp_inspection_driver_trg
  before insert on public.inspections
  for each row execute function public.stamp_inspection_driver();
-- ============ ASSIGNED TRUCK VIDEO (permanent) + driver counts ============
-- A driver records one "Assigned Truck Video" per truck/trailer (scan the QR, record, upload — same as a PTI).
-- It is stored as an inspection of type 'BASELINE'. The FIRST one for a unit is kept FOREVER:
--   * only one can exist per unit (a second one is refused by the database)
--   * nobody can edit or delete it through the app, and the 3-month clean-up skips it
--   * every driver and manager in the fleet can watch it
-- Safe to re-run.

-- 1) allow the new kind
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.inspections'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%''PTI''%'
  loop
    execute format('alter table public.inspections drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.inspections
  add constraint inspections_type_check check (type in ('PTI', 'HOOK', 'DROP', 'BASELINE'));

-- 2) one per truck/trailer: the first wins
create unique index if not exists inspections_one_assigned_video_per_unit
  on public.inspections (fleet_code, upper(unit)) where type = 'BASELINE';

-- 3) everyone in the fleet can read these (drivers only see their own PTIs otherwise)
drop policy if exists "Fleet can read assigned truck videos" on public.inspections;
create policy "Fleet can read assigned truck videos"
  on public.inspections for select
  using (type = 'BASELINE' and fleet_code = public.current_fleet_code());

-- 4) lock: no editing / deleting an assigned truck video from the app (second lock on top of "no policy")
create or replace function public.block_assigned_video_changes() returns trigger
language plpgsql
as $$
begin
  if old.type = 'BASELINE' and current_user in ('anon', 'authenticated') then
    raise exception 'Assigned truck videos are permanent and cannot be changed or deleted';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists block_assigned_video_changes_trg on public.inspections;
create trigger block_assigned_video_changes_trg
  before update or delete on public.inspections
  for each row execute function public.block_assigned_video_changes();

-- 5) storage: fleet members can watch the files; the delete rule now skips the BASELINE folder
drop policy if exists "Fleet can read assigned truck video files" on storage.objects;
create policy "Fleet can read assigned truck video files"
  on storage.objects for select
  using (
    bucket_id = 'inspection-media'
    and (storage.foldername(name))[1] = public.current_fleet_code()
    and (storage.foldername(name))[2] = 'BASELINE'
  );

drop policy if exists "Managers can delete their fleet's media" on storage.objects;
create policy "Managers can delete their fleet's media"
  on storage.objects for delete
  using (
    bucket_id = 'inspection-media'
    and (storage.foldername(name))[1] = public.current_fleet_code()
    and (storage.foldername(name))[2] is distinct from 'BASELINE'
    and public.current_is_manager()
  );

-- 6) Drivers tab: how many inspections each driver has done, per kind (managers only see their own fleet via RLS)
create or replace function public.fleet_driver_counts()
returns table (driver_id uuid, type text, n bigint)
language sql
stable
set search_path = public
as $$
  select i.driver_id, i.type, count(*)::bigint
  from public.inspections i
  where i.fleet_code = public.current_fleet_code() and i.type <> 'BASELINE'
  group by i.driver_id, i.type
$$;
revoke all on function public.fleet_driver_counts() from public, anon;
grant execute on function public.fleet_driver_counts() to authenticated;
-- ============ MANAGERS CAN EDIT / REMOVE EACH OTHER ============
-- A fleet manager can change another manager's name, login and password, or remove them,
-- but only inside their OWN fleet. (Your own details are changed in Settings.)
-- Safe to re-run.

create or replace function public.manager_update_manager(
  p_manager_id uuid, p_name text, p_email text, p_password text
) returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_fleet text;
  v_old_email text;
  v_email text;
begin
  if not public.current_is_manager() then raise exception 'Only fleet managers can do this'; end if;
  if p_manager_id = auth.uid() then raise exception 'Change your own details in Settings'; end if;
  select fleet_code, email into v_fleet, v_old_email
    from public.profiles where id = p_manager_id and role = 'manager';
  if v_fleet is null or v_fleet <> public.current_fleet_code() then
    raise exception 'Manager not found in your fleet';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name cannot be empty'; end if;
  v_email := lower(trim(coalesce(p_email, '')));
  if v_email = '' then v_email := lower(v_old_email); end if;
  if position('@' in v_email) < 2 then raise exception 'The login must look like name@gmail.com'; end if;

  if v_email <> lower(v_old_email) then
    if exists (select 1 from auth.users where lower(email) = v_email and id <> p_manager_id) then
      raise exception 'That login is already used by someone else';
    end if;
    update auth.users
       set email = v_email, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
     where id = p_manager_id;
    update auth.identities
       set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_email)), updated_at = now()
     where user_id = p_manager_id and provider = 'email';
  end if;

  if coalesce(p_password, '') <> '' then
    if length(p_password) < 8 then raise exception 'Password must be at least 8 characters'; end if;
    update auth.users
       set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now()
     where id = p_manager_id;
    delete from auth.sessions where user_id = p_manager_id;   -- signed out everywhere
  end if;

  update public.profiles set name = trim(p_name), email = v_email where id = p_manager_id;
  update public.fleets set manager_name = trim(p_name) where manager_id = p_manager_id;
end;
$$;
revoke all on function public.manager_update_manager(uuid, text, text, text) from public, anon;
grant execute on function public.manager_update_manager(uuid, text, text, text) to authenticated;

create or replace function public.manager_remove_manager(p_manager_id uuid) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_fleet text;
  v_me_name text;
begin
  if not public.current_is_manager() then raise exception 'Only fleet managers can do this'; end if;
  if p_manager_id = auth.uid() then raise exception 'You cannot remove yourself'; end if;
  select fleet_code into v_fleet from public.profiles where id = p_manager_id and role = 'manager';
  if v_fleet is null or v_fleet <> public.current_fleet_code() then
    raise exception 'Manager not found in your fleet';
  end if;
  -- The fleet row is tied to the manager who created it: hand it to the person removing them first,
  -- otherwise deleting that login would delete the whole fleet (trucks, inspections, everything).
  select name into v_me_name from public.profiles where id = auth.uid();
  update public.fleets set manager_id = auth.uid(), manager_name = v_me_name where manager_id = p_manager_id;
  delete from auth.users where id = p_manager_id;   -- their profile goes with it
end;
$$;
revoke all on function public.manager_remove_manager(uuid) from public, anon;
grant execute on function public.manager_remove_manager(uuid) to authenticated;
-- ============ FLEET SAFETY NETS ============
-- 1. Deleting someone's login can never delete a fleet (it used to cascade: delete the creating manager -> fleet, trucks, inspections gone).
-- 2. A fleet can never lose its LAST manager (by delete, demotion or moving fleets), even if two managers remove each other at the same moment.
-- 3. A fleet can't be deleted by accident. (To delete one ON PURPOSE, run `select set_config('app.allow_fleet_delete','yes', true);` in the same transaction first.)
-- If a fleet ever ends up with no manager anyway, a new manager can sign up with the fleet code + manager security code ("Join my fleet").
-- Safe to re-run.

-- 1) fleet no longer dies with its creator's login
alter table public.fleets alter column manager_id drop not null;
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.fleets'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass
  loop
    execute format('alter table public.fleets drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.fleets
  add constraint fleets_manager_id_fkey foreign key (manager_id) references auth.users(id) on delete set null;

-- 2) never lose the last manager
create or replace function public.protect_last_manager() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'manager'
     and (tg_op = 'DELETE' or new.role <> 'manager' or new.fleet_code is distinct from old.fleet_code) then
    if coalesce(current_setting('app.allow_fleet_delete', true), '') = 'yes' then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    -- one at a time per fleet, so two managers removing each other can't both succeed
    perform pg_advisory_xact_lock(hashtext('fleet-managers:' || old.fleet_code));
    if not exists (select 1 from public.profiles
                   where fleet_code = old.fleet_code and role = 'manager' and id <> old.id) then
      raise exception 'A fleet must always keep at least one manager';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists protect_last_manager_trg on public.profiles;
create trigger protect_last_manager_trg
  before delete or update of role, fleet_code on public.profiles
  for each row execute function public.protect_last_manager();

-- 3) no accidental fleet deletion
create or replace function public.protect_fleet_delete() returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.allow_fleet_delete', true), '') <> 'yes' then
    raise exception 'Fleets cannot be deleted (this would erase all its trucks, inspections and videos)';
  end if;
  return old;
end;
$$;
drop trigger if exists protect_fleet_delete_trg on public.fleets;
create trigger protect_fleet_delete_trg
  before delete on public.fleets
  for each row execute function public.protect_fleet_delete();
