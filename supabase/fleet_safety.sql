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
