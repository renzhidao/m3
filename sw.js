const CACHE_NAME = 'p1-v209-1765102480'; // 升级版本号

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './style.css'
];

// 安装阶段：跳过等待，立即接管
self.addEventListener('install', event => {
  self.skipWaiting(); // <-- 关键：强制新 SW 立即生效
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of CORE_ASSETS) {
      try {
        await cache.add(url);
      } catch (e) {
        console.warn('[SW] Failed to cache', url, e);
      }
    }
  })());
});

// 激活阶段：立即清理旧缓存并控制所有客户端
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())
    )).then(() => self.clients.claim()) // <-- 关键：立即控制当前页面，无需刷新两次
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 调试模式：注册表和加载器永远网络优先，防止死循环
  if (url.pathname.endsWith('registry.txt') || url.pathname.endsWith('loader.js') || url.pathname.endsWith('app.js')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  if (req.method === 'GET') {
    event.respondWith(
      caches.match(req).then(cached => {
        const networkFetch = fetch(req).then(res => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
          return res;
        });
        // 缓存优先，但会在后台更新
        return cached || networkFetch;
      })
    );
  }
});