import { CHAT, UI_CONFIG } from './constants.js';

export function init() {
  window.ui = window.ui || {};
  
  // 样式保持不变...
  const css = `
    .msg-bubble { max-width: 80%; padding: 8px 12px; border-radius: 8px; word-break: break-all; position: relative; }
    .msg-row { display: flex; margin-bottom: 10px; }
    .msg-row.me { justify-content: flex-end; }
    .msg-row.me .msg-bubble { background: #0084ff; color: #fff; border-bottom-right-radius: 2px; }
    .msg-row.other { justify-content: flex-start; }
    .msg-row.other .msg-bubble { background: #333; color: #fff; border-bottom-left-radius: 2px; }
    .msg-meta { font-size: 10px; color: #666; margin-top: 2px; text-align: right; }
    .stream-card { background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; min-width: 220px; }
    .mini-log { display: none; flex-direction: column; position: fixed; bottom: 0; left: 0; right: 0; height: 40%; background: rgba(0,0,0,0.9); z-index: 999; border-top: 1px solid #444; }
    .log-content { flex: 1; overflow-y: auto; padding: 10px; font-family: monospace; font-size: 11px; color: #0f0; user-select: text !important; -webkit-user-select: text !important; }
    .log-bar { padding: 5px; background: #222; display: flex; gap: 10px; justify-content: flex-end; }
    .log-btn { padding: 4px 10px; background: #444; color: #fff; border: none; border-radius: 4px; font-size: 12px; }
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const render = {
    init() { this.renderList(); this.updateSelf(); },
    clearMsgs() { document.getElementById('msgList').innerHTML = ''; },
    
    renderList() {
      const list = document.getElementById('contactList');
      if (!list) return;
      list.innerHTML = '';
      
      let html = `
        <div class="contact-item ${window.state.activeChat===CHAT.PUBLIC_ID?'active':''}" data-chat-id="${CHAT.PUBLIC_ID}" data-chat-name="公共频道">
           <div class="avatar" style="background:#ff9800">群</div>
           <div class="info"><div class="name">公共频道</div><div class="status">在线: ${Object.keys(window.state.conns).length}</div></div>
        </div>`;
      
      Object.keys(window.state.conns).forEach(id => {
          const conn = window.state.conns[id];
          const name = conn.label || id.slice(0, 6);
          const active = window.state.activeChat === id ? 'active' : '';
          const unread = window.state.unread[id] ? `<div class="badge">${window.state.unread[id]}</div>` : '';
          html += `<div class="contact-item ${active}" data-chat-id="${id}" data-chat-name="${window.util.escape(name)}"><div class="avatar">${name[0]}</div><div class="info"><div class="name">${window.util.escape(name)}</div><div class="status" style="color:#4caf50">● 在线</div></div>${unread}</div>`;
      });
      list.innerHTML = html;
    },

    updateSelf() {
        const elNick = document.getElementById('myNick');
        const elId = document.getElementById('myId');
        const elDot = document.getElementById('statusDot');
        const elText = document.getElementById('statusText');
        if(elNick) elNick.innerText = window.state.myName;
        if(elId) elId.innerText = window.state.myId;
        
        let status = '离线', color = '#999';
        const mqttOn = window.state.mqttStatus === '在线';
        const p2pCount = Object.keys(window.state.conns).length;
        if (mqttOn && p2pCount > 0) { status = '在线+P2P'; color = '#4caf50'; }
        else if (mqttOn) { status = '在线(MQTT)'; color = '#2196f3'; }
        else if (p2pCount > 0) { status = 'P2P组网'; color = '#ff9800'; }
        
        if(elDot) elDot.style.background = color;
        if(elText) { elText.innerText = status; elText.style.color = color; }
        const countEl = document.getElementById('onlineCount');
        if(countEl) countEl.innerText = p2pCount;
    },

    appendMsg(m) {
      const box = document.getElementById('msgList');
      if (!box || document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      let content = '', style = '';

      if (m.kind === 'SMART_FILE_UI') {
         const meta = m.meta;
         
         // === 核心修复：渲染时自动注入缓存 ===
         // 既然 UI 拿到了数据，就顺便告诉 SmartCore
         if (window.smartCore && window.smartCore.cacheMeta) {
             // 兼容嵌套结构
             const realMeta = (meta && meta.fileId) ? meta : (meta && meta.meta);
             if (realMeta) window.smartCore.cacheMeta(realMeta);
         }
         // ================================

         const safeName = window.util.escape(meta.fileName || '未知文件');
         const sizeStr = meta.fileSize ? (meta.fileSize / (1024*1024)).toFixed(2) + ' MB' : '未知大小';
         
         const isVideo = meta.fileType && meta.fileType.startsWith('video');
         const fileId = meta.fileId || (meta.meta && meta.meta.fileId);

         // 只有当 fileId 存在时才渲染播放器
         if (fileId && isVideo) {
             // 获取播放链接 (现在 cache 肯定有了)
             const streamUrl = window.smartCore ? window.smartCore.play(fileId, safeName) : '';
             
             const errScript = `this.style.display='none';this.nextElementSibling.style.display='block';`;
             content = `
             <div class="stream-card">
                 <div style="font-weight:bold;color:#4ea8ff">🎬 ${safeName}</div>
                 <div style="font-size:11px;color:#aaa;margin-bottom:8px">${sizeStr} (流式直连)</div>
                 <video controls src="${streamUrl}" 
                        style="width:100%;max-width:300px;background:#000;border-radius:4px"
                        onerror="${errScript}"></video>
                 <div class="video-error" style="display:none;color:#f55;font-size:10px;padding:10px">❌ 播放失败</div>
                 <div style="text-align:right;margin-top:4px">
                     <a href="javascript:void(0)" onclick="window.smartCore.download('${fileId}','${safeName}')" style="color:#aaa;font-size:10px;text-decoration:none">⬇ 保存本地</a>
                 </div>
             </div>`;
             style = 'background:transparent;padding:0;border:none';
         } else {
             content = `
             <div class="stream-card">
                 <div style="font-weight:bold;color:#fff">📄 ${safeName}</div>
                 <div style="font-size:11px;color:#aaa;margin:4px 0">${sizeStr}</div>
                 <a href="javascript:void(0)" onclick="window.smartCore.download('${fileId}','${safeName}')"
                    style="display:inline-block;background:#2a7cff;color:white;padding:6px 12px;border-radius:4px;text-decoration:none;font-size:12px">下载</a>
             </div>`;
             style = 'background:transparent;padding:0;border:none';
         }
      } else {
         content = window.util.escape(m.txt);
      }
      
      const html = `
        <div class="msg-row ${isMe ? 'me' : 'other'}" id="msg-${m.id}">
          <div>
            <div class="msg-bubble" style="${style}">${content}</div>
            <div class="msg-meta">${isMe ? '我' : window.util.escape(m.n)} ${new Date(m.ts).toLocaleTimeString()}</div>
          </div>
        </div>`;

      box.insertAdjacentHTML('beforeend', html);
      box.scrollTop = box.scrollHeight;
    },
    
    downloadBlob(data, name) {
        let url;
        if (data instanceof Blob) url = URL.createObjectURL(data);
        else if (typeof data === 'string') url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(data);
        else return;
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(() => document.body.removeChild(a), 100);
    }
  };
  Object.assign(window.ui, render);
}
