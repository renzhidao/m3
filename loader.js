// Loader v1.2 - Safe Boot (Timeout Protection)
console.log('🚀 Loader: 启动中 (Safe Mode)...');

const FALLBACK_MODULES = ["monitor", "constants", "utils", "state", "db", "smart-core", "protocol", "p2p", "hub", "mqtt", "ui-render", "ui-events"];

// 超时辅助函数
const waitWithTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
]);

async function boot() {
    // === 0. 尝试注册 SW (带超时保护) ===
    if ('serviceWorker' in navigator) {
        try {
            console.log('🔄 Loader: 注册 Service Worker...');
            // 使用固定版本号，防止无限重装
            const reg = await navigator.serviceWorker.register('./sw.js?v=fix_boot');
            
            // 核心修复：最多等 2秒，等不到就跳过，防止死锁
            await waitWithTimeout(navigator.serviceWorker.ready, 2000);
            
            console.log('✅ Loader: SW 已就绪 (Active)');
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'PING' });
            }
        } catch (e) {
            console.warn('⚠️ Loader: SW 跳过 (超时或失败), 继续启动 App...', e.message);
        }
    }

    // === 1. 加载配置 (Fail-Safe) ===
    try {
        const cfg = await fetch('./config.json').then(r => r.json());
        window.config = cfg;
        console.log('✅ 配置文件已加载');
    } catch(e) {
        console.error('❌ Config Load Error:', e);
        // 如果配置文件都挂了，无法继续
        document.body.innerHTML = '<h3 style="color:red;padding:20px">配置加载失败，请检查网络</h3>';
        return;
    }

    // === 2. 获取模块列表 ===
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
        console.warn('Loader: Registry fallback.');
        modules = FALLBACK_MODULES;
    }

    // === 3. 串行加载模块 ===
    for (const mod of modules) {
        const path = `./modules/${mod}.js?v=fix_boot`; // 统一版本控制
        try {
            await import(path).then(m => {
                if (m.init) m.init();
            });
        } catch(e) {
            console.error(`❌ Module failed: ${mod}`, e);
        }
    }
    
    // === 4. 确保 App 启动 ===
    if (window.app && window.app.init && !window.app._inited) {
        console.log('Loader: Final check app start...');
        // app.init() 通常是幂等的，多调一次没事
    }

    console.log('🎉 Loader: 启动流程结束');
}

boot().catch(e => {
    console.error('🔥 BOOT CRASH:', e);
    alert('启动崩溃，请截图控制台');
});