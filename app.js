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
      
      // === 修改：提升历史记录加载量至 500 条 ===
      this.loadHistory(500);

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
                window.util.log(' 应用切入后台 (跟随浏览器自动挂起)...');
            } else {
                window.util.log('☀️ 应用切回前台 (并发重连)...');
                if (!this.loopTimer) {
                    this.loopTimer = setInterval(() => this.loop(), NET_PARAMS.LOOP_INTERVAL);
                }
                if (window.p2p) {
                    if (!window.state.peer || window.state.peer.destroyed || window.state.peer.disconnected) {
                        window.util.log('🔧 P2P 失效，立即重启');
                        window.p2p.start();
                    } else {
                        window.p2p.maintenance();
                        window.p2p.patrolHubs();
                    }
                }
                if (window.mqtt) { 
                     if (!window.state.mqttClient || !window.state.mqttClient.isConnected()) {
                         window.util.log('🔧 MQTT 断开，立即重连');
                         window.mqtt.start();
                     } else {
                         window.mqtt.sendPresence();
                     }
                }            
            }
            window.util.syncTime();
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