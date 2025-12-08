import { MSG_TYPE, CHAT, NET_PARAMS } from './constants.js';

/**
 * Smart Core v2.5.5 - Lossless Repair Edition
 * 修复：1. 传输丢包逻辑(解决文件损坏) 2. 元数据恢复(解决重启失效)
 * 策略：无损流式，大文件不占内存
 */

export function init() {
  if (window.monitor) window.monitor.info('Core', 'Smart Core v2.5.5 (Lossless Fix) 启动');

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
      
      download: async (fileId, fileName) => {
          if (window.virtualFiles.has(fileId)) {
              if(window.monitor) window.monitor.info('UI', `[Local] 本地导出: ${fileName}`);
              const file = window.virtualFiles.get(fileId);
              if (window.ui && window.ui.downloadBlob) {
                  window.ui.downloadBlob(file, fileName);
              } else {
                  const url = URL.createObjectURL(file);
                  const a = document.createElement('a'); a.href = url; a.download = fileName;
                  document.body.appendChild(a); a.click(); document.body.removeChild(a);
              }
              return;
          }
          
          const meta = window.smartMetaCache.get(fileId);
          const size = meta ? meta.fileSize : 0;
          
          // 小文件(<20MB)保留原有逻辑：缓冲到内存，方便快速分发（不影响大文件安全）
          if (size > 0 && size < 20 * 1024 * 1024) {
              if(window.monitor) window.monitor.info('UI', `[Smart] 正在缓冲小文件 (${(size/1024/1024).toFixed(1)}MB)...`);
              window.util.log(`⏳ 正在缓冲: ${fileName} ...`);
              
              try {
                  const url = `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
                  const res = await fetch(url);
                  if (!res.ok) throw new Error(`Stream Error ${res.status}`);
                  const blob = await res.blob();
                  window.util.log(`✅ 缓冲完成，开始保存`);
                  
                  // 只有小文件才进入内存缓存(Safe)
                  window.virtualFiles.set(fileId, blob);
                  
                  if (window.ui && window.ui.downloadBlob) {
                      window.ui.downloadBlob(blob, fileName);
                  }
              } catch(e) {
                  window.util.log(`❌ 下载失败: ${e.message}`);
                  if(window.monitor) window.monitor.error('UI', `缓冲失败`, e);
              }
              return;
          }
          
          // 大文件：严格流式，不进内存，浏览器接管下载
          if(window.monitor) window.monitor.info('UI', `[Start] 启动流式下载: ${fileName}`);
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
              if(window.monitor) window.monitor.info('STEP', `[Local] 原生预览: ${fileName}`);
              const file = window.virtualFiles.get(fileId);
              if (window.blobUrls.has(fileId)) return window.blobUrls.get(fileId);
              const url = URL.createObjectURL(file);
              window.blobUrls.set(fileId, url);
              return url;
          }
          return `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
      },
      
      onPeerConnect: (peerId) => {
          // 连接建立时，唤醒相关任务
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

    const attempt = () => {
        if (!conn.open) return callback(new Error('Closed during send'));
        if (dc.bufferedAmount < 1.5 * 1024 * 1024) {
            try { conn.send(data); callback(null); } catch(e) { callback(e); }
        } else {
            setTimeout(attempt, 10);
        }
    };
    attempt();
}

async function restoreMetaFromDB() {
    try {
        // === 修复：扩大扫描范围到200条，确保能找回私聊和较早的文件 ===
        const msgs = await window.db.getRecent(200, 'all');
        let count = 0;
        msgs.forEach(m => {
            if (m.kind === 'SMART_FILE_UI' && m.meta) {
                window.smartMetaCache.set(m.meta.fileId, m.meta);
                if (m.senderId !== window.state.myId) {
                   if (!window.remoteFiles.has(m.meta.fileId)) window.remoteFiles.set(m.meta.fileId, new Set());
                   window.remoteFiles.get(m.meta.fileId).add(m.senderId);
                }
                count++;
            }
        });
        if(count > 0 && window.monitor) window.monitor.info('Core', `已恢复 ${count} 个历史文件记录`);
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

const CHUNK_SIZE = 64 * 1024; 
const MAX_INFLIGHT = 64; 
const TIMEOUT_MS = 5000;
const HIGH_WATER_MARK = 50 * 1024 * 1024; 

function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    
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
        stalledCount: 0,
        // === 核心修复：记录已接收的offset，防止重复请求或丢弃迟到包 ===
        receivedOffsets: new Set() 
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
            if(window.monitor) window.monitor.info('STEP', `✅ [STEP 8] 传输完成!`);
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
        
        // === 修复：如果这个块已经收到过，跳过 ===
        if (task.receivedOffsets.has(offset)) continue;

        const size = Math.min(CHUNK_SIZE, task.end - offset + 1);
        
        const peerId = task.peers[Math.floor(offset / CHUNK_SIZE) % task.peers.length];
        const conn = window.state.conns[peerId];
        
        if (conn && conn.open) {
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
    let timeoutCount = 0; 
    
    window.activeStreams.forEach(task => {
        let needsPump = false;
        task.inflight.forEach((ts, offset) => {
            if (now - ts > TIMEOUT_MS) {
                task.inflight.delete(offset);
                
                // === 修复：只有当这个块 真的没收到 时，才加入missing重试 ===
                // 防止迟到的数据包被重新放入请求队列，浪费流量或造成混乱
                if (!task.receivedOffsets.has(offset)) {
                    task.missing.add(offset);
                }
                
                needsPump = true;
                timeoutCount++; 
            }
        });
        if (task.inflight.size === 0 && !task.finished) needsPump = true;
        if (needsPump) pumpStream(task); 
    });
    
    if (timeoutCount > 0 && window.monitor) {
        // 降级日志级别，因为超时重试是正常的P2P行为
        // window.monitor.warn('Timeout', `⚠️ 有 ${timeoutCount} 个数据块请求超时`);
    }
    
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
            
            // === 核心无损修复 ===
            // 旧逻辑：if (task.inflight.has(offset)) { ... } 
            // 问题：网络抖动导致包迟到（超时后才到），旧逻辑会丢弃该包，导致文件空洞。
            // 新逻辑：只要这个offset我还没收录，就接收它！不管是否超时。
            if (!task.receivedOffsets.has(offset)) {
                task.receivedOffsets.add(offset);
                
                task.inflight.delete(offset); // 无论是否在inflight，都清理
                task.missing.delete(offset);  // 无论是否在missing，都清理
                
                task.buffer.set(offset, body);
                task.bufferBytes += body.byteLength;
                pumpStream(task);
            }
        }
    } catch(e) {}
}

function handleSmartGet(pkt, requesterId) {
    const file = window.virtualFiles.get(pkt.fileId);
    
    if (!file) {
        // if(window.monitor) window.monitor.warn('Serve', `❌ 拒绝请求: 无此文件`, {fileId: pkt.fileId.slice(0,6)});
        return;
    }

    const conn = window.state.conns[requesterId];
    if (!conn || !conn.open) return;
    
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
        
        flowSend(conn, packet, (err) => {
            if (err && window.monitor) window.monitor.warn('Serve', `❌ 发送失败: ${err.message}`);
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
            if(window.monitor) window.monitor.info('Core', ` 内存注册文件: ${file.name}`, {fileId: fileId, size: file.size});
            
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
    };\n\n    const originalProcess = window.protocol.processIncoming;\n    window.protocol.processIncoming = function(pkt, fromPeerId) {\n        if (pkt.t === 'SMART_ACK') {\n             if (window.pendingAcks.has(pkt.refId)) {\n                 window.pendingAcks.delete(pkt.refId);\n                 if(window.monitor) window.monitor.info('Ack', `✅ 对方已收到信令: ${pkt.refId.slice(0,4)}`);\n             }\n             return;\n        }\n\n        if (pkt.t === 'SMART_META') {\n            if (pkt.senderId === window.state.myId) return;\n            \n            if (pkt.target === window.state.myId) {\n                const conn = window.state.conns[fromPeerId];\n                if (conn && conn.open) {\n                    conn.send({ t: 'SMART_ACK', refId: pkt.id });\n                }\n            }\n            \n            window.db.saveMsg({ \n                id: pkt.id || window.util.uuid(),\n                t: 'MSG', \n                senderId: pkt.senderId,\n                target: pkt.target || CHAT.PUBLIC_ID, \n                kind: 'SMART_FILE_UI', \n                ts: pkt.ts,\n                n: pkt.n,\n                meta: pkt\n            });\n\n            if(window.monitor) window.monitor.info('STEP', `[STEP 3] 收到 Meta: ${pkt.fileName}`);\n\n            if (window.smartMetaCache.has(pkt.fileId)) {\n                if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());\n                window.remoteFiles.get(pkt.fileId).add(pkt.senderId);\n                return;\n            }\n            \n            window.smartMetaCache.set(pkt.fileId, pkt);\n            \n            if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());\n            window.remoteFiles.get(pkt.fileId).add(pkt.senderId);\n            \n            window.activeStreams.forEach(task => {\n                if (task.fileId === pkt.fileId && !task.peers.includes(pkt.senderId)) {\n                    task.peers.push(pkt.senderId);\n                    pumpStream(task);\n                }\n            });\n            \n            window.ui.appendMsg({ id: pkt.id || window.util.uuid(), senderId: pkt.senderId, n: pkt.n, ts: pkt.ts, kind: 'SMART_FILE_UI', meta: pkt });\n            window.protocol.flood(pkt, fromPeerId);\n            return;\n        }\n        \n        if (pkt.t === 'SMART_GET') { handleSmartGet(pkt, fromPeerId); return; }\n        \n        if (pkt.t === 'SMART_WHO_HAS') {\n            if (window.virtualFiles.has(pkt.fileId)) {\n                const conn = window.state.conns[fromPeerId];\n                if (conn) conn.send({ t: 'SMART_I_HAVE', fileId: pkt.fileId });\n            }\n            window.protocol.flood(pkt, fromPeerId);\n            return;\n        }\n        \n        if (pkt.t === 'SMART_I_HAVE') {\n            if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());\n            window.remoteFiles.get(pkt.fileId).add(fromPeerId);\n            \n            window.activeStreams.forEach(task => {\n                if (task.fileId === pkt.fileId && !task.peers.includes(fromPeerId)) {\n                    task.peers.push(fromPeerId);\n                    pumpStream(task);\n                }\n            });\n            return;\n        }\n\n        originalProcess.apply(this, arguments);\n    };\n}\n