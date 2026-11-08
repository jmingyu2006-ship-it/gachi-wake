-- 같이 일어나요 v0.6 — 운영·이용자 보호 (supabase-nickname.sql 다음에 실행, 여러 번 실행해도 안전)
-- 1) 의견·신고·오류 수집 (운영자만 봄)  2) 비밀번호 복구 코드  3) 서버에 있는 내 기록 지우기
-- 4) 오래된 기록 자동 정리 (개인정보 처리방침의 보유 기간)  5) 앱이 쓸 수 있는 기능 알려주기
-- 채팅 기능은 없어요. 신고·의견은 운영자에게만 가고 다른 사용자에게는 보이지 않아요.

-- ---------- 1) 의견·신고·오류 ----------
create table if not exists private.reports (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('feedback', 'report', 'error')),
  anon_id     uuid,
  room_code   text,
  target_key  text,
  target_name text,           -- 신고 당시 이름 (나중에 바꿔도 기록이 남게)
  reason      text,
  body        text,
  meta        text,
  ip_hash     text,
  status      text not null default 'new'   -- 운영자가 'done' 등으로 바꿔 씀
);
create index if not exists reports_ip_time_idx on private.reports (ip_hash, created_at);
create index if not exists reports_new_idx on private.reports (status, created_at);
revoke all on private.reports from public, anon, authenticated;

-- 같은 네트워크에서 하루 의견·신고 20건, 오류 30건까지
create or replace function public.send_report(p_anon uuid, p_kind text, p_body text, p_room text, p_target text, p_reason text, p_meta text)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare d date := (now() at time zone 'Asia/Seoul')::date; h text := private.req_ip_hash(d); n int; tname text;
        c text := lower(trim(coalesce(p_room, ''))); b text := left(trim(coalesce(p_body, '')), 1000);
begin
  if p_kind is null or p_kind not in ('feedback', 'report', 'error') then return json_build_object('error', 'bad_request'); end if;
  if p_kind = 'feedback' and char_length(b) = 0 then return json_build_object('error', 'empty'); end if;
  select count(*) into n from private.reports
   where ip_hash is not distinct from h and created_at > now() - interval '1 day' and (kind = 'error') = (p_kind = 'error');
  if n >= (case when p_kind = 'error' then 30 else 20 end) then return json_build_object('error', 'rate_limited'); end if;
  if p_kind = 'report' then
    if p_anon is null or not private.is_active_member(c, p_anon) then return json_build_object('error', 'not_member'); end if;
    select m.nickname into tname from room_members m where m.room_code = c and private.member_key(m.anon_id, c) = p_target;
    if tname is null then return json_build_object('error', 'member_not_found'); end if;
  end if;
  insert into private.reports (kind, anon_id, room_code, target_key, target_name, reason, body, meta, ip_hash)
  values (p_kind, p_anon, nullif(c, ''), case when p_kind = 'report' then p_target end, tname,
          left(p_reason, 40), nullif(b, ''), left(p_meta, 2000), h);
  return json_build_object('ok', true);
end; $$;

-- ---------- 2) 비밀번호 복구 코드 ----------
-- 가입할 때 한 번 보여주는 12자리 코드. bcrypt 해시로만 저장. 쓰면 새 코드로 바뀜.
alter table private.accounts add column if not exists recovery_hash text;

create or replace function private.new_recovery_code()
returns text language plpgsql volatile set search_path = '' as $$
declare a text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; b bytea := extensions.gen_random_bytes(12); v text := ''; i int;
begin
  for i in 0..11 loop
    v := v || substr(a, (get_byte(b, i) % 31) + 1, 1);
    if i in (3, 7) then v := v || '-'; end if;
  end loop;
  return v;
end; $$;

create or replace function public.set_recovery_code(p_anon uuid, p_password text)
returns json language plpgsql volatile security definer set search_path = public, private, extensions as $$
declare acc private.accounts%rowtype; code text;
begin
  select * into acc from private.accounts where anon_id = p_anon and closed_at is null;
  if acc.username is null then return json_build_object('error', 'not_linked'); end if;
  if p_password is null or acc.pw_hash <> extensions.crypt(p_password, acc.pw_hash) then return json_build_object('error', 'wrong_credentials'); end if;
  code := private.new_recovery_code();
  update private.accounts set recovery_hash = extensions.crypt(replace(code, '-', ''), extensions.gen_salt('bf', 10)), updated_at = now()
   where anon_id = p_anon;
  return json_build_object('ok', true, 'recovery_code', code);
end; $$;

-- 복구 코드로 새 비밀번호 정하기. 틀리면 로그인 실패와 같은 횟수에 더해짐 (하루 10번이면 잠김)
create or replace function public.reset_password(p_username text, p_code text, p_new_password text)
returns json language plpgsql volatile security definer set search_path = public, private, extensions as $$
declare u text := lower(trim(coalesce(p_username, ''))); d date := (now() at time zone 'Asia/Seoul')::date;
        acc private.accounts%rowtype; f int; code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); nc text;
begin
  perform private.count_attempt();
  select n into f from private.login_fails where username = u and day = d;
  if coalesce(f, 0) >= 10 then return json_build_object('error', 'locked'); end if;
  if p_new_password is null or char_length(p_new_password) not between 8 and 64 then return json_build_object('error', 'bad_password'); end if;
  select * into acc from private.accounts where username = u and closed_at is null;
  if acc.username is null or acc.recovery_hash is null or char_length(code) <> 12
     or acc.recovery_hash <> extensions.crypt(code, acc.recovery_hash) then
    insert into private.login_fails as lf (username, day, n) values (u, d, 1)
      on conflict (username, day) do update set n = lf.n + 1;
    return json_build_object('error', 'wrong_code');
  end if;
  nc := private.new_recovery_code();
  update private.accounts set pw_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)),
         recovery_hash = extensions.crypt(replace(nc, '-', ''), extensions.gen_salt('bf', 10)), updated_at = now()
   where username = u;
  return json_build_object('ok', true, 'username', u, 'anon_id', acc.anon_id, 'data', acc.data, 'recovery_code', nc);
end; $$;

-- ---------- 3) 서버에 있는 내 기록 지우기 ----------
-- 모든 방에서 나가고(빈 방은 함께 삭제), 방 기록·프로필·전체 창문 기록을 지움. 계정은 따로 (계정 삭제 기능).
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
  delete from member_profiles where anon_id = p_anon;
  get diagnostics c = row_count;
  delete from wake_events where anon_id = p_anon;
  get diagnostics e = row_count;
  return json_build_object('ok', true, 'rooms_left', a, 'starts', b, 'profiles', c, 'wakes', e);
end; $$;

-- ---------- 4) 오래된 기록 정리 ----------
create or replace function private.purge_old()
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare t date := (now() at time zone 'Asia/Seoul')::date; a int; b int; c int; e int; f int; g int;
begin
  delete from private.room_attempts where day < t - 7;          get diagnostics a = row_count;
  delete from private.login_fails where day < t - 7;            get diagnostics b = row_count;
  update public.wake_events set ip_hash = null where ip_hash is not null and day < t - 30;  get diagnostics c = row_count;
  delete from public.wake_events where day < t - 365;           get diagnostics e = row_count;
  update private.reports set ip_hash = null where ip_hash is not null and created_at < now() - interval '90 days';  get diagnostics f = row_count;
  delete from private.reports where created_at < now() - interval '1 year';  get diagnostics g = row_count;
  return json_build_object('room_attempts', a, 'login_fails', b, 'wake_ip_cleared', c, 'wake_deleted', e, 'report_ip_cleared', f, 'report_deleted', g);
end; $$;

-- ---------- 5) 앱이 쓸 수 있는 기능 ----------
create or replace function public.app_info()
returns json language sql stable set search_path = '' as $$
  select json_build_object('v', 6, 'features', json_build_array('report', 'recovery', 'erase'));
$$;

revoke all on function public.send_report(uuid, text, text, text, text, text, text), public.set_recovery_code(uuid, text),
  public.reset_password(text, text, text), public.delete_my_data(uuid), public.app_info() from public, anon, authenticated;
grant execute on function public.send_report(uuid, text, text, text, text, text, text), public.set_recovery_code(uuid, text),
  public.reset_password(text, text, text), public.delete_my_data(uuid), public.app_info() to anon;
revoke all on function private.purge_old(), private.new_recovery_code() from public, anon, authenticated;
