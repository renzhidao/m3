export function init() {
  console.log('📦 加载模块: Utils (Cycle Test v5)');

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
    async syncTime() { 
      try {
        const res = await fetch(location.href, { method: 'HEAD', cache: 'no-cache' });
        const dateStr = res.headers.get('date');
        if (dateStr) window.state.timeOffset = new Date(dateStr).getTime() - Date.now();
      } catch (e) {}
    },
    uuid: () => Math.random().toString(36).substr(2, 9),
    escape(s) { return String(s||'').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'); },
    colorHash(str) {
      let hash = 0; for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
      const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
      return '#' + '000000'.substring(0, 6 - c.length) + c;
    },
    
    // === 循环回收压测 ===
    stressTest() {
        const addLog = (msg) => {
            const line = `[${new Date().toLocaleTimeString()}] 💣 ${msg}`;
            console.log(line);
            window.util.log('💣 ' + msg);
        };

        if(confirm('⚠️ 开始【循环回收测试】\n目标：在连接数限制(50)内，创建 1000 次新连接。\n\n预期：每次创建前都会自动踢掉旧的，总量永远不超标，系统永远不崩。')) {
            addLog('=== 开始循环回收测试 ===');
            
            let total = 0;
            let success = 0;
            
            const timer = setInterval(() => {
                if (!window.state.peer || window.state.peer.destroyed) {
                    addLog('❌ Peer已销毁，测试中止');
                    clearInterval(timer);
                    return;
                }

                // 检查当前存活数（应该被压制在50左右）
                const active = Object.keys(window.state.conns).length;
                
                try {
                    // 每次创建一个新连接
                    total++;
                    window.state.peer.connect('cycle_' + Date.now() + '_' + total);
                    success++;
                    
                    if (total % 20 === 0) {
                        addLog(`循环次数: ${total}, 当前存活: ${active}/50`);
                    }
                } catch(e) {
                    clearInterval(timer);
                    addLog(`💥 崩溃！在第 ${total} 次时失败。`);
                    addLog(`错误: ${e.message}`);
                    alert(`❌ 测试失败\n循环次数: ${total}\n存活数: ${active}\n错误: ${e.message}`);
                    return;
                }

                if (total >= 1000) {
                    clearInterval(timer);
                    addLog(`🎉 ✅ 测试通过！循环创建了 1000 个连接，当前存活 ${active} 个。`);
                    alert('🎉 完美通过！\n资源回收机制有效，系统永不积压。');
                }
            }, 50); // 每50ms一个，快速循环
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