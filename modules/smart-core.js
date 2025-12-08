
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v30 - Zero-Intrusion Mode
 * 
 * 1. 关键修复：删除 window.protocol.flood 覆盖。使用系统原生路由，确保发现与同步正常。
 * 2. 仅拦截：sendMsg (文件优化) 和 processIncoming (文件流处理)。
 * 3. 效果：系统功能（发现/同步）100% 原生，文件传输 100% 极速。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v30 (Zero-Intrusion)');
  
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

// 内存缓存
const memoryCache = {}; 
const activeStreams = {};

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // ⚠️ 关键：不再覆盖 protocol.flood，保证系统原生广播正常工作！

  // 1. 发送拦截 (仅优化文件)
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    // 非文件消息，直接放行，不做任何处理
    if ((kind !== CHAT.KIND_FILE && kind !== CHAT.KIND_IMAGE) || (!fileInfo && txt.length < 1024)) { 
        originalSendMsg.apply(this, arguments); 
        return; 
    }

    // 文件处理逻辑 (极速直传)
    const fileId = window.util.uuid();
    let blob;
    try {
        const res = await fetch(txt);
        blob = await res.blob();
    } catch(e) {
        // Fallback
        const raw = base64ToArrayBuffer(txt);
        blob = new Blob([raw], {type: fileInfo ? fileInfo.type : 'application/octet-stream'});
    }
    
    memoryCache[fileId] = blob;
    
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
        try { metaMsg.preview = await makePreview(txt, 600, 0.6); } catch(e) {}
    }
    
    // UI 上屏
    const uiMsg = { id: metaMsg.id, senderId: metaMsg.senderId, n: metaMsg.n, ts: metaMsg.ts, kind: 'SMART_FILE_UI', meta: metaMsg };
    window.ui.appendMsg(uiMsg);
    
    // 使用原生广播发送元数据
    window.protocol.flood(metaMsg); 
  };

  // 2. 接收拦截 (仅处理 SMART 包，其他透传)
  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
    // 如果是 SMART 协议包，我们拦截处理
    if (pkt.t && pkt.t.startsWith('SMART_')) {
        handleSmartPacket(pkt, fromPeerId);
        return; // 拦截，不让系统报“未知消息错误”
    }
    
    // ⚠️ 关键：所有非 SMART 包（握手、心跳、同步、聊天）完全透传给原系统
    // 这样就绝对不会影响历史记录和发现功能
    originalProcess.apply(this, arguments);
  };

  // 3. UI 渲染
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      const domId = m.id;
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      const isVideo = m.meta.fileType.startsWith('video');
      
      let inner = '';
      if (m.meta.fileType.startsWith('image') && m.meta.preview) {
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

// 处理 Smart 包
function handleSmartPacket(pkt, fromPeerId) {
    if (pkt.senderId === window.state.myId) return;

    if (pkt.t === 'SMART_META') {
      // 上屏
      const uiMsg = { id: pkt.id, senderId: pkt.senderId, n: pkt.n, ts: pkt.ts, kind: 'SMART_FILE_UI', meta: pkt };
      window.ui.appendMsg(uiMsg); 
      // 继续广播元数据 (让其他人也看到)
      window.protocol.flood(pkt, fromPeerId);
      return;
    }
    
    // 流式请求
    if (pkt.t === 'SMART_WANT_STREAM') { serveStream(pkt, fromPeerId); return; }
    if (pkt.t === 'SMART_STREAM_CHUNK') { handleStreamChunk(pkt); return; }
}

// ---------------------------------------------------------
// 业务逻辑 (直传流)
// ---------------------------------------------------------

async function openFileViewer(fileId) {
    let blob = memoryCache[fileId];
    if (!blob) { alert('文件缓存已过期'); return; }
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
}

async function startDownload(fileId, domId) {
  if (memoryCache[fileId]) { openFileViewer(fileId); return; }

  const progWrap = document.getElementById('prog-wrap-' + domId);
  if (progWrap) progWrap.style.display = 'block';
  
  const btn = document.getElementById('btn-' + domId);
  if (btn) {
      btn.innerText = '⏳ 连接...';
      btn.onclick = () => { delete activeStreams[fileId]; btn.innerText = '已取消'; };
  }
  
  const txt = document.getElementById('st-' + domId);
  if (txt) txt.innerText = '呼叫资源...';

  activeStreams[fileId] = { chunks: [], received: 0, domId: domId };
  
  window.util.log('🚀 发起直传请求...');
  
  // 广播请求
  window.protocol.flood({ 
      t: 'SMART_WANT_STREAM', 
      fileId: fileId, 
      requester: window.state.myId 
  });
}

async function serveStream(pkt, fromPeerId) {
    const blob = memoryCache[pkt.fileId];
    if (!blob) return; 
    
    // 使用系统已有的连接
    const conn = window.state.conns[pkt.requester] || window.state.conns[fromPeerId];
    if (!conn || !conn.open) return; // 不干预连接，通了才发
    
    window.util.log(`📤 直传 -> ${conn.peer.slice(0,5)}`);
    
    const buffer = await blob.arrayBuffer();
    const total = buffer.byteLength;
    const CHUNK = 32 * 1024;
    let offset = 0;
    
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
        }
    }, 5);
}

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
        memoryCache[pkt.fileId] = blob;
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
  openFileViewer(fileId);
}

function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64.split(',')[1] || base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); }
  return bytes.buffer;
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
