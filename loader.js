// Loader v2.1 - Runtime Diagnostic
// 包含启动诊断 + P2P 实时监控面板

// === UI: 实时诊断面板 ===
const debugPanel = {
    el: null,
    init() {
        if (document.getElementById('p2p-monitor')) return;
        const div = document.createElement('div');
        div.id = 'p2p-monitor';
        div.style.position = 'fixed';
        div.style.top = '0';
        div.style.right = '0';
        div.style.width = '200px'; // 稍微窄一点，不挡操作
        div.style.maxHeight = '150px';
        div.style.background = 'rgba(0,0,0,0.8)';
        div.style.color = '#0f0';
        div.style.zIndex = '100000';
        div.style.fontSize = '10px';
        div.style.fontFamily = 'monospace';
        div.style.overflowY = 'auto';
        div.style.pointerEvents = 'none'; // 允许点击穿透
        div.style.padding = '4px';
        div.innerHTML = '<div style="border-bottom:1px solid #444;margin-bottom:2px">📡 P2P 实时监控</div>';
        document.body.appendChild(div);
        this.el = div;
    },
    log(msg, type='info') {
        if (!this.el) this.init();
        const line = document.createElement('div');
        line.innerText = `[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`;
        if (type === 'error') line.style.color = '#f55';
        if (type === 'warn') line.style.color = '#fa0';
        if (type === 'tx') line.style.color = '#aaf'; // 发送
        if (type === 'rx') line.style.color = '#afa'; // 接收
        this.el.appendChild(line);
        this.el.scrollTop = this.el.scrollHeight;
        // 自动清理
        if (this.el.childElementCount > 20) this.el.removeChild(this.el.children[1]);
    }
};

// 暴露给全局
window.visualLog = (msg, type) => debugPanel.log(msg, type);

// === 之前的启动逻辑 ===
const LOAD_ORDER = ["monitor", "constants", "utils", "state", "db", "protocol", "smart-core", "p2p", "mqtt", "hub", "ui-render", "ui-events"];

async function boot() {
    debugPanel.init();
    debugPanel.log('Loader: 系统启动...', 'warn');

    // 1. 加载配置
    try {
        window.config = await fetch('./config.json').then(r => r.json());
    } catch(e) { window.config = { peer: {}, mqtt: {} }; }

    // 2. 加载模块
    for (const mod of LOAD_ORDER) {
        try {
            const m = await import(`./modules/${mod}.js?t=` + Date.now());
            if (m.init) m.init();
        } catch(e) {
            debugPanel.log(`❌ ${mod} 失败: ${e.message}`, 'error');
            console.error(e);
        }
    }
    
    // 3. 启动 App
    try {
        const appMod = await import('./app.js?t=' + Date.now());
        if (appMod.init) appMod.init();
        else if (window.app && window.app.init) window.app.init();
        debugPanel.log('✅ 系统就绪', 'info');
    } catch(e) {
        debugPanel.log(`❌ App 启动失败`, 'error');
    }
}

boot();
