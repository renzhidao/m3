import { MSG_TYPE, NET_PARAMS, UI_CONFIG } from './constants.js';

export function init() {
  console.log('📦 加载模块: MQTT (Proxy-Hub-Guard)');

  const CFG = window.config;

  window.mqtt = {
    client: null,
    failCount: 0,
    _pulseTimer: null,
    _isConnecting: false,

    start() {
      if (this.client && this.client.isConnected()) return;
      if (this._isConnecting) return;
      this._isConnecting = true;

      if (typeof Paho === 'undefined') {
        window.util.log('❌ MQTT库未加载');
        this._isConnecting = false;
        setTimeout(() => this.start(), 3000);
        return;
      }

      let host = CFG.mqtt.broker;
      let port = Number(CFG.mqtt.port);
      let path = CFG.mqtt.path;
      let isProxy = false;

      // 失败一次就切代理
      if (this.failCount > 0) {
        window.util.log(`️ MQTT直连失败，切换代理`);
        host = CFG.mqtt.proxy_host;
        port = 443;
        path = `/https://${CFG.mqtt.broker}:${CFG.mqtt.port}${CFG.mqtt.path}`;
        isProxy = true;
      }

      const cid = "mqtt_" + window.state.myId + "_" + Math.random().toString(36).slice(2, 6);
      window.util.log(`连接MQTT: ${host}...`);
      
      try {
          this.client = new Paho.MQTT.Client(host, port, path, cid);
          window.state.mqttClient = this.client; 
    
          this.client.onConnectionLost = (res) => this.onLost(res);
          this.client.onMessageArrived = (msg) => this.onMessage(msg);
    
          const opts = {
            useSSL: true,
            timeout: (this.failCount > 0 ? 10 : 5), // 代理模式给长一点超时
            onSuccess: () => this.onConnect(isProxy),
            onFailure: (ctx) => this.onFail(ctx)
          };
    
          this.client.connect(opts);
      } catch(e) {
          this.onFail({ errorMessage: e.message });
      }
    },

    stop() {
        if (this._pulseTimer) {
            clearInterval(this._pulseTimer);
            this._pulseTimer = null;
        }
        if (this.client) {
            try { 
                if(this.client.isConnected()) this.client.disconnect(); 
            } catch(e) {}
            this.client = null;
            window.state.mqttClient = null;
        }
        this._isConnecting = false;
        window.state.mqttStatus = '暂停';
        if(window.ui) window.ui.updateSelf();
    },

    onConnect(isProxy) {
      this._isConnecting = false;
      window.state.mqttStatus = '在线';
      this.failCount = 0;
      window.util.log(`✅ MQTT连通!`);
      if (window.ui) window.ui.updateSelf();

      this.client.subscribe(CFG.mqtt.topic);
      
      // === 核心修改：代理保护逻辑 ===
      if (window.state.isHub) {
        if (!isProxy) {
            // 只有【直连】恢复了，才辞职（回归平民）
            window.util.log('⚡ 直连已恢复，辞去房主职务...');
            if (window.hub) window.hub.resign();
        } else {
            // 如果是【代理】连上的，继续当房主！
            window.util.log('🛡️ 代理连接成功，保持房主身份');
            // 这里直接 return，不执行下面的 patrolHubs
            // 启动心跳即可
            this.startHeartbeat(isProxy);
            return; 
        }
      } else {
        // 不是房主，正常去找别人
        if (window.p2p) window.p2p.patrolHubs();
      }

      this.startHeartbeat(isProxy);
    },

    startHeartbeat(isProxy) {
      this.sendPresence();
      if (this._pulseTimer) clearInterval(this._pulseTimer);
      // 代理模式心跳慢一点(10s)，直连快一点(4s)
      this._pulseTimer = setInterval(() => this.sendPresence(), isProxy ? 10000 : 4000);
    },

    onFail(ctx) {
      this._isConnecting = false;
      window.state.mqttStatus = '失败';
      this.failCount++;
      window.util.log(`❌ MQTT失败: ${ctx.errorMessage}`);
      if (window.ui) window.ui.updateSelf();
      
      setTimeout(() => this.start(), NET_PARAMS.RETRY_DELAY);
    },

    onLost(res) {
      this._isConnecting = false;
      if (res.errorCode === 0) return;

      window.state.mqttStatus = '断开';
      this.failCount++;
      if (window.ui) window.ui.updateSelf();
      setTimeout(() => this.start(), NET_PARAMS.RETRY_DELAY);
    },

    onMessage(msg) {
      try {
        const d = JSON.parse(msg.payloadString);
        if (Math.abs(window.util.now() - d.ts) > 120000) return; 

        
        if (d.type === MSG_TYPE.HUB_PULSE) {
          window.util.log(`📡 感知房主: ${d.id.slice(0,6)} (Hub:${d.hubIndex})`);

          window.state.hubHeartbeats[d.hubIndex] = Date.now();
          if (!window.state.conns[d.id] && Object.keys(window.state.conns).length < 5) {
            if (window.p2p) window.p2p.connectTo(d.id);
          }
          return;
        }

        if (d.id === window.state.myId) return;
        
        const count = Object.keys(window.state.conns).filter(k => window.state.conns[k].open).length;
        if (!window.state.conns[d.id] && count < 6) {
           if (window.p2p) window.p2p.connectTo(d.id);
        }

      } catch(e) {}
    },

    sendPresence() {
      if (document.hidden) return;

      if (!this.client || !this.client.isConnected()) return;

      let payload;
      if (window.state.isHub) {
        payload = JSON.stringify({
          type: MSG_TYPE.HUB_PULSE,
          id: window.state.myId,
          hubIndex: window.state.hubIndex,
          ts: window.util.now()
        });
      } else {
        payload = JSON.stringify({
          id: window.state.myId,
          ts: window.util.now()
        });
      }

      const msg = new Paho.MQTT.Message(payload);
      msg.destinationName = CFG.mqtt.topic;
      this.client.send(msg);
    }
  };
}