import { CHAT, UI_CONFIG } from './constants.js';

export function init() {
  console.log('📦 加载模块: UI Render (Click-Close Fix)');
  window.ui = window.ui || {};
  
  const style = document.createElement('style');
  style.textContent = `
    .img-preview-overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.95); z-index: 9999;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        animation: fadeIn 0.2s ease;
        cursor: zoom-out; /* 提示可关闭 */
    }
    .img-preview-content {
        max-width: 100%; max-height: 80%;
        object-fit: contain;
        transition: transform 0.2s;
    }
    .preview-actions {
        margin-top: 20px; display: flex; gap: 20px;
        z-index: 10000;
    }
    .preview-btn {
        background: #333; color: white; border: 1px solid #555;
        padding: 8px 20px; border-radius: 20px; font-size: 14px; cursor: pointer;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
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

    downloadBlob(urlOrData, fileName) {
        try {
            window.util.log('⬇️ 准备下载: ' + fileName);
            let url = urlOrData;
            if (typeof urlOrData === 'string' && urlOrData.startsWith('data:')) {
                 fetch(urlOrData).then(res => res.blob()).then(blob => {
                     const u = URL.createObjectURL(blob);
                     this.downloadBlob(u, fileName);
                 });
                 return;
            }
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                window.util.log('✅ 已调起系统下载');
            }, 500);
        } catch(e) {
            window.util.log('❌ 下载失败: ' + e.message);
        }
    },

    previewImage(src) {
        const div = document.createElement('div');
        div.className = 'img-preview-overlay';
        div.innerHTML = `
            <img src="${src}" class="img-preview-content">
            <div class="preview-actions">
                <button class="preview-btn" id="pv-close">关闭</button>
                <button class="preview-btn" id="pv-save" style="background:#2a7cff;border-color:#2a7cff">保存原图</button>
            </div>
        `;
        
        // === 修复：点击任意地方（包括图片本身）都关闭 ===
        const close = () => {
             if(document.body.contains(div)) document.body.removeChild(div);
        };

        div.onclick = (e) => {
            // 如果点击的是保存按钮，不关闭
            if (e.target.id === 'pv-save') return;
            close();
        };

        const btnSave = div.querySelector('#pv-save');
        btnSave.onclick = (e) => {
            e.stopPropagation(); // 阻止冒泡到 div 关闭
            const ts = new Date().getTime();
            this.downloadBlob(src, `p1_img_${ts}.jpg`);
        };

        document.body.appendChild(div);
    },

    appendMsg(m) {
      const box = document.getElementById('msgList');
      if (!box || !m) return;
      if (document.getElementById('msg-' + m.id)) return;

      const isMe = m.senderId === window.state.myId;
      let content = '', style = '';

      if (m.kind === CHAT.KIND_IMAGE) {
         content = `<img src="${m.txt}" class="chat-img" style="min-height:50px; background:#222;">`;
         style = 'background:transparent;padding:0';
      } else if (m.kind === CHAT.KIND_FILE) {
         const sizeStr = m.fileSize ? (m.fileSize / 1024).toFixed(1) + 'KB' : '未知';
         content = `
           <div class="file-card">
             <div class="file-icon">📄</div>
             <div class="file-info">
               <div class="file-name">${window.util.escape(m.fileName || '未命名文件')}</div>
               <div class="file-size">${sizeStr}</div>
             </div>
             <div class="file-dl-btn" style="cursor:pointer">⬇</div>
           </div>`;
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
      
      const el = document.getElementById('msg-' + m.id);
      if (m.kind === CHAT.KIND_IMAGE) {
          const img = el.querySelector('img');
          if (img) img.onclick = () => this.previewImage(m.txt);
      }
      if (m.kind === CHAT.KIND_FILE) {
          const btn = el.querySelector('.file-dl-btn');
          if (btn) btn.onclick = () => this.downloadBlob(m.txt, m.fileName || 'file.dat');
      }

      if (window.uiEvents && window.uiEvents.bindMsgEvents) window.uiEvents.bindMsgEvents();
    }
  };
  Object.assign(window.ui, render);
}