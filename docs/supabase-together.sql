-- 같이 일어나요 v0.9 — 응원(정해진 이모지만, 채팅 아님)·초대 미리보기·참여 요일 알림·익명 단계 집계
-- (supabase-push.sql 다음에 실행, 여러 번 실행해도 안전)

-- ---------- 응원: 불 켠 방 친구에게 ☀️/👏/🔥 중 하나. 글은 못 씀. 한 사람에게 하루 한 번(바꿀 수는 있음) ----------
create table if not exists public.room_cheers (
  room_code  text not null references public.rooms(code) on delete cascade,
  from_anon  uuid not null,
  to_anon    uuid not null,
  day        date not null,
  kind       smallint not null check (kind between 1 and 3),
  created_at timestamptz not null default now(),
  primary key (room_code, from_anon, to_anon, day)
);
create index if not exists room_cheers_to_idx on public.room_cheers (to_anon, day);
alter table public.room_cheers enable row level security;
revoke all on public.room_cheers from anon, authenticated;

create or replace function public.send_cheer(p_anon uuid, p_code text, p_key text, p_kind int)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare c text := lower(trim(coalesce(p_code, ''))); today date := (now() at time zone 'Asia/Seoul')::date; target uuid;
begin
  if p_anon is null or p_kind is null or p_kind not between 1 and 3 then return json_build_object('error', 'bad_request'); end if;
  if not private.is_active_member(c, p_anon) then return json_build_object('error', 'not_member'); end if;
  select m.anon_id into target from room_members m where m.room_code = c and private.member_key(m.anon_id, c) = p_key and private.is_active_member(c, m.anon_id);
  if target is null then return json_build_object('error', 'member_not_found'); end if;
  if target = p_anon then return json_build_object('error', 'cannot_cheer_self'); end if;
  if not exists (select 1 from room_starts s where s.anon_id = target and s.day = today) then return json_build_object('error', 'not_lit'); end if;
  insert into room_cheers (room_code, from_anon, to_anon, day, kind) values (c, p_anon, target, today, p_kind)
    on conflict (room_code, from_anon, to_anon, day) do update set kind = excluded.kind, created_at = now();
  return json_build_object('ok', true);
end; $$;

-- 오늘 이 방에서: 내가 받은 응원(보낸 사람 이름·종류), 내가 보낸 응원(멤버 키별 종류)
create or replace function public.cheers_today(p_anon uuid, p_code text, p_day date)
returns json language sql stable security definer set search_path = public, private as $$
  select case when not private.is_active_member(lower(trim(p_code)), p_anon) then null else json_build_object(
    'got', coalesce((select json_agg(json_build_object('name', m.nickname, 'kind', ch.kind, 'key', private.member_key(ch.from_anon, ch.room_code)) order by ch.created_at)
             from room_cheers ch join room_members m on m.room_code = ch.room_code and m.anon_id = ch.from_anon
             where ch.room_code = lower(trim(p_code)) and ch.to_anon = p_anon and ch.day = p_day
               and private.is_active_member(ch.room_code, ch.from_anon)), '[]'::json),
    'sent', coalesce((select json_object_agg(private.member_key(ch.to_anon, ch.room_code), ch.kind)
             from room_cheers ch where ch.room_code = lower(trim(p_code)) and ch.from_anon = p_anon and ch.day = p_day), '{}'::json)
  ) end;
$$;

-- ---------- 초대 미리보기: 방 이름·인원 + 오늘 켜진 수 ----------
create or replace function public.room_preview(p_code text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare res json; today date := (now() at time zone 'Asia/Seoul')::date;
begin
  perform private.count_attempt();
  select json_build_object('name', r.name,
           'members', (select count(*) from room_members m where m.room_code = r.code and private.is_active_member(r.code, m.anon_id)),
           'lit', (select count(*) from room_members m where m.room_code = r.code and private.is_active_member(r.code, m.anon_id)
                     and exists (select 1 from room_starts s where s.anon_id = m.anon_id and s.day = today)))
    into res from rooms r where r.code = lower(trim(p_code));
  return coalesce(res, json_build_object('error', 'room_not_found'));
end; $$;

-- ---------- 알림: 참여 요일 (비트 0=일 … 6=토, 기본 매일) ----------
alter table private.push_subs add column if not exists days_mask int not null default 127;

create or replace function public.save_push(p_anon uuid, p_sub jsonb, p_prefs jsonb)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare ep text := p_sub ->> 'endpoint'; k1 text := p_sub #>> '{keys,p256dh}'; k2 text := p_sub #>> '{keys,auth}';
        b int; t int; ps date; sh int; n int; mask int := 0; it jsonb;
begin
  if p_anon is null or ep is null or length(ep) > 1000
     or ep !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
     or k1 !~ '^[A-Za-z0-9_-]{80,100}$' or k2 !~ '^[A-Za-z0-9_-]{16,30}$' then
    return json_build_object('error', 'bad_subscription');
  end if;
  begin
    b := (p_prefs ->> 'baselineMin')::int; t := (p_prefs ->> 'targetMin')::int; ps := (p_prefs ->> 'planStart')::date; sh := (p_prefs ->> 'sleepH')::int;
    if jsonb_typeof(p_prefs -> 'days') = 'array' then
      for it in select value from jsonb_array_elements(p_prefs -> 'days') loop
        if (it #>> '{}')::int between 0 and 6 then mask := mask | (1 << (it #>> '{}')::int); end if;
      end loop;
    else mask := 127; end if;
  exception when others then return json_build_object('error', 'bad_prefs'); end;
  if mask = 0 then mask := 127; end if;
  if b not between 240 and 835 or t not between 240 and 835 or sh not between 5 and 11 or ps is null then return json_build_object('error', 'bad_prefs'); end if;
  if not exists (select 1 from private.push_subs where endpoint = ep) then
    select count(*) into n from private.push_subs where anon_id = p_anon;
    if n >= 5 then return json_build_object('error', 'too_many'); end if;
  end if;
  insert into private.push_subs (anon_id, endpoint, p256dh, auth, morning, bedtime, weekdays_only, baseline_min, target_min, plan_start, sleep_h, days_mask)
  values (p_anon, ep, k1, k2, coalesce((p_prefs ->> 'morning')::boolean, true), coalesce((p_prefs ->> 'bedtime')::boolean, false),
          coalesce((p_prefs ->> 'weekdaysOnly')::boolean, false), b, t, ps, sh, mask)
  on conflict (endpoint) do update set anon_id = excluded.anon_id, p256dh = excluded.p256dh, auth = excluded.auth,
    morning = excluded.morning, bedtime = excluded.bedtime, weekdays_only = excluded.weekdays_only,
    baseline_min = excluded.baseline_min, target_min = excluded.target_min, plan_start = excluded.plan_start, sleep_h = excluded.sleep_h,
    days_mask = excluded.days_mask, updated_at = now();
  return json_build_object('ok', true);
end; $$;

create or replace function public.push_claim_due(p_now timestamptz default now())
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare ts timestamp := p_now at time zone 'Asia/Seoul'; d date := ts::date; m int := extract(hour from ts)::int * 60 + extract(minute from ts)::int;
        a json; b json;
begin
  with upd as (
    update private.push_subs s set last_morning = d
     where s.morning
       and (not s.weekdays_only or extract(isodow from d) <= 5)
       and (s.days_mask >> (extract(dow from d)::int)) & 1 = 1
       and s.last_morning is distinct from d
       and private.plan_target(s.baseline_min, s.target_min, s.plan_start, d) between m - 9 and m
       and not exists (select 1 from public.wake_events w where w.anon_id = s.anon_id and w.day = d)
    returning s.id, s.endpoint, s.p256dh, s.auth, private.plan_target(s.baseline_min, s.target_min, s.plan_start, d) as tmin
  ) select coalesce(json_agg(json_build_object('kind', 'morning', 'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth, 'target', tmin)), '[]') into a from upd;
  with c as (
    select s.id, x.mday, x.bt, private.plan_target(s.baseline_min, s.target_min, s.plan_start, x.mday) as tmin
      from private.push_subs s,
      lateral (values (d + 1, private.plan_target(s.baseline_min, s.target_min, s.plan_start, d + 1) - s.sleep_h * 60 - 30 + 1440),
                      (d,     private.plan_target(s.baseline_min, s.target_min, s.plan_start, d) - s.sleep_h * 60 - 30)) x(mday, bt)
     where s.bedtime and ((x.mday = d + 1 and x.bt between 720 and 1439) or (x.mday = d and x.bt between 0 and 719))
       and x.bt between m - 9 and m
       and (not s.weekdays_only or extract(isodow from x.mday) <= 5)
       and (s.days_mask >> (extract(dow from x.mday)::int)) & 1 = 1
       and s.last_bedtime is distinct from x.mday
  ), upd2 as (
    update private.push_subs s set last_bedtime = c.mday from c where s.id = c.id
    returning s.endpoint, s.p256dh, s.auth, c.tmin, s.sleep_h
  ) select coalesce(json_agg(json_build_object('kind', 'bedtime', 'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth, 'target', tmin, 'sleep', sleep_h)), '[]') into b from upd2;
  return (select coalesce(json_agg(e), '[]') from (select json_array_elements(a) e union all select json_array_elements(b)) z);
end; $$;

-- ---------- 익명 단계 집계: 기기 번호 없이 날짜·단계별 숫자만 ----------
create table if not exists public.funnel_daily (
  day  date not null,
  step text not null check (step in ('visit', 'invite_visit', 'demo', 'setup', 'first', 'day2', 'week1', 'room', 'push_on', 'weather_on', 'cheer')),
  n    int not null default 0,
  primary key (day, step)
);
alter table public.funnel_daily enable row level security;
revoke all on public.funnel_daily from anon, authenticated;

create or replace function public.bump_funnel(p_step text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if p_step is null or p_step not in ('visit', 'invite_visit', 'demo', 'setup', 'first', 'day2', 'week1', 'room', 'push_on', 'weather_on', 'cheer') then return false; end if;
  insert into funnel_daily as f (day, step, n) values ((now() at time zone 'Asia/Seoul')::date, p_step, 1)
    on conflict (day, step) do update set n = f.n + 1;
  return true;
end; $$;

-- ---------- 지우기·정리에 응원 포함 ----------
create or replace function public.delete_my_data(p_anon uuid)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare codes text[]; a int; b int; c int; e int;
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  select array_agg(room_code) into codes from room_members where anon_id = p_anon;
  delete from room_cheers where from_anon = p_anon or to_anon = p_anon;
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

create or replace function private.purge_old()
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare t date := (now() at time zone 'Asia/Seoul')::date; a int; b int; c int; e int; f int; g int; h int;
begin
  delete from private.room_attempts where day < t - 7;          get diagnostics a = row_count;
  delete from private.login_fails where day < t - 7;            get diagnostics b = row_count;
  update public.wake_events set ip_hash = null where ip_hash is not null and day < t - 30;  get diagnostics c = row_count;
  delete from public.wake_events where day < t - 365;           get diagnostics e = row_count;
  update private.reports set ip_hash = null where ip_hash is not null and created_at < now() - interval '90 days';  get diagnostics f = row_count;
  delete from private.reports where created_at < now() - interval '1 year';  get diagnostics g = row_count;
  delete from public.room_cheers where day < t - 30;            get diagnostics h = row_count;
  return json_build_object('room_attempts', a, 'login_fails', b, 'wake_ip_cleared', c, 'wake_deleted', e, 'report_ip_cleared', f, 'report_deleted', g, 'cheers_deleted', h);
end; $$;

create or replace function public.app_info()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('v', 9, 'features', json_build_array('report', 'recovery', 'erase', 'rests', 'undo', 'push', 'cheer', 'funnel', 'days'),
                           'vapid', (select vapid_public from private.push_keys where id = 1));
$$;

revoke all on function public.send_cheer(uuid, text, text, int), public.cheers_today(uuid, text, date), public.room_preview(text),
  public.save_push(uuid, jsonb, jsonb), public.bump_funnel(text), public.delete_my_data(uuid), public.app_info(),
  public.push_claim_due(timestamptz) from public, anon, authenticated;
grant execute on function public.send_cheer(uuid, text, text, int), public.cheers_today(uuid, text, date), public.room_preview(text),
  public.save_push(uuid, jsonb, jsonb), public.bump_funnel(text), public.delete_my_data(uuid), public.app_info() to anon;
grant execute on function public.push_claim_due(timestamptz) to service_role;
revoke all on function private.purge_old() from public, anon, authenticated;
