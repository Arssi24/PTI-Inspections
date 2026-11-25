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
