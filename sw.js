const CACHE_NAME = 'p1-cache-v3';
const STREAM_PATH = '/stream/';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());

// 消息通道
let dataPort = null;
const chunkMap = new Map(); // reqId -> { controller }

self.addEventListener('message', event => {
  const msg = event.data;
  if (msg && msg.type === 'INIT_PORT') {
    dataPort = event.ports && event.ports[0];
    if (dataPort) dataPort.onmessage = handleClientMsg;
  }
});

function handleClientMsg(event) {
  const { type, reqId, chunk, done } = (event.data || {});
  if (type !== 'STREAM_DATA') return;
  const ctx = chunkMap.get(reqId);
  if (!ctx) return;
  try {
    if (chunk) ctx.controller.enqueue(new Uint8Array(chunk));
    if (done) {
      ctx.controller.close();
      chunkMap.delete(reqId);
    }
  } catch (e) {
    chunkMap.delete(reqId);
    // 可选：通知页面中止
    // notifyClient({ type:'PULL_ABORT', reqId, reason:'enqueue_error' });
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith(STREAM_PATH)) {
    const fileId = url.pathname.slice(STREAM_PATH.length);
    event.respondWith(handleStream(event.request, fileId));
    return;
  }
  // 其他资源：维持原缓存策略
  event.respondWith(caches.match(event.request).then(res => res || fetch(event.request)));
});

async function handleStream(request, fileId) {
  const method = request.method || 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return new Response(null, { status: 405, headers: baseHeaders() });
  }

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...baseHeaders(), 'Accept-Ranges': 'bytes' } });
  }

  const meta = await getMetaFromClient(fileId);
  if (!meta || !meta.size) {
    return new Response('meta not available', { status: 404, headers: baseHeaders() });
  }

  const size = +meta.size;
  const type = meta.type || guessTypeByName(meta.name) || 'video/mp4';

  const r = parseRange(request.headers.get('range'), size);
  if (r === null) {
    // 非法范围
    const h = { ...baseHeaders(), 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` };
    return new Response(null, { status: 416, headers: h });
  }

  const common = { ...baseHeaders(), 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Vary': 'Range' };

  // HEAD：仅返回头
  if (method === 'HEAD') {
    if (r.partial) {
      const len = r.end - r.start + 1;
      return new Response(null, { status: 206, headers: { ...common, 'Content-Range': `bytes ${r.start}-${r.end}/${size}`, 'Content-Length': String(len) } });
    } else {
      return new Response(null, { status: 200, headers: { ...common, 'Content-Length': String(size) } });
    }
  }

  // GET：构造流并按精确范围下发
  const reqId = Math.random().toString(36).slice(2);
  const body = new ReadableStream({
    start(controller) {
      chunkMap.set(reqId, { controller });
      notifyClient({ type: 'PULL_START', reqId, fileId, start: r.start, end: r.end }); // end 为含端
    },
    cancel() {
      chunkMap.delete(reqId);
      notifyClient({ type: 'PULL_CANCEL', reqId });
    }
  });

  if (r.partial) {
    const len = r.end - r.start + 1;
    const headers = { ...common, 'Content-Range': `bytes ${r.start}-${r.end}/${size}`, 'Content-Length': String(len) };
    return new Response(body, { status: 206, headers });
  } else {
    const headers = { ...common, 'Content-Length': String(size) };
    return new Response(body, { status: 200, headers });
  }
}

function parseRange(header, size) {
  if (!size || size <= 0) return { start: 0, end: -1, partial: false };
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /bytes=(\d*)-(\d*)/i.exec(header);
  if (!m) return null;
  let [, s, e] = m;
  if (s === '' && e) { // 后缀范围 -N
    const len = Math.min(parseInt(e, 10), size);
    return { start: size - len, end: size - 1, partial: true };
  }
  const start = parseInt(s, 10);
  const end = e ? Math.min(parseInt(e, 10), size - 1) : size - 1;
  if (Number.isNaN(start) || start < 0 || start > end) return null;
  return { start, end, partial: true };
}

function getMetaFromClient(fileId) {
  return new Promise(resolve => {
    if (!dataPort) { resolve(null); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = e => resolve(e.data || null);
    dataPort.postMessage({ type: 'GET_META', fileId }, [ch.port2]);
  });
}

function notifyClient(msg) { if (dataPort) dataPort.postMessage(msg); }
function baseHeaders() { return { 'Cache-Control': 'no-store' }; }
function guessTypeByName(name = '') {
  const n = (name || '').toLowerCase();
  if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.mkv')) return 'video/x-matroska';
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.m4a') || n.endsWith('.aac')) return 'audio/mp4';
  return null;
}
