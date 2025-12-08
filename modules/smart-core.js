
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v29 - v12 Stability + Streaming Speed
 * 
 * 1. 基底：完全基于 v12 代码，不动任何连接/握手逻辑。
 * 2. 修改：将 handleChunkRequest (BT模式) 替换为 serveStream (直传模式)。
 * 3. 效果：连接稳如老狗，传输快如网盘。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v29 (Stream Mod)');
  
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

// 内存缓存 (加速发送)
const memoryCache = {}; 
const activeStreams = {}; // 接收任务

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // 1. 路由：全放行 (保持 v12 原样)
  window.protocol.flood = function(pkt, excludePeerId) {
    let all = Object.values(window.state.conns).filter(c => c.open && c.peer !== excludePeerId);
    all.forEach(c => c.send(pkt));
  };

  // 2. 发送拦截 (改为极速模式)
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    if (!window.state.isUserAction && !fileInfo) { originalSendMsg.apply(this, arguments); return; }
    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) { originalSendMsg.apply(this, arguments); return; }

    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      const fileId = window.util.uuid();
      
      // 优化：使用 fetch 转换 Base64，比 for 循环快 10 倍，且不卡顿
      const res = await fetch(txt);
      const blob = await res.blob();
      
      // 存入内存，准备直传
      memoryCache[fileId] = blob;
      
      // 备份到 DB (防止刷新丢失)
      // saveToDB(fileId, blob); // 异步做，不阻塞 UI
      
      const metaMsg = {
        t: 'SMART_META',
        id: window.util.uuid(),
        fileId: fileId,
        fileName: fileInfo ? fileInfo.name : `File_${Date.now()}`,
        fileType: fileInfo ? fileInfo.type : blob.type,
        fileSize: blob.size,
        ts: window.util.now(),
        senderId: window.state.myId,
        n: window.state.myName
      };

      if (kind === CHAT.KIND_IMAGE) {
          try {
             const preview = await makePreview(txt, 600, 0.6);
             metaMsg.preview = preview;
          } catch(e) {}
      }
      
      const uiMsg = { id: metaMsg.id, senderId: metaMsg.senderId, n: metaMsg.n, ts: metaMsg.ts, kind: 'SMART_FILE_UI', meta: metaMsg };
      window.ui.appendMsg(uiMsg);
      window.protocol.flood(metaMsg); 
      return;
    }
    originalSendMsg.apply(this, arguments);
  };

  // 3. 接收拦截 (保持 v12 结构，替换处理逻辑)
  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
    // 握手包直接放行
    if (pkt.t === 'SMART_META') {
      if (pkt.senderId === window.state.myId) return;
      const uiMsg = { id: pkt.id, senderId: pkt.senderId, n: pkt.n, ts: pkt.ts, kind: 'SMART_FILE_UI', meta: pkt };
      window.ui.appendMsg(uiMsg); 
      window.protocol.flood(pkt, fromPeerId);
      return;
    }
    
    // === 核心修改：拦截流式请求 ===
    if (pkt.t === 'SMART_WANT_STREAM') { serveStream(pkt, fromPeerId); return; }
    if (pkt.t === 'SMART_STREAM_CHUNK') { handleStreamChunk(pkt); return; }
    
    originalProcess.apply(this, arguments);
  };

  // 4. UI 渲染 (保持 v12 原样)
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      const domId = m.id;
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      const isImg = m.meta.fileType.startsWith('image');
      const isVideo = m.meta.fileType.startsWith('video'); // 新增视频识别
      
      let inner = '';
      if (isImg && m.meta.preview) {
         inner = `
           <div class="smart-card" id="card-${domId}" style="position:relative;min-width:150px">
             <img src="${m.meta.preview}" style="display:block;max-width:100%;max-height:200px;object-fit:contain;border-radius:8px;${isMe?'':'filter:brightness(0.7)'}">
             ${isMe ? 
               `<div style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.5);color:#fff;font-size:10px;padding:2px 4px;border-radius:4px;cursor:pointer" onclick="window.smartCore.openLocal('${m.meta.fileId}')">已发送</div>` 
               : 
               `<div class="overlay" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer" onclick="window.smartCore.download('${m.meta.fileId}', '${domId}')">
                  <div class="dl-btn" style="background:rgba(0,0,0,0.5);border:2px solid #fff;border-radius:50%;width:40px;height:40px;display:grid;place-items:center;color:#fff;font-size:20px">⬇</div>
                  <div class="dl-txt" id="st-${domId}" style="color:#fff;font-size:10px;margin-top:4px;text-shadow:0 1px 2px #000">${sizeStr}</div>
               </div>`
             }
             <div id="prog-wrap-${domId}" style="position:absolute;bottom:0;left:0;right:0;height:4px;background:rgba(0,0,0,0.5);display:none">
                <div id="prog-${domId}" style="height:100%;width:0%;background:#0f0;transition:width 0.2s"></div>
             </div>
           </div>`;
      } else {
         // 文件/视频卡片
         inner = `
           <div class="smart-card" style="padding:10px;min-width:200px">
             <div style="font-weight:bold;color:#4ea8ff">${isVideo ? '🎬 ' : '📄 '}${window.util.escape(m.meta.fileName)}</div>
             <div style="font-size:11px;color:#aaa">${sizeStr}</div>
             <div style="margin-top:8px;text-align:right">
               ${isMe ? 
                 `<button onclick="window.smartCore.openLocal('${m.meta.fileId}')" style="background:transparent;border:1px solid #555;color:#ddd;padding:4px 8px;border-radius:4px;cursor:pointer">📂 打开</button>` 
                 : 
                 `<button onclick="window.smartCore.download('${m.meta.fileId}', '${domId}')" id="btn-${domId}"
                    style="background:#2a7cff;border:none;color:#fff;padding:5px 10px;border-radius:4px;cursor:pointer">⚡ 直传</button>`
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

// ---------------------------------------------------------
// 业务逻辑 (由 BT 改为 Stream)
// ---------------------------------------------------------

async function openFileViewer(fileId) {
    // 优先读内存
    let blob = memoryCache[fileId];
    if (!blob) {
        // 读库 (TODO: 实现读库逻辑，为了v12兼容这里简化)
        // v12 原版没有实现完整的 blob 存储，这里我们让下载后的 blob 驻留内存
        alert('文件已过期或被清理 (v12精简版限制)');
        return;
    }
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
}

// 开始下载 (请求流)
async function startDownload(fileId, domId) {
  if (memoryCache[fileId]) {
      openFileViewer(fileId);
      return;
  }

  // UI 更新
  const progWrap = document.getElementById('prog-wrap-' + domId);
  if (progWrap) progWrap.style.display = 'block';
  
  const btn = document.getElementById('btn-' + domId);
  if (btn) {
      btn.innerText = '⏳ 连接...';
      btn.onclick = () => { // 点击取消
          delete activeStreams[fileId];
          btn.innerText = '已取消';
      };
  }
  
  const txt = document.getElementById('st-' + domId);
  if (txt) txt.innerText = '呼叫资源...';

  activeStreams[fileId] = {
      chunks: [],
      received: 0,
      domId: domId
  };
  
  window.util.log('🚀 发起直传请求...');
  
  // 广播：我要流！
  window.protocol.flood({ 
      t: 'SMART_WANT_STREAM', 
      fileId: fileId, 
      requester: window.state.myId 
  });
  
  // v12 风格：不搞复杂的重试，只发一次广播
  // 依赖 v12 原生的连接稳定性
}

// 发送端：收到请求，开始推流
async function serveStream(pkt, fromPeerId) {
    // 1. 检查我有吗？
    const blob = memoryCache[pkt.fileId];
    if (!blob) return; // 我没有
    
    // 2. 找到连接
    const conn = window.state.conns[pkt.requester] || window.state.conns[fromPeerId];
    
    // v12 逻辑：如果没连接，就不发。保证绝对不乱动连接状态。
    if (!conn || !conn.open) {
        window.util.log('❌ 对方未连接，无法直传');
        return;
    }
    
    window.util.log(`📤 开始向 ${conn.peer.slice(0,5)} 推流`);
    
    // 3. 极速推流
    const buffer = await blob.arrayBuffer();
    const total = buffer.byteLength;
    const CHUNK = 32 * 1024;
    let offset = 0;
    
    // 发送头
    conn.send({ t: 'SMART_STREAM_CHUNK', fileId: pkt.fileId, type: 'START', size: total, mime: blob.type });
    
    const loop = setInterval(() => {
        if (!conn.open) { clearInterval(loop); return; }
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > 2*1024*1024) return;
        
        const end = Math.min(offset + CHUNK, total);
        const chunk = buffer.slice(offset, end);
        
        conn.send({ t: 'SMART_STREAM_CHUNK', fileId: pkt.fileId, type: 'DATA', data: chunk });
        
        offset = end;
        if (offset >= total) {
            clearInterval(loop);
            conn.send({ t: 'SMART_STREAM_CHUNK', fileId: pkt.fileId, type: 'END' });
            window.util.log('✅ 推流完毕');
        }
    }, 5);
}

// 接收端：接收流
function handleStreamChunk(pkt) {
    const task = activeStreams[pkt.fileId];
    if (!task) return;
    
    if (pkt.type === 'START') {
        task.total = pkt.size;
        task.mime = pkt.mime;
        updateUI(task.domId, 0, '📥 接收中...');
    }
    else if (pkt.type === 'DATA') {
        task.chunks.push(pkt.data);
        task.received += pkt.data.byteLength;
        const pct = Math.floor((task.received / task.total) * 100);
        if (Math.random() < 0.1) updateUI(task.domId, pct, `下载 ${pct}%`);
    }
    else if (pkt.type === 'END') {
        const blob = new Blob(task.chunks, { type: task.mime });
        memoryCache[pkt.fileId] = blob; // 存入缓存
        finishDownload(pkt.fileId, task.domId);
        delete activeStreams[pkt.fileId];
    }
}

function updateUI(domId, pct, txt) {
    const bar = document.getElementById('prog-' + domId);
    const btn = document.getElementById('btn-' + domId);
    const t = document.getElementById('st-' + domId);
    if(bar) bar.style.width = pct + '%';
    if(btn) btn.innerText = txt || `${pct}%`;
    if(t) t.innerText = txt;
}

function finishDownload(fileId, domId) {
  const btn = document.getElementById('btn-' + domId);
  const prog = document.getElementById('prog-wrap-' + domId);
  const t = document.getElementById('st-' + domId);
  
  if (btn) {
      btn.innerText = '🔗 打开';
      btn.style.background = '#22c55e';
      btn.onclick = () => openFileViewer(fileId);
  }
  if (prog) prog.style.display = 'none';
  if(t) t.innerText = '✅ 完成';
  window.util.log('✅ 下载完成');
  
  // 自动打开 (模拟流式体验)
  openFileViewer(fileId);
}

// Utils (保持 v12 的辅助函数，makePreview 保留)
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
