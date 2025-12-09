import { MSG_TYPE, CHAT, NET_PARAMS } from './constants.js';

/**
 * Smart Core v2.5.8 - Auto Retry & Fast Recovery
 * 修复：1. 网络错误自动重试 (缩短超时时间)
 *       2. 传输卡死自动恢复 (Watchdog 增强)
 *       3. 集成 P2PVideoPlayer (解决手机播放 MP4 格式错误)
 */

export function init() {
  if (window.monitor) window.monitor.info('Core', 'Smart Core v2.5.8 (Auto Retry) 启动');

  window.virtualFiles = new Map(); 
  window.remoteFiles = new Map();  
  window.smartMetaCache = new Map(); 
  window.activeStreams = new Map(); 
  window.pendingAcks = new Map(); 
  window.blobUrls = new Map();
  
  // 全局播放器实例引用
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
          // 1. 优先检查本地文件 (自己发送的)
          if (window.virtualFiles.has(fileId)) {
              const file = window.virtualFiles.get(fileId);
              try {
                  if (file.size === 0) throw new Error('File Empty');
                  if (window.blobUrls.has(fileId)) return window.blobUrls.get(fileId);
                  const url = URL.createObjectURL(file);
                  window.blobUrls.set(fileId, url);
                  return url;
              } catch(e) {
                  console.warn('Local file invalidated:', fileId);
                  window.virtualFiles.delete(fileId);
                  return null;
              }
          }

          // 2. [核心修复] 检测 MP4 视频，启动 P2P 转码播放器 (解决手机报错)
          const isVideo = fileName.match(/\.(mp4|mov|m4v)$/i);
          if (isVideo) {
              console.log('[UI] 启动 P2P 流式播放器:', fileName);
              
              // 销毁上一个播放器实例，防止内存泄漏
              if (window.activePlayer) {
                  try { window.activePlayer.destroy(); } catch(e){}
              }

              // 创建新播放器，绑定 fileId
              window.activePlayer = new P2PVideoPlayer(fileId);
              
              // 手动通知 Service Worker 开始下载 P2P 数据流
              // 这里的 range=bytes=0- 表示从头开始下载
              const requestId = 'vid_' + Date.now();
              if (navigator.serviceWorker.controller) {
                  navigator.serviceWorker.controller.postMessage({
                      type: 'STREAM_OPEN',
                      requestId: requestId,
                      fileId: fileId,
                      range: 'bytes=0-'
                  });
              }
              
              // 返回 MSE 的 URL，手机浏览器会认为这是一个标准的本地流
              return window.activePlayer.getUrl();
          }

          // 3. 非视频文件，走原来的 SW 虚拟路径
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
        if(window.monitor && count > 0) window.monitor.info('Core', `⚡ 已恢复 ${count} 个历史文件元数据`);
    } catch(e) {
        console.error('Restore Meta Failed', e);
    }
}

function handleSWMessage(event) {
    const d = event.data;
    if (!d || !d.type) return;

    if (d.type === 'STREAM_OPEN') {
        startStreamTask(d);
    }
    else if (d.type === 'STREAM_CANCEL') stopStreamTask(d.requestId);
}

// === 优化：加速重试 ===
const CHUNK_SIZE = 512 * 1024;
const MAX_INFLIGHT = 8;
const TIMEOUT_MS = 5000;       // 优化：15s -> 5s (遇到错误更快重试)
const HIGH_WATER_MARK = 20 * 1024 * 1024;

function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    
    if (window.virtualFiles.has(fileId)) {
        serveLocalFile(req);
        return;
    }

    const meta = window.smartMetaCache.get(fileId);
    if (!meta) {
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
    
    window.activeStreams.set(requestId, task);
    
    if (task.peers.length === 0) {
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
    
    while (task.buffer.has(task.cursor)) {
        const chunk = task.buffer.get(task.cursor);
        task.buffer.delete(task.cursor); 
        task.bufferBytes -= chunk.byteLength;
        
        // 1. 发给 ServiceWorker (保持原有的下载/缓存逻辑)
        sendToSW({ type: 'STREAM_DATA', requestId: task.requestId, chunk });

        // 2. [核心修复] 如果有播放器正在播放该文件，分流喂给播放器
        // 这解决了手机因为没有 MP4 索引而报错的问题
        if (window.activePlayer && window.activePlayer.fileId === task.fileId) {
             window.activePlayer.appendChunk(chunk);
        }
        
        task.cursor += chunk.byteLength;
        
        if (task.cursor > task.end) {
            sendToSW({ type: 'STREAM_END', requestId: task.requestId });
            task.finished = true;
            stopStreamTask(task.requestId);
            if(window.monitor) window.monitor.info('STEP', `✅ 传输完成`);
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
        
        // 1. 检查超时请求 (Timeout Check)
        task.inflight.forEach((ts, offset) => {
            if (now - ts > TIMEOUT_MS) {
                task.inflight.delete(offset);
                task.missing.add(offset); // 移回待抓取队列，立即重试
                needsPump = true;
            }
        });
        
        // 2. 检查空闲死锁 (Stall Check)
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
    } catch(e) {}
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

/**
 * ====================================================================
 * P2P 视频播放器 (基于 MSE + MP4Box.js)
 * 核心作用：在浏览器前端将 P2P 收到的离散 MP4 数据包，
 * 实时封装成 fMP4 片段，从而解决手机 (iOS/Android) 对普通 MP4 的格式兼容报错。
 * ====================================================================
 */
class P2PVideoPlayer {
    constructor(fileId) {
        this.fileId = fileId;
        this.mediaSource = new MediaSource();
        // 创建 Blob URL，UI 层的 video 标签 src 直接指向这个 URL 即可
        this.url = URL.createObjectURL(this.mediaSource);
        
        // MP4Box.js 实例，用于处理 MP4 容器格式
        this.mp4box = MP4Box.createFile();
        
        this.sourceBuffer = null;
        this.queue = [];
        this.fileStart = 0;
        
        this.mediaSource.addEventListener('sourceopen', () => this.init());
    }

    getUrl() { return this.url; }

    init() {
        // 当 MP4Box 解析出视频头部信息（moov）时触发
        this.mp4box.onReady = (info) => {
            console.log('[P2PPlayer] 视频元数据已解析:', info);
            
            // 获取第一个视频轨道
            const track = info.videoTracks[0];
            if (track) {
                // 构建带 Codec 的 MIME 类型，这是骗过手机浏览器的关键
                // 例如: video/mp4; codecs="avc1.42E01E"
                const mime = `video/mp4; codecs="${track.codec}"`;
                
                if (MediaSource.isTypeSupported(mime)) {
                    this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
                    
                    // 设置切片策略：每 20 个样本切一个片段，喂给浏览器
                    // 样本数越少延迟越低，但 CPU 消耗略高
                    this.mp4box.setSegmentOptions(track.id, this.sourceBuffer, { nbSamples: 20 });
                } else {
                    console.error('[P2PPlayer] 浏览器不支持此编码:', mime);
                }
            }
        };

        // 当 MP4Box 切割好一个 fMP4 片段时触发
        this.mp4box.onSegment = (id, user, buffer) => {
            if (this.sourceBuffer) {
                if (!this.sourceBuffer.updating) {
                    try { 
                        this.sourceBuffer.appendBuffer(buffer); 
                    } catch(e) {
                        // 如果 Buffer 满了，可能需要清理，暂时简单压入队列
                        console.warn('[P2PPlayer] Buffer Append Error', e);
                    }
                } else {
                    this.queue.push(buffer);
                }
            }
        };
        
        // 简单的消费队列循环，防止 SourceBuffer 忙碌时丢包
        setInterval(() => {
            if (this.sourceBuffer && !this.sourceBuffer.updating && this.queue.length > 0) {
                try { 
                    this.sourceBuffer.appendBuffer(this.queue.shift()); 
                } catch(e) {}
            }
        }, 50);
    }

    // 接收来自 P2P 层的原始二进制数据
    appendChunk(data) {
        // 必须深拷贝数据，因为 ArrayBuffer 可能会在传输层被转移或复用
        const buffer = data.slice(0); 
        
        // 告诉 mp4box 这段数据在文件中的偏移量，保证连续性
        buffer.fileStart = this.fileStart; 
        this.fileStart += buffer.byteLength;
        
        // 喂给 mp4box，它会自动触发 onReady 或 onSegment
        this.mp4box.appendBuffer(buffer);
    }

    destroy() {
        URL.revokeObjectURL(this.url);
        window.activePlayer = null;
        this.mp4box = null;
        if(this.sourceBuffer) {
             try { this.mediaSource.removeSourceBuffer(this.sourceBuffer); } catch(e){}
        }
    }
}
