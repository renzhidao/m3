import { NET_PARAMS, CHAT, APP_VERSION } from './modules/constants.js';

export function init() {
  console.log(`🚀 启动主程序: App Core v${APP_VERSION}`);
  
  window.app = {
    async init() {
      window.util.log(`正在启动 P1 v${APP_VERSION}...`);
      
      // 基础初始化
      await window.util.syncTime();
      localStorage.setItem('p1_my_id', window.state.myId);
      await window.db.init();
      
      // UI 初始化
      if (window.ui && window.ui.init) window.ui.init();
      if (window.uiEvents && window.uiEvents.init) window.uiEvents.init();
      
      // 加载历史记录 (500条)
      this.loadHistory(500);

      // 启动网络模块
      if (window.p2p) window.p2p.start();
      if (window.mqtt) window.mqtt.start();

      // 尝试激活 SW (不阻塞启动)
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'PING' });
      }

      // 启动主循环
      this.loopTimer = setInterval(() => this.loop(), NET_PARAMS.LOOP_INTERVAL);
      this.bindLifecycle();

      // 延迟检查连接状态
      setTimeout(() => {
        if (!window.state.isHub && Object.keys(window.state.conns).length < 1) {
           if (window.state.mqttStatus === '在线') {
               if (window.p2p) window.p2p.patrolHubs();
           } else {
               if (window.hub) window.hub.connectToAnyHub();
           }
        }
      }, 2000);
    },

    bindLifecycle() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                window.util.log(' 应用切入后台...');
            } else {
                window.util.log('☀️ 应用切回前台...');
                if (!this.loopTimer) this.loopTimer = setInterval(() => this.loop(), NET_PARAMS.LOOP_INTERVAL);
                if (window.p2p) window.p2p.maintenance();
                if (window.mqtt) window.mqtt.sendPresence();
                window.util.syncTime();
            }
        });
    },

    loop() {
      if (document.hidden) return;
      if (window.p2p) window.p2p.maintenance();
      if (window.protocol) window.protocol.retryPending();
      
      if (!window.state.isHub && window.state.mqttStatus === '在线') {
         if (window.p2p) window.p2p.patrolHubs();
      } else if (!window.state.isHub && window.state.mqttStatus !== '在线') {
         if (window.hub) window.hub.connectToAnyHub();
      }
    },

    async loadHistory(limit) {
      if (window.state.loading) return;
      window.state.loading = true;
      const msgs = await window.db.getRecent(limit, window.state.activeChat, window.state.oldestTs);
      if (msgs && msgs.length > 0) {
         window.state.oldestTs = msgs[0].ts;
         msgs.forEach(m => {
            window.state.seenMsgs.add(m.id);
            if (window.ui) window.ui.appendMsg(m);
         });
      }
      window.state.loading = false;
    }
  };
  
  // 立即执行
  window.app.init();
}
