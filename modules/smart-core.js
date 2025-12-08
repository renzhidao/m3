import { MSG_TYPE, CHAT } from './constants.js';

/**
 * Smart Core v24 - Final Polish
 * 修复：高水位死锁、提升块大小至 64KB、IO 错误捕获
 */

export function init() {
  if (window.monitor) window.monitor.info('Core', 'Smart Core v24 (HighPerf) 启动');

  window.virtualFiles = new Map(); 
  window.remoteFiles = new Map();  
  window.smartMetaCache = new Map(); 
  window.activeStreams = new Map(); 
  
  setInterval(watchdog, 1000);
  setTimeout(restoreMetaFromDB, 1000);

  if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', event => handleSWMessage(event));
  }

  window.smartCore = {
      handleBinary: (data, fromPeerId) => handleIncomingBinary(data, fromPeerId),
      download: (fileId, fileName) => {
          if(window.monitor) window.monitor.info('UI', `用户请求下载: ${fileName}`);
          const url = `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName; 
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
      },
      play: (fileId, fileName) => `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`
  };
  
  applyHooks();
}

async function restoreMetaFromDB() {
    try {
        const msgs = await window.db.getRecent(50, 'all');
        let restored = 0;
        msgs.forEach(m => {
            if (m.kind === 'SMART_FILE_UI' && m.meta) {
                window.smartMetaCache.set(m.meta.fileId, m.meta);
                if (m.senderId !== window.state.myId) {
                   if (!window.remoteFiles.has(m.meta.fileId)) window.remoteFiles.set(m.meta.fileId, new Set());
                   window.remoteFiles.get(m.meta.fileId).add(m.senderId);
                }
                restored++;
            }
        });
        if (restored > 0 && window.monitor) window.monitor.info('DB', `恢复历史元数据: ${restored}条`);
    } catch(e) {}
}

function handleSWMessage(event) {
    const d = event.data;
    if (!d || !d.type) return;

    if (d.type === 'STREAM_OPEN') startStreamTask(d);
    else if (d.type === 'STREAM_CANCEL') stopStreamTask(d.requestId);
}

// === 核心参数调整 ===
// Fix 3: 提升至 64KB 以加速起播 (现代 WebRTC 支持)
const CHUNK_SIZE = 64 * 1024; 
const MAX_INFLIGHT = 32; 
const TIMEOUT_MS = 5000;
const HIGH_WATER_MARK = 50 * 1024 * 1024; 

function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    if(window.monitor) window.monitor.info('Task', `新建流任务: ${requestId.slice(0,4)}`, {range});
    
    if (window.virtualFiles.has(fileId)) {
        serveLocalFile(req);
        return;
    }

    const meta = window.smartMetaCache.get(fileId);
    if (!meta) {
        if(window.monitor) window.monitor.error('Task', '元数据丢失，无法开始任务', {fileId});
        sendToSW({ type: 'STREAM_ERROR', requestId, msg: 'Meta Not Found' });
        return;
    }

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
    if (start > end) { start = 0; end = meta.fileSize - 1; }

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
        
        finished: false
    };
    
    window.activeStreams.set(requestId, task);
    
    if (task.peers.length === 0) {
        if(window.monitor) window.monitor.warn('Swarm', '无可用节点，广播寻找中...');
        window.protocol.flood({ t: 'SMART_WHO_HAS', fileId });
    } else {
        pumpStream(task);
    }
}

function stopStreamTask(requestId) {
    if(window.monitor) window.monitor.info('Task', `任务结束/取消: ${requestId.slice(0,4)}`);
    window.activeStreams.delete(requestId);
}

function sendToSW(msg) {
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(msg);
    }
}

function pumpStream(task) {
    if (task.finished || !window.activeStreams.has(task.requestId)) return;
    
    // 1. 提交数据
    while (task.buffer.has(task.cursor)) {
        const chunk = task.buffer.get(task.cursor);
        task.buffer.delete(task.cursor); 
        task.bufferBytes -= chunk.byteLength;
        
        sendToSW({ type: 'STREAM_DATA', requestId: task.requestId, chunk });
        task.cursor += chunk.byteLength;
        
        if (task.cursor > task.end) {
            sendToSW({ type: 'STREAM_END', requestId: task.requestId });
            task.finished = true;
            window.activeStreams.delete(task.requestId);
            if(window.monitor) window.monitor.info('Task', `任务完成: ${task.requestId.slice(0,4)}`);
            return;
        }
    }

    // Fix 1: 高水位检查前移到“新数据请求”前，但不能阻塞“重传”
    const isHighWater = task.bufferBytes > HIGH_WATER_MARK;
    if (isHighWater && window.monitor && Math.random() < 0.05) {
        window.monitor.warn('Flow', '高水位，暂停获取新块', {bytes: task.bufferBytes});
    }

    while (task.inflight.size < MAX_INFLIGHT) {
        if (task.peers.length === 0) break;
        
        let offset;
        // 优先重传（即使高水位也允许，因为重传能填坑，降低水位）
        if (task.missing.size > 0) {
            const it = task.missing.values();
            offset = it.next().value;
            task.missing.delete(offset);
            if(window.monitor) window.monitor.warn('Retry', `重传块: ${offset}`);
        } 
        // 只有非高水位时，才请求新数据
        else if (!isHighWater && task.nextReq <= task.end) {
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
            const buf = (conn.dataChannel && conn.dataChannel.bufferedAmount) || 0;
            if (buf > 1024 * 1024) { 
                task.missing.add(offset); 
                break; 
            }
            
            conn.send({
                t: 'SMART_GET',
                fileId: task.fileId,
                offset: offset,
                size: size,
                reqId: task.requestId
            });
            
            task.inflight.set(offset, Date.now());
        } else {
            task.missing.add(offset);
        }
    }
}

function watchdog() {
    const now = Date.now();
    window.activeStreams.forEach(task => {
        let hasTimeout = false;
        task.inflight.forEach((ts, offset) => {
            if (now - ts > TIMEOUT_MS) {
                task.inflight.delete(offset);
                task.missing.add(offset);
                hasTimeout = true;
                if(window.monitor) window.monitor.warn('Timeout', `块超时重置: ${offset}`);
            }
        });
        if (hasTimeout) pumpStream(task); 
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
            
            if (task.inflight.has(offset)) {
                task.inflight.delete(offset);
                task.buffer.set(offset, body);
                task.bufferBytes += body.byteLength;
                pumpStream(task);
            }
        }
    } catch(e) {
        if(window.monitor) window.monitor.error('Proto', '二进制解析失败', e);
    }
}

function handleSmartGet(pkt, requesterId) {
    const file = window.virtualFiles.get(pkt.fileId);
    if (!file) {
        // Fix 2: 找不到文件时，给个日志 (协议不支持回传错误，让接收端超时即可)
        if(window.monitor) window.monitor.warn('IO', '收到请求但文件不存在', pkt);
        return;
    }

    const conn = window.state.conns[requesterId];
    if (!conn || !conn.open) return;
    
    const buf = (conn.dataChannel && conn.dataChannel.bufferedAmount) || 0;
    if (buf > 2 * 1024 * 1024) return; 

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
        
        conn.send(packet);
    };
    // Fix 2: 捕获读取错误
    reader.onerror = () => {
        if(window.monitor) window.monitor.error('IO', '文件读取失败', {file: file.name, offset: pkt.offset});
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
    
    function readLoop() {
        if (offset > end) {
            sendToSW({ type: 'STREAM_END', requestId: req.requestId });
            return;
        }
        const sliceEnd = Math.min(offset + CHUNK, end + 1);
        const reader = new FileReader();
        reader.onload = () => {
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
        if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && fileInfo && fileInfo.fileObj) {
            const file = fileInfo.fileObj;
            const fileId = window.util.uuid();
            window.virtualFiles.set(fileId, file);
            
            const meta = {
                t: 'SMART_META',
                fileId: fileId,
                fileName: file.name,
                fileType: file.type,
                fileSize: file.size,
                senderId: window.state.myId,
                n: window.state.myName,
                ts: window.util.now()
            };
            window.protocol.flood(meta);
            window.ui.appendMsg({ id: window.util.uuid(), senderId: window.state.myId, kind: 'SMART_FILE_UI', meta: meta });
            return;
        }
        originalSendMsg.apply(this, arguments);
    };

    const originalProcess = window.protocol.processIncoming;
    window.protocol.processIncoming = function(pkt, fromPeerId) {
        if (pkt.t === 'SMART_META') {
            if (!window.smartMetaCache) window.smartMetaCache = new Map();
            window.smartMetaCache.set(pkt.fileId, pkt);
            
            if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());
            window.remoteFiles.get(pkt.fileId).add(pkt.senderId);
            
            window.activeStreams.forEach(task => {
                if (task.fileId === pkt.fileId && !task.peers.includes(pkt.senderId)) {
                    task.peers.push(pkt.senderId);
                    if(window.monitor) window.monitor.info('Swarm', `发现新源: ${pkt.senderId.slice(0,4)}`);
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
                    if(window.monitor) window.monitor.info('Swarm', `源上线: ${fromPeerId.slice(0,4)}`);
                    pumpStream(task);
                }
            });
            return;
        }

        originalProcess.apply(this, arguments);
    };
}
