create or replace function public.get_public_leaderboard()
returns table (
  display_name text,
  weekly_km numeric,
  weekly_walks bigint,
  all_time_km numeric,
  all_time_walks bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  with week_bounds as (
    select date_trunc('week', now() at time zone 'Asia/Kolkata')::date as start_date
  ),
  leaderboard as (
    select
      p.id,
      p.display_name,
      coalesce(round(sum(w.km) filter (
        where w.date >= bounds.start_date
          and w.date < bounds.start_date + 7
      ), 2), 0) as weekly_km,
      count(w.id) filter (
        where w.date >= bounds.start_date
          and w.date < bounds.start_date + 7
      ) as weekly_walks,
      coalesce(round(sum(w.km), 2), 0) as all_time_km,
      count(w.id) as all_time_walks
    from public.profiles p
    cross join week_bounds bounds
    left join public.walk_logs w on w.member_id = p.id
    group by p.id, p.display_name, bounds.start_date
    having count(w.id) > 0
  )
  select
    board.display_name,
    board.weekly_km,
    board.weekly_walks,
    board.all_time_km,
    board.all_time_walks
  from leaderboard board
  order by board.weekly_km desc, board.all_time_km desc, board.display_name;
$function$;

revoke all on function public.get_public_leaderboard() from public;
grant execute on function public.get_public_leaderboard() to anon, authenticated;
