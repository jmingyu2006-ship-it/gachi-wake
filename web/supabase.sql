-- 같이 일어나요 v0.2 — 공유 서버 (Supabase SQL Editor에 그대로 붙여 넣고 실행, 여러 번 실행해도 안전)
-- 저장하는 것: 익명 기기 번호, 날짜, 30분 구간, (스팸 방지용) 그날만 쓰는 IP 해시.
-- 이름·이메일·정확한 시각·위치는 저장하지 않아요.

create table if not exists public.wake_events (
  anon_id    uuid      not null,
  day        date      not null,
  bucket     smallint  not null check (bucket between 8 and 27),  -- 04:00(8) ~ 13:30(27)
  ip_hash    text,
  created_at timestamptz not null default now(),
  primary key (anon_id, day)                                      -- 기기당 하루 1건
);
alter table public.wake_events add column if not exists ip_hash text;
create index if not exists wake_events_day_idx on public.wake_events (day);
create index if not exists wake_events_ip_idx on public.wake_events (day, ip_hash);

alter table public.wake_events enable row level security;

-- 익명 사용자는 '오늘 전후 하루'의 기록을 쓰기만 할 수 있고, 다른 사람 기록은 읽을 수 없어요.
drop policy if exists "anon can insert recent day" on public.wake_events;
create policy "anon can insert recent day" on public.wake_events
  for insert to anon
  with check (day between (now() at time zone 'Asia/Seoul')::date - 1
                      and (now() at time zone 'Asia/Seoul')::date + 1);

revoke all on public.wake_events from anon, authenticated;
grant insert on public.wake_events to anon;

-- 스팸 방지: 같은 인터넷 주소(IP)에서 하루 30건 넘게 들어오면 거절 (기숙사·학교 와이파이 고려해 넉넉히)
-- IP는 저장하지 않고, 날짜와 비밀 값을 섞은 해시만 남겨요. 비밀 값은 처음 실행할 때 무작위로 만들어져요.
create schema if not exists private;
create table if not exists private.app_secret (id int primary key default 1, salt text not null);
insert into private.app_secret (id, salt) values (1, md5(random()::text || clock_timestamp()::text))
  on conflict (id) do nothing;
revoke all on schema private from anon, authenticated;

create or replace function public.wake_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  ip text;
  recent int;
begin
  ip := trim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1));
  if ip <> '' then
    new.ip_hash := md5(ip || new.day::text || (select salt from private.app_secret where id = 1));
    select count(*) into recent from public.wake_events where day = new.day and ip_hash = new.ip_hash;
    if recent >= 30 then
      raise exception 'too many starts from this network today' using errcode = 'P0001';
    end if;
  end if;
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists wake_events_guard on public.wake_events;
create trigger wake_events_guard before insert on public.wake_events
  for each row execute function public.wake_events_guard();
revoke all on function public.wake_events_guard() from public, anon, authenticated;

-- 앱이 읽는 건 이 함수 하나: 그날 30분 구간별 인원 수 (합계만, 개별 기록은 안 나감)
create or replace function public.day_counts(p_day date)
returns table (bucket smallint, n bigint)
language sql
stable
security definer
set search_path = public
as $$
  select w.bucket, count(*)::bigint as n
  from public.wake_events w
  where w.day = p_day
  group by w.bucket
  order by w.bucket;
$$;

revoke all on function public.day_counts(date) from public;
grant execute on function public.day_counts(date) to anon;

-- (선택) 90일 지난 기록 지우기 — Supabase의 pg_cron을 켠 경우
-- select cron.schedule('gachi-cleanup', '0 4 * * *',
--   $$delete from public.wake_events where day < current_date - 90$$);
