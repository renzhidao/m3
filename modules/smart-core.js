
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v27 - NetDisk Stream + Swarm Daemon (Restored)
 * 1. 传输层：使用 NetDisk Stream (网盘直流)，秒传秒播，无计算。
 * 2. 逻辑层：恢复 Download Daemon (下载守护)，负责多源发现、自动重试、断线修复。
 * 3. 结果：既有网盘的快，又有 BT 的稳。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v27 (Hybrid Fix)');
  
  const req = indexedDB.open('P1_FILE_DB', 1);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
  };
  req.onsuccess = e => {
    window.smartDB = e.target.result;
    setTimeout(broadcastInventory, 2000); // 恢复：广播做种
    startConnectionGuard(); // 恢复：连接守护
    applyHooks();
  };

  window.smartCore = {
    download: (fileId) => startTask(fileId),
    openLocal: (fileId) => openFileViewer(fileId),
    cancel: (fileId) => cancelTask(fileId)
  };
}

// === 状态管理 (恢复原有逻辑) ===
const memoryStore = {}; 
const swarmMap = {};    // 记录谁有文件 (恢复)
const activeTasks = {}; // 正在进行的任务 (恢复)

// === 1. 守护进程 (恢复：保证连接不死) ===
function startConnectionGuard() {
    setTimeout(() => advertiseSelf(), 1000);
    setInterval(() => {
        const conns = Object.values(window.state.conns).filter(c => c.open);
        if (conns.length === 0) {
            if(window.p2p) window.p2p.patrolHubs();
            advertiseSelf();
        }
    }, 5000);
}

function advertiseSelf() {
    if(window.protocol) window.protocol.flood({ t: 'SMART_HELLO', id: window.state.myId });
}

function broadcastInventory() {
    if(!window.smartDB) return;
    const tx = window.smartDB.transaction(['files'], 'readonly');
    tx.objectStore('files').getAllKeys().onsuccess = (e) => {
        const ids = e.target.result;
        if(ids && ids.length) {
            window.protocol.flood({ t: 'SMART_I_HAVE', list: ids });
        }
    };
}

// === 2. 协议钩子 ===
function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txtOrFile, kind, fileInfo) {
    if (kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) {
        if (txtOrFile.length > 1024) { 
            // 极速发送逻辑 (NetDisk Style)
            const fileId = window.util.uuid();
            const rawData = base64ToArrayBuffer(txtOrFile);
            const blob = new Blob([rawData], {type: fileInfo ? fileInfo.type : 'application/octet-stream'});
            
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
                try { meta.preview = await makePreview(txtOrFile, 600, 0.6); } catch(e) {}
            }

            window.ui.appendMsg({ ...meta, kind: 'SMART_FILE_UI', meta: meta });
            window.protocol.flood(meta);
            
            // 恢复：立即注册自己为源
            registerProvider(fileId, window.state.myId);
            return;
        }
    }
    originalSendMsg.apply(this, arguments);
  };

  const originalProcess = window.protocol.processIncoming;
  window.protocol.processIncoming = function(pkt, fromPeerId) {
    if (pkt.senderId === window.state.myId) return;

    if (pkt.t === 'SMART_META') {
      window.ui.appendMsg({ ...pkt, kind: 'SMART_FILE_UI', meta: pkt });
      registerProvider(pkt.fileId, pkt.senderId); // 恢复：记录源
      return;
    }
    
    // 恢复：资源发现
    if (pkt.t === 'SMART_I_HAVE' && pkt.list) {
        pkt.list.forEach(fid => registerProvider(fid, fromPeerId || pkt.senderId));
        return;
    }

    // 网盘流请求
    if (pkt.t === 'SMART_GET_STREAM') {
        serveStream(pkt, fromPeerId);
        window.protocol.flood(pkt, fromPeerId);
        return;
    }
    
    // 流数据
    if (pkt.t === 'SMART_STREAM_DATA') {
        handleStreamData(pkt, fromPeerId);
        return;
    }

    if (pkt.t === 'SMART_HELLO') {
        if (!window.state.conns[pkt.id] && window.p2p) window.p2p.connectTo(pkt.id);
        return;
    }

    originalProcess.apply(this, arguments);
  };
  
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
        renderCard(m);
        return;
    }
    originalAppend.apply(this, arguments);
  };
}

function registerProvider(fileId, peerId) {
    if (!swarmMap[fileId]) swarmMap[fileId] = new Set();
    swarmMap[fileId].add(peerId);
    
    // 恢复：动态唤醒任务
    const task = activeTasks[fileId];
    if (task && !task.finished && !task.sourcePeer) {
        // 如果当前没源，来了新源，立即重试
        task.forceRetry = true; 
    }
}

// === 3. 核心：带守护进程的网盘流传输 ===

async function startTask(fileId) {
    if (memoryStore[fileId] || await getFileFromDB(fileId)) {
        openFileViewer(fileId);
        return;
    }
    
    if (activeTasks[fileId]) return;

    updateUIStatus(fileId, '🚀 准备连接...', true);

    activeTasks[fileId] = {
        fileId: fileId,
        chunks: [],
        receivedSize: 0,
        totalSize: 0,
        mime: '',
        sourcePeer: null,
        streamStarted: false,
        startTime: Date.now()
    };

    // 恢复：启动后台守护 (Download Daemon)
    // 这是 v25 的逻辑，负责智能调度，而不是像 v26 那样死等
    const task = activeTasks[fileId];
    task.loop = setInterval(() => downloadDaemon(task), 1000);
    downloadDaemon(task); // 立即执行
}

function downloadDaemon(task) {
    if (!activeTasks[task.fileId] || task.finished) { clearInterval(task.loop); return; }

    // 1. 状态检查
    if (task.sourcePeer) {
        const conn = window.state.conns[task.sourcePeer];
        // 如果连接断了，或者很久没收到数据(5秒)，解锁源，重新寻找
        if (!conn || !conn.open || (Date.now() - task.lastPacketTime > 5000)) {
            window.util.log('⚠️ 源连接不稳定，重新搜寻...');
            task.sourcePeer = null; 
        } else {
            return; // 正常传输中
        }
    }

    // 2. 寻找最佳源 (Smart Seek)
    const providers = swarmMap[task.fileId] || new Set();
    const candidates = [];
    providers.forEach(pid => {
        const c = window.state.conns[pid];
        if (c && c.open) candidates.push(pid);
        else {
            // 恢复：尝试连接潜在的源
            if (Math.random() < 0.2 && window.p2p) window.p2p.connectTo(pid);
        }
    });

    updateUIStatus(task.fileId, `📡 寻找资源 (${candidates.length})...`);

    if (candidates.length > 0) {
        // 随机选一个（负载均衡）
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        const conn = window.state.conns[target];
        
        // 发送网盘流请求
        conn.send({ 
            t: 'SMART_GET_STREAM', 
            fileId: task.fileId, 
            requester: window.state.myId,
            offset: task.receivedSize // 恢复：支持断点续传请求
        });
        
        // 标记：如果对方响应了 HEAD，就在 handleStreamData 里锁定
    } else {
        // 全网广播 (Flood)
        window.protocol.flood({ t: 'SMART_GET_STREAM', fileId: task.fileId, requester: window.state.myId });
        advertiseSelf();
    }
}

// 服务端：推流
async function serveStream(pkt, fromPeerId) {
    let blob = memoryStore[pkt.fileId] || await getFileFromDB(pkt.fileId);
    if (!blob) return;

    const targetId = pkt.requester;
    const conn = window.state.conns[targetId];
    if (!conn || !conn.open) {
        if(window.p2p) window.p2p.connectTo(targetId);
        return;
    }

    if (conn.isStreaming === pkt.fileId) return; // 防抖
    conn.isStreaming = pkt.fileId;

    const buffer = await blob.arrayBuffer();
    const totalSize = buffer.byteLength;
    // 恢复：断点续传支持
    let offset = pkt.offset || 0; 
    const CHUNK_SIZE = 32 * 1024;

    conn.send({ t: 'SMART_STREAM_DATA', fileId: pkt.fileId, type: 'HEAD', size: totalSize, mime: blob.type });

    const streamLoop = setInterval(() => {
        if (!conn.open) { clearInterval(streamLoop); conn.isStreaming = null; return; }
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > 2 * 1024 * 1024) return;

        const end = Math.min(offset + CHUNK_SIZE, totalSize);
        const chunk = buffer.slice(offset, end);
        
        conn.send({ t: 'SMART_STREAM_DATA', fileId: pkt.fileId, type: 'BODY', data: chunk, offset: offset });
        
        offset = end;
        if (offset >= totalSize) {
            clearInterval(streamLoop);
            conn.isStreaming = null;
            conn.send({ t: 'SMART_STREAM_DATA', fileId: pkt.fileId, type: 'EOF' });
        }
    }, 5);
}

// 客户端：接收
function handleStreamData(pkt, fromPeerId) {
    const task = activeTasks[pkt.fileId];
    if (!task) return;

    // 锁定源
    if (!task.sourcePeer) task.sourcePeer = fromPeerId;
    if (task.sourcePeer !== fromPeerId) return; 

    task.lastPacketTime = Date.now();

    if (pkt.type === 'HEAD') {
        task.totalSize = pkt.size;
        task.mime = pkt.mime;
        updateUIStatus(pkt.fileId, '📥 高速传输中...', true);
        return;
    }

    if (pkt.type === 'BODY') {
        task.chunks.push(pkt.data);
        task.receivedSize += pkt.data.byteLength;

        const pct = Math.floor((task.receivedSize / task.totalSize) * 100);
        if (Math.random() < 0.1) updateUIStatus(pkt.fileId, `下载中 ${pct}%`, true);
        updateUIProg(pkt.fileId, pct);

        // 恢复：视频秒播
        if (task.mime.startsWith('video/') && !task.streamStarted && task.receivedSize > 2 * 1024 * 1024) {
            task.streamStarted = true;
            tryPreviewVideo(task);
        }
    }

    if (pkt.type === 'EOF') {
        finishTask(task);
    }
}

function finishTask(task) {
    task.finished = true;
    clearInterval(task.loop);
    
    updateUIStatus(task.fileId, '✅ 完成', false);
    updateUIProg(task.fileId, 100);
    
    const blob = new Blob(task.chunks, { type: task.mime });
    memoryStore[task.fileId] = blob;
    saveFileToDB(task.fileId, blob, null);
    
    // 恢复：视频完整播放逻辑
    if (task.mime.startsWith('video/')) {
        const v = document.getElementById('v-' + task.fileId);
        if(v) {
            const t = v.currentTime;
            v.src = URL.createObjectURL(blob);
            v.currentTime = t;
            v.play().catch(()=>{});
        }
    } else {
        const btn = document.getElementById('btn-' + task.fileId);
        if(btn) {
            btn.innerText = '打开';
            btn.style.background = '#22c55e';
            btn.onclick = () => openFileViewer(task.fileId);
        }
    }
    
    delete activeTasks[task.fileId];
}

function cancelTask(fileId) {
    const task = activeTasks[fileId];
    if (task) {
        clearInterval(task.loop);
        delete activeTasks[fileId];
        updateUIStatus(fileId, '已取消', false);
        
        const btn = document.getElementById('btn-' + fileId);
        if(btn) {
            btn.innerText = '重试';
            btn.style.background = '#2a7cff';
            // clone to strip listener
            const n = btn.cloneNode(true);
            btn.parentNode.replaceChild(n, btn);
            n.onclick = () => startTask(fileId);
        }
    }
}

// === UI 渲染 (保持无损) ===
function renderCard(m) {
    const box = document.getElementById('msgList');
    if (!box || document.getElementById('msg-' + m.id)) return;
    
    const isMe = m.senderId === window.state.myId;
    const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
    const isVideo = m.meta.fileType.startsWith('video');
    const fid = m.meta.fileId;
    
    let inner = '';
    const style = `background:#252525;border-radius:8px;overflow:hidden;min-width:240px;border:1px solid #333;`;
    
    if (isVideo) {
        inner = `
        <div style="${style}">
            <div style="height:160px;background:#000;display:flex;align-items:center;justify-content:center;position:relative">
                <div style="font-size:40px">🎬</div>
                ${!isMe ? `<div id="mask-${fid}" onclick="window.smartCore.download('${fid}')" style="position:absolute;inset:0;background:rgba(0,0,0,0.5);display:grid;place-items:center;cursor:pointer"><div style="font-size:30px;color:#fff">▶</div></div>` : ''}
                <video id="v-${fid}" controls style="width:100%;height:100%;display:${isMe?'block':'none'}"></video>
            </div>
            <div style="padding:10px">
                <div style="color:#fff;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${window.util.escape(m.meta.fileName)}</div>
                <div style="display:flex;justify-content:space-between;margin-top:6px;align-items:center">
                    <span style="color:#888;font-size:12px">${sizeStr}</span>
                    <span id="st-${fid}" style="color:#4ea8ff;font-size:12px">${isMe?'本地':'点击播放'}</span>
                </div>
                <div id="pb-${fid}" style="height:3px;background:#4ea8ff;width:0%;margin-top:6px;transition:width 0.2s"></div>
            </div>
        </div>`;
    } else {
        inner = `
        <div style="${style};padding:15px">
            <div style="display:flex;gap:12px;align-items:center">
                <div style="font-size:28px">📄</div>
                <div style="flex:1;overflow:hidden">
                    <div style="color:#fff;font-weight:bold">${window.util.escape(m.meta.fileName)}</div>
                    <div style="color:#888;font-size:12px">${sizeStr}</div>
                </div>
                ${!isMe ? `<button id="btn-${fid}" onclick="window.smartCore.download('${fid}')" style="background:#2a7cff;color:#fff;border:none;padding:6px 12px;border-radius:4px">下载</button>` : ''}
            </div>
            <div id="st-${fid}" style="font-size:10px;color:#666;text-align:right;margin-top:6px"></div>
            <div id="pb-${fid}" style="height:3px;background:#4ea8ff;width:0%;margin-top:6px"></div>
        </div>`;
    }

    const html = `<div class="msg-row ${isMe?'me':'other'}" id="msg-${m.id}" style="margin-bottom:15px"><div class="msg-bubble" style="padding:0;background:transparent;border:none">${inner}</div><div class="msg-meta">${isMe?'我':window.util.escape(m.n)}</div></div>`;
    box.insertAdjacentHTML('beforeend', html);
    box.scrollTop = box.scrollHeight;
    
    if(isMe && isVideo && memoryStore[fid]) {
        setTimeout(() => {
            const v = document.getElementById(`v-${fid}`);
            if(v) v.src = URL.createObjectURL(memoryStore[fid]);
        }, 100);
    }
}

function tryPreviewVideo(task) {
    const v = document.getElementById('v-' + task.fileId);
    const mask = document.getElementById('mask-' + task.fileId);
    if(v && mask) {
        const partial = new Blob(task.chunks, {type:task.mime});
        v.src = URL.createObjectURL(partial);
        v.style.display = 'block';
        mask.style.display = 'none';
        v.play().catch(()=>{});
        updateUIStatus(task.fileId, '▶️ 边下边播...', true);
    }
}

function updateUIStatus(fid, txt, showCancel) {
    const el = document.getElementById('st-' + fid);
    if(el) el.innerText = txt;
    
    if(showCancel !== undefined) {
        const btn = document.getElementById('btn-' + fid);
        if(btn) {
            if(showCancel) {
                btn.innerText = '❌';
                btn.style.background = '#ff3b30';
                btn.onclick = () => cancelTask(fid);
            }
        }
    }
}

function updateUIProg(fid, pct) {
    const el = document.getElementById('pb-' + fid);
    if(el) el.style.width = pct + '%';
}

async function openFileViewer(fileId) {
    let blob = memoryStore[fileId] || await getFileFromDB(fileId);
    if (!blob) { alert('文件丢失'); return; }
    const url = URL.createObjectURL(blob);
    
    if (blob.type.startsWith('video/')) {
        const v = document.getElementById('v-' + fileId);
        if(v) { 
            v.style.display='block'; 
            v.requestFullscreen().catch(()=>{});
            v.play();
        }
    } else {
        const a = document.createElement('a');
        a.href = url; a.download = `file_${Date.now()}`; a.click();
    }
}

// Utils
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
            if(w>w){h=(h*w)/w;w=w;}
            cvs.width=img.width>600?600:img.width; cvs.height=img.height*(cvs.width/img.width);
            cvs.getContext('2d').drawImage(img,0,0,cvs.width,cvs.height);
            r(cvs.toDataURL('image/jpeg', q));
        };
        img.onerror = j;
    });
}
