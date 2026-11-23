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
