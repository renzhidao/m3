// Loader v1.1 - SW Priority Fix
console.log('🚀 Loader: 启动中...');

const FALLBACK_MODULES = ["monitor", "constants", "utils", "state", "db", "smart-core", "protocol", "p2p", "hub", "mqtt", "ui-render", "ui-events"];

async function boot() {
    // === 0. 优先注册 Service Worker ===
    if ('serviceWorker' in navigator) {
        try {
            console.log('🔄 Loader: 注册 Service Worker...');
            const reg = await navigator.serviceWorker.register('./sw.js?t=' + Date.now());
            
            // 等待 SW 激活 (关键修复)
            await navigator.serviceWorker.ready;
            console.log('✅ Loader: SW 已就绪 (Active)');
            
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'PING' });
            }
        } catch (e) {
            console.error('❌ Loader: SW 注册失败', e);
        }
    }

    // 1. 加载配置
    try {
        const cfg = await fetch('./config.json').then(r => r.json());
        window.config = cfg;
        console.log('✅ 配置文件已加载');
    } catch(e) {
        console.error('❌ 无法加载 config.json', e);
        alert('致命错误: 配置文件丢失');
        return;
    }

    // 2. 获取模块列表
    let modules = [];
    try {
        const res = await fetch('./registry.txt?t=' + Date.now()); 
        if(res.ok) {
            const text = await res.text();
            modules = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        } else {
            throw new Error('404');
        }
    } catch(e) {
        console.warn('Loader: Registry not found, using fallback.');
        modules = FALLBACK_MODULES;
    }

    // 3. 逐个加载模块并执行初始化
    for (const mod of modules) {
        const path = `./modules/${mod}.js?t=` + Date.now();
        try {
            const m = await import(path);
            if (m.init) {
                m.init();
            }
        } catch(e) {
            console.error(`❌ Module failed: ${mod}`, e);
        }
    }
    
    // 4. 显式调用 app.init (防止模块加载顺序问题)
    if (window.app && window.app.init && !window.app._inited) {
        // app.js 内部通常有自启动，这里作为保底
        console.log('Loader: 检查 App 启动状态...');
    }

    console.log('🎉 Loader: 所有模块加载完成');
}

boot().catch(e => console.error('Boot Failed:', e));

window.addEventListener('error', e => {
    console.error('Global Error:', e.error);
});
