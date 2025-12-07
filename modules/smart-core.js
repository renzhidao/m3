
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v15 - Truth Log & Click-Close
 */

export function init() {
  console.log('📦 加载模块: Smart Core v15 (Log)');
  
  const req = indexedDB.open('P1_FILE_DB', 1);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'fileId' });
  };
  req.onsuccess = e => {
    window.smartDB = e.target.result;
    applyHooks();
  };

  window.smartCore = {
    download: (fileId, msgId) => startDownload(fileId, msgId),
    openLocal: (fileId) => openFileViewer(fileId)
  };
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
      const uiMsg = { id: pkt.id, senderId: pkt.senderId, n: pkt.n, ts: pkt.ts, kind: 'SMART_FILE_UI', meta: pkt };
      window.ui.appendMsg(uiMsg); 
      window.protocol.flood(pkt, fromPeerId);
      return;
    }
    
    if (pkt.t === 'SMART_WAKE') {
       handleWakeSignal(pkt, fromPeerId);
       window.protocol.flood(pkt, fromPeerId);
       return;
    }

    if (pkt.t === 'SMART_REQ') { handleChunkRequest(pkt, fromPeerId); return; }
    if (pkt.t === 'SMART_DATA') { handleChunkData(pkt); return; }
    
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
      
      let inner = '';
      if (isImg && m.meta.preview) {
         inner = `
           <div class="smart-card" id="card-${domId}" style="position:relative;min-width:150px">
             <img src="${m.meta.preview}" style="display:block;max-width:100%;max-height:200px;object-fit:contain;border-radius:8px;${isMe?'':'filter:brightness(0.7)'}">
             ${isMe ? 
               `<div id="status-${domId}" style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.5);color:#fff;font-size:10px;padding:2px 4px;border-radius:4px;cursor:pointer" onclick="window.smartCore.openLocal('${m.meta.fileId}')">${m.isProcessing ? '⏳ 处理中' : '已发送'}</div>` 
               : 
               `<div class="overlay" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer" onclick="window.smartCore.download('${m.meta.fileId}', '${domId}')">
                  <div class="dl-btn" style="background:rgba(0,0,0,0.5);border:2px solid #fff;border-radius:50%;width:40px;height:40px;display:grid;place-items:center;color:#fff;font-size:20px">⬇</div>
                  <div class="dl-txt" style="color:#fff;font-size:10px;margin-top:4px;text-shadow:0 1px 2px #000">${sizeStr}</div>
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
                 `<button onclick="window.smartCore.download('${m.meta.fileId}', '${domId}')" id="btn-${domId}"
                    style="background:#2a7cff;border:none;color:#fff;padding:5px 10px;border-radius:4px;cursor:pointer">⚡ 下载</button>`
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

async function openFileViewer(fileId) {
    const url = await assembleFile(fileId);
    if (!url) { alert('文件尚未就绪'); return; }
    
    const meta = await getMeta(fileId);
    if (meta && meta.fileType && meta.fileType.startsWith('image/')) {
        if(window.ui && window.ui.previewImage) window.ui.previewImage(url);
        else window.open(url);
    } else {
        if(window.ui && window.ui.downloadBlob) window.ui.downloadBlob(url, meta ? meta.fileName : 'file.dat');
        else window.open(url);
    }
}

async function startDownload(fileId, domId) {
  const url = await assembleFile(fileId);
  if (url) {
      finishDownload(fileId, domId, url);
      openFileViewer(fileId);
      return;
  }

  const meta = await getMeta(fileId);
  if (!meta) { alert('元数据丢失'); return; }

  const progWrap = document.getElementById('prog-wrap-' + domId);
  if (progWrap) progWrap.style.display = 'block';
  
  const btn = document.getElementById('btn-' + domId);
  if (btn) btn.innerText = '...';
  
  if (!transfers[fileId]) transfers[fileId] = { 
      meta: meta, 
      chunks: new Array(meta.totalChunks).fill(null), 
      needed: meta.totalChunks, 
      domId: domId,
      _logShown: false
  };
  
  // === 真相日志 ===
  const senderId = meta.senderId;
  const conn = window.state.conns[senderId];
  window.util.log('🚀 发起下载请求...');
  window.util.log(`👤 目标发送者: ${window.util.escape(meta.n)} (${senderId.slice(0,6)})`);
  
  if (conn) {
      if (conn.open) {
          window.util.log(`🟢 P2P通道: 已连接 (RTT: ${Date.now() - (conn.lastPong||0)}ms)`);
      } else {
          window.util.log(`🟡 P2P通道: 存在但未Open (正在尝试重连)`);
          conn.close(); // 强制重置死连接
          if(window.p2p) window.p2p.connectTo(senderId);
      }
  } else {
      window.util.log(`🔴 P2P通道: 未连接 (尝试发起连接...)`);
      if(window.p2p) window.p2p.connectTo(senderId);
  }

  window.protocol.flood({
      t: 'SMART_WAKE',
      id: window.util.uuid(),
      fileId: fileId,
      requester: window.state.myId,
      ttl: 8
  });

  downloadLoop(fileId);
}

function downloadLoop(fileId) {
  const task = transfers[fileId];
  if (!task || task.needed <= 0) return;

  const pct = Math.floor(((task.chunks.length - task.needed) / task.chunks.length) * 100);
  const bar = document.getElementById('prog-' + task.domId);
  const btn = document.getElementById('btn-' + task.domId);
  if(bar) bar.style.width = pct + '%';
  if(btn) btn.innerText = `${pct}%`;

  const allConns = Object.values(window.state.conns).filter(c => c.open);
  const senderId = task.meta.senderId;
  allConns.sort((a, b) => {
      if (a.peer === senderId) return -1;
      if (b.peer === senderId) return 1;
      return 0;
  });

  if (allConns.length === 0) {
      if (btn) btn.innerText = '⏳ 寻路中';
      setTimeout(() => downloadLoop(fileId), 2000);
      return;
  }
  
  if (Math.random() < 0.1) {
       window.protocol.flood({
          t: 'SMART_WAKE',
          id: window.util.uuid(),
          fileId: fileId,
          requester: window.state.myId,
          ttl: 4
      });
  }

  let reqCount = 0;
  for (let i = 0; i < task.chunks.length; i++) {
    if (!task.chunks[i] && reqCount < 8) { 
       const target = allConns[reqCount % allConns.length];
       if (target && target.open) {
           target.send({ t: 'SMART_REQ', fileId: fileId, chunkIdx: i });
           reqCount++;
       }
    }
  }
  
  setTimeout(() => downloadLoop(fileId), 500);
}

async function handleWakeSignal(pkt, fromPeerId) {
    if (pkt.requester === window.state.myId) return;
    const chunks = await getChunk(pkt.fileId, 0); 
    if (chunks) {
        if (window.p2p && !window.state.conns[pkt.requester]) {
            window.p2p.connectTo(pkt.requester);
        }
    }
}

async function handleChunkRequest(pkt, fromPeerId) {
  const chunk = await getChunk(pkt.fileId, pkt.chunkIdx);
  const conn = window.state.conns[fromPeerId];
  if (chunk && conn && conn.open) {
      conn.send({ t: 'SMART_DATA', fileId: pkt.fileId, chunkIdx: pkt.chunkIdx, data: chunk.data });
  }
}

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
  const btn = document.getElementById('btn-' + domId);
  const card = document.getElementById('card-' + domId);
  const prog = document.getElementById('prog-wrap-' + domId);
  
  if (card) {
      const img = card.querySelector('img');
      const overlay = card.querySelector('.overlay');
      if (img) {
          img.src = url;
          img.style.filter = 'none';
      }
      if (overlay) overlay.style.display = 'none';
      card.onclick = () => openFileViewer(fileId);
  } 
  else if (btn) {
      btn.innerText = '🔗 打开';
      btn.style.background = '#22c55e';
      btn.onclick = () => openFileViewer(fileId);
  }
  if (prog) prog.style.display = 'none';
  window.util.log('✅ 下载完成');
}

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
