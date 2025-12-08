
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v19 - Trust Existing Connection
 * 修复：严禁在下载时主动断开/重置现有的 P2P 连接。
 * 保留：流媒体预览、蜂群下载、取消功能。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v19 (Trust-Fix)');
  
  const req = indexedDB.open('P1_FILE_DB', 1);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'fileId' });
  };
  req.onsuccess = e => {
    window.smartDB = e.target.result;
    setTimeout(broadcastInventory, 2000);
    applyHooks();
  };

  window.smartCore = {
    download: (fileId, msgId) => startDownload(fileId, msgId),
    cancel: (fileId) => cancelDownload(fileId),
    openLocal: (fileId) => openFileViewer(fileId),
    playVideo: (fileId, domId) => startStreaming(fileId, domId)
  };
}

async function broadcastInventory() {
    if (!window.smartDB || !window.protocol) return;
    const tx = window.smartDB.transaction(['meta'], 'readonly');
    const req = tx.objectStore('meta').getAllKeys();
    req.onsuccess = () => {
        const fileIds = req.result;
        if (fileIds && fileIds.length > 0) {
            window.protocol.flood({
                t: 'SMART_I_HAVE',
                list: fileIds,
                id: window.util.uuid()
            });
        }
    };
}

const fileProviders = {}; 

function addProvider(fileId, peerId) {
    if (!fileProviders[fileId]) fileProviders[fileId] = new Set();
    fileProviders[fileId].add(peerId);
}

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  window.protocol.flood = function(pkt, excludePeerId) {
    let all = Object.values(window.state.conns).filter(c => c.open && c.peer !== excludePeerId);
    all.forEach(c => c.send(pkt));
  };

  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    if (!window.state.isUserAction && !fileInfo) { originalSendMsg.apply(this, arguments); return; }
    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) { originalSendMsg.apply(this, arguments); return; }

    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      const fileId = window.util.uuid();
      const now = window.util.now();
      
      const metaMsg = {
        t: 'SMART_META',
        id: window.util.uuid(),
        fileId: fileId,
        fileName: fileInfo ? fileInfo.name : `File_${Date.now()}`,
        fileType: fileInfo ? fileInfo.type : 'application/octet-stream',
        fileSize: 0, 
        totalChunks: 0,
        ts: now,
        senderId: window.state.myId,
        n: window.state.myName,
        ttl: 16
      };
      
      const uiMsg = { id: metaMsg.id, senderId: metaMsg.senderId, n: metaMsg.n, ts: metaMsg.ts, kind: 'SMART_FILE_UI', meta: metaMsg, isProcessing: true };
      window.ui.appendMsg(uiMsg);

      setTimeout(async () => {
          try {
              const rawData = base64ToArrayBuffer(txt);
              const chunks = sliceData(rawData, 16 * 1024);
              metaMsg.fileSize = rawData.byteLength;
              metaMsg.totalChunks = chunks.length;

              if (kind === CHAT.KIND_IMAGE) {
                  try {
                     const preview = await makePreview(txt, 600, 0.6);
                     metaMsg.preview = preview;
                  } catch(e) {}
              }
              
              await saveChunks(fileId, chunks, metaMsg);
              addProvider(fileId, window.state.myId);
              
              window.db.addPending(metaMsg);
              window.protocol.flood(metaMsg); 
              
              const statusDiv = document.getElementById('status-' + metaMsg.id);
              if (statusDiv) statusDiv.innerText = '✅ 已就绪';
          } catch(e) {}
      }, 50);
      return;
    }
    originalSendMsg.apply(this, arguments);
  };

  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
    if (pkt.senderId === window.state.myId && pkt.t === 'SMART_META') return;
    
    if (pkt.t === 'SMART_META') {
      saveMeta(pkt);
      addProvider(pkt.fileId, pkt.senderId);
      const uiMsg = { id: pkt.id, senderId: pkt.senderId, n: pkt.n, ts: pkt.ts, kind: 'SMART_FILE_UI', meta: pkt };
      window.ui.appendMsg(uiMsg); 
      window.protocol.flood(pkt, fromPeerId);
      return;
    }
    
    if (pkt.t === 'SMART_I_HAVE' && Array.isArray(pkt.list)) {
        pkt.list.forEach(fid => addProvider(fid, fromPeerId || pkt.senderId)); 
        return; 
    }
    
    if (pkt.t === 'SMART_WHO_HAS') {
        checkAndRespond(pkt.fileId, fromPeerId);
        window.protocol.flood(pkt, fromPeerId);
        return;
    }

    if (pkt.t === 'SMART_REQ') { handleChunkRequest(pkt, fromPeerId); return; }
    if (pkt.t === 'SMART_DATA') { handleChunkData(pkt); return; }
    if (pkt.t === 'SMART_404') { handle404(pkt); return; }
    
    originalProcess.apply(this, arguments);
  };

  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      const domId = m.id;
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      const sizeStr = m.meta.fileSize ? (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB' : '计算中...';
      const isImg = m.meta.fileType && m.meta.fileType.startsWith('image');
      const isVideo = m.meta.fileType && m.meta.fileType.startsWith('video');
      
      let inner = '';
      if (isVideo) {
           inner = `
           <div class="smart-card" id="card-${domId}" style="padding:0;min-width:220px;background:#000;border-radius:8px;overflow:hidden">
             <div style="padding:10px;background:rgba(255,255,255,0.1)">
                <div style="font-weight:bold;color:#4ea8ff">🎬 ${window.util.escape(m.meta.fileName)}</div>
                <div style="font-size:11px;color:#aaa">${sizeStr}</div>
             </div>
             <div id="video-box-${domId}" style="width:100%;height:180px;display:flex;align-items:center;justify-content:center;background:#111;position:relative">
                ${isMe ? 
                  `<div style="color:#666">本地视频</div>` :
                  `<div id="play-btn-${domId}" style="width:60px;height:60px;background:rgba(255,255,255,0.2);border-radius:50%;display:grid;place-items:center;cursor:pointer;font-size:28px" 
                        onclick="window.smartCore.playVideo('${m.meta.fileId}', '${domId}')">▶</div>`
                }
                <video id="player-${domId}" controls style="width:100%;height:100%;display:none"></video>
                <div id="buf-tip-${domId}" style="position:absolute;bottom:10px;left:10px;color:#fff;font-size:10px;background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:4px;display:none">缓冲中...</div>
             </div>
             <div style="padding:8px;display:flex;justify-content:space-between;align-items:center;background:#1a1a1a">
                <div id="dl-txt-${domId}" style="font-size:10px;color:#aaa">点击播放</div>
                ${!isMe ? `<button id="btn-${domId}" onclick="window.smartCore.download('${m.meta.fileId}', '${domId}')" 
                   style="background:#333;border:1px solid #555;color:#fff;padding:4px 10px;border-radius:4px;font-size:12px">缓存</button>` : ''}
             </div>
             <div id="prog-wrap-${domId}" style="height:4px;background:#333;display:none">
                <div id="prog-${domId}" style="height:100%;width:0%;background:#2a7cff;transition:width 0.2s"></div>
             </div>
           </div>`;
      } 
      else if (isImg && m.meta.preview) {
         inner = `
           <div class="smart-card" id="card-${domId}" style="position:relative;min-width:150px">
             <img src="${m.meta.preview}" style="display:block;max-width:100%;max-height:200px;object-fit:contain;border-radius:8px;${isMe?'':'filter:brightness(0.7)'}">
             ${isMe ? 
               `<div id="status-${domId}" style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.5);color:#fff;font-size:10px;padding:2px 4px;border-radius:4px;cursor:pointer" onclick="window.smartCore.openLocal('${m.meta.fileId}')">${m.isProcessing ? '⏳ 处理中' : '已发送'}</div>` 
               : 
               `<div class="overlay" id="overlay-${domId}" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer" onclick="window.smartCore.download('${m.meta.fileId}', '${domId}')">
                  <div class="dl-btn" id="dl-icon-${domId}" style="background:rgba(0,0,0,0.5);border:2px solid #fff;border-radius:50%;width:40px;height:40px;display:grid;place-items:center;color:#fff;font-size:20px">⬇</div>
                  <div class="dl-txt" id="dl-txt-${domId}" style="color:#fff;font-size:10px;margin-top:4px;text-shadow:0 1px 2px #000">${sizeStr}</div>
               </div>`
             }
             <div id="prog-wrap-${domId}" style="position:absolute;bottom:0;left:0;right:0;height:4px;background:rgba(0,0,0,0.5);display:none">
                <div id="prog-${domId}" style="height:100%;width:0%;background:#0f0;transition:width 0.2s"></div>
             </div>
           </div>`;
      } else {
         inner = `
           <div class="smart-card" id="card-${domId}" style="padding:10px;min-width:200px">
             <div style="font-weight:bold;color:#4ea8ff">📄 ${window.util.escape(m.meta.fileName)}</div>
             <div style="font-size:11px;color:#aaa">${sizeStr}</div>
             <div style="margin-top:8px;text-align:right">
               ${isMe ? 
                 `<button id="status-${domId}" onclick="window.smartCore.openLocal('${m.meta.fileId}')" style="background:transparent;border:1px solid #555;color:#ddd;padding:4px 8px;border-radius:4px;cursor:pointer">${m.isProcessing ? '⏳' : '📂 打开'}</button>` 
                 : 
                 `<div style="display:flex;gap:10px;justify-content:flex-end">
                    <span id="dl-txt-${domId}" style="font-size:10px;align-self:center;color:#666"></span>
                    <button onclick="window.smartCore.download('${m.meta.fileId}', '${domId}')" id="btn-${domId}"
                        style="background:#2a7cff;border:none;color:#fff;padding:5px 10px;border-radius:4px;cursor:pointer">⚡ 下载</button>
                  </div>`
               }
             </div>
             <div id="prog-wrap-${domId}" style="margin-top:6px;height:3px;background:#333;display:none">
                <div id="prog-${domId}" style="height:100%;width:0%;background:#0f0;transition:width 0.2s"></div>
             </div>
           </div>`;
      }

      const html = `
        <div class="msg-row ${isMe ? 'me' : 'other'}" id="msg-${m.id}">
          <div>
            <div class="msg-bubble" style="padding:0;overflow:hidden;background:#2b2f3a;border:1px solid #444;color:#fff">
              ${inner}
            </div>
            <div class="msg-meta">${isMe ? '我' : window.util.escape(m.n)} ${new Date(m.ts).toLocaleTimeString()}</div>
          </div>
        </div>`;
      
      box.insertAdjacentHTML('beforeend', html);
      box.scrollTop = box.scrollHeight;
      return;
    }
    originalAppend.apply(this, arguments);
  };
}

const transfers = {};

async function checkAndRespond(fileId, peerId) {
    const chunks = await getChunk(fileId, 0);
    if (chunks) {
        const conn = window.state.conns[peerId];
        if (conn && conn.open) {
            conn.send({ t: 'SMART_I_HAVE', list: [fileId] });
        } else {
            if(window.p2p) window.p2p.connectTo(peerId);
        }
    }
}

function cancelDownload(fileId) {
    const task = transfers[fileId];
    if (task) {
        task.isCancelled = true;
        resetUI(task.domId, '已取消');
        delete transfers[fileId];
    }
}

async function startStreaming(fileId, domId) {
    startDownload(fileId, domId, true);
}

async function startDownload(fileId, domId, isStreaming = false) {
  if (transfers[fileId] && !transfers[fileId].isCancelled) return;

  const url = await assembleFile(fileId);
  if (url) {
      finishDownload(fileId, domId, url);
      if(!isStreaming) openFileViewer(fileId);
      return;
  }

  const meta = await getMeta(fileId);
  if (!meta) { alert('元数据丢失'); return; }

  const progWrap = document.getElementById('prog-wrap-' + domId);
  if (progWrap) progWrap.style.display = 'block';
  
  const btn = document.getElementById('btn-' + domId);
  if (btn) {
      btn.innerText = '❌ 取消';
      btn.style.background = '#ff3b30';
      btn.onclick = () => cancelDownload(fileId);
  }
  
  if (isStreaming) {
      document.getElementById('play-btn-' + domId).style.display = 'none';
      const v = document.getElementById('player-' + domId);
      v.style.display = 'block';
      const tip = document.getElementById('buf-tip-' + domId);
      if(tip) tip.style.display = 'block';
  }

  transfers[fileId] = { 
      meta: meta, 
      chunks: new Array(meta.totalChunks).fill(null), 
      needed: meta.totalChunks, 
      domId: domId,
      isCancelled: false,
      isStreaming: isStreaming,
      streamInit: false
  };

  window.util.log('🚀 开始下载 (信任模式)...');
  const senderId = meta.senderId;
  const conn = window.state.conns[senderId];
  
  // === 核心修复：绝对不主动关闭连接 ===
  if (conn) {
      if (conn.open) {
          window.util.log(`🟢 P2P通道: 已就绪`);
      } else {
          window.util.log(`⏳ 通道存在但未Open，等待中...`);
          // 不关闭，只等待
      }
  } else {
      window.util.log(`🔴 无连接，发起连接: ${senderId.slice(0,6)}`);
      if(window.p2p) window.p2p.connectTo(senderId);
  }

  // 广播找人 (Swarm)
  window.protocol.flood({ t: 'SMART_WHO_HAS', fileId: fileId, senderId: window.state.myId });

  downloadLoop(fileId);
}

function downloadLoop(fileId) {
  const task = transfers[fileId];
  if (!task || task.isCancelled) return;
  if (task.needed <= 0) return;

  const pct = Math.floor(((task.chunks.length - task.needed) / task.chunks.length) * 100);
  const bar = document.getElementById('prog-' + task.domId);
  const txt = document.getElementById('dl-txt-' + task.domId);
  
  if (task.isStreaming && !task.streamInit) {
      const chunksCount = 128; 
      let hasHead = true;
      for(let i=0; i<Math.min(task.chunks.length, chunksCount); i++) {
          if(!task.chunks[i]) { hasHead = false; break; }
      }
      
      if (hasHead) {
          task.streamInit = true;
          const headChunks = task.chunks.slice(0, chunksCount);
          const blob = new Blob(headChunks, { type: task.meta.fileType });
          const v = document.getElementById('player-' + task.domId);
          const tip = document.getElementById('buf-tip-' + task.domId);
          if (v) {
              v.src = URL.createObjectURL(blob);
              v.play().catch(()=>{}); 
              if(tip) tip.innerText = '正在预览 (后台下载中...)';
          }
      }
  }

  const providers = fileProviders[fileId] || new Set();
  if(task.meta.senderId) providers.add(task.meta.senderId);

  const activeSeeds = [];
  providers.forEach(pid => {
      const c = window.state.conns[pid];
      if (c && c.open) activeSeeds.push(c);
  });
  
  if(txt) txt.innerText = `下载中: ${pct}% (源:${activeSeeds.length})`;
  if(bar) bar.style.width = pct + '%';

  if (activeSeeds.length === 0) {
      if(txt) txt.innerText = '等待连接...';
      setTimeout(() => downloadLoop(fileId), 1000);
      return;
  }

  let reqCount = 0;
  for (let i = 0; i < task.chunks.length && reqCount < 10; i++) {
    if (!task.chunks[i]) { 
       const seed = activeSeeds[reqCount % activeSeeds.length];
       seed.send({ t: 'SMART_REQ', fileId: fileId, chunkIdx: i });
       reqCount++;
    }
  }
  
  setTimeout(() => downloadLoop(fileId), 200); 
}

async function handleChunkRequest(pkt, fromPeerId) {
  const chunk = await getChunk(pkt.fileId, pkt.chunkIdx);
  const conn = window.state.conns[fromPeerId];
  if (conn && conn.open) {
      if (chunk) {
          conn.send({ t: 'SMART_DATA', fileId: pkt.fileId, chunkIdx: pkt.chunkIdx, data: chunk.data });
      } else {
          conn.send({ t: 'SMART_404', fileId: pkt.fileId, chunkIdx: pkt.chunkIdx });
      }
  }
}

function handle404(pkt) {}

function handleChunkData(pkt) {
  const task = transfers[pkt.fileId];
  if (!task || task.chunks[pkt.chunkIdx]) return;
  task.chunks[pkt.chunkIdx] = pkt.data;
  task.needed--;
  
  if (task.needed === 0) {
      const blob = new Blob(task.chunks, { type: task.meta.fileType });
      const url = URL.createObjectURL(blob);
      finishDownload(pkt.fileId, task.domId, url);
      saveChunks(pkt.fileId, task.chunks, null);
  }
}

function finishDownload(fileId, domId, url) {
  const task = transfers[fileId];
  const isVideo = task && task.meta.fileType.startsWith('video');

  const btn = document.getElementById('btn-' + domId);
  const prog = document.getElementById('prog-wrap-' + domId);
  const txt = document.getElementById('dl-txt-' + domId);
  
  if(txt) txt.innerText = '下载完成';
  if(prog) prog.style.display = 'none';

  if (isVideo) {
      const v = document.getElementById('player-' + domId);
      const tip = document.getElementById('buf-tip-' + domId);
      if(tip) tip.style.display = 'none';
      if(v) {
          const curTime = v.currentTime;
          v.src = url;
          v.currentTime = curTime; 
          v.play(); 
      }
      if(btn) btn.style.display = 'none'; 
  } else {
      resetUI(domId, '✅ 完成');
      if (btn) {
          btn.innerText = '🔗 打开';
          btn.style.background = '#22c55e';
          btn.onclick = () => openFileViewer(fileId);
      }
      if(document.getElementById('dl-icon-' + domId)) {
          const card = document.getElementById('card-' + domId);
          if(card) card.onclick = () => openFileViewer(fileId);
      }
  }
  
  window.util.log('✅ 传输完成');
}

function resetUI(domId, msg) {
    const btn = document.getElementById('btn-' + domId);
    const icon = document.getElementById('dl-icon-' + domId);
    const txt = document.getElementById('dl-txt-' + domId);
    
    if (btn) {
        btn.innerText = '⚡ 下载';
        btn.style.background = '#2a7cff';
        const oldClone = btn.cloneNode(true);
        btn.parentNode.replaceChild(oldClone, btn);
        oldClone.onclick = () => alert('请刷新页面重试');
    }
    if (icon) {
        icon.innerText = '⬇';
        icon.style.borderColor = '#fff';
    }
    if (txt) txt.innerText = msg || '已取消';
}

// Utils (保持不变)
async function assembleFile(fileId) {
    const meta = await getMeta(fileId);
    if (!meta) return null;
    const chunks = [];
    for(let i=0; i<meta.totalChunks; i++) {
        const c = await getChunk(fileId, i);
        if(!c) return null;
        chunks.push(c.data);
    }
    const blob = new Blob(chunks, { type: meta.fileType });
    return URL.createObjectURL(blob);
}
function makePreview(base64, maxWidth, quality) {
    return new Promise((r, j) => {
        const img = new Image(); img.src = base64;
        img.onload = () => {
            const cvs = document.createElement('canvas');
            let w=img.width, h=img.height;
            if(w>maxWidth){h=(h*maxWidth)/w;w=maxWidth;}
            cvs.width=w; cvs.height=h;
            cvs.getContext('2d').drawImage(img,0,0,w,h);
            r(cvs.toDataURL('image/jpeg', quality));
        };
        img.onerror = j;
    });
}
function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64.split(',')[1] || base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); }
  return bytes.buffer;
}
function sliceData(buffer, size) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.byteLength) { chunks.push(buffer.slice(offset, offset + size)); offset += size; }
  return chunks;
}
function saveChunks(fileId, chunks, meta) {
  return new Promise((r, j) => {
    const tx = window.smartDB.transaction(['chunks', 'meta'], 'readwrite');
    chunks.forEach((data, idx) => tx.objectStore('chunks').put({ id: `${fileId}_${idx}`, data: data }));
    if (meta) tx.objectStore('meta').put({ fileId: fileId, ...meta });
    tx.oncomplete = r; tx.onerror = j;
  });
}
function getChunk(fileId, idx) {
  return new Promise(r => {
    const tx = window.smartDB.transaction(['chunks'], 'readonly');
    const req = tx.objectStore('chunks').get(`${fileId}_${idx}`);
    req.onsuccess = () => r(req.result);
    req.onerror = () => r(null);
  });
}
function getMeta(fileId) {
  if (transfers[fileId] && transfers[fileId].meta) return Promise.resolve(transfers[fileId].meta);
  return new Promise(r => {
    const tx = window.smartDB.transaction(['meta'], 'readonly');
    const req = tx.objectStore('meta').get(fileId);
    req.onsuccess = () => r(req.result);
  });
}
function saveMeta(meta) {
   const tx = window.smartDB.transaction(['meta'], 'readwrite');
   tx.objectStore('meta').put(meta);
}
