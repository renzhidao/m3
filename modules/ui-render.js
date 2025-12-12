import { CHAT, UI_CONFIG } from './constants.js';

export function init() {
  if (!window.ui) window.ui = {};

  const css = `
    .msg-row { display:flex; margin:8px 12px; }
    .msg-row.me { justify-content: flex-end; }
    .msg-row.other { justify-content: flex-start; }
    .msg-bubble { max-width: 80%; padding:10px 12px; border-radius:10px; background:#1f2937; color:#fff; word-break:break-word; }
    .msg-row.me .msg-bubble { background:#2563eb; }
    .msg-meta { margin:4px 4px 0; font-size:11px; color:#9ca3af; }
    .stream-card { background:#0b1220; border:1px solid #1f2a44; border-radius:8px; padding:10px; }
    .stream-card video { width:100%; max-width:320px; background:#000; border-radius:4px; }
    .avatar { width:36px; height:36px; border-radius:50%; background:#2a7cff; color:#fff; display:flex; align-items:center; justify-content:center; margin-right:8px; }
    .contact-item { display:flex; align-items:center; gap:8px; padding:8px; cursor:pointer; border-bottom:1px solid #222; position:relative; }
    .contact-item.active { background:#0b1220; }
    .badge { position:absolute; right:10px; top:50%; transform:translateY(-50%); background:#ef4444; color:#fff; border-radius:10px; padding:2px 6px; font-size:11px; }
  `;
  const styleEl = document.createElement('style'); styleEl.textContent = css; document.head.appendChild(styleEl);

  const esc = (s)=> (window.util && window.util.escape) ? window.util.escape(s) : (s ?? '');

  const render = {
    init() { this.renderList(); this.updateSelf(); },
    clearMsgs() { const box = document.getElementById('msgList'); if (box) box.innerHTML = ''; },

    renderList() {
      const list = document.getElementById('contactList');
      if (!list) return;
      list.innerHTML = '';
      
      let html = `<div class="contact-item ${window.state.activeChat===CHAT.PUBLIC_ID?'active':''}" data-chat-id="${CHAT.PUBLIC_ID}" data-chat-name="公共频道"><div class="avatar" style="background:#ff9800">群</div><div class="info"><div class="name">公共频道</div><div class="status">在线: ${Object.keys(window.state.conns).length}</div></div></div>`;
      Object.keys(window.state.conns).forEach(id => {
        const conn = window.state.conns[id];
        const name = (conn && conn.label) ? conn.label : id.slice(0, 6);
        const active = window.state.activeChat === id ? 'active' : '';
        const unread = window.state.unread[id] ? `<div class="badge">${window.state.unread[id]}</div>` : '';
        html += `<div class="contact-item ${active}" data-chat-id="${id}" data-chat-name="${esc(name)}"><div class="avatar">${esc(name)[0] || '?'}</div><div class="info"><div class="name">${esc(name)}</div><div class="status" style="color:#4caf50">● 在线</div></div>${unread}</div>`;
      });
      list.innerHTML = html;
    },

    updateSelf() {
      const title = document.getElementById('chatTitle');
      const status = document.getElementById('chatStatus');
      if (title) title.innerText = window.state.activeChatName || '公共频道';
      if (status) status.innerText = window.state.mqttStatus || '未知';
    },

    appendMsg(m) {
      const box = document.getElementById('msgList');
      if (!box || !m) return;

      const isMe = (m.senderId === window.state.myId);
      let content = '';
      let bubbleStyle = '';

      const meta = (m && m.meta && m.meta.fileId) ? m.meta : (m && m.meta && m.meta.meta ? m.meta.meta : null);

      if ((m.t === 'SMART_META' && meta) || (m.kind && (m.kind === CHAT.KIND_FILE || m.kind === CHAT.KIND_IMAGE) && meta)) {
        if (window.smartCore && window.smartCore.cacheMeta) window.smartCore.cacheMeta(meta);

        const safeName = esc(meta.fileName || '未知文件');
        const sizeStr = meta.fileSize ? (meta.fileSize / (1024*1024)).toFixed(2) + ' MB' : '未知大小';
        const isVideo = meta.fileType && meta.fileType.includes('video');
        const fileId = meta.fileId;

        // 如果支持 Service Worker，则使用流式播放地址
        const hasSW = ('serviceWorker' in navigator) && !!navigator.serviceWorker.controller;
        
        if (fileId && isVideo && hasSW) {
          const streamUrl = `/stream/${fileId}`;
          content = `
            <div class="stream-card">
              <div style="font-weight:bold;color:#4ea8ff">🎬 ${safeName}</div>
              <div style="font-size:11px;color:#aaa;margin-bottom:8px">${sizeStr} (SW流式)</div>
              <video controls autoplay muted playsinline src="${streamUrl}" 
                     style="width:100%;max-width:320px;background:#000;border-radius:4px"></video>
              <div style="text-align:right;margin-top:4px">
                 <a href="${streamUrl}" download="${safeName}" style="color:#aaa;font-size:12px;text-decoration:none">⬇ 保存</a>
              </div>
            </div>`;
          bubbleStyle = 'background:transparent;padding:0;border:none';
        } else {
          // 不支持 SW 或者是普通文件
          content = `
            <div class="stream-card">
              <div style="font-weight:bold;color:#fff">${isVideo ? '🎞' : '📄'} ${safeName}</div>
              <div style="font-size:11px;color:#aaa;margin:4px 0">${sizeStr}</div>
              <a href="javascript:void(0)" onclick="window.smartCore.download('${fileId}','${safeName}')"
                 style="display:inline-block;background:#2a7cff;color:white;padding:6px 12px;border-radius:4px;text-decoration:none;font-size:12px">下载</a>
            </div>`;
          bubbleStyle = 'background:transparent;padding:0;border:none';
        }
      } else if (m.kind === CHAT.KIND_IMAGE && m.txt && /^data:image\//.test(m.txt)) {
        content = `<img class="chat-img" src="${m.txt}" style="max-width:240px;border-radius:6px" />`;
      } else {
        content = m.txt ? esc(m.txt) : '<span style="color:#9ca3af">[空消息]</span>';
      }

      const who = isMe ? '我' : esc(m.n || '');
      const tsStr = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
      const html = `
        <div class="msg-row ${isMe ? 'me' : 'other'}" id="msg-${m.id || ('m_'+Math.random().toString(36).slice(2,8))}">
          <div>
            <div class="msg-bubble" style="${bubbleStyle}">${content}</div>
            <div class="msg-meta">${who} ${tsStr}</div>
          </div>
        </div>`;

      box.insertAdjacentHTML('beforeend', html);
      box.scrollTop = box.scrollHeight;
    }
  };

  Object.assign(window.ui, render);
  const start = () => { try { window.ui.init(); } catch(e) {} };
  if (document.readyState === 'complete' || document.readyState === 'interactive') start();
  else document.addEventListener('DOMContentLoaded', start);
}
