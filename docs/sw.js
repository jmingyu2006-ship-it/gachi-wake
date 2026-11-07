// 같이 일어나요 — 오프라인에서도 앱이 열리게 하는 서비스 워커
// 앱 파일을 바꿔 배포할 때는 VERSION을 올려 주세요.
const VERSION = 'gachi-v0.3.1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './config.js', './icons/icon-192.png', './icons/icon-512.png', './og.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 공유 서버·폰트 등 다른 주소는 그대로 네트워크로
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // 같은 주소: 저장된 화면을 먼저 보여주고, 뒤에서 새 버전을 받아 둠
  e.respondWith(
    caches.open(VERSION).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => hit || cache.match('./index.html'));
        return hit || net;
      })
    )
  );
});
