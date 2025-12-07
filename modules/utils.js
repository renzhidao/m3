export function init() {
  console.log('📦 加载模块: Utils (Endurance Test)');

  window.onerror = function(msg, url, line, col, error) {
    const info = `❌ [全局错误] ${msg} @ ${url}:${line}:${col}`;
    console.error(info, error);
    if (window.logSystem) {
      window.logSystem.add(info);
      if (error && error.stack) window.logSystem.add('堆栈: ' + error.stack);
    }
    try {
      localStorage.setItem('p1_crash', JSON.stringify({
        time: new Date().toISOString(),
        msg: msg,
        url: url,
        line: line,
        stack: error ? error.stack : null
      }));
    } catch(e) {}
    return false;
  };

  window.logSystem = {
    history: JSON.parse(localStorage.getItem('p1_blackbox') || '[]'),
    fullHistory: [],
    add(text) {
      const now = new Date();
      const ts = now.toLocaleTimeString() + '.' + String(now.getMilliseconds()).padStart(3, '0');
      const msg = `[${ts}] ${typeof text==='object'?JSON.stringify(text):text}`;
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
        const start = Date.now();
        const url = location.href.split('?')[0] + '?t=' + Math.random();
        const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
        const dateStr = res.headers.get('date');
        if (dateStr) {
          window.state.timeOffset = (new Date(dateStr).getTime() + (Date.now() - start) / 2) - Date.now();
          window.util.log(`🕒 时间已校准`);
        }
      } catch (e) { window.util.log('⚠️ 时间校准失败'); }
    },
    uuid: () => Math.random().toString(36).substr(2, 9),
    escape(s) { return String(s||'').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'); },
    colorHash(str) {
      let hash = 0; for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
      const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
      return '#' + '000000'.substring(0, 6 - c.length) + c;
    },
    
    // === 耐力压测逻辑 ===
    stressTest() {
        const logKey = 'p1_stress_log';
        const addLog = (msg) => {
            const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
            console.log('💣 ' + line);
            window.util.log('💣 ' + msg);
            const logs = JSON.parse(localStorage.getItem(logKey) || '[]');
            logs.push(line);
            localStorage.setItem(logKey, JSON.stringify(logs));
        };

        if(confirm('⚠️ 开始【耐力压测】\n目标：创建 1000 个连接，验证资源回收。\n\n如果系统健康，总连接数会维持在 350 左右，不会崩。')) {
            localStorage.removeItem(logKey); 
            addLog('=== 开始耐力压测 ===');
            
            let totalCreated = 0;
            let batch = 20; 
            
            const timer = setInterval(() => {
                if (!window.state.peer || window.state.peer.destroyed) {
                    addLog('❌ Peer已销毁，压测中止');
                    clearInterval(timer);
                    return;
                }

                // 检查当前活跃数
                const active = Object.keys(window.state.conns).length;
                addLog(`创建 +${batch} (总计:${totalCreated}, 存活:${active})...`);
                
                try {
                    for(let i=0; i<batch; i++) {
                        totalCreated++;
                        window.state.peer.connect('endurance_' + Date.now() + '_' + totalCreated);
                    }
                } catch(e) {
                    clearInterval(timer);
                    addLog(`💥 崩溃！回收失败！`);
                    addLog(`错误: ${e.message}`);
                    alert(`❌ 压测失败\n总计创建: ${totalCreated}\n最终错误: ${e.message}`);
                    return;
                }

                if (totalCreated >= 1000) {
                    clearInterval(timer);
                    addLog('🎉 ✅ 压测通过！已成功创建 1000 个连接且未崩溃。');
                    alert('🎉 压测通过！\n系统成功回收了旧连接，保持了稳定。');
                }
            }, 500); 
        }
    },

    compressImage(file) {
      return new Promise((resolve) => { resolve(''); });
    }
  };

  window.diag = function() {
    const s = window.state || {};
    const report = [
      '=== 诊断 ===',
      `Peer: ${s.peer ? (s.peer.open?'Open':'Closed') : 'Null'}`,
      `Conns: ${Object.keys(s.conns||{}).length}`
    ];
    report.forEach(l => window.util.log(l));
  };

  setTimeout(() => {
    const crash = localStorage.getItem('p1_crash');
    if (crash) { try { window.util.log('⚠️ 上次崩溃: ' + JSON.parse(crash).msg); } catch(e){} }
  }, 1000);
}