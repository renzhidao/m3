import { NET_PARAMS, CHAT, APP_VERSION } from './modules/constants.js';

export function init() {
  console.log(`🚀 启动主程序: App Core v${APP_VERSION}`);

  window.app = {
    _lastPatrol: 0,

    async init() {
      window.util.log(`正在启动 P1 v${APP_VERSION}...`);
      
      await window.util.syncTime();
      localStorage.setItem('p1_my_id', window.state.myId);
      await window.db.init();
      
      if (window.ui && window.ui.init) window.ui.init();
      if (window.uiEvents && window.uiEvents.init) window.uiEvents.init();

      this.loadHistory(20);

      // 并发启动
      if (window.p2p) window.p2p.start();
      if (window.mqtt) window.mqtt.start();

      // 启动主循环，不再被后台事件打断
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
                // === 切后台：只记录日志，不清除定时器，进入“只听不连”模式 ===
                // 这样可以利用浏览器宽限期继续收消息
                window.util.log('🌙 切入后台 (被动接收模式)...');
            } else {
                // === 切前台：恢复主动并发 ===
                window.util.log('☀️ 切回前台 (并发重连)...');
                
                // 防御性恢复：如果浏览器强行杀了定时器，这里救活它
                if (!this.loopTimer) {
                    this.loopTimer = setInterval(() => this.loop(), NET_PARAMS.LOOP_INTERVAL);
                }
                
                if (window.p2p) {
                    if (!window.state.peer || window.state.peer.destroyed || window.state.peer.disconnected) {
                        window.util.log('🔧 P2P 失效，重启中');
                        window.p2p.start();
                    } else {
                        // 回前台立刻并发巡逻一次
                        window.p2p.maintenance();
                        window.p2p.patrolHubs();
                        this._lastPatrol = Date.now();
                    }
                }
                
                if (window.mqtt) {
                     if (!window.mqtt.client || !window.mqtt.client.isConnected()) {
                         window.mqtt.start();
                     } else {
                         window.mqtt.sendPresence();
                     }
                }
                window.util.syncTime();
            }
        });
    },

    loop() {
      // 这里的 loop 现在后台也会跑（直到浏览器挂起）
      const isHidden = document.hidden;
      const now = Date.now();
      
      // 1. 基础维护：必须跑，用于接收消息、维持心跳、回调数据
      if (window.p2p) window.p2p.maintenance();
      if (window.protocol) window.protocol.retryPending();

      // 2. 关键防护：如果是后台，直接返回，绝不执行下面的主动连接逻辑
      // 这就避免了后台积压请求导致的崩溃，同时上面的代码保证了能收消息
      if (isHidden) return;

      // 3. 主动巡逻：只有前台才做
      if (now - this._lastPatrol > 5000) {
          this._lastPatrol = now;
          
          if (!window.state.isHub && window.state.mqttStatus === '在线') {
             if (window.p2p) window.p2p.patrolHubs();
          } else if (!window.state.isHub && window.state.mqttStatus !== '在线') {
             if (window.hub) window.hub.connectToAnyHub();
          }
      }
    }
  };

  window.app.init();
}