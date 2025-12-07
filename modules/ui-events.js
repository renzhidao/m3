import { CHAT, UI_CONFIG } from './constants.js';

export function init() {
  console.log('📦 加载模块: UI Events (交互优化版)');
  
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
        // 使用新修好的下载器
        if (window.ui && window.ui.downloadBlob) {
            window.ui.downloadBlob(btoa(unescape(encodeURIComponent(text))), 'p1_log.txt');
        } else {
            alert('下载模块未就绪');
        }
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

      // === 核心修复：文件/图片上传逻辑 (带进度提示) ===
      bind('btnFile', () => document.getElementById('fileInput').click());
      const fi = document.getElementById('fileInput');
      if (fi) {
        fi.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;

          // 1. 立即给用户反馈
          const editor = document.getElementById('editor');
          const oldText = editor ? editor.innerText : '';
          if (editor) editor.innerText = `⏳ 正在读取: ${file.name}...`;
          window.util.log(`⏳ 开始处理文件: ${file.name} (${(file.size/1024).toFixed(0)}KB)`);

          try {
              const isBigImage = file.type.startsWith('image/') && file.size > 1024 * 1024; // 1MB以上算大图
              
              if (file.type.startsWith('image/') && !isBigImage) {
                // 小图：压缩发送
                window.util.log('图片压缩中...');
                const b64 = await window.util.compressImage(file);
                window.protocol.sendMsg(b64, CHAT.KIND_IMAGE);
                if (editor) editor.innerText = ''; 
              } else {
                // 大图 或 普通文件
                const reader = new FileReader();
                reader.readAsDataURL(file);
                
                reader.onload = () => {
                   const b64 = reader.result;
                   const type = file.type.startsWith('image/') ? CHAT.KIND_IMAGE : CHAT.KIND_FILE;
                   
                   window.protocol.sendMsg(b64, type, {
                     name: file.name,
                     size: file.size,
                     type: file.type
                   });
                   window.util.log('✅ 读取完成，发送中...');
                   if (editor) editor.innerText = ''; // 清空提示
                };
                
                reader.onerror = () => {
                    window.util.log('❌ 读取文件失败');
                    if (editor) editor.innerText = '❌ 读取失败';
                };
              }
          } catch(err) {
              window.util.log('❌ 处理错误: ' + err.message);
              if (editor) editor.innerText = '';
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