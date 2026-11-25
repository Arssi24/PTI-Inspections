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
