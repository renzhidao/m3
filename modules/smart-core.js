
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v2 - 智能传输与路由核心 (增强版)
 * 
 * 核心升级：
 * 1. 图片分级策略：小图(<300KB)直发预览，大图走P2P分块。
 * 2. Gossip 智能路由：优先确保房主收到，防止消息孤岛。
 * 3. 进度反馈：下载进度条更丝滑。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v2 (Smart-Image + Priority-Gossip)');
  
  // 1. 初始化文件专用数据库
  const req = indexedDB.open('P1_FILE_DB', 1);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'fileId' });
  };
  req.onsuccess = e => {
    window.smartDB = e.target.result;
    console.log('✅ SmartDB 就绪');
    applyHooks();
  };

  window.smartCore = {
    download: (fileId) => startDownload(fileId)
  };
}

function applyHooks() {
  if (!window.protocol || !window.ui) {
    setTimeout(applyHooks, 500); 
    return;
  }

  // === HOOK 1: 智能 Gossip 路由 (增强：房主优先) ===
  const originalFlood = window.protocol.flood;
  window.protocol.flood = function(pkt, excludePeerId) {
    let all = Object.values(window.state.conns).filter(c => c.open && c.peer !== excludePeerId);
    
    // 如果邻居少于 12 个，全发（没必要优化）
    if (all.length <= 12) {
        all.forEach(conn => conn.send(pkt));
        return;
    }

    // 邻居太多，开始筛选
    const targets = [];
    const hubs = [];
    const normals = [];

    // 分类：房主 vs 普通人
    all.forEach(c => {
        if (c.peer.startsWith(window.config.hub.prefix)) hubs.push(c);
        else normals.push(c);
    });

    // 策略：所有房主必发 (保证跨网传播)
    targets.push(...hubs);

    // 策略：剩下的名额给普通人 (随机抽签)
    const needed = 10 - targets.length;
    if (needed > 0 && normals.length > 0) {
        // 洗牌算法
        for (let i = normals.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [normals[i], normals[j]] = [normals[j], normals[i]];
        }
        targets.push(...normals.slice(0, needed));
    }

    // TTL 递减
    if (typeof pkt.ttl === 'number') {
      if (pkt.ttl <= 0) return;
      pkt.ttl--;
    }

    targets.forEach(conn => conn.send(pkt));
  };

  // === HOOK 2: 拦截发送 (增强：图片分级) ===
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    // 策略：图片且体积 < 300KB (Base64 长度约 400,000)，直接走老路，不拦截！
    // 这样截图、表情包依然秒发秒看
    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) {
        // console.log('🚀 小图直发，无需分块');
        originalSendMsg.apply(this, arguments);
        return;
    }

    // 只有大图 或 文件 才走 Smart Transfer
    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      window.util.log('🚀 启动高速通道传输大文件...');
      
      const fileId = window.util.uuid();
      const rawData = base64ToArrayBuffer(txt);
      const chunks = sliceData(rawData, 16 * 1024); // 16KB 切片
      
      await saveChunks(fileId, chunks, fileInfo);
      
      const metaMsg = {
        t: 'SMART_META',
        id: window.util.uuid(),
        fileId: fileId,
        fileName: fileInfo ? fileInfo.name : `HD_Image_${Date.now()}.png`,
        fileType: fileInfo ? fileInfo.type : 'image/png',
        fileSize: rawData.byteLength,
        totalChunks: chunks.length,
        ts: window.util.now(),
        senderId: window.state.myId,
        n: window.state.myName,
        ttl: 16
      };
      
      window.db.addPending(metaMsg);
      window.protocol.processIncoming(metaMsg);
      window.protocol.flood(metaMsg); 
      return;
    }
    
    originalSendMsg.apply(this, arguments);
  };

  // === HOOK 3: 拦截接收 ===
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

  // === HOOK 4: UI 渲染 (增强：美化) ===
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      const isImg = m.meta.fileType.startsWith('image');
      
      const html = `
        <div class="msg-row ${isMe ? 'me' : 'other'}" id="msg-${m.id}">
          <div>
            <div class="msg-bubble" style="background:#2b2f3a; border:1px solid #444; color:#fff; padding:0; overflow:hidden">
              <div class="file-card" style="background:transparent; padding:12px">
                <div class="file-icon">${isImg ? '🖼️' : '📦'}</div>
                <div class="file-info">
                   <div class="file-name" style="font-weight:bold;color:#4ea8ff">${window.util.escape(m.meta.fileName)}</div>
                   <div class="file-size" style="color:#aaa;font-size:11px">${sizeStr} | P2P 高速传输</div>
                   <div class="progress-wrap" style="background:#111;height:4px;border-radius:2px;margin-top:8px;overflow:hidden">
                     <div id="prog-${m.meta.fileId}" style="width:0%;height:100%;background:#22c55e;transition:width 0.2s"></div>
                   </div>
                </div>
              </div>
              <div style="background:rgba(0,0,0,0.3); padding:8px 12px; display:flex; justify-content:flex-end">
                <button onclick="window.smartCore.download('${m.meta.fileId}')" 
                        id="btn-${m.meta.fileId}"
                        style="background:#2a7cff;border:none;color:#fff;padding:6px 14px;border-radius:4px;font-size:12px;font-weight:600">
                  ${isMe ? '已发送' : '⚡ 下载原文件'}
                </button>
              </div>
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

  console.log('✅ Smart Core v2 钩子已挂载');
}

// ---------------------------------------------------------
// 业务逻辑 (与之前相同，略微优化下载逻辑)
// ---------------------------------------------------------
const transfers = {};

function registerSource(fileId, peerId) {
  if (!peerId) return;
  if (!transfers[fileId]) transfers[fileId] = { sources: new Set() };
  transfers[fileId].sources.add(peerId);
}

async function startDownload(fileId) {
  const btn = document.getElementById('btn-' + fileId);
  if (btn && btn.innerText.includes('打开')) return; // 已经下载过了

  if (btn) btn.innerText = '连接资源...';

  const meta = await getMeta(fileId);
  if (!meta) { alert('元数据丢失'); return; }

  if (!transfers[fileId]) transfers[fileId] = { sources: new Set() };
  transfers[fileId].meta = meta;
  transfers[fileId].chunks = new Array(meta.totalChunks).fill(null);
  transfers[fileId].needed = meta.totalChunks;
  transfers[fileId].startTime = Date.now();
  
  if (window.state.conns[meta.senderId]) transfers[fileId].sources.add(meta.senderId);
  
  if (transfers[fileId].sources.size === 0) {
    window.protocol.flood({ t: 'SMART_REQ', q: 'WHO_HAS', fileId: fileId });
    if(btn) btn.innerText = '全网搜寻...';
    // 3秒后无论如何试一次
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
    const btn = document.getElementById('btn-' + fileId);
    if(btn) btn.innerText = '等待节点...';
    setTimeout(() => downloadLoop(fileId), 2000); // 持续重试
    return;
  }

  const btn = document.getElementById('btn-' + fileId);
  if(btn) btn.innerText = `下载中 ${(task.chunks.length - task.needed)}/${task.chunks.length}`;

  // 并发请求 8 个块
  let reqCount = 0;
  for (let i = 0; i < task.chunks.length; i++) {
    if (!task.chunks[i] && reqCount < 8) { 
       const target = sources[Math.floor(Math.random() * sources.length)];
       window.state.conns[target].send({ t: 'SMART_REQ', fileId: fileId, chunkIdx: i });
       reqCount++;
    }
  }
  
  // 0.5秒后继续下一轮
  setTimeout(() => downloadLoop(fileId), 500);
}

async function handleChunkRequest(pkt, fromPeerId) {
  if (pkt.q === 'WHO_HAS') {
    // 如果我有这个文件的 Meta，我就是潜在源 (虽然不一定有数据，但先回应以建立连接)
    // 简化：这里暂不回应，依靠后续机制
    return;
  }
  const chunk = await getChunk(pkt.fileId, pkt.chunkIdx);
  if (chunk) {
    const conn = window.state.conns[fromPeerId];
    if (conn && conn.open) conn.send({ t: 'SMART_DATA', fileId: pkt.fileId, chunkIdx: pkt.chunkIdx, data: chunk.data });
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
  if (btn) btn.innerText = '合成中...';

  const blob = new Blob(task.chunks, { type: task.meta.fileType });
  const url = URL.createObjectURL(blob);
  
  if (btn) {
    btn.innerText = '📂 打开文件';
    btn.onclick = () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = task.meta.fileName;
      a.click();
    };
    btn.style.background = '#4CAF50';
  }
  
  await saveChunks(fileId, task.chunks, null);
  console.log('✅ 下载完成');
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
  return new Promise((resolve, reject) => {
    const tx = window.smartDB.transaction(['chunks', 'meta'], 'readwrite');
    chunks.forEach((data, idx) => tx.objectStore('chunks').put({ id: `${fileId}_${idx}`, data: data }));
    if (meta) tx.objectStore('meta').put({ fileId: fileId, ...meta });
    tx.oncomplete = resolve;
    tx.onerror = reject;
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
