
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v9 - Debug & Relay
 * 
 * 1. 内置全屏图片查看器 (Lightbox)，彻底解决 window.open 打不开问题。
 * 2. 混合传输策略：直连失败时，自动通过 Hub 中转数据 (Relay)。
 * 3. 详细的 UI 日志，显示传输进度和错误原因。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v9 (Debug-Relay)');
  
  const req = indexedDB.open('P1_FILE_DB', 1);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'fileId' });
  };
  req.onsuccess = e => {
    window.smartDB = e.target.result;
    applyHooks();
    injectLightbox(); // 注入看图组件
  };

  window.smartCore = {
    download: (fileId) => startDownload(fileId),
    openLocal: (fileId) => openFileViewer(fileId), // 改用内部查看器
    closeLightbox: () => document.getElementById('lightbox').style.display = 'none'
  };
}

// 注入全屏看图组件
function injectLightbox() {
    if (document.getElementById('lightbox')) return;
    const div = document.createElement('div');
    div.id = 'lightbox';
    div.style.cssText = 'display:none;position:fixed;inset:0;background:#000;z-index:9999;flex-direction:column;align-items:center;justify-content:center;';
    div.innerHTML = `
      <div style="position:absolute;top:10px;right:10px;z-index:10000">
        <button onclick="window.smartCore.closeLightbox()" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:10px 15px;border-radius:20px;font-size:16px">✕ 关闭</button>
      </div>
      <img id="lb-img" style="max-width:100%;max-height:100%;object-fit:contain">
      <div id="lb-msg" style="color:#fff;margin-top:10px;display:none"></div>
    `;
    document.body.appendChild(div);
}

// 打开查看器
async function openFileViewer(fileId) {
    const url = await assembleFile(fileId);
    if (!url) { alert('文件尚未就绪'); return; }
    
    // 识别类型
    const meta = await getMeta(fileId);
    if (meta && meta.fileType.startsWith('image')) {
        const lb = document.getElementById('lightbox');
        const img = document.getElementById('lb-img');
        img.src = url;
        lb.style.display = 'flex';
    } else {
        // 文件类型，尝试调用原生下载
        const a = document.createElement('a');
        a.href = url;
        a.download = meta ? meta.fileName : 'download';
        a.click();
    }
}

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // === HOOK 1: 智能路由 (支持定向中继) ===
  window.protocol.flood = function(pkt, excludePeerId) {
    // 关键修正：如果包里指定了 targetId (单播中继)，则只发给那个人
    if (pkt.targetId) {
        const conn = window.state.conns[pkt.targetId];
        if (conn && conn.open) {
            conn.send(pkt);
        } else {
            // 我连不上目标，但我可以发给 Hub 帮忙转
            if (!pkt.relayed) { // 防止死循环
                pkt.relayed = true;
                const hubs = Object.values(window.state.conns).filter(c => c.open && c.peer.startsWith(window.config.hub.prefix));
                if (hubs.length > 0) hubs[0].send(pkt); // 随便找个 Hub
            }
        }
        return;
    }

    // 广播逻辑 (仅 Meta)
    if (pkt.t === 'SMART_DATA' || pkt.t === 'SMART_REQ') return; // 数据包禁止广播，必须单播

    let all = Object.values(window.state.conns).filter(c => c.open && c.peer !== excludePeerId);
    if (all.length <= 12) { all.forEach(c => c.send(pkt)); return; }
    
    const targets = [];
    all.filter(c => c.peer.startsWith(window.config.hub.prefix)).forEach(c => targets.push(c));
    const normals = all.filter(c => !c.peer.startsWith(window.config.hub.prefix));
    if (normals.length > 0) targets.push(normals[Math.floor(Math.random() * normals.length)]);
    
    if (typeof pkt.ttl === 'number') { if (pkt.ttl <= 0) return; pkt.ttl--; }
    targets.forEach(c => c.send(pkt));
  };

  // === HOOK 2: 发送逻辑 ===
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    if (!window.state.isUserAction && !fileInfo) { originalSendMsg.apply(this, arguments); return; }
    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) { originalSendMsg.apply(this, arguments); return; }

    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      window.util.log('📤 开始处理文件...');
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
      // 本地渲染
      const uiMsg = { id: metaMsg.id, senderId: metaMsg.senderId, n: metaMsg.n, ts: metaMsg.ts, kind: 'SMART_FILE_UI', meta: metaMsg };
      window.ui.appendMsg(uiMsg);
      
      window.protocol.flood(metaMsg); 
      window.util.log('✅ 文件元数据已广播');
      return;
    }
    originalSendMsg.apply(this, arguments);
  };

  // === HOOK 3: 接收逻辑 ===
  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
    // 中继处理：如果我是 Hub，且包的目标不是我，我帮忙转发
    if (window.state.isHub && pkt.targetId && pkt.targetId !== window.state.myId) {
        // console.log('🔄 Hub Relay:', pkt.t, '->', pkt.targetId);
        const target = window.state.conns[pkt.targetId];
        if (target && target.open) target.send(pkt);
        return; // 我只负责转，不负责吃
    }

    if (pkt.senderId === window.state.myId && pkt.t === 'SMART_META') return;
    
    if (pkt.t === 'SMART_META') {
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

  // === HOOK 4: UI 渲染 ===
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      const isImg = m.meta.fileType.startsWith('image');
      
      let inner = '';
      
      // 无论是谁发的，只要本地有缓存，就显示“已就绪”状态
      // 这里先默认显示下载/发送状态，由点击逻辑判断
      if (isImg && m.meta.preview) {
          inner = `
           <div class="smart-card" id="card-${m.meta.fileId}" style="cursor:pointer" onclick="window.smartCore.${isMe ? 'openLocal' : 'download'}('${m.meta.fileId}')">
             <img src="${m.meta.preview}" style="display:block;max-width:100%;max-height:200px;object-fit:contain;border-radius:8px;${isMe ? '' : 'filter:brightness(0.7)'}">
             ${isMe ? '' : `
             <div class="overlay" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
                <div class="dl-icon" style="background:rgba(0,0,0,0.5);border:2px solid #fff;border-radius:50%;width:40px;height:40px;display:grid;place-items:center;color:#fff;font-size:20px">⬇</div>
                <div style="color:#fff;font-size:10px;margin-top:4px;text-shadow:0 1px 2px #000">${sizeStr}</div>
             </div>`}
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
               <button onclick="window.smartCore.${isMe ? 'openLocal' : 'download'}('${m.meta.fileId}')" id="btn-${m.meta.fileId}"
                  style="background:${isMe?'transparent':'#2a7cff'};border:${isMe?'1px solid #555':'none'};color:${isMe?'#ddd':'#fff'};padding:5px 10px;border-radius:4px;cursor:pointer">
                  ${isMe ? '📂 打开' : '⚡ 下载'}
               </button>
             </div>
             <div id="prog-wrap-${m.meta.fileId}" style="margin-top:6px;height:3px;background:#333;display:none">
                <div id="prog-${m.meta.fileId}" style="height:100%;width:0%;background:#0f0;transition:width 0.2s"></div>
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

// ---------------------------------------------------------
// 业务逻辑
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
  const progWrap = document.getElementById('prog-wrap-' + fileId);

  // 1. 检查本地
  const url = await assembleFile(fileId);
  if (url) {
      window.util.log('✅ 本地缓存命中，直接打开');
      finishDownload(fileId, url);
      window.smartCore.openLocal(fileId);
      return;
  }

  window.util.log('🚀 开始下载任务...');
  const meta = await getMeta(fileId);
  if (!meta) { alert('元数据丢失'); return; }

  // UI 更新
  if (progWrap) progWrap.style.display = 'block';
  if (btn) btn.innerText = '📡 寻址中...';
  
  if (!transfers[fileId]) transfers[fileId] = { meta: meta, chunks: new Array(meta.totalChunks).fill(null), needed: meta.totalChunks, lastActive: Date.now() };
  
  // 启动下载循环
  downloadLoop(fileId);
}

function downloadLoop(fileId) {
  const task = transfers[fileId];
  if (!task || task.needed <= 0) return;
  
  // 超时检查
  if (Date.now() - task.lastActive > 10000) {
      window.util.log('⚠️ 下载停滞，尝试重连发送者...');
      task.lastActive = Date.now();
      if (window.p2p) window.p2p.connectTo(task.meta.senderId);
  }

  // 策略：直连 Sender
  const senderId = task.meta.senderId;
  const conn = window.state.conns[senderId];
  let target = null;
  
  if (conn && conn.open) {
      target = conn;
  } else {
      // 备选策略：中继模式 (通过 Hub)
      // window.util.log('直连不可用，尝试 Hub 中继...');
      const hubs = Object.values(window.state.conns).filter(c => c.open && c.peer.startsWith(window.config.hub.prefix));
      if (hubs.length > 0) target = hubs[0];
  }

  if (!target) {
      const btn = document.getElementById('btn-' + fileId);
      if(btn) btn.innerText = '❌ 无可用线路';
      // 持续重试，也许 Sender 一会就上线了
      setTimeout(() => downloadLoop(fileId), 2000); 
      return; 
  }

  // 更新进度条
  const pct = Math.floor(((task.chunks.length - task.needed) / task.chunks.length) * 100);
  const bar = document.getElementById('prog-' + fileId);
  const btn = document.getElementById('btn-' + fileId);
  if(bar) bar.style.width = pct + '%';
  if(btn) btn.innerText = `${pct}%`;

  // 发送请求 (带上 targetId 以便中继)
  let reqCount = 0;
  for (let i = 0; i < task.chunks.length; i++) {
    if (!task.chunks[i] && reqCount < 8) { 
       target.send({ 
           t: 'SMART_REQ', 
           fileId: fileId, 
           chunkIdx: i,
           targetId: senderId // 告诉 Hub 我想找谁
       });
       reqCount++;
    }
  }
  
  setTimeout(() => downloadLoop(fileId), 300);
}

async function handleChunkRequest(pkt, fromPeerId) {
  // 如果我是 Sender，我回复数据
  const chunk = await getChunk(pkt.fileId, pkt.chunkIdx);
  if (chunk) {
      // 回包也需要指定 targetId (发给请求者)
      const resp = { 
          t: 'SMART_DATA', 
          fileId: pkt.fileId, 
          chunkIdx: pkt.chunkIdx, 
          data: chunk.data,
          targetId: fromPeerId 
      };
      
      // 优先直连回复
      if (window.state.conns[fromPeerId] && window.state.conns[fromPeerId].open) {
          window.state.conns[fromPeerId].send(resp);
      } else {
          // 否则走中继
          const hubs = Object.values(window.state.conns).filter(c => c.open && c.peer.startsWith(window.config.hub.prefix));
          if (hubs.length > 0) hubs[0].send(resp);
      }
  }
}

function handleChunkData(pkt) {
  const task = transfers[pkt.fileId];
  if (!task || task.chunks[pkt.chunkIdx]) return;
  task.chunks[pkt.chunkIdx] = pkt.data;
  task.needed--;
  task.lastActive = Date.now();
  
  if (task.needed === 0) {
      const blob = new Blob(task.chunks, { type: task.meta.fileType });
      const url = URL.createObjectURL(blob);
      finishDownload(fileId, url);
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
      // 点击打开看图器
      card.onclick = () => window.smartCore.openLocal(fileId);
  } 
  else if (btn) {
      btn.innerText = '📂 打开';
      btn.style.background = '#22c55e';
      btn.onclick = () => window.smartCore.openLocal(fileId);
  }
  if (prog) prog.style.display = 'none';
  window.util.log('✅ 下载完成');
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
