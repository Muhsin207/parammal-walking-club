grant usage on schema public to authenticated;
grant select, insert on public.profiles to authenticated;
grant update (monthly_goal) on public.profiles to authenticated;

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id and is_admin = false);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, monthly_goal, is_admin)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), 'Member'), 80),
    30,
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (id, display_name, monthly_goal, is_admin)
select
  users.id,
  left(coalesce(nullif(trim(users.raw_user_meta_data->>'display_name'), ''), 'Member'), 80),
  30,
  false
from auth.users users
on conflict (id) do nothing;
