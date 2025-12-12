import { CHAT, UI_CONFIG } from './constants.js';

export function init() {
  window.uiEvents = {
    init() {
      this.bindClicks();
      this.bindDelegation();
      this.addDiagBtn();
    },
    
    addDiagBtn() {
        const box = document.querySelector('.settings-box');
        if (box && !document.getElementById('btnNetDiag')) {
            const btn = document.createElement('button');
            btn.id = 'btnNetDiag';
            btn.className = 'st-btn';
            btn.style.background = '#607d8b';
            btn.style.marginTop = '10px';
            btn.innerText = '📡 网络诊断';
            btn.onclick = () => {
                if (window.smartCore && window.smartCore.runDiag) {
                    window.smartCore.runDiag();
                    alert('诊断已开始，请查看日志');
                    document.getElementById('settings-panel').style.display = 'none';
                    document.getElementById('miniLog').style.display = 'flex';
                }
            };
            box.appendChild(btn);
        }
    },

    bindDelegation() {
        const list = document.getElementById('msgList');
        if (!list) return;
        list.addEventListener('click', (e) => {
            if (e.target.classList.contains('chat-img')) {
                e.stopPropagation();
                // 预览逻辑
            }
        });
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
      
      // === 新增：复制日志按钮 ===
      const logBar = document.querySelector('.log-bar');
      if (logBar && !document.getElementById('btnCopyLog')) {
          const btn = document.createElement('button');
          btn.id = 'btnCopyLog';
          btn.className = 'log-btn';
          btn.innerText = '📋 复制';
          btn.style.marginRight = '10px';
          btn.onclick = () => {
              const el = document.getElementById('logContent');
              if(el) {
                  // 创建选区
                  const range = document.createRange();
                  range.selectNode(el);
                  window.getSelection().removeAllRanges();
                  window.getSelection().addRange(range);
                  // 执行复制
                  try {
                      document.execCommand('copy');
                      alert('日志已复制到剪贴板');
                  } catch(e) { alert('复制失败，请长按手动复制'); }
                  window.getSelection().removeAllRanges();
              }
          };
          logBar.prepend(btn);
      }

      bind('btnDlLog', () => {
        const el = document.getElementById('logContent');
        if (!el) return;
        if (window.ui && window.ui.downloadBlob) {
            window.ui.downloadBlob(el.innerText, 'p1_log.txt');
        }
      });

      bind('btnSettings', () => document.getElementById('settings-panel').style.display = 'grid');
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
    console.log('[UI] file chosen:', e.target && e.target.files && e.target.files[0] ? e.target.files[0].name : '(none)', 'has shareLocalFile:', !!(window.smartCore && window.smartCore.shareLocalFile));
const file = e.target.files[0];
    if (!file) return;
    const kind = file.type.startsWith('image/') ? CHAT.KIND_IMAGE : CHAT.KIND_FILE;
    if (window.smartCore && typeof window.smartCore.shareLocalFile === 'function') {
      window.smartCore.shareLocalFile(file);
    } else {
      // 兜底：即便拦截异常，也避免 [空消息]
      window.protocol.sendMsg(`[文件] ${file.name}`, kind, {
        fileObj: file, name: file.name, size: file.size, type: file.type
      });
    }
    e.target.value = '';};
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
    }
  };
  window.uiEvents.init();
}
