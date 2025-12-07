export function init() {
  console.log('📦 加载模块: Utils (DiagMaster v2)');

  // ========== 全局错误捕捉 ==========
  window.onerror = function(msg, url, line, col, error) {
    const info = `❌ [全局错误] ${msg} @ ${url}:${line}:${col}`;
    console.error(info, error);
    if (window.logSystem) {
      window.logSystem.add(info);
      if (error && error.stack) window.logSystem.add('堆栈: ' + error.stack);
    }
    // 保存崩溃快照
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
          isHub: window.state.isHub,
          connCount: Object.keys(window.state.conns || {}).length,
          peerExists: !!window.state.peer,
          peerDestroyed: window.state.peer ? window.state.peer.destroyed : null
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

  // ========== 日志系统 ==========
  window.logSystem = {
    history: JSON.parse(localStorage.getItem('p1_blackbox') || '[]'),
    fullHistory: [], // 完整历史（不限制条数，用于下载）
    
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
        const div = document.createElement('div'); 
        div.innerText = msg; 
        div.style.borderBottom = '1px solid #333';
        el.prepend(div);
      }
    },
    
    clear() {
      this.history = [];
      this.fullHistory = [];
      localStorage.removeItem('p1_blackbox');
    }
  };

  // ========== 工具函数 ==========
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

  // ========== 诊断命令 ==========
  window.diag = function() {
    const s = window.state || {};
    const peer = s.peer;
    const conns = s.conns || {};
    
    const report = [
      '========== P1 诊断报告 ==========',
      `时间: ${new Date().toISOString()}`,
      '',
      '--- Peer状态 ---',
      `myId: ${s.myId}`,
      `peer存在: ${!!peer}`,
      `peer.id: ${peer ? peer.id : 'N/A'}`,
      `peer.open: ${peer ? peer.open : 'N/A'}`,
      `peer.destroyed: ${peer ? peer.destroyed : 'N/A'}`,
      `peer.disconnected: ${peer ? peer.disconnected : 'N/A'}`,
      '',
      '--- MQTT状态 ---',
      `mqttStatus: ${s.mqttStatus}`,
      `mqttClient存在: ${!!s.mqttClient}`,
      `mqttClient.isConnected: ${s.mqttClient ? s.mqttClient.isConnected() : 'N/A'}`,
      '',
      '--- Hub状态 ---',
      `isHub: ${s.isHub}`,
      `hubIndex: ${s.hubIndex}`,
      `hubPeer存在: ${!!s.hubPeer}`,
      '',
      '--- 连接列表 ---',
      `总连接数: ${Object.keys(conns).length}`
    ];
    
    Object.keys(conns).forEach(pid => {
      const c = conns[pid];
      report.push(`  ${pid.slice(0,8)}: open=${c.open}, lastPong=${c.lastPong ? (Date.now()-c.lastPong)+'ms前' : 'N/A'}`);
    });
    
    report.push('');
    report.push('--- 内存状态 ---');
    report.push(`seenMsgs: ${s.seenMsgs ? s.seenMsgs.size : 0}`);
    report.push(`contacts: ${Object.keys(s.contacts || {}).length}`);
    report.push(`unread: ${JSON.stringify(s.unread || {})}`);
    
    // 检查上次崩溃
    const crash = localStorage.getItem('p1_crash');
    if (crash) {
      report.push('');
      report.push('--- ⚠️ 上次崩溃记录 ---');
      try {
        const c = JSON.parse(crash);
        report.push(`时间: ${c.time}`);
        report.push(`错误: ${c.msg}`);
        report.push(`位置: ${c.url}:${c.line}`);
        if (c.stack) report.push(`堆栈: ${c.stack.slice(0, 200)}`);
      } catch(e) {}
    }
    
    report.push('================================');
    
    const text = report.join('\\n');
    console.log(text);
    window.util.log('📊 诊断报告已生成(见控制台)');
    
    // 同时输出到日志面板
    report.forEach(line => window.util.log(line));
    
    return text;
  };

  // ========== 启动时检查上次崩溃 ==========
  setTimeout(() => {
    const crash = localStorage.getItem('p1_crash');
    if (crash) {
      try {
        const c = JSON.parse(crash);
        window.util.log('⚠️ 检测到上次崩溃: ' + c.msg);
        window.util.log('⚠️ 崩溃时间: ' + c.time);
      } catch(e) {}
    }
  }, 1000);
}