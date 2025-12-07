
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v5 - Stability Fix
 * 
 * 修复内容：
 * 1. 修复点击下载后导致“自动重发”的严重 Bug。
 * 2. 修复图片/文件点击无法打开的问题 (改用原生 A 标签触发)。
 * 3. 增强 Blob URL 的生命周期管理。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v5 (Stable)');
  
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

  // 暴露给 HTML 的全局 API
  window.smartCore = {
    download: (fileId) => startDownload(fileId),
    openFile: (url) => { 
        // 强制新窗口打开，避开拦截
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.click();
    }
  };
}

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // === HOOK 1: 发送拦截 (修正：防止递归调用) ===
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    // 只有用户主动触发的“大文件”才拦截
    // 防止内部系统消息触发此逻辑
    if (!window.state.isUserAction && !fileInfo) {
        originalSendMsg.apply(this, arguments);
        return;
    }

    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) {
        originalSendMsg.apply(this, arguments);
        return;
    }

    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      window.util.log('🚀 处理大文件上传...');
      
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
             const preview = await makePreview(txt, 1024, 0.6);
             metaMsg.preview = preview;
          } catch(e) {}
      }
      
      window.db.addPending(metaMsg);
      // 本地直接渲染（不走网络回路，防止重复）
      const uiMsg = { id: metaMsg.id, senderId: metaMsg.senderId, n: metaMsg.n, ts: metaMsg.ts, kind: 'SMART_FILE_UI', meta: metaMsg };
      window.ui.appendMsg(uiMsg);
      
      // 仅广播 Meta
      window.protocol.flood(metaMsg); 
      return;
    }
    
    originalSendMsg.apply(this, arguments);
  };

  // === HOOK 2: 接收处理 (修正：严格过滤自己发的消息) ===
  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
    // 忽略自己发的 Meta (因为本地已经渲染过了)
    if (pkt.senderId === window.state.myId && pkt.t === 'SMART_META') return;

    if (pkt.t === 'SMART_META') {
      registerSource(pkt.fileId, fromPeerId || pkt.senderId);
      saveMeta(pkt);
      const uiMsg = { id: pkt.id, senderId: pkt.senderId, n: pkt.n, ts: pkt.ts, kind: 'SMART_FILE_UI', meta: pkt };
      window.ui.appendMsg(uiMsg); 
      window.protocol.flood(pkt, fromPeerId);
      return;
    }
    if (pkt.t === 'SMART_REQ') { handleChunkRequest(pkt, fromPeerId); return; }
    if (pkt.t === 'SMART_DATA') { handleChunkData(pkt); return; }
    
    originalProcess.apply(this, arguments);
  };

  // === HOOK 3: UI 渲染 (外链修正) ===
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      const isImg = m.meta.fileType.startsWith('image');
      
      let inner = '';
      if (isImg && m.meta.preview) {
         // 图片卡片
         inner = `
           <div class="smart-card" id="card-${m.meta.fileId}" style="position:relative; min-width:200px">
             <img src="${m.meta.preview}" style="display:block;max-width:100%;border-radius:8px;filter:brightness(0.7)">
             <div class="overlay" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
                <button onclick="window.smartCore.download('${m.meta.fileId}')" id="btn-${m.meta.fileId}" 
                   style="background:rgba(0,0,0,0.6);border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:16px;cursor:pointer">
                   ⬇ 原图
                </button>
             </div>
           </div>`;
      } else {
         // 文件卡片
         inner = `
           <div class="smart-card" style="padding:10px;min-width:200px">
             <div style="font-weight:bold;color:#4ea8ff;margin-bottom:4px">📄 ${window.util.escape(m.meta.fileName)}</div>
             <div style="font-size:11px;color:#aaa">${sizeStr}</div>
             <div style="margin-top:8px;text-align:right">
               <button onclick="window.smartCore.download('${m.meta.fileId}')" id="btn-${m.meta.fileId}"
                  style="background:#2a7cff;border:none;color:#fff;padding:5px 10px;border-radius:4px;cursor:pointer">
                  ⚡ 下载
               </button>
             </div>
           </div>`;
      }

      const html = `
        <div class="msg-row ${isMe ? 'me' : 'other'}" id="msg-${m.id}">
          <div>
            <div class="msg-bubble" style="padding:0;overflow:hidden;background:#2b2f3a;border:1px solid #444;color:#fff">
              ${inner}
              <!-- 隐形进度条 -->
              <div id="prog-${m.meta.fileId}" style="height:3px;width:0%;background:#0f0;transition:width 0.2s"></div>
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
  
  // 注入一段 CSS 来处理样式
  const css = document.createElement('style');
  css.innerHTML = `.smart-card img { transition: filter 0.3s; } .smart-card img:hover { filter: brightness(0.9); }`;
  document.head.appendChild(css);
}

// ---------------------------------------------------------
// 业务逻辑
// ---------------------------------------------------------
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

function registerSource(fileId, peerId) {
  if (!peerId) return;
  if (!transfers[fileId]) transfers[fileId] = { sources: new Set() };
  transfers[fileId].sources.add(peerId);
}

async function startDownload(fileId) {
  const btn = document.getElementById('btn-' + fileId);
  // 防止重复点击
  if (btn && btn.disabled) return;
  
  // 如果已经下载完成 (dataset.url 存在)，直接打开
  if (btn && btn.dataset.url) {
      window.smartCore.openFile(btn.dataset.url);
      return;
  }

  if (btn) btn.innerText = '⏳ 连接中...';

  const meta = await getMeta(fileId);
  if (!meta) { alert('文件元数据丢失'); return; }

  // 初始化任务
  if (!transfers[fileId]) transfers[fileId] = { sources: new Set() };
  transfers[fileId].meta = meta;
  transfers[fileId].chunks = new Array(meta.totalChunks).fill(null);
  transfers[fileId].needed = meta.totalChunks;
  
  if (window.state.conns[meta.senderId]) transfers[fileId].sources.add(meta.senderId);
  
  if (transfers[fileId].sources.size === 0) {
    window.protocol.flood({ t: 'SMART_REQ', q: 'WHO_HAS', fileId: fileId });
    setTimeout(() => downloadLoop(fileId), 2000);
    return;
  }
  downloadLoop(fileId);
}

function downloadLoop(fileId) {
  const task = transfers[fileId];
  if (!task || task.needed <= 0) return;
  const sources = Array.from(task.sources).filter(pid => window.state.conns[pid] && window.state.conns[pid].open);
  
  if (sources.length === 0) {
      const btn = document.getElementById('btn-' + fileId);
      if(btn) btn.innerText = '等待资源...';
      setTimeout(() => downloadLoop(fileId), 2000); 
      return; 
  }

  const pct = Math.floor(((task.chunks.length - task.needed) / task.chunks.length) * 100);
  const btn = document.getElementById('btn-' + fileId);
  if(btn) btn.innerText = `${pct}%`;
  
  const bar = document.getElementById('prog-' + fileId);
  if(bar) bar.style.width = pct + '%';

  let reqCount = 0;
  for (let i = 0; i < task.chunks.length; i++) {
    if (!task.chunks[i] && reqCount < 8) { 
       const target = sources[Math.floor(Math.random() * sources.length)];
       window.state.conns[target].send({ t: 'SMART_REQ', fileId: fileId, chunkIdx: i });
       reqCount++;
    }
  }
  setTimeout(() => downloadLoop(fileId), 500);
}

async function handleChunkRequest(pkt, fromPeerId) {
  if (pkt.q === 'WHO_HAS') return;
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
  if (task.needed === 0) finishDownload(pkt.fileId);
}

async function finishDownload(fileId) {
  const task = transfers[fileId];
  const btn = document.getElementById('btn-' + fileId);
  const bar = document.getElementById('prog-' + fileId);
  if(bar) bar.style.width = '100%';
  
  const blob = new Blob(task.chunks, { type: task.meta.fileType });
  const url = URL.createObjectURL(blob);
  
  // 保存到 DB (可选)
  await saveChunks(fileId, task.chunks, null);

  // === 核心逻辑：转换为外链模式 ===
  if (task.meta.fileType.startsWith('image')) {
      // 图片模式：替换 src，移除遮罩
      const card = document.getElementById('card-' + fileId);
      if (card) {
          const img = card.querySelector('img');
          const overlay = card.querySelector('.overlay');
          if (img) {
              img.src = url;
              img.style.filter = 'none';
              img.style.cursor = 'pointer';
              img.onclick = () => window.smartCore.openFile(url);
          }
          if (overlay) overlay.style.display = 'none';
      }
  } else {
      // 文件模式：按钮变色，点击跳转
      if (btn) {
          btn.innerText = '🔗 打开';
          btn.style.background = '#22c55e';
          btn.dataset.url = url; // 标记 URL
          btn.onclick = () => window.smartCore.openFile(url);
      }
  }
  
  console.log('✅ 下载完成，URL:', url);
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
