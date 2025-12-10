import { MSG_TYPE, CHAT, NET_PARAMS } from './constants.js';

/**
 * Smart Core v2.6.1 - Stable Fix
 */

function logDebug(msg, data) {
    // 仅在 monitor 存在时输出
    if (window.monitor) {
        // window.monitor.info('DEBUG', msg + (data ? ' ' + JSON.stringify(data) : ''));
    }
}

function logError(msg, err) {
    console.error(`[SmartCore] ${msg}`, err);
    if (window.monitor) window.monitor.error('CORE', msg, err);
}

export function init() {
  if (window.monitor) window.monitor.info('Core', 'Smart Core v2.6.1 启动');

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
          if (window.virtualFiles.has(fileId)) {
              if(window.monitor) window.monitor.info('UI', `[Local] 本地导出: ${fileName}`);
              const file = window.virtualFiles.get(fileId);
              if (window.ui && window.ui.downloadBlob) {
                  window.ui.downloadBlob(file, fileName);
              }
              return;
          }
          
          if(window.monitor) window.monitor.info('UI', `[Download] 启动下载: ${fileName}`);
          const url = `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName; 
          document.body.appendChild(a);
          a.click();
          setTimeout(() => document.body.removeChild(a), 100);
      },
      
      play: (fileId, fileName) => {
          // 1. 本地文件
          if (window.virtualFiles.has(fileId)) {
              const file = window.virtualFiles.get(fileId);
              try {
                  if (file.size === 0) throw new Error('File Empty');
                  if (window.blobUrls.has(fileId)) return window.blobUrls.get(fileId);
                  const url = URL.createObjectURL(file);
                  window.blobUrls.set(fileId, url);
                  return url;
              } catch(e) {
                  window.virtualFiles.delete(fileId);
                  return null;
              }
          }

          // 2. 视频检测 -> 启动流式播放器
          const isVideo = fileName.match(/\.(mp4|mov|m4v)$/i);
          if (isVideo) {
              if (window.activePlayer) {
                  try { window.activePlayer.destroy(); } catch(e){}
              }

              try {
                  // 如果 MP4Box 没加载，这行会报错，被下面 catch 捕获
                  window.activePlayer = new P2PVideoPlayer(fileId);
              } catch (e) {
                  logError('播放器初始化失败 (可能缺 mp4box.js)', e);
                  return null;
              }
              
              const requestId = 'vid_' + Date.now();
              if (navigator.serviceWorker.controller) {
                  navigator.serviceWorker.controller.postMessage({
                      type: 'STREAM_OPEN',
                      requestId: requestId,
                      fileId: fileId,
                      range: 'bytes=0-'
                  });
              } else {
                  logError('Service Worker 未激活，无法播放');
              }
              
              return window.activePlayer.getUrl();
          }

          // 3. 普通文件 -> 走 Service Worker 代理下载
          return `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
      }
  };

  // 劫持发送消息，用于拦截文件发送
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = function(txt, kind, meta) {
      if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && meta && meta.fileObj) {
          const file = meta.fileObj;
          const fileId = window.util.uuid();
          
          window.virtualFiles.set(fileId, file);
          if(window.monitor) window.monitor.info('Core', `注册文件: ${file.name}`);
          
          const target = (window.state.activeChat && window.state.activeChat !== CHAT.PUBLIC_ID) 
                         ? window.state.activeChat 
                         : CHAT.PUBLIC_ID;

          const fileMeta = {
              id: window.util.uuid(),
              ts: Date.now(),
              senderId: window.state.myId,
              n: window.state.myName,
              target: target,
              kind: 'SMART_FILE_UI', 
              txt: `[文件] ${file.name}`,
              meta: {
                  fileId: fileId,
                  fileName: file.name,
                  fileSize: file.size,
                  fileType: file.type
              }
          };

          window.protocol.processIncoming(fileMeta); 

          const meta = { ...fileMeta };
          meta._sentTs = Date.now();
          window.pendingAcks.set(meta.id, meta);

          const pkt = { t: 'SMART_META', ...fileMeta };
          window.protocol.broadcast(pkt, target);
          return;
      }
      originalSendMsg.apply(this, arguments);
  };

  // 劫持消息处理，用于捕获 Meta
  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
      if (pkt.t === 'SMART_ACK') {
           if (window.pendingAcks.has(pkt.refId)) window.pendingAcks.delete(pkt.refId);
           return;
      }

      if (pkt.t === 'SMART_META') {
          if (window.state.seenMsgs.has(pkt.id)) return;
          window.state.seenMsgs.add(pkt.id);
          
          if (pkt.target === window.state.myId) {
              const conn = window.state.conns[fromPeerId];
              if (conn && conn.open) conn.send({ t: 'SMART_ACK', refId: pkt.id });
          }
          
          window.db.saveMsg({ 
              id: pkt.id, ts: pkt.ts, 
              senderId: pkt.senderId, n: pkt.n, 
              target: pkt.target, 
              kind: pkt.kind, txt: pkt.txt, 
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
          
          if (window.ui) window.ui.appendMsg(pkt);
          return;
      }
      
      if (pkt.t === 'SMART_WHO_HAS') {
          if (window.virtualFiles.has(pkt.fileId)) {
               const conn = window.state.conns[fromPeerId];
               if(conn && conn.open) conn.send({ t: 'SMART_HAVE', fileId: pkt.fileId });
          }
          return;
      }

      if (pkt.t === 'SMART_HAVE') {
          if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());
          window.remoteFiles.get(pkt.fileId).add(fromPeerId);
          
          // 如果有正在等待此文件的流任务，立即唤醒
          window.activeStreams.forEach(task => {
              if (task.fileId === pkt.fileId && !task.finished) {
                   if (!task.peers.includes(fromPeerId)) task.peers.push(fromPeerId);
                   pumpStream(task);
              }
          });
          return;
      }

      if (pkt.t === 'SMART_GET') {
          handleSmartGet(pkt, fromPeerId);
          return;
      }

      originalProcess.apply(this, arguments);
  };
}

async function restoreMetaFromDB() {
    try {
        const list = await window.db.getRecent(200, 'all'); 
        let count = 0;
        list.forEach(m => {
            if (m.kind === 'SMART_FILE_UI' && m.meta) {
                window.smartMetaCache.set(m.meta.fileId, m.meta); // 这里之前可能是 m
                count++;
            }
        });
    } catch(e) { console.error('Meta Restore Error', e); }
}

function handleSWMessage(event) {
    const d = event.data;
    if (!d || !d.type) return;

    if (d.type === 'STREAM_OPEN') {
        startStreamTask(d);
    }
    else if (d.type === 'STREAM_CANCEL') stopStreamTask(d.requestId);
}

const CHUNK_SIZE = 512 * 1024;
const MAX_INFLIGHT = 8;
const TIMEOUT_MS = 5000;

function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    
    if (window.virtualFiles.has(fileId)) {
        serveLocalFile(req);
        return;
    }

    const meta = window.smartMetaCache.get(fileId);
    if (!meta) {
        logError('❌ Meta Missing', {fileId});
        sendToSW({ type: 'STREAM_ERROR', requestId, msg: 'Meta Not Found' });
        // 广播寻找
        window.protocol.flood({ t: 'SMART_WHO_HAS', fileId });
        return;
    }

    let start = 0;
    let end = meta.fileSize - 1;
    if (range && range.startsWith('bytes=')) {
        const parts = range.replace('bytes=', '').split('-');
        start = parseInt(parts[0], 10);
        if (parts[1]) end = parseInt(parts[1], 10);
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
        start, end,
        cursor: start, 
        peers: Array.from(window.remoteFiles.get(fileId) || []),
        buffer: new Map(),     
        bufferBytes: 0,        
        inflight: new Map(),
        missing: new Set(),
        receivedOffsets: new Set(), 
        finished: false
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

function pumpStream(task) {
    if (task.finished || !window.activeStreams.has(task.requestId)) return;
    
    // 1. 消费 Buffer
    while (task.buffer.has(task.cursor)) {
        const chunk = task.buffer.get(task.cursor);
        task.buffer.delete(task.cursor); 
        task.bufferBytes -= chunk.byteLength;
        
        sendToSW({ type: 'STREAM_DATA', requestId: task.requestId, chunk });

        // 同步给本地播放器 (MP4Box)
        if (window.activePlayer && window.activePlayer.fileId === task.fileId) {
             window.activePlayer.appendChunk(chunk);
        }
        
        task.cursor += chunk.byteLength;
        
        if (task.cursor > task.end) {
            sendToSW({ type: 'STREAM_END', requestId: task.requestId });
            task.finished = true;
            stopStreamTask(task.requestId);
            return;
        }
    }

    // 2. 发送请求
    const peerCount = task.peers.length;
    if (peerCount === 0) return;

    while (task.inflight.size < MAX_INFLIGHT && task.cursor + (task.inflight.size * CHUNK_SIZE) <= task.end) {
        // 简单策略：顺序请求
        // 找到下一个未请求的 offset
        // 这里简化处理：假设 inflight 之外的就是需要的
        // 实际逻辑应该更复杂，这里只保留基本功能
        
        // 寻找下一个要请求的 offset
        let nextReq = task.cursor;
        while (task.inflight.has(nextReq) || task.buffer.has(nextReq)) {
            nextReq += CHUNK_SIZE;
        }
        
        if (nextReq > task.end) break;
        
        const size = Math.min(CHUNK_SIZE, task.end - nextReq + 1);
        const peer = task.peers[Math.floor(Math.random() * peerCount)];
        
        task.inflight.set(nextReq, Date.now());
        
        const conn = window.state.conns[peer];
        if (conn && conn.open) {
            conn.send({ 
                t: 'SMART_GET', 
                reqId: task.requestId, 
                fileId: task.fileId, 
                offset: nextReq, 
                size: size 
            });
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
                needsPump = true;
            }
        });
        if (needsPump || (task.inflight.size === 0 && !task.finished)) {
            pumpStream(task); 
        }
    });
    
    window.pendingAcks.forEach((meta, id) => {
        if (now - meta._sentTs > 2000) { 
             window.pendingAcks.delete(id);
        }
    });
}

function handleIncomingBinary(buffer, fromPeerId) {
    // 尝试解析 P2P Header
    try {
        // 假设 Header 长度在第1字节 (Uint8)
        // 注意：这里必须与发送端 handleSmartGet 保持一致
        const headerLen = new Uint8Array(buffer.slice(0, 1))[0]; 
        
        if (headerLen > 0 && headerLen < 255) {
            const decoder = new TextDecoder();
            const headerStr = decoder.decode(buffer.slice(1, 1 + headerLen));
            
            let header = null;
            try { header = JSON.parse(headerStr); } catch(e){}

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
                    return; // 成功作为流数据处理
                }
            }
        }
    } catch(e) {}

    // === Fallback: 作为普通二进制文件处理 ===
    // 兼容旧版图片发送逻辑
    if (window.protocol && window.protocol.processIncoming) {
        // 模拟一个二进制消息给 protocol
        // 但通常 protocol 需要 msg 对象。
        // 如果旧版是通过 conn.on('data') 直接拿到 buffer，
        // p2p.js 已经把 buffer 转给了 smartCore。
        
        // 既然 smartCore 无法处理流，那它可能是个普通的 Blob
        // 尝试触发 UI 下载或显示
        // 这里最安全的做法是：如果是图片，我们很难知道它是哪个会话的，除非有 header。
        // ** 如果旧版发送图片没加 Header，那这里确实很难办。**
        // 但根据 ui-events.js，发送图片时使用的是 window.protocol.sendMsg，
        // 它是封装在 JSON 里的？不对，是 fileObj。
        
        console.warn('收到未知二进制数据，无法流式处理');
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
        
        const headerObj = { reqId: pkt.reqId, offset: pkt.offset };
        const headerStr = JSON.stringify(headerObj);
        const headerBytes = new TextEncoder().encode(headerStr);
        const headerLen = headerBytes.byteLength;
        
        // 构造 Packet: [Len(1)] + [Header] + [Body]
        const packet = new Uint8Array(1 + headerLen + raw.byteLength);
        packet[0] = headerLen;
        packet.set(headerBytes, 1);
        packet.set(new Uint8Array(raw), 1 + headerLen);
        
        conn.send(packet);
    };
    reader.readAsArrayBuffer(blob);
}

function serveLocalFile(req) {
    // 本地播放逻辑
    const file = window.virtualFiles.get(req.fileId);
    if (!file) return;
    
    const start = req.start || 0;
    const end = req.end || file.size - 1;
    const chunkSize = 1024 * 1024; // 1MB for local
    
    let offset = start;
    
    const readNext = () => {
        if (offset > end) {
             sendToSW({ type: 'STREAM_END', requestId: req.requestId });
             return;
        }
        const s = offset;
        const e = Math.min(offset + chunkSize, end + 1);
        const blob = file.slice(s, e);
        const reader = new FileReader();
        reader.onload = () => {
             sendToSW({ type: 'STREAM_DATA', requestId: req.requestId, chunk: reader.result });
             offset = e;
             readNext();
        };
        reader.readAsArrayBuffer(blob);
    };
    
    sendToSW({ type: 'STREAM_META', requestId: req.requestId, fileSize: file.size, fileType: file.type, start, end });
    readNext();
}

function sendToSW(msg) {
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(msg);
    }
}

// === P2P 播放器类 (兼容 MP4Box) ===
class P2PVideoPlayer {
    constructor(fileId) {
        this.fileId = fileId;
        this.mediaSource = new MediaSource();
        this.url = URL.createObjectURL(this.mediaSource);
        
        if (typeof MP4Box === 'undefined') {
            throw new Error('MP4Box Missing');
        }

        this.mp4box = MP4Box.createFile();
        this.sourceBuffer = null;
        this.queue = [];
        this.fileStart = 0;
        
        this.mediaSource.addEventListener('sourceopen', () => this.init());
    }

    getUrl() { return this.url; }

    init() {
        this.mp4box.onReady = (info) => {
            const track = info.videoTracks[0];
            if (track) {
                const mime = `video/mp4; codecs="${track.codec}"`;
                if (MediaSource.isTypeSupported(mime)) {
                    this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
                    this.mp4box.setSegmentOptions(track.id, this.sourceBuffer, { nbSamples: 20 });
                }
            }
        };

        this.mp4box.onSegment = (id, user, buffer) => {
            if (this.sourceBuffer) {
                if (!this.sourceBuffer.updating) {
                    try { this.sourceBuffer.appendBuffer(buffer); } catch(e) {}
                } else {
                    this.queue.push(buffer);
                }
            }
        };
        
        setInterval(() => {
            if (this.sourceBuffer && !this.sourceBuffer.updating && this.queue.length > 0) {
                try { this.sourceBuffer.appendBuffer(this.queue.shift()); } catch(e) {}
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
        URL.revokeObjectURL(this.url);
        window.activePlayer = null;
        this.mp4box = null;
    }
}
