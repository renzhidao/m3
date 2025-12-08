import { CHAT, UI_CONFIG } from './constants.js';

export function init() {
  console.log('📦 加载模块: UI Render (Fixed DL)');
  window.ui = window.ui || {};
  
  const style = document.createElement('style');
  style.textContent = `
    .img-preview-overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.95); z-index: 9999;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        cursor: zoom-out;
    }
    .img-preview-content {
        max-width: 100%; max-height: 80%;
        object-fit: contain;
    }
    .stream-card {
        background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; min-width: 220px;
    }
  `;
  document.head.appendChild(style);
  
  const render = {
    init() { this.renderList(); this.updateSelf(); },

    updateSelf() {
      const elId = document.getElementById('myId');
      const elNick = document.getElementById('myNick');
      const elSt = document.getElementById('statusText');
      const elDot = document.getElementById('statusDot');
      const elCount = document.getElementById('onlineCount');

      if (elId) elId.innerText = window.state.myId.slice(0, 6);
      if (elNick) elNick.innerText = window.state.myName;
      
      if (elSt) {
        let s = '在线';
        if (window.state.isHub) s = '👑网关';
        if (window.state.mqttStatus === '在线') s += '+MQTT';
        else if (window.state.mqttStatus === '失败') s += '(M离)';
        elSt.innerText = s;
      }
      
      if (elDot) elDot.className = window.state.mqttStatus === '在线' ? 'dot online' : 'dot';
      
      if (elCount) {
         let count = 0;
         Object.values(window.state.conns).forEach(c => { if(c.open) count++; });
         elCount.innerText = count;
      }
    },

    renderList() {
      const list = document.getElementById('contactList');
      if (!list) return;

      const pubUnread = window.state.unread[CHAT.PUBLIC_ID] || 0;
      
      let html = `
        <div class="contact-item ${window.state.activeChat === CHAT.PUBLIC_ID ? 'active' : ''}" 
              data-chat-id="${CHAT.PUBLIC_ID}" data-chat-name="${CHAT.PUBLIC_NAME}">
          <div class="avatar" style="background:${UI_CONFIG.COLOR_GROUP}">群</div>
          <div class="c-info">
            <div class="c-name">${CHAT.PUBLIC_NAME} 
               ${pubUnread > 0 ? `<span class="unread-badge">${pubUnread}</span>` : ''}
            </div>
          </div>
        </div>`;

      const map = new Map();
      Object.values(window.state.contacts).forEach(c => map.set(c.id, c));
      Object.keys(window.state.conns).forEach(k => {
         if (k !== window.state.myId) {
            const existing = map.get(k) || {};
            map.set(k, { ...existing, id: k, n: window.state.conns[k].label || k.slice(0, 6) });
         }
      });

      map.forEach((v, id) => {
        if (!id || id === window.state.myId || id.startsWith(window.config.hub.prefix)) return;
        const isOnline = window.state.conns[id] && window.state.conns[id].open;
        const unread = window.state.unread[id] || 0;
        const safeName = window.util.escape(v.n || id.slice(0, 6));
        const bg = isOnline ? UI_CONFIG.COLOR_ONLINE : window.util.colorHash(id);

        html += `
          <div class="contact-item ${window.state.activeChat === id ? 'active' : ''}" 
                data-chat-id="${id}" data-chat-name="${safeName}">
            <div class="avatar" style="background:${bg}">${safeName[0]}</div>
            <div class="c-info">
              <div class="c-name">${safeName} ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''}</div>
              <div class="c-time">${isOnline ? '在线' : '离线'}</div>
            </div>
          </div>`;
      });
      list.innerHTML = html;
    },

    clearMsgs() {
      const box = document.getElementById('msgList');
      if (box) box.innerHTML = '';
    },

    appendMsg(m) {
      const box = document.getElementById('msgList');
      if (!box || !m) return;
      if (document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      let content = '', style = '';

      if (m.kind === 'SMART_FILE_UI') {
         const meta = m.meta;
         const sizeStr = (meta.fileSize / (1024*1024)).toFixed(2) + ' MB';
         const isVideo = meta.fileType.startsWith('video');
         const isImg = meta.fileType.startsWith('image');
         const streamUrl = window.smartCore.play(meta.fileId, meta.fileName);
         
         if (isVideo) {
             content = `
             <div class="stream-card">
                 <div style="font-weight:bold;color:#4ea8ff">🎬 ${window.util.escape(meta.fileName)}</div>
                 <div style="font-size:11px;color:#aaa;margin-bottom:8px">${sizeStr} (流式直连)</div>
                 <video controls src="${streamUrl}" style="width:100%;max-width:300px;background:#000;border-radius:4px"></video>
                 <div style="text-align:right;margin-top:4px">
                     <a href="${streamUrl}" download="${meta.fileName}" style="color:#aaa;font-size:10px">⬇ 保存本地</a>
                 </div>
             </div>`;
             style = 'background:transparent;padding:0;border:none';
         } else if (isImg) {
             content = `
             <div class="stream-card">
                 <img src="${streamUrl}" style="max-width:200px;border-radius:4px;display:block">
                 <div style="font-size:10px;color:#aaa;margin-top:4px">${sizeStr}</div>
             </div>`;
             style = 'background:transparent;padding:0;border:none';
         } else {
             content = `
             <div class="stream-card">
                 <div style="font-weight:bold;color:#fff">📄 ${window.util.escape(meta.fileName)}</div>
                 <div style="font-size:11px;color:#aaa;margin:4px 0">${sizeStr}</div>
                 <a href="${streamUrl}" download="${meta.fileName}" 
                    style="display:inline-block;background:#2a7cff;color:white;padding:6px 12px;border-radius:4px;text-decoration:none;font-size:12px">
                    ⚡ 极速下载
                 </a>
             </div>`;
             style = 'background:transparent;padding:0;border:none';
         }

      } else if (m.kind === CHAT.KIND_IMAGE) {
         content = `<img src="${m.txt}" class="chat-img" style="min-height:50px; background:#222;">`;
         style = 'background:transparent;padding:0';
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
      
      if (window.uiEvents && window.uiEvents.bindMsgEvents) window.uiEvents.bindMsgEvents();
    },
    
    // === 修复：通用下载器 ===
    downloadBlob(data, name) {
        try {
            // 支持 base64 string 或普通 string
            let url;
            if (typeof data === 'string') {
                // 如果是 base64
                if (data.startsWith('data:')) {
                     const a = document.createElement('a');
                     a.href = data;
                     a.download = name;
                     a.click();
                     return;
                }
                // 纯文本 -> Blob
                const blob = new Blob([data], {type: 'text/plain'});
                url = URL.createObjectURL(blob);
            } else {
                // Blob 对象
                url = URL.createObjectURL(data);
            }
            
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch(e) {
            console.error('Download failed', e);
            alert('下载失败: ' + e.message);
        }
    }
  };
  Object.assign(window.ui, render);
}