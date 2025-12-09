export function init() {
    console.log('📦 加载模块: Monitor (Text Mode)');
    
    // 注入 DOM
    const panel = document.createElement('div');
    panel.id = 'monitor-panel';
    // 改用 flex 布局 + textarea
    panel.innerHTML = `
      <div class="mon-header">
        <span class="mon-title">🐞 系统诊断</span>
        <div>
            <button class="mon-btn" id="btnMonDl">📥 下载</button>
            <button class="mon-btn" id="btnMonClear">🚫 清空</button>
            <span class="mon-close" id="btnMonClose">✖</span>
        </div>
      </div>
      <div class="mon-stats" id="monStats">
        <span>连接: <b id="st-conn">0</b></span>
        <span>任务: <b id="st-task">0</b></span>
        <span>内存: <b id="st-mem">-</b></span>
      </div>
      <!-- 使用 textarea 实现原生全选复制 -->
      <textarea class="mon-text" id="monText" readonly spellcheck="false"></textarea>
    `;
    
    // 追加样式到 style 标签 (简单内联)
    const style = document.createElement('style');
    style.textContent = `
        .mon-text { 
            flex: 1; background: #000; color: #0f0; border: none; 
            padding: 10px; font-family: monospace; font-size: 11px; resize: none; outline: none;
        }
        .mon-btn {
            background: #333; color: #fff; border: 1px solid #555; 
            padding: 2px 8px; font-size: 11px; cursor: pointer; margin-right: 5px;
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);
    
    document.getElementById('btnMonClose').onclick = () => panel.style.display = 'none';
    document.getElementById('btnMonClear').onclick = () => {
        document.getElementById('monText').value = '';
        window.monitor.logs = [];
    };
    document.getElementById('btnMonDl').onclick = () => {
        const text = document.getElementById('monText').value;
        const blob = new Blob([text], {type: 'text/plain'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `p1_diag_${Date.now()}.log`;
        a.click();
    };

    window.monitor = {
        logs: [],
        
        log(level, module, msg, data) {
            const entry = { ts: new Date(), level, module, msg, data };
            this.logs.push(entry);
            if (this.logs.length > 500) this.logs.shift();
            
            this.appendLine(entry);
            
            // 控制台保留原生对象
            if (level === 'ERROR' || level === 'FATAL') console.error(`[${module}] ${msg}`, data);
            else console.log(`[${module}] ${msg}`);
        },
        
        info(mod, msg, d) { this.log('INFO', mod, msg, d); },
        warn(mod, msg, d) { this.log('WARN', mod, msg, d); },
        error(mod, msg, d) { this.log('ERROR', mod, msg, d); },
        fatal(mod, msg, d) { this.log('FATAL', mod, msg, d); },
        
        show() {
            document.getElementById('monitor-panel').style.display = 'flex';
            this.updateStats();
        },
        
        updateStats() {
            if (document.getElementById('monitor-panel').style.display === 'none') return;
            const peers = window.state ? Object.keys(window.state.conns).length : 0;
            const tasks = window.activeStreams ? window.activeStreams.size : 0;
            document.getElementById('st-conn').innerText = peers;
            document.getElementById('st-task').innerText = tasks;
            if (window.performance && window.performance.memory) {
                const mem = (window.performance.memory.usedJSHeapSize / 1048576).toFixed(0);
                document.getElementById('st-mem').innerText = mem + ' MB';
            }
        },
        
        appendLine(e) {
            const ta = document.getElementById('monText');
            if (!ta) return;
            
            const time = e.ts.toTimeString().split(' ')[0];
            let line = `[${time}] [${e.level}] [${e.module}] ${e.msg}`;
            if (e.data) {
                try { line += ' ' + JSON.stringify(e.data); } catch(err) {}
            }
            
            // 错误引导附加
            if (e.level === 'ERROR' || e.msg.includes('Timeout')) {
                 if (e.msg.includes('Timeout')) line += ' >>> 建议: 检查对方是否在线';
                 if (e.msg.includes('Meta')) line += ' >>> 建议: 刷新页面';
            }
            
            ta.value = line + '\n' + ta.value; // 最新在最前
        }
    };
    
    setInterval(() => window.monitor.updateStats(), 2000);
}
