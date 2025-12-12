import { MSG_TYPE, CHAT } from './constants.js';

function log(msg) {
    console.log(`[Core] ${msg}`);
    if (window.util) window.util.log(msg);
}

// 简单的日志节流，防止UI卡死
const STAT = { send:0, recv:0, next:0 };
function statBump(k) {
    STAT[k]++;
    if (Date.now() > STAT.next) {
        // log(`📊 传输: send=${STAT.send} recv=${STAT.recv}`);
        STAT.send = STAT.recv = 0;
        STAT.next = Date.now() + 1000;
    }
}

export function init() {
  window.virtualFiles = new Map(); window.remoteFiles = new Map(); window.smartMetaCache = new Map(); 
  window.activeTasks = new Map();
  
  // 建立与 SW 的通信
  if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
      // 建立专用通道
      navigator.serviceWorker.ready.then(reg => {
          if (!reg.active) return;
          const ch = new MessageChannel();
          window.swPort = ch.port1;
          window.swPort.onmessage = handleSwMessage;
          reg.active.postMessage({ type: 'INIT_PORT' }, [ch.port2]);
      });
  }

  if (window.protocol) {
      const origSend = window.protocol.sendMsg;
      window.protocol.sendMsg = function(txt, kind, meta) {
          if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && meta && meta.fileObj) {
              const file = meta.fileObj;
              const fileId = 'f_' + Date.now() + Math.random().toString(36).substr(2,5);
              window.virtualFiles.set(fileId, file);
              log(`✅ 文件已注册: ${fileId} (${(file.size/1024/1024).toFixed(2)}MB)`);
              
              const metaData = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type };
              const msg = {
                  t: 'SMART_META', id: 'm_' + Date.now(), ts: Date.now(), senderId: window.state.myId,
                  n: window.state.myName, kind: 'SMART_FILE_UI', txt: `[文件] ${file.name}`, meta: metaData,
                  target: (window.state.activeChat && window.state.activeChat !== CHAT.PUBLIC_ID) ? window.state.activeChat : CHAT.PUBLIC_ID
              };
              
              window.protocol.processIncoming(msg);
              if (msg.target === CHAT.PUBLIC_ID) Object.values(window.state.conns).forEach(c => c.open && c.send(msg));
              else { const c = window.state.conns[msg.target]; if(c && c.open) c.send(msg); }
              log(`📤 Meta已广播`);
              return;
          }
          origSend.apply(this, arguments);
      };

      const origProc = window.protocol.processIncoming;
      window.protocol.processIncoming = function(pkt, fromPeerId) {
          if (pkt.t === 'SMART_META') {
              if (window.state.seenMsgs.has(pkt.id)) return;
              window.state.seenMsgs.add(pkt.id);
              log(`📥 收到Meta: ${pkt.meta.fileName}`);
              const meta = { ...pkt.meta, senderId: pkt.senderId };
              window.smartMetaCache.set(meta.fileId, meta);
              if(!window.remoteFiles.has(meta.fileId)) window.remoteFiles.set(meta.fileId, new Set());
              window.remoteFiles.get(meta.fileId).add(pkt.senderId);
              if (window.ui) window.ui.appendMsg(pkt);
              return;
          }
          if (pkt.t === 'SMART_GET_CHUNK') {
              handleGetChunk(pkt, fromPeerId);
              return;
          }
          origProc.apply(this, arguments);
      };
  }

  // 二进制处理
  if (window.p2p) {
      const oldHandle = window.p2p.handleData;
      window.p2p.handleData = function(d, conn) {
          if (typeof Blob !== 'undefined' && d instanceof Blob) {
              const reader = new FileReader();
              reader.onload = () => handleBinaryData(reader.result, conn.peer);
              reader.readAsArrayBuffer(d);
              return;
          }
          if (d instanceof ArrayBuffer || d instanceof Uint8Array || (d && d.buffer instanceof ArrayBuffer)) {
              handleBinaryData(d, conn.peer);
              return;
          }
          if (d && typeof d === 'object' && !d.t && d[0] !== undefined) {
              try {
                  const arr = new Uint8Array(Object.values(d));
                  handleBinaryData(arr, conn.peer);
                  return;
              } catch(e) {}
          }
          oldHandle.call(this, d, conn);
      };
  }

  window.smartCore = {
      download: (fileId, name) => {
          const url = `/stream/${fileId}`;
          const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      },
      cacheMeta: (m) => { if(m && m.fileId) window.smartMetaCache.set(m.fileId, m); }
  };

window.smartCore.shareLocalFile = function(file) {
    try {
        const fileId = 'f_' + Date.now() + Math.random().toString(36).substr(2,5);
        window.virtualFiles.set(fileId, file);
        log(`✅ 文件已注册: ${fileId} (${(file.size/1024/1024).toFixed(2)}MB)`);
        const metaData = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type };
        const msg = {
            t: 'SMART_META',
            id: 'm_' + Date.now(),
            ts: Date.now(),
            senderId: window.state.myId,
            n: window.state.myName,
            kind: 'SMART_FILE_UI',
            txt: `[文件] ${file.name}`,
            meta: metaData,
            target: (window.state.activeChat && window.state.activeChat !== CHAT.PUBLIC_ID) ? window.state.activeChat : CHAT.PUBLIC_ID
        };
        // 本地缓存 meta，便于后续 GET_META
        window.smartMetaCache.set(metaData.fileId, { ...metaData, senderId: msg.senderId });
        // 先本地渲染
        if (window.protocol && window.protocol.processIncoming) window.protocol.processIncoming(msg);
        // 再广播到目标
        if (msg.target === CHAT.PUBLIC_ID) {
            Object.values(window.state.conns).forEach(c => { try { if (c && c.open) c.send(msg); } catch(e) {} });
        } else {
            const c = window.state.conns[msg.target];
            try { if (c && c.open) c.send(msg); } catch(e) {}
        }
        log(`📤 Meta已广播`);
    } catch (e) {
        console.warn('shareLocalFile error', e);
    }
};

}

const CHUNK_SIZE = 128 * 1024;
const PARALLEL = 12; // 更激进的并发

// 响应 SW 请求
function handleSwMessage(event) {
    const msg = event && event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'GET_META') {
        const meta = (window.smartMetaCache && window.smartMetaCache.get) ? window.smartMetaCache.get(msg.fileId) : null;
        if (event.ports && event.ports[0]) {
            event.ports[0].postMessage(meta ? {
                size: meta.fileSize,
                type: (meta.fileType || guessType(meta.fileName)),
                name: meta.fileName
            }
        }
        return;
    }

    if (msg.type === 'PULL_START') {
        log(`⚡ 流请求: ${msg.fileId} start=${msg.start} end=${msg.end}`);
        startStreamTask(msg.fileId, msg.start, msg.end, msg.reqId);
        return;
    }

    if (msg.type === 'PULL_CANCEL') {
        cancelStreamTask(msg.reqId);
        return;
    }
}

    }
    }
    else if (msg.type === 'PULL_START') {
        log(`⚡ 流请求: ${msg.fileId} start=${msg.start} end=${msg.end}`);
        startStreamTask(msg.fileId, msg.start, msg.end, msg.reqId);
    }
        
    }
    else if (msg.type === 'PULL_CANCEL') {
        // log(`⛔ 流取消: ${msg.reqId}`);
        cancelStreamTask(msg.reqId);
    }
}

// 这里的任务专为流服务，不再是整文件下载
function startStreamTask(fileId, startOffset, endIncl, reqId) {

    const meta = window.smartMetaCache.get(fileId);
    if (!meta) return;

    const task = {
        fileId, reqId,
        size: meta.fileSize,
        start: startOffset,
        endIncl: Math.min(typeof endIncl === 'number' ? endIncl : (meta.fileSize - 1), meta.fileSize - 1),
        currentOffset: startOffset,
        peers: [],
        inflight: new Set(),
        parts: new Map(),
        active: true
    };

    if (meta.senderId && window.state.conns[meta.senderId]) task.peers.push(meta.senderId);
    if (window.remoteFiles.has(fileId)) {
        window.remoteFiles.get(fileId).forEach(pid => {
            if (!task.peers.includes(pid) && window.state.conns[pid]) task.peers.push(pid);
        });
    }

    if (task.peers.length === 0) { log('❌ 无节点可用'); return; }

    window.activeTasks.set(reqId, task);
    pumpStream(task);
}

function cancelStreamTask(reqId) {
    const task = window.activeTasks.get(reqId);
    if (task) {
        task.active = false;
        window.activeTasks.delete(reqId);
    }
}

function pumpStream(task) {
    if (!task.active) return;

    // 1) 推送缓存中的连续块（不越界）
    while (task.parts.has(task.currentOffset)) {
        const chunk = task.parts.get(task.currentOffset);
        task.parts.delete(task.currentOffset);

        const remain = task.endIncl - task.currentOffset + 1;
        const out = (chunk.byteLength <= remain) ? chunk : chunk.slice(0, remain);

        if (window.swPort) {
            window.swPort.postMessage({ type: 'STREAM_DATA', reqId: task.reqId, chunk: out.buffer }, [out.buffer]);
        }

        task.currentOffset += out.byteLength;
        if (task.currentOffset > task.endIncl) {
            if (window.swPort) window.swPort.postMessage({ type: 'STREAM_DATA', reqId: task.reqId, done: true });
            task.active = false;
            window.activeTasks.delete(task.reqId);
            return;
        }
    }

    // 2) 补货（限制在 endIncl 之内）
    const desired = PARALLEL;
    let nextReq = task.currentOffset;

    if (task.inflight.size > 0) {
        const maxInflight = Math.max(...task.inflight);
        nextReq = Math.max(nextReq, maxInflight + CHUNK_SIZE);
    }

    while (task.inflight.size < desired && nextReq <= task.endIncl) {
        if (!task.inflight.has(nextReq) && !task.parts.has(nextReq)) {
            const remain = task.endIncl - nextReq + 1;
            const size = Math.min(CHUNK_SIZE, remain);
            sendRequest(task, nextReq, size);
        }
        nextReq += CHUNK_SIZE;
    }
}

function sendRequest(task, offset, size) {
    const peer = task.peers[Math.floor(Math.random() * task.peers.length)];
    const conn = window.state.conns[peer];
    if (conn && conn.open) {
        conn.send({ t: 'SMART_GET_CHUNK', fileId: task.fileId, offset, size, reqId: task.reqId });
        task.inflight.add(offset);
    }
}

function handleGetChunk(pkt, fromId) {
    // 发送端逻辑：收到请求，读取文件发送
    // log(`📩 请求: ${pkt.offset}`);
    const file = window.virtualFiles.get(pkt.fileId);
    if (!file) return;
    
    const blob = file.slice(pkt.offset, pkt.offset + pkt.size);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const buffer = reader.result;
            // 响应头需带回 reqId 以便接收端区分是哪个流请求的
            const header = JSON.stringify({ fileId: pkt.fileId, offset: pkt.offset, reqId: pkt.reqId });
            const headerBytes = new TextEncoder().encode(header);
            const packet = new Uint8Array(1 + headerBytes.byteLength + buffer.byteLength);
            packet[0] = headerBytes.byteLength;
            packet.set(headerBytes, 1);
            packet.set(new Uint8Array(buffer), 1 + headerBytes.byteLength);
            
            const conn = window.state.conns[fromId];
            if (conn && conn.open) conn.send(packet); 
        } catch(e) {}
    };
    reader.readAsArrayBuffer(blob);
}

function handleBinaryData(buffer, fromId) {
    try {
        let u8 = new Uint8Array(buffer); // 统一转视图
        const len = u8[0];
        const headerStr = new TextDecoder().decode(u8.slice(1, 1 + len));
        const header = JSON.parse(headerStr);
        const body = u8.slice(1 + len); // 这里其实是拷贝了，为了 detached buffer 传给 SW，拷贝是必须的
        
        // 只有带着 reqId 的包我们才能精确对应到某个流任务
        // 但如果旧版本客户端没发 reqId，我们只能尝试广播给所有同 fileId 的任务
        
        const tasks = Array.from(window.activeTasks.values()).filter(t => t.fileId === header.fileId);
        if (tasks.length === 0) return;

        statBump('recv');

        tasks.forEach(task => {
            // 如果这个包是这个任务请求的范围
            if (header.reqId && header.reqId !== task.reqId) return; // 精确匹配

            if (task.inflight.has(header.offset)) {
                task.inflight.delete(header.offset);
                task.parts.set(header.offset, body);
                // 驱动流推送
                pumpStream(task);
            }
        });

    } catch(e) { console.error('Bin err', e); }
}

function guessType(name='') {
    const n = (name || '').toLowerCase();
    if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4';
    if (n.endsWith('.mov')) return 'video/quicktime';
    if (n.endsWith('.webm')) return 'video/webm';
    if (n.endsWith('.mkv')) return 'video/x-matroska';
    if (n.endsWith('.mp3')) return 'audio/mpeg';
    if (n.endsWith('.m4a') || n.endsWith('.aac')) return 'audio/mp4';
    return 'application/octet-stream';
}


// === Ensure shareLocalFile exists even before init timing ===
(function() {
  try {
    if (!window.smartCore) window.smartCore = {};
    if (typeof window.smartCore.shareLocalFile !== 'function') {
      window.smartCore.shareLocalFile = function(file) {
        try {
          if (!file) return;
          if (!window.virtualFiles) window.virtualFiles = new Map();
          if (!window.remoteFiles) window.remoteFiles = new Map();
          if (!window.smartMetaCache) window.smartMetaCache = new Map();
          if (!window.activeTasks) window.activeTasks = new Map();

          const fileId = 'f_' + Date.now() + Math.random().toString(36).substr(2,5);
          window.virtualFiles.set(fileId, file);
          const metaData = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type };

          const target = (window.state && window.state.activeChat && window.state.activeChat !== CHAT.PUBLIC_ID)
              ? window.state.activeChat
              : (typeof CHAT !== 'undefined' ? CHAT.PUBLIC_ID : 'all');

          const msg = {
            t: 'SMART_META',
            id: 'm_' + Date.now(),
            ts: Date.now(),
            senderId: window.state && window.state.myId,
            n: window.state && window.state.myName,
            kind: 'SMART_FILE_UI',
            txt: `[文件] ${file.name}`,
            meta: metaData,
            target
          };

          // 缓存 meta，便于 SW GET_META
          window.smartMetaCache.set(metaData.fileId, { ...metaData, senderId: msg.senderId });

          // 本地渲染
          if (window.protocol && window.protocol.processIncoming) window.protocol.processIncoming(msg);

          // 广播
          if (target === (typeof CHAT !== 'undefined' ? CHAT.PUBLIC_ID : 'all')) {
            const conns = (window.state && window.state.conns) ? Object.values(window.state.conns) : [];
            conns.forEach(c => { try { if (c && c.open) c.send(msg); } catch(e) {} });
          } else {
            const c = (window.state && window.state.conns) ? window.state.conns[target] : null;
            try { if (c && c.open) c.send(msg); } catch(e) {}
          }

          console.log('[Core] shareLocalFile: sent SMART_META for', file.name);
        } catch (e) { console.warn('shareLocalFile(ensure) error', e); }
      };
    }
  } catch(e) {}
})();

