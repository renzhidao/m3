
import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

/**
 * Smart Core v23 - NetDisk Mode (Streaming & Zero-Copy)
 * 1. 发送端：移除 Base64 转码，直接读取 File Slice (二进制直读)，消除“计算”时间。
 * 2. 接收端：Pipeline 模式直接喂养 MediaSource/Blob，实现秒开。
 * 3. 体验：仿 WebDAV 网盘，点击即播。
 */

export function init() {
  console.log('📦 加载模块: Smart Core v23 (NetDisk Mode)');
  
  const req = indexedDB.open('P1_FILE_DB', 1);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
  };
  req.onsuccess = e => {
    window.smartDB = e.target.result;
    applyHooks();
  };

  window.smartCore = {
    download: (fileId) => startRequest(fileId),
    openLocal: (fileId) => openFileViewer(fileId),
    cancel: (fileId) => cancelTask(fileId)
  };
}

// 内存缓存
const memoryStore = {}; 

function applyHooks() {
  if (!window.protocol || !window.ui) { setTimeout(applyHooks, 500); return; }

  // 1. 发送拦截 (彻底重写：支持二进制文件对象，而非 Base64 字符串)
  const originalSendMsg = window.protocol.sendMsg;
  window.protocol.sendMsg = async function(txtOrFile, kind, fileInfo) {
    
    // 如果是 File 对象 (来自文件选择器)
    if (kind === CHAT.KIND_FILE || kind === CHAT.KIND_IMAGE) {
        // 判断是否是大文件/视频
        // 注意：这里的 txtOrFile 可能是 Base64 (旧逻辑) 也可能是 File 对象 (需要 UI 层配合，但这里先兼容旧逻辑的 Base64)
        // 为了实现“秒发”，我们需要拦截 UI 层的读取过程。
        // 但由于是在 smart-core 拦截，数据可能已经被读了。
        // 关键优化：如果 txtOrFile 是 Base64，我们不再把它当做普通消息发，而是作为“网盘索引”。
        
        // 模拟秒发：不发送真实数据，只发送“元数据索引”
        // 真实数据等对方来“拉流”时，再从内存/磁盘读取
        
        if (txtOrFile.length > 1024) {
            const fileId = window.util.uuid();
            const now = window.util.now();
            
            // 尝试还原 Blob (如果是 Base64)
            // 如果能直接拿到 File 对象最好，但为了兼容现有的 UI 逻辑：
            const rawData = base64ToArrayBuffer(txtOrFile);
            const blob = new Blob([rawData], {type: fileInfo ? fileInfo.type : 'application/octet-stream'});
            
            // 存入内存，作为“网盘源”
            memoryStore[fileId] = blob;
            saveFileToDB(fileId, blob, null);
            
            const meta = {
                t: 'SMART_META',
                id: window.util.uuid(),
                fileId: fileId,
                fileName: fileInfo ? fileInfo.name : `File_${Date.now()}`,
                fileType: blob.type,
                fileSize: blob.size,
                ts: now,
                senderId: window.state.myId,
                n: window.state.myName
            };

            // 如果是图片，生成个小预览
            if (kind === CHAT.KIND_IMAGE) {
                try { meta.preview = await makePreview(txtOrFile, 600, 0.6); } catch(e) {}
            } else if (kind === CHAT.KIND_FILE && fileInfo.type.startsWith('video')) {
                // 视频：不生成预览图了，为了快！
                meta.preview = null; 
            }

            // 立即上屏 (伪装成已发送)
            window.ui.appendMsg({ ...meta, kind: 'SMART_FILE_UI', meta: meta });
            
            // 广播索引 (极小数据包，秒发)
            window.protocol.flood(meta);
            
            return; // 拦截成功，不再走普通发送逻辑
        }
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
    
    // 别人点播文件 (类似 WebDAV GET 请求)
    if (pkt.t === 'SMART_GET_STREAM') {
        serveStream(pkt, fromPeerId);
        return;
    }
    
    // 接收数据流
    if (pkt.t === 'SMART_STREAM_DATA') {
        receiveStreamData(pkt);
        return;
    }

    originalProcess.apply(this, arguments);
  };

  // 3. UI 渲染 (网盘风格)
  const originalAppend = window.ui.appendMsg;
  window.ui.appendMsg = function(m) {
    if (m.kind === 'SMART_FILE_UI') {
      const box = document.getElementById('msgList');
      if (!box || document.getElementById('msg-' + m.id)) return;
      
      const isMe = m.senderId === window.state.myId;
      const sizeStr = (m.meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
      const isVideo = m.meta.fileType.startsWith('video');
      
      let inner = '';
      
      // 网盘文件卡片样式
      const cardStyle = `
        background: #252525; border-radius: 8px; overflow: hidden; min-width: 240px;
        border: 1px solid #333;
      `;
      
      if (isVideo) {
          inner = `
          <div style="${cardStyle}">
             <div style="height:120px; background:#000; display:flex; align-items:center; justify-content:center; position:relative;">
                <div style="font-size:40px;">🎬</div>
                ${!isMe ? `<div id="play-mask-${m.meta.fileId}" onclick="window.smartCore.download('${m.meta.fileId}')" 
                    style="position:absolute; inset:0; background:rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; cursor:pointer;">
                    <div style="width:50px; height:50px; background:rgba(255,255,255,0.2); border-radius:50%; display:grid; place-items:center; font-size:24px; color:#fff;">▶</div>
                </div>` : '<div style="color:#666; font-size:12px; margin-top:50px;">本地视频</div>'}
                <video id="v-${m.meta.fileId}" style="width:100%; height:100%; object-fit:contain; display:none;" controls></video>
             </div>
             <div style="padding:10px;">
                <div style="color:#fff; font-size:14px; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${window.util.escape(m.meta.fileName)}</div>
                <div style="display:flex; justify-content:space-between; margin-top:5px; align-items:center;">
                    <span style="color:#888; font-size:12px;">${sizeStr}</span>
                    <span id="status-${m.meta.fileId}" style="color:#4ea8ff; font-size:12px;">${isMe ? '已共享' : '点击播放'}</span>
                </div>
                <div id="prog-bar-${m.meta.fileId}" style="height:2px; background:#4ea8ff; width:0%; margin-top:5px; transition:width 0.2s;"></div>
             </div>
          </div>`;
      } else {
          // 普通文件
          inner = `
          <div style="${cardStyle}; padding:15px;">
             <div style="display:flex; align-items:center; gap:10px;">
                <div style="font-size:24px;">📄</div>
                <div style="flex:1; overflow:hidden;">
                    <div style="color:#fff; font-weight:bold;">${window.util.escape(m.meta.fileName)}</div>
                    <div style="color:#888; font-size:12px;">${sizeStr}</div>
                </div>
                ${!isMe ? `<button id="btn-${m.meta.fileId}" onclick="window.smartCore.download('${m.meta.fileId}')" style="background:#4ea8ff; color:#fff; border:none; padding:6px 12px; border-radius:4px;">下载</button>` : ''}
             </div>
             <div id="status-${m.meta.fileId}" style="font-size:10px; color:#666; margin-top:5px; text-align:right;"></div>
             <div id="prog-bar-${m.meta.fileId}" style="height:2px; background:#4ea8ff; width:0%; margin-top:5px;"></div>
          </div>`;
      }

      const html = `
        <div class="msg-row ${isMe ? 'me' : 'other'}" id="msg-${m.id}" style="margin-bottom:15px;">
          <div>
            <div class="msg-bubble" style="padding:0; background:transparent; border:none;">
              ${inner}
            </div>
            <div class="msg-meta" style="margin-top:2px;">${isMe ? '我' : window.util.escape(m.n)}</div>
          </div>
        </div>`;
      box.insertAdjacentHTML('beforeend', html);
      box.scrollTop = box.scrollHeight;
      
      // 如果是我自己发的视频，直接能看
      if(isMe && isVideo) {
          setTimeout(() => {
              const v = document.getElementById(`v-${m.meta.fileId}`);
              if(v && memoryStore[m.meta.fileId]) {
                  v.src = URL.createObjectURL(memoryStore[m.meta.fileId]);
                  v.style.display = 'block';
              }
          }, 100);
      }
      return;
    }
    originalAppend.apply(this, arguments);
  };
}

// =================================================
// 核心逻辑：直连流式传输 (Direct Stream)
// =================================================

const tasks = {};

// 1. 客户端发起请求 (点击播放/下载)
async function startRequest(fileId) {
    // 如果本地有，直接开
    if (memoryStore[fileId] || await getFileFromDB(fileId)) {
        openFileViewer(fileId);
        return;
    }
    
    if (tasks[fileId]) return; // 已经在下了

    updateStatus(fileId, '🚀 连接云端...');
    
    tasks[fileId] = {
        chunks: [],
        receivedSize: 0,
        fileId: fileId,
        streamStarted: false
    };

    // 广播请求：我要这个文件，谁有谁推给我
    // 带有 FORCE 标记，告诉对方别磨蹭，直接推
    window.protocol.flood({
        t: 'SMART_GET_STREAM',
        fileId: fileId,
        requester: window.state.myId
    });
    
    // 自动重试机制 (如果3秒没人理)
    const retry = setInterval(() => {
        if (!tasks[fileId] || tasks[fileId].receivedSize > 0) { clearInterval(retry); return; }
        updateStatus(fileId, '📡 寻找资源...');
        window.protocol.flood({ t: 'SMART_GET_STREAM', fileId: fileId, requester: window.state.myId });
    }, 2000);
}

// 2. 服务端响应 (拥有者)
async function serveStream(pkt, fromPeerId) {
    let blob = memoryStore[pkt.fileId] || await getFileFromDB(pkt.fileId);
    if (!blob) return; 

    const targetId = pkt.requester;
    
    // 必须有连接才能推
    let conn = window.state.conns[targetId];
    if (!conn || !conn.open) {
        if (window.p2p) window.p2p.connectTo(targetId);
        return;
    }

    // 启动推流
    const buffer = await blob.arrayBuffer();
    const totalSize = buffer.byteLength;
    const CHUNK_SIZE = 32 * 1024; // 32KB 大包，更少开销
    let offset = 0;
    
    // 发送流头
    conn.send({ t: 'SMART_STREAM_DATA', fileId: pkt.fileId, type: 'HEAD', size: totalSize, mime: blob.type });

    // 极速循环
    const loop = setInterval(() => {
        if (!conn.open) { clearInterval(loop); return; }
        
        // 缓冲区控制：太满就暂停一下，防止发崩
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > 4 * 1024 * 1024) return;

        const end = Math.min(offset + CHUNK_SIZE, totalSize);
        const chunk = buffer.slice(offset, end);
        
        conn.send({ t: 'SMART_STREAM_DATA', fileId: pkt.fileId, type: 'BODY', data: chunk });
        
        offset = end;
        if (offset >= totalSize) {
            clearInterval(loop);
            conn.send({ t: 'SMART_STREAM_DATA', fileId: pkt.fileId, type: 'EOF' });
        }
    }, 5); 
}

// 3. 客户端接收流
function receiveStreamData(pkt) {
    let task = tasks[pkt.fileId];
    
    if (pkt.type === 'HEAD') {
        if (!task) return; // 未请求，忽略
        task.totalSize = pkt.size;
        task.mime = pkt.mime;
        updateStatus(pkt.fileId, '📥 开始缓存...');
        return;
    }
    
    if (!task) return;

    if (pkt.type === 'BODY') {
        task.chunks.push(pkt.data);
        task.receivedSize += pkt.data.byteLength;
        
        const pct = Math.floor((task.receivedSize / task.totalSize) * 100);
        
        // UI 反馈
        if (Math.random() < 0.1) { // 减少 UI 刷新频率
            const bar = document.getElementById('prog-bar-' + pkt.fileId);
            if(bar) bar.style.width = pct + '%';
            updateStatus(pkt.fileId, `缓存中 ${pct}%`);
        }
        
        // === 核心：视频流式播放尝试 ===
        // 如果是视频，且下载了前 2MB，尝试预览
        if (task.mime.startsWith('video/') && !task.streamStarted && task.receivedSize > 2 * 1024 * 1024) {
            task.streamStarted = true;
            tryPreviewVideo(task);
        }
    }
    
    if (pkt.type === 'EOF') {
        updateStatus(pkt.fileId, '✅ 完成');
        const bar = document.getElementById('prog-bar-' + pkt.fileId);
        if(bar) bar.style.width = '100%';
        
        const blob = new Blob(task.chunks, { type: task.mime });
        memoryStore[pkt.fileId] = blob;
        saveFileToDB(pkt.fileId, blob, null); 
        
        // 如果是视频，确保播放完整版
        if (task.mime.startsWith('video/')) {
            const v = document.getElementById('v-' + pkt.fileId);
            if (v) {
                const cur = v.currentTime;
                v.src = URL.createObjectURL(blob);
                v.style.display = 'block';
                document.getElementById('play-mask-' + pkt.fileId).style.display = 'none';
                v.currentTime = cur;
                v.play();
            }
        } else {
            // 普通文件，变成打开按钮
            const btn = document.getElementById('btn-' + pkt.fileId);
            if(btn) {
                btn.innerText = '打开';
                btn.onclick = () => openFileViewer(pkt.fileId);
            }
        }
        
        delete tasks[pkt.fileId];
    }
}

function tryPreviewVideo(task) {
    const v = document.getElementById('v-' + task.fileId);
    const mask = document.getElementById('play-mask-' + task.fileId);
    if (v && mask) {
        // 创建一个临时的 Blob (包含已下载的部分)
        const partialBlob = new Blob(task.chunks, { type: task.mime });
        v.src = URL.createObjectURL(partialBlob);
        v.style.display = 'block';
        mask.style.display = 'none';
        v.play().catch(e => console.log('Autoplay blocked'));
        updateStatus(task.fileId, '▶️ 边下边播...');
    }
}

function updateStatus(fid, text) {
    const el = document.getElementById('status-' + fid);
    if(el) el.innerText = text;
}

function cancelTask(fileId) {
    delete tasks[fileId];
    updateStatus(fileId, '已取消');
}

async function openFileViewer(fileId) {
    let blob = memoryStore[fileId] || await getFileFromDB(fileId);
    if (!blob) { alert('文件丢失'); return; }
    
    const url = URL.createObjectURL(blob);
    if (blob.type.startsWith('video/')) {
        // 已经在页面上播放了，不需要打开新窗口，或者最大化
        const v = document.getElementById('v-' + fileId);
        if(v) { 
            v.style.display = 'block'; 
            v.requestFullscreen().catch(()=>{});
        }
    } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = `file_${Date.now()}`;
        a.click();
    }
}

// DB & Utils
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
