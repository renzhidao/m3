export function init() {
  console.log('📦 加载模块: Utils (Time-Sync Fix)');
  
  window.onerror = function(msg, url, line, col, error) {
    const info = `❌ [全局错误] ${msg} @ ${url}:${line}:${col}`;
    console.error(info, error);
    if (window.logSystem) window.logSystem.add(info);
    return false;
  };

  window.logSystem = {
    history: JSON.parse(localStorage.getItem('p1_blackbox') || '[]'),
    fullHistory: [],
    _lastMsg: null,
    _repeatCount: 0,
    
    add(text) {
      if (typeof text === 'object') text = JSON.stringify(text);
      
      const el = document.getElementById('logContent');
      
      // === 实时折叠逻辑 ===
      if (text === this._lastMsg) {
        this._repeatCount++;
        if (el && el.firstChild) {
          let countSpan = el.firstChild.querySelector('.log-count');
          if (!countSpan) {
             countSpan = document.createElement('span');
             countSpan.className = 'log-count';
             countSpan.style.color = '#ff0';
             countSpan.style.marginLeft = '8px';
             el.firstChild.appendChild(countSpan);
          }
          countSpan.innerText = `(x${this._repeatCount + 1})`;
        }
        return;
      }
      
      this._lastMsg = text;
      this._repeatCount = 0;
      
      const time = new Date().toLocaleTimeString();
      const msg = `[${time}] ${text}`;
      console.log(msg);
      
      this.fullHistory.push(msg);
      this.history.push(msg);
      if (this.history.length > 200) this.history.shift();
      try { localStorage.setItem('p1_blackbox', JSON.stringify(this.history)); } catch(e){}
      
      if (el) {
         const div = document.createElement('div');
         div.innerText = msg;
         div.style.borderBottom = '1px solid #333';
         el.prepend(div);
      }
    },
    
    clear() { this.history = []; localStorage.removeItem('p1_blackbox'); }
  };

  window.util = {
    log: (s) => window.logSystem.add(s),
    now() { return Date.now() + (window.state ? window.state.timeOffset : 0); },
    
    // === 修复：真实时间校准 ===
    async syncTime() { 
      try {
        const start = Date.now();
        // 请求 config.json 或当前页面，只为获取 Date 头
        const res = await fetch(location.href, { method: 'HEAD' });
        const dateStr = res.headers.get('Date');
        if (dateStr) {
            const serverTime = new Date(dateStr).getTime();
            const end = Date.now();
            const latency = (end - start) / 2;
            const realTime = serverTime + latency;
            window.state.timeOffset = realTime - end;
            window.util.log(`🕒 时间校准: 偏移 ${Math.round(window.state.timeOffset)}ms`);
        } else {
            // window.util.log('⚠️ 无法获取服务器时间，使用本地时间');
            window.state.timeOffset = 0;
        }
      } catch (e) {
        // window.util.log('⚠️ 校时请求失败: ' + e.message);
        window.state.timeOffset = 0;
      }
    },
    
    uuid: () => Math.random().toString(36).substr(2, 9),
    escape(s) { return String(s||'').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'); },
    colorHash(str) { return '#333'; },
    stressTest() { },
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

  setTimeout(() => {
    const crash = localStorage.getItem('p1_crash');
    if (crash) { try { window.util.log('⚠️ 上次崩溃: ' + JSON.parse(crash).msg); } catch(e){} }
  }, 1000);
}