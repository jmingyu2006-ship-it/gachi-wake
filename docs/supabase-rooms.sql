-- 같이 일어나요 — '우리 방' (supabase.sql 다음에 실행, 여러 번 실행해도 안전)
-- 방 안에서는 닉네임과 하루 시작 시각(분)이 같은 방 사람에게만 보여요.
-- 앱은 테이블에 직접 접근하지 않고 아래 함수들만 불러요. 기기 번호(anon_id)는 절대 다른 사람에게 돌려주지 않아요.

create table if not exists public.rooms (
  code       text primary key check (code ~ '^[a-z2-9]{6}$'),
  name       text not null check (char_length(name) between 1 and 20),
  ip_hash    text,
  created_at timestamptz not null default now()
);
create table if not exists public.room_members (
  room_code  text not null references public.rooms(code) on delete cascade,
  anon_id    uuid not null,
  nickname   text not null check (char_length(nickname) between 1 and 10),
  joined_at  timestamptz not null default now(),
  primary key (room_code, anon_id)
);
create index if not exists room_members_anon_idx on public.room_members (anon_id);
create table if not exists public.room_starts (
  anon_id    uuid not null,
  day        date not null,
  start_min  smallint not null check (start_min between 240 and 839),
  created_at timestamptz not null default now(),
  primary key (anon_id, day)
);
create table if not exists private.room_attempts (
  ip_hash text not null,
  day     date not null,
  n       int not null default 0,
  primary key (ip_hash, day)
);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_starts enable row level security;
revoke all on public.rooms, public.room_members, public.room_starts from anon, authenticated;

-- 요청한 쪽 IP의 그날 해시 (IP 자체는 저장 안 함)
create or replace function private.req_ip_hash(p_day date)
returns text language sql stable security definer set search_path = private as $$
  select case when ip = '' then null else md5(ip || p_day::text || (select salt from private.app_secret where id = 1)) end
  from (select trim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)) as ip) t;
$$;

-- 초대 코드 확인·참여 시도는 같은 네트워크에서 하루 60번까지 (코드 무작위 대입 방지)
create or replace function private.count_attempt()
returns void language plpgsql security definer set search_path = private as $$
declare d date := (now() at time zone 'Asia/Seoul')::date; h text := private.req_ip_hash(d); c int;
begin
  if h is null then return; end if;
  insert into private.room_attempts as a (ip_hash, day, n) values (h, d, 1)
    on conflict (ip_hash, day) do update set n = a.n + 1 returning n into c;
  if c > 60 then raise exception 'rate_limited' using errcode = 'P0001'; end if;
end; $$;

create or replace function private.clean_text(p text, p_max int, p_err text)
returns text language plpgsql immutable set search_path = '' as $$
declare t text := regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g');
begin
  if t ~ '[<>[:cntrl:]]' or char_length(t) < 1 or char_length(t) > p_max then
    raise exception '%', p_err using errcode = 'P0001';
  end if;
  return t;
end; $$;

-- 방 만들기 → 초대 코드
create or replace function public.create_room(p_anon uuid, p_name text, p_nickname text)
returns text language plpgsql volatile security definer set search_path = public, private as $$
declare
  alphabet text := 'abcdefghjkmnpqrstuvwxyz23456789';
  d date := (now() at time zone 'Asia/Seoul')::date;
  h text := private.req_ip_hash(d);
  nm text := private.clean_text(p_name, 20, 'bad_room_name');
  nk text := private.clean_text(p_nickname, 10, 'bad_nickname');
  r text; v text; i int; tries int := 0;
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  if (select count(*) from room_members where anon_id = p_anon) >= 10 then raise exception 'too_many_rooms' using errcode = 'P0001'; end if;
  if h is not null and (select count(*) from rooms where ip_hash = h) >= 10 then raise exception 'rate_limited' using errcode = 'P0001'; end if;
  loop
    r := replace(gen_random_uuid()::text, '-', '');
    v := '';
    for i in 0..5 loop
      v := v || substr(alphabet, (('x' || substr(r, i * 2 + 1, 2))::bit(8)::int % 31) + 1, 1);
    end loop;
    begin
      insert into rooms (code, name, ip_hash) values (v, nm, h);
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;
  insert into room_members (room_code, anon_id, nickname) values (v, p_anon, nk);
  return v;
end; $$;

-- 초대 링크를 열었을 때: 방 이름과 인원만 (멤버 이름은 들어가야 보임)
-- 틀린 코드는 오류를 던지지 않고 결과로 돌려준다. 오류를 던지면 시도 횟수 기록까지 되돌려져 무작위 대입을 셀 수 없기 때문.
create or replace function public.room_preview(p_code text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare res json;
begin
  perform private.count_attempt();
  select json_build_object('name', r.name, 'members', (select count(*) from room_members m where m.room_code = r.code))
    into res from rooms r where r.code = lower(trim(p_code));
  return coalesce(res, json_build_object('error', 'room_not_found'));
end; $$;

-- 방 들어가기 (이미 들어가 있으면 닉네임만 바꿈)
create or replace function public.join_room(p_anon uuid, p_code text, p_nickname text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare c text := lower(trim(p_code)); nk text := private.clean_text(p_nickname, 10, 'bad_nickname'); nm text;
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  perform private.count_attempt();
  select name into nm from rooms where code = c;
  if nm is null then return json_build_object('error', 'room_not_found'); end if;
  if exists (select 1 from room_members where room_code = c and anon_id = p_anon) then
    update room_members set nickname = nk where room_code = c and anon_id = p_anon;
  else
    if (select count(*) from room_members where room_code = c) >= 50 then return json_build_object('error', 'room_full'); end if;
    if (select count(*) from room_members where anon_id = p_anon) >= 10 then return json_build_object('error', 'too_many_rooms'); end if;
    insert into room_members (room_code, anon_id, nickname) values (c, p_anon, nk);
  end if;
  return json_build_object('code', c, 'name', nm);
end; $$;

-- 방 나가기 (마지막 사람이 나가면 방도 지움)
create or replace function public.leave_room(p_anon uuid, p_code text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare c text := lower(trim(p_code));
begin
  delete from room_members where room_code = c and anon_id = p_anon;
  if not exists (select 1 from room_members where room_code = c) then delete from rooms where code = c; end if;
  return true;
end; $$;

-- 하루 시작 기록 (방에 하나라도 들어가 있을 때만 저장, 첫 기록이 그대로 남음)
create or replace function public.room_start(p_anon uuid, p_day date, p_min int)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if p_anon is null or p_day not between today - 1 and today + 1 or p_min not between 240 and 839 then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;
  if not exists (select 1 from room_members where anon_id = p_anon) then return false; end if;
  insert into room_starts (anon_id, day, start_min) values (p_anon, p_day, p_min) on conflict do nothing;
  return true;
end; $$;

-- 방 보기: 들어가 있는 사람만. 닉네임·그날 시작 시각·나인지 여부 (기기 번호는 안 돌려줌)
create or replace function public.room_view(p_anon uuid, p_code text, p_day date)
returns json language sql stable security definer set search_path = public as $$
  select case when not exists (select 1 from room_members where room_code = lower(trim(p_code)) and anon_id = p_anon) then null
  else (
    select json_build_object(
      'code', r.code, 'name', r.name,
      'members', coalesce((
        select json_agg(json_build_object('nickname', m.nickname, 'start_min', s.start_min, 'me', m.anon_id = p_anon) order by m.joined_at, m.nickname)
        from room_members m left join room_starts s on s.anon_id = m.anon_id and s.day = p_day
        where m.room_code = r.code), '[]'::json))
    from rooms r where r.code = lower(trim(p_code))
  ) end;
$$;

revoke all on function public.create_room(uuid, text, text), public.room_preview(text), public.join_room(uuid, text, text),
  public.leave_room(uuid, text), public.room_start(uuid, date, int), public.room_view(uuid, text, date) from public;
grant execute on function public.create_room(uuid, text, text), public.room_preview(text), public.join_room(uuid, text, text),
  public.leave_room(uuid, text), public.room_start(uuid, date, int), public.room_view(uuid, text, date) to anon;
revoke all on function private.req_ip_hash(date), private.count_attempt(), private.clean_text(text, int, text) from public, anon, authenticated;
-- 로그인 사용자 기능은 쓰지 않으므로 authenticated 실행 권한은 거둔다 (익명 앱용 anon만)
revoke execute on function public.create_room(uuid, text, text), public.room_preview(text), public.join_room(uuid, text, text),
  public.leave_room(uuid, text), public.room_start(uuid, date, int), public.room_view(uuid, text, date), public.day_counts(date)
  from authenticated;
