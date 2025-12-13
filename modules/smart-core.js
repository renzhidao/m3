import { MSG_TYPE, CHAT } from './constants.js';

// === Smart Core (Final Merged + Debugged Edition) ===
// 增强：播放问题定位日志（SW/MSE 路径、Range、MSE 缓存/配额）
// 增强：SMART_META 可靠送达（单聊 + 公共频道）
// 修复：本地保存逻辑 (字节校验 + 正确 MIME)
// 修复：手机录屏/大文件无法边下边播 (Probe Tail 扩大)
// 修复：发送端 FileReader 崩溃保护
// 修复：老设备 MSE 起播与收尾 (Moov 后置支持 + 滑动窗口清理)
// 修复：任务清理避免中断 SW 流

function log(msg) {
    console.log(`[Core] ${msg}`);
    if (window.util) window.util.log(msg);
}

const STAT = { send:0, req:0, recv:0, next:0 };
function statBump(k) {
    STAT[k]++;
    const now = Date.now();
    if (now > STAT.next) {
        log(`📊 速率: req=${STAT.req} send=${STAT.send} recv=${STAT.recv} (≈0.7s)`);
        STAT.send = STAT.req = STAT.recv = 0;
        STAT.next = now + 700;
    }
}

// === Tunables ===
// 保持较低的块大小以稳定发送端内存
const CHUNK_SIZE = 128 * 1024;
const PARALLEL = 12;
const PREFETCH_AHEAD = 3 * 1024 * 1024;
const MAX_BUFFERED = 256 * 1024;
const SEND_QUEUE = [];
const USE_SEQUENCE_MODE = false;

// Debug helpers
function fmtMB(n){ return (n/1024/1024).toFixed(1)+'MB'; }
function fmtRanges(v) {
    try {
        const b = v.buffered;
        const arr = [];
        for (let i=0;i<b.length;i++) arr.push(`[${b.start(i).toFixed(2)}, ${b.end(i).toFixed(2)}]`);
        return arr.join(', ');
    } catch(e){ return ''; }
}
function bindMoreVideoLogs(video, fileId){
    if (!video || video._moreLogsBound) return;
    video._moreLogsBound = true;
    const logBuffered = () => log(`🎞 buffered=${fmtRanges(video)} ct=${(video.currentTime||0).toFixed(2)} rdy=${video.readyState}`);
    video.addEventListener('progress', logBuffered);
    video.addEventListener('waiting', () => log('⏳ waiting ' + fmtRanges(video)));
    video.addEventListener('stalled', () => log('⚠️ stalled ' + fmtRanges(video)));
    video.addEventListener('seeking', () => log(`⏩ seeking to ${video.currentTime.toFixed(2)}`));
    video.addEventListener('seeked', () => log(`✅ seeked ${video.currentTime.toFixed(2)} buffered=${fmtRanges(video)}`));
    video.addEventListener('error', () => log('❌ <video> error: ' + (video.error && video.error.message)));
    setInterval(() => { if (!video.paused) logBuffered(); }, 4000);
}

// SMART_META ACK/重试参数
const META_RETRY_MS = 1500;
const META_MAX_RETRIES = 6;
const META_MAX_TTL_MS = 20000; // 公共频道发现新 peer 的窗口

export function init() {
  window.virtualFiles = new Map();
  window.smartMetaCache = new Map();
  window.remoteFiles = new Map();
  window.activeTasks = new Map();
  window.activePlayer = null;

  // SMART_META pending map
  window.pendingMeta = new Map(); // id -> { scope, msg, targets: Map<pid,{acked,tries,timer}>, start, discoveryTimer }

  if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', event => {
          const data = event.data;
          if (!data) return;
          if (data.type === 'PING') log('✅ SW 握手成功 (Core)');
          if (data.type === 'STREAM_OPEN') handleStreamOpen(data, event.source);
          if (data.type === 'STREAM_CANCEL') handleStreamCancel(data);
      });
  }

  if (window.protocol) {
      const origSend = window.protocol.sendMsg;
      window.protocol.sendMsg = function(txt, kind, meta) {
          if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && meta && meta.fileObj) {
              const file = meta.fileObj;
              const fileId = 'f_' + Date.now() + Math.random().toString(36).substr(2,5);
              window.virtualFiles.set(fileId, file);
              log(`✅ 文件注册: ${file.name} (${fmtMB(file.size)}) type=${file.type}`);

              const metaData = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type };
              const msg = {
                  t: 'SMART_META', id: 'm_' + Date.now(), ts: Date.now(), senderId: window.state.myId,
                  n: window.state.myName, kind: 'SMART_FILE_UI', txt: `[文件] ${file.name}`, meta: metaData,
                  target: (window.state.activeChat && window.state.activeChat !== CHAT.PUBLIC_ID) ? window.state.activeChat : CHAT.PUBLIC_ID
              };

              // 本地立即显示
              window.protocol.processIncoming(msg);

              // 可靠发送（单聊 + 公共频道）
              sendSmartMetaReliable(msg);
              return;
          }
          origSend.apply(this, arguments);
      };

      const origProc = window.protocol.processIncoming;
      window.protocol.processIncoming = function(pkt, fromPeerId) {
          if (pkt.t === 'SMART_META') {
              // 去重，但仍回 ACK，避免对方持续重试
              const seen = window.state.seenMsgs.has(pkt.id);
              if (!seen) {
                  window.state.seenMsgs.add(pkt.id);
                  log(`📥 Meta: ${pkt.meta.fileName} (${fmtMB(pkt.meta.fileSize)}) from=${pkt.senderId}`);
                  const meta = { ...pkt.meta, senderId: pkt.senderId };
                  window.smartMetaCache.set(meta.fileId, meta);
                  if(!window.remoteFiles.has(meta.fileId)) window.remoteFiles.set(meta.fileId, new Set());
                  window.remoteFiles.get(meta.fileId).add(pkt.senderId);
                  if (window.ui) window.ui.appendMsg(pkt);
              }
              // 回 ACK
              if (fromPeerId) {
                  const c = window.state.conns[fromPeerId];
                  if (c && c.open) c.send({ t: 'SMART_META_ACK', refId: pkt.id, from: window.state.myId });
              } else {
                  // 尝试直接回给 sender
                  const c = window.state.conns[pkt.senderId];
                  if (c && c.open) c.send({ t: 'SMART_META_ACK', refId: pkt.id, from: window.state.myId });
              }
              return;
          }
          if (pkt.t === 'SMART_META_ACK') {
              handleMetaAck(pkt, fromPeerId);
              return;
          }
          if (pkt.t === 'SMART_GET_CHUNK' || pkt.t === 'SMART_GET') {
              handleGetChunk(pkt, fromPeerId);
              return;
          }
          origProc.apply(this, arguments);
      };
  }

  window.smartCore = {
      _videos: {},

      handleBinary: (data, fromId) => handleBinaryData(data, fromId),

      play: (fileId, name) => {
          const meta = window.smartMetaCache.get(fileId) || {};
          const fileName = name || meta.fileName || '';
          const fileType = meta.fileType || '';
          const fileSize = meta.fileSize || 0;

          // 本地文件直接播放
          if (window.virtualFiles.has(fileId)) {
              const url = URL.createObjectURL(window.virtualFiles.get(fileId));
              log(`▶️ 本地Blob播放 ${fileName} (${fmtMB(fileSize)}) type=${fileType}`);
              return url;
          }

          startDownloadTask(fileId);

          const hasSW = navigator.serviceWorker && navigator.serviceWorker.controller;
          const isMP4 = /\.(mp4|mov|m4v)$/i.test(fileName) || /mp4|quicktime/.test(fileType);
          const isBig = fileSize > 20 * 1024 * 1024;
          const forceMSE = !!window.DEBUG_FORCE_MSE || false; // 可调开关：window.DEBUG_FORCE_MSE = true;

          if (hasSW) {
              log(`🎥 播放路径 = SW + 原生 <video> (Range) | ${fileName} (${fmtMB(fileSize)}) type=${fileType}`);
              const vUrl = `./virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
              setTimeout(() => {
                  const v = document.querySelector && document.querySelector('video');
                  if (v) { bindVideoEvents(v, fileId); bindMoreVideoLogs(v, fileId); }
              }, 300);
              return vUrl;
          }

          // 老设备或强制 MSE
          log(`🎥 播放路径 = MSE + MP4Box | ${fileName} (${fmtMB(fileSize)}) type=${fileType}`);
          if (fileName.match(/\.(mp4|mov|m4v)$/i)) {
              if (window.activePlayer) try{window.activePlayer.destroy()}catch(e){}
              window.activePlayer = new P2PVideoPlayer(fileId);

              const task = window.activeTasks.get(fileId);
              if (task) {
                  // 排序投喂，确保 MSE 初始化
                  const offsets = Array.from(task.parts.keys()).sort((a, b) => a - b);
                  for (const off of offsets) {
                      const data = task.parts.get(off);
                      try { window.activePlayer.appendChunk(data, off); } catch(e){}
                  }
              }

              autoBindVideo(fileId);
              setTimeout(() => {
                  const v = document.querySelector && document.querySelector('video');
                  if (v) { bindVideoEvents(v, fileId); bindMoreVideoLogs(v, fileId); }
              }, 300);

              return window.activePlayer.getUrl();
          }
          return '';
      },

      download: (fileId, name) => {
          const meta = window.smartMetaCache.get(fileId) || {};
          const fileName = name || meta.fileName || 'file';

          // 本地：直接保存
          if (window.virtualFiles.has(fileId)) {
              const data = window.virtualFiles.get(fileId);
              if (window.ui && window.ui.downloadBlob) {
                  window.ui.downloadBlob(data, fileName);
                  return;
              }
              const a = document.createElement('a');
              a.href = URL.createObjectURL(data);
              a.download = fileName;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              return;
          }

          // 远端：强制走 SW 虚拟直链下载（旧版行为：哪怕预览失败也能保存）
          try { startDownloadTask(fileId); } catch(e) {}
          const url = `./virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
      },

      bindVideo: (video, fileId) => { bindVideoEvents(video, fileId); bindMoreVideoLogs(video, fileId); },

      seek: (fileId, seconds) => {
           if (window.activePlayer && window.activePlayer.fileId === fileId) {
               const res = window.activePlayer.seek(seconds);
               if (res && typeof res.offset === 'number') {
                   const task = window.activeTasks.get(fileId);
                   if (task) {
                       const off = Math.floor(res.offset / CHUNK_SIZE) * CHUNK_SIZE;
                       log(`⏩ MSE Seek -> ${off}`);
                       task.nextOffset = off;
                       task.wantQueue = [];
                       task.inflight.clear();
                       task.inflightTimestamps.clear();
                       task.lastWanted = off - CHUNK_SIZE;
                       requestNextChunk(task);
                   }
               }
           }
      },

      runDiag: () => {
          log(`Tasks: ${window.activeTasks.size}, SendQ: ${SEND_QUEUE.length}`);
      }
  };

  setInterval(checkTimeouts, 1000);
  setInterval(flushSendQueue, 100);
}

/***********************
 * SMART_META 可靠送达 *
 ***********************/
function sendSmartMetaReliable(msg) {
    const entry = {
        scope: (msg.target === CHAT.PUBLIC_ID) ? 'public' : 'direct',
        msg,
        targets: new Map(), // pid -> { acked, tries, timer }
        start: Date.now(),
        discoveryTimer: null
    };
    window.pendingMeta.set(msg.id, entry);

    const addTargetIf = (pid) => {
        if (!pid || pid === window.state.myId) return;
        if (!window.state.conns[pid]) return;
        if (!entry.targets.has(pid)) {
            entry.targets.set(pid, { acked:false, tries:0, timer:null });
        }
    };

    // 初始目标：direct 就是目标，public 就是当前所有 open 的连接
    if (entry.scope === 'direct') {
        addTargetIf(msg.target);
    } else {
        Object.keys(window.state.conns || {}).forEach(pid => {
            const c = window.state.conns[pid];
            if (c && c.open) addTargetIf(pid);
        });
    }

    const sendTo = (pid) => {
        const c = window.state.conns[pid];
        if (c && c.open) {
            try { c.send(msg); } catch(e) { /* noop */ }
        }
    };

    const armRetry = (pid) => {
        const target = entry.targets.get(pid);
        if (!target || target.acked) return;
        if (target.timer) clearTimeout(target.timer);
        target.timer = setTimeout(() => {
            if (target.acked) return;
            if (Date.now() - entry.start > META_MAX_TTL_MS || target.tries >= META_MAX_RETRIES) {
                log(`❌ SMART_META ${msg.id} -> ${pid} 超时未确认 (tries=${target.tries})`);
                clearTimeout(target.timer);
                target.timer = null;
                return;
            }
            target.tries++;
            log(`🔁 重新发送 SMART_META #${target.tries} -> ${pid}`);
            sendTo(pid);
            armRetry(pid);
        }, META_RETRY_MS);
    };

    // 首次发送
    entry.targets.forEach((_, pid) => {
        sendTo(pid);
        armRetry(pid);
    });

    // 公共频道：在 TTL 窗口内，持续发现新上线 peer 并发送
    if (entry.scope === 'public') {
        entry.discoveryTimer = setInterval(() => {
            if (Date.now() - entry.start > META_MAX_TTL_MS) {
                clearInterval(entry.discoveryTimer);
                entry.discoveryTimer = null;
                return;
            }
            Object.keys(window.state.conns || {}).forEach(pid => {
                const c = window.state.conns[pid];
                if (c && c.open && !entry.targets.has(pid)) {
                    log(`🆕 新上线 peer，补发 SMART_META -> ${pid}`);
                    addTargetIf(pid);
                    sendTo(pid);
                    armRetry(pid);
                }
            });
        }, 1000);
    }
}

function handleMetaAck(pkt, fromPeerId) {
    const refId = pkt.refId;
    const entry = window.pendingMeta.get(refId);
    if (!entry) return;
    const pid = fromPeerId || (pkt.from || '');
    const target = entry.targets.get(pid);
    if (!target) return;
    target.acked = true;
    if (target.timer) clearTimeout(target.timer);
    target.timer = null;
    log(`✅ 收到 SMART_META ACK <- ${pid} ref=${refId}`);

    // 如果所有已知目标都 ACK 了，清理
    const allAcked = Array.from(entry.targets.values()).every(t => t.acked);
    if (allAcked) {
        if (entry.discoveryTimer) clearInterval(entry.discoveryTimer);
        window.pendingMeta.delete(refId);
    }
}

/***********************
 * 下载/播放主逻辑      *
 ***********************/
function bindVideoEvents(video, fileId) {
    if (!video || video._p2pBound) return;
    try {
        video.controls = true;
        video.playsInline = true;
        video._p2pBound = true;
        if (window.smartCore) window.smartCore._videos[fileId] = video;

        // 解决 0 秒处非关键帧黑屏
        video.addEventListener('loadedmetadata', () => {
            try { if (video.currentTime === 0) video.currentTime = 0.05; } catch(e){}
        });

        video.addEventListener('seeking', () => {
            const t = isNaN(video.currentTime) ? 0 : video.currentTime;
            if (window.smartCore) window.smartCore.seek(fileId, t);
        });
    } catch(e) {}
}

function autoBindVideo(fileId) {
    setTimeout(() => {
        const v = document.querySelector && document.querySelector('video');
        if (v) {
            if (!v.controls) v.controls = true;
            bindVideoEvents(v, fileId);
        }
    }, 500);
}

function checkTimeouts() {
    const now = Date.now();
    window.activeTasks.forEach(task => {
        if (task.completed) return;
        task.inflightTimestamps.forEach((ts, offset) => {
            if (now - ts > 3000) {
                task.inflight.delete(offset);
                task.inflightTimestamps.delete(offset);
                task.wantQueue.unshift(offset);
                log(`⏱️ 超时重试 off=${offset}`);
            }
        });
        if (task.inflight.size === 0 && task.wantQueue.length === 0 && !task.completed) {
            requestNextChunk(task);
        }
    });
}

function handleStreamOpen(data, source) {
    const { requestId, fileId, range } = data;

    if (window.virtualFiles.has(fileId)) {
        serveLocalBlob(fileId, requestId, range, source);
        return;
    }

    let task = window.activeTasks.get(fileId);
    if (!task) {
        startDownloadTask(fileId);
        task = window.activeTasks.get(fileId);
    }
    if (!task) {
        source.postMessage({ type: 'STREAM_ERROR', requestId, msg: 'Task Start Failed' });
        return;
    }

    let start = 0;
    let end = task.size - 1;
    if (range && range.startsWith('bytes=')) {
        const parts = range.replace('bytes=', '').split('-');
        const s = parseInt(parts[0], 10);
        const e = parts[1] ? parseInt(parts[1], 10) : end;
        if (!isNaN(s)) start = s;
        if (!isNaN(e)) end = Math.min(e, task.size - 1);
    }

    log(`📡 SW OPEN ${requestId}: range=${start}-${end} (${(end-start+1)} bytes)`);

    source.postMessage({
        type: 'STREAM_META', requestId, fileId,
        fileSize: task.size, fileType: task.fileType || 'application/octet-stream',
        start, end
    });

    task.swRequests.set(requestId, { start, end, current: start, source });

    const reqChunkIndex = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE;

    // === 修复: 图片/音频极速加载优化 ===
    // 如果是小文件 (< 2MB) 或起播段，强制插队优先下载
    if (task.size < 2 * 1024 * 1024) {
        // 小文件：全量预取
        for (let off = 0; off < task.size; off += CHUNK_SIZE) {
            if (!task.parts.has(off) && !task.wantQueue.includes(off) && !task.inflight.has(off)) {
                task.wantQueue.unshift(off); // 插队到最前
            }
        }
    } else if (Math.abs(task.nextOffset - start) > CHUNK_SIZE * 2) {
        // 大文件 Seek
        log(`⏩ SW Seek -> ${start}`);
        task.nextOffset = reqChunkIndex;
        task.wantQueue = [];
        task.inflight.clear();
        task.inflightTimestamps.clear();
        task.lastWanted = reqChunkIndex - CHUNK_SIZE;
    }

    processSwQueue(task);
    requestNextChunk(task);
}

function serveLocalBlob(fileId, requestId, range, source) {
    const blob = window.virtualFiles.get(fileId);
    if (!blob) return;

    let start = 0; let end = blob.size - 1;
    if (range && range.startsWith('bytes=')) {
        const parts = range.replace('bytes=', '').split('-');
        const s = parseInt(parts[0], 10);
        const e = parts[1] ? parseInt(parts[1], 10) : end;
        if (!isNaN(s)) start = s;
        if (!isNaN(e)) end = Math.min(e, blob.size - 1);
    }

    source.postMessage({
        type: 'STREAM_META', requestId, fileId,
        fileSize: blob.size, fileType: blob.type, start, end
    });

    const reader = new FileReader();
    reader.onload = () => {
        const buffer = reader.result;
        source.postMessage({ type: 'STREAM_DATA', requestId, chunk: buffer }, [buffer]);
        source.postMessage({ type: 'STREAM_END', requestId: requestId });
        log(`📤 SW 本地Blob响应完成 ${requestId} bytes=${end-start+1}`);
    };
    reader.readAsArrayBuffer(blob.slice(start, end + 1));
}

function handleStreamCancel(data) {
    const { requestId } = data;
    window.activeTasks.forEach(t => {
        t.swRequests.delete(requestId);
        if (t.completed) cleanupTask(t.fileId);
    });
}

function processSwQueue(task) {
    if (task.swRequests.size === 0) return;
    task.swRequests.forEach((req, reqId) => {
        let sentBytes = 0;
        while (req.current <= req.end) {
            const chunkOffset = Math.floor(req.current / CHUNK_SIZE) * CHUNK_SIZE;
            const insideOffset = req.current % CHUNK_SIZE;
            const chunkData = task.parts.get(chunkOffset);

            if (chunkData) {
                const available = chunkData.byteLength - insideOffset;
                const needed = req.end - req.current + 1;
                const sendLen = Math.min(available, needed);
                const slice = chunkData.slice(insideOffset, insideOffset + sendLen);

                req.source.postMessage({ type: 'STREAM_DATA', requestId: reqId, chunk: slice.buffer }, [slice.buffer]);
                req.current += sendLen;
                sentBytes += sendLen;

                if (sentBytes >= 2*1024*1024) {
                    log(`📤 SW ${reqId} -> +${sentBytes} bytes (cur=${req.current})`);
                    sentBytes = 0;
                }

                if (req.current > req.end) {
                    req.source.postMessage({ type: 'STREAM_END', requestId: reqId });
                    task.swRequests.delete(reqId);
                    log(`🏁 SW END ${reqId}`);
                    if (task.completed) cleanupTask(task.fileId);
                    break;
                }
            } else {
                log(`SW ⏳ WAIT chunk @${chunkOffset} (req.current=${req.current})`);
                break;
            }
        }
    });
}

// === 融合修复：Probe Tail 策略（扩大） ===
function startDownloadTask(fileId) {
    if (window.activeTasks.has(fileId)) return;
    const meta = window.smartMetaCache.get(fileId);
    if (!meta) return;

    const task = {
        fileId, size: meta.fileSize, fileType: meta.fileType,
        parts: new Map(), swRequests: new Map(), peers: [],
        peerIndex: 0, nextOffset: 0, lastWanted: -CHUNK_SIZE,
        wantQueue: [], inflight: new Set(), inflightTimestamps: new Map(),
        completed: false
    };

    if (meta.senderId && window.state.conns[meta.senderId]) task.peers.push(meta.senderId);
    if (window.remoteFiles.has(fileId)) {
        window.remoteFiles.get(fileId).forEach(pid => {
            if (!task.peers.includes(pid) && window.state.conns[pid]) task.peers.push(pid);
        });
    }

    log(`🚀 任务开始: ${fileId} (${fmtMB(task.size)}) peers=${task.peers.length}`);
    window.activeTasks.set(fileId, task);

    // 尾部优先：拉最后 6 块，帮助尽早拿到 moov
    if (task.size > CHUNK_SIZE) {
        const lastChunk = Math.floor((task.size - 1) / CHUNK_SIZE) * CHUNK_SIZE;
        for (let i = 0; i < 6; i++) {
            const off = lastChunk - i * CHUNK_SIZE;
            if (off >= 0 && !task.wantQueue.includes(off)) task.wantQueue.unshift(off);
        }
    }
    // 头部也拉
    if (!task.wantQueue.includes(0)) task.wantQueue.push(0);

    requestNextChunk(task);
}

function requestNextChunk(task) {
    if (task.completed) return;
    const desired = PARALLEL;

    task.swRequests.forEach(req => {
        let cursor = Math.floor(req.current / CHUNK_SIZE) * CHUNK_SIZE;
        const limit = cursor + PREFETCH_AHEAD;
        while (task.wantQueue.length < desired && cursor < limit && cursor < task.size) {
            if (!task.parts.has(cursor) && !task.inflight.has(cursor) && !task.wantQueue.includes(cursor)) {
                task.wantQueue.push(cursor);
            }
            cursor += CHUNK_SIZE;
        }
    });

    while (task.wantQueue.length < desired) {
        const off = Math.max(task.nextOffset, task.lastWanted + CHUNK_SIZE);
        if (off >= task.size) break;
        if (task.parts.has(off)) {
            task.nextOffset = off; task.lastWanted = off; continue;
        }
        if (!task.inflight.has(off) && !task.wantQueue.includes(off)) {
            task.wantQueue.push(off); task.lastWanted = off;
        } else {
             task.lastWanted += CHUNK_SIZE;
        }
    }
    dispatchRequests(task);
}

function dispatchRequests(task) {
    while (task.inflight.size < PARALLEL && task.wantQueue.length > 0) {
        const off = task.wantQueue.shift();
        const conn = pickConn(task);
        if (!conn) { task.wantQueue.unshift(off); break; }

        try {
            conn.send({ t: 'SMART_GET', fileId: task.fileId, offset: off, size: CHUNK_SIZE, reqId: task.fileId });
            task.inflight.add(off);
            task.inflightTimestamps.set(off, Date.now());
            log(`REQ → off=${off} peer=${conn.peerId || 'n/a'}`);
            statBump('req');
        } catch(e) {
            task.wantQueue.unshift(off); break;
        }
    }
}

function pickConn(task) {
    if (!task.peers.length) return null;
    for (let i=0; i<task.peers.length; i++) {
        const idx = (task.peerIndex + i) % task.peers.length;
        const pid = task.peers[idx];
        const c = window.state.conns[pid];
        if (c && c.open) {
            task.peerIndex = (idx + 1) % task.peers.length;
            return c;
        }
    }
    return null;
}

// === 融合修复：本地保存校验 + SW 流清理 ===
function handleBinaryData(buffer, fromId) {
    try {
        let u8;
        if (buffer instanceof ArrayBuffer) u8 = new Uint8Array(buffer);
        else if (buffer instanceof Uint8Array) u8 = buffer;
        else return;

        const len = u8[0];
        const headerStr = new TextDecoder().decode(u8.slice(1, 1 + len));
        const header = JSON.parse(headerStr);
        const body = u8.slice(1 + len);
        const safeBody = new Uint8Array(body);

        const fid = header.fileId || header.reqId;
        if (!fid) return;
        const task = window.activeTasks.get(fid);
        if (!task) return;

        task.inflight.delete(header.offset);
        task.inflightTimestamps.delete(header.offset);

        if (!task.parts.has(header.offset)) {
            task.parts.set(header.offset, safeBody);
            log(`RECV ← off=${header.offset} size=${safeBody.byteLength}`);
            statBump('recv');
        }

        processSwQueue(task);

        if (window.activePlayer && window.activePlayer.fileId === fid) {
            try { window.activePlayer.appendChunk(safeBody, header.offset); } catch(e){}
        }

        const expectedChunks = Math.ceil(task.size / CHUNK_SIZE);
        if (task.parts.size >= expectedChunks && !task.completed) {
            task.completed = true;

            // 字节完整性校验
            const chunks = [];
            let totalBytes = 0;
            for(let i=0; i<expectedChunks; i++) {
                const off = i * CHUNK_SIZE;
                const d = task.parts.get(off);
                if (d) { chunks.push(d); totalBytes += d.byteLength; }
            }

            if (totalBytes !== task.size) {
                log(`⚠️ 字节不匹配: got=${totalBytes} expected=${task.size}`);
            } else {
                log('✅ 下载完成 (字节校验通过)');
            }

            // 合成 Blob
            const blob = new Blob(chunks, { type: task.fileType || 'application/octet-stream' });
            window.virtualFiles.set(task.fileId, blob);

            if (window.activePlayer && window.activePlayer.fileId === task.fileId) {
                try { window.activePlayer.flush(); } catch(e){}
            }

            // 暂不立即清理 parts：可能还有 SW 流在读
            if (task.swRequests.size > 0) {
                log(`🟡 下载已完成，但仍有 ${task.swRequests.size} 个 SW 流未结束，继续供流后再清理`);
            } else {
                cleanupTask(task.fileId);
            }
            return;
        }
        requestNextChunk(task);
    } catch(e) {}
}

function cleanupTask(fileId) {
    const task = window.activeTasks.get(fileId);
    if (!task) return;
    if (task.swRequests.size === 0) {
        try { task.parts.clear(); } catch(e){}
        window.activeTasks.delete(fileId);
        log(`🧽 任务清理完成: ${fileId}`);
    } else {
        setTimeout(() => cleanupTask(fileId), 1000);
    }
}

// === 融合修复：发送端防崩溃 ===
function handleGetChunk(pkt, fromId) {
    // 1. 确认文件是否存在
    const file = window.virtualFiles.get(pkt.fileId);
    if (!file) return;

    // 2. 校验 Offset
    if (pkt.offset >= file.size) return;

    const reader = new FileReader();

    reader.onload = () => {
        if (!reader.result) return;
        try {
            const buffer = reader.result;
            const header = JSON.stringify({ fileId: pkt.fileId, reqId: pkt.reqId, offset: pkt.offset });
            const headerBytes = new TextEncoder().encode(header);

            const packet = new Uint8Array(1 + headerBytes.byteLength + buffer.byteLength);
            packet[0] = headerBytes.byteLength;
            packet.set(headerBytes, 1);
            packet.set(new Uint8Array(buffer), 1 + headerBytes.byteLength);

            const conn = window.state.conns[fromId];
            if (conn && conn.open) sendSafe(conn, packet);
        } catch(e) {
            log('❌ 发送组包异常: ' + e);
        }
    };

    reader.onerror = () => {
        log(`❌ 发送端读取失败 (Offset ${pkt.offset}): ${reader.error}`);
    };

    try {
        const blob = file.slice(pkt.offset, pkt.offset + pkt.size);
        reader.readAsArrayBuffer(blob);
    } catch(e) {
        log('❌ 发送端 Slice 异常: ' + e);
    }
}

function sendSafe(conn, packet) {
    const dc = conn.dataChannel || conn._dc || (conn.peerConnection && conn.peerConnection.createDataChannel ? null : null);
    // 保护：如果队列过长，丢弃旧包（避免堆爆）
    if (SEND_QUEUE.length > 200) {
        log('⚠️ 发送队列过载，丢弃包');
        SEND_QUEUE.shift();
    }

    if (dc && dc.bufferedAmount > MAX_BUFFERED) {
        SEND_QUEUE.push({ conn, packet });
        return;
    }
    try {
        conn.send(packet);
        statBump('send');
    } catch(e) {
        SEND_QUEUE.push({ conn, packet });
    }
}

function flushSendQueue() {
    if (SEND_QUEUE.length === 0) return;
    let processCount = 8;
    const fails = [];
    while (SEND_QUEUE.length > 0 && processCount > 0) {
        const item = SEND_QUEUE.shift();
        if (!item.conn || item.conn.readyState === 'closed' || !item.conn.open) continue;

        const dc = item.conn.dataChannel || item.conn._dc;
        if (dc && dc.bufferedAmount > MAX_BUFFERED) {
            fails.push(item);
        } else {
            try {
                item.conn.send(item.packet);
                statBump('send');
                processCount--;
            } catch(e) {
                fails.push(item);
            }
        }
    }
    if (fails.length > 0) SEND_QUEUE.unshift(...fails);
}

// === P2PVideoPlayer (老设备收尾与稳定性增强版 + 日志 + 缓存滑窗) ===
class P2PVideoPlayer {
    constructor(fileId) {
        this.fileId = fileId;
        this.mediaSource = new MediaSource();
        this.url = URL.createObjectURL(this.mediaSource);

        if (typeof MP4Box === 'undefined') return;

        this.mp4box = MP4Box.createFile();
        this.sourceBuffers = {};
        this.queues = {};
        this.info = null;

        this.wantEOS = false;
        this.ended = false;
        this.trackLast = {};

        this.mp4box.onReady = (info) => {
            try {
                this.info = info;
                const vts = info.videoTracks || [];
                const ats = info.audioTracks || [];
                const tracks = [...vts, ...ats];
                if (!tracks.length) return;

                if (info.duration && info.timescale) {
                    try { this.mediaSource.duration = info.duration / info.timescale; } catch(e) {}
                }

                log(`🧠 MP4Ready: dur=${(info.duration/info.timescale).toFixed(2)}s v=${vts.length} a=${ats.length}`);
                vts.forEach(t => log(`  🎬 vtrack id=${t.id} codec=${t.codec} kbps=${(t.bitrate/1000|0)}`));
                ats.forEach(t => log(`  🎧 atrack id=${t.id} codec=${t.codec} kbps=${(t.bitrate/1000|0)}`));

                tracks.forEach(t => {
                    this.mp4box.setSegmentOptions(t.id, null, { nbSamples: 20, rapAlignment: true });
                });

                const inits = this.mp4box.initializeSegmentation();
                if (inits && inits.length) {
                    inits.forEach(seg => {
                        if (!this.queues[seg.id]) this.queues[seg.id] = [];
                        this.queues[seg.id].push(seg.buffer);
                    });
                }

                this.mp4box.start();

                if (this.mediaSource.readyState === 'open') this.ensureSourceBuffers(tracks);
                this.drain();
                this.logBuffered();
                this.maybeCloseIfDone();
            } catch(e) { log('❌ onReady异常: ' + e.message); }
        };

        this.mp4box.onSegment = (id, user, buf, sampleNum, last) => {
            if (!this.queues[id]) this.queues[id] = [];
            this.queues[id].push(buf);
            if (last) this.trackLast[id] = true;
            this.drain();
            this.logBuffered();
            this.maybeCloseIfDone();
        };

        this.mediaSource.addEventListener('sourceopen', () => {
            const tracks = (this.info ? [...(this.info.videoTracks||[]), ...(this.info.audioTracks||[])] : []);
            this.ensureSourceBuffers(tracks);
            this.drain();
            this.logBuffered();
            this.maybeCloseIfDone();
        });
    }

    ensureSourceBuffers(tracks) {
        if (!tracks || !tracks.length) return;
        tracks.forEach(t => {
            if (this.sourceBuffers[t.id]) return;
            const isVideo = (this.info.videoTracks || []).some(v => v.id === t.id);
            const mime = (isVideo ? 'video/mp4' : 'audio/mp4') + `; codecs="${t.codec}"`;
            if (window.MediaSource && MediaSource.isTypeSupported && !MediaSource.isTypeSupported(mime)) return;

            const sb = this.mediaSource.addSourceBuffer(mime);
            if (USE_SEQUENCE_MODE) {
                try { sb.mode = 'sequence'; sb.timestampOffset = 0; } catch(_) {}
            }
            sb.addEventListener('updateend', () => { this.drain(); this.logBuffered(); this.maybeCloseIfDone(); });
            this.sourceBuffers[t.id] = sb;
            if (!this.queues[t.id]) this.queues[t.id] = [];
        });
    }

    drain() {
        try {
            Object.keys(this.sourceBuffers).forEach(id => {
                const sb = this.sourceBuffers[id];
                const q = this.queues[id];
                while (sb && !sb.updating && q && q.length) {
                    const seg = q.shift();
                    try {
                        sb.appendBuffer(seg);
                    } catch (e) {
                        if (e && e.name === 'QuotaExceededError') {
                            log('🧱 MSE QuotaExceededError，开始清理旧缓冲区...');
                            this.evictOldBuffered(); // 清理所有 SB 的旧缓冲
                            q.unshift(seg);
                        } else {
                            log('❌ appendBuffer error: ' + e);
                            q.unshift(seg);
                        }
                        return;
                    }
                }
            });
        } catch(e) { log('❌ drain异常: ' + e); }
    }

    evictOldBuffered() {
        const video = window.smartCore && window.smartCore._videos[this.fileId];
        const cur = video ? (video.currentTime || 0) : 0;
        const KEEP_BACK = 30;   // 当前时间之前至少保留 30s
        const KEEP_AHEAD = 120; // 当前时间之后至少保留 120s

        Object.values(this.sourceBuffers).forEach(sb => {
            try {
                if (!sb || !sb.buffered || sb.buffered.length === 0 || sb.updating) return;
                const start = sb.buffered.start(0);
                const end   = sb.buffered.end(sb.buffered.length - 1);
                const removeEnd = Math.min(cur - KEEP_BACK, end - KEEP_AHEAD);
                if (removeEnd > start + 1) {
                    sb.remove(start, removeEnd);
                    log(`🧹 已清理缓冲: [${start.toFixed(1)}, ${removeEnd.toFixed(1)}]`);
                } else {
                    log('ℹ️ 无需清理，窗口太小');
                }
            } catch(e) {}
        });
    }

    logBuffered() {
        const video = window.smartCore && window.smartCore._videos[this.fileId];
        const t = video ? video.currentTime : 0;
        Object.values(this.sourceBuffers).forEach((sb, i) => {
            try {
                let ranges = [];
                for (let k=0; k<sb.buffered.length; k++) {
                    ranges.push(`[${sb.buffered.start(k).toFixed(1)}, ${sb.buffered.end(k).toFixed(1)}]`);
                }
                log(`MSE buffered #${i} @${t.toFixed(1)}s: ${ranges.join(' ') || '∅'}`);
            } catch(_) {}
        });
    }

    maybeCloseIfDone() {
        if (this.ended || !this.wantEOS) return;
        if (this.mediaSource.readyState !== 'open') return;

        if (Object.values(this.sourceBuffers).some(sb => sb.updating)) return;
        if (!Object.values(this.queues).every(q => !q || q.length === 0)) return;

        let allLast = true;
        if (this.info) {
            const ids = [...(this.info.videoTracks||[]), ...(this.info.audioTracks||[])].map(t => t.id);
            if (ids.length) allLast = ids.every(id => this.trackLast[id]);
        }

        if (!allLast) {
            setTimeout(() => this.maybeCloseIfDone(), 50);
            return;
        }

        try { this.mediaSource.endOfStream(); } catch(e) {}
        this.ended = true;
        log('🎬 MSE EndOfStream called');
    }

    getUrl() { return this.url; }

    appendChunk(buf, offset) {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        try { Object.defineProperty(ab, 'fileStart', { value: offset }); } catch(_) { ab.fileStart = offset; }
        try { this.mp4box.appendBuffer(ab); } catch(e) {}
    }

    flush() {
        this.wantEOS = true;
        try { this.mp4box.flush(); } catch(e) {}
        setTimeout(() => this.maybeCloseIfDone(), 0);
    }

    seek(seconds) {
        try { return this.mp4box.seek(seconds, true); } catch(e) { return null; }
    }

    destroy() { try{URL.revokeObjectURL(this.url);}catch(e){} }
}