import { CHAT, UI_CONFIG } from './constants.js';

export function init() {
  console.log('📦 加载模块: UI Events (Fixed & Unlimited)');
  
  window.uiEvents = {
    init() {
      this.bindClicks();
      this.bindMsgEvents(); 
      this.injectStyles();
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

      // 发送按钮
      bind('btnSend', () => {
        const el = document.getElementById('editor');
        if (el && el.innerText.trim()) {
          window.protocol.sendMsg(el.innerText.trim());
          el.innerText = '';
        }
      });

      // 开关日志
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
        const blob = new Blob([text], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'p1_log.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });

      // 设置面板
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

      // === 关键修改：文件/图片上传逻辑 ===
      bind('btnFile', () => document.getElementById('fileInput').click());
      const fi = document.getElementById('fileInput');
      if (fi) {
        fi.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;

          // 策略：如果图片很大 (>500KB)，不压缩，直接发原图
          // 如果图片很小，走压缩以节省空间
          const isBigImage = file.type.startsWith('image/') && file.size > 500 * 1024;
          
          if (file.type.startsWith('image/') && !isBigImage) {
            // 小图：走压缩 (秒传)
            window.util.log('发送小图(压缩)...');
            const b64 = await window.util.compressImage(file);
            window.protocol.sendMsg(b64, CHAT.KIND_IMAGE);
          } else {
            // 大图 或 普通文件：读取原始数据 (Base64)
            // 彻底移除了 5MB 限制
            window.util.log(`读取原文件: ${file.name} (${(file.size/1024).toFixed(0)}KB)`);
            
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => {
               const b64 = reader.result;
               // 如果是图片，依然标记为 IMAGE，但内容是原图 Base64
               // Smart Core 会识别它并生成高清预览
               const type = file.type.startsWith('image/') ? CHAT.KIND_IMAGE : CHAT.KIND_FILE;
               
               window.protocol.sendMsg(b64, type, {
                 name: file.name,
                 size: file.size,
                 type: file.type
               });
               window.util.log('📤 数据已提交');
            };
            reader.onerror = () => window.util.log('❌ 读取文件失败');
          }
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