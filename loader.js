// Loader v2.0 - Visual Diagnostic
// 这个版本会将日志直接打印在屏幕上，方便排查白屏问题

function logToScreen(msg, color = '#0f0') {
    console.log(msg);
    const box = document.getElementById('debug-boot');
    if (box) {
        const line = document.createElement('div');
        line.style.color = color;
        line.style.marginBottom = '4px';
        line.innerText = '> ' + msg;
        box.appendChild(line);
    }
}

// 初始化屏幕日志区域
(function initDebugUI() {
    if (!document.getElementById('debug-boot')) {
        const div = document.createElement('div');
        div.id = 'debug-boot';
        div.style.position = 'fixed';
        div.style.top = '0';
        div.style.left = '0';
        div.style.width = '100%';
        div.style.height = '100%';
        div.style.background = '#000';
        div.style.color = '#fff';
        div.style.zIndex = '99999';
        div.style.padding = '20px';
        div.style.fontFamily = 'monospace';
        div.style.overflowY = 'auto';
        div.style.fontSize = '12px';
        div.innerHTML = '<h3 style="color:#fff;border-bottom:1px solid #333;padding-bottom:10px">🚀 系统启动诊断模式</h3>';
        document.body.appendChild(div);
    }
})();

// 硬编码加载顺序 (绕过 registry.txt 可能的乱码或错误)
const LOAD_ORDER = [
    "monitor",
    "constants",
    "utils",
    "state",
    "db",
    "protocol",    // protocol 必须在 smart-core 之前
    "smart-core",  // 核心模块
    "p2p",
    "mqtt",
    "hub",
    "ui-render",
    "ui-events"
];

async function boot() {
    logToScreen('开始加载...', '#aaa');

    // 1. 加载配置
    try {
        const cfg = await fetch('./config.json').then(r => r.json());
        window.config = cfg;
        logToScreen('✅ 配置加载成功');
    } catch(e) {
        logToScreen('⚠️ 配置加载失败 (使用默认空配置)', '#fa0');
        window.config = { peer: {}, mqtt: {} };
    }

    // 2. 串行加载模块
    for (const mod of LOAD_ORDER) {
        logToScreen(`⏳ 正在加载模块: ${mod}...`, '#aaa');
        const path = `./modules/${mod}.js?t=` + Date.now();
        try {
            const m = await import(path);
            if (m.init) {
                try {
                    m.init();
                    logToScreen(`  -> ${mod} 初始化完成`);
                } catch(initErr) {
                    logToScreen(`❌ ${mod}.init() 执行出错: ${initErr.message}`, '#f00');
                    console.error(initErr);
                }
            } else {
                logToScreen(`  -> ${mod} 已加载 (无 init)`);
            }
        } catch(e) {
            logToScreen(`❌ 模块文件加载失败: ${mod}.js`, '#f00');
            logToScreen(`  原因: ${e.message}`, '#f55');
            // 如果是核心模块失败，可能导致崩溃
            if (mod === 'protocol' || mod === 'smart-core') {
                 logToScreen('🚨 核心依赖丢失，系统可能无法启动', '#f00');
            }
        }
    }
    
    // 3. 加载 App 主程序
    logToScreen('⏳ 正在启动主程序 app.js...', '#aaa');
    try {
        const appPath = './app.js?t=' + Date.now();
        const appMod = await import(appPath);
        if (appMod.init) {
            appMod.init();
            logToScreen('✅ App.init() 调用成功', '#0f0');
        } else {
            // 尝试全局查找
            if (window.app && window.app.init) {
                window.app.init();
                logToScreen('✅ window.app.init() 调用成功 (Fallback)', '#0f0');
            } else {
                logToScreen('❌ 找不到 App 启动入口!', '#f00');
            }
        }
    } catch(e) {
        logToScreen(`❌ app.js 加载/执行失败: ${e.message}`, '#f00');
    }

    logToScreen('🎉 启动流程结束', '#0ff');
    
    // 3秒后如果没有报错，隐藏诊断层
    setTimeout(() => {
        const box = document.getElementById('debug-boot');
        if (box && !document.body.innerText.includes('❌')) {
             // box.style.display = 'none'; // 为了看清日志，暂时不自动隐藏
             logToScreen('诊断层将在 5秒后自动关闭...', '#666');
             setTimeout(() => {
                 if(box) box.style.display = 'none';
             }, 5000);
        }
    }, 2000);
}

// 捕获全局未处理错误
window.addEventListener('error', e => {
    logToScreen(`🔥 全局崩溃: ${e.message} at ${e.filename}:${e.lineno}`, '#f00');
});

window.addEventListener('unhandledrejection', e => {
    logToScreen(`🔥 未捕获 Promise 异常: ${e.reason}`, '#f00');
});

boot();
