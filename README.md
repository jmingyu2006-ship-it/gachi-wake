# 같이 일어나요

하루를 시작하고 싶은 시각을 정하고, 실제로 시작할 때 버튼 하나로 기록하는 아침 습관 앱.
누르면 내 창문에 불이 켜지고, 오늘 하루를 시작한 모든 사용자의 창문이 함께 보여요.
로그인 없이 바로 쓰고, 원하면 아이디+비밀번호로 가입해 다른 기기에서 기록을 이어 갈 수 있어요. 방장은 멤버를 내보낼 수 있어요 (채팅 기능은 없음).

- 사이트: https://jmingyu2006-ship-it.github.io/gachi-wake/
- `docs/` — 배포되는 사이트 (GitHub Pages: main 브랜치 /docs)
- `src/` — 앱 원본 (`logic.js` 계산, `app.html` 화면)
- `web/` — 서비스 워커·매니페스트·config.js·서버 SQL·개인정보 처리방침·이용약관·배포 안내(DEPLOY.md)·운영 안내(OPERATIONS.md)
- `test/` — 로직 테스트 27개, 브라우저 테스트 34개 (우리 방·초대 코드·프로필·이름 바꾸기·방장·계정·복구 코드·신고·의견·서버 기록 지우기·아침 알림·설치 안내·기록 이미지·내보내기·새 버전 자동 적용 포함)

## 다시 빌드하기
```
SITE_URL=https://jmingyu2006-ship-it.github.io/gachi-wake/ node build.js
rm -rf docs && cp -r dist/web docs
```
앱을 바꿔 올릴 때는 `web/sw.js`의 `VERSION`을 올려 주세요. 열려 있던 앱은 돌아올 때 새 버전을 알아차리고 "새 버전이 있어요" 버튼을 띄우거나, 백그라운드에 있었으면 저절로 새로 고쳐요.
