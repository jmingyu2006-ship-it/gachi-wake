-- dayset v0.12 — "바로 앞에 일어난 사람" 말풍선 + "내 목표 시각(±15분)에 일어난 사람 수" (supabase-goal.sql 다음에 실행, 여러 번 실행해도 안전)
-- 전체 창문 기록에 시작 시각(분)을 함께 저장해요. 이름·위치는 여전히 저장하지 않고, 앱에는 개별 기록 대신
-- '직전 한 사람의 시각'과 '목표 근처 인원 수'만 내보내요.

alter table public.wake_events add column if not exists minute smallint;
alter table public.wake_events drop constraint if exists wake_events_minute_ok;
alter table public.wake_events add constraint wake_events_minute_ok
  check (minute is null or (minute between 240 and 839 and minute / 30 = bucket));
create index if not exists wake_events_day_min_idx on public.wake_events (day, minute);

-- p_before: 이 시각(분)까지 시작한 사람 중 가장 늦은 사람 = 나보다 바로 앞에 일어난 사람
-- p_target: 내 목표 시각. ±15분 안에 시작한 사람 수 (나는 빼고)
create or replace function public.day_pulse(p_anon uuid, p_day date, p_before int, p_target int)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prev int; near int;
begin
  if p_day is null or p_before is null or p_target is null
     or p_before not between 0 and 1439 or p_target not between 240 and 720 then
    return json_build_object('error', 'bad_input');
  end if;
  select max(w.minute) into prev from public.wake_events w
   where w.day = p_day and w.minute is not null and w.minute <= p_before
     and (p_anon is null or w.anon_id <> p_anon);
  select count(*) into near from public.wake_events w
   where w.day = p_day and w.minute between p_target - 15 and p_target + 15
     and (p_anon is null or w.anon_id <> p_anon);
  return json_build_object('prev', prev, 'near', near);
end;
$$;
revoke all on function public.day_pulse(uuid, date, int, int) from public;
grant execute on function public.day_pulse(uuid, date, int, int) to anon, authenticated;

create or replace function public.app_info()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object('v', 10, 'features', json_build_array('report', 'recovery', 'erase', 'rests', 'undo', 'push', 'cheer', 'funnel', 'days', 'pulse'),
                           'vapid', (select vapid_public from private.push_keys where id = 1));
$$;
