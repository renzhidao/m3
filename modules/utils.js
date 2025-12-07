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
        window.util.log('💣 开始压力测试(模拟资源耗尽)...');
        let count = 0;
        const timer = setInterval(() => {
            if (!window.state.peer || window.state.peer.destroyed) {
                clearInterval(timer); return;
            }
            for(let i=0; i<50; i++) {
                count++;
                try { window.state.peer.connect('fake_' + count); } catch(e) {
                    window.util.log('💥 已爆内存: ' + e.message);
                    clearInterval(timer);
                    window.util.log('🚑 尝试触发自动救活...');
                    if(window.p2p) window.p2p.connectTo('trigger_fix');
                    return;
                }
            }
            if(count%500===0) window.util.log(`已堆积 ${count} 个连接`);
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
}