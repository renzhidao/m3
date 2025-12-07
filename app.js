import { NET_PARAMS, CHAT, APP_VERSION } from './modules/constants.js';

export function init() {
  console.log(`🚀 启动主程序: App Core v${APP_VERSION}`);

  window.app = {
    async init() {
      window.util.log(`正在启动 P1 v${APP_VERSION}...`);
      
      await window.util.syncTime();
      localStorage.setItem('p1_my_id', window.state.myId);
      await window.db.init();
      
      if (window.ui && window.ui.init) window.ui.init();
      if (window.uiEvents && window.uiEvents.init) window.uiEvents.init();

      this.loadHistory(20);

      if (window.p2p) window.p2p.start();
      if (window.mqtt) window.mqtt.start();

      this.loopTimer = setInterval(() => this.loop(), NET_PARAMS.LOOP_INTERVAL);
      this.bindLifecycle();

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
                // === 切后台：只暂停逻辑循环，保持连接（利用系统宽容期） ===
                window.util.log('🌙 应用切入后台 (静默模式)...');
                
                if (this.loopTimer) {
                    clearInterval(this.loopTimer);
                    this.loopTimer = null;
                }
                
            } else {
                // === 切前台：恢复逻辑，检查连接 ===
                window.util.log('☀️ 应用切回前台...');
                
                if (!this.loopTimer) {
                    this.loopTimer = setInterval(() => this.loop(), NET_PARAMS.LOOP_INTERVAL);
                }
                
                // 检查 P2P 是否存活，只有死了才重启
                if (window.p2p) { /* P2P自托管，App不干预 */ }
                
                // 检查 MQTT
                if (window.mqtt) {
                     if (!window.mqtt.client || !window.mqtt.client.isConnected()) {
                         window.util.log('🔧 MQTT 连接已断开，正在重连...');
                         window.mqtt.start();
                     }
                }
                
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

  window.app.init();
}