import { MSG_TYPE, CHAT, NET_PARAMS } from './constants.js';

function log(msg, type='info') {
    if (window.visualLog) window.visualLog(msg, type);
    console.log(`[SmartCore] ${msg}`);
}

export function init() {
  log('Core Start');

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
              const file = window.virtualFiles.get(fileId);
              if (window.ui && window.ui.downloadBlob) window.ui.downloadBlob(file, fileName);
              return;
          }
          log(`启动下载: ${fileName}`, 'tx');
          const url = `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
          const a = document.createElement('a'); a.href = url; a.download = fileName; 
          document.body.appendChild(a); a.click(); setTimeout(() => document.body.removeChild(a), 100);
      },
      
      play: (fileId, fileName) => {
          log(`Play: ${fileName}`, 'info');
          if (window.virtualFiles.has(fileId)) {
              try {
                  const file = window.virtualFiles.get(fileId);
                  if (file.size === 0) throw new Error('Empty');
                  const url = URL.createObjectURL(file);
                  window.blobUrls.set(fileId, url);
                  return url;
              } catch(e) { window.virtualFiles.delete(fileId); return null; }
          }

          const isVideo = fileName.match(/\.(mp4|mov|m4v)$/i);
          if (isVideo) {
              if (window.activePlayer) try { window.activePlayer.destroy(); } catch(e){}
              try { window.activePlayer = new P2PVideoPlayer(fileId); } catch (e) { log('No MP4Box', 'error'); return null; }
              
              const requestId = 'vid_' + Date.now();
              if (navigator.serviceWorker.controller) {
                  navigator.serviceWorker.controller.postMessage({
                      type: 'STREAM_OPEN', requestId, fileId, range: 'bytes=0-'
                  });
                  log('SW Stream Open', 'tx');
              } else {
                  log('SW Not Active!', 'error');
              }
              return window.activePlayer.getUrl();
          }
          return `/virtual/file/${fileId}/${encodeURIComponent(fileName)}`;
      }
  };

  setTimeout(() => {
      if (!window.protocol || !window.protocol.sendMsg) return;

      const originalSendMsg = window.protocol.sendMsg;
      window.protocol.sendMsg = function(txt, kind, meta) {
          if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && meta && meta.fileObj) {
              const file = meta.fileObj;
              const fileId = window.util.uuid();
              window.virtualFiles.set(fileId, file);
              
              log(`Tx File: ${file.name}`, 'tx');
              
              const target = (window.state.activeChat && window.state.activeChat !== CHAT.PUBLIC_ID) ? window.state.activeChat : CHAT.PUBLIC_ID;
              const fileMeta = {
                  id: window.util.uuid(), ts: Date.now(), senderId: window.state.myId, n: window.state.myName,
                  target: target, kind: 'SMART_FILE_UI', txt: `[文件] ${file.name}`,
                  meta: { fileId, fileName: file.name, fileSize: file.size, fileType: file.type }
              };

              window.protocol.processIncoming(fileMeta); 
              window.protocol.broadcast({ t: 'SMART_META', ...fileMeta }, target);
              log('Meta Broadcast', 'tx');
              return;
          }
          originalSendMsg.apply(this, arguments);
      };

      const originalProcess = window.protocol.processIncoming;
      window.protocol.processIncoming = function(pkt, fromPeerId) {
          if (pkt.t === 'SMART_META') {
              if (window.state.seenMsgs.has(pkt.id)) return;
              window.state.seenMsgs.add(pkt.id);
              
              log(`Rx Meta: ${pkt.meta.fileName}`, 'rx');
              
              window.db.saveMsg({ id: pkt.id, ts: pkt.ts, senderId: pkt.senderId, n: pkt.n, target: pkt.target, kind: pkt.kind, txt: pkt.txt, meta: pkt });
              window.smartMetaCache.set(pkt.fileId, pkt);
              if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());
              window.remoteFiles.get(pkt.fileId).add(pkt.senderId);
              if (window.ui) window.ui.appendMsg(pkt);
              return;
          }
          if (pkt.t === 'SMART_WHO_HAS') {
              if (window.virtualFiles.has(pkt.fileId)) {
                   const conn = window.state.conns[fromPeerId];
                   if(conn && conn.open) {
                       conn.send({ t: 'SMART_HAVE', fileId: pkt.fileId });
                       log(`Rx WHO_HAS -> Rep HAVE`, 'tx');
                   }
              }
              return;
          }
          if (pkt.t === 'SMART_HAVE') {
              log(`Rx HAVE from ${fromPeerId}`, 'rx');
              if (!window.remoteFiles.has(pkt.fileId)) window.remoteFiles.set(pkt.fileId, new Set());
              window.remoteFiles.get(pkt.fileId).add(fromPeerId);
              window.activeStreams.forEach(task => {
                  if (task.fileId === pkt.fileId && !task.finished) {
                       if (!task.peers.includes(fromPeerId)) task.peers.push(fromPeerId);
                       pumpStream(task);
                  }
              });
              return;
          }
          if (pkt.t === 'SMART_GET') {
              log(`Rx GET chunk ${pkt.offset}`, 'rx');
              handleSmartGet(pkt, fromPeerId);
              return;
          }
          originalProcess.apply(this, arguments);
      };
      log('Protocol Patched', 'info');
  }, 1000);
}

async function restoreMetaFromDB() {
    try {
        const list = await window.db.getRecent(200, 'all'); 
        list.forEach(m => {
            if (m.kind === 'SMART_FILE_UI' && m.meta) window.smartMetaCache.set(m.meta.fileId, m.meta);
        });
    } catch(e) {}
}

function handleSWMessage(event) {
    const d = event.data;
    if (d && d.type === 'STREAM_OPEN') {
        log('SW req Stream', 'info');
        startStreamTask(d);
    }
}

const CHUNK_SIZE = 512 * 1024;
const TIMEOUT_MS = 5000;

function startStreamTask(req) {
    const { requestId, fileId, range } = req;
    log(`Start Task: ${fileId}`, 'info');

    const meta = window.smartMetaCache.get(fileId);
    if (!meta) {
        sendToSW({ type: 'STREAM_ERROR', requestId, msg: 'Meta Not Found' });
        window.protocol.flood({ t: 'SMART_WHO_HAS', fileId });
        log('Meta Missing, flooding WHO_HAS', 'warn');
        return;
    }

    let start = 0; let end = meta.fileSize - 1;
    if (range && range.startsWith('bytes=')) {
        const parts = range.replace('bytes=', '').split('-');
        start = parseInt(parts[0], 10);
        if (parts[1]) end = parseInt(parts[1], 10);
    }

    sendToSW({ type: 'STREAM_META', requestId, fileSize: meta.fileSize, fileType: meta.fileType, start, end });

    const task = {
        requestId, fileId, start, end, cursor: start, 
        peers: Array.from(window.remoteFiles.get(fileId) || []),
        buffer: new Map(), bufferBytes: 0, inflight: new Map(), receivedOffsets: new Set(), finished: false
    };
    window.activeStreams.set(requestId, task);
    
    if (task.peers.length === 0) {
        window.protocol.flood({ t: 'SMART_WHO_HAS', fileId });
        log('No Peers, flooding WHO_HAS', 'warn');
    } else {
        log(`Found ${task.peers.length} peers, pumping...`, 'info');
        pumpStream(task);
    }
}

function stopStreamTask(reqId) {
    const task = window.activeStreams.get(reqId);
    if (task) { task.buffer.clear(); task.inflight.clear(); }
    window.activeStreams.delete(reqId);
}

function pumpStream(task) {
    if (task.finished) return;
    
    while (task.buffer.has(task.cursor)) {
        const chunk = task.buffer.get(task.cursor);
        task.buffer.delete(task.cursor); 
        sendToSW({ type: 'STREAM_DATA', requestId: task.requestId, chunk });
        if (window.activePlayer && window.activePlayer.fileId === task.fileId) window.activePlayer.appendChunk(chunk);
        task.cursor += chunk.byteLength;
        if (task.cursor > task.end) {
            sendToSW({ type: 'STREAM_END', requestId: task.requestId });
            task.finished = true;
            log('Transfer Finished', 'success');
            stopStreamTask(task.requestId);
            return;
        }
    }

    if (task.peers.length === 0) return;
    while (task.inflight.size < 8 && task.cursor + (task.inflight.size * CHUNK_SIZE) <= task.end) {
        let next = task.cursor;
        while (task.inflight.has(next) || task.buffer.has(next)) next += CHUNK_SIZE;
        if (next > task.end) break;
        
        const size = Math.min(CHUNK_SIZE, task.end - next + 1);
        const peer = task.peers[Math.floor(Math.random() * task.peers.length)];
        task.inflight.set(next, Date.now());
        const conn = window.state.conns[peer];
        if (conn && conn.open) {
            conn.send({ t: 'SMART_GET', reqId: task.requestId, fileId: task.fileId, offset: next, size });
            log(`TX GET ${next} -> ${peer.slice(0,4)}`, 'tx');
        }
    }
}

function watchdog() {
    const now = Date.now();
    window.activeStreams.forEach(task => {
        let needsPump = false;
        task.inflight.forEach((ts, offset) => {
            if (now - ts > TIMEOUT_MS) { task.inflight.delete(offset); needsPump = true; log(`Timeout chunk ${offset}`, 'warn'); }
        });
        if (needsPump || (task.inflight.size === 0 && !task.finished)) pumpStream(task);
    });
}

function handleIncomingBinary(buffer, fromPeerId) {
    try {
        const len = new Uint8Array(buffer.slice(0, 1))[0]; 
        if (len > 0 && len < 255) {
            const str = new TextDecoder().decode(buffer.slice(1, 1 + len));
            let h = null;
            try { h = JSON.parse(str); } catch(e){}
            if (h && h.reqId) {
                const task = window.activeStreams.get(h.reqId);
                if (task) {
                    const body = buffer.slice(1 + len);
                    if (!task.receivedOffsets.has(h.offset)) {
                        task.receivedOffsets.add(h.offset); 
                        task.inflight.delete(h.offset);     
                        task.buffer.set(h.offset, body);
                        log(`Rx DATA ${h.offset} <- ${fromPeerId.slice(0,4)}`, 'rx');
                        pumpStream(task);
                    }
                    return; 
                }
            }
        }
    } catch(e) {}
    log('Rx Unknown Binary', 'warn');
}

function handleSmartGet(pkt, pid) {
    const file = window.virtualFiles.get(pkt.fileId);
    if (!file) return;
    const conn = window.state.conns[pid];
    if (!conn || !conn.open) return;
    const reader = new FileReader();
    reader.onload = () => {
        const raw = reader.result;
        const h = JSON.stringify({ reqId: pkt.reqId, offset: pkt.offset });
        const hb = new TextEncoder().encode(h);
        const packet = new Uint8Array(1 + hb.byteLength + raw.byteLength);
        packet[0] = hb.byteLength;
        packet.set(hb, 1);
        packet.set(new Uint8Array(raw), 1 + hb.byteLength);
        conn.send(packet);
        log(`Tx DATA ${pkt.offset} -> ${pid.slice(0,4)}`, 'tx');
    };
    reader.readAsArrayBuffer(file.slice(pkt.offset, pkt.offset + pkt.size));
}

function sendToSW(msg) {
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(msg);
}

class P2PVideoPlayer {
    constructor(fileId) {
        this.fileId = fileId;
        this.mediaSource = new MediaSource();
        this.url = URL.createObjectURL(this.mediaSource);
        if (typeof MP4Box === 'undefined') throw new Error('MP4Box Missing');
        this.mp4box = MP4Box.createFile();
        this.sourceBuffer = null;
        this.queue = [];
        this.mediaSource.addEventListener('sourceopen', () => this.init());
    }
    getUrl() { return this.url; }
    init() {
        this.mp4box.onReady = (info) => {
            const track = info.videoTracks[0];
            if (track && MediaSource.isTypeSupported(`video/mp4; codecs="${track.codec}"`)) {
                this.sourceBuffer = this.mediaSource.addSourceBuffer(`video/mp4; codecs="${track.codec}"`);
                this.mp4box.setSegmentOptions(track.id, this.sourceBuffer, { nbSamples: 20 });
            }
        };
        this.mp4box.onSegment = (id, u, buf) => {
            if (this.sourceBuffer && !this.sourceBuffer.updating) try{this.sourceBuffer.appendBuffer(buf);}catch(e){}
            else this.queue.push(buf);
        };
        setInterval(() => {
            if (this.sourceBuffer && !this.sourceBuffer.updating && this.queue.length > 0) try{this.sourceBuffer.appendBuffer(this.queue.shift());}catch(e){}
        }, 50);
    }
    appendChunk(d) {
        const b = d.slice(0); b.fileStart = this.fileStart || 0; this.fileStart = (this.fileStart||0) + b.byteLength;
        this.mp4box.appendBuffer(b);
    }
    destroy() { URL.revokeObjectURL(this.url); window.activePlayer = null; }
}
