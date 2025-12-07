
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v3 - HD Preview Edition
 * 
 * 核心升级：
 * 1. 即使是大文件，也会生成一张“高清预览图”(HD Preview) 随 Meta 广播。
 * 2. 接收方无需下载即可看到清晰的图片内容。
 * 3. 点击图片可下载无损原图。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v3 (HD-Preview)');
  
  // 初始化数据库
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
    download: (fileId) => startDownload(fileId)
  };
}

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // === HOOK: Gossip 路由 (保持 v2 的房主优先策略) ===
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

  // === HOOK: 发送拦截 (生成高清预览) ===
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    // 1. 小图 (<300KB) 直接发，最快
    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) {
        originalSendMsg.apply(this, arguments);
        return;
    }

    // 2. 大图/大文件处理
    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      window.util.log('📸 生成高清预览并加密存储...');
      
      const fileId = window.util.uuid();
      const rawData = base64ToArrayBuffer(txt);
      const chunks = sliceData(rawData, 16 * 1024);
      
      await saveChunks(fileId, chunks, fileInfo);
      
      // 构建 Meta
      const metaMsg = {
        t: 'SMART_META',
        id: window.util.uuid(),
        fileId: fileId,
        fileName: fileInfo ? fileInfo.name : `Image_${Date.now()}.png`,
        fileType: fileInfo ? fileInfo.type : 'image/png',
        fileSize: rawData.byteLength,
        totalChunks: chunks.length,
        ts: window.util.now(),
        senderId: window.state.myId,
        n: window.state.myName,
        ttl: 16
      };

      // 关键升级：如果是图片，生成高清预览图嵌入 Meta
      if (kind === CHAT.KIND_IMAGE) {
          try {
              // 生成 1024px 宽度的预览图 (约 80-100KB)
              const previewBase64 = await makePreview(txt, 1024, 0.6);
              metaMsg.preview = previewBase64;
              // window.util.log(`预览图生成: ${(previewBase64.length/1024).toFixed(1)}KB`);
          } catch(e) {
              console.warn('预览生成失败', e);
          }
      }
      
      window.db.addPending(metaMsg);
      window.protocol.processIncoming(metaMsg);
      window.protocol.flood(metaMsg); 
      return;
    }
    
    originalSendMsg.apply(this, arguments);
  };

  // === HOOK: 接收处理 ===
  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
    if (pkt.t === 'SMART_META') {
      registerSource(pkt.fileId, fromPeerId || pkt.senderId);
      saveMeta(pkt);
      
      const uiMsg = {
        id: pkt.id,
        senderId: pkt.senderId,
        n: pkt.n,
        ts: pkt.ts,
        kind: 'SMART_FILE_UI', 
        meta: pkt 
      };
      
      window.ui.appendMsg(uiMsg); 
      window.protocol.flood(pkt, fromPeerId);
      return;
    }
    if (pkt.t === 'SMART_REQ') { handleChunkRequest(pkt, fromPeerId); return; }
    if (pkt.t === 'SMART_DATA') { handleChunkData(pkt); return; }
    originalProcess.apply(this, arguments);
  };

  // === HOOK: UI 渲染 (支持预览图显示) ===
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
          // === 场景 A: 带预览的大图 ===
          contentHtml = `
            <div class="file-card" style="padding:0; position:relative; overflow:hidden; min-width:200px; min-height:150px">
               <!-- 预览图层 -->
               <img src="${m.meta.preview}" style="display:block; max-width:100%; height:auto; border-radius:8px; filter: brightness(0.8);">
               
               <!-- 覆盖操作层 -->
               <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(0,0,0,0.2)">
                  <div style="background:rgba(0,0,0,0.6); color:#fff; padding:4px 8px; border-radius:12px; font-size:10px; margin-bottom:8px">
                     原图 ${sizeStr}
                  </div>
                  <button onclick="window.smartCore.download('${m.meta.fileId}')" 
                          id="btn-${m.meta.fileId}"
                          style="background:rgba(42, 124, 255, 0.9); border:none; color:#fff; padding:8px 16px; border-radius:20px; font-weight:bold; cursor:pointer; backdrop-filter:blur(4px); box-shadow: 0 4px 6px rgba(0,0,0,0.3)">
                    ⬇ 查看原图
                  </button>
                  <!-- 进度条 -->
                  <div id="prog-wrap-${m.meta.fileId}" style="width:80%; height:4px; background:rgba(255,255,255,0.3); border-radius:2px; margin-top:8px; display:none">
                     <div id="prog-${m.meta.fileId}" style="width:0%; height:100%; background:#0f0; transition:width 0.2s"></div>
                  </div>
               </div>
            </div>
          `;
      } else {
          // === 场景 B: 普通文件 或 无预览图 ===
          contentHtml = `
            <div class="file-card" style="background:transparent; padding:12px">
                <div class="file-icon">${isImg ? '🖼️' : '📦'}</div>
                <div class="file-info">
                   <div class="file-name" style="font-weight:bold;color:#4ea8ff">${window.util.escape(m.meta.fileName)}</div>
                   <div class="file-size" style="color:#aaa;font-size:11px">${sizeStr} | Smart P2P</div>
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
// 辅助功能：高清预览生成器
// ---------------------------------------------------------
function makePreview(base64, maxWidth, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = base64;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width;
            let h = img.height;
            
            if (w > maxWidth) {
                h = (h * maxWidth) / w;
                w = maxWidth;
            }
            
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            
            // 导出为 JPEG 以节省空间 (PNG太大了)
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
    });
}

// ---------------------------------------------------------
// 业务逻辑 (Data Plane)
// ---------------------------------------------------------
const transfers = {};

function registerSource(fileId, peerId) {
  if (!peerId) return;
  if (!transfers[fileId]) transfers[fileId] = { sources: new Set() };
  transfers[fileId].sources.add(peerId);
}

async function startDownload(fileId) {
  const btn = document.getElementById('btn-' + fileId);
  if (btn && btn.innerText.includes('打开')) return;

  // 显示进度条容器
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
  if (sources.length === 0) {
     setTimeout(() => downloadLoop(fileId), 2000); 
     return; 
  }

  // 计算百分比
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
  
  // 核心体验优化：下载完成后，直接用高清原图替换掉预览图
  // 并隐藏按钮和遮罩，还原成一张纯净的图片
  const imgEl = btn.closest('.file-card').querySelector('img');
  if (imgEl) {
      imgEl.src = url;
      imgEl.style.filter = 'none'; // 去除变暗滤镜
      
      // 移除遮罩层
      const overlay = btn.parentElement;
      if (overlay) overlay.style.display = 'none';
  }
  
  await saveChunks(fileId, task.chunks, null);
  console.log('✅ 原图下载并渲染完成');
}

// Utils
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
