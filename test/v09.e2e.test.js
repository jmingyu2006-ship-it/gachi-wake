// v0.9: 첫 방문 체험, 목표 제안(기록 기반 단계), 참여 요일, 주간 리포트 다음 행동, 많이 일찍
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

function fakeServer() {
  const st = { funnel: [] };
  return { st, attach: async (page) => {
    await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.GACHI_CONFIG={supabaseUrl:'https://mock.supabase.test',supabaseAnonKey:'k'};" }));
    await page.route('https://mock.supabase.test/**', async (route) => {
      const url = route.request().url(), body = route.request().postDataJSON ? (route.request().postDataJSON() || {}) : {};
      const json = (b) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
      const fn = (url.match(/rpc\/(\w+)/) || [])[1] || '';
      if (url.includes('wake_events')) return route.fulfill({ status: 201, body: '' });
      if (fn === 'day_counts') return json([]);
      if (fn === 'app_info') return json({ v: 9, features: ['funnel', 'days', 'undo'] });
      if (fn === 'bump_funnel') { st.funnel.push(body.p_step); return json(true); }
      return json(null);
    });
  } };
}
async function open(isoLocal, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(+process.env.PWT || 30000);
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/, r => r.abort());
  if (opts.srv) await opts.srv.attach(page);
  else await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.GACHI_CONFIG={};' }));
  if (opts.seed) await page.addInitScript((d) => {
    if (localStorage.getItem('seeded')) return;
    const p2 = (n) => String(n).padStart(2, '0');
    const recs = d.days.map(([k, m, t]) => ({ id: 'w-' + k, date: k, wokeAt: k + 'T' + p2(Math.floor(m / 60)) + ':' + p2(m % 60) + ':00+09:00', minuteOfDay: m, cohort: p2(Math.floor(m / 60)) + ':' + (m % 60 >= 30 ? '30' : '00'), dayTarget: t, actionDoneAt: null, greetedAt: null }));
    localStorage.setItem('gachi-v2-settings', JSON.stringify(d.settings));
    localStorage.setItem('gachi-v2-records', JSON.stringify(recs));
    localStorage.setItem('seeded', '1');
  }, opts.seed);
  await page.clock.install({ time: new Date(isoLocal + '+09:00') });
  await page.goto(BASE);
  return page;
}
const SET = (o = {}) => ({ version: 2, baselineMin: 480, targetMin: 420, planStart: '2026-10-01', sleepNeedH: 8, firstAction: '물 한 잔 마시기', age: '20', cur: 465, ...o });

test('첫 방문: 설정 전에 "먼저 창문 켜 보기" 체험(저장 안 됨) → "목표 정하러 가기"로 바로 다음 단계, 단계 집계', async () => {
  const srv = fakeServer();
  const page = await open('2026-11-09T15:00:00', { srv });
  await page.getByRole('button', { name: /먼저 창문 켜 보기/ }).click();
  await page.clock.runFor(300);
  const cer = page.locator('#cer');
  await cer.getByText('체험이에요 · 저장되지 않아요').waitFor();
  await cer.getByText('금빛 아침').waitFor();
  assert.equal(await cer.getByRole('button', { name: '기록 이미지' }).count(), 0);
  await page.clock.runFor(3200);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(SHOTS, 'v09-demo.png') });
  await cer.getByRole('button', { name: '목표 정하러 가기' }).click();
  await page.getByRole('heading', { name: /요즘 보통 몇 시에/ }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('gachi-v2-records')), null, '체험은 저장 안 됨');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByText('3번 시작하면 15분씩').waitFor();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '20대' }).click();
  await page.getByRole('button', { name: '시작하기' }).click();
  // 오후 첫 방문: 내일 첫 아침 예약
  await page.locator('[data-morning]', { hasText: '아침 알림 설정' }).waitFor();
  await page.waitForFunction(() => window.__wakeApp.state.features.length > 0);
  for (let i = 0; i < 10 && srv.st.funnel.length < 3; i++) await page.clock.runFor(100);
  assert.deepEqual(srv.st.funnel.slice().sort(), ['demo', 'setup', 'visit']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('목표 제안: 07:45 목표를 3번 연속 지키면 "15분 앞당길까요?" → 앞당기면 내일 07:30 / 조금 더 유지는 이틀 쉬기', async () => {
  const days = [['2026-11-06', 465, 465], ['2026-11-07', 470, 465], ['2026-11-08', 460, 465]];
  const page = await open('2026-11-09T07:45:00', { seed: { settings: SET(), days } });
  await page.getByRole('button', { name: '하루 시작', exact: true }).click();
  await page.clock.runFor(400);
  await page.locator('#cer').getByRole('button', { name: '확인' }).click();
  await page.getByText('최근 3번 모두 목표 근처에서 시작했어요.', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(SHOTS, 'v09-advice.png'), fullPage: true });
  await page.getByRole('button', { name: '앞당기기' }).click();
  await page.getByText('내일부터 07:30이 목표예요.').waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-settings')).cur), 450);
  assert.equal(await page.getByText('최근 3번 모두 목표 근처에서', { exact: false }).count(), 0, '고른 뒤엔 사라짐');
  // 오늘 기록은 그때 목표(07:45) 그대로 평가
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-records')).slice(-1)[0].dayTarget), 465);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('오래 쉬다 돌아온 날: 쌓은 창문은 그대로 안내 + 편한 목표 고르기, 연출에서도 다시 이어가요', async () => {
  const days = [['2026-10-20', 465, 465], ['2026-10-21', 465, 465], ['2026-10-22', 470, 465]];
  const page = await open('2026-11-09T07:50:00', { seed: { settings: SET(), days } });
  await page.getByRole('button', { name: '하루 시작', exact: true }).click();
  await page.clock.runFor(400);
  await page.locator('#cer').getByText('지금까지 채운 창문 3칸은 그대로예요. 오늘부터 다시 이어가요').waitFor();
  await page.locator('#cer').getByRole('button', { name: '확인' }).click();
  await page.getByText('17일 쉬고 돌아왔어요.', { exact: false }).waitFor();
  await page.getByRole('button', { name: '08:00으로 편하게' }).click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-settings')).cur), 480);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('참여 요일: 설정에서 월~금 → 저장해도 단계 목표 유지, 토요일엔 쉬는 요일 안내, 주말을 건너 연속, 많이 일찍 판정', async () => {
  const page = await open('2026-11-06T07:40:00', { seed: { settings: SET({ cur: 420, baselineMin: 440 }), days: [['2026-11-03', 420, 420], ['2026-11-04', 425, 420], ['2026-11-05', 418, 420]] } });
  await page.getByRole('button', { name: '설정 열기' }).click();
  await page.getByRole('button', { name: /내일 아침/ }).click();
  for (const d of ['일', '토']) await page.locator('#sheetBody').getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했어요.').waitFor();
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-settings')));
  assert.deepEqual(s.days, [1, 2, 3, 4, 5]); assert.equal(s.daysFrom, '2026-11-06');
  assert.equal(s.cur, 420, '다른 설정을 저장해도 지금 단계 목표는 그대로');
  await page.context().close();
  const weekdays = SET({ cur: 420, baselineMin: 440, days: [1, 2, 3, 4, 5], daysFrom: '2026-11-01' });
  const recs = [['2026-11-02', 420, 420], ['2026-11-03', 425, 420], ['2026-11-04', 418, 420], ['2026-11-05', 420, 420], ['2026-11-06', 421, 420]];
  const sat = await open('2026-11-07T07:00:00', { seed: { settings: weekdays, days: recs } });
  await sat.getByText('오늘은 쉬는 요일이에요', { exact: false }).waitFor();
  await sat.context().close();
  // 월요일 05:30 → 목표 07:00보다 90분 일찍 → 많이 일찍 (기록은 됨), 토·일을 건너 연속 6일
  const mon = await open('2026-11-09T05:30:00', { seed: { settings: weekdays, days: recs } });
  assert.equal(await mon.getByText('오늘은 쉬는 요일이에요', { exact: false }).count(), 0);
  await mon.getByRole('button', { name: '하루 시작', exact: true }).click();
  await mon.clock.runFor(400);
  await mon.locator('#cer').getByText('많이 일찍', { exact: false }).waitFor();
  await mon.locator('#cer').getByRole('button', { name: '확인' }).click();
  await mon.getByText('목표 07:00 · 1시간 30분 일찍').waitFor();
  await mon.getByRole('button', { name: '기록', exact: true }).click();
  assert.equal(await mon.locator('.duo .big').nth(1).textContent(), '6일', '토·일 쉬는 요일을 건너 연속 6일');
  await mon.screenshot({ path: path.join(SHOTS, 'v09-habit.png'), fullPage: true });
  assert.deepEqual(mon.errors, []);
  await mon.context().close();
});

test('주간 리포트: 늦은 날이 많으면 "목표 유지하기·직접 조정하기", 기록이 드물면 횟수부터', async () => {
  const days = [['2026-11-02', 520, 465], ['2026-11-03', 530, 465], ['2026-11-04', 515, 465], ['2026-11-05', 470, 465]];
  const page = await open('2026-11-10T09:00:00', { seed: { settings: SET(), days } });
  await page.locator('[data-recap]').click();
  await page.getByText('지난주에는 목표보다 30분 넘게 늦게 시작한 날이 3번 있었어요.', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(SHOTS, 'v09-recap.png') });
  await page.getByRole('button', { name: '목표 유지하기' }).click();
  await page.getByText('이번 주도 07:45으로 가요.').waitFor();
  await page.getByRole('button', { name: '기록', exact: true }).click();
  await page.locator('[data-recap]').click();
  await page.getByRole('button', { name: '직접 조정하기' }).click();
  await page.getByRole('heading', { name: '내일 아침' }).waitFor();
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
