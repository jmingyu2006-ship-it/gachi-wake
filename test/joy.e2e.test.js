// v0.7 재미·리텐션: 불 켜기 연출(단계별), 오늘의 하늘·도감, 보호권, 칭호, 내 건물, 지난주 리포트
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

// 목표 07:00 고정, 지정한 날짜들에 기록이 있는 사람
function seed(days, extra = {}) {
  return { settings: { version: 2, baselineMin: 420, targetMin: 420, planStart: '2026-10-01', sleepNeedH: 8, firstAction: '물 한 잔 마시기', age: '20' }, days, extra };
}
async function open(isoLocal, data, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block', reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.GACHI_CONFIG={};' }));
  if (data) await page.addInitScript((d) => {
    if (localStorage.getItem('seeded')) return;
    const p2 = (n) => String(n).padStart(2, '0');
    const mk = (k, m) => ({ id: 'w-' + k, date: k, wokeAt: k + 'T' + p2(Math.floor(m / 60)) + ':' + p2(m % 60) + ':00+09:00', minuteOfDay: m, cohort: p2(Math.floor(m / 60)) + ':' + (m % 60 >= 30 ? '30' : '00'), dayTarget: 420, actionDoneAt: null, greetedAt: null });
    localStorage.setItem('gachi-v2-settings', JSON.stringify(d.settings));
    localStorage.setItem('gachi-v2-records', JSON.stringify(d.days.map(x => mk(x[0], x[1]))));
    Object.entries(d.extra).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
    localStorage.setItem('seeded', '1');
  }, data);
  await page.clock.install({ time: new Date(isoLocal + '+09:00') });
  await page.goto(BASE);
  return page;
}
const range = (from, n, min = 420) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.parse(from + 'T00:00:00Z') + i * 864e5); return [d.toISOString().slice(0, 10), min]; });

test('첫날: 창문 점등 → 금빛 아침(새로 발견) → 연속 0→1, 첫 창문 축하, 확인하면 오늘 화면에 하늘', async () => {
  const page = await open('2026-11-09T07:00:00', seed([]));
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(300);
  const cer = page.locator('#cer');
  await cer.waitFor();
  assert.equal(await cer.getAttribute('role'), 'dialog');
  await page.clock.runFor(700);
  await page.screenshot({ path: path.join(SHOTS, 'joy-1-ignite.png') });
  await cer.getByText('금빛 아침').waitFor();
  await cer.getByText('새로 발견').waitFor();
  await cer.getByText('첫 창문에 불이 켜졌어요').waitFor();
  assert.equal(await cer.locator('#cerStreak').textContent(), '0일');
  await page.clock.runFor(2400);
  assert.equal(await cer.locator('#cerStreak').textContent(), '1일', '연속 숫자가 올라감');
  await page.waitForTimeout(3800);   // CSS 전환(실제 시간)이 끝난 뒤 모습
  await page.screenshot({ path: path.join(SHOTS, 'joy-2-reveal.png') });
  await cer.getByText('연속 3일이 되면 아침 새가 날아와요 · 2일 남음').waitFor();
  await cer.getByRole('button', { name: '확인' }).click();
  assert.equal(await cer.count(), 0);
  await page.getByText('오늘의 하늘 · 금빛 아침').waitFor();
  assert.match(await page.locator('.scene').first().getAttribute('style'), /linear-gradient/, '장면에 오늘 하늘');
  // 다시 보기: 새로 발견 표시는 없음
  await page.getByRole('button', { name: '다시 보기' }).click();
  await page.clock.runFor(300);
  await page.locator('#cer').waitFor();
  assert.equal(await page.locator('#cer').getByText('새로 발견').count(), 0);
  await page.locator('#cer').click({ position: { x: 200, y: 200 } });   // 화면 누르면 건너뛰기
  assert.ok(await page.locator('#cer').evaluate(e => e.classList.contains('done')));
  assert.equal(await page.locator('#cerStreak').textContent(), '1일');
  // 효과음 켜기 (기억됨)
  await page.locator('[data-cer-snd]').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('gachi-v2-sound')), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#cer').count(), 0);
  await page.screenshot({ path: path.join(SHOTS, 'joy-3-today.png'), fullPage: true });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('7일째: 칭호 "일주일의 리듬" + 보호권 획득 + 햇살 단계(e2), 드문 하늘 이상', async () => {
  const page = await open('2026-11-09T06:58:00', seed(range('2026-11-03', 6)));
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(300);
  const cer = page.locator('#cer');
  await cer.getByText("7일째 · 칭호 '일주일의 리듬'").waitFor();
  await cer.getByText('보호권을 1개 받았어요. 하루 빠져도 연속 기록이 이어져요').waitFor();
  assert.ok(await cer.evaluate(e => e.classList.contains('e2')), '연속 7일 → 햇살 단계');
  assert.match(await cer.locator('.cer-card').getAttribute('class'), /t[23]/, '칭호 날은 드묾 이상');
  await page.clock.runFor(3200);
  await page.waitForTimeout(3800);
  await page.screenshot({ path: path.join(SHOTS, 'joy-4-milestone.png') });
  await cer.getByRole('button', { name: '확인' }).click();
  await page.getByRole('button', { name: '습관' }).click();
  await page.getByText('7 / 66', { exact: true }).waitFor();
  assert.equal(await page.locator('.titles span.got').count(), 2);
  await page.screenshot({ path: path.join(SHOTS, 'joy-5-habit.png'), fullPage: true });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('보호권: 어제 빠졌어도 연속이 이어지고 연출에서 알려 준다', async () => {
  // 11/1~11/7 기록(보호권 1) → 11/8 빠짐 → 11/9 기록
  const page = await open('2026-11-09T07:05:00', seed(range('2026-11-01', 7)));
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(300);
  const cer = page.locator('#cer');
  await cer.getByText('어제는 보호권으로 연속 기록을 지켰어요').waitFor();
  await page.clock.runFor(3000);
  assert.equal(await cer.locator('#cerStreak').textContent(), '8일');
  await cer.getByRole('button', { name: '확인' }).click();
  await page.getByText('연속 8일').waitFor();
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('움직임 줄이기: 연출이 바로 마지막 모습으로', async () => {
  const page = await open('2026-11-09T07:00:00', seed([]), { reduced: true });
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(300);
  const cer = page.locator('#cer');
  await cer.waitFor();
  assert.ok(await cer.evaluate(e => e.classList.contains('done')));
  assert.equal(await cer.locator('#cerStreak').textContent(), '1일');
  await page.context().close();
});

test('지난주 리포트: 화요일에 카드 → 열면 기록 수·평균·하늘, 본 뒤엔 카드가 사라진다', async () => {
  const days = [...range('2026-10-26', 5, 450), ...range('2026-11-02', 6, 425)];   // 전주 평균 07:30, 지난주 07:05
  const page = await open('2026-11-10T08:00:00', seed(days));
  await page.getByText('지난주 리포트가 왔어요').waitFor();
  await page.locator('[data-recap]').click();
  await page.getByRole('heading', { name: '지난주 리포트' }).waitFor();
  await page.getByText('11/2~11/8 · 월요일부터 일요일까지').waitFor();
  assert.equal(await page.locator('#sheetBody .stat-num').nth(0).textContent(), '6 / 7');
  assert.equal(await page.locator('#sheetBody .stat-num').nth(2).textContent(), '07:05');
  await page.getByText('전주보다 25분 빨라짐').waitFor();
  await page.getByText('평균 시작이 전주보다 25분 빨라졌어요.').waitFor();
  assert.equal(await page.locator('#sheetBody .sky-swatch').count(), 6);
  await page.screenshot({ path: path.join(SHOTS, 'joy-6-recap.png') });
  await page.getByRole('button', { name: '닫기' }).click();
  assert.equal(await page.getByText('지난주 리포트가 왔어요').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
