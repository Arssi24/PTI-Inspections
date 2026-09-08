-- Run this ONCE in the Supabase SQL Editor (your project -> SQL Editor -> New query -> paste -> Run).
-- Adds: fleet managers can switch which fleet code their dashboard shows, and can start a
-- new fleet, without signing up again. Safe to re-run. Already folded into schema.sql too.

alter table public.fleets add column if not exists name text;

create or replace function public.set_active_fleet(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if public.current_is_manager() is not true then
    raise exception 'Only fleet managers can switch fleets';
  end if;
  select code into v_code from public.fleets where code = upper(trim(p_code));
  if v_code is null then
    raise exception 'Fleet code not found';
  end if;
  update public.profiles set fleet_code = v_code where id = auth.uid();
  return v_code;
end;
$$;

create or replace function public.create_fleet(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate text;
  v_attempt int := 0;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_mgr_name text;
begin
  if public.current_is_manager() is not true then
    raise exception 'Only fleet managers can create a fleet';
  end if;
  select name into v_mgr_name from public.profiles where id = auth.uid();
  loop
    v_attempt := v_attempt + 1;
    v_candidate := 'F';
    for i in 1..5 loop
      v_candidate := v_candidate || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    begin
      insert into public.fleets (code, manager_id, manager_name, name)
      values (v_candidate, auth.uid(), coalesce(v_mgr_name, ''), nullif(trim(p_name), ''));
      exit;
    exception when unique_violation then
      if v_attempt >= 6 then
        raise exception 'Could not generate a unique fleet code, try again';
      end if;
    end;
  end loop;
  update public.profiles set fleet_code = v_candidate where id = auth.uid();
  return v_candidate;
end;
$$;

grant execute on function public.set_active_fleet(text) to authenticated;
grant execute on function public.create_fleet(text) to authenticated;
