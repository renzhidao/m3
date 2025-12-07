export function init() {
  console.log('📦 加载模块: Utils (DiagMaster v2)');

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
        stack: error ? error.stack : null,
        state: window.state ? {
          myId: window.state.myId,
          mqttStatus: window.state.mqttStatus,
          connCount: Object.keys(window.state.conns || {}).length
        } : null
      }));
    } catch(e) {}
    return false;
  };

  window.addEventListener('unhandledrejection', function(e) {
    const info = `❌ [Promise异常] ${e.reason}`;
    console.error(info, e);
    if (window.logSystem) {
      window.logSystem.add(info);
      if (e.reason && e.reason.stack) window.logSystem.add('堆栈: ' + e.reason.stack);
    }
  });

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
      if (this.fullHistory.length > 2000) this.fullHistory.shift();
      try { localStorage.setItem('p1_blackbox', JSON.stringify(this.history)); } catch(e){}
      const el = document.getElementById('logContent'); 
      if (el) {
        const div = document.createElement('div'); div.innerText = msg; div.style.borderBottom = '1px solid #333';
        el.prepend(div);
      }
    },
    clear() {
      this.history = []; this.fullHistory = []; localStorage.removeItem('p1_blackbox');
    }
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

        if(confirm('⚠️ 即将开始阶梯式压测。
请不要关闭页面，直到出现崩溃提示。
刷新后日志会自动保留。')) {
            localStorage.removeItem(logKey); // 清空旧记录
            addLog('=== 开始阶梯式压测 ===');
            
            let total = 0;
            let batch = 20; // 每次20个
            
            const timer = setInterval(() => {
                if (!window.state.peer || window.state.peer.destroyed) {
                    addLog('❌ Peer已销毁，压测中止。当前总量: ' + total);
                    clearInterval(timer);
                    return;
                }

                addLog(`正在尝试创建 +${batch} 个连接 (当前: ${total})...`);
                
                try {
                    for(let i=0; i<batch; i++) {
                        total++;
                        // 使用无操作的 dummy 连接，仅占用配额
                        window.state.peer.connect('stress_test_' + Date.now() + '_' + total);
                    }
                } catch(e) {
                    clearInterval(timer);
                    addLog(`💥 崩溃触发！极限阈值 ≈ ${total}`);
                    addLog(`错误信息: ${e.message}`);
                    addLog('=== 测试结束，请刷新页面查看结果 ===');
                    alert(`测得极限连接数: ${total}
错误: ${e.message}`);
                }
            }, 500); // 每0.5秒一波
        }
    },
    
    showStressReport() {
        const logs = JSON.parse(localStorage.getItem('p1_stress_log') || '[]');
        if(logs.length > 0) {
            console.log(logs.join('
'));
            alert('📜 压测报告已输出到控制台，最近一条:
' + logs[logs.length-1]);
            // 也可以直接打到屏幕上
            logs.forEach(l => window.util.log(l));
        } else {
            alert('暂无压测记录');
        }
    }, 10);
    },
    compressImage(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
          const img = new Image();
          img.src = e.target.result;
          img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            const max = 800; 
            if (w > h && w > max) { h *= max/w; w = max; }
            else if (h > max) { w *= max/h; h = max; }
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.7));
          };
        };
      });
    }
  };

  window.diag = function() {
    // (保持原有诊断逻辑)
    const s = window.state || {};
    const peer = s.peer;
    const conns = s.conns || {};
    const report = [
      '=== 诊断报告 ===',
      `时间: ${new Date().toISOString()}`,
      `Peer: ${peer ? (peer.open?'Open':'Closed') : 'Null'}`,
      `MQTT: ${s.mqttStatus}`,
      `连接数: ${Object.keys(conns).length}`
    ];
    Object.keys(conns).forEach(pid => {
      const c = conns[pid];
      report.push(`  ${pid.slice(0,8)}: ${c.open?'Open':'Closed'}`);
    });
    const text = report.join('\n');
    console.log(text);
    report.forEach(line => window.util.log(line));
    return text;
  };

  setTimeout(() => {
    const crash = localStorage.getItem('p1_crash');
    if (crash) {
      try {
        const c = JSON.parse(crash);
        window.util.log('⚠️ 检测到上次崩溃: ' + c.msg);
      } catch(e) {}
    }
  }, 1000);
  setTimeout(() => {
    const logs = JSON.parse(localStorage.getItem('p1_stress_log') || '[]');
    if (logs.length > 0 && logs[logs.length-1].includes('崩溃')) {
        window.util.log('📊 发现上次压测记录，极限值: ' + logs[logs.length-2]);
    }
  }, 1500);
}