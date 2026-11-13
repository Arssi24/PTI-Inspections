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
