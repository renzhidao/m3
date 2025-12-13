const CACHE_NAME = 'p1-stream-v1765199405'; // Version Fix-200-OK
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

self.addEventListener('message', event => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'PING') {
        try { event.source && event.source.postMessage({ type: 'PING' }); } catch(e) {}
        return;
    }

    if (!data.requestId) return;

    const controller = streamControllers.get(data.requestId);
    if (!controller) return;

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
            try { controller.error(new Error(data.msg)); } catch(e) {}
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
    // === 兼容性恢复: 激进的 Client 查找 (针对图片并发) ===
    let client = await self.clients.get(clientId);
    if (!client) {
        await self.clients.claim();
        for (let i = 0; i < 3; i++) {
            const list = await self.clients.matchAll({type:'window', includeUncontrolled:true});
            if (list && list.length > 0) { client = list[0]; break; }
            await new Promise(r => setTimeout(r, 100));
        }
    }

    if (!client) return new Response("Service Worker: No Client Active", { status: 503 });

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
    catch(e) { fileName = segs.slice(1).join('/') || 'file'; }

    // === 关键判断: 是否有 Range ===
    const rangeHeader = event.request.headers.get('Range');
    const requestId = Math.random().toString(36).slice(2) + Date.now();

    const stream = new ReadableStream({
        start(controller) {
            streamControllers.set(requestId, controller);
            // 传给主线程，让 Core 知道是否有 range
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
            if (d && d.requestId === requestId) {
                if (d.type === 'STREAM_META') {
                    self.removeEventListener('message', metaHandler);
                    const headers = new Headers();
                    
                    const total = d.fileSize;
                    const start = d.start;
                    const end = d.end;
                    const len = end - start + 1;

                    headers.set('Content-Disposition', `inline; filename="${fileName}"`);
                    headers.set('Content-Length', len);

                    // === 核心修复逻辑 ===
                    if (rangeHeader) {
                        // 【视频流模式】 -> 206 Partial Content
                        // 类型优先用 core 传回的，或者是 mp4
                        headers.set('Content-Type', d.fileType || 'video/mp4');
                        headers.set('Accept-Ranges', 'bytes');
                        headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
                        resolve(new Response(stream, { status: 206, headers }));
                    } else {
                        // 【旧版模式】 -> 200 OK (图片/音频/下载)
                        // 强制 octet-stream，让浏览器自己 Sniff 图片头
                        headers.set('Content-Type', 'application/octet-stream');
                        // 不发送 Content-Range
                        // 不发送 Accept-Ranges (模仿旧版行为)
                        resolve(new Response(stream, { status: 200, headers }));
                    }
                } 
                else if (d.type === 'STREAM_ERROR') {
                    self.removeEventListener('message', metaHandler);
                    streamControllers.delete(requestId);
                    resolve(new Response(d.msg || 'File Not Found', { status: 404 }));
                }
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
