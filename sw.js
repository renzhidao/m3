const CACHE_NAME = 'p1-stream-v1765199409'; // Version Bump
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './loader.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(CORE_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())
    )).then(() => self.clients.claim())
  );
});

const streamControllers = new Map();

// 辅助函数：根据文件名或元数据猜测正确的 Content-Type
// 解决 audio/mp3 变成了 application/octet-stream 导致无法播放的问题
function guessMime(fileName, declaredType) {
  if (declaredType && typeof declaredType === 'string' && declaredType.trim() && declaredType !== 'application/octet-stream') {
      return declaredType;
  }
  const n = (fileName || '').toLowerCase();

  // audio
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.m4a')) return 'audio/mp4';
  if (n.endsWith('.aac')) return 'audio/aac';
  if (n.endsWith('.wav')) return 'audio/wav';
  if (n.endsWith('.ogg') || n.endsWith('.oga')) return 'audio/ogg';
  if (n.endsWith('.flac')) return 'audio/flac';
  if (n.endsWith('.webm')) return 'audio/webm';

  // image
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.svg')) return 'image/svg+xml';

  // video fallback
  if (n.endsWith('.mp4')) return 'video/mp4';

  return 'application/octet-stream';
}

self.addEventListener('message', event => {
  const data = event.data;
  if (!data) return;

  // 握手
  if (data.type === 'PING') {
    try { event.source && event.source.postMessage({ type: 'PING' }); } catch (e) {}
    return;
  }

  if (!data.requestId) return;

  const controller = streamControllers.get(data.requestId);
  if (!controller) return;

  switch (data.type) {
    case 'STREAM_DATA':
      try {
        if (data.chunk) controller.enqueue(new Uint8Array(data.chunk));
      } catch (e) {}
      break;
    case 'STREAM_END':
      try { controller.close(); } catch (e) {}
      streamControllers.delete(data.requestId);
      break;
    case 'STREAM_ERROR':
      try { controller.error(new Error(data.msg)); } catch (e) {}
      streamControllers.delete(data.requestId);
      break;
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. 拦截虚拟文件请求 (核心逻辑)
  if (url.pathname.includes('/virtual/file/')) {
    event.respondWith(handleVirtualStream(event));
    return;
  }

  // 2. 静态资源策略
  if (url.pathname.endsWith('registry.txt') || url.pathname.endsWith('.js')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // 3. 通用缓存策略
  event.respondWith(
    caches.match(event.request).then(cached => {
      const netFetch = fetch(event.request).then(res => {
        // 确保只缓存 http/https 协议的成功请求
        if (event.request.method === 'GET' && url.protocol.startsWith('http')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => null);
      return cached || netFetch;
    })
  );
});

async function handleVirtualStream(event) {
  // 1. 强力查找 Client，确保页面未受控时也能接管
  const clientId = event.clientId;
  let client = clientId ? await self.clients.get(clientId) : null;
  
  if (!client) {
    await self.clients.claim();
    // 重试机制：查找包括未受控的页面
    for (let i = 0; i < 3; i++) {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (list && list.length > 0) { client = list[0]; break; }
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!client) return new Response('Service Worker: No Client Active', { status: 503 });

  // 2. 解析路径 /virtual/file/{fileId}/{fileName}
  // 使用 indexOf 兼容 GitHub Pages 子路径
  const pathname = new URL(event.request.url).pathname;
  const marker = '/virtual/file/';
  const idx = pathname.indexOf(marker);
  if (idx === -1) return new Response('Bad Virtual URL', { status: 400 });

  const tail = pathname.slice(idx + marker.length);
  const segs = tail.split('/').filter(Boolean);
  const fileId = segs[0];
  if (!fileId) return new Response('Bad Virtual URL (missing fileId)', { status: 400 });

  let fileName = 'file';
  try { fileName = decodeURIComponent(segs.slice(1).join('/') || 'file'); }
  catch (e) { fileName = segs.slice(1).join('/') || 'file'; }

  const rangeHeader = event.request.headers.get('Range');
  const requestId = Math.random().toString(36).slice(2) + Date.now();

  const stream = new ReadableStream({
    start(controller) {
      streamControllers.set(requestId, controller);
      client.postMessage({ type: 'STREAM_OPEN', requestId, fileId, range: rangeHeader });
    },
    cancel() {
      streamControllers.delete(requestId);
      client.postMessage({ type: 'STREAM_CANCEL', requestId });
    }
  });

  return new Promise(resolve => {
    const metaHandler = (e) => {
      const d = e.data;
      if (!d || d.requestId !== requestId) return;

      if (d.type === 'STREAM_META') {
        self.removeEventListener('message', metaHandler);

        const headers = new Headers();
        const total = d.fileSize;
        const start = d.start;
        const end = d.end;
        const len = end - start + 1;

        // 使用 guessMime 修正 Content-Type
        headers.set('Content-Type', guessMime(fileName, d.fileType));
        headers.set('Content-Disposition', `inline; filename="${fileName}"`);
        headers.set('Content-Length', String(len));
        headers.set('Accept-Ranges', 'bytes');

        if (rangeHeader) {
          headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
          resolve(new Response(stream, { status: 206, headers }));
        } else {
          resolve(new Response(stream, { status: 200, headers }));
        }
        return;
      }

      if (d.type === 'STREAM_ERROR') {
        self.removeEventListener('message', metaHandler);
        streamControllers.delete(requestId);
        resolve(new Response(d.msg || 'File Not Found', { status: 404 }));
      }
    };

    self.addEventListener('message', metaHandler);

    // 15秒超时防止死锁
    setTimeout(() => {
      self.removeEventListener('message', metaHandler);
      if (streamControllers.has(requestId)) {
        streamControllers.delete(requestId);
        resolve(new Response('Gateway Timeout (Metadata Wait)', { status: 504 }));
      }
    }, 15000);
  });
}