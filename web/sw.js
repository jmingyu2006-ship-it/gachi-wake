// 같이 일어나요 — 오프라인에서도 앱이 열리게 하는 서비스 워커
// 앱 파일을 바꿔 배포할 때는 VERSION을 올려 주세요.
const VERSION = 'gachi-v0.12.2';
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
  const page = req.mode === 'navigate' || /\/(index\.html)?$/.test(url.pathname) || url.pathname.endsWith('/config.js');
  e.respondWith(page ? networkFirst(req) : staleWhileRevalidate(req));
});

// 앱 화면(index.html): 새 버전을 먼저 받아 보고, 인터넷이 없거나 4초 넘게 걸리면 저장된 화면
function networkFirst(req) {
  return caches.open(VERSION).then((cache) => {
    const net = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    const fallback = () => cache.match(req, { ignoreSearch: true }).then((hit) => hit || cache.match('./index.html'));
    const slow = new Promise((resolve) => setTimeout(resolve, 4000)).then(fallback);
    return Promise.race([net.catch(fallback), slow.then((hit) => hit || net)]).then((res) => res || net);
  });
}

// 아이콘 등: 저장된 것을 먼저 보여주고, 뒤에서 새 것으로 바꿔 둠
function staleWhileRevalidate(req) {
  return caches.open(VERSION).then((cache) =>
    cache.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit || cache.match('./index.html'));
      return hit || net;
    })
  );
}

// ---------- 푸시 알림 (아침·잘 시간, 켠 사람만) ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  const title = String(d.title || 'dayset').slice(0, 80);
  e.waitUntil(self.registration.showNotification(title, {
    body: String(d.body || '').slice(0, 200),
    tag: String(d.tag || 'gachi'),
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: typeof d.url === 'string' ? d.url : './' }
  }));
});

// 알림을 누르면: 열려 있는 앱이 있으면 그 창으로, 없으면 새로 열기 (이 사이트 안의 주소만)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let target = new URL('./', self.registration.scope).href;
  try {
    const u = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope);
    if (u.href.startsWith(self.registration.scope)) target = u.href;
  } catch (x) {}
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(target);
  }));
});
