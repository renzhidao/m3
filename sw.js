const CACHE_NAME = 'p1-stream-v1765199407'; // bump: ensure update
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './loader.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(CORE_ASSETS).catch(() => {})));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())
    )).then(() => self.clients.claim())
  );
});

const streamControllers = new Map();

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

  if (url.pathname.includes('/virtual/file/')) {
    event.respondWith(handleVirtualStream(event));
    return;
  }

  if (url.pathname.endsWith('registry.txt') || url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const netFetch = fetch(event.request).then(res => {
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
  const clientId = event.clientId;
  let client = clientId ? await self.clients.get(clientId) : null;

  if (!client) {
    await self.clients.claim();
    for (let i = 0; i < 3; i++) {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (list && list.length > 0) { client = list[0]; break; }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (!client) return new Response("Service Worker: No Client Active", { status: 503 });

  // 兼容 /repo/virtual/file/... 等子路径
  const pathname = new URL(event.request.url).pathname;
  const marker = '/virtual/file/';
  const idx = pathname.indexOf(marker);
  if (idx === -1) return new Response("Bad Virtual URL", { status: 400 });

  const tail = pathname.slice(idx + marker.length);
  const segs = tail.split('/').filter(Boolean);

  const fileId = segs[0];
  if (!fileId) return new Response("Bad Virtual URL (missing fileId)", { status: 400 });

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

        // 关键修复：图片/音频必须用真实 MIME 才能解码显示/播放
        headers.set('Content-Type', d.fileType || 'application/octet-stream');
        headers.set('Content-Disposition', `inline; filename="${fileName}"`);
        headers.set('Content-Length', String(len));

        if (rangeHeader) {
          headers.set('Accept-Ranges', 'bytes');
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

    setTimeout(() => {
      self.removeEventListener('message', metaHandler);
      if (streamControllers.has(requestId)) {
        streamControllers.delete(requestId);
        resolve(new Response("Gateway Timeout (Metadata Wait)", { status: 504 }));
      }
    }, 15000);
  });
}