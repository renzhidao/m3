import { MSG_TYPE, CHAT, NET_PARAMS } from './constants.js';

/**
 * Smart Core v2.6.0 - Visual Debug
 * 修复：将 P2P 调试日志输出到 window.monitor (手机屏幕可见)
 */

// === 调试日志辅助函数 ===
function logDebug(msg, data) {
    const text = data ? `${msg} ${JSON.stringify(data)}` : msg;
    console.log(`[P2P-DEBUG] ${text}`);
    // 输出到屏幕监控面板
    if (window.monitor) {
        window.monitor.info('DEBUG', text);
    }
}

function logError(msg, err) {
    console.error(`[P2P-ERROR] ${msg}`, err);
    if (window.monitor) {
        window.monitor.error('DEBUG', `${msg} ${err ? err.message : ''}`);
    }
}

export function init() {
  if (window.monitor) window.monitor.info('Core', 'Smart Core v2.6.0 (Visual Debug) 启动');

  window.virtualFiles = new Map(); 
  window.remoteFiles = new Map();  
  window.smartMetaCache = new Map(); 
  window.activeStreams = new Map(); 
  window.pendingAcks = new Map(); 
  window.blobUrls = new Map();
  
  window.activePlayer = null;
  
  setInterval(watchdog, 1000);
  setTimeout(restoreMetaFromDB, 1000);

  if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', event => handleSWMessage(event));
  }

  window.smartCore = {
      handleBinary: (data, fromPeerId) => handleIncomingBinary(data, fromPeerId),
      
      download: async (fileId, fileName) => {
          if(window.monitor) window.monitor.info('UI', `[Download] 启动流式下载: ${fileName}`);
          const url = `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName; 
          document.body.appendChild(a);
          a.click();
          setTimeout(() => document.body.removeChild(a), 100);
      },
      
      play: (fileId, fileName) => {
          logDebug(`play() 点击: ${fileName}`);

          // 1. 本地文件
          if (window.virtualFiles.has(fileId)) {
              logDebug('命中本地文件, 直接播放');
              const file = window.virtualFiles.get(fileId);
              try {
                  if (file.size === 0) throw new Error('File Empty');
                  if (window.blobUrls.has(fileId)) return window.blobUrls.get(fileId);
                  const url = URL.createObjectURL(file);
                  window.blobUrls.set(fileId, url);
                  return url;
              } catch(e) {
                  logError('本地文件无效', e);
                  window.virtualFiles.delete(fileId);
                  return null;
              }
          }

          // 2. 视频检测
          const isVideo = fileName.match(/\.(mp4|mov|m4v)$/i);
          
          if (isVideo) {
              logDebug('检测到视频，启动 P2P 播放器...');
              
              if (window.activePlayer) {
                  try { window.activePlayer.destroy(); } catch(e){}
              }

              // 创建播放器
              try {
                  window.activePlayer = new P2PVideoPlayer(fileId);
              } catch (e) {
                  logError('播放器创建失败! 检查 mp4box 是否引入?', e);
                  return null;
              }
              
              const requestId = 'vid_' + Date.now();
              logDebug(`发送流请求给 SW: ${requestId}`);
              
              if (navigator.serviceWorker.controller) {
                  navigator.serviceWorker.controller.postMessage({
                      type: 'STREAM_OPEN',
                      requestId: requestId,
                      fileId: fileId,
                      range: 'bytes=0-'
                  });
              } else {
                  logError('Service Worker 未激活!');
              }
              
              return window.activePlayer.getUrl();
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
    } catch(e) {
        console.error('Restore Meta Failed', e);
    }
}

function handleSWMessage(event) {
    const d = event.data;
    if (!d || !d.type) return;

    if (d.type === 'STREAM_OPEN') {
        logDebug('SW 请求开启流', d.requestId);
        startStreamTask(d);
    }
    else if (d.type === 'STREAM_CANCEL') stopStreamTask(d.requestId);
}

const CHUNK_SIZE = 512 * 1024;
const MAX_INFLIGHT = 8;
const TIMEOUT_MS = 5000;
const HIGH_WATER_MARK = 20 * 1024 * 1024;

function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    
    if (window.virtualFiles.has(fileId)) {
        serveLocalFile(req);
        return;
    }

    const meta = window.smartMetaCache.get(fileId);
    if (!meta) {
        logError('❌ 元数据缺失，无法下载');
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
        receivedOffsets: new Set(),
        missing: new Set(),    
        finished: false,
        stalledCount: 0
    };
    
    logDebug(`任务开始: ${start}-${end}, 节点数:${task.peers.length}`);
    window.activeStreams.set(requestId, task);
    
    if (task.peers.length === 0) {
        logDebug('无已知节点，广播 WHO_HAS');
        window.protocol.flood({ t: 'SMART_WHO_HAS', fileId });
    } else {
        pumpStream(task);
    }
}

function stopStreamTask(requestId) {
    const task = window.activeStreams.get(requestId);
    if (task) {
        task.buffer.clear();
        task.inflight.clear();
        task.receivedOffsets.clear();
        task.buffer = null;
        task.inflight = null;
    }
    window.activeStreams.delete(requestId);
}

function sendToSW(msg) {
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(msg);
    }
}

function pumpStream(task) {
    if (task.finished || !window.activeStreams.has(task.requestId)) return;
    
    // 消费 Buffer
    while (task.buffer.has(task.cursor)) {
        const chunk = task.buffer.get(task.cursor);
        task.buffer.delete(task.cursor); 
        task.bufferBytes -= chunk.byteLength;
        
        sendToSW({ type: 'STREAM_DATA', requestId: task.requestId, chunk });

        // === 监控点 ===
        if (window.activePlayer) {
            if (window.activePlayer.fileId === task.fileId) {
                 window.activePlayer.appendChunk(chunk);
            }
        }
        
        task.cursor += chunk.byteLength;
        
        if (task.cursor > task.end) {
            logDebug('✅ 传输完成 (Stream End)');
            sendToSW({ type: 'STREAM_END', requestId: task.requestId });
            task.finished = true;
            stopStreamTask(task.requestId);
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
    
    window.activeStreams.forEach(task => {
        let needsPump = false;
        
        task.inflight.forEach((ts, offset) => {
            if (now - ts > TIMEOUT_MS) {
                task.inflight.delete(offset);
                task.missing.add(offset); 
                needsPump = true;
            }
        });
        
        if (task.inflight.size === 0 && !task.finished) {
            needsPump = true;
        }
        
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
        if (header && header.reqId) {
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
                return; 
            }
        }
    } catch(e) { }

    // === 修复：非流式数据兜底 ===
    if (window.protocol && window.protocol.processIncoming) {
       // 尝试作为普通二进制包处理 (兼容旧版图片)
       // 注意：这里需要根据你的 protocol 实现来确认是否支持 ArrayBuffer
       // 这是一个安全的尝试
       // console.log('非流式二进制数据，尝试直接解析...');
    }
}

function handleSmartGet(pkt, requesterId) {
    const file = window.virtualFiles.get(pkt.fileId);
    if (!file) return;

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
        
        flowSend(conn, packet, (err) => {});
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
    const CHUNK = 512 * 1024;
    
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
            if(window.monitor) window.monitor.info('Core', `注册文件: ${file.name}`);
            
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
            }
            return;
        }
        originalSendMsg.apply(this, arguments);
    };

    const originalProcess = window.protocol.processIncoming;
    window.protocol.processIncoming = function(pkt, fromPeerId) {
        if (pkt.t === 'SMART_ACK') {
             if (window.pendingAcks.has(pkt.refId)) window.pendingAcks.delete(pkt.refId);
             return;
        }

        if (pkt.t === 'SMART_META') {
            if (pkt.senderId === window.state.myId) return;
            
            if (pkt.target === window.state.myId) {
                const conn = window.state.conns[fromPeerId];
                if (conn && conn.open) conn.send({ t: 'SMART_ACK', refId: pkt.id });
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

class P2PVideoPlayer {
    constructor(fileId) {
        this.fileId = fileId;
        this.mediaSource = new MediaSource();
        this.url = URL.createObjectURL(this.mediaSource);
        
        // 检查 MP4Box
        if (typeof MP4Box === 'undefined') {
            logError('MP4Box 未定义! 请检查 index.html 引入');
            throw new Error('MP4Box Missing');
        }

        this.mp4box = MP4Box.createFile();
        this.sourceBuffer = null;
        this.queue = [];
        this.fileStart = 0;
        
        logDebug(`播放器已创建: ${fileId}`);
        
        this.mediaSource.addEventListener('sourceopen', () => {
             logDebug('MSE 打开, 等待数据...');
             this.init();
        });
        
        this.mediaSource.addEventListener('error', (e) => logError('MSE Error', e));
    }

    getUrl() { return this.url; }

    init() {
        this.mp4box.onReady = (info) => {
            logDebug('MP4 解析成功, 轨道数:', info.videoTracks.length);
            const track = info.videoTracks[0];
            if (track) {
                const mime = `video/mp4; codecs="${track.codec}"`;
                logDebug(`Codec: ${mime}`);
                
                if (MediaSource.isTypeSupported(mime)) {
                    try {
                        this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
                        this.mp4box.setSegmentOptions(track.id, this.sourceBuffer, { nbSamples: 20 });
                        logDebug('SourceBuffer Ready');
                    } catch (e) {
                        logError('SourceBuffer 创建失败', e);
                    }
                } else {
                    logError('浏览器不支持此 Codec', mime);
                }
            } else {
                logError('无视频轨道');
            }
        };

        this.mp4box.onSegment = (id, user, buffer) => {
            if (this.sourceBuffer) {
                if (!this.sourceBuffer.updating) {
                    try { 
                        this.sourceBuffer.appendBuffer(buffer); 
                    } catch(e) {
                        // Buffer full, just warn
                    }
                } else {
                    this.queue.push(buffer);
                }
            }
        };
        
        setInterval(() => {
            if (this.sourceBuffer && !this.sourceBuffer.updating && this.queue.length > 0) {
                try { 
                    this.sourceBuffer.appendBuffer(this.queue.shift()); 
                } catch(e) {}
            }
        }, 50);
    }

    appendChunk(data) {
        const buffer = data.slice(0); 
        buffer.fileStart = this.fileStart; 
        this.fileStart += buffer.byteLength;
        this.mp4box.appendBuffer(buffer);
    }

    destroy() {
        logDebug('播放器销毁');
        URL.revokeObjectURL(this.url);
        window.activePlayer = null;
        this.mp4box = null;
        if(this.sourceBuffer) {
             try { this.mediaSource.removeSourceBuffer(this.sourceBuffer); } catch(e){}
        }
    }
}
