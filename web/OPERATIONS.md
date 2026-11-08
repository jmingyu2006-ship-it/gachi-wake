# 같이 일어나요 · 운영 안내

운영자(사업자)가 매주 보면 좋은 숫자, 신고·문의 처리, 개인정보 요청, 정리 작업, 비용 한도를 모았어요.
아래 SQL은 모두 **Supabase 대시보드 → SQL Editor**에서 실행해요. 읽기 전용 쿼리는 몇 번 실행해도 안전해요.

---

## 1. 매주 보는 숫자

### 하루 사용자 (하루 시작을 누른 기기 수, 최근 30일)
```sql
select day, count(*) as 사용자
from public.wake_events
where day >= (now() at time zone 'Asia/Seoul')::date - 30
group by day order by day desc;
```

### 새로 온 기기와 다시 온 비율 (D1·D7 리텐션)
처음 누른 날 기준으로, 다음 날(D1)과 6~8일 뒤(D7)에 또 누른 비율이에요.
```sql
with f as (select anon_id, min(day) as d0 from public.wake_events group by anon_id)
select d0 as 첫날, count(*) as 새기기,
  round(100.0 * count(*) filter (where exists (select 1 from public.wake_events w where w.anon_id = f.anon_id and w.day = f.d0 + 1)) / count(*), 1) as "D1 %",
  round(100.0 * count(*) filter (where exists (select 1 from public.wake_events w where w.anon_id = f.anon_id and w.day between f.d0 + 6 and f.d0 + 8)) / count(*), 1) as "D7 %"
from f group by d0 order by d0 desc limit 30;
```
목표치 참고: 습관 앱은 D1 30%, D7 15%를 넘으면 괜찮은 편이에요. 가장 먼저 볼 숫자예요.

### 지난 7일 동안 며칠 기록했나 (습관이 붙는 중인지)
```sql
select n as "7일 중 기록한 날", count(*) as 기기
from (select anon_id, count(*) as n from public.wake_events
      where day > (now() at time zone 'Asia/Seoul')::date - 7 group by anon_id) t
group by n order by n;
```

### 몇 시에 일어나나 (30분 단위)
```sql
select to_char(time '00:00' + bucket * interval '30 minutes', 'HH24:MI') as 구간, count(*)
from public.wake_events where day > (now() at time zone 'Asia/Seoul')::date - 7
group by bucket order by bucket;
```

### 우리 방 (친구 기능을 실제로 쓰는지)
```sql
select count(*) as 방,
  count(*) filter (where n >= 2) as "2명 이상 방",
  round(avg(n), 1) as 평균인원,
  (select count(distinct anon_id) from public.room_members) as 방에_있는_사람,
  (select count(*) from private.accounts where closed_at is null) as 계정
from (select r.code, count(m.anon_id) as n from public.rooms r left join public.room_members m on m.room_code = r.code group by r.code) t;
```
방에 든 사람의 리텐션이 혼자 쓰는 사람보다 높으면, 친구 초대를 더 앞에 보여주는 게 맞아요.

### 첫 방문 → 설정 → 첫 기록 → 다음 날 (익명 단계 집계)
기기 번호 없이 날짜·단계별 숫자만 세요. 한 기기는 각 단계를 한 번만 세요.
```sql
select step, sum(n) as 기기수 from public.funnel_daily
where day >= (now() at time zone 'Asia/Seoul')::date - 14
group by step order by array_position(array['visit','invite_visit','demo','setup','first','day2','week1','room','push_on','weather_on','cheer'], step);
```
- `visit`→`setup`이 낮으면 첫 화면·설정 단계가 어려운 거예요. `setup`→`first`가 낮으면 첫 아침까지 이어지지 않는 거라 알림 예약을 더 앞에 보여 주세요.
- `first`→`day2`가 리텐션의 핵심이에요. `invite_visit`(초대 링크로 온 첫 방문)과 `room`도 같이 보면 친구 초대의 효과를 알 수 있어요.

### 응원
```sql
select day, count(*) as 응원, count(distinct from_anon) as 보낸사람 from public.room_cheers group by day order by day desc limit 14;
```

---

## 2. 신고·의견·오류 확인 (앱 안 '의견·문의 보내기', '신고하기', 화면 오류)

### 새로 들어온 것
```sql
select id, created_at at time zone 'Asia/Seoul' as 시각, kind, room_code, target_name, reason, body, left(meta, 80) as meta
from private.reports where status = 'new' order by id desc limit 50;
```
- `kind = 'report'`: 방 안의 다른 사람 신고. `target_name`은 신고 당시 이름이에요.
- `kind = 'feedback'`: 의견·문의. 개인정보 요청도 여기로 와요(아래 4번).
- `kind = 'error'`: 앱 화면 오류 자동 보고 (기기당 페이지마다 3건까지).

### 처리했으면 표시
```sql
update private.reports set status = 'done' where id in (/* 번호 */);
```

### 신고된 사람 처리
```sql
-- 1) 누구인지 찾기 (room_code, target_key는 신고 행에 있음)
select m.room_code, m.nickname, m.anon_id from public.room_members m
where m.room_code = '방코드' and private.member_key(m.anon_id, m.room_code) = '신고의 target_key';
-- 2-a) 이름만 바꾸기
update public.room_members set nickname = '이름 변경됨' where room_code = '방코드' and anon_id = '찾은 anon_id';
-- 2-b) 그 방에서 내보내기 (다시 못 들어옴)
insert into public.room_bans (room_code, anon_id) values ('방코드', '찾은 anon_id') on conflict do nothing;
```

---

## 2-1. 푸시 알림 상태

```sql
-- 알림을 켠 기기 수와 종류
select count(*) as 기기, count(*) filter (where morning) as 아침, count(*) filter (where bedtime) as 잘시간, count(*) filter (where weekdays_only) as 평일만
from private.push_subs;
-- 최근 발송 결과 (5분마다 실행, 응답은 몇 시간 보관)
select created, status_code, left(content::text, 120) from net._http_response order by id desc limit 10;
-- 예약 작업
select jobname, schedule, active from cron.job;
```
`results`에 `gone`이 보이면 그 기기가 알림 권한을 꺼서 구독이 자동으로 지워진 거예요.

## 3. 정리 작업 (개인정보 처리방침의 보유 기간)

`supabase-cron.sql`을 실행했다면 매일 새벽 04:10에 자동으로 돌아요. 확인:
```sql
select jobname, schedule, active from cron.job;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
```
자동 정리를 못 켰다면 **한 달에 한 번** 직접 실행:
```sql
select private.purge_old();
```
지우는 것: 7일 지난 시도·로그인 실패 횟수, 30일 지난 IP 해시, 1년 지난 창문 기록, 90일 지난 신고의 IP 해시, 1년 지난 의견·신고·오류.

### 1년 넘게 안 쓴 계정 (처리방침: 미리 알린 뒤 정리 가능)
```sql
select username, updated_at from private.accounts
where closed_at is null and updated_at < now() - interval '1 year';
```

---

## 4. 개인정보 요청 처리 (보기·지우기)

사용자는 앱 설정 맨 아래의 **기기 번호 앞 8자리**를 알려 줘요. 앱 안에서 직접 할 수 있는 것(기록 지우기, 서버 기록 지우기, 방 나가기, 이름 바꾸기, 계정 삭제)을 먼저 안내하고, 안 되면:
```sql
-- 기기 번호 찾기
select distinct anon_id from (
  select anon_id from public.wake_events union all select anon_id from public.room_members
  union all select anon_id from public.member_profiles union all select anon_id from private.accounts
) t where anon_id::text like '앞8자리%';
-- 서버의 방·창문 기록 지우기 (계정은 그대로)
select public.delete_my_data('찾은 anon_id');
```
처리방침상 **10일 안에** 처리해야 해요.

---

## 5. 비용·한도 (Supabase 무료 요금제, 2026년 11월 확인)

| 항목 | 무료 한도 | 이 앱에서 |
|---|---|---|
| 데이터베이스 | 500 MB | 기록 1건이 아주 작아서 수만 명까지 여유 |
| 전송량(egress) | 월 5 GB | 앱을 켜 둔 동안 30초마다 합계 1번(화면이 꺼지면 멈춤). 하루 1,000명이 10분씩 켜 두면 월 1 GB 안팎 |
| 일시 정지 | 1주일 동안 요청이 없으면 멈춤 | 매일 쓰는 사람이 있으면 해당 없음. 멈추면 대시보드에서 Restore |
| 백업 | **자동 백업 없음** | 아래처럼 직접 백업 |

**백업**: 실제 사용자가 늘면 Pro(월 $25, 매일 백업 7일 보관)로 올리는 걸 권해요. 그 전까지는 한 달에 한 번 Supabase CLI로 받아 두세요.
```
supabase db dump --db-url "대시보드 → Connect에 있는 주소" -f backup.sql
```

---

## 6. 배포 체크리스트

1. `web/sw.js`의 `VERSION` 올리기 (열려 있던 앱이 새 버전을 알아챔)
2. `SITE_URL=https://jmingyu2006-ship-it.github.io/gachi-wake/ node build.js`
3. 테스트: `TZ=Asia/Seoul node --test test/logic.test.js` 와 브라우저 테스트들
4. `rm -rf docs && cp -r dist/web docs` 후 커밋·푸시 → GitHub Actions의 Pages 배포 성공 확인
5. 처리방침·약관을 바꿨다면 시행일을 고치고, 앱 안에서 7일 전에 알리기

---

## 7. 다음에 하면 좋은 것 (성장·수익)

- **푸시 알림**: 지금은 캘린더 알림이에요. 홈 화면에 추가한 아이폰(iOS 16.4+)·안드로이드는 웹 푸시가 되므로, Supabase Edge Function + 매분 cron으로 '목표 시각 알림'을 보낼 수 있어요. 리텐션에 가장 큰 영향을 줄 기능이에요.
- **첫 방문→첫 기록 전환율**: 이름 없는 하루 방문 수만 세는 기능을 추가하면 온보딩 개선 효과를 잴 수 있어요.
- **수익화(사용자 경험을 해치지 않는 순서)**: ① 기록 이미지 테마·창문 색 같은 꾸미기(소액 결제), ② 학원·스터디·기숙사용 '단체 방'(인원 50명 이상, 출석 리포트) 유료, ③ 아침 시간대 광고는 '하루 시작' 순간을 방해하므로 넣지 않는 걸 권해요.
- **유료화하면** 통신판매업 신고, 사업자등록, 환불 정책, 처리방침의 결제 항목 추가가 필요해요.
