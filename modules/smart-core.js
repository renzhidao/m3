
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v4 - Unlimited & Direct Link
 * 
 * 核心升级：
 * 1. 彻底移除文件大小限制支持。
 * 2. "外链化"体验：下载完成后，生成 Blob URL，点击直接在浏览器新标签页打开。
 * 3. 修复点击无效的问题。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v4 (Unlimited)');
  
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
    openBlob: (url) => window.open(url, '_blank') // 简单的外链跳转工具
  };
}

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // === HOOK: Gossip 路由 ===
  window.protocol.flood = function(pkt, excludePeerId) {
    let all = Object.values(window.state.conns).filter(c => c.open && c.peer !== excludePeerId);
    if (all.length <= 12) { all.forEach(c => c.send(pkt)); return; }

    const targets = [];
    const hubs = all.filter(c => c.peer.startsWith(window.config.hub.prefix));
    const normals = all.filter(c => !c.peer.startsWith(window.config.hub.prefix));

    targets.push(...hubs);
    const needed = 10 - targets.length;
    if (needed > 0 && normals.length > 0) {
        for (let i = normals.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [normals[i], normals[j]] = [normals[j], normals[i]];
        }
        targets.push(...normals.slice(0, needed));
    }
    if (typeof pkt.ttl === 'number') { if (pkt.ttl <= 0) return; pkt.ttl--; }
    targets.forEach(c => c.send(pkt));
  };

  // === HOOK: 发送拦截 ===
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) {
        originalSendMsg.apply(this, arguments);
        return;
    }
    // 只要是大文件（无论多大），都走 Smart 通道
    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      window.util.log('🚀 正在处理大文件...');
      
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
              const previewBase64 = await makePreview(txt, 1024, 0.6);
              metaMsg.preview = previewBase64;
          } catch(e) {}
      }
      
      window.db.addPending(metaMsg);
      window.protocol.processIncoming(metaMsg);
      window.protocol.flood(metaMsg); 
      return;
    }
    originalSendMsg.apply(this, arguments);
  };

  // === HOOK: 接收 ===
  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
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

  // === HOOK: UI 渲染 (外链化改造) ===
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      const isImg = m.meta.fileType.startsWith('image');
      const hasPreview = !!m.meta.preview;
      
      let contentHtml = '';

      if (isImg && hasPreview) {
          // 图片模式
          contentHtml = `
            <div class="file-card smart-img-card" id="card-${m.meta.fileId}" style="padding:0; position:relative; min-width:200px; min-height:150px">
               <img src="${m.meta.preview}" style="display:block; max-width:100%; height:auto; border-radius:8px; filter: brightness(0.6);">
               
               <div class="overlay" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                  <button onclick="window.smartCore.download('${m.meta.fileId}')" 
                          id="btn-${m.meta.fileId}"
                          style="background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.5); color:#fff; padding:8px 16px; border-radius:20px; font-weight:bold; backdrop-filter:blur(4px);">
                    ⬇ 原图 (${sizeStr})
                  </button>
                  <div id="prog-wrap-${m.meta.fileId}" style="width:60%; height:3px; background:rgba(255,255,255,0.2); margin-top:10px; display:none">
                     <div id="prog-${m.meta.fileId}" style="width:0%; height:100%; background:#0f0; transition:width 0.2s"></div>
                  </div>
               </div>
            </div>
          `;
      } else {
          // 文件模式
          contentHtml = `
            <div class="file-card" style="background:transparent; padding:12px">
                <div class="file-icon">📦</div>
                <div class="file-info">
                   <div class="file-name" style="font-weight:bold;color:#4ea8ff">${window.util.escape(m.meta.fileName)}</div>
                   <div class="file-size" style="color:#aaa;font-size:11px">${sizeStr}</div>
                   <div class="progress-wrap" style="background:#111;height:4px;border-radius:2px;margin-top:8px;overflow:hidden">
                     <div id="prog-${m.meta.fileId}" style="width:0%; height:100%; background:#22c55e; transition:width 0.2s"></div>
                   </div>
                </div>
            </div>
            <div style="background:rgba(0,0,0,0.3); padding:8px 12px; display:flex; justify-content:flex-end">
                <button onclick="window.smartCore.download('${m.meta.fileId}')" 
                        id="btn-${m.meta.fileId}"
                        style="background:#2a7cff;border:none;color:#fff;padding:6px 14px;border-radius:4px;font-size:12px;font-weight:600">
                  ${isMe ? '已发送' : '⚡ 下载'}
                </button>
            </div>
          `;
      }

      const html = `
        <div class="msg-row ${isMe ? 'me' : 'other'}" id="msg-${m.id}">
          <div>
            <div class="msg-bubble" style="background:#2b2f3a; border:1px solid #444; color:#fff; padding:0; overflow:hidden">
              ${contentHtml}
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
  // 如果已经是完成状态，直接打开
  if (btn && btn.getAttribute('data-url')) {
      window.open(btn.getAttribute('data-url'), '_blank');
      return;
  }

  const progWrap = document.getElementById('prog-wrap-' + fileId);
  if (progWrap) progWrap.style.display = 'block';
  if (btn) btn.innerText = '⏳';

  const meta = await getMeta(fileId);
  if (!meta) { alert('元数据丢失'); return; }

  if (!transfers[fileId]) transfers[fileId] = { sources: new Set() };
  transfers[fileId].meta = meta;
  transfers[fileId].chunks = new Array(meta.totalChunks).fill(null);
  transfers[fileId].needed = meta.totalChunks;
  
  if (window.state.conns[meta.senderId]) transfers[fileId].sources.add(meta.senderId);
  
  if (transfers[fileId].sources.size === 0) {
    window.protocol.flood({ t: 'SMART_REQ', q: 'WHO_HAS', fileId: fileId });
    setTimeout(() => downloadLoop(fileId), 3000);
    return;
  }
  downloadLoop(fileId);
}

function downloadLoop(fileId) {
  const task = transfers[fileId];
  if (!task || task.needed <= 0) return;
  const sources = Array.from(task.sources).filter(pid => window.state.conns[pid] && window.state.conns[pid].open);
  if (sources.length === 0) { setTimeout(() => downloadLoop(fileId), 2000); return; }

  const pct = Math.floor(((task.chunks.length - task.needed) / task.chunks.length) * 100);
  const btn = document.getElementById('btn-' + fileId);
  if(btn) btn.innerText = `${pct}%`;

  let reqCount = 0;
  for (let i = 0; i < task.chunks.length; i++) {
    if (!task.chunks[i] && reqCount < 6) { 
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
  const pct = Math.floor(((task.chunks.length - task.needed) / task.chunks.length) * 100);
  const bar = document.getElementById('prog-' + pkt.fileId);
  if (bar) bar.style.width = pct + '%';
  if (task.needed === 0) finishDownload(pkt.fileId);
}

async function finishDownload(fileId) {
  const task = transfers[fileId];
  const btn = document.getElementById('btn-' + fileId);
  
  const blob = new Blob(task.chunks, { type: task.meta.fileType });
  const url = URL.createObjectURL(blob);
  
  // === 核心修复：外链化逻辑 ===
  
  if (task.meta.fileType.startsWith('image')) {
      // 图片：替换预览图，点击打开大图
      const card = document.getElementById('card-' + fileId);
      if (card) {
          const img = card.querySelector('img');
          if(img) {
              img.src = url;
              img.style.filter = 'none'; // 移除遮罩
              img.style.cursor = 'pointer';
              // 绑定点击事件：直接新窗口打开 Blob
              img.onclick = () => window.open(url, '_blank');
          }
          // 隐藏按钮层
          const overlay = card.querySelector('.overlay');
          if(overlay) overlay.style.display = 'none';
      }
  } else {
      // 文件：按钮变为“打开连接”
      if (btn) {
          btn.innerText = '🔗 打开连接';
          btn.style.background = '#22c55e';
          // 存储 URL 供 startDownload 里的判断使用，防止重复下载
          btn.setAttribute('data-url', url);
          // 强制新行为：点击即跳转
          btn.onclick = (e) => {
              e.stopPropagation();
              window.open(url, '_blank');
          };
      }
  }
  
  await saveChunks(fileId, task.chunks, null);
  console.log('✅ 资源已转为外链模式:', url);
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
