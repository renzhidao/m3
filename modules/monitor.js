export function init() {
    console.log('📦 加载模块: Monitor (Instant Init)');
    
    // 1. 立即构建核心对象，防止其他模块调用报错
    window.monitor = {
        logs: [],
        
        log(level, module, msg, data) {
            const entry = { ts: new Date(), level, module, msg, data };
            this.logs.push(entry);
            if (this.logs.length > 500) this.logs.shift();
            
            // 尝试更新 UI，如果 UI 还没好，就先存着
            this.appendLine(entry);
            
            if (level === 'ERROR' || level === 'FATAL') console.error(`[${module}] ${msg}`, data);
            else console.log(`[${module}] ${msg}`);
        },
        
        info(mod, msg, d) { this.log('INFO', mod, msg, d); },
        warn(mod, msg, d) { this.log('WARN', mod, msg, d); },
        error(mod, msg, d) { this.log('ERROR', mod, msg, d); },
        fatal(mod, msg, d) { this.log('FATAL', mod, msg, d); },
        
        show() {
            const p = document.getElementById('monitor-panel');
            if(p) {
                p.style.display = 'flex';
                this.updateStats();
            }
        },
        
        updateStats() {
            if (!document.getElementById('monitor-panel') || document.getElementById('monitor-panel').style.display === 'none') return;
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
            ta.value = line + '\n' + ta.value;
        }
    };

    // 2. 延迟注入 DOM (不影响核心逻辑)
    setTimeout(() => {
        if (document.getElementById('monitor-panel')) return;
        
        const panel = document.createElement('div');
        panel.id = 'monitor-panel';
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
            <span>流任务: <b id="st-task">0</b></span>
            <span>内存: <b id="st-mem">-</b></span>
          </div>
          <textarea class="mon-text" id="monText" readonly spellcheck="false"></textarea>
        `;
        
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
        
        if (document.body) {
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
            
            // 自动加载历史日志
            window.monitor.logs.forEach(l => window.monitor.appendLine(l));
        }
    }, 500);
    
    // 3. 监听 SW 日志
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', event => {
            const d = event.data;
            if (d && d.type === 'SW_LOG') {
                window.monitor.log(d.level, 'SW-CORE', d.msg, {reqId: d.requestId ? d.requestId.slice(-4) : 'N/A'});
            }
        });
    }
    
    setInterval(() => window.monitor.updateStats(), 2000);
}