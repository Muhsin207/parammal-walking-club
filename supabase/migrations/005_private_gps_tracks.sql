alter table public.walk_logs
  add column if not exists gps_path jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'walk_logs_gps_path_valid'
      and conrelid = 'public.walk_logs'::regclass
  ) then
    alter table public.walk_logs
      add constraint walk_logs_gps_path_valid
      check (
        gps_path is null or case
          when jsonb_typeof(gps_path) = 'array'
            then jsonb_array_length(gps_path) between 2 and 2000
          else false
        end
      );
  end if;
end;
$$;
