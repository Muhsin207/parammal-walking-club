create or replace function public.get_weekly_topper()
returns table (
  display_name text,
  total_km numeric,
  week_start date,
  week_end date
)
language sql
stable
security definer
set search_path = ''
as $function$
  with week_bounds as (
    select date_trunc('week', now() at time zone 'Asia/Kolkata')::date as start_date
  ),
  member_totals as (
    select
      p.id,
      p.display_name,
      sum(w.km) as total_km,
      bounds.start_date
    from public.walk_logs w
    join public.profiles p on p.id = w.member_id
    cross join week_bounds bounds
    where w.date >= bounds.start_date
      and w.date < bounds.start_date + 7
    group by p.id, p.display_name, bounds.start_date
  ),
  best_total as (
    select max(total_km) as total_km
    from member_totals
  )
  select
    totals.display_name,
    round(totals.total_km, 2),
    totals.start_date,
    totals.start_date + 6
  from member_totals totals
  join best_total best using (total_km)
  order by totals.display_name;
$function$;

revoke all on function public.get_weekly_topper() from public;
grant execute on function public.get_weekly_topper() to anon, authenticated;
