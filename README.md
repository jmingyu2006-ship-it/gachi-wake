# 같이 일어나요

하루를 시작하고 싶은 시각을 정하고, 실제로 시작할 때 버튼 하나로 기록하는 아침 습관 앱.
누르면 내 창문에 불이 켜지고, 오늘 하루를 시작한 모든 사용자의 창문이 함께 보여요.

- 사이트: https://jmingyu2006-ship-it.github.io/gachi-wake/
- `docs/` — 배포되는 사이트 (GitHub Pages: main 브랜치 /docs)
- `src/` — 앱 원본 (`logic.js` 계산, `app.html` 화면)
- `web/` — 서비스 워커·매니페스트·config.js·supabase.sql·배포 안내 원본
- `test/` — 로직 테스트 20개, 브라우저 테스트 19개 (우리 방 두 사람 흐름 포함)

## 다시 빌드하기
```
SITE_URL=https://jmingyu2006-ship-it.github.io/gachi-wake/ node build.js
rm -rf docs && cp -r dist/web docs
```
앱을 바꿔 올릴 때는 `web/sw.js`의 `VERSION`을 올려 주세요.
