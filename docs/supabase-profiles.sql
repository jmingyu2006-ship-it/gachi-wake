-- 같이 일어나요 — 방 프로필 (supabase-rooms.sql 다음에 실행, 여러 번 실행해도 안전)
-- 방에 하나라도 들어가 있는 사람만 목표 시각과 최근 66일 하루 시작 기록을 올릴 수 있고,
-- 같은 방 사람에게만 보여요. 기기 번호는 여전히 아무에게도 돌려주지 않아요.

create table if not exists public.member_profiles (
  anon_id    uuid primary key,
  target_min smallint check (target_min between 240 and 720),
  updated_at timestamptz not null default now()
);
alter table public.member_profiles enable row level security;
revoke all on public.member_profiles from anon, authenticated;

-- 목표 시각 + 최근 기록 올리기 (방에 들어가 있을 때만)
create or replace function public.sync_profile(p_anon uuid, p_target int, p_starts json)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
  it json; d date; mn int;
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  if not exists (select 1 from room_members where anon_id = p_anon) then return false; end if;
  if p_target is not null then
    if p_target not between 240 and 720 then raise exception 'bad_request' using errcode = 'P0001'; end if;
    insert into member_profiles (anon_id, target_min, updated_at) values (p_anon, p_target, now())
      on conflict (anon_id) do update set target_min = excluded.target_min, updated_at = now();
  end if;
  if p_starts is not null and json_typeof(p_starts) = 'array' then
    if json_array_length(p_starts) > 70 then raise exception 'bad_request' using errcode = 'P0001'; end if;
    for it in select value from json_array_elements(p_starts) loop
      begin
        d := (it ->> 'd')::date; mn := (it ->> 'm')::int;
      exception when others then d := null; mn := null;
      end;
      if d is not null and d between today - 66 and today + 1 and mn between 240 and 839 then
        insert into room_starts (anon_id, day, start_min) values (p_anon, d, mn) on conflict do nothing;
      end if;
    end loop;
  end if;
  return true;
end; $$;

-- 방 보기: 멤버마다 오늘 시각 + 프로필(목표, 들어온 날, 연속 일수, 최근 7일, 최근 30일 기록 수)
-- 연속 일수: 오늘 기록이 있으면 오늘부터, 없으면 어제부터 거꾸로 이어진 날 수 (오늘이 끝나기 전엔 끊기지 않음)
create or replace function public.room_view(p_anon uuid, p_code text, p_day date)
returns json language sql stable security definer set search_path = public as $$
  select case when not exists (select 1 from room_members where room_code = lower(trim(p_code)) and anon_id = p_anon) then null
  else (
    select json_build_object(
      'code', r.code, 'name', r.name,
      'members', coalesce((
        select json_agg(json_build_object(
          'nickname', m.nickname,
          'me', m.anon_id = p_anon,
          'start_min', (select s.start_min from room_starts s where s.anon_id = m.anon_id and s.day = p_day),
          'target_min', (select pr.target_min from member_profiles pr where pr.anon_id = m.anon_id),
          'joined', to_char(m.joined_at at time zone 'Asia/Seoul', 'YYYY-MM-DD'),
          'week', (select json_agg(s2.start_min order by k.k) from generate_series(0, 6) k(k)
                   left join room_starts s2 on s2.anon_id = m.anon_id and s2.day = p_day - 6 + k.k),
          'days30', (select count(*) from room_starts s3 where s3.anon_id = m.anon_id and s3.day between p_day - 29 and p_day),
          'streak', (
            with a as (select case when exists (select 1 from room_starts x where x.anon_id = m.anon_id and x.day = p_day)
                                   then p_day else p_day - 1 end as a),
                 t as (select s4.day, row_number() over (order by s4.day desc) as rn
                       from room_starts s4, a where s4.anon_id = m.anon_id and s4.day <= a.a and s4.day > a.a - 400)
            select count(*) from t, a where (a.a - t.day) = t.rn - 1)
        ) order by m.joined_at, m.nickname)
        from room_members m where m.room_code = r.code), '[]'::json))
    from rooms r where r.code = lower(trim(p_code))
  ) end;
$$;

revoke all on function public.sync_profile(uuid, int, json) from public, authenticated;
grant execute on function public.sync_profile(uuid, int, json) to anon;
revoke all on function public.room_view(uuid, text, date) from public, authenticated;
grant execute on function public.room_view(uuid, text, date) to anon;
