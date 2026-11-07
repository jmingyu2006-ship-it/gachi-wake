// 빌드: src/logic.js + src/app.html → 두 가지 결과물
//   dist/artifact/index.html  claude.ai에서 미리보기용 한 파일 (예시 데이터)
//   dist/web/                 로그인 없이 어느 웹 호스팅에나 올리는 PWA 폴더
const fs = require('fs');
const path = require('path');
const R = (...p) => path.join(__dirname, ...p);

const logic = fs.readFileSync(R('src/logic.js'), 'utf8');
const html = fs.readFileSync(R('src/app.html'), 'utf8');
for (const mark of ['/*__LOGIC__*/', '<!--__WEB_HEAD__-->', '/*__WEB_INIT__*/']) {
  if (!html.includes(mark)) throw new Error('missing placeholder ' + mark);
}
// SITE_URL: 공개 주소 (예: https://아이디.github.io/gachi-wake/) — 공유 링크와 카카오톡 미리보기에 쓰임
const SITE_URL = (process.env.SITE_URL || '').replace(/\/?$/, process.env.SITE_URL ? '/' : '');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const SITE_HEAD = SITE_URL ? [
  `<script>window.GACHI_SITE_URL = ${JSON.stringify(SITE_URL)};</script>`,
  `<meta property="og:type" content="website">`,
  `<meta property="og:title" content="같이 일어나요">`,
  `<meta property="og:description" content="하루를 시작하고 싶은 시각을 정하고, 같이 지켜요. 지금 몇 명의 창문에 불이 켜졌는지 보세요.">`,
  `<meta property="og:url" content="${esc(SITE_URL)}">`,
  `<meta property="og:image" content="${esc(SITE_URL)}og.png">`,
  `<meta property="og:image:width" content="1200">`,
  `<meta property="og:image:height" content="630">`,
  `<meta name="twitter:card" content="summary_large_image">`
].join('\n') : '';
const withLogic = html.replace('/*__LOGIC__*/', () => logic);

const WEB_HEAD = [
  SITE_HEAD,
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="icon" href="icons/icon-192.png" type="image/png">',
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="같이 일어나요">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<script src="config.js"></script>'
].join('\n');
const WEB_INIT = "if ('serviceWorker' in navigator && location.protocol !== 'file:') { window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); }); }";

function out(rel, content) { fs.mkdirSync(path.dirname(R('dist', rel)), { recursive: true }); fs.writeFileSync(R('dist', rel), content); }

out('artifact/index.html', withLogic.replace('<!--__WEB_HEAD__-->', () => SITE_URL ? `<script>window.GACHI_SITE_URL = ${JSON.stringify(SITE_URL)};</script>` : '').replace('/*__WEB_INIT__*/', ''));
out('web/index.html', withLogic.replace('<!--__WEB_HEAD__-->', () => WEB_HEAD).replace('/*__WEB_INIT__*/', () => WEB_INIT));
for (const f of ['sw.js', 'manifest.webmanifest', 'config.js', 'supabase.sql', 'supabase-rooms.sql', 'supabase-profiles.sql', 'supabase-owner-accounts.sql', 'DEPLOY.md']) {
  if (fs.existsSync(R('web', f))) out('web/' + f, fs.readFileSync(R('web', f)));
}
out('web/.nojekyll', '');

(async () => {
  const sharp = require(process.env.SHARP_PATH || '/opt/npm-tools/node_modules/sharp');
  const svg = fs.readFileSync(R('web/icon.svg'));
  fs.mkdirSync(R('dist/web/icons'), { recursive: true });
  await sharp(svg).resize(192, 192).png().toFile(R('dist/web/icons/icon-192.png'));
  await sharp(svg).resize(512, 512).png().toFile(R('dist/web/icons/icon-512.png'));
  await sharp(svg).resize(180, 180).png().toFile(R('dist/web/icons/apple-touch-icon.png'));
  // maskable: 안전 영역을 위해 여백을 더한 버전
  const inner = await sharp(svg).resize(400, 400).png().toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0E1322' } })
    .composite([{ input: inner, left: 56, top: 56 }]).png().toFile(R('dist/web/icons/icon-maskable-512.png'));
  // 링크 미리보기 이미지 (카카오톡·메신저용 1200x630)
  await sharp(fs.readFileSync(R('web/og.svg'))).png().toFile(R('dist/web/og.png'));
  console.log('built dist/artifact and dist/web');
})();
