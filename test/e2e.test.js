// 05 Test Engineer: v0.2 브라우저 테스트 (Playwright + 설치된 Chrome, 로컬 HTTP 서버)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW_PATH || '/opt/npm-tools/node_modules/playwright');

const WEB = path.join(__dirname, '../dist/web');
const SHOTS = path.join(__dirname, '../shots');
fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.sql': 'text/plain' };

let browser, server, BASE;
test.before(async () => {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(WEB, p);
    if (!f.startsWith(WEB) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port + '/';
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
});
test.after(async () => { await browser.close(); server.close(); });

async function ctx() { return browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block' }); }
async function open(context, isoLocal, opts = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  // 기본: 서버 없는 예시 모드 (실제 Supabase에 테스트 기록이 들어가지 않게). 서버 테스트는 opts.route로 덮어씀
  await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.GACHI_CONFIG={};' }));
  await page.route(/supabase\.co/, r => r.abort());
  if (opts.route) await opts.route(page);
  if (opts.init) await page.addInitScript(opts.init);
  await page.clock.install({ time: new Date(isoLocal + '+09:00') });
  await page.goto(opts.url || BASE);
  page.errors = errors;
  return page;
}
async function onboard(page, { age = '20대', custom = null } = {}) {
  await page.getByRole('button', { name: '목표 정하기' }).click();
  await page.getByRole('button', { name: '다음' }).click();   // 평소 08:00
  await page.getByRole('button', { name: '다음' }).click();   // 목표 07:00
  if (custom !== null) {
    await page.getByRole('button', { name: '직접 입력' }).click();
    await page.getByLabel('할 일 (20자까지)').fill(custom);
  }
  await page.getByRole('button', { name: age }).click();
  await page.getByRole('button', { name: '시작하기' }).click();
}
const settled = (page) => page.clock.runFor(2500);

// 하루 시작 → 불 켜기 연출이 뜨면 '확인'으로 닫기
async function startDay(page) {
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(400);
  const cer = page.locator('#cer');
  if (await cer.count()) await cer.getByRole('button', { name: '확인' }).click();
}

test('온보딩 → 하루 시작(07:40, 단계 목표 07:45) → 달성, 내 창문, 첫 행동, 새로고침 유지', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-09T07:40:00');
  await page.clock.runFor(500);
  await page.screenshot({ path: path.join(SHOTS, '01-onboarding.png') });
  await page.getByRole('button', { name: '목표 정하기' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByText('3일마다 15분씩').waitFor();
  await page.screenshot({ path: path.join(SHOTS, '02-target.png') });
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '시작하기' }).click();
  await page.getByText('나이대를 골라 주세요.').waitFor();           // 오류 상태: 필수 선택 누락
  await page.getByRole('button', { name: '20대' }).click();
  await page.getByRole('button', { name: '시작하기' }).click();

  await page.getByText('07:45').first().waitFor();                   // 오늘 단계 목표
  await page.getByText('최종 07:00까지 9일').waitFor();
  await settled(page);
  assert.ok(await page.locator('.win.on').count() > 10, '다른 사람 창문이 켜져 있어야 함');
  assert.equal(await page.locator('.win.me.on').count(), 0);
  await page.screenshot({ path: path.join(SHOTS, '03-today-before.png') });

  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByText('목표 달성').waitFor();
  await page.getByText('07:40에 하루를 시작했어요').waitFor();
  assert.equal(await page.locator('.win.me.on').count(), 1, '내 창문이 켜져야 함');
  await page.getByText('23:45').waitFor();                           // 내일 목표 07:45 - 8시간
  await page.screenshot({ path: path.join(SHOTS, '04-today-after.png') });

  await page.getByRole('button', { name: '했어요' }).click();
  await page.reload();
  await page.getByText('목표 달성').waitFor();
  assert.equal(await page.getByRole('button', { name: '하루 시작하기' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '했어요' }).count(), 0, '첫 행동 체크 유지');
  assert.equal(await page.locator('.win.me.on').count(), 1);
  assert.equal(await page.locator('#ob').isVisible(), false, '다시 온보딩이 뜨지 않음');
  assert.deepEqual(page.errors, []);
  await c.close();
});

test('늦은 시작(09:30): 비난 없이 "괜찮아요"로 안내', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-09T09:30:00');
  await onboard(page);
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByText('늦어도 시작한 게 중요해요').waitFor();
  await page.getByText('1시간 45분 늦었어요').waitFor();
  await c.close();
});

test('직접 입력: 빈 값은 막고, 태그 문자는 지우고 20자로 자른다', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-09T07:00:00');
  await page.getByRole('button', { name: '목표 정하기' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '직접 입력' }).click();
  await page.getByRole('button', { name: '20대' }).click();
  await page.getByRole('button', { name: '시작하기' }).click();
  await page.getByText('일어나서 할 일을 하나 골라 주세요.').waitFor();
  await page.getByLabel('할 일 (20자까지)').fill('<img>창문 열고 심호흡 세 번 하고 물 마시기 그리고 또');
  await page.getByRole('button', { name: '시작하기' }).click();
  await startDay(page);
  await page.clock.runFor(1600);
  const t = await page.locator('.action-text').first().textContent();
  assert.ok(!t.includes('<'), t);
  assert.ok(Array.from(t).length <= 20, t);
  await c.close();
});

test('마감(22:40) → 체험 → 저장 안 됨, 습관 탭 빈 상태', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-07T22:40:00');
  await onboard(page);
  await page.getByText('오후 2시에 마감').waitFor();
  assert.equal(await page.getByRole('button', { name: '하루 시작하기' }).count(), 0);
  await page.screenshot({ path: path.join(SHOTS, '05-closed.png') });
  await page.getByRole('button', { name: '아침 시간으로 체험해보기' }).click();
  await page.getByRole('button', { name: /06:42/ }).click();
  await page.getByText(/체험 중/).waitFor();
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByText('목표 달성').waitFor();
  await page.getByRole('button', { name: '체험 끝내기' }).click();
  await page.getByText('오후 2시에 마감').waitFor();
  await page.reload();
  await page.getByRole('button', { name: '습관' }).click();
  await page.getByText('아직 기록이 없어요').waitFor();
  await page.getByText('0 / 66', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(SHOTS, '06-habit-empty.png') });
  await c.close();
});

test('새벽(03:00): 버튼 비활성', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-09T03:00:00');
  await onboard(page);
  assert.equal(await page.locator('.start-btn').isDisabled(), true);
  await c.close();
});

test('오류 상태: 기기 저장이 막혀도 결과는 뜨고 안내가 나온다', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-09T07:10:00', { init: () => { Storage.prototype.setItem = function () { throw new Error('blocked'); }; } });
  await onboard(page);
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByText('목표 달성').waitFor();
  await page.getByText(/저장하지 못했어요/).first().waitFor();
  await c.close();
});

test('습관 탭: 2주 기록이 있으면 이번 주 색, 달성 수, 흔들림, 주말 차이, 차트가 맞게 나온다', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-11T12:00:00', {
    init: () => {
      const s = { version: 2, baselineMin: 420, targetMin: 420, planStart: '2026-11-01', sleepNeedH: 8, firstAction: '물 한 잔 마시기', age: '20' };
      const mk = (d, m) => ({ id: 'w-' + d, date: d, wokeAt: d + 'T07:00:00+09:00', minuteOfDay: m, cohort: String(Math.floor(m / 60)).padStart(2, '0') + ':' + (m % 60 >= 30 ? '30' : '00'), dayTarget: 420, actionDoneAt: null, greetedAt: null });
      const recs = [['2026-11-02', 420], ['2026-11-03', 430], ['2026-11-04', 410], ['2026-11-05', 425], ['2026-11-06', 420], ['2026-11-07', 510], ['2026-11-08', 530], ['2026-11-09', 420], ['2026-11-10', 440]].map(x => mk(x[0], x[1]));
      localStorage.setItem('gachi-v2-settings', JSON.stringify(s));
      localStorage.setItem('gachi-v2-records', JSON.stringify(recs));
    }
  });
  await page.getByRole('button', { name: '습관' }).click();
  await page.getByText('9 / 66', { exact: true }).waitFor();
  await page.getByText('7일 중 2일 기록').waitFor();
  assert.equal(await page.locator('.cell.hit').count(), 1);
  assert.equal(await page.locator('.cell.close').count(), 1);
  assert.equal(await page.locator('.cell.todo').count(), 1);
  assert.match(await page.locator('.stats .stat-num').nth(0).textContent(), /^3 \/ 6일$/);
  assert.match(await page.locator('.stats .stat-num').nth(1).textContent(), /^±\d+분$/);
  assert.match(await page.locator('.stats .stat-num').nth(2).textContent(), /^\+\d+분$/);
  // 연속 9일(오늘 아직), 7일째에 보호권 1개, 내 건물 9칸, 칭호 3·7일
  assert.equal(await page.locator('.stat-num').first().textContent(), '9일');
  assert.equal(await page.locator('.card').first().locator('.shield i.on').count(), 1);
  assert.equal(await page.locator('.my-bld .w.on').count(), 9);
  assert.equal(await page.locator('.titles span.got').count(), 2);
  assert.ok(await page.locator('.dex .it:not(.no)').count() >= 2, '도감에 하늘이 2종 이상');
  assert.equal(await page.locator('svg[aria-label^="최근 14일"] circle').count(), 9);
  await page.clock.runFor(600);
  await page.screenshot({ path: path.join(SHOTS, '07-habit.png'), fullPage: true });
  await c.close();
});

test('설정 변경: 목표를 바꾸면 오늘부터 다시 계산되고, 기록 지우기는 두 번 눌러야 한다', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-09T07:40:00');
  await onboard(page);
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByRole('button', { name: '목표 설정 열기' }).click();
  await page.locator('.stepper[data-for="targetMin"] [data-d="15"]').click();  // 07:15 → 45분 차이라 단계 목표
  await page.getByText('3일마다 15분씩').waitFor();
  await page.locator('.stepper[data-for="targetMin"] [data-d="15"]').click();  // 07:30 → 30분 차이라 바로
  await page.getByText('바로 07:30부터').waitFor();
  await page.getByRole('button', { name: '저장' }).click();
  await page.getByText('저장했어요.').waitFor();
  await page.reload();
  await page.getByText('내일 목표는').waitFor();
  assert.match(await page.locator('.tip').textContent(), /07:30/, '바뀐 목표가 저장됨');
  await page.getByRole('button', { name: '목표 설정 열기' }).click();
  await page.getByRole('button', { name: '기록 모두 지우기' }).click();
  await page.getByRole('button', { name: '한 번 더 누르면 모든 기록이 지워져요' }).click();
  await page.getByRole('button', { name: '하루 시작하기' }).waitFor();
  await c.close();
});

test('공유 서버(모의): 익명 id·날짜·구간만 보내고, 서버 인원으로 창문을 켠다', async () => {
  const c = await ctx();
  const posts = [];
  let extra = 0;
  const page = await open(c, '2026-11-09T07:40:00', {
    route: async (p) => {
      await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.GACHI_CONFIG={supabaseUrl:'https://mock.supabase.test',supabaseAnonKey:'anon-test-key'};" }));
      await p.route('https://mock.supabase.test/**', async r => {
        const req = r.request();
        assert.equal(req.headers()['apikey'], 'anon-test-key');
        if (req.url().endsWith('/rest/v1/wake_events')) { posts.push(JSON.parse(req.postData())); extra = 1; return r.fulfill({ status: 201, body: '' }); }
        if (req.url().endsWith('/rest/v1/rpc/day_counts')) {
          assert.deepEqual(JSON.parse(req.postData()), { p_day: '2026-11-09' });
          return r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ bucket: 14, n: 3 }, { bucket: 15, n: 2 + extra }]) });
        }
        r.fulfill({ status: 404, body: '' });
      });
    }
  });
  await onboard(page);
  await page.getByText('5명').waitFor();
  assert.equal(await page.locator('.win.on').count(), 5);
  assert.equal(await page.locator('#demoNote').textContent(), '');
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByText('6명').waitFor();
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0]).sort(), ['anon_id', 'bucket', 'day']);
  assert.equal(posts[0].day, '2026-11-09');
  assert.equal(posts[0].bucket, 15);
  assert.match(posts[0].anon_id, /^[0-9a-f-]{36}$/);
  assert.equal(await page.locator('.win.on').count(), 6, '다른 사람 5 + 나 1');
  assert.deepEqual(page.errors, [], '온보딩 중 서버 응답이 와도 화면 오류 없음');
  await c.close();
});

test('1칸 = 1명: 130명이면 건물이 11층으로 올라가고 창문 130개가 켜진다', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-09T07:40:00', {
    route: async (p) => {
      await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.GACHI_CONFIG={supabaseUrl:'https://mock.supabase.test',supabaseAnonKey:'k'};" }));
      await p.route('https://mock.supabase.test/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ bucket: 13, n: 60 }, { bucket: 14, n: 70 }]) }));
    }
  });
  await onboard(page);
  await page.getByText('130명').waitFor();
  assert.equal(await page.locator('.win').count(), 132);
  assert.equal(await page.locator('.win.on').count(), 130);
  assert.equal(await page.locator('#perLine').textContent(), '');
  await page.clock.runFor(2500);
  await page.screenshot({ path: path.join(SHOTS, '09-130-people.png') });
  await c.close();
});

test('공유 서버가 죽어도 앱은 동작하고, 다음에 열 때 다시 보낸다', async () => {
  const c = await ctx();
  let down = true; const posts = [];
  const route = async (p) => {
    await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.GACHI_CONFIG={supabaseUrl:'https://mock.supabase.test',supabaseAnonKey:'k'};" }));
    await p.route('https://mock.supabase.test/**', r => {
      if (down) return r.fulfill({ status: 503, body: '' });
      if (r.request().url().endsWith('/wake_events')) posts.push(JSON.parse(r.request().postData()));
      return r.fulfill({ contentType: 'application/json', status: r.request().url().endsWith('/wake_events') ? 201 : 200, body: r.request().url().endsWith('/wake_events') ? '' : '[]' });
    });
  };
  const page = await open(c, '2026-11-09T07:40:00', { route });
  await onboard(page);
  await page.getByText('지금은 함께 보기를 불러올 수 없어요').waitFor();
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByText('목표 달성').waitFor();
  assert.equal(posts.length, 0);
  down = false;
  await page.close();
  const again = await open(c, '2026-11-09T07:50:00', { route });
  await again.clock.runFor(1500);
  await again.waitForFunction(() => (JSON.parse(localStorage.getItem('gachi-v2-pending') || '[]')).length === 0);
  assert.equal(posts.length, 1, '밀린 기록 재전송');
  await c.close();
});

test('공유: 공유 시트가 없으면 공개 주소를 복사한다', async () => {
  const c = await ctx();
  await c.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE.replace(/\/$/, '') });
  const page = await open(c, '2026-11-09T07:40:00', { init: () => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } });
  await onboard(page);
  await page.getByRole('button', { name: '친구에게 공유하기' }).click();
  await page.getByText('링크를 복사했어요').waitFor();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /07:00에 하루를 시작하기로 했어/);
  assert.match(clip, /https:\/\/jmingyu2006-ship-it\.github\.io\/gachi-wake\//);
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByText('친구 창문도 켜 주기').waitFor();
  const og = await page.evaluate(() => document.querySelector('meta[property="og:image"]').content);
  assert.equal(og, 'https://jmingyu2006-ship-it.github.io/gachi-wake/og.png');
  await c.close();
});

test('공유 서버: 아직 아무도 없으면 빈 상태, 서버가 거절하면 다시 보내지 않는다', async () => {
  const c = await ctx();
  let posts = 0;
  const page = await open(c, '2026-11-09T05:10:00', {
    route: async (p) => {
      await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.GACHI_CONFIG={supabaseUrl:'https://mock.supabase.test',supabaseAnonKey:'k'};" }));
      await p.route('https://mock.supabase.test/**', r => {
        if (r.request().url().endsWith('/wake_events')) { posts++; return r.fulfill({ status: 400, contentType: 'application/json', body: '{"code":"P0001","message":"too many starts from this network today"}' }); }
        return r.fulfill({ contentType: 'application/json', body: '[]' });
      });
    }
  });
  await onboard(page);
  await page.getByText('아직 아무도 없어요. 첫 창문을 켜 보세요').waitFor();
  assert.equal(await page.locator('.win.on').count(), 0);
  await page.getByText('모든 사용자 기준').waitFor();
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByText('목표 달성').waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gachi-v2-pending') || '[]').length === 0);
  assert.equal(posts, 1);
  await page.reload();
  await page.clock.runFor(1500);
  assert.equal(posts, 1, '거절된 기록은 다시 보내지 않음');
  assert.deepEqual(page.errors, []);
  await c.close();
});

test('PWA: 매니페스트·아이콘이 열리고 서비스 워커가 설치된다 (로그인 없이 설치 가능)', async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await c.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(BASE);
  const man = await page.evaluate(async () => { const r = await fetch(document.querySelector('link[rel=manifest]').href); return r.json(); });
  assert.equal(man.display, 'standalone');
  for (const ic of man.icons) {
    const st = await page.evaluate(async (src) => (await fetch(src)).status, ic.src);
    assert.equal(st, 200, ic.src);
  }
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert.ok(scope.startsWith('http://127.0.0.1'));
  await c.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: '목표 정하기' }).waitFor();   // 오프라인에서도 열림
  await c.close();
});

test('claude.ai 미리보기용 한 파일도 열린다', async () => {
  const c = await ctx();
  const page = await open(c, '2026-11-09T07:00:00', { url: 'file://' + path.join(__dirname, '../dist/artifact/index.html') });
  await page.getByRole('button', { name: '목표 정하기' }).waitFor();
  assert.deepEqual(page.errors, []);
  await c.close();
});
