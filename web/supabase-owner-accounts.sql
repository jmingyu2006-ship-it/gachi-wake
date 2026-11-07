-- 같이 일어나요 — 방장(내보내기) + 아이디/비밀번호 계정 (supabase-profiles.sql 다음에 실행, 여러 번 실행해도 안전)
-- 채팅 기능은 없어요. 방장은 멤버를 내보낼 수만 있고, 내보낸 사람은 같은 방에 다시 들어올 수 없어요.
-- 데이터를 지우는 문장 없이 동작해요: 내보내기는 room_bans에 올리는 방식, 계정 삭제는 비밀번호·데이터를 비우고 아이디를 풀어주는 방식.
-- 계정은 선택이에요. 비밀번호는 bcrypt 해시로만 저장하고, 계정 테이블은 API에 노출되지 않는 private 스키마에 있어요.

-- ---------- 방장 ----------
alter table public.rooms add column if not exists owner_anon uuid;

create table if not exists public.room_bans (
  room_code  text not null references public.rooms(code) on delete cascade,
  anon_id    uuid not null,
  created_at timestamptz not null default now(),
  primary key (room_code, anon_id)
);
alter table public.room_bans enable row level security;
revoke all on public.room_bans from anon, authenticated;

-- 멤버를 가리키는 방 전용 키 (기기 번호를 드러내지 않음)
create or replace function private.member_key(p_anon uuid, p_code text)
returns text language sql stable security definer set search_path = private as $$
  select left(md5(p_anon::text || p_code || (select salt from private.app_secret where id = 1)), 12);
$$;

-- 활성 멤버 = room_members 중 room_bans(내보냄)에 없는 사람
create or replace function private.is_active_member(p_code text, p_anon uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_members m where m.room_code = p_code and m.anon_id = p_anon)
     and not exists (select 1 from public.room_bans b where b.room_code = p_code and b.anon_id = p_anon);
$$;

-- 방장: 지정된 방장이 아직 활성 멤버면 그 사람, 아니면(나갔거나 이 기능 전에 만든 방) 가장 먼저 들어온 활성 멤버
create or replace function private.room_owner(p_code text)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select r.owner_anon from public.rooms r where r.code = p_code and private.is_active_member(p_code, r.owner_anon)),
    (select m.anon_id from public.room_members m where m.room_code = p_code
       and not exists (select 1 from public.room_bans b where b.room_code = p_code and b.anon_id = m.anon_id)
     order by m.joined_at limit 1));
$$;

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
      insert into rooms (code, name, ip_hash, owner_anon) values (v, nm, h, p_anon);
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;
  insert into room_members (room_code, anon_id, nickname) values (v, p_anon, nk);
  return v;
end; $$;

create or replace function public.join_room(p_anon uuid, p_code text, p_nickname text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare c text := lower(trim(p_code)); nk text := private.clean_text(p_nickname, 10, 'bad_nickname'); nm text;
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  perform private.count_attempt();
  select name into nm from rooms where code = c;
  if nm is null then return json_build_object('error', 'room_not_found'); end if;
  if exists (select 1 from room_bans where room_code = c and anon_id = p_anon) then return json_build_object('error', 'banned'); end if;
  if exists (select 1 from room_members where room_code = c and anon_id = p_anon) then
    update room_members set nickname = nk where room_code = c and anon_id = p_anon;
  else
    if (select count(*) from room_members m where m.room_code = c and private.is_active_member(c, m.anon_id)) >= 50 then return json_build_object('error', 'room_full'); end if;
    if (select count(*) from room_members m where m.anon_id = p_anon and private.is_active_member(m.room_code, p_anon)) >= 10 then return json_build_object('error', 'too_many_rooms'); end if;
    insert into room_members (room_code, anon_id, nickname) values (c, p_anon, nk);
  end if;
  return json_build_object('code', c, 'name', nm);
end; $$;

create or replace function public.room_preview(p_code text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare res json;
begin
  perform private.count_attempt();
  select json_build_object('name', r.name, 'members',
           (select count(*) from room_members m where m.room_code = r.code and private.is_active_member(r.code, m.anon_id)))
    into res from rooms r where r.code = lower(trim(p_code));
  return coalesce(res, json_build_object('error', 'room_not_found'));
end; $$;

-- 내보내기: 방장만, 자기 자신은 안 됨. 내보낸 사람은 방에서 안 보이고 다시 못 들어옴
create or replace function public.kick_member(p_anon uuid, p_code text, p_key text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare c text := lower(trim(p_code)); target uuid;
begin
  if p_anon is null or private.room_owner(c) is distinct from p_anon then
    return json_build_object('error', 'not_owner');
  end if;
  select m.anon_id into target from room_members m where m.room_code = c and private.member_key(m.anon_id, c) = p_key
    and private.is_active_member(c, m.anon_id);
  if target is null then return json_build_object('error', 'member_not_found'); end if;
  if target = p_anon then return json_build_object('error', 'cannot_kick_self'); end if;
  insert into room_bans (room_code, anon_id) values (c, target) on conflict do nothing;
  return json_build_object('ok', true);
end; $$;

create or replace function public.room_start(p_anon uuid, p_day date, p_min int)
returns boolean language plpgsql volatile security definer set search_path = public, private as $$
declare today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if p_anon is null or p_day not between today - 1 and today + 1 or p_min not between 240 and 839 then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;
  if not exists (select 1 from room_members m where m.anon_id = p_anon and private.is_active_member(m.room_code, p_anon)) then return false; end if;
  insert into room_starts (anon_id, day, start_min) values (p_anon, p_day, p_min) on conflict do nothing;
  return true;
end; $$;

create or replace function public.sync_profile(p_anon uuid, p_target int, p_starts json)
returns boolean language plpgsql volatile security definer set search_path = public, private as $$
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
  it json; d date; mn int;
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  if not exists (select 1 from room_members m where m.anon_id = p_anon and private.is_active_member(m.room_code, p_anon)) then return false; end if;
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

-- 방 보기: 활성 멤버만. 멤버 키·방장 표시·프로필 포함 (기기 번호는 안 나감)
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
        from room_members m where m.room_code = r.code
          and not exists (select 1 from room_bans b where b.room_code = r.code and b.anon_id = m.anon_id)), '[]'::json))
    from rooms r where r.code = lower(trim(p_code))
  ) end;
$$;

-- ---------- 계정 (아이디 + 비밀번호, 선택) ----------
create table if not exists private.accounts (
  username   text primary key check (username ~ '^[a-z0-9_.]{4,20}$'),
  pw_hash    text not null,
  anon_id    uuid not null unique,
  data       jsonb,
  closed_at  timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists private.login_fails (
  username text not null,
  day      date not null,
  n        int not null default 0,
  primary key (username, day)
);

-- 가입: 지금 기기 번호를 계정에 묶고, 기기에 있던 기록을 계정에 보관
create or replace function public.sign_up(p_anon uuid, p_username text, p_password text, p_data jsonb)
returns json language plpgsql volatile security definer set search_path = public, private, extensions as $$
declare u text := lower(trim(coalesce(p_username, '')));
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  if u !~ '^[a-z0-9_.]{4,20}$' then return json_build_object('error', 'bad_username'); end if;
  if p_password is null or char_length(p_password) not between 8 and 64 then return json_build_object('error', 'bad_password'); end if;
  if p_data is not null and octet_length(p_data::text) > 200000 then return json_build_object('error', 'too_big'); end if;
  perform private.count_attempt();
  if exists (select 1 from private.accounts where username = u) then return json_build_object('error', 'username_taken'); end if;
  if exists (select 1 from private.accounts where anon_id = p_anon and closed_at is null) then return json_build_object('error', 'already_linked'); end if;
  insert into private.accounts (username, pw_hash, anon_id, data) values (u, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), p_anon, p_data)
    on conflict (anon_id) do update set username = excluded.username, pw_hash = excluded.pw_hash, data = excluded.data,
      closed_at = null, created_at = now(), updated_at = now();
  return json_build_object('ok', true, 'username', u);
end; $$;

-- 로그인: 맞으면 계정의 기기 번호와 보관한 기록을 돌려줌. 같은 아이디로 하루 10번 틀리면 그날은 잠김
-- (틀린 횟수가 되돌려지지 않도록 오류를 던지지 않고 결과로 돌려줌)
create or replace function public.sign_in(p_username text, p_password text)
returns json language plpgsql volatile security definer set search_path = public, private, extensions as $$
declare u text := lower(trim(coalesce(p_username, ''))); d date := (now() at time zone 'Asia/Seoul')::date; acc private.accounts%rowtype; f int;
begin
  perform private.count_attempt();
  select n into f from private.login_fails where username = u and day = d;
  if coalesce(f, 0) >= 10 then return json_build_object('error', 'locked'); end if;
  select * into acc from private.accounts where username = u and closed_at is null;
  if acc.username is null or p_password is null or acc.pw_hash <> extensions.crypt(p_password, acc.pw_hash) then
    insert into private.login_fails as lf (username, day, n) values (u, d, 1)
      on conflict (username, day) do update set n = lf.n + 1;
    return json_build_object('error', 'wrong_credentials');
  end if;
  return json_build_object('ok', true, 'username', acc.username, 'anon_id', acc.anon_id, 'data', acc.data);
end; $$;

create or replace function public.save_account(p_anon uuid, p_data jsonb)
returns boolean language plpgsql volatile security definer set search_path = public, private as $$
begin
  if p_anon is null or p_data is null or octet_length(p_data::text) > 200000 then raise exception 'bad_request' using errcode = 'P0001'; end if;
  update private.accounts set data = p_data, updated_at = now() where anon_id = p_anon and closed_at is null;
  return found;
end; $$;

-- 계정 삭제: 비밀번호 확인 후 비밀번호·보관 데이터를 비우고 아이디를 풀어줌 (다시 로그인 불가)
create or replace function public.close_account(p_anon uuid, p_password text)
returns json language plpgsql volatile security definer set search_path = public, private, extensions as $$
declare acc private.accounts%rowtype;
begin
  select * into acc from private.accounts where anon_id = p_anon and closed_at is null;
  if acc.username is null then return json_build_object('error', 'not_linked'); end if;
  if p_password is null or acc.pw_hash <> extensions.crypt(p_password, acc.pw_hash) then return json_build_object('error', 'wrong_credentials'); end if;
  update private.accounts set username = 'x' || left(md5(acc.username || clock_timestamp()::text), 19), pw_hash = '!', data = null,
    closed_at = now(), updated_at = now() where anon_id = p_anon;
  return json_build_object('ok', true);
end; $$;

revoke all on function public.kick_member(uuid, text, text), public.room_view(uuid, text, date), public.room_preview(text),
  public.create_room(uuid, text, text), public.join_room(uuid, text, text), public.room_start(uuid, date, int),
  public.sync_profile(uuid, int, json), public.sign_up(uuid, text, text, jsonb), public.sign_in(text, text),
  public.save_account(uuid, jsonb), public.close_account(uuid, text) from public, authenticated;
grant execute on function public.kick_member(uuid, text, text), public.room_view(uuid, text, date), public.room_preview(text),
  public.create_room(uuid, text, text), public.join_room(uuid, text, text), public.room_start(uuid, date, int),
  public.sync_profile(uuid, int, json), public.sign_up(uuid, text, text, jsonb), public.sign_in(text, text),
  public.save_account(uuid, jsonb), public.close_account(uuid, text) to anon;
revoke all on function private.member_key(uuid, text), private.room_owner(text), private.is_active_member(text, uuid) from public, anon, authenticated;
