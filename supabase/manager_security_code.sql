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
