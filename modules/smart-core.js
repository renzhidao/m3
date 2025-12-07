
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v8 - Direct P2P Enforcer
 * 
 * 核心修正：
 * 1. 废弃数据转发模式，强制建立点对点直连通道。
 * 2. 解决远程传输 0% 问题：点击下载 -> 强制连接 Sender -> 直连传输。
 * 3. 只有直连建立后，才开始请求数据块。
 */

export function init() {
  console.log(' 加载模块: Smart Core v8 (Direct-P2P)');
  
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
    download: (fileId) => startDownload(fileId),
    openLocal: async (fileId) => {
        const url = await assembleFile(fileId);
        if (url) {
            const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.click();
        } else {
            alert('文件未就绪，请稍候');
        }
    }
  };
}

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // 1. 路由 (Gossip 仅用于广播 Meta，不传数据)
  window.protocol.flood = function(pkt, excludePeerId) {
    // 过滤掉数据包，防止全网风暴
    if (pkt.t === 'SMART_DATA' || pkt.t === 'SMART_REQ') return; 

    let all = Object.values(window.state.conns).filter(c => c.open && c.peer !== excludePeerId);
    if (all.length <= 12) { all.forEach(c => c.send(pkt)); return; }
    
    // 简单的随机路由
    const targets = [];
    // 必发房主
    all.filter(c => c.peer.startsWith(window.config.hub.prefix)).forEach(c => targets.push(c));
    // 随机路人
    const normals = all.filter(c => !c.peer.startsWith(window.config.hub.prefix));
    if (normals.length > 0) {
        targets.push(normals[Math.floor(Math.random() * normals.length)]); // 至少选一个
        if (normals.length > 1) targets.push(normals[Math.floor(Math.random() * normals.length)]);
    }
    
    if (typeof pkt.ttl === 'number') { if (pkt.ttl <= 0) return; pkt.ttl--; }
    targets.forEach(c => c.send(pkt));
  };

  // 2. 发送 (正常存库 + 广播 Meta)
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    if (!window.state.isUserAction && !fileInfo) { originalSendMsg.apply(this, arguments); return; }
    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) { originalSendMsg.apply(this, arguments); return; }

    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      const fileId = window.util.uuid();
      const rawData = base64ToArrayBuffer(txt);
      const chunks = sliceData(rawData, 16 * 1024);
      
      await saveChunks(fileId, chunks, fileInfo);
      
      const metaMsg = {
        t: 'SMART_META',
        id: window.util.uuid(),
        fileId: fileId,
        fileName: fileInfo ? fileInfo.name : `File_${Date.now()}`,
        fileType: fileInfo ? fileInfo.type : 'application/octet-stream',
        fileSize: rawData.byteLength,
        totalChunks: chunks.length,
        ts: window.util.now(),
        senderId: window.state.myId,
        n: window.state.myName,
        ttl: 16
      };

      if (kind === CHAT.KIND_IMAGE) {
          try {
             const preview = await makePreview(txt, 600, 0.6);
             metaMsg.preview = preview;
          } catch(e) {}
      }
      
      window.db.addPending(metaMsg);
      const uiMsg = { id: metaMsg.id, senderId: metaMsg.senderId, n: metaMsg.n, ts: metaMsg.ts, kind: 'SMART_FILE_UI', meta: metaMsg };
      window.ui.appendMsg(uiMsg);
      window.protocol.flood(metaMsg); 
      return;
    }
    originalSendMsg.apply(this, arguments);
  };

  // 3. 接收 (只处理直连数据)
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
    
    // 直连请求处理
    if (pkt.t === 'SMART_REQ') { 
        handleChunkRequest(pkt, fromPeerId); 
        return; 
    }
    if (pkt.t === 'SMART_DATA') { 
        handleChunkData(pkt); 
        return; 
    }
    
    originalProcess.apply(this, arguments);
  };

  // 4. UI 渲染 (样式优化)
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      const isImg = m.meta.fileType.startsWith('image');
      
      let inner = '';
      
      if (isMe) {
          // 我发的：直接打开
          if (isImg && m.meta.preview) {
              inner = `
               <div class="smart-card" style="cursor:pointer" onclick="window.smartCore.openLocal('${m.meta.fileId}')">
                 <img src="${m.meta.preview}" style="display:block;max-width:100%;max-height:200px;object-fit:contain;border-radius:8px;">
                 <div style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.5);color:#fff;font-size:10px;padding:2px 4px;border-radius:4px">已发送</div>
               </div>`;
          } else {
              inner = `
               <div class="smart-card" style="padding:10px;min-width:200px">
                 <div style="font-weight:bold;color:#4ea8ff">📄 ${window.util.escape(m.meta.fileName)}</div>
                 <div style="font-size:11px;color:#aaa">${sizeStr}</div>
                 <div style="margin-top:4px;text-align:right">
                    <button onclick="window.smartCore.openLocal('${m.meta.fileId}')" style="background:transparent;border:1px solid #555;color:#ddd;padding:4px 8px;border-radius:4px;cursor:pointer">📂 打开</button>
                 </div>
               </div>`;
          }
      } else {
          // 别人发的：下载交互
          if (isImg && m.meta.preview) {
              inner = `
               <div class="smart-card" id="card-${m.meta.fileId}" style="position:relative;cursor:pointer;min-width:150px" onclick="window.smartCore.download('${m.meta.fileId}')">
                 <img src="${m.meta.preview}" style="display:block;max-width:100%;max-height:200px;object-fit:contain;border-radius:8px;filter:brightness(0.7)">
                 <div class="overlay" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
                    <div class="dl-icon" style="background:rgba(0,0,0,0.5);border:2px solid #fff;border-radius:50%;width:40px;height:40px;display:grid;place-items:center;color:#fff;font-size:20px">⬇</div>
                    <div style="color:#fff;font-size:10px;margin-top:4px;text-shadow:0 1px 2px #000">${sizeStr}</div>
                 </div>
                 <div id="prog-wrap-${m.meta.fileId}" style="position:absolute;bottom:0;left:0;right:0;height:4px;background:rgba(0,0,0,0.5);display:none">
                    <div id="prog-${m.meta.fileId}" style="height:100%;width:0%;background:#0f0;transition:width 0.2s"></div>
                 </div>
               </div>`;
          } else {
              inner = `
               <div class="smart-card" style="padding:10px;min-width:200px">
                 <div style="font-weight:bold;color:#4ea8ff">📄 ${window.util.escape(m.meta.fileName)}</div>
                 <div style="font-size:11px;color:#aaa">${sizeStr}</div>
                 <div style="margin-top:8px;text-align:right">
                   <button onclick="window.smartCore.download('${m.meta.fileId}')" id="btn-${m.meta.fileId}"
                      style="background:#2a7cff;border:none;color:#fff;padding:5px 10px;border-radius:4px;cursor:pointer">
                      ⚡ 下载
                   </button>
                 </div>
                 <div id="prog-wrap-${m.meta.fileId}" style="margin-top:6px;height:3px;background:#333;display:none">
                    <div id="prog-${m.meta.fileId}" style="height:100%;width:0%;background:#0f0;transition:width 0.2s"></div>
                 </div>
               </div>`;
          }
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

// ---------------------------------------------------------
// 业务逻辑：强制直连下载
// ---------------------------------------------------------

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

const transfers = {};

async function startDownload(fileId) {
  const btn = document.getElementById('btn-' + fileId);
  const card = document.getElementById('card-' + fileId);
  
  // 1. 检查本地是否有缓存
  const url = await assembleFile(fileId);
  if (url) {
      finishDownload(fileId, url);
      // 自动打开
      const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.click();
      return;
  }

  // 2. 准备下载
  const meta = await getMeta(fileId);
  if (!meta) { alert('元数据丢失'); return; }

  // UI 状态
  const progWrap = document.getElementById('prog-wrap-' + fileId);
  if (progWrap) progWrap.style.display = 'block';
  if (btn) btn.innerText = '📡 连接中...';
  if (card) {
      const icon = card.querySelector('.dl-icon');
      if(icon) icon.innerText = '📡';
  }

  // 初始化任务
  if (!transfers[fileId]) transfers[fileId] = { meta: meta, chunks: new Array(meta.totalChunks).fill(null), needed: meta.totalChunks };
  
  const senderId = meta.senderId;
  
  // 3. 强制直连检测逻辑
  if (!window.state.conns[senderId] || !window.state.conns[senderId].open) {
      console.log('🔗 [Smart] 无直连，正在强制连接 Sender:', senderId);
      if (window.p2p) window.p2p.connectTo(senderId);
      
      // 等待连接建立 (最多等 10 秒)
      waitForConnection(senderId, fileId, 0);
  } else {
      console.log('✅ [Smart] 直连已就绪，开始请求');
      downloadLoop(fileId);
  }
}

function waitForConnection(targetId, fileId, attempt) {
    if (attempt > 20) { // 10秒超时
        const btn = document.getElementById('btn-' + fileId);
        if(btn) btn.innerText = '❌ 连接失败';
        alert('无法连接到发送者，请确认对方在线');
        return;
    }
    
    if (window.state.conns[targetId] && window.state.conns[targetId].open) {
        console.log('✅ [Smart] 直连建立成功！');
        downloadLoop(fileId);
    } else {
        setTimeout(() => waitForConnection(targetId, fileId, attempt + 1), 500);
    }
}

function downloadLoop(fileId) {
  const task = transfers[fileId];
  if (!task || task.needed <= 0) return;
  
  const senderId = task.meta.senderId;
  const conn = window.state.conns[senderId];
  
  // 再次确认连接
  if (!conn || !conn.open) {
      // 连接断开了，尝试重连
      window.p2p.connectTo(senderId);
      setTimeout(() => downloadLoop(fileId), 2000);
      return;
  }

  // UI 更新
  const pct = Math.floor(((task.chunks.length - task.needed) / task.chunks.length) * 100);
  const bar = document.getElementById('prog-' + fileId);
  const btn = document.getElementById('btn-' + fileId);
  if(bar) bar.style.width = pct + '%';
  if(btn) btn.innerText = `${pct}%`;

  // 并发请求 (直连模式下可以激进一点，发 16 个请求)
  let reqCount = 0;
  for (let i = 0; i < task.chunks.length; i++) {
    if (!task.chunks[i] && reqCount < 16) { 
       conn.send({ t: 'SMART_REQ', fileId: fileId, chunkIdx: i });
       reqCount++;
    }
  }
  
  // 0.2秒一轮，高速轮询
  setTimeout(() => downloadLoop(fileId), 200);
}

async function handleChunkRequest(pkt, fromPeerId) {
  // 收到请求，立刻回传
  const chunk = await getChunk(pkt.fileId, pkt.chunkIdx);
  if (chunk && window.state.conns[fromPeerId]) {
    window.state.conns[fromPeerId].send({ t: 'SMART_DATA', fileId: pkt.fileId, chunkIdx: pkt.chunkIdx, data: chunk.data });
  }
}

function handleChunkData(pkt) {
  const task = transfers[pkt.fileId];
  if (!task || task.chunks[pkt.chunkIdx]) return;
  task.chunks[pkt.chunkIdx] = pkt.data;
  task.needed--;
  
  const pct = Math.floor(((task.chunks.length - task.needed) / task.chunks.length) * 100);
  const bar = document.getElementById('prog-' + pkt.fileId);
  if(bar) bar.style.width = pct + '%';
  
  if (task.needed === 0) {
      const blob = new Blob(task.chunks, { type: task.meta.fileType });
      const url = URL.createObjectURL(blob);
      finishDownload(pkt.fileId, url);
      // 存库
      saveChunks(pkt.fileId, task.chunks, null);
  }
}

function finishDownload(fileId, url) {
  const btn = document.getElementById('btn-' + fileId);
  const card = document.getElementById('card-' + fileId);
  const prog = document.getElementById('prog-wrap-' + fileId);
  
  if (card) {
      const img = card.querySelector('img');
      const overlay = card.querySelector('.overlay');
      if (img) {
          img.src = url;
          img.style.filter = 'none';
      }
      if (overlay) overlay.style.display = 'none';
      card.onclick = () => window.smartCore.openLocal(fileId);
  } 
  else if (btn) {
      btn.innerText = '🔗 打开';
      btn.style.background = '#22c55e';
      btn.onclick = () => window.smartCore.openLocal(fileId);
  }
  if (prog) prog.style.display = 'none';
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
