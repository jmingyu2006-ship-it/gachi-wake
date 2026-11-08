// v0.8: 실제 날씨 하늘, 푸시 알림(브라우저 푸시는 흉내), 잘못 누름 취소, 컨디션, 달력, 바로가기
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW_PATH || '/opt/npm-tools/node_modules/playwright');

const WEB = path.join(__dirname, '../dist/web');
const SHOTS = path.join(__dirname, '../shots');
fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const VAPID = 'BDGIJGy7WlYA6gcJcvTEDTDdn2QK2bkR_w7Xf5ZsnNKfGeJ8b1kWnFwGQTkBX6criEOW9d5_H_FVkIFiRUmFd2g';
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

// 서버 흉내: 합계·앱 정보·알림·취소
function fakeServer() {
  const st = { calls: [], subs: new Map(), tests: 0, weatherHits: 0 };
  const attach = async (page) => {
    await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.GACHI_CONFIG={supabaseUrl:'https://mock.supabase.test',supabaseAnonKey:'k'};" }));
    await page.route('https://mock.supabase.test/**', async (route) => {
      const url = route.request().url(), body = route.request().postDataJSON ? (route.request().postDataJSON() || {}) : {};
      const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/functions/v1/send-reminders')) { st.tests++; return json(body.mode === 'test' && st.subs.has(body.endpoint) ? { result: 'ok' } : { error: 'wait_or_not_found' }, body.mode === 'test' && st.subs.has(body.endpoint) ? 200 : 429); }
      const fn = (url.match(/rpc\/(\w+)/) || [])[1] || (url.includes('wake_events') ? 'wake_events' : '');
      st.calls.push({ fn, body });
      if (fn === 'wake_events') return route.fulfill({ status: 201, body: '' });
      if (fn === 'day_counts') return json([]);
      if (fn === 'app_info') return json({ v: 8, features: ['report', 'recovery', 'erase', 'rests', 'undo', 'push'], vapid: VAPID });
      if (fn === 'save_push') { st.subs.set(body.p_sub.endpoint, body.p_prefs); return json({ ok: true }); }
      if (fn === 'delete_push') { st.subs.delete(body.p_endpoint); return json({ ok: true, deleted: 1 }); }
      if (fn === 'undo_start') return json({ ok: true, wakes: 1, starts: 0 });
      return json(null);
    });
    await page.route('https://api.open-meteo.com/**', r => { st.weatherHits++; st.lastWeatherUrl = r.request().url(); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current: { time: '2026-11-09T07:00', temperature_2m: 6.6, weather_code: 63 } }) }); });
  };
  return { st, attach };
}
// 브라우저 푸시 흉내 (실제 푸시 서버 없이): 권한 허용, 구독 객체
const pushStub = () => {
  let sub = null;
  const fakeReg = { pushManager: {
    getSubscription: async () => sub,
    subscribe: async (o) => { if (!(o.applicationServerKey instanceof Uint8Array) || o.applicationServerKey.length !== 65) throw new Error('bad key'); sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/fake-1', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/fake-1', keys: { p256dh: 'B'.padEnd(87, 'x'), auth: 'a'.padEnd(22, 'y') } }), unsubscribe: async () => { sub = null; return true; } }; return sub; }
  } };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(fakeReg), register: () => Promise.resolve(fakeReg), addEventListener() {}, controller: null } });
  window.Notification = function () {}; window.Notification.permission = 'default';
  window.Notification.requestPermission = () => { window.Notification.permission = 'granted'; return Promise.resolve('granted'); };
  if (!window.PushManager) window.PushManager = function () {};
};
async function open(isoLocal, srv, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: 37.5512, longitude: 126.9882 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  if (srv) await srv.attach(page);
  else await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.GACHI_CONFIG={};' }));
  if (opts.push) await page.addInitScript(pushStub);
  if (opts.seed) await page.addInitScript((d) => { if (!localStorage.getItem('seeded')) { Object.entries(d).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v))); localStorage.setItem('seeded', '1'); } }, opts.seed);
  await page.clock.install({ time: new Date(isoLocal + '+09:00') });
  await page.goto(opts.url || BASE);
  return page;
}
async function onboard(page) {
  await page.getByRole('button', { name: '목표 정하기' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '20대' }).click();
  await page.getByRole('button', { name: '시작하기' }).click();
}
const SETTINGS = { version: 2, baselineMin: 420, targetMin: 420, planStart: '2026-10-01', sleepNeedH: 8, firstAction: '물 한 잔 마시기', age: '20' };

test('실제 날씨: 설정에서 서울을 고르면 비 오는 날 하늘이 "비 오는 아침", 기록에 날씨·기온, 도감 안내', async () => {
  const srv = fakeServer();
  const page = await open('2026-11-09T07:00:00', srv);
  await onboard(page);
  await page.getByRole('button', { name: '습관' }).click();
  await page.getByText('실제 날씨를 켜면 만날 수 있어요', { exact: false }).waitFor();
  await page.getByRole('button', { name: '오늘' }).click();
  await page.getByRole('button', { name: '목표 설정 열기' }).click();
  await page.getByLabel(/하루를 시작한 순간의 날씨/).check();
  await page.getByLabel('지역').selectOption('서울');
  await page.getByText('지금 서울 7° · 비').waitFor();
  assert.match(srv.st.lastWeatherUrl, /latitude=37\.6&longitude=127&current=temperature_2m,weather_code/);
  await page.getByRole('button', { name: '닫기' }).last().click();
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(400);
  const cer = page.locator('#cer');
  await cer.getByText('서울 7° · 비 · 궂은 날에도 시작했어요').waitFor();
  assert.match(await cer.locator('.cer-card .nm').textContent(), /비 오는 아침|무지개 아침/);
  await page.clock.runFor(3200);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(SHOTS, 'v08-rain.png') });
  await cer.getByRole('button', { name: '확인' }).click();
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-records'))[0]);
  assert.equal(rec.wx, 63); assert.equal(rec.tc, 7);
  // 현재 위치(대략)
  await page.getByRole('button', { name: '목표 설정 열기' }).click();
  await page.getByLabel('지역').selectOption('__here');
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('gachi-v2-weather')) || {}).name === '현재 위치');
  const w = await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-weather')));
  assert.deepEqual([w.lat, w.lon], [37.6, 127], '소수 첫째 자리로만 저장');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('푸시 알림: 켜기(권한·구독·서버 저장) → 테스트 알림 → 목표 바꾸면 서버도 갱신 → 끄기, 켠 사람은 알림 카드 안 보임', async () => {
  const srv = fakeServer();
  const page = await open('2026-11-09T22:00:00', srv, { push: true });
  await onboard(page);
  await page.waitForFunction(() => window.__wakeApp && window.__wakeApp.state.features.includes('push'));
  await page.locator('section.card', { hasText: '아침 알림 맞추기' }).waitFor();
  await page.getByRole('button', { name: '맞추기' }).click();
  await page.getByText('푸시 알림 (추천)').waitFor();
  await page.screenshot({ path: path.join(SHOTS, 'v08-push-sheet.png') });
  await page.getByLabel(/아침 알림 · 목표 시각에/).check();
  await page.getByText('알림을 켰어요. 테스트 알림으로 확인해 보세요.').waitFor();
  const prefs = srv.st.subs.get('https://fcm.googleapis.com/fcm/send/fake-1');
  assert.deepEqual(prefs, { morning: true, bedtime: false, weekdaysOnly: false, baselineMin: 480, targetMin: 420, planStart: '2026-11-09', sleepH: 8 });
  await page.getByRole('button', { name: '닫기' }).last().click();
  assert.equal(await page.locator('section.card', { hasText: '아침 알림 맞추기' }).count(), 0, '알림 켠 사람에겐 카드 안 보임');
  // 설정: 잘 시간·평일만, 테스트 알림
  await page.getByRole('button', { name: '목표 설정 열기' }).click();
  await page.getByLabel(/잘 시간 알림/).check();
  await page.getByText('알림 설정을 바꿨어요.').waitFor();
  assert.equal(srv.st.subs.get('https://fcm.googleapis.com/fcm/send/fake-1').bedtime, true);
  await page.getByRole('button', { name: '목표 설정 열기' }).click().catch(() => {});
  await page.getByRole('button', { name: '테스트 알림 보내기' }).click();
  await page.getByText('테스트 알림을 보냈어요. 몇 초 안에 와요.').waitFor();
  for (const [i, y] of [[1, 0], [2, 700], [3, 1400], [4, 2100]]) {
    await page.locator('#sheetBody').evaluate((e, y) => { (e.closest('.sheet-panel') || e.parentElement).scrollTop = y; e.scrollTop = y; }, y);
    await page.screenshot({ path: path.join(SHOTS, 'v08-settings-' + i + '.png') });
  }
  // 목표를 바꾸면 서버의 알림 시각 정보도
  await page.locator('.stepper[data-for="targetMin"] [data-d="15"]').click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 20 && srv.st.subs.get('https://fcm.googleapis.com/fcm/send/fake-1').targetMin !== 435; i++) await page.clock.runFor(100);
  assert.equal(srv.st.subs.get('https://fcm.googleapis.com/fcm/send/fake-1').targetMin, 435);
  // 끄기 (둘 다 해제)
  await page.getByRole('button', { name: '목표 설정 열기' }).click();
  await page.getByLabel(/아침 알림 · 목표 시각에/).uncheck();
  await page.getByText('알림 설정을 바꿨어요.').waitFor();
  await page.getByLabel(/잘 시간 알림/).uncheck();
  await page.getByText('알림을 껐어요.').waitFor();
  assert.equal(srv.st.subs.size, 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('gachi-v2-push')), null);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('잘못 누름 취소(5분 안, 두 번) → 다시 누를 수 있음, 5분 지나면 취소 버튼 없음 / 컨디션 기록', async () => {
  const srv = fakeServer();
  const page = await open('2026-11-09T07:00:00', srv);
  await onboard(page);
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(400);
  await page.locator('#cer').getByRole('button', { name: '확인' }).click();
  await page.getByRole('button', { name: '잘못 눌렀어요 · 취소' }).click();
  await page.getByRole('button', { name: '한 번 더 누르면 오늘 기록을 취소해요' }).click();
  await page.getByText('오늘 기록을 취소했어요. 준비되면 다시 눌러 주세요.').waitFor();
  await page.getByRole('button', { name: '하루 시작하기' }).waitFor();
  assert.ok(srv.st.calls.some(c => c.fn === 'undo_start' && c.body.p_day === '2026-11-09'));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-records')).length), 0);
  // 다시 눌러 시작 → 컨디션
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(400);
  await page.locator('#cer').getByRole('button', { name: '확인' }).click();
  await page.getByRole('button', { name: '개운해요' }).click();
  assert.equal(await page.getByRole('button', { name: '개운해요' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-records'))[0].mood), 3);
  await page.screenshot({ path: path.join(SHOTS, 'v08-today.png'), fullPage: true });
  // 5분 지나면 취소 버튼이 사라짐
  await page.clock.fastForward('05:10');
  await page.getByRole('button', { name: '습관' }).click();
  await page.getByRole('button', { name: '오늘' }).click();
  assert.equal(await page.getByRole('button', { name: '잘못 눌렀어요 · 취소' }).count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('달력: 이번 달 기록이 하늘 색으로, 지난달로 넘기기, 날짜 누르면 그날 정보 / 바로가기 ?tab=habit', async () => {
  const p2 = (n) => String(n).padStart(2, '0');
  const recs = [];
  for (const d of ['2026-10-28', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-08']) {
    recs.push({ id: 'w-' + d, date: d, wokeAt: d + 'T07:05:00+09:00', minuteOfDay: 425, cohort: '07:00', dayTarget: 420, actionDoneAt: null, greetedAt: null, mood: d === '2026-11-03' ? 3 : null, wx: d === '2026-11-04' ? 61 : null, tc: d === '2026-11-04' ? 9 : null });
  }
  const page = await open('2026-11-09T09:00:00', null, { url: BASE + '?tab=habit', seed: { 'gachi-v2-settings': SETTINGS, 'gachi-v2-records': recs } });
  await page.getByText('2026년 11월').waitFor();
  assert.equal(await page.evaluate(() => location.search), '', '주소에서 바로가기 표시는 지움');
  await page.getByText('6일 기록', { exact: true }).waitFor();
  assert.equal(await page.locator('.cal .c.on').count(), 6);
  assert.equal(await page.locator('.cal .c.rest').count(), 1, '11/7은 보호권으로 쉰 날 (11/6이 7번째 기록이라 보호권 1개)');
  await page.locator('[data-cal="2026-11-04"]').click();
  await page.getByText(/11\/4 07:05 · 비 오는 아침|11\/4 07:05 · 무지개 아침/).waitFor();
  await page.getByText(/비 9°/).first().waitFor();
  await page.getByRole('button', { name: '이전 달' }).click();
  await page.getByText('2026년 10월').waitFor();
  assert.equal(await page.locator('.cal .c.on').count(), 2);
  assert.ok(await page.getByRole('button', { name: '이전 달' }).isDisabled(), '첫 기록 달보다 앞으론 안 감');
  await page.screenshot({ path: path.join(SHOTS, 'v08-calendar.png') });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
