// v0.11 디자인: 첫 방문 체험, 목표 제안(기록 기반 단계), 참여 요일, 주간 리포트 다음 행동, 많이 일찍
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
const SET = (o = {}) => ({ version: 2, baselineMin: 480, targetMin: 420, planStart: '2026-10-01', sleepNeedH: 8, firstAction: '스트레칭 1분', age: '20', cur: 480, ...o });
const DAYS = [['2026-11-02', 478, 480], ['2026-11-04', 470, 480], ['2026-11-05', 482, 480], ['2026-11-07', 475, 480]];
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, 'v11-' + n + '.png') });

test('디자인: 390×844 첫 화면에 시간·창문·시작 버튼이 스크롤 없이, 기록 후엔 하늘·첫 행동만, 기록 탭은 내 기록/모은 하늘, 각 상태 화면', async () => {
  let page = await open('2026-11-08T07:42:00', { seed: { settings: SET(), days: DAYS } });
  await page.waitForTimeout(400); await shot(page, 'today-before');
  const btn = await page.getByRole('button', { name: '하루 시작', exact: true }).boundingBox();
  const nav = await page.locator('nav.tabs').boundingBox();
  assert.ok(btn.y + btn.height <= nav.y, '시작 버튼이 탭 막대 위, 스크롤 없이 보임');
  assert.equal(await page.locator('.hero-time').textContent(), '08:00');
  await page.getByText('목표까지 18분 · 지금 시작해도 달성').waitFor();
  assert.equal(await page.locator('section.card').count(), 0, '오늘 화면에 쌓인 카드 없음');
  await page.getByRole('button', { name: '하루 시작' }).click();
  await page.clock.runFor(400);
  await page.locator('#cer').getByRole('button', { name: '확인' }).click();
  await page.waitForTimeout(500); await shot(page, 'today-after');
  assert.equal(await page.locator('.hero-time').textContent(), '07:42');
  await page.getByText('목표 08:00 · 18분 일찍').waitFor();
  assert.equal(await page.locator('[data-share], [data-invite], [data-morning]').count(), 0, '기록 후 알림·초대·공유 카드가 줄줄이 붙지 않음');
  await page.getByRole('button', { name: '컨디션 기록' }).click(); await page.waitForTimeout(200); await shot(page, 'mood');
  await page.getByRole('button', { name: '개운해요' }).click();
  await page.getByRole('button', { name: /오늘의 하늘/ }).click(); await page.waitForTimeout(200); await shot(page, 'sky-sheet');
  await page.getByRole('button', { name: '닫기' }).click();
  await page.locator('[data-morning]').count();
  await page.getByRole('button', { name: '기록', exact: true }).click(); await page.waitForTimeout(400); await shot(page, 'record');
  assert.equal(await page.locator('#brandTitle').textContent(), '기록');
  await page.locator('#dayDetail').getByText('07:42에 시작').waitFor();
  await page.locator('#dayDetail').getByText(/컨디션 개운해요/).waitFor();
  await page.locator('[data-cal="2026-11-04"]').click();
  await page.locator('#dayDetail').getByText('07:50에 시작').waitFor();
  await page.getByRole('button', { name: '모은 하늘' }).click(); await page.waitForTimeout(400); await shot(page, 'sky');
  await page.locator('.sky-tile').first().click();
  await page.getByText(/번 만났어요/).waitFor();
  await page.getByRole('button', { name: '닫기' }).click();
  await page.getByRole('button', { name: '설정 열기' }).click(); await page.waitForTimeout(300); await shot(page, 'settings');
  await page.getByRole('button', { name: /내일 아침/ }).click(); await page.waitForTimeout(300); await shot(page, 'morning');
  // 저장 전엔 적용 안 됨 → 저장하면 내일 목표가 바뀜
  await page.getByRole('button', { name: '5분 빠르게' }).click();
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-settings')))).cur, 480);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했어요.').waitFor();
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('gachi-v2-settings')))).cur, 475);
  assert.deepEqual(page.errors, []);
  page = await open('2026-11-08T13:16:00', { seed: { settings: SET({ cur: 585, baselineMin: 600 }), days: [['2026-11-08', 794, 585]] } });
  await page.waitForTimeout(400); await shot(page, 'late');
  await page.getByText('목표 09:45 · +3시간 29분').waitFor();
  assert.equal(await page.getByText('괜찮아요').count(), 0);
  page = await open('2026-11-08T18:20:00', { seed: { settings: SET(), days: [] } });
  await page.waitForTimeout(400); await shot(page, 'afternoon');
  await page.getByText('내일 목표').waitFor();
  await page.getByText('첫 기록은 내일 아침부터').waitFor();
  assert.equal(await page.locator('.start-btn').count(), 0, '마감된 기록 버튼을 크게 남겨두지 않음');
  page = await open('2026-11-08T23:20:00', { seed: { settings: SET(), days: DAYS } });
  await page.waitForTimeout(400); await shot(page, 'night');
  assert.deepEqual(page.errors, []);
});
