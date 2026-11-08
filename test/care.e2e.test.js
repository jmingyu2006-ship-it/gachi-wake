// v0.6 사용자·운영 보완: 밤 첫 방문, 아침 알림, 설치·앱 안 브라우저 안내, 기록 이미지, 내보내기, 약관, 요청 절약
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
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const KAKAO = IOS_SAFARI.replace('Safari/604.1', 'KAKAOTALK 10.8.0');

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

async function open(isoLocal, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block', acceptDownloads: true, userAgent: opts.ua });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: opts.config || 'window.GACHI_CONFIG={};' }));
  await page.route(/supabase\.co/, r => r.abort());
  if (opts.route) await opts.route(page);
  await page.clock.install({ time: new Date(isoLocal + '+09:00') });
  await page.goto(opts.url || BASE);
  return page;
}
async function onboard(page, age = '20대') {
  await page.getByRole('button', { name: '목표 정하기' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: age }).click();
  await page.getByRole('button', { name: '시작하기' }).click();
}
const readDownload = async (dl) => fs.readFileSync(await dl.path(), 'utf8');

// 하루 시작 → 불 켜기 연출이 뜨면 '확인'으로 닫기
async function startDay(page) {
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(400);
  const cer = page.locator('#cer');
  if (await cer.count()) await cer.getByRole('button', { name: '확인' }).click();
}

test('밤 1시 첫 방문: 잘 시간 안내 → 아침 알림(캘린더 파일·구글 링크) 맞추면 카드가 사라진다, 약관 링크와 기기 번호', async () => {
  const page = await open('2026-11-09T01:00:00');
  // 첫 화면 약관 안내
  const terms = page.locator('#obBody').getByRole('link', { name: '이용약관' });
  assert.match(await terms.getAttribute('href'), /\/terms\.html$/);
  assert.match(await page.locator('#obBody').getByRole('link', { name: '개인정보 처리방침' }).getAttribute('href'), /\/privacy\.html$/);
  await onboard(page);
  await page.getByText('지금은 잘 시간이에요. 지금 잠들면 목표까지 6시간 45분 잘 수 있어요.').waitFor();
  await page.getByText('오늘 첫 아침 예약하기').waitFor();
  await page.screenshot({ path: path.join(SHOTS, 'care-night.png'), fullPage: true });
  await page.getByRole('button', { name: '예약' }).click();
  await page.getByText('오늘부터 매일 07:45').waitFor();
  const gcal = await page.getByRole('link', { name: '구글 캘린더에 추가' }).getAttribute('href');
  assert.match(gcal, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&.*dates=20261109T074500\/20261109T075500&ctz=Asia%2FSeoul&recur=RRULE%3AFREQ%3DDAILY/);
  await page.screenshot({ path: path.join(SHOTS, 'care-reminder.png') });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '아이폰·맥 캘린더에 추가' }).click()]);
  assert.equal(dl.suggestedFilename(), 'gachi-wake-morning.ics');
  const ics = (await readDownload(dl)).replace(/\r\n /g, '');
  assert.match(ics, /DTSTART:20261109T074500\r\nDURATION:PT10M\r\nRRULE:FREQ=DAILY\r\n/, '지금 단계 목표로 매일 (앞당기면 다시 추가)');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.equal(await page.locator('section.card', { hasText: '첫 아침 예약하기' }).count(), 0, '맞춘 뒤엔 카드 사라짐');
  // 목표를 바꾸면 다시 맞추라고 안내
  await page.getByRole('button', { name: '목표 설정 열기' }).click();
  assert.equal(await page.getByText('내 기기 번호 앞 8자리').count(), 0, '서버 없는 모드에선 기기 번호 안내 없음');
  await page.locator('.stepper[data-for="targetMin"] [data-d="15"]').click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.locator('section.card', { hasText: '알림 다시 맞추기' }).waitFor();
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('기록 이미지(1080×1920)와 엑셀용 CSV 내보내기', async () => {
  const page = await open('2026-11-09T07:40:00');
  await onboard(page);
  await startDay(page);
  await page.clock.runFor(1600);
  await page.getByRole('button', { name: '기록 이미지' }).waitFor();
  await page.locator('[data-share-image]').click();
  await page.getByRole('button', { name: '공유하기' }).and(page.locator(':not([disabled])')).waitFor();
  const size = await page.locator('#shareImg').evaluate(i => [i.naturalWidth, i.naturalHeight, i.src.slice(0, 22)]);
  assert.deepEqual(size, [1080, 1920, 'data:image/png;base64,']);
  await page.screenshot({ path: path.join(SHOTS, 'care-share-sheet.png') });
  const [img] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '이미지 저장' }).click()]);
  assert.equal(img.suggestedFilename(), 'gachi-wake-2026-11-09.png');
  fs.copyFileSync(await img.path(), path.join(SHOTS, 'care-share-card.png'));
  await page.getByRole('button', { name: '닫기' }).click();
  await page.getByRole('button', { name: '목표 설정 열기' }).click();
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '기록 내보내기 (엑셀·CSV)' }).click()]);
  const body = await readDownload(csv);
  assert.equal(body.charCodeAt(0), 0xFEFF, '엑셀 한글 깨짐 방지');
  assert.match(body, /날짜,요일,하루 시작,그날 목표,목표와 차이\(분\),결과,첫 행동\r\n2026-11-09,월,07:40,07:45,-5,목표 달성,\r\n$/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('아이폰 Safari: 홈 화면 추가 안내 → "이미 했어요"면 다시 안 보임 / 카카오톡 안: 외부 브라우저로 열기', async () => {
  const ios = await open('2026-11-09T07:40:00', { ua: IOS_SAFARI });
  await onboard(ios);
  await ios.getByText('홈 화면에 추가해 두세요').waitFor();
  await ios.screenshot({ path: path.join(SHOTS, 'care-install.png'), fullPage: true });
  await ios.getByRole('button', { name: '이미 했어요' }).click();
  assert.equal(await ios.getByText('홈 화면에 추가해 두세요').count(), 0);
  await ios.reload();
  await ios.getByRole('button', { name: '하루 시작하기' }).waitFor();
  assert.equal(await ios.getByText('홈 화면에 추가해 두세요').count(), 0, '다시 열어도 안 보임');
  assert.deepEqual(ios.errors, []);
  await ios.context().close();

  const kk = await open('2026-11-09T07:40:00', { ua: KAKAO });
  await kk.getByText('카카오톡 안에서 열었어요.').waitFor();
  await kk.screenshot({ path: path.join(SHOTS, 'care-kakao.png') });
  let external = null;
  kk.on('request', r => { if (r.url().startsWith('kakaotalk:')) external = r.url(); });
  await kk.evaluate(() => { window.__nav = []; });
  await onboard(kk);
  await kk.getByText('Safari나 Chrome에서 열어 주세요').waitFor();
  assert.equal(await kk.getByText('홈 화면에 추가해 두세요').count(), 0, '앱 안 브라우저에선 설치 안내 대신 브라우저 안내');
  assert.deepEqual(kk.errors, []);
  await kk.context().close();
});

test('약관·처리방침 페이지가 열리고, config의 문의 이메일이 들어간다', async () => {
  const page = await open('2026-11-09T07:40:00', { url: BASE + 'privacy.html', config: "window.GACHI_CONFIG={contact:'help@example.com'};" });
  await page.getByRole('heading', { name: '개인정보 처리방침' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'help@example.com' }).first().getAttribute('href'), 'mailto:help@example.com');
  await page.screenshot({ path: path.join(SHOTS, 'care-privacy.png') });
  await page.goto(BASE + 'terms.html');
  await page.getByRole('heading', { name: '이용약관' }).waitFor();
  await page.getByText('만 14세 이상').first().waitFor();
  const bad = await open('2026-11-09T07:40:00', { url: BASE + 'terms.html', config: "window.GACHI_CONFIG={contact:'<img src=x onerror=alert(1)>'};" });
  assert.equal(await bad.getByRole('link', { name: 'GitHub 문의 게시판' }).count(), 1, '이상한 값이면 기본 안내 그대로');
  await page.context().close(); await bad.context().close();
});

test('화면이 꺼져 있을 땐 서버에 묻지 않고, 돌아오면 바로 새로 고친다', async () => {
  let n = 0;
  const page = await open('2026-11-09T07:40:00', {
    config: "window.GACHI_CONFIG={supabaseUrl:'https://mock.supabase.test',supabaseAnonKey:'k'};",
    route: async (p) => p.route('https://mock.supabase.test/**', r => {
      if (r.request().url().includes('day_counts')) n++;
      r.fulfill({ contentType: 'application/json', body: r.request().url().includes('day_counts') ? '[]' : 'null' });
    })
  });
  await onboard(page);
  await page.clock.runFor(1000);
  const before = n;
  assert.ok(before >= 1);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(95000);
  assert.equal(n, before, '꺼져 있는 동안 0번');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(500);
  assert.equal(n, before + 1, '돌아오자마자 1번');
  await page.context().close();
});
