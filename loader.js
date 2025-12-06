const debugBox = document.getElementById('debug-console');
function log(msg, type='ok') {
    if(debugBox) {
        // console.log(msg);
    }
}

// 模块加载列表
const FALLBACK_MODULES = ["constants", "utils", "state", "db", "protocol", "p2p", "mqtt", "hub", "ui-render", "ui-events"];

async function boot() {
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
        const res = await fetch('./registry.txt?t=' + Date.now()); // 添加时间戳防缓存
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
            // === 关键修复：获取模块对象并调用 init ===
            const m = await import(path);
            if (m.init) {
                m.init();
                console.log(`✅ Module initialized: ${mod}`);
            } else {
                console.warn(`⚠️ Module loaded but no init(): ${mod}`);
            }
        } catch(e) {
            console.error(`❌ Module failed: ${mod}`, e);
            alert(`模块加载失败: ${mod}\n${e.message}`); // 弹窗提示以便手机端调试
        }
    }
    
    // 4. 启动新核心 (app.js)
    setTimeout(async () => {
        try {
            const main = await import('./app.js');
            if(main.init) {
                main.init();
                console.log('🚀 System Booting (Refactored)...');
            }
        } catch(e) {
            console.error('Failed to load app.js', e);
            alert('启动核心失败: ' + e.message);
        }
    }, 500);
}

// 全局错误捕获，防止白屏无反馈
window.onerror = function(msg, url, line) {
    console.error(`Global Error: ${msg} @ ${url}:${line}`);
    // alert(`System Error: ${msg}`); // 可选：如果还不行就打开这个注释
};

boot();