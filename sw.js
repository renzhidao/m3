const CACHE_NAME = 'p1-stream-v1765199403-fix2'; // Bump Version (fix2)
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './loader.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(CORE_ASSETS).catch(()=>{})));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())
    )).then(() => self.clients.claim())
  );
});

const streamControllers = new Map();

function guessMime(fileName) {
  const n = (fileName || '').toLowerCase();
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.wav')) return 'audio/wav';
  if (n.endsWith('.m4a')) return 'audio/mp4';
  if (n.endsWith('.aac')) return 'audio/aac';
  if (n.endsWith('.ogg')) return 'audio/ogg';
  if (n.endsWith('.mp4') || n.endsWith('.m4v') || n.endsWith('.mov')) return 'video/mp4';
  if (n.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

self.addEventListener('message', event => {
    const data = event.data;
    if (!data) return;

    // ✅ 兼容握手：页面发 PING，这里回 PING
    if (data.type === 'PING') {
        try { event.source && event.source.postMessage({ type: 'PING' }); } catch(e) {}
        return;
    }

    // 允许页面触发立即激活
    if (data.type === 'SKIP_WAITING') {
        try { self.skipWaiting(); } catch(e) {}
        return;
    }

    if (!data.requestId) return;

    const controller = streamControllers.get(data.requestId);
    if (!controller) {
        // HEAD 流程/或已取消：允许 metaHandler 单独处理 STREAM_META/STREAM_ERROR
        return;
    }

    switch (data.type) {
        case 'STREAM_DATA':
            try {
                if (data.chunk) controller.enqueue(new Uint8Array(data.chunk));
            } catch(e) { }
            break;
        case 'STREAM_END':
            try { controller.close(); } catch(e) {}
            streamControllers.delete(data.requestId);
            break;
        case 'STREAM_ERROR':
            try { controller.error(new Error(data.msg || 'STREAM_ERROR')); } catch(e) {}
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
    const client = await self.clients.get(clientId) || (await self.clients.matchAll({type:'window', includeUncontrolled: true}))[0];

    if (!client) return new Response("Service Worker: No Client Active", { status: 503 });

    // ✅ 关键修复：兼容 /repo/virtual/file/... 这种带前缀子路径（GitHub Pages/任意 Pages）
    const pathname = new URL(event.request.url).pathname;
    const marker = '/virtual/file/';
    const idx = pathname.indexOf(marker);
    if (idx === -1) return new Response("Bad Virtual URL", { status: 400 });

    const tail = pathname.slice(idx + marker.length);
    const segs = tail.split('/').filter(Boolean);

    const fileId = segs[0];
    if (!fileId) return new Response("Bad Virtual URL (missing fileId)", { status: 400 });

    let fileName = 'file';
    try {
        fileName = decodeURIComponent(segs.slice(1).join('/') || 'file');
    } catch(e) {
        fileName = segs.slice(1).join('/') || 'file';
    }

    const method = (event.request.method || 'GET').toUpperCase();
    const range = event.request.headers.get('Range'); // may be null
    const hasRange = !!(range && String(range).startsWith('bytes='));
    const requestId = Math.random().toString(36).slice(2) + Date.now();

    // HEAD：只取 meta，不返回 body，且立刻 cancel，避免页面继续拉流
    if (method === 'HEAD') {
        try { client.postMessage({ type: 'STREAM_OPEN', requestId, fileId, range }); } catch(e) {}
        const res = await waitMetaAndBuildResponse({ requestId, client, fileName, range, hasRange, stream: null, isHead: true });
        try { client.postMessage({ type: 'STREAM_CANCEL', requestId }); } catch(e) {}
        return res;
    }

    const stream = new ReadableStream({
        start(controller) {
            streamControllers.set(requestId, controller);
            client.postMessage({ type: 'STREAM_OPEN', requestId, fileId, range });
        },
        cancel() {
            streamControllers.delete(requestId);
            try { client.postMessage({ type: 'STREAM_CANCEL', requestId }); } catch(e) {}
        }
    });

    return waitMetaAndBuildResponse({ requestId, client, fileName, range, hasRange, stream, isHead: false });
}

function waitMetaAndBuildResponse({ requestId, client, fileName, range, hasRange, stream, isHead }) {
    return new Promise(resolve => {
        const metaHandler = (e) => {
            const d = e.data;
            if (!d || d.requestId !== requestId) return;

            if (d.type === 'STREAM_META') {
                self.removeEventListener('message', metaHandler);

                const headers = new Headers();
                const mime = d.fileType || guessMime(fileName);
                headers.set('Content-Type', mime);
                headers.set('Accept-Ranges', 'bytes');
                headers.set('Cache-Control', 'no-store');
                headers.set('Content-Disposition', `inline; filename="${fileName}"`);

                const total = Number(d.fileSize || 0);
                const start = Number(d.start || 0);
                const end = Number((d.end !== undefined && d.end !== null) ? d.end : (total ? (total - 1) : 0));

                if (hasRange) {
                    // Range 请求：206 + Content-Range
                    headers.set('Content-Range', `bytes ${start}-${end}/${total || '*'}`);
                    const len = Math.max(0, end - start + 1);
                    headers.set('Content-Length', String(len));
                    resolve(new Response(isHead ? null : stream, { status: 206, headers }));
                } else {
                    // 非 Range 请求（图片/音频常见）：用 200，避免部分浏览器对 206/Content-Range 处理异常
                    if (total) headers.set('Content-Length', String(total));
                    resolve(new Response(isHead ? null : stream, { status: 200, headers }));
                }
            } 
            else if (d.type === 'STREAM_ERROR') {
                self.removeEventListener('message', metaHandler);
                streamControllers.delete(requestId);
                resolve(new Response(d.msg || 'File Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } }));
            }
        };

        self.addEventListener('message', metaHandler);

        setTimeout(() => {
            self.removeEventListener('message', metaHandler);
            if (streamControllers.has(requestId)) {
                streamControllers.delete(requestId);
            }
            resolve(new Response("Gateway Timeout (Metadata Wait)", { status: 504, headers: { 'Cache-Control': 'no-store' } }));
        }, 15000);
    });
}
