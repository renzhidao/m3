const CACHE_NAME = 'p1-stream-v1765266936'; // Auto-updated
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
const streamClients = new Map(); // 记录 RequestId -> ClientId 映射

function logToClient(requestId, msg, level='ERROR') {
    const clientId = streamClients.get(requestId);
    if (!clientId) return;
    self.clients.get(clientId).then(client => {
        if (client) client.postMessage({ type: 'SW_LOG', level, msg, requestId });
    });
}

self.addEventListener('message', event => {
    const data = event.data;
    if (!data || !data.requestId) return;

    const controller = streamControllers.get(data.requestId);
    
    // 收到主线程的心跳或日志请求，可选
    
    if (!controller) {
        if (data.type === 'STREAM_DATA') {
            // 管道可能已断开
            // logToClient(data.requestId, 'SW: 收到数据但管道已关闭', 'WARN');
        }
        return;
    }

    switch (data.type) {
        case 'STREAM_DATA':
            try {
                if (data.chunk) {
                    controller.enqueue(new Uint8Array(data.chunk));
                }
            } catch(e) { 
                logToClient(data.requestId, `SW Enqueue Fail: ${e.message}`, 'FATAL');
                try { controller.error(e); } catch(err){}
                streamControllers.delete(data.requestId);
            }
            break;
        case 'STREAM_END':
            try { controller.close(); } catch(e) {}
            streamControllers.delete(data.requestId);
            streamClients.delete(data.requestId);
            break;
        case 'STREAM_ERROR':
            const err = new Error(data.msg);
            logToClient(data.requestId, `SW收到主线程报错: ${data.msg}`, 'ERROR');
            try { controller.error(err); } catch(e) {}
            streamControllers.delete(data.requestId);
            streamClients.delete(data.requestId);
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
    let client = await self.clients.get(clientId);
    
    // 如果找不到 Client，尝试 Claim 并轮询
    if (!client) {
        await self.clients.claim();
        for (let i = 0; i < 5; i++) { // 尝试 5 次，每次 200ms
            const clients = await self.clients.matchAll({type:'window', includeUncontrolled: true});
            if (clients && clients.length > 0) {
                client = clients[0];
                break;
            }
            await new Promise(r => setTimeout(r, 200));
        }
    }
    
    if (!client) return new Response("Service Worker: No Client Active (Retry Failed)", { status: 503 });

    const parts = new URL(event.request.url).pathname.split('/');
    const fileId = parts[3];
    const range = event.request.headers.get('Range');
    const requestId = Math.random().toString(36).slice(2) + Date.now();

    // 记录映射，以便回传日志
    streamClients.set(requestId, client.id);

    const stream = new ReadableStream({
        start(controller) {
            streamControllers.set(requestId, controller);
            client.postMessage({ type: 'STREAM_OPEN', requestId, fileId, range });
        },
        cancel(reason) {
            logToClient(requestId, `浏览器取消流: ${reason}`, 'WARN');
            streamControllers.delete(requestId);
            streamClients.delete(requestId);
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
                    headers.set('Content-Type', d.fileType || 'application/octet-stream');
                    headers.set('Accept-Ranges', 'bytes');
                    const total = d.fileSize;
                    const start = d.start;
                    const end = d.end;
                    headers.set('Content-Length', end - start + 1);
                    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
                    resolve(new Response(stream, { status: 206, headers }));
                } 
                else if (d.type === 'STREAM_ERROR') {
                    self.removeEventListener('message', metaHandler);
                    streamControllers.delete(requestId);
                    streamClients.delete(requestId);
                    resolve(new Response(d.msg || 'File Not Found', { status: 404 }));
                }
            }
        };

        self.addEventListener('message', metaHandler);

        setTimeout(() => {
            self.removeEventListener('message', metaHandler);
            if (streamControllers.has(requestId)) {
                logToClient(requestId, '等待 Meta 超时 (10s)', 'ERROR');
                streamControllers.delete(requestId);
                streamClients.delete(requestId);
                resolve(new Response("Gateway Timeout (Metadata Wait)", { status: 504 }));
            }
        }, 10000);
    });
}
