
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v22 - Blast Protocol (Final Fix)
 * 1. 采用“喷射模式”(Blast)：无握手、无切片请求，直接推送流。
 * 2. 自动循环广播：直到收到第一个字节才停止喊话。
 * 3. 单源锁定：防止多个人同时推流导致错乱。
 * 4. 持久化做种：下载完后自动存库，成为新种子。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v22 (Blast Protocol)');
  
  // 持久化存储，用于做种
  const req = indexedDB.open('P1_FILE_DB', 1);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
  };
  req.onsuccess = e => {
    window.smartDB = e.target.result;
    // 上线广播：告诉大家我有啥
    setTimeout(broadcastInventory, 3000);
    applyHooks();
  };

  window.smartCore = {
    download: (fileId) => startRequest(fileId),
    openLocal: (fileId) => openFileViewer(fileId),
    cancel: (fileId) => cancelTask(fileId)
  };
}

// 内存缓存 (Session级)
const memoryStore = {}; 

// 广播我有的文件
function broadcastInventory() {
    if(!window.smartDB) return;
    const tx = window.smartDB.transaction(['files'], 'readonly');
    tx.objectStore('files').getAllKeys().onsuccess = (e) => {
        const ids = e.target.result;
        if(ids && ids.length) {
            window.util.log(`📢 正在做种 ${ids.length} 个文件`);
            // 这里不广播具体ID以免包太大，仅作为日志
            // 实际逻辑是：别人问我要的时候，我查库，有就给
        }
    };
}

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // 1. 发送拦截
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txt, kind, fileInfo) {
    if (!window.state.isUserAction && !fileInfo) { originalSendMsg.apply(this, arguments); return; }
    if (kind === CHAT.KIND_IMAGE && txt.length < 400000) { originalSendMsg.apply(this, arguments); return; }

    if ((kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) && txt.length > 1024) {
      const fileId = window.util.uuid();
      const rawData = base64ToArrayBuffer(txt);
      const blob = new Blob([rawData], {type: fileInfo ? fileInfo.type : 'application/octet-stream'});
      
      // 存入内存 & 数据库，立即成为种子
      memoryStore[fileId] = blob;
      saveFileToDB(fileId, blob, null);
      
      const meta = {
        t: 'SMART_META',
        id: window.util.uuid(),
        fileId: fileId,
        fileName: fileInfo ? fileInfo.name : `File_${Date.now()}`,
        fileType: blob.type,
        fileSize: blob.size,
        ts: window.util.now(),
        senderId: window.state.myId,
        n: window.state.myName
      };

      if (kind === CHAT.KIND_IMAGE) {
          try { meta.preview = await makePreview(txt, 600, 0.6); } catch(e) {}
      }

      window.ui.appendMsg({ ...meta, kind: 'SMART_FILE_UI', meta: meta, isProcessing: false });
      window.protocol.flood(meta);
      
      // 自动上屏状态更新
      setTimeout(() => {
          const t = document.getElementById('prog-text-' + fileId);
          if(t) t.innerText = '✅ 发送完成 (做种中)';
      }, 500);
      
      return;
    }
    originalSendMsg.apply(this, arguments);
  };

  // 2. 接收拦截
  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
    if (pkt.senderId === window.state.myId) return;

    if (pkt.t === 'SMART_META') {
      window.ui.appendMsg({ ...pkt, kind: 'SMART_FILE_UI', meta: pkt });
      return;
    }
    
    // 收到求种请求
    if (pkt.t === 'SMART_ASK_BLAST') {
        handleBlastRequest(pkt, fromPeerId);
        // 帮忙转发，让更多人看到
        window.protocol.flood(pkt, fromPeerId);
        return;
    }
    
    // 收到数据流
    if (pkt.t === 'SMART_BLAST_DATA') {
        handleBlastData(pkt, fromPeerId);
        return;
    }

    originalProcess.apply(this, arguments);
  };

  // 3. UI 渲染
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      if (!box || document.getElementById('msg-' + m.id)) return;
      
      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      
      let inner = '';
      const commonStyle = 'min-width:200px;padding:10px;position:relative;overflow:hidden';
      
      if (m.meta.fileType.startsWith('image/') && m.meta.preview) {
           inner = `<img src="${m.meta.preview}" style="max-width:200px;max-height:200px;border-radius:4px;display:block">`;
      } else {
           inner = `
           <div style="font-weight:bold;color:#4ea8ff">📄 ${window.util.escape(m.meta.fileName)}</div>
           <div style="font-size:11px;color:#aaa">${sizeStr}</div>`;
      }
      
      inner += `
      <div style="margin-top:8px;display:flex;justify-content:flex-end;align-items:center;gap:10px">
         <span id="prog-text-${m.meta.fileId}" style="font-size:10px;color:#888"></span>
         ${isMe ? 
           `<button onclick="window.smartCore.openLocal('${m.meta.fileId}')" style="background:transparent;border:1px solid #555;color:#ddd;padding:4px 8px;border-radius:4px">📂 打开</button>` 
           : 
           `<button id="btn-${m.meta.fileId}" onclick="window.smartCore.download('${m.meta.fileId}')" style="background:#2a7cff;border:none;color:#fff;padding:6px 12px;border-radius:4px;cursor:pointer">⚡ 极速下载</button>`
         }
      </div>
      <div id="prog-bar-${m.meta.fileId}" style="position:absolute;bottom:0;left:0;height:3px;width:0%;background:#0f0;transition:width 0.1s"></div>
      `;

      const html = `
        <div class="msg-row ${isMe ? 'me' : 'other'}" id="msg-${m.id}">
          <div>
            <div class="msg-bubble" style="padding:0;background:#2b2f3a;border:1px solid #444;color:#fff;overflow:hidden">
              <div style="${commonStyle}">${inner}</div>
            </div>
            <div class="msg-meta">${isMe ? '我' : window.util.escape(m.n)}</div>
          </div>
        </div>`;
      box.insertAdjacentHTML('beforeend', html);
      box.scrollTop = box.scrollHeight;
      return;
    }
    originalAppend.apply(this, arguments);
  };
}

// =================================================
// 核心逻辑：Blast Protocol (暴力推送)
// =================================================

const tasks = {}; // 接收任务

// 1. 发起请求 (A端)
async function startRequest(fileId) {
    // 检查本地
    if (memoryStore[fileId] || await getFileFromDB(fileId)) {
        openFileViewer(fileId);
        return;
    }
    
    if (tasks[fileId]) {
        // 如果已经在跑，就取消
        cancelTask(fileId);
        return;
    }

    updateUI(fileId, 0, '📡 呼叫资源...', true); // true = show cancel
    
    tasks[fileId] = {
        chunks: [],
        receivedSize: 0,
        startTime: Date.now(),
        fileId: fileId,
        sourcePeer: null // 锁定源
    };

    // 第一次呼叫
    sendAsk(fileId);
    
    // 循环呼叫 (直到开始接收)
    const loop = setInterval(() => {
        const t = tasks[fileId];
        if (!t) { clearInterval(loop); return; }
        if (t.receivedSize > 0) { 
            // 已经开始了，停止呼叫，但可以更新下 UI
            clearInterval(loop); 
            return; 
        }
        window.util.log('📡 无人响应，再次呼叫...');
        sendAsk(fileId);
    }, 2000);
}

function sendAsk(fileId) {
    window.protocol.flood({
        t: 'SMART_ASK_BLAST',
        fileId: fileId,
        requester: window.state.myId
    });
}

// 2. 收到请求 (B端/C端...)
async function handleBlastRequest(pkt, fromPeerId) {
    // 我有文件吗？
    let blob = memoryStore[pkt.fileId] || await getFileFromDB(pkt.fileId);
    if (!blob) return; // 我没有，闭嘴

    // 我有！找到连接推给他
    const targetId = pkt.requester;
    let conn = window.state.conns[targetId];
    
    if (!conn || !conn.open) {
        // 没连上？主动连他！
        window.util.log(`➕ 收到求种，主动连接 -> ${targetId.slice(0,5)}`);
        if (window.p2p) window.p2p.connectTo(targetId);
        // 连上后 PeerJS 会自动握手，但我们需要在 open 后触发推流
        // 简单处理：等下次他再喊的时候（2秒后），如果连上了就能推了
        return;
    }

    // 已经在连接中，直接喷射！
    window.util.log(`🚀 正在向 ${targetId.slice(0,5)} 喷射数据...`);
    startBlasting(conn, pkt.fileId, blob);
}

// 3. 喷射数据 (Sender)
async function startBlasting(conn, fileId, blob) {
    const CHUNK_SIZE = 16 * 1024; 
    const totalSize = blob.size;
    const buffer = await blob.arrayBuffer();
    let offset = 0;
    
    // 发送头部
    conn.send({
        t: 'SMART_BLAST_DATA',
        fileId: fileId,
        type: 'START',
        size: totalSize,
        mime: blob.type
    });

    const loop = setInterval(() => {
        if (!conn.open) { clearInterval(loop); return; }
        
        // 流控：防止把浏览器发挂了
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > 2 * 1024 * 1024) return;

        const end = Math.min(offset + CHUNK_SIZE, totalSize);
        const chunk = buffer.slice(offset, end);
        
        conn.send({
            t: 'SMART_BLAST_DATA',
            fileId: fileId,
            type: 'DATA',
            data: chunk
        });
        
        offset = end;
        
        if (offset >= totalSize) {
            clearInterval(loop);
            conn.send({ t: 'SMART_BLAST_DATA', fileId: fileId, type: 'END' });
            window.util.log('✅ 发送完毕');
        }
    }, 5); 
}

// 4. 接收数据 (Receiver)
function handleBlastData(pkt, fromPeerId) {
    let task = tasks[pkt.fileId];
    
    if (pkt.type === 'START') {
        if (!task) return; // 没点下载，别人硬推？忽略，或者自动接收？为了安全先忽略
        if (task.sourcePeer && task.sourcePeer !== fromPeerId) return; // 已经锁定了别人，忽略这个插队的
        
        task.sourcePeer = fromPeerId; // 锁定这个源
        task.totalSize = pkt.size;
        task.mime = pkt.mime;
        updateUI(pkt.fileId, 0, '🚀 正在接收流...');
        return;
    }
    
    if (!task) return;
    if (task.sourcePeer && task.sourcePeer !== fromPeerId) return; // 忽略干扰源

    if (pkt.type === 'DATA') {
        task.chunks.push(pkt.data);
        task.receivedSize += pkt.data.byteLength;
        
        // 节流更新UI
        if (Math.random() < 0.05) {
            const pct = Math.floor((task.receivedSize / task.totalSize) * 100);
            updateUI(pkt.fileId, pct, `⏬ 极速下载 ${pct}%`);
        }
    }
    
    if (pkt.type === 'END') {
        updateUI(pkt.fileId, 100, '✅ 完成', false);
        
        const blob = new Blob(task.chunks, { type: task.mime });
        memoryStore[pkt.fileId] = blob;
        saveFileToDB(pkt.fileId, blob, null); 
        
        const btn = document.getElementById('btn-' + pkt.fileId);
        if (btn) {
            btn.innerText = ' 打开';
            btn.style.background = '#22c55e';
            btn.onclick = () => openFileViewer(pkt.fileId);
        }
        
        delete tasks[pkt.fileId];
    }
}

function updateUI(fileId, pct, text, showCancel) {
    const bar = document.getElementById('prog-bar-' + fileId);
    const txt = document.getElementById('prog-text-' + fileId);
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.innerText = text;
    
    if (showCancel) {
        const btn = document.getElementById('btn-' + fileId);
        if (btn) {
            btn.innerText = '❌ 取消';
            btn.style.background = '#ff3b30';
            btn.onclick = () => cancelTask(fileId);
        }
    }
}

function cancelTask(fileId) {
    delete tasks[fileId];
    // 恢复按钮
    const btn = document.getElementById('btn-' + fileId);
    if (btn) {
        btn.innerText = '⚡ 极速下载';
        btn.style.background = '#2a7cff';
        // 重置 onclick 比较麻烦，需要重新绑定，最简单的是刷新.. 
        // 这里做一个简单闭包修复
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.onclick = () => startRequest(fileId);
    }
    const txt = document.getElementById('prog-text-' + fileId);
    if(txt) txt.innerText = '已取消';
}

async function openFileViewer(fileId) {
    let blob = memoryStore[fileId] || await getFileFromDB(fileId);
    if (!blob) { alert('文件已过期'); return; }
    
    const url = URL.createObjectURL(blob);
    if (blob.type.startsWith('image/')) {
        if(window.ui && window.ui.previewImage) window.ui.previewImage(url);
        else window.open(url);
    } else if (blob.type.startsWith('video/')) {
        // 视频播放窗口
        const win = window.open('', '_blank');
        win.document.write(`<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><video src="${url}" controls autoplay style="max-width:100%;max-height:100%"></video></body>`);
    } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = `file_${Date.now()}`;
        a.click();
    }
}

function saveFileToDB(id, blob, meta) {
    if(!window.smartDB) return;
    const tx = window.smartDB.transaction(['files'], 'readwrite');
    tx.objectStore('files').put({ id: id, blob: blob, meta: meta, ts: Date.now() });
}
async function getFileFromDB(id) {
    if(!window.smartDB) return null;
    return new Promise(r => {
        const req = window.smartDB.transaction(['files']).objectStore('files').get(id);
        req.onsuccess = () => r(req.result ? req.result.blob : null);
        req.onerror = () => r(null);
    });
}

function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64.split(',')[1] || base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); }
  return bytes.buffer;
}
function makePreview(base64, w, q) {
    return new Promise((r, j) => {
        const img = new Image(); img.src = base64;
        img.onload = () => {
            const cvs = document.createElement('canvas');
            let w=img.width, h=img.height;
            if(w>w){h=(h*w)/w;w=w;} // simple
            cvs.width=img.width>600?600:img.width; cvs.height=img.height*(cvs.width/img.width);
            cvs.getContext('2d').drawImage(img,0,0,cvs.width,cvs.height);
            r(cvs.toDataURL('image/jpeg', q));
        };
        img.onerror = j;
    });
}
