export function init() {
    console.log('📦 加载模块: Monitor (诊断系统)');
    
    // 注入 DOM
    const panel = document.createElement('div');
    panel.id = 'monitor-panel';
    panel.innerHTML = `
      <div class="mon-header">
        <span class="mon-title">🐞 系统诊断</span>
        <span class="mon-close" id="btnMonClose">关闭</span>
      </div>
      <div class="mon-stats" id="monStats">
        <span>连接: <b id="st-conn">0</b></span>
        <span>任务: <b id="st-task">0</b></span>
        <span>内存: <b id="st-mem">-</b></span>
      </div>
      <div class="mon-list" id="monList"></div>
    `;
    document.body.appendChild(panel);
    
    document.getElementById('btnMonClose').onclick = () => panel.style.display = 'none';

    window.monitor = {
        logs: [],
        
        // 核心日志入口
        log(level, module, msg, data) {
            const entry = {
                ts: new Date(),
                level,
                module,
                msg,
                data
            };
            this.logs.push(entry);
            if (this.logs.length > 200) this.logs.shift();
            
            this.renderItem(entry);
            
            if (level === 'ERROR' || level === 'FATAL') {
                console.error(`[${module}] ${msg}`, data);
                // 错误自救建议
                this.analyzeError(entry);
            } else {
                console.log(`[${module}] ${msg}`);
            }
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
        
        renderItem(e) {
            const list = document.getElementById('monList');
            if (!list) return;
            
            const div = document.createElement('div');
            div.className = 'mon-item';
            
            const time = e.ts.toTimeString().split(' ')[0];
            let html = `<span class="mon-time">${time}</span><span class="mon-tag ${e.level}">${e.level}</span>[${e.module}] ${e.msg}`;
            
            if (e.suggestion) {
                html += `<div class="mon-suggestion">💡 建议: ${e.suggestion}</div>`;
            }
            
            div.innerHTML = html;
            list.prepend(div); // 最新在最上
        },
        
        analyzeError(e) {
            let sug = '';
            if (e.msg.includes('Timeout')) sug = '网络拥塞，正在自动重试，请检查对方是否在线';
            else if (e.msg.includes('Meta')) sug = '文件元数据丢失，请刷新页面后重试';
            else if (e.msg.includes('RTC')) sug = 'P2P连接断开，正在尝试重连';
            else if (e.msg.includes('Quota') || e.msg.includes('Memory')) sug = '内存不足，请关闭一些页面或减少任务';
            
            if (sug) {
                e.suggestion = sug;
                // 重新渲染带建议的
                const list = document.getElementById('monList');
                if (list && list.firstChild) {
                    list.removeChild(list.firstChild);
                    this.renderItem(e);
                }
            }
        }
    };
    
    // 定时刷新状态
    setInterval(() => window.monitor.updateStats(), 2000);
}
