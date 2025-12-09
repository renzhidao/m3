import { MSG_TYPE, CHAT, NET_PARAMS } from './constants.js';

/**
 * Smart Core v2.5.8 - Deep Probe (Moov Detector)
 */

export function init() {
  if (!window.monitor) {
      window.monitor = { info:()=>{}, warn:()=>{}, error:()=>{}, log:()=>{} };
  }
  window.monitor.info('Core', 'Smart Core v2.5.8 (Deep Probe) 启动');

  window.virtualFiles = new Map(); 
  window.remoteFiles = new Map();  
  window.smartMetaCache = new Map(); 
  window.activeStreams = new Map(); 
  window.pendingAcks = new Map(); 
  window.blobUrls = new Map();
  window.metaResolvers = new Map();
  
  setInterval(watchdog, 1000);
  // setTimeout(restoreMetaFromDB, 1000); // Moved to manual init

  if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', event => handleSWMessage(event));
  }

  window.smartCore = {
      initMeta: async () => { await restoreMetaFromDB(); },

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
          
          if (size > 0 && size < 20 * 1024 * 1024) {
              if(window.monitor) window.monitor.info('UI', `[Smart] 正在缓冲小文件 (${(size/1024/1024).toFixed(1)}MB)...`);
              window.util.log(`⏳ 正在缓冲: ${fileName} ...`);
              
              try {
                  const url = `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
                  const res = await fetch(url);
                  if (!res.ok) throw new Error(`Stream Error ${res.status}`);
                  const blob = await res.blob();
                  window.util.log(`✅ 缓冲完成，开始保存`);
                  if (window.ui && window.ui.downloadBlob) {
                      window.ui.downloadBlob(blob, fileName);
                  }
              } catch(e) {
                  window.util.log(`❌ 下载失败: ${e.message}`);
                  if(window.monitor) window.monitor.error('UI', `缓冲失败`, e);
              }
              return;
          }
          
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
        const msgs = await window.db.getRecentFiles(200);
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
        if(window.monitor) window.monitor.info('Core', `⚡ 已恢复 ${count} 个历史文件元数据`);
    } catch(e) {
        console.error('Restore Meta Failed', e);
    }
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





async function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    
    if (window.virtualFiles.has(fileId)) {
        if(window.monitor) window.monitor.info('STEP', `[Local] SW 请求本地文件`);
        serveLocalFile(req);
        return;
    }

    // === 阶段1: 等待 Meta (事件驱动 + 轮询双保底) ===
    let meta = window.smartMetaCache.get(fileId);
    if (!meta) {
        if (window.monitor) window.monitor.warn('STEP', `⏳ Meta未就绪，挂起等待...`, {reqId: requestId.slice(-4)});
        
        meta = await new Promise(resolve => {
            window.metaResolvers.set(fileId, resolve);
            let attempt = 0;
            const timer = setInterval(() => {
                const m = window.smartMetaCache.get(fileId);
                if (m) {
                    clearInterval(timer);
                    window.metaResolvers.delete(fileId);
                    resolve(m);
                } else if (++attempt > 40) { // 2s
                    clearInterval(timer);
                    window.metaResolvers.delete(fileId);
                    resolve(null);
                }
            }, 50);
        });
    }
    
    if (!meta) {
        if(window.monitor) window.monitor.error('STEP', `❌ Meta等待超时`, {fileId});
        sendToSW({ type: 'STREAM_ERROR', requestId, msg: 'Meta Timeout' });
        return;
    }

    // === [Trace] 关键诊断日志 ===
    const peers = Array.from(window.remoteFiles.get(fileId) || []);
    if (window.monitor) {
        window.monitor.info('Trace', `🚀 任务初始化`, {
            req: requestId.slice(-4),
            file: meta.fileName,
            peers: peers.length > 0 ? peers : "❌无节点(等待WHO_HAS)"
        });
    }

    // === 阶段2: 任务初始化 ===
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

    const task = {
        requestId,
        fileId,
        start,
        end,
        cursor: start, 
        nextReq: start, 
        peers: peers,
        buffer: new Map(),     
        bufferBytes: 0,        
        inflight: new Map(),
        receivedOffsets: new Set(),
        missing: new Set(),    
        finished: false,
        stalledCount: 0
    };
    window.activeStreams.set(requestId, task);

    if (task.peers.length === 0) {
        window.protocol.flood({ t: 'SMART_WHO_HAS', fileId });
    } else {
        pumpStream(task);
    }

    // === 阶段3: 首帧预缓冲 (Pre-Buffer Offset 0) ===
    if (start === 0 && !task.receivedOffsets.has(0)) {
        if(window.monitor) window.monitor.info('Trace', `⏳ 等待首帧(Offset 0)...`);
        const t0 = performance.now();
        
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (task.receivedOffsets.has(0) || task.finished || !window.activeStreams.has(requestId)) {
                    clearInterval(check);
                    resolve(true);
                }
            }, 50);
            setTimeout(() => { clearInterval(check); resolve(false); }, 3000);
        });
        
        const cost = Math.round(performance.now() - t0);
        const success = task.receivedOffsets.has(0);
        if(window.monitor) {
            if(success) window.monitor.info('Trace', `✅ 首帧就绪 (耗时${cost}ms)`);
            else window.monitor.warn('Trace', `⚠️ 首帧等待超时 (耗时${cost}ms) - 强制响应SW`);
        }
    }

    // === 阶段4: 响应 SW ===
    sendToSW({
        type: 'STREAM_META',
        requestId,
        fileSize: meta.fileSize,
        fileType: meta.fileType,
        start, end
    });
    if(window.monitor) window.monitor.info('Trace', `📤 已发送 Meta 给 SW (Ready to Stream)`);
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
                task.missing.add(offset);
                needsPump = true;
                timeoutCount++; 
            }
        });
        if (task.inflight.size === 0 && !task.finished) needsPump = true;
        if (needsPump) pumpStream(task); 
    });
    
    if (timeoutCount > 5 && window.monitor) {
        window.monitor.warn('Timeout', `⚠️ 正在重试 ${timeoutCount} 个超时块...`);
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
    
    let header;
    try {
        header = JSON.parse(headerStr); 
    } catch(e) { return; }

    // === [Deep Probe] 深度诊断：MP4 Box 结构扫描 ===
    try {
        if (header.offset === 0 && window.monitor) {
             const body = new Uint8Array(buffer.slice(1 + headerLen));
             const checkLen = Math.min(body.length, 16);
             const hexArr = [];
             for(let i=0; i<checkLen; i++) {
                hexArr.push(body[i].toString(16).padStart(2, '0').toUpperCase());
             }
             window.monitor.warn('PROBE', `🔍 收到文件头 (Offset 0): [${hexArr.join(' ')}]`, {from: fromPeerId.slice(0,4)});
             
             // MP4 Box 扫描
             let pos = 0;
             let foundFtyp = false;
             let foundMoov = false;
             let foundMdat = false;
             
             // 只扫描前 64KB (通常够了)
             const scanLimit = Math.min(body.length, 65536);
             
             while (pos < scanLimit - 8) {
                 const size = (body[pos] << 24) | (body[pos+1] << 16) | (body[pos+2] << 8) | body[pos+3];
                 const typeArr = body.slice(pos+4, pos+8);
                 const type = String.fromCharCode(...typeArr);
                 
                 if (type === 'ftyp') foundFtyp = true;
                 if (type === 'moov') foundMoov = true;
                 if (type === 'mdat') {
                     foundMdat = true;
                     break; // 遇到数据区了，停止扫描
                 }
                 
                 if (size <= 0) break; // 异常
                 pos += size;
             }
             
             if (foundFtyp) {
                 let msg = '>> MP4结构: ';
                 if (foundMoov && !foundMdat) msg += '✅ 索引在头 (Moov First) - 适合流播放';
                 else if (foundMdat && !foundMoov) msg += '⚠️ 索引在尾 (Moov Missing/Late) - 流播放大概率失败!';
                 else if (foundMoov && foundMdat) msg += '✅ 索引在头 (Moov before Mdat)';
                 else msg += '❓ 疑似索引缺失';
                 window.monitor.warn('PROBE', msg);
             }
        }
    } catch(diagErr) {
        // 忽略诊断错误
    }
    // ===========================================

    const task = window.activeStreams.get(header.reqId);
    if (task) {
        const body = buffer.slice(1 + headerLen);
        const offset = header.offset; 
        
        if (!task.receivedOffsets.has(offset)) {
            task.receivedOffsets.add(offset); 
            task.inflight.delete(offset);     
            
            task.buffer.set(offset, body);
            task.bufferBytes += body.byteLength;
            pumpStream(task);
        }
    }
}

function handleSmartGet(pkt, requesterId) {
    const file = window.virtualFiles.get(pkt.fileId);
    
    if (!file) {
        if(window.monitor) window.monitor.warn('Serve', `❌ 拒绝请求: 无此文件`, {fileId: pkt.fileId.slice(0,6)});
        return;
    }

    const conn = window.state.conns[requesterId];
    if (!conn || !conn.open) return;
    
    if(window.monitor) {
        if (Math.random() < 0.1) {
             window.monitor.info('Serve', `📥 正在上传...`, {to: requesterId.slice(0,4)});
        }
    }
    
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
            if (window.metaResolvers.has(pkt.fileId)) {
                const resolve = window.metaResolvers.get(pkt.fileId);
                resolve(pkt);
                window.metaResolvers.delete(pkt.fileId);
            }

            
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