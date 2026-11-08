-- 같이 일어나요 v0.10 — 방 주간 목표(각자 몇 번) 방장이 조정 (supabase-together.sql 다음에 실행)
alter table public.rooms add column if not exists week_goal smallint not null default 4 check (week_goal between 1 and 7);

create or replace function public.set_room_goal(p_anon uuid, p_code text, p_n int)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare c text := lower(trim(coalesce(p_code, '')));
begin
  if p_n is null or p_n not between 1 and 7 then return json_build_object('error', 'bad_request'); end if;
  if private.room_owner(c) is distinct from p_anon then return json_build_object('error', 'not_owner'); end if;
  update rooms set week_goal = p_n where code = c;
  return json_build_object('ok', true, 'week_goal', p_n);
end; $$;

create or replace function public.room_view(p_anon uuid, p_code text, p_day date)
returns json language sql stable security definer set search_path = public as $$
  select case when not private.is_active_member(lower(trim(p_code)), p_anon) then null
  else (
    select json_build_object(
      'code', r.code, 'name', r.name, 'owner_me', private.room_owner(r.code) = p_anon, 'week_goal', r.week_goal,
      'members', coalesce((
        select json_agg(json_build_object(
          'key', private.member_key(m.anon_id, r.code),
          'nickname', m.nickname,
          'me', m.anon_id = p_anon,
          'owner', m.anon_id = private.room_owner(r.code),
          'start_min', (select s.start_min from room_starts s where s.anon_id = m.anon_id and s.day = p_day),
          'target_min', (select pr.target_min from member_profiles pr where pr.anon_id = m.anon_id),
          'joined', to_char(m.joined_at at time zone 'Asia/Seoul', 'YYYY-MM-DD'),
          'week', (select json_agg(coalesce(s2.start_min, case when r2.day is not null then -1 end) order by k.k)
                   from generate_series(0, 6) k(k)
                   left join room_starts s2 on s2.anon_id = m.anon_id and s2.day = p_day - 6 + k.k
                   left join member_rests r2 on r2.anon_id = m.anon_id and r2.day = p_day - 6 + k.k),
          'days30', (select count(*) from room_starts s3 where s3.anon_id = m.anon_id and s3.day between p_day - 29 and p_day),
          'streak', (
            with a as (select case when exists (select 1 from room_starts x where x.anon_id = m.anon_id and x.day = p_day)
                                   then p_day else p_day - 1 end as a),
                 u as (select s4.day, true as st from room_starts s4 where s4.anon_id = m.anon_id
                       union all
                       select r4.day, false from member_rests r4 where r4.anon_id = m.anon_id
                         and not exists (select 1 from room_starts y where y.anon_id = m.anon_id and y.day = r4.day)),
                 t as (select u.day, u.st, row_number() over (order by u.day desc) as rn
                       from u, a where u.day <= a.a and u.day > a.a - 400)
            select count(*) filter (where t.st) from t, a where (a.a - t.day) = t.rn - 1)
        ) order by m.joined_at, m.nickname)
        from room_members m where m.room_code = r.code
          and not exists (select 1 from room_bans b where b.room_code = r.code and b.anon_id = m.anon_id)), '[]'::json))
    from rooms r where r.code = lower(trim(p_code))
  ) end;
$$;

revoke all on function public.set_room_goal(uuid, text, int), public.room_view(uuid, text, date) from public, anon, authenticated;
grant execute on function public.set_room_goal(uuid, text, int), public.room_view(uuid, text, date) to anon;
