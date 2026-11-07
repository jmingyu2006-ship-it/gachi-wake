-- 같이 일어나요 · 방 이름(닉네임) 바꾸기
-- supabase-owner-accounts.sql 다음에 실행

-- p_all = true 이면 내가 들어가 있는 모든 방에서, 아니면 그 방에서만 바꿈. 바뀐 방 수를 돌려줌.
create or replace function public.set_nickname(p_anon uuid, p_code text, p_nickname text, p_all boolean)
returns json language plpgsql volatile security definer set search_path = public, private as $$
declare c text := lower(trim(coalesce(p_code, ''))); nk text := private.clean_text(p_nickname, 10, 'bad_nickname'); n int;
begin
  if p_anon is null then raise exception 'bad_request' using errcode = 'P0001'; end if;
  if not coalesce(p_all, false) and not private.is_active_member(c, p_anon) then return json_build_object('error', 'not_member'); end if;
  update room_members m set nickname = nk
   where m.anon_id = p_anon
     and (coalesce(p_all, false) or m.room_code = c)
     and private.is_active_member(m.room_code, p_anon);
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'nickname', nk, 'rooms', n);
end; $$;

revoke all on function public.set_nickname(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.set_nickname(uuid, text, text, boolean) to anon, authenticated;
