-- Fix: guard_profile_update was SECURITY DEFINER, so inside it current_user was the function owner
-- (postgres), never 'authenticated', and a taker could promote themselves to admin.
-- Run it as the caller instead. is_admin() is itself SECURITY DEFINER, so it still reads profiles.

create or replace function public.guard_profile_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'role cannot be changed' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.email is distinct from old.email then
      raise exception 'profile id and email cannot be changed' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
