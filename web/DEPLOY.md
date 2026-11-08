# 같이 일어나요 v0.2 — 로그인 없이 배포하기

이 폴더(`index.html`이 들어 있는 폴더)를 그대로 정적 웹 호스팅에 올리면 끝이에요.
사용자는 링크만 열면 되고 회원가입·로그인이 없어요. 폰에서 "홈 화면에 추가"하면 앱처럼 열리고, 인터넷이 끊겨도 열려요.

## 1. 웹에 올리기 (GitHub Pages, 무료)

1. GitHub에서 새 저장소를 만들어요 (예: `gachi-wake`, Public).
2. **Add file → Upload files**로 이 폴더 안의 파일을 모두 올려요. `index.html`이 저장소 맨 위에 있어야 해요. `icons` 폴더도 같이요.
3. **Settings → Pages**에서 Source를 `Deploy from a branch`, Branch를 `main` / `(root)`로 저장해요.
4. 잠시 뒤 `https://<내아이디>.github.io/gachi-wake/` 주소가 생겨요. 이 주소를 친구들에게 보내면 돼요.

Netlify, Cloudflare Pages, Vercel 같은 다른 정적 호스팅도 이 폴더를 그대로 올리면 동작해요. 서비스 워커와 "홈 화면에 추가"가 동작하려면 https 주소여야 해요.

## 2. (선택) 실제 사람들의 창문 켜기 — Supabase

설정하지 않으면 다른 사람 창문은 **예시 데이터**(하루 5,000명 가정)로 보여요. 실제 사용자끼리 창문을 공유하려면:

1. [supabase.com](https://supabase.com)에서 새 프로젝트를 만들어요.
2. 왼쪽 **SQL Editor**에 `supabase.sql`을 붙여 넣고 실행한 다음, `supabase-rooms.sql`(우리 방), `supabase-profiles.sql`(방 프로필), `supabase-owner-accounts.sql`(방장·계정), `supabase-nickname.sql`(이름 바꾸기), `supabase-care.sql`(의견·신고·복구 코드·서버 기록 지우기·정리), `supabase-cron.sql`(매일 자동 정리), `supabase-rests.sql`(보호권으로 쉰 날을 방 연속 기록에 반영), `supabase-push.sql`(푸시 알림·잘못 누름 취소), `supabase-together.sql`(응원·초대 미리보기·참여 요일·익명 단계 집계), `supabase-goal.sql`(방 주간 목표 조정)도 차례로 실행해요.
   푸시 알림을 쓰려면 `server/send-reminders/index.ts`를 Edge Function `send-reminders`(JWT 확인 끔)로 배포하고, pg_net을 켠 뒤 5분마다 `private.push_tick()`을 부르는 cron을 등록해요. 알림 서명 키는 함수가 처음 실행될 때 스스로 만들어 DB 비공개 영역에 보관해요.
3. **Project Settings → API**에서 `Project URL`과 `anon public` 키를 복사해요.
4. `config.js`에 붙여 넣고 다시 올려요.

```js
window.GACHI_CONFIG = {
  supabaseUrl: 'https://abcd1234.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...'
};
```

- `anon` 키는 웹에 공개돼도 되는 키예요. `service_role` 키는 절대 넣지 마세요.
- 서버에는 **익명 기기 번호 · 날짜 · 30분 구간**만 저장돼요. 정확한 분, 목표, 첫 행동, 이름은 보내지 않아요.
- 익명 사용자는 쓰기만 할 수 있고, 읽기는 구간별 인원 합계만 가능해요.
- **우리 방**: 초대 링크(`?room=코드`)로 들어온 사람끼리만 닉네임과 하루 시작 시각(분)을 서로 볼 수 있어요. 방 안 사람에게도 기기 번호는 보이지 않아요. 틀린 초대 코드 시도는 같은 네트워크에서 하루 60번까지예요.
- **방 프로필**: 방에 들어가 있는 동안 목표 시각과 최근 66일의 하루 시작 기록이 같은 방 사람에게 보여요 (연속 일수·최근 7일·최근 30일 계산용).

- **개인정보 처리방침·이용약관**: `privacy.html`, `terms.html`. 문의 이메일을 보이게 하려면 `config.js`의 `contact`에 적어요 (비우면 GitHub 문의 게시판으로 안내). 운영 방법은 `OPERATIONS.md`에 있어요.

## 3. 업데이트할 때

`index.html` 등을 바꿔 다시 올릴 때는 `sw.js` 맨 위의 `VERSION` 값을 올려 주세요 (예: `gachi-v0.2.1`). 그래야 사용자 폰에 저장된 이전 버전이 새 버전으로 바뀌어요.

## 알려진 한계

- 내 기록은 각자 폰의 브라우저에만 저장돼요. 브라우저 데이터를 지우면 사라져요.
- 익명 방식이라 누군가 마음먹고 가짜 기록을 많이 보내는 걸 완전히 막진 못해요. 사용자가 늘면 요청 횟수 제한이나 봇 확인을 추가하세요.
- 알람, 푸시 알림, 홈 화면 위젯은 없어요 (위젯은 네이티브 앱이 필요해요).
- Supabase 연동은 모의 서버로만 테스트했어요. 실제 프로젝트에 연결한 뒤 한 번 눌러 확인해 주세요.
