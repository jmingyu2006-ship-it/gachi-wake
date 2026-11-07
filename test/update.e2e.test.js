// 새 버전 배포 → 열려 있던 앱이 알아차리고 바뀌는지 (실제 서비스 워커로)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require(process.env.PW_PATH || '/opt/npm-tools/node_modules/playwright');

const SRC = path.join(__dirname, '../dist/web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
let browser, server, BASE, DIR;

test.before(async () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gachi-up-'));
  fs.cpSync(SRC, DIR, { recursive: true });
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(DIR, p);
    if (!f.startsWith(DIR) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    // GitHub Pages처럼 10분 캐시
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port + '/';
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
});
test.after(async () => { await browser.close(); server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

function deploy(tag) {
  const idx = path.join(DIR, 'index.html'), sw = path.join(DIR, 'sw.js');
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/<meta name="build-tag"[^>]*>|<\/head>/, (m) => '<meta name="build-tag" content="' + tag + '">' + (m === '</head>' ? '</head>' : '')));
  fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/const VERSION = '[^']*'/, "const VERSION = 'test-" + tag + "'"));
}
const tagOf = (page) => page.evaluate(() => (document.querySelector('meta[name="build-tag"]') || {}).content || 'v1');

test('배포하면: 보고 있을 땐 "새 버전" 버튼 → 누르면 적용, 앱을 내렸다 오면 저절로 적용, 기록은 그대로', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
  await context.route(/supabase\.co|fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.evaluate(() => localStorage.setItem('gachi-v2-records', JSON.stringify([{ date: '2026-11-08', minuteOfDay: 400 }])));
  const recBefore = await page.evaluate(() => localStorage.getItem('gachi-v2-records'));
  await page.reload();
  assert.equal(await tagOf(page), 'v1');
  assert.equal(await page.locator('#updateBar').isVisible(), false, '평소엔 안 보임');

  // 1) 배포 → 앱으로 돌아옴(visibilitychange) → 버튼
  deploy('v2');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#updateBar').waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await page.locator('#updateBar').textContent(), '새 버전이 있어요 · 눌러서 적용');
  assert.equal(await tagOf(page), 'v1', '누르기 전엔 그대로');
  await Promise.all([page.waitForEvent('load'), page.locator('#updateBar').click()]);
  assert.equal(await tagOf(page), 'v2', '누르면 새 버전 (10분 캐시도 건너뜀)');
  assert.equal(await page.locator('#updateBar').isVisible(), false);

  // 2) 앱이 뒤로 가 있는 동안 새 버전이 잡히면 저절로 새로 고침
  deploy('v3');
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }));
  await Promise.all([page.waitForEvent('load', { timeout: 15000 }), page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()))]);
  assert.equal(await tagOf(page), 'v3');
  assert.equal(await page.evaluate(() => localStorage.getItem('gachi-v2-records')), recBefore, '기록 그대로');

  // 3) 인터넷이 끊겨도 저장된 화면으로 열림
  await context.setOffline(true);
  await page.reload();
  assert.equal(await tagOf(page), 'v3');
  await context.setOffline(false);
  assert.deepEqual(errors, []);
  await context.close();
});
