// Loader v1.3 - Emergency Simple Boot
console.log('🚀 Loader: 简单模式启动...');

// 确保 Protocol 在 SmartCore 之前加载 (Fallback列表)
const FALLBACK_MODULES = ["monitor", "constants", "utils", "state", "db", "protocol", "smart-core", "p2p", "hub", "mqtt", "ui-render", "ui-events"];

async function boot() {
    // 1. 加载配置
    try {
        const cfg = await fetch('./config.json').then(r => r.json());
        window.config = cfg;
    } catch(e) {
        window.config = { peer: {}, mqtt: {} };
    }

    // 2. 获取模块列表
    let modules = [];
    try {
        const res = await fetch('./registry.txt?t=' + Date.now()); 
        if(res.ok) {
            const text = await res.text();
            modules = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        } else { throw new Error('404'); }
    } catch(e) {
        console.warn('Loader: Registry fallback.');
        modules = FALLBACK_MODULES;
    }

    // 3. 串行加载
    for (const mod of modules) {
        const path = `./modules/${mod}.js?t=` + Date.now();
        try {
            const m = await import(path);
            if (m.init) m.init();
        } catch(e) {
            console.error(`❌ Module failed: ${mod}`, e);
        }
    }
    
    // 4. 启动 App
    if (window.app && window.app.init && !window.app._inited) {
        // App 内部会调用 init
    }
    console.log('🎉 Loader: Done');
}
boot().catch(e => console.error('Boot Error', e));
