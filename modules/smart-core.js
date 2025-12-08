import { MSG_TYPE, CHAT, NET_PARAMS } from './constants.js';

/**
 * Smart Core v2.4.0 - Full Trace
 * 包含 [STEP 1-7] 全链路埋点日志
 */

export function init() {
  if (window.monitor) window.monitor.info('Core', 'Smart Core v2.4.0 (Trace) 启动');

  window.virtualFiles = new Map(); 
  window.remoteFiles = new Map();  
  window.smartMetaCache = new Map(); 
  window.activeStreams = new Map(); 
  window.pendingAcks = new Map(); 
  window.blobUrls = new Map();
  
  setInterval(watchdog, 1000);
  setTimeout(restoreMetaFromDB, 1000);

  if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', event => handleSWMessage(event));
  }

  window.smartCore = {
      handleBinary: (data, fromPeerId) => handleIncomingBinary(data, fromPeerId),
      
      download: (fileId, fileName) => {
          if (window.virtualFiles.has(fileId)) {
              if(window.monitor) window.monitor.info('STEP', `[Local] 本地直接下载: ${fileName}`);
              const file = window.virtualFiles.get(fileId);
              const url = URL.createObjectURL(file);
              const a = document.createElement('a');
              a.href = url;
              a.download = fileName;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 10000);
              return;
          }
          
          if(window.monitor) window.monitor.info('STEP', `[Start] 请求远程下载: ${fileName}`);
          const url = `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName; 
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
      },
      
      play: (fileId, fileName) => {
          if (window.virtualFiles.has(fileId)) {
              if(window.monitor) window.monitor.info('STEP', `[Local] 本地直接播放: ${fileName}`);
              const file = window.virtualFiles.get(fileId);
              if (window.blobUrls.has(fileId)) return window.blobUrls.get(fileId);
              const url = URL.createObjectURL(file);
              window.blobUrls.set(fileId, url);
              return url;
          }
          return `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
      },
      
      onPeerConnect: (peerId) => {
          window.activeStreams.forEach(task => {
              if (task.peers.includes(peerId)) {
                  pumpStream(task);
              }
          });
          window.pendingAcks.forEach((meta, id) => {
              if (meta.target === peerId) {
                  window.protocol.sendMsg(null, 'RETRY_META', meta);
              }
          });
      }
  };
  
  applyHooks();
}

// === 混合流控 ===
function flowSend(conn, data, callback) {
    if (!conn || !conn.open) return callback(new Error('Connection Closed'));
    
    if (!(data instanceof ArrayBuffer || data instanceof Uint8Array)) {
        try { conn.send(data); callback(null); } catch(e) { callback(e); }
        return;
    }

    const dc = conn.dataChannel;
    if (!dc || typeof dc.bufferedAmount !== 'number') {
        try { conn.send(data); callback(null); } catch(e) { callback(e); }
        return;
    }

    if (dc.bufferedAmount < 1.5 * 1024 * 1024) {
        try { conn.send(data); callback(null); } catch(e) { callback(e); }
        return;
    }

    // if(window.monitor) window.monitor.warn('Flow', `缓冲满(${dc.bufferedAmount}), 等待...`);

    const timeout = setTimeout(() => {
        cleanup();
        callback(new Error('FlowControl Timeout (5s)'));
    }, 5000);

    const onLow = () => {
        cleanup();
        flowSend(conn, data, callback);
    };

    function cleanup() {
        clearTimeout(timeout);
        try { dc.removeEventListener('bufferedamountlow', onLow); } catch(e){}
    }

    try {
        if (dc.bufferedAmountLowThreshold === 0) dc.bufferedAmountLowThreshold = 64 * 1024;
        dc.addEventListener('bufferedamountlow', onLow);
    } catch(e) {
        cleanup();
        setTimeout(() => flowSend(conn, data, callback), 50);
    }
}

async function restoreMetaFromDB() {
    try {
        const msgs = await window.db.getRecent(50, 'all');
        msgs.forEach(m => {
            if (m.kind === 'SMART_FILE_UI' && m.meta) {
                window.smartMetaCache.set(m.meta.fileId, m.meta);
                if (m.senderId !== window.state.myId) {
                   if (!window.remoteFiles.has(m.meta.fileId)) window.remoteFiles.set(m.meta.fileId, new Set());
                   window.remoteFiles.get(m.meta.fileId).add(m.senderId);
                }
            }
        });
    } catch(e) {}
}

function handleSWMessage(event) {
    const d = event.data;
    if (!d || !d.type) return;

    if (d.type === 'STREAM_OPEN') {
        if(window.monitor) window.monitor.info('STEP', `[STEP 4b] 主线程收到 SW 请求`, {reqId: d.requestId.slice(-4)});
        startStreamTask(d);
    }
    else if (d.type === 'STREAM_CANCEL') stopStreamTask(d.requestId);
}

const CHUNK_SIZE = 32 * 1024; 
const MAX_INFLIGHT = 64; 
const TIMEOUT_MS = 5000;
const HIGH_WATER_MARK = 50 * 1024 * 1024; 

function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    
    // 如果任务请求的是本地文件，且走到了 SW 逻辑（说明 play 方法没拦截住，或者是直接 URL 访问）
    if (window.virtualFiles.has(fileId)) {
        if(window.monitor) window.monitor.info('STEP', `[Local] SW 请求本地文件`);
        serveLocalFile(req);
        return;
    }

    const meta = window.smartMetaCache.get(fileId);
    if (!meta) {
        if(window.monitor) window.monitor.error('STEP', `❌ [STEP 4 Fail] 元数据丢失`, {fileId});
        sendToSW({ type: 'STREAM_ERROR', requestId, msg: 'Meta Not Found' });
        return;
    }

    // if(window.monitor) window.monitor.info('Task', `🚀 开始任务: ${meta.fileName}`, {size: meta.fileSize});

    let start = 0;
    let end = meta.fileSize - 1;
    if (range && range.startsWith('bytes=')) {
        const parts = range.replace('bytes=', '').split('-');
        const p0 = parts[0] ? parseInt(parts[0], 10) : NaN;
        const p1 = parts[1] ? parseInt(parts[1], 10) : NaN;
        if (!isNaN(p0)) start = p0;
        if (!isNaN(p1)) end = p1;
        else if (isNaN(p0) && !isNaN(p1)) { 
             start = meta.fileSize - p1;
             end = meta.fileSize - 1;
        }
    }
    if (start < 0) start = 0;
    if (end >= meta.fileSize) end = meta.fileSize - 1;

    sendToSW({
        type: 'STREAM_META',
        requestId,
        fileSize: meta.fileSize,
        fileType: meta.fileType,
        start, end
    });

    const task = {
        requestId,
        fileId,
        start,
        end,
        cursor: start, 
        nextReq: start, 
        peers: Array.from(window.remoteFiles.get(fileId) || []),
        buffer: new Map(),     
        bufferBytes: 0,        
        inflight: new Map(),   
        missing: new Set(),    
        finished: false,
        stalledCount: 0
    };
    
    window.activeStreams.set(requestId, task);
    
    if (task.peers.length === 0) {
        if(window.monitor) window.monitor.warn('STEP', `[STEP 5 Fail] 无可用节点`);
        window.protocol.flood({ t: 'SMART_WHO_HAS', fileId });
    } else {
        pumpStream(task);
    }
}

function stopStreamTask(requestId) {
    window.activeStreams.delete(requestId);
}

function sendToSW(msg) {
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(msg);
    }
}

function pumpStream(task) {
    if (task.finished || !window.activeStreams.has(task.requestId)) return;
    
    // 喂给 SW
    while (task.buffer.has(task.cursor)) {
        const chunk = task.buffer.get(task.cursor);
        task.buffer.delete(task.cursor); 
        task.bufferBytes -= chunk.byteLength;
        
        sendToSW({ type: 'STREAM_DATA', requestId: task.requestId, chunk });
        
        // 日志采样：每 10 片打一条，避免刷屏
        // if (task.cursor % (CHUNK_SIZE * 10) === 0 && window.monitor) {
        //    window.monitor.info('STEP', `[STEP 7] 喂给SW: Offset ${task.cursor}`);
        // }
        
        task.cursor += chunk.byteLength;
        task.stalledCount = 0; 
        
        if (task.cursor > task.end) {
            sendToSW({ type: 'STREAM_END', requestId: task.requestId });
            task.finished = true;
            window.activeStreams.delete(task.requestId);
            if(window.monitor) window.monitor.info('STEP', `✅ [STEP 8] 传输完成!`);
            return;
        }
    }

    const isHighWater = task.bufferBytes > HIGH_WATER_MARK;
    if (isHighWater) return;

    // 发起请求
    while (task.inflight.size < MAX_INFLIGHT) {
        if (task.peers.length === 0) break;
        
        let offset;
        if (task.missing.size > 0) {
            const it = task.missing.values();
            offset = it.next().value;
            task.missing.delete(offset);
        } else if (task.nextReq <= task.end) {
            offset = task.nextReq;
            task.nextReq += CHUNK_SIZE;
        } else {
            break; 
        }
        
        if (offset > task.end) continue;
        const size = Math.min(CHUNK_SIZE, task.end - offset + 1);
        
        const peerId = task.peers[Math.floor(offset / CHUNK_SIZE) % task.peers.length];
        const conn = window.state.conns[peerId];
        
        if (conn && conn.open) {
            try {
                // if(window.monitor && offset === 0) window.monitor.info('STEP', `[STEP 5] 发起首块请求`);
                
                conn.send({
                    t: 'SMART_GET',
                    fileId: task.fileId,
                    offset: offset,
                    size: size,
                    reqId: task.requestId
                });
                task.inflight.set(offset, Date.now());
            } catch(e) {
                task.missing.add(offset);
            }
        } else {
            task.missing.add(offset);
            if (peerId && window.p2p) {
                window.p2p.connectTo(peerId);
            }
        }
    }
}

function watchdog() {
    const now = Date.now();
    window.activeStreams.forEach(task => {
        let needsPump = false;
        task.inflight.forEach((ts, offset) => {
            if (now - ts > TIMEOUT_MS) {
                task.inflight.delete(offset);
                task.missing.add(offset);
                needsPump = true;
                if(window.monitor) window.monitor.warn('Timeout', `块超时: ${offset}`);
            }
        });
        if (task.inflight.size === 0 && !task.finished) needsPump = true;
        if (needsPump) pumpStream(task); 
    });
    
    window.pendingAcks.forEach((meta, id) => {
        if (now - meta._sentTs > 2000) { 
            window.pendingAcks.delete(id);
            if (window.state.conns[meta.target]) {
                if (window.p2p) window.p2p._hardClose(window.state.conns[meta.target]);
                delete window.state.conns[meta.target];
            }
            if (window.p2p) window.p2p.connectTo(meta.target);
        }
    });
}

function handleIncomingBinary(rawBuffer, fromPeerId) {
    let buffer = rawBuffer;
    if (rawBuffer.buffer) buffer = rawBuffer.buffer; 
    if (rawBuffer.byteOffset !== undefined) {
         buffer = buffer.slice(rawBuffer.byteOffset, rawBuffer.byteOffset + rawBuffer.byteLength);
    }

    const view = new DataView(buffer);
    const headerLen = view.getUint8(0);
    const decoder = new TextDecoder();
    const headerStr = decoder.decode(buffer.slice(1, 1 + headerLen));
    
    try {
        const header = JSON.parse(headerStr); 
        const task = window.activeStreams.get(header.reqId);
        if (task) {
            const body = buffer.slice(1 + headerLen);
            const offset = header.offset; 
            
            // if(window.monitor && offset === 0) window.monitor.info('STEP', `[STEP 6] 收到首块数据!`);
            
            if (task.inflight.has(offset)) {
                task.inflight.delete(offset);
                task.buffer.set(offset, body);
                task.bufferBytes += body.byteLength;
                pumpStream(task);
            }
        }
    } catch(e) {}
}

function handleSmartGet(pkt, requesterId) {
    const file = window.virtualFiles.get(pkt.fileId);
    if (!file) return;

    const conn = window.state.conns[requesterId];
    if (!conn || !conn.open) return;
    
    if(window.monitor && pkt.offset === 0) window.monitor.info('STEP', `[STEP 6a] 收到对方下载请求`, {peer: requesterId.slice(0,4)});
    
    const blob = file.slice(pkt.offset, pkt.offset + pkt.size);
    const reader = new FileReader();
    
    reader.onload = () => {
        const raw = reader.result;
        const header = JSON.stringify({ reqId: pkt.reqId, offset: pkt.offset });
        const encoder = new TextEncoder();
        const headerBytes = encoder.encode(header);
        const headerLen = headerBytes.length;
        
        if (headerLen > 255) return;
        
        const packet = new Uint8Array(1 + headerLen + raw.byteLength);
        packet[0] = headerLen;
        packet.set(headerBytes, 1);
        packet.set(new Uint8Array(raw), 1 + headerLen);
        
        // if(window.monitor && pkt.offset === 0) window.monitor.info('STEP', `[STEP 6b] 发送首块数据`);
        
        flowSend(conn, packet, (err) => {
            if (err && window.monitor) {
                window.monitor.warn('Serve', `[STEP 6 Fail] 流控发送失败: ${err.message}`);
            }
        });
    };
    reader.readAsArrayBuffer(blob);
}

function serveLocalFile(req) {
    const file = window.virtualFiles.get(req.fileId);
    const range = req.range;
    let start = 0;
    let end = file.size - 1;
    if (range && range.startsWith('bytes=')) {
        const parts = range.replace('bytes=', '').split('-');
        if (parts[0]) start = parseInt(parts[0], 10);
        if (parts[1]) end = parseInt(parts[1], 10);
    }

    sendToSW({ type: 'STREAM_META', requestId: req.requestId, fileSize: file.size, fileType: file.type, start, end });

    let offset = start;
    const CHUNK = 1024 * 1024; 
    
    window.activeStreams.set(req.requestId, { finished: false });

    function readLoop() {
        if (!window.activeStreams.has(req.requestId)) return;

        if (offset > end) {
            sendToSW({ type: 'STREAM_END', requestId: req.requestId });
            window.activeStreams.delete(req.requestId);
            return;
        }
        
        const sliceEnd = Math.min(offset + CHUNK, end + 1);
        const reader = new FileReader();
        reader.onload = () => {
             if (!window.activeStreams.has(req.requestId)) return;
             sendToSW({ type: 'STREAM_DATA', requestId: req.requestId, chunk: reader.result });
             offset += CHUNK;
             setTimeout(readLoop, 10);
        };
        reader.readAsArrayBuffer(file.slice(offset, sliceEnd));
    }
    readLoop();
}

function applyHooks() {
    if (!window.protocol) { setTimeout(applyHooks, 500); return; }

    const originalSendMsg = window.protocol.sendMsg;
    window.protocol.sendMsg = function(txt, kind, fileInfo) {
        if (kind === 'RETRY_META' && fileInfo) {
             const conn = window.state.conns[fileInfo.target];
             if (conn && conn.open) conn.send(fileInfo);
             return;
        }

        if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && fileInfo && fileInfo.fileObj) {
            const file = fileInfo.fileObj;
            const fileId = window.util.uuid();
            window.virtualFiles.set(fileId, file);
            
            const target = (window.state.activeChat && window.state.activeChat !== CHAT.PUBLIC_ID) 
                           ? window.state.activeChat 
                           : CHAT.PUBLIC_ID;

            const meta = {
                t: 'SMART_META',
                id: window.util.uuid(),
                fileId: fileId,
                fileName: file.name,
                fileType: file.type,
                fileSize: file.size,
                senderId: window.state.myId,
                n: window.state.myName,
                ts: window.util.now(),
                target: target,  
                ttl: NET_PARAMS.GOSSIP_SIZE
            };
            
            window.smartMetaCache.set(fileId, meta);
            window.ui.appendMsg({ id: window.util.uuid(), senderId: window.state.myId, kind: 'SMART_FILE_UI', meta: meta });
            window.db.addPending(meta);
            window.protocol.retryPending();
            
            if (target !== CHAT.PUBLIC_ID) {
                meta._sentTs = Date.now();
                window.pendingAcks.set(meta.id, meta);
                if(window.monitor) window.monitor.info('STEP', `[STEP 2] 发送Meta (私聊): ${file.name}`);
            } else {
                if(window.monitor) window.monitor.info('STEP', `[STEP 2] 广播Meta (群发): ${file.name}`);
            }
            if(window.monitor) window.monitor.info('STEP', `[STEP 1] 文件注册成功: ${file.name}`);
            return;
        }
        originalSendMsg.apply(this, arguments);
    };

    const originalProcess = window.protocol.processIncoming;
    window.protocol.processIncoming = function(pkt, fromPeerId) {
        if (pkt.t === 'SMART_ACK') {
             if (window.pendingAcks.has(pkt.refId)) {
                 window.pendingAcks.delete(pkt.refId);
                 if(window.monitor) window.monitor.info('Ack', `✅ 对方已收到信令: ${pkt.refId.slice(0,4)}`);
             }
             return;
        }

        if (pkt.t === 'SMART_META') {
            if (pkt.senderId === window.state.myId) return;
            
            if (pkt.target === window.state.myId) {
                const conn = window.state.conns[fromPeerId];
                if (conn && conn.open) {
                    conn.send({ t: 'SMART_ACK', refId: pkt.id });
                }
            }
            
            window.db.saveMsg({ 
                id: pkt.id || window.util.uuid(),
                t: 'MSG', 
                senderId: pkt.senderId,
                target: pkt.target || CHAT.PUBLIC_ID, 
                kind: 'SMART_FILE_UI', 
                ts: pkt.ts,
                n: pkt.n,
                meta: pkt
            });

            if(window.monitor) window.monitor.info('STEP', `[STEP 3] 收到 Meta: ${pkt.fileName}`);

            if (window.smartMetaCache.has(pkt.fileId)) {
                if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());
                window.remoteFiles.get(pkt.fileId).add(pkt.senderId);
                return;
            }
            
            window.smartMetaCache.set(pkt.fileId, pkt);
            
            if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());
            window.remoteFiles.get(pkt.fileId).add(pkt.senderId);
            
            window.activeStreams.forEach(task => {
                if (task.fileId === pkt.fileId && !task.peers.includes(pkt.senderId)) {
                    task.peers.push(pkt.senderId);
                    pumpStream(task);
                }
            });
            
            window.ui.appendMsg({ id: pkt.id || window.util.uuid(), senderId: pkt.senderId, n: pkt.n, ts: pkt.ts, kind: 'SMART_FILE_UI', meta: pkt });
            window.protocol.flood(pkt, fromPeerId);
            return;
        }
        
        if (pkt.t === 'SMART_GET') { handleSmartGet(pkt, fromPeerId); return; }
        
        if (pkt.t === 'SMART_WHO_HAS') {
            if (window.virtualFiles.has(pkt.fileId)) {
                const conn = window.state.conns[fromPeerId];
                if (conn) conn.send({ t: 'SMART_I_HAVE', fileId: pkt.fileId });
            }
            window.protocol.flood(pkt, fromPeerId);
            return;
        }
        
        if (pkt.t === 'SMART_I_HAVE') {
            if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());
            window.remoteFiles.get(pkt.fileId).add(fromPeerId);
            
            window.activeStreams.forEach(task => {
                if (task.fileId === pkt.fileId && !task.peers.includes(fromPeerId)) {
                    task.peers.push(fromPeerId);
                    pumpStream(task);
                }
            });
            return;
        }

        originalProcess.apply(this, arguments);
    };
}