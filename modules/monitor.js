export function init() {
    console.log('📦 加载模块: Monitor (Deep Probe)');
    
    // 注入 DOM
    const panel = document.createElement('div');
    panel.id = 'monitor-panel';
    panel.innerHTML = `
      <div class="mon-header">
        <span class="mon-title">🐞 全链路诊断 (Video Probe)</span>
        <div>
            <button class="mon-btn" id="btnMonDl">📥 下载日志</button>
            <button class="mon-btn" id="btnMonClear">🚫 清空</button>
            <span class="mon-close" id="btnMonClose">✖</span>
        </div>
      </div>
      <div class="mon-stats" id="monStats">
        <span>连接: <b id="st-conn">0</b></span>
        <span>流任务: <b id="st-task">0</b></span>
        <span>内存: <b id="st-mem">-</b></span>
      </div>
      <textarea class="mon-text" id="monText" readonly spellcheck="false"></textarea>
    `;
    
    const style = document.createElement('style');
    style.textContent = `
        .mon-text { 
            flex: 1; background: #000; color: #0f0; border: none; 
            padding: 10px; font-family: monospace; font-size: 11px; resize: none; outline: none;
        }
        .mon-btn {
            background: #333; color: #fff; border: 1px solid #555; 
            padding: 2px 8px; font-size: 11px; cursor: pointer; margin-right: 5px;
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);
    
    document.getElementById('btnMonClose').onclick = () => panel.style.display = 'none';
    document.getElementById('btnMonClear').onclick = () => {
        document.getElementById('monText').value = '';
        window.monitor.logs = [];
    };
    document.getElementById('btnMonDl').onclick = () => {
        const text = document.getElementById('monText').value;
        const blob = new Blob([text], {type: 'text/plain'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `p1_diag_${Date.now()}.log`;
        a.click();
    };

    window.monitor = {
        logs: [],
        
        log(level, module, msg, data) {
            const entry = { ts: new Date(), level, module, msg, data };
            this.logs.push(entry);
            if (this.logs.length > 500) this.logs.shift();
            this.appendLine(entry);
            if (level === 'ERROR' || level === 'FATAL') console.error(`[${module}] ${msg}`, data);
            else console.log(`[${module}] ${msg}`);
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
        
        appendLine(e) {
            const ta = document.getElementById('monText');
            if (!ta) return;
            const time = e.ts.toTimeString().split(' ')[0];
            let line = `[${time}] [${e.level}] [${e.module}] ${e.msg}`;
            if (e.data) {
                try { line += ' ' + JSON.stringify(e.data); } catch(err) {}
            }
            ta.value = line + '\n' + ta.value;
        }
    };
    
    setInterval(() => window.monitor.updateStats(), 2000);

    // ================= 外挂探针区 =================

    // 1. Hook Smart Core 数据层 (验尸模式)
    setTimeout(() => {
        if (!window.smartCore || !window.smartCore.handleBinary) return;
        const originalHandle = window.smartCore.handleBinary;
        
        window.smartCore.handleBinary = function(rawBuffer, fromPeerId) {
            // 尝试读取 Header 确定 offset
            try {
                let buffer = rawBuffer;
                if (rawBuffer.buffer) buffer = rawBuffer.buffer;
                if (rawBuffer.byteOffset !== undefined) {
                     buffer = buffer.slice(rawBuffer.byteOffset, rawBuffer.byteOffset + rawBuffer.byteLength);
                }
                const view = new DataView(buffer);
                const headerLen = view.getUint8(0);
                const decoder = new TextDecoder();
                const headerStr = decoder.decode(buffer.slice(1, 1 + headerLen));
                const header = JSON.parse(headerStr);
                
                // 关键：如果 offset 是 0，说明是文件头，立即 Hex Dump
                if (header.offset === 0) {
                    const body = new Uint8Array(buffer.slice(1 + headerLen));
                    const checkLen = Math.min(body.length, 16);
                    const hexArr = [];
                    for(let i=0; i<checkLen; i++) {
                        hexArr.push(body[i].toString(16).padStart(2, '0').toUpperCase());
                    }
                    window.monitor.warn('PROBE', `🔍 收到文件头 (Offset 0): [${hexArr.join(' ')}]`, {from: fromPeerId.slice(0,4)});
                    
                    // 简易格式判断
                    const magic = hexArr.join('');
                    if (magic.startsWith('000000')) window.monitor.info('PROBE', '>> MP4/Mov 格式头检测通过');
                    else if (magic.startsWith('1A45DFA3')) window.monitor.info('PROBE', '>> WebM/MKV 格式头检测通过');
                    else window.monitor.error('PROBE', '>> ⚠️ 未知/损坏的文件头!');
                }
            } catch(e) {
                // 不阻塞正常流程
            }
            return originalHandle.apply(this, arguments);
        };
        window.monitor.info('SYS', '✅ 数据层探针已植入');
    }, 2000);

    // 2. 监听 Service Worker 回传
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', event => {
            const d = event.data;
            if (d && d.type === 'SW_LOG') {
                window.monitor.log(d.level, 'SW-CORE', d.msg, {reqId: d.requestId ? d.requestId.slice(-4) : 'N/A'});
            }
        });
    }

    // 3. 自动监听 Video 标签 (DOM 变动)
    const observer = new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
                    attachVideoProbe(node);
                }
                // 递归查找容器内的 video
                if (node.querySelectorAll) {
                    node.querySelectorAll('video, audio').forEach(v => attachVideoProbe(v));
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    function attachVideoProbe(el) {
        if (el.dataset.probed) return;
        el.dataset.probed = 'true';
        
        const name = el.getAttribute('src') || 'Video';
        
        el.addEventListener('error', (e) => {
            const err = el.error;
            let msg = '未知错误';
            if (err) {
                switch(err.code) {
                    case 1: msg = '用户中止 (MEDIA_ERR_ABORTED)'; break;
                    case 2: msg = '网络错误 (MEDIA_ERR_NETWORK)'; break;
                    case 3: msg = '解码错误 (MEDIA_ERR_DECODE) - 数据损坏!'; break;
                    case 4: msg = '格式不支持 (MEDIA_ERR_SRC_NOT_SUPPORTED)'; break;
                }
                window.monitor.fatal('VIDEO', `❌ 播放失败: ${msg}`, {code: err.code, msg: err.message});
            } else {
                window.monitor.error('VIDEO', `播放出错 (无错误对象)`);
            }
        });
        
        el.addEventListener('stalled', () => {
             // 降低频率
             if (Math.random() < 0.1) window.monitor.warn('VIDEO', `🐢 缓冲卡顿/流中断...`);
        });
        
        el.addEventListener('loadedmetadata', () => {
            window.monitor.info('VIDEO', `✅ 元数据加载成功: ${el.videoWidth}x${el.videoHeight}, Dur:${el.duration}`);
        });
    }
}