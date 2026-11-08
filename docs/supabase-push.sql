-- 같이 일어나요 v0.8 — 푸시 알림(선택) + 잘못 누른 기록 취소 (supabase-rests.sql 다음에 실행, 여러 번 실행해도 안전)
-- 알림: 아침(목표 시각, 이미 하루를 시작했으면 안 보냄), 잘 시간(취침 30분 전). 둘 다 켜는 사람만.
-- 알림 서명 키(VAPID)는 send-reminders 함수가 처음 실행될 때 스스로 만들어 여기 보관해요. 개인 키는 밖으로 나가지 않아요.

create table if not exists private.push_keys (
  id            int primary key default 1 check (id = 1),
  vapid_public  text,
  vapid_private text,
  cron_secret   text not null default encode(extensions.gen_random_bytes(24), 'hex')
);
insert into private.push_keys (id) values (1) on conflict do nothing;
revoke all on private.push_keys from public, anon, authenticated;

create table if not exists private.push_subs (
  id            bigserial primary key,
  anon_id       uuid not null,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  morning       boolean not null default true,
  bedtime       boolean not null default false,
  weekdays_only boolean not null default false,
  baseline_min  int not null,
  target_min    int not null,
  plan_start    date not null,
  sleep_h       int not null,
  last_morning  date,
  last_bedtime  date,
  last_test     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists push_subs_anon_idx on private.push_subs (anon_id);
revoke all on private.push_subs from public, anon, authenticated;

-- 앱과 같은 단계 목표 계산 (3일마다 15분, 30분 이내면 바로 목표)
create or replace function private.plan_target(b int, t int, ps date, d date)
returns int language sql immutable set search_path = '' as $$
  select case when b - t <= 30 then t else greatest(t, b - 15 * (1 + floor(greatest(0, d - ps) / 3.0)::int)) end;
$$;

-- 알림 켜기·설정 바꾸기 (같은 기기 구독은 덮어씀). 브라우저 푸시 서버 주소만 받음
create or replace function public.save_push(p_anon uuid, p_sub jsonb, p_prefs jsonb)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare ep text := p_sub ->> 'endpoint'; k1 text := p_sub #>> '{keys,p256dh}'; k2 text := p_sub #>> '{keys,auth}';
        b int; t int; ps date; sh int; n int;
begin
  if p_anon is null or ep is null or length(ep) > 1000
     or ep !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
     or k1 !~ '^[A-Za-z0-9_-]{80,100}$' or k2 !~ '^[A-Za-z0-9_-]{16,30}$' then
    return json_build_object('error', 'bad_subscription');
  end if;
  begin
    b := (p_prefs ->> 'baselineMin')::int; t := (p_prefs ->> 'targetMin')::int; ps := (p_prefs ->> 'planStart')::date; sh := (p_prefs ->> 'sleepH')::int;
  exception when others then return json_build_object('error', 'bad_prefs'); end;
  if b not between 240 and 835 or t not between 240 and 720 or sh not between 5 and 11 or ps is null then return json_build_object('error', 'bad_prefs'); end if;
  if not exists (select 1 from private.push_subs where endpoint = ep) then
    select count(*) into n from private.push_subs where anon_id = p_anon;
    if n >= 5 then return json_build_object('error', 'too_many'); end if;
  end if;
  insert into private.push_subs (anon_id, endpoint, p256dh, auth, morning, bedtime, weekdays_only, baseline_min, target_min, plan_start, sleep_h)
  values (p_anon, ep, k1, k2, coalesce((p_prefs ->> 'morning')::boolean, true), coalesce((p_prefs ->> 'bedtime')::boolean, false),
          coalesce((p_prefs ->> 'weekdaysOnly')::boolean, false), b, t, ps, sh)
  on conflict (endpoint) do update set anon_id = excluded.anon_id, p256dh = excluded.p256dh, auth = excluded.auth,
    morning = excluded.morning, bedtime = excluded.bedtime, weekdays_only = excluded.weekdays_only,
    baseline_min = excluded.baseline_min, target_min = excluded.target_min, plan_start = excluded.plan_start, sleep_h = excluded.sleep_h,
    updated_at = now();
  return json_build_object('ok', true);
end; $$;

create or replace function public.delete_push(p_anon uuid, p_endpoint text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare n int;
begin
  delete from private.push_subs where anon_id = p_anon and endpoint = p_endpoint;
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'deleted', n);
end; $$;

-- ---------- send-reminders 함수 전용 (service_role만) ----------
create or replace function public.push_config()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('vapid_public', vapid_public, 'vapid_private', vapid_private, 'cron_secret', cron_secret) from private.push_keys where id = 1;
$$;
create or replace function public.push_set_vapid(p_pub text, p_priv text)
returns json language plpgsql volatile security definer set search_path = '' as $$
begin
  update private.push_keys set vapid_public = p_pub, vapid_private = p_priv where id = 1 and vapid_public is null;
  return public.push_config();
end; $$;

-- 지금(5분 단위 실행) 보낼 알림을 고르고, 같은 날 두 번 가지 않게 표시까지 한 번에
create or replace function public.push_claim_due(p_now timestamptz default now())
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare ts timestamp := p_now at time zone 'Asia/Seoul'; d date := ts::date; m int := extract(hour from ts)::int * 60 + extract(minute from ts)::int;
        a json; b json;
begin
  with upd as (
    update private.push_subs s set last_morning = d
     where s.morning
       and (not s.weekdays_only or extract(isodow from d) <= 5)
       and s.last_morning is distinct from d
       and private.plan_target(s.baseline_min, s.target_min, s.plan_start, d) between m - 9 and m
       and not exists (select 1 from public.wake_events w where w.anon_id = s.anon_id and w.day = d)
    returning s.id, s.endpoint, s.p256dh, s.auth, private.plan_target(s.baseline_min, s.target_min, s.plan_start, d) as tmin
  ) select coalesce(json_agg(json_build_object('kind', 'morning', 'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth, 'target', tmin)), '[]') into a from upd;
  -- 잘 시간: 다음 날 아침 목표 - 수면 시간 - 30분. 저녁(12시 이후)이면 내일 아침 기준, 자정 넘어가면 오늘 아침 기준
  with c as (
    select s.id, x.mday, x.bt, private.plan_target(s.baseline_min, s.target_min, s.plan_start, x.mday) as tmin
      from private.push_subs s,
      lateral (values (d + 1, private.plan_target(s.baseline_min, s.target_min, s.plan_start, d + 1) - s.sleep_h * 60 - 30 + 1440),
                      (d,     private.plan_target(s.baseline_min, s.target_min, s.plan_start, d) - s.sleep_h * 60 - 30)) x(mday, bt)
     where s.bedtime and ((x.mday = d + 1 and x.bt between 720 and 1439) or (x.mday = d and x.bt between 0 and 719))
       and x.bt between m - 9 and m
       and (not s.weekdays_only or extract(isodow from x.mday) <= 5)
       and s.last_bedtime is distinct from x.mday
  ), upd2 as (
    update private.push_subs s set last_bedtime = c.mday from c where s.id = c.id
    returning s.endpoint, s.p256dh, s.auth, c.tmin, s.sleep_h
  ) select coalesce(json_agg(json_build_object('kind', 'bedtime', 'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth, 'target', tmin, 'sleep', sleep_h)), '[]') into b from upd2;
  return (select coalesce(json_agg(e), '[]') from (select json_array_elements(a) e union all select json_array_elements(b)) z);
end; $$;

create or replace function public.push_gone(p_endpoint text)
returns void language sql volatile security definer set search_path = '' as $$
  delete from private.push_subs where endpoint = p_endpoint;
$$;

-- 테스트 알림: 본인 구독만, 20초에 한 번
create or replace function public.push_for_test(p_anon uuid, p_endpoint text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare r private.push_subs%rowtype;
begin
  update private.push_subs set last_test = now()
   where anon_id = p_anon and endpoint = p_endpoint and (last_test is null or last_test < now() - interval '20 seconds')
  returning * into r;
  if r.id is null then return null; end if;
  return json_build_object('kind', 'test', 'endpoint', r.endpoint, 'p256dh', r.p256dh, 'auth', r.auth);
end; $$;

-- ---------- 잘못 누른 기록 취소 (오늘, 누른 지 15분 안) ----------
create or replace function public.undo_start(p_anon uuid, p_day date)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare today date := (now() at time zone 'Asia/Seoul')::date; a int; b int;
begin
  if p_anon is null or p_day is distinct from today then return json_build_object('error', 'bad_request'); end if;
  delete from wake_events where anon_id = p_anon and day = p_day and created_at > now() - interval '15 minutes';
  get diagnostics a = row_count;
  delete from room_starts where anon_id = p_anon and day = p_day;
  get diagnostics b = row_count;
  return json_build_object('ok', true, 'wakes', a, 'starts', b);
end; $$;

-- 서버에 있는 내 기록 지우기에 알림 구독도 포함
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
  delete from private.push_subs where anon_id = p_anon;
  return json_build_object('ok', true, 'rooms_left', a, 'starts', b, 'profiles', c, 'wakes', e);
end; $$;

-- 기능 목록 + 알림 공개 키 (공개 키는 공개돼도 되는 값)
create or replace function public.app_info()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('v', 8, 'features', json_build_array('report', 'recovery', 'erase', 'rests', 'undo', 'push'),
                           'vapid', (select vapid_public from private.push_keys where id = 1));
$$;

revoke all on function public.save_push(uuid, jsonb, jsonb), public.delete_push(uuid, text), public.undo_start(uuid, date),
  public.delete_my_data(uuid), public.app_info(), public.push_config(), public.push_set_vapid(text, text),
  public.push_claim_due(timestamptz), public.push_gone(text), public.push_for_test(uuid, text) from public, anon, authenticated;
grant execute on function public.save_push(uuid, jsonb, jsonb), public.delete_push(uuid, text), public.undo_start(uuid, date),
  public.delete_my_data(uuid), public.app_info() to anon;
grant execute on function public.push_config(), public.push_set_vapid(text, text), public.push_claim_due(timestamptz),
  public.push_gone(text), public.push_for_test(uuid, text) to service_role;
revoke all on function private.plan_target(int, int, date, date) from public, anon, authenticated;
