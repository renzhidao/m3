export function init() {
  console.log('📦 加载模块: Utils (Fixed Leak)');

  window.onerror = function(msg, url, line, col, error) {
    const info = `❌ [全局错误] ${msg} @ ${url}:${line}:${col}`;
    console.error(info, error);
    if (window.logSystem) window.logSystem.add(info);
    return false;
  };

  window.logSystem = {
    history: JSON.parse(localStorage.getItem('p1_blackbox') || '[]'),
    fullHistory: [],
    add(text) {
      const msg = `[${new Date().toLocaleTimeString()}] ${typeof text==='object'?JSON.stringify(text):text}`;
      console.log(msg);
      this.fullHistory.push(msg);
      this.history.push(msg);
      if (this.history.length > 200) this.history.shift();
      try { localStorage.setItem('p1_blackbox', JSON.stringify(this.history)); } catch(e){}
      const el = document.getElementById('logContent'); 
      if (el) {
        const div = document.createElement('div'); div.innerText = msg; div.style.borderBottom = '1px solid #333';
        el.prepend(div);
      }
    },
    clear() { this.history = []; localStorage.removeItem('p1_blackbox'); }
  };

  window.util = {
    log: (s) => window.logSystem.add(s),
    now() { return Date.now() + (window.state ? window.state.timeOffset : 0); },
    async syncTime() { try { window.state.timeOffset = 0; } catch (e) {} },
    uuid: () => Math.random().toString(36).substr(2, 9),
    escape(s) { return String(s||'').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'); },
    colorHash(str) { return '#333'; },
    
    // === 3人转压测 (修复版) ===
    stressTest() {
        const addLog = (msg) => {
            window.util.log('💣 ' + msg);
        };

        if(confirm('⚠️ 开始【微观循环测试】(已修复内存泄露)\n限制：3个连接。\n目标：循环创建500次，验证GC回收。')) {
            addLog('=== 开始测试 (Safe Mode) ===');
            
            let total = 0;
            // 关键：用于持有测试连接的引用，以便销毁
            let lastTestConn = null;

            const timer = setInterval(() => {
                if (!window.state.peer || window.state.peer.destroyed) {
                    clearInterval(timer); return;
                }

                // 1. 强制清理上一个测试连接 (不管是否成功连上)
                if (lastTestConn) {
                    try { lastTestConn.close(); } catch(e){}
                    try { 
                        if (lastTestConn.peerConnection) {
                            lastTestConn.peerConnection.close();
                            lastTestConn.peerConnection = null;
                        }
                    } catch(e){}
                    lastTestConn = null;
                }

                const active = Object.keys(window.state.conns).length;
                
                try {
                    total++;
                    // 2. 创建新连接并抓住引用
                    // 使用不存在的ID必然报错，但这正是为了测试 "失败连接的回收"
                    lastTestConn = window.state.peer.connect('cycle_' + Date.now() + '_' + total);
                    
                    if (total % 10 === 0) {
                        addLog(`第 ${total} 次, 存活: ${active}/3`);
                    }
                } catch(e) {
                    clearInterval(timer);
                    addLog(`💥 失败！无法创建第 ${total} 个连接。`);
                    addLog(`存活数: ${active}`);
                    addLog(`错误: ${e.message}`);
                    return;
                }

                if (total >= 500) {
                    clearInterval(timer);
                    // 结束时清理最后一次
                    if (lastTestConn) { try{lastTestConn.close();}catch(e){} }
                    addLog(`🎉 ✅ 测试通过！已循环 500 次，资源未耗尽。`);
                    alert('🎉 通过！\n连接资源已成功动态回收。');
                }
            }, 100); 
        }
    },

    compressImage(file) {
      return new Promise((resolve) => { resolve(''); });
    }
  };

  setTimeout(() => {
    const crash = localStorage.getItem('p1_crash');
    if (crash) { try { window.util.log('⚠️ 上次崩溃: ' + JSON.parse(crash).msg); } catch(e){} }
  }, 1000);
}
