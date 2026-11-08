-- 같이 일어나요 v0.7 — 보호권(쉬는 날)을 방 연속 기록에 반영 (supabase-care.sql 다음에 실행, 여러 번 실행해도 안전)
-- 보호권: 기록 7일마다 1개(최대 2개). 하루 빠지면 앱이 자동으로 써서 연속 기록을 이어 줘요.
-- 쉬는 날은 연속 일수에 더하지 않고 '끊기지 않게'만 해요. 방 친구에게는 그날 칸이 방패로 보여요.

create table if not exists public.member_rests (
  anon_id    uuid not null,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (anon_id, day)
);
alter table public.member_rests enable row level security;
revoke all on public.member_rests from anon, authenticated;

-- 쉬는 날 올리기: 방에 들어가 있을 때만, 최근 66일 안의 지난 날, 기록이 없는 날만. 한 번에 최대 20일
create or replace function public.sync_rests(p_anon uuid, p_days json)
returns boolean language plpgsql volatile security definer set search_path = public, private as $$
declare today date := (now() at time zone 'Asia/Seoul')::date; it json; d date;
begin
  if p_anon is null or p_days is null or json_typeof(p_days) <> 'array' or json_array_length(p_days) > 20 then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;
  if not exists (select 1 from room_members m where m.anon_id = p_anon and private.is_active_member(m.room_code, p_anon)) then return false; end if;
  for it in select value from json_array_elements(p_days) loop
    begin d := (it #>> '{}')::date; exception when others then d := null; end;
    if d is not null and d between today - 66 and today - 1
       and not exists (select 1 from room_starts s where s.anon_id = p_anon and s.day = d) then
      insert into member_rests (anon_id, day) values (p_anon, d) on conflict do nothing;
    end if;
  end loop;
  return true;
end; $$;

-- 방 보기: 주간 칸에서 쉬는 날은 -1, 연속 일수는 쉬는 날을 건너뛰며 셈
create or replace function public.room_view(p_anon uuid, p_code text, p_day date)
returns json language sql stable security definer set search_path = public as $$
  select case when not private.is_active_member(lower(trim(p_code)), p_anon) then null
  else (
    select json_build_object(
      'code', r.code, 'name', r.name, 'owner_me', private.room_owner(r.code) = p_anon,
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

-- 서버에 있는 내 기록 지우기에 쉬는 날도 포함
create or replace function public.delete_my_data(p_anon uuid)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare codes text[]; a int; b int; c int; e int;
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  select array_agg(room_code) into codes from room_members where anon_id = p_anon;
  delete from room_members where anon_id = p_anon;
  get diagnostics a = row_count;
  delete from rooms r where r.code = any(coalesce(codes, '{}'::text[]))
     and not exists (select 1 from room_members m where m.room_code = r.code and private.is_active_member(r.code, m.anon_id));
  delete from room_starts where anon_id = p_anon;
  get diagnostics b = row_count;
  delete from member_rests where anon_id = p_anon;
  delete from member_profiles where anon_id = p_anon;
  get diagnostics c = row_count;
  delete from wake_events where anon_id = p_anon;
  get diagnostics e = row_count;
  return json_build_object('ok', true, 'rooms_left', a, 'starts', b, 'profiles', c, 'wakes', e);
end; $$;

create or replace function public.app_info()
returns json language sql stable set search_path = '' as $$
  select json_build_object('v', 7, 'features', json_build_array('report', 'recovery', 'erase', 'rests'));
$$;

revoke all on function public.sync_rests(uuid, json), public.room_view(uuid, text, date), public.delete_my_data(uuid), public.app_info()
  from public, anon, authenticated;
grant execute on function public.sync_rests(uuid, json), public.room_view(uuid, text, date), public.delete_my_data(uuid), public.app_info() to anon;
