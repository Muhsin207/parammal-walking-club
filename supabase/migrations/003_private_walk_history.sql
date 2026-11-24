revoke select on public.walk_logs from anon, public;
grant select on public.walk_logs to authenticated;

alter table public.walk_logs enable row level security;

create index if not exists walk_logs_member_date_created_idx
  on public.walk_logs (member_id, date desc, created_at desc);

drop policy if exists "walk_logs_public_read" on public.walk_logs;
drop policy if exists "walk_logs_select_own" on public.walk_logs;
create policy "walk_logs_select_own" on public.walk_logs
  for select using (auth.uid() = member_id);
