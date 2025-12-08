import { CHAT, UI_CONFIG } from './constants.js';

export function init() {
  console.log('📦 加载模块: UI Events (Monitor)');
  
  window.uiEvents = {
    init() {
      this.bindClicks();
      this.bindMsgEvents(); 
      this.injectStyles();
      this.addMonitorBtn();
    },
    
    addMonitorBtn() {
        // 在 Header 增加诊断按钮
        const header = document.querySelector('.chat-header div:last-child');
        if (header && !document.getElementById('btnMonitor')) {
            const btn = document.createElement('div');
            btn.className = 'btn-icon';
            btn.id = 'btnMonitor';
            btn.innerHTML = '🐞';
            btn.title = '打开诊断面板';
            btn.onclick = () => {
                if(window.monitor) window.monitor.show();
            };
            header.prepend(btn);
        }
    },

    injectStyles() {
      const css = '.file-card { display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 8px; min-width: 200px; } ' +
                  '.file-icon { font-size: 24px; } ' +
                  '.file-info { flex: 1; min-width: 0; } ' +
                  '.file-name { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } ' +
                  '.file-size { font-size: 11px; opacity: 0.7; } ' +
                  '.file-dl-btn { text-decoration: none; color: white; font-weight: bold; padding: 4px 8px; background: #2a7cff; border-radius: 4px; font-size: 12px; }';
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    },

    bindClicks() {
      const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

      bind('btnSend', () => {
        const el = document.getElementById('editor');
        if (el && el.innerText.trim()) {
          window.protocol.sendMsg(el.innerText.trim());
          el.innerText = '';
        }
      });

      bind('btnToggleLog', () => {
        const el = document.getElementById('miniLog');
        if (el) el.style.display = (el.style.display === 'flex') ? 'none' : 'flex';
      });
      
      const logEl = document.getElementById('logContent');
      if (logEl) {
          logEl.addEventListener('contextmenu', (e) => {
              const selection = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(logEl);
              selection.removeAllRanges();
              selection.addRange(range);
          });
      }
      
      bind('btnDlLog', () => {
        const el = document.getElementById('logContent');
        if (!el) return;
        const text = (window.logSystem && window.logSystem.fullHistory) ? window.logSystem.fullHistory.join('\n') : 'Log Error';
        if (window.ui && window.ui.downloadBlob) {
            window.ui.downloadBlob(btoa(unescape(encodeURIComponent(text))), 'p1_log.txt');
        }
      });

      bind('btnSettings', () => {
        document.getElementById('settings-panel').style.display = 'grid';
        document.getElementById('iptNick').value = window.state.myName;
      });
      bind('btnCloseSettings', () => document.getElementById('settings-panel').style.display = 'none');
      
      bind('btnSave', () => {
        const n = document.getElementById('iptNick').value.trim();
        if (n) {
          window.state.myName = n;
          localStorage.setItem('nickname', n);
          if (window.ui) window.ui.updateSelf();
        }
        document.getElementById('settings-panel').style.display = 'none';
      });

      bind('btnFile', () => document.getElementById('fileInput').click());
      const fi = document.getElementById('fileInput');
      if (fi) {
        fi.onchange = (e) => {
          const file = e.target.files[0];
          if (!file) return;

          const editor = document.getElementById('editor');
          if (editor) editor.innerText = `⏳ 准备发送: ${file.name}`;

          const kind = file.type.startsWith('image/') ? CHAT.KIND_IMAGE : CHAT.KIND_FILE;
          
          window.protocol.sendMsg(null, kind, {
              fileObj: file, 
              name: file.name,
              size: file.size,
              type: file.type
          });
          
          if (editor) editor.innerText = '';
          if(window.monitor) window.monitor.info('UI', `选择文件: ${file.name}`);
          
          e.target.value = '';
        };
      }

      bind('btnBack', () => { 
          window.state.activeChat = null; 
          document.getElementById('sidebar').classList.remove('hidden'); 
          const log = document.getElementById('miniLog'); 
          if(log) log.style.display = 'none'; 
      });

      const contactListEl = document.getElementById('contactList');
      if (contactListEl) {
        contactListEl.addEventListener('click', e => {
          const item = e.target.closest('.contact-item');
          if (item && window.ui) {
             const id = item.getAttribute('data-chat-id');
             const name = item.getAttribute('data-chat-name');
             window.state.activeChat = id;
             window.state.activeChatName = name;
             window.state.unread[id] = 0;
             localStorage.setItem('p1_unread', JSON.stringify(window.state.unread));
             window.state.oldestTs = Infinity;
             document.getElementById('chatTitle').innerText = name;
             document.getElementById('chatStatus').innerText = (id === CHAT.PUBLIC_ID) ? '全员' : '私聊';
             if (window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
             window.ui.clearMsgs();
             window.state.loading = false;
             if(window.app) window.app.loadHistory(50);
             window.ui.renderList();
          }
        });
      }
    },

    bindMsgEvents() {
      document.querySelectorAll('.msg-bubble').forEach(el => {
         if (el.dataset.bound) return;
         el.dataset.bound = 'true';
         el.addEventListener('contextmenu', (e) => {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            selection.removeAllRanges();
            selection.addRange(range);
         });
      });
    }
  };
  
  window.uiEvents.init();
}