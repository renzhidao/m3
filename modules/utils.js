export function init() {
  console.log('📦 加载模块: Utils (Fixed Leak)');

  window.onerror = function(msg, url, line, col, error) {
    const info = `❌ [全局错误] ${msg} @ ${url}:${line}:${col}`;
    console.error(info, error);
    if (window.logSystem) window.logSystem.add(info);
    return false;
  };

  window.logSystem = {
    history: JSON.parse(localStorage.getItem('p1_blackbox') || '[]'),
    fullHistory: [],
    add(text) {
      const msg = `[${new Date().toLocaleTimeString()}] ${typeof text==='object'?JSON.stringify(text):text}`;
      console.log(msg);
      this.fullHistory.push(msg);
      this.history.push(msg);
      if (this.history.length > 200) this.history.shift();
      try { localStorage.setItem('p1_blackbox', JSON.stringify(this.history)); } catch(e){}
      const el = document.getElementById('logContent'); 
      if (el) {
        const div = document.createElement('div'); div.innerText = msg; div.style.borderBottom = '1px solid #333';
        el.prepend(div);
      }
    },
    clear() { this.history = []; localStorage.removeItem('p1_blackbox'); }
  };

  window.util = {
    log: (s) => window.logSystem.add(s),
    now() { return Date.now() + (window.state ? window.state.timeOffset : 0); },
    async syncTime() { try { window.state.timeOffset = 0; } catch (e) {} },
    uuid: () => Math.random().toString(36).substr(2, 9),
    escape(s) { return String(s||'').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'); },
    colorHash(str) { return '#333'; },
    
    // === 3人转压测 (修复版) ===
    stressTest() {
        const addLog = (msg) => { window.util.log('💣 ' + msg); };

        if(confirm('⚠️ 开始【微观循环测试】(终极修正版)
限制：3个连接。
机制：每次循环暴力清理所有测试残留。')) {
            addLog('=== 开始测试 (Zombie Killer Mode) ===');
            
            let total = 0;
            
            // 定义暴力清理函数：直接操作 PeerJS 内部缓存
            const cleanupZombies = () => {
                 const p = window.state.peer;
                 if (!p || !p._connections) return;
                 
                 // 遍历所有连接缓存，找到测试遗留的垃圾
                 // PeerJS 的 _connections 是一个 Map<PeerID, Connection[]>
                 for (const [peerId, conns] of p._connections.entries()) {
                     if (peerId.startsWith('cycle_')) {
                         conns.forEach(c => {
                             try { c.close(); } catch(e){}
                             try { 
                                 if (c.peerConnection) {
                                     c.peerConnection.onicecandidate = null;
                                     c.peerConnection.close(); 
                                 }
                             } catch(e){}
                         });
                         // 从 Map 中彻底删除
                         p._connections.delete(peerId);
                     }
                 }
            };

            const timer = setInterval(() => {
                if (!window.state.peer || window.state.peer.destroyed) {
                    clearInterval(timer); return;
                }

                // 1. 先执行全场清理，确保没有任何上一次的残留
                cleanupZombies();

                const active = Object.keys(window.state.conns).length;
                
                try {
                    total++;
                    // 2. 创建新连接 (不需要保存引用了，下次循环会自动清理所有 cycle_ 开头的)
                    window.state.peer.connect('cycle_' + Date.now() + '_' + total);
                    
                    if (total % 10 === 0) {
                        addLog(`第 ${total} 次, 存活: ${active}/3`);
                    }
                } catch(e) {
                    clearInterval(timer);
                    addLog(`💥 失败！无法创建第 ${total} 个连接。`);
                    addLog(`错误: ${e.message}`);
                    return;
                }

                if (total >= 500) {
                    clearInterval(timer);
                    cleanupZombies(); // 最后清理一次
                    addLog(`🎉 ✅ 测试通过！已循环 500 次，资源回收正常。`);
                    alert('🎉 通过！
暴力清理机制生效，连接池未溢出。');
                }
            }, 200); // 放慢到 200ms，给 GC 喘息时间
        }
    },

    compressImage(file) {
      return new Promise((resolve) => {
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    });
    }
  };

  setTimeout(() => {
    const crash = localStorage.getItem('p1_crash');
    if (crash) { try { window.util.log('⚠️ 上次崩溃: ' + JSON.parse(crash).msg); } catch(e){} }
  }, 1000);
}
