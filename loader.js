// Loader v3.0 - SW Reset & Stable
console.log('🚀 Loader: 系统启动 (SW重置版)...');

const FALLBACK_MODULES = ["monitor", "constants", "utils", "state", "db", "protocol", "smart-core", "p2p", "hub", "mqtt", "ui-render", "ui-events"];

async function boot() {
    // === 0. Service Worker 重置与注册 ===
    if ('serviceWorker' in navigator) {
        try {
            // 1. 先卸载所有旧的 SW，防止冲突
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const reg of regs) {
                // 如果是旧的带时间戳的，或者状态异常的，卸载它
                await reg.unregister();
                console.log('🧹 已卸载旧 SW:', reg.scope);
            }

            // 2. 注册新的 (使用固定 URL，不要加时间戳！)
            console.log('🔄 正在注册新 SW...');
            const newReg = await navigator.serviceWorker.register('./sw.js'); // 固定 URL
            
            // 3. 强制等待激活
            if (newReg.installing) {
                console.log('⏳ SW 正在安装...');
            } else if (newReg.waiting) {
                console.log('⏳ SW 等待中 (跳过等待)...');
                // newReg.waiting.postMessage({ type: 'SKIP_WAITING' }); // sw.js 里已有 skipWaiting
            } else if (newReg.active) {
                console.log('✅ SW 已激活');
            }
            
            await navigator.serviceWorker.ready;
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'PING' });
            }
            console.log('✅ Service Worker 握手成功');

        } catch (e) {
            console.warn('⚠️ SW 注册警告:', e);
        }
    }

    // === 1. 加载配置 ===
    try { window.config = await fetch('./config.json').then(r => r.json()); } 
    catch(e) { window.config = { peer: {}, mqtt: {} }; }

    // === 2. 加载模块列表 ===
    let modules = [];
    try {
        const res = await fetch('./registry.txt?t=' + Date.now());
        if(res.ok) modules = (await res.text()).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        else throw new Error('404');
    } catch(e) { modules = FALLBACK_MODULES; }

    // === 3. 加载模块 ===
    for (const mod of modules) {
        try {
            const m = await import(`./modules/${mod}.js?t=` + Date.now());
            if (m.init) m.init();
        } catch(e) { console.error(`Failed: ${mod}`, e); }
    }
    
    // === 4. 启动 App ===
    try {
        const appMod = await import('./app.js?t=' + Date.now());
        if (appMod.init) appMod.init();
        else if (window.app && window.app.init) window.app.init();
    } catch(e) { console.error('App Launch Failed', e); }
}

boot();
