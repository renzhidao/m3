import { MSG_TYPE, CHAT, NET_PARAMS } from './constants.js';

/**
 * Smart Core v2.2.2 - Signaling Fix
 * 修复：即时发送信令因僵尸连接丢失的问题
 */

export function init() {
  if (window.monitor) window.monitor.info('Core', 'Smart Core v2.2.2 (Targeting) 启动');

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
      play: (fileId, fileName) => `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`,
      onPeerConnect: (peerId) => {
          window.activeStreams.forEach(task => {
              if (task.peers.includes(peerId)) {
                  if(window.monitor) window.monitor.info('Swarm', `节点重连唤醒任务: ${peerId.slice(0,4)}`);
                  pumpStream(task);
              }
          });
      }
  };
  
  applyHooks();
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

    if (d.type === 'STREAM_OPEN') startStreamTask(d);
    else if (d.type === 'STREAM_CANCEL') stopStreamTask(d.requestId);
}

const CHUNK_SIZE = 16 * 1024; 
const MAX_INFLIGHT = 256;     
const TIMEOUT_MS = 5000;
const HIGH_WATER_MARK = 50 * 1024 * 1024; 

function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    
    if (window.virtualFiles.has(fileId)) {
        if(window.monitor) window.monitor.info('Task', '提供本地文件流', {fileId});
        serveLocalFile(req);
        return;
    }

    const meta = window.smartMetaCache.get(fileId);
    if (!meta) {
        if(window.monitor) window.monitor.error('Task', '❌ 元数据丢失', {fileId});
        sendToSW({ type: 'STREAM_ERROR', requestId, msg: 'Meta Not Found' });
        return;
    }

    if(window.monitor) window.monitor.info('Task', `🚀 开始任务: ${meta.fileName}`, {size: meta.fileSize});

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
        if(window.monitor) window.monitor.warn('Swarm', '📡 无可用节点，广播搜寻...');
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
    
    while (task.buffer.has(task.cursor)) {
        const chunk = task.buffer.get(task.cursor);
        task.buffer.delete(task.cursor); 
        task.bufferBytes -= chunk.byteLength;
        
        sendToSW({ type: 'STREAM_DATA', requestId: task.requestId, chunk });
        task.cursor += chunk.byteLength;
        task.stalledCount = 0; 
        
        if (task.cursor > task.end) {
            sendToSW({ type: 'STREAM_END', requestId: task.requestId });
            task.finished = true;
            window.activeStreams.delete(task.requestId);
            if(window.monitor) window.monitor.info('Task', `✅ 任务完成: ${task.requestId.slice(0,4)}`);
            return;
        }
    }

    const isHighWater = task.bufferBytes > HIGH_WATER_MARK;
    if (isHighWater) return;

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
            const buf = (conn.dataChannel && conn.dataChannel.bufferedAmount) || 0;
            if (buf > 1024 * 1024) { 
                task.missing.add(offset); 
                break; 
            }
            try {
                conn.send({
                    t: 'SMART_GET',
                    fileId: task.fileId,
                    offset: offset,
                    size: size,
                    reqId: task.requestId
                });
                task.inflight.set(offset, Date.now());
            } catch(e) {
                if(window.monitor) window.monitor.error('Net', `发送GET失败: ${peerId}`, e);
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
                if(window.monitor) window.monitor.warn('Timeout', `⏱️ 块超时: ${offset}`);
            }
        });
        if (task.inflight.size === 0 && !task.finished) needsPump = true;
        if (needsPump) pumpStream(task); 
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
    } catch(e) {}
}

function handleSmartGet(pkt, requesterId) {
    const file = window.virtualFiles.get(pkt.fileId);
    if (!file) return;

    const conn = window.state.conns[requesterId];
    if (!conn || !conn.open) {
        if(window.monitor) window.monitor.warn('Serve', `请求者 ${requesterId.slice(0,4)} 连接断开`);
        return;
    }
    
    const buf = (conn.dataChannel && conn.dataChannel.bufferedAmount) || 0;
    if (buf > 4 * 1024 * 1024) return; 

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
        
        try {
            conn.send(packet);
        } catch(e) {
            if(window.monitor) window.monitor.error('Serve', `发送块失败`, e);
        }
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
             queueMicrotask(readLoop);
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
            
            // === 修复：准确的 Target 设置 ===
            // 如果是私聊，target 就是对方 ID；如果是群聊，target 是 Public
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
                target: target,  // <--- 关键修改：不再强制 Public
                ttl: NET_PARAMS.GOSSIP_SIZE
            };
            
            window.smartMetaCache.set(fileId, meta);
            window.ui.appendMsg({ id: window.util.uuid(), senderId: window.state.myId, kind: 'SMART_FILE_UI', meta: meta });
            window.db.addPending(meta);
            window.protocol.retryPending();
            
            if(window.monitor) window.monitor.info('Msg', `📤 发送文件信令: ${file.name} (To: ${target})`);
            return;
        }
        originalSendMsg.apply(this, arguments);
    };

    const originalProcess = window.protocol.processIncoming;
    window.protocol.processIncoming = function(pkt, fromPeerId) {
        if (pkt.t === 'SMART_META') {
            if (pkt.senderId === window.state.myId) return;
            
            window.db.saveMsg({ 
                id: pkt.id || window.util.uuid(),
                t: 'MSG', 
                senderId: pkt.senderId,
                target: pkt.target || CHAT.PUBLIC_ID, // 兼容旧版
                kind: 'SMART_FILE_UI', 
                ts: pkt.ts,
                n: pkt.n,
                meta: pkt
            });

            if(window.monitor) window.monitor.info('Msg', `📥 收到文件信令: ${pkt.fileName}`);

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