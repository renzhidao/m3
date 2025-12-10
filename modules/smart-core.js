import { MSG_TYPE, CHAT } from './constants.js';

function log(msg) {
    console.log(`[Core] ${msg}`);
    if (window.util) window.util.log(msg);
}

export function init() {
  window.virtualFiles = new Map(); window.remoteFiles = new Map(); window.smartMetaCache = new Map(); 
  window.activeTasks = new Map(); window.activePlayer = null;

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
              const meta = { ...pkt.meta, senderId: pkt.senderId }; // 保存来源，优先直连
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

  // === 万能数据接收补丁 (Blob/Buffer/Array) ===
  if (window.p2p) {
      const oldHandle = window.p2p.handleData;
      window.p2p.handleData = function(d, conn) {
          // 1. Blob 支持
          if (typeof Blob !== 'undefined' && d instanceof Blob) {
              const reader = new FileReader();
              reader.onload = () => {
                  if (window.smartCore && window.smartCore.handleBinary) window.smartCore.handleBinary(reader.result, conn.peer);
              };
              reader.readAsArrayBuffer(d);
              return;
          }
          // 2. ArrayBuffer / View
          if (d instanceof ArrayBuffer || d instanceof Uint8Array || (d && d.buffer && d.buffer instanceof ArrayBuffer)) {
              if (window.smartCore && window.smartCore.handleBinary) window.smartCore.handleBinary(d, conn.peer);
              return;
          }
          // 3. 序列化对象兼容
          if (d && typeof d === 'object' && !d.t && d[0] !== undefined) {
              try {
                  const arr = new Uint8Array(Object.values(d));
                  if (window.smartCore && window.smartCore.handleBinary) window.smartCore.handleBinary(arr, conn.peer);
                  return;
              } catch(e) {}
          }
          // 4. 普通信令
          oldHandle.call(this, d, conn);
      };
  }

  window.smartCore = {
      handleBinary: (data, fromId) => handleBinaryData(data, fromId),
      onMp4Ready: (fileId) => {
          const task = window.activeTasks.get(fileId);
          if (task) task.moovReady = true;
      },
      play: (fileId, name) => {
          if (window.virtualFiles.has(fileId)) return URL.createObjectURL(window.virtualFiles.get(fileId));
          startDownloadTask(fileId);
          autoBindVideo(fileId);
          if (name.match(/\.(mp4|mov)$/i)) {
              if (window.activePlayer) try{window.activePlayer.destroy()}catch(e){}
              window.activePlayer = new P2PVideoPlayer(fileId);
              return window.activePlayer.getUrl();
          }
          return ''; 
      },
      download: (fileId, name) => {
          if (window.virtualFiles.has(fileId)) {
              const a = document.createElement('a'); a.href = URL.createObjectURL(window.virtualFiles.get(fileId)); a.download = name; a.click();
          } else { startDownloadTask(fileId); log('⏳ 开始下载...'); }
      },
      cacheMeta: (m) => { if(m && m.fileId) window.smartMetaCache.set(m.fileId, m); },
      // 显式绑定播放器，启用拖动随机访问
      bindVideo: (video, fileId) => bindVideoEvents(video, fileId),
      // 主动寻址到时间（秒）
      seek: (fileId, seconds) => seekToTime(fileId, seconds)
  };
}

// ==== 传输/播放参数 ====
const CHUNK_SIZE = 128 * 1024; // 单包128KB，兼容移动端
const PARALLEL = 6;            // 并发窗口大小
const BASE_TAIL_SEGMENTS = 2;  // 初始预取尾部 2 块（拿 moov）
const ESCALATE_ROUNDS = 4;     // 最多追加 4 轮
const ESCALATE_STEP_MS = 300;  // 逐轮间隔

function startDownloadTask(fileId) {
    if (window.activeTasks.has(fileId)) return;
    const meta = window.smartMetaCache.get(fileId);
    if (!meta) { log('❌ Meta丢失'); return; }
    
    const task = {
        fileId, size: meta.fileSize, received: 0, chunks: [], nextOffset: 0,
        peers: [], parts: new Map(), tailRequested: new Set(), moovReady: false,
        inflight: new Set(), wantQueue: [], lastWanted: -CHUNK_SIZE, peerIndex: 0
    };
    
    if (meta.senderId && window.state.conns[meta.senderId]) task.peers.push(meta.senderId);
    if (window.remoteFiles.has(fileId)) {
        window.remoteFiles.get(fileId).forEach(pid => {
            if (!task.peers.includes(pid) && window.state.conns[pid]) task.peers.push(pid);
        });
    }
    
    log(`🎯 目标: ${task.peers.join(', ')}`);
    window.activeTasks.set(fileId, task);
    requestNextChunk(task);
    prefetchTail(task, BASE_TAIL_SEGMENTS);
    scheduleTailEscalation(task, 1);
}

function prefetchTail(task, segCount) {
    const offs = [];
    for (let i = segCount; i >= 1; i--) {
        const offset = task.size - i * CHUNK_SIZE;
        if (offset >= 0 && !task.tailRequested.has(offset)) {
            task.tailRequested.add(offset);
            offs.push(offset);
            log(`📡 预取尾部: ${(offset/1024).toFixed(0)}KB`);
        }
    }
    // 将尾部预取也纳入窗口，统一并发调度
    offs.forEach(off => pushWanted(task, off));
    dispatchRequests(task);
}

function scheduleTailEscalation(task, round) {
    if (round > ESCALATE_ROUNDS) return;
    setTimeout(() => {
        const t = window.activeTasks.get(task.fileId);
        if (!t || t.moovReady) return;
        prefetchTail(t, BASE_TAIL_SEGMENTS + 2*round);
        scheduleTailEscalation(t, round + 1);
    }, ESCALATE_STEP_MS);
}

// 窗口填充 + 并发请求
function requestNextChunk(task) {
    fillWindow(task);
    dispatchRequests(task);
}

function fillWindow(task) {
    const desired = PARALLEL * 2;
    while ((task.wantQueue.length + task.inflight.size) < desired) {
        const next = Math.max(task.nextOffset, task.lastWanted + CHUNK_SIZE);
        if (next >= task.size) break;
        pushWanted(task, next);
    }
}

function pushWanted(task, offset) {
    if (offset < 0 || offset >= task.size) return;
    if (task.inflight.has(offset)) return;
    if (task.parts.has(offset)) return;
    if (task.wantQueue.indexOf(offset) !== -1) return;
    task.wantQueue.push(offset);
    task.lastWanted = Math.max(task.lastWanted, offset);
}

function pickConn(task) {
    if (!task.peers.length) return null;
    const n = task.peers.length;
    for (let i = 0; i < n; i++) {
        const idx = (task.peerIndex + i) % n;
        const pid = task.peers[idx];
        const c = window.state.conns[pid];
        if (c && c.open) { task.peerIndex = (idx + 1) % n; return c; }
    }
    return null;
}

function dispatchRequests(task) {
    let sent = 0;
    while (task.inflight.size < PARALLEL && task.wantQueue.length > 0) {
        const off = task.wantQueue.shift();
        const conn = pickConn(task);
        if (!conn) { log('❌ 无可用连接'); task.wantQueue.unshift(off); break; }
        conn.send({ t: 'SMART_GET_CHUNK', fileId: task.fileId, offset: off, size: CHUNK_SIZE });
        task.inflight.add(off);
        log(`📡 请求: ${(off/1024).toFixed(0)}KB`);
        sent++;
    }
    return sent;
}

function handleGetChunk(pkt, fromId) {
    log(`📩 请求: ${pkt.offset} from ${fromId ? fromId.slice(0,4) : '?'}`);
    const file = window.virtualFiles.get(pkt.fileId);
    if (!file) { log(`❌ 无此文件`); return; }
    
    const blob = file.slice(pkt.offset, pkt.offset + pkt.size);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const buffer = reader.result;
            const header = JSON.stringify({ fileId: pkt.fileId, offset: pkt.offset });
            const headerBytes = new TextEncoder().encode(header);
            const packet = new Uint8Array(1 + headerBytes.byteLength + buffer.byteLength);
            packet[0] = headerBytes.byteLength;
            packet.set(headerBytes, 1);
            packet.set(new Uint8Array(buffer), 1 + headerBytes.byteLength);
            
            const conn = window.state.conns[fromId];
            if (conn && conn.open) {
                // 发送 Uint8Array，最大兼容
                conn.send(packet);
                log(`📤 数据发出: ${pkt.offset} -> ${fromId.slice(0,4)}`);
            } else {
                log(`❌ 发送失败: 连接断开`);
            }
        } catch(e) { log(`❌ 发送异常: ${e.message}`); }
    };
    reader.readAsArrayBuffer(blob);
}

function handleBinaryData(buffer, fromId) {
    try {
        let u8;
        if (buffer instanceof ArrayBuffer) u8 = new Uint8Array(buffer);
        else if (buffer instanceof Uint8Array) u8 = buffer;
        else if (buffer && buffer.buffer instanceof ArrayBuffer) u8 = new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length || 0);
        else return;

        const len = u8[0];
        const headerStr = new TextDecoder().decode(u8.slice(1, 1 + len));
        const header = JSON.parse(headerStr);
        const body = u8.slice(1 + len);
        
        const task = window.activeTasks.get(header.fileId);
        if (!task) return;

        // 标记此 offset 已返回
        if (task.inflight.has(header.offset)) task.inflight.delete(header.offset);

        // 先喂播放器（支持乱序）
        if (window.activePlayer && window.activePlayer.fileId === header.fileId) {
            window.activePlayer.appendChunk(body, header.offset);
        }

        // 存入乱序缓存
        if (!task.parts.has(header.offset)) task.parts.set(header.offset, body);

        // 连续冲刷顺序段
        let advanced = false;
        while (true) {
            const seg = task.parts.get(task.nextOffset);
            if (!seg) break;
            task.parts.delete(task.nextOffset);
            task.chunks.push(seg);
            task.received += seg.byteLength;
            task.nextOffset += seg.byteLength;
            advanced = true;
            log(`📥 收到: ${task.received - seg.byteLength} (${(task.received/task.size*100).toFixed(0)}%)`);
        }

        if (task.received >= task.size) {
            log('✅ 完成');
            window.virtualFiles.set(task.fileId, new Blob(task.chunks));
            if (window.activePlayer && window.activePlayer.fileId === header.fileId) {
                try { window.activePlayer.flush(); } catch(e) {}
            }
        } else {
            // 继续填充并发窗口
            requestNextChunk(task);
        }
    } catch(e) { console.error('Binary Parse Error', e); }
}

// === 拖动/寻址 ===
function seekToTime(fileId, seconds) {
    if (!window.activePlayer || window.activePlayer.fileId !== fileId) return;
    const task = window.activeTasks.get(fileId);
    if (!task) return;

    let seekRes = null;
    try { seekRes = window.activePlayer.seek(seconds); } catch(e) {}

    if (seekRes && typeof seekRes.offset === 'number') {
        const off = Math.max(0, Math.min(task.size - 1, seekRes.offset));
        // 重置并发窗口，从新位置起拉取
        task.wantQueue.length = 0;
        task.lastWanted = off - CHUNK_SIZE;
        // 不清理 inflight（允许回收利用），但会从新起点补足窗口
        if (off > task.nextOffset) task.nextOffset = off;
        fillWindow(task);
        dispatchRequests(task);
        log(`⏩ Seek -> 触发字节偏移: ${off}`);
    } else {
        // moov 尚未 ready，尽快扩大尾部预取
        prefetchTail(task, BASE_TAIL_SEGMENTS + 6);
    }
}

function bindVideoEvents(video, fileId) {
    if (!video || video._p2pBound) return;
    try {
        video.playsInline = true;
        video._p2pBound = true;
        video.addEventListener('seeking', () => {
            const t = isNaN(video.currentTime) ? 0 : video.currentTime;
            seekToTime(fileId, t);
        });
    } catch(e) {}
}

function autoBindVideo(fileId) {
    // 尝试自动绑定第一次出现的 video
    setTimeout(() => {
        const v = document.querySelector && document.querySelector('video');
        if (v) bindVideoEvents(v, fileId);
    }, 200);
}

class P2PVideoPlayer {
    constructor(fileId) {
        this.fileId = fileId;
        this.mediaSource = new MediaSource();
        this.url = URL.createObjectURL(this.mediaSource);
        if (typeof MP4Box === 'undefined') throw new Error('MP4Box Missing');
        this.mp4box = MP4Box.createFile();
        this.sourceBuffers = {};  // trackId -> SourceBuffer
        this.queues = {};         // trackId -> Array<ArrayBuffer>
        this.ready = false;
        this.mediaSource.addEventListener('sourceopen', () => this.init());
    }
    getUrl() { return this.url; }
    init() {
        this.mp4box.onReady = (info) => {
            try {
                const vts = (info.videoTracks || []);
                const ats = (info.audioTracks || []);
                const tracks = [...vts, ...ats];
                if (tracks.length === 0) return;

                // 创建对应 SourceBuffer
                tracks.forEach(t => {
                    const isVideo = (vts.find(v => v.id === t.id) != null);
                    const mime = (isVideo ? 'video/mp4' : 'audio/mp4') + `; codecs="${t.codec}"`;
                    if (window.MediaSource && MediaSource.isTypeSupported && !MediaSource.isTypeSupported(mime)) {
                        log(`⚠️ 不支持的MIME: ${mime}`);
                        return;
                    }
                    const sb = this.mediaSource.addSourceBuffer(mime);
                    this.sourceBuffers[t.id] = sb;
                    this.queues[t.id] = [];
                    sb.addEventListener('updateend', () => this.drain());
                    // 为每个轨配置分片
                    this.mp4box.setSegmentOptions(t.id, { trackId: t.id }, { nbSamples: 50 });
                });

                // 初始化分片（init segments）
                const inits = this.mp4box.initializeSegmentation();
                if (inits && inits.length) {
                    inits.forEach(seg => {
                        if (seg && seg.buffer && this.queues[seg.id]) {
                            this.queues[seg.id].push(seg.buffer);
                        }
                    });
                }
                this.ready = true;
                if (window.smartCore) window.smartCore.onMp4Ready(this.fileId);
                this.drain();
                this.mp4box.start();
            } catch(e) { log('❌ onReady异常: ' + e.message); }
        };
        this.mp4box.onSegment = (id, user, buf) => {
            if (buf && this.queues[id]) {
                this.queues[id].push(buf);
                this.drain();
            }
        };
    }
    drain() {
        try {
            Object.keys(this.sourceBuffers).forEach(id => {
                const sb = this.sourceBuffers[id];
                const q = this.queues[id];
                while (sb && !sb.updating && q && q.length) {
                    const seg = q.shift();
                    try { sb.appendBuffer(seg); } catch(e) { break; }
                }
            });
        } catch(e) {}
    }
    appendChunk(buf, offset) {
        // MP4Box 需要 ArrayBuffer 且设置 fileStart 为绝对偏移（支持乱序）
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        ab.fileStart = offset;
        try { this.mp4box.appendBuffer(ab); } catch(e) {}
    }
    flush() {
        try { this.mp4box.flush(); } catch(e) {}
        try {
            const allEmpty = Object.values(this.queues).every(q => q.length === 0);
            if (this.mediaSource.readyState === 'open' && allEmpty) {
                this.mediaSource.endOfStream();
            }
        } catch(e) {}
    }
    seek(seconds) {
        try { return this.mp4box.seek(seconds, true); } catch(e) { return null; }
    }
    destroy() { try{URL.revokeObjectURL(this.url);}catch(e){} }
}
