const debugBox = document.getElementById('debug-console');
function log(msg, type='ok') {
    if (debugBox) {
        // console.log(msg);
    }
}

// 模块加载列表
const FALLBACK_MODULES = ["monitor", "constants", "utils", "state", "db", "protocol", "smart-core", "p2p", "hub", "mqtt", "ui-render", "ui-events"];

// === 关键修复：确保 SW 先注册并接管当前页面（否则 /virtual/file/ 不会触发 STREAM_OPEN）===
async function ensureServiceWorkerControl() {
    if (!('serviceWorker' in navigator)) return true;

    try {
        const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
        console.log('✅ SW Registered:', reg.scope);

        // 等待 SW 激活完成
        await navigator.serviceWorker.ready;

        // 首次安装后本页通常还没有 controller，需要刷新一次才能被 SW 控制
        if (!navigator.serviceWorker.controller) {
            const k = '__sw_force_reload_once__';
            if (!sessionStorage.getItem(k)) {
                sessionStorage.setItem(k, '1');
                location.reload();
                return false; // 阻止继续 boot（避免重复初始化）
            }
        }
        return true;
    } catch (err) {
        console.error('❌ SW Fail:', err);
        return true; // 不阻塞启动
    }
}

async function boot() {
    // 0. 先确保 SW 接管页面
    const ok = await ensureServiceWorkerControl();
    if (!ok) return;

    // 1. 加载配置
    try {
        const cfg = await fetch('./config.json').then(r => r.json());
        window.config = cfg;
        console.log('✅ 配置文件已加载');
    } catch (e) {
        console.error('❌ 无法加载 config.json', e);
        alert('致命错误: 配置文件丢失');
        return;
    }

    // 2. 获取模块列表
    let modules = [];
    try {
        const res = await fetch('./registry.txt?t=' + Date.now());
        if (res.ok) {
            const text = await res.text();
            modules = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        } else {
            throw new Error('404');
        }
    } catch (e) {
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
        } catch (e) {
            console.error(`❌ Module failed: ${mod}`, e);
        }
    }

    // 4. 启动新核心 (app.js)
    // === 修复：增加时间戳，强制刷新 app.js 及其依赖 ===
    setTimeout(async () => {
        try {
            const main = await import('./app.js?t=' + Date.now());
            if (main.init) {
                main.init();
                console.log('🚀 System Booting (Stream Final)...');
            }
        } catch (e) {
            console.error('Failed to load app.js', e);
            alert('启动核心失败: ' + e.message);
        }
    }, 500);
}

window.onerror = function (msg, url, line) {
    console.error(`Global Error: ${msg} @ ${url}:${line}`);
};

boot();