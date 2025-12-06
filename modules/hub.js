import { NET_PARAMS, MSG_TYPE } from './constants.js';

export function init() {
  console.log('📦 加载模块: Hub');
  const CFG = window.config;

  window.hub = {
    _connectingHub: false,

    // 尝试连接任意房主，如果失败则自己成为房主
    connectToAnyHub() {
      if (window.state.isHub || window.state.hubPeer) return;
      if (this._connectingHub) return;

      // 检查是否已经连接了某个房主
      for (let i = 0; i < NET_PARAMS.HUB_COUNT; i++) {
        const hubId = NET_PARAMS.HUB_PREFIX + i;
        if (window.state.conns[hubId] && window.state.conns[hubId].open) return;
      }

      this._connectingHub = true;
      // 随机选择一个房主槽位尝试连接
      const idx = Math.floor(Math.random() * NET_PARAMS.HUB_COUNT);
      const targetId = NET_PARAMS.HUB_PREFIX + idx;

      window.util.log('🔍 寻找房主 #' + idx + '...');
      if (window.p2p) window.p2p.connectTo(targetId);

      // 如果一段时间后既没连上该房主，自己也没变成房主，则尝试篡位
      setTimeout(() => {
        this._connectingHub = false;
        
        // === 关键修复：如果在等待期间 MQTT 连上了，就取消篡位计划 ===
        if (window.state.mqttStatus === '在线') {
            window.util.log('✅ MQTT已恢复，取消建立据点');
            return;
        }

        if (window.state.isHub) return;
        
        const conn = window.state.conns[targetId];
        if (!conn || !conn.open) {
          window.util.log('⚓ 无法连接，尝试建立据点 #' + idx);
          this.becomeHub(idx);
        }
      }, 2500);
    },

    // 成为房主 (通过创建第二个 Peer 实例，使用固定 ID)
    becomeHub(index) {
      if (window.state.hubPeer || window.state.isHub) return;

      const id = NET_PARAMS.HUB_PREFIX + index;
      const p = new Peer(id, window.config.peer);

      p.on('open', () => {
        // 二次检查：Open 可能是异步的，再次确认 MQTT 状态
        if (window.state.mqttStatus === '在线') {
           window.util.log('⚡ 房主创建过程中MQTT上线，立即销毁房主实例');
           p.destroy();
           return;
        }

        window.state.hubPeer = p;
        window.state.isHub = true;
        window.state.hubIndex = index;
        window.state.hubStatus = '房主';
        window.state.hubHeartbeats[index] = Date.now();
        
        if (window.ui) window.ui.updateSelf();
        window.util.log('👑 据点建立成功 #' + index);
      });

      p.on('connection', conn => {
        // 房主收到连接后的特殊处理：立即告知现有节点列表
        conn.on('open', () => {
          const list = Object.keys(window.state.conns);
          list.push(window.state.myId); // 把房主自己的主ID也放进去
          conn.send({ t: MSG_TYPE.PEER_EX, list: list });

          // 同时也把新节点告诉其他人
          const newPeer = conn.peer;
          Object.values(window.state.conns).forEach(c => {
            if (c.open && c.peer !== newPeer) {
              c.send({ t: MSG_TYPE.PEER_EX, list: [newPeer] });
            }
          });
        });
        
        // 房主也作为普通节点处理数据转发
        conn.on('data', d => {
           if (window.protocol) window.protocol.processIncoming(d, conn.peer);
        });
      });

      p.on('error', (e) => {
        window.state.isHub = false;
        window.state.hubPeer = null;
        // 如果是因为ID被占用 (unavailable-id)，说明有人比我先当了房主，那就去连他
        if (e.type === 'unavailable-id') {
           if (window.p2p) window.p2p.connectTo(id);
        }
      });
    },

    // 辞去房主 (新功能)
    resign() {
      if (!window.state.isHub || !window.state.hubPeer) return;

      window.util.log('👋 辞去房主身份，回归普通节点');
      
      // 销毁房主专用的 Peer 实例
      window.state.hubPeer.destroy();
      window.state.hubPeer = null;
      
      // 重置状态
      window.state.isHub = false;
      window.state.hubIndex = -1;
      window.state.hubStatus = null;

      if (window.ui) window.ui.updateSelf();
    }
  };
}
