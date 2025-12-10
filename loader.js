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
            const reg = await navigator.serviceWorker.register('./sw.js?v=fix_boot_v2');
            
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
        // 如果配置文件都挂了，尝试使用默认空配置继续，而不是直接死掉
        window.config = { peer: {}, mqtt: {} }; 
        console.warn('⚠️ 使用空配置继续启动');
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
        // 使用时间戳确保加载最新文件
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
    
    // === 4. 确保 App 启动 ===
    if (window.app && window.app.init && !window.app._inited) {
        console.log('Loader: Final check app start...');
        // 如果 app.js 自己没调用 init (现在它应该调了)，这里是最后一道保险
    }

    console.log('🎉 Loader: 启动流程结束');
}

boot().catch(e => {
    console.error('🔥 BOOT CRASH:', e);
});

// 全局错误监听
window.addEventListener('error', e => {
    console.error('Global Error:', e.error);
});
