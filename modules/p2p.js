import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (DiagMaster v2)');
  const CFG = window.config;

  window.p2p = {
    _searchLogShown: false,
    _waitLogShown: false,
    _connecting: new Set(),
    _healthTimer: null,

    // ========== 状态检查 ==========
    _checkPeer(caller) {
      const p = window.state.peer;
      if (!p) {
        window.util.log(`⚠️ [${caller}] peer不存在`);
        return false;
      }
      if (p.destroyed) {
        window.util.log(`⚠️ [${caller}] peer已销毁`);
        return false;
      }
      return true;
    },

    _safeCall(fn, caller) {
      try {
        return fn();
      } catch (e) {
        window.util.log(`❌ [${caller}] 异常: ${e.message}`);
        window.util.log(`❌ [${caller}] 堆栈: ${e.stack}`);
        return null;
      }
    },

    // ========== 健康检查 ==========
    _startHealthCheck() {
      if (this._healthTimer) clearInterval(this._healthTimer);
      this._healthTimer = setInterval(() => {
        if (document.hidden) return;
        this._outputHealthSnapshot();
      }, 10000); // 每10秒
    },

    _outputHealthSnapshot() {
      const s = window.state;
      const p = s.peer;
      const conns = s.conns || {};
      const openCount = Object.values(conns).filter(c => c.open).length;
      const totalCount = Object.keys(conns).length;
      
      let peerStatus = 'N/A';
      if (p) {
        peerStatus = `open=${p.open},destroyed=${p.destroyed},disconnected=${p.disconnected}`;
      }
      
      window.util.log(`💓 [健康] Peer(${peerStatus}) 连接(${openCount}/${totalCount}) MQTT(${s.mqttStatus}) Hub(${s.isHub})`);
      
      // 检测异常状态
      if (p && p.destroyed && totalCount > 0) {
        window.util.log(`🚨 [异常] Peer已销毁但连接表不为空!`);
      }
      if (p && !p.open && !p.destroyed && openCount > 0) {
        window.util.log(`🚨 [异常] Peer未open但有活跃连接!`);
      }
    },

    // ========== 启动 ==========
    start() {
      window.util.log('▶ [P2P] start() 进入');
      
      this._safeCall(() => {
        if (window.state.peer && !window.state.peer.destroyed) {
          window.util.log('▶ [P2P] peer已存在且未销毁，跳过');
          return;
        }

        if (typeof Peer === 'undefined') {
          if (!this._waitLogShown) {
            window.util.log('⏳ [P2P] Peer库未加载，等待...');
            this._waitLogShown = true;
          }
          setTimeout(() => this.start(), 500);
          return;
        }

        window.util.log(`🚀 [P2P] 创建Peer: ${window.state.myId}`);
        
        const p = new Peer(window.state.myId, CFG.peer);
        
        // Peer 事件全记录
        p.on('open', id => {
          window.util.log(`✅ [P2P] Peer.open: ${id}`);
          window.state.myId = id;
          window.state.peer = p;
          this._searchLogShown = false;
          
          if (window.ui) window.ui.updateSelf();
          this.patrolHubs();
          this._startHealthCheck();
        });

        p.on('connection', conn => {
          window.util.log(`⚡ [P2P] Peer.connection: 收到来自 ${conn.peer} 的连接`);
          this.setupConn(conn);
        });

        p.on('disconnected', () => {
          window.util.log(`📡 [P2P] Peer.disconnected`);
          // 尝试重连
          if (p && !p.destroyed) {
            window.util.log(`📡 [P2P] 尝试 reconnect()`);
            try { p.reconnect(); } catch(e) { 
              window.util.log(`❌ [P2P] reconnect失败: ${e.message}`); 
            }
          }
        });

        p.on('close', () => {
          window.util.log(`🔴 [P2P] Peer.close`);
        });

        p.on('error', e => {
          window.util.log(`❌ [P2P] Peer.error: type=${e.type}, msg=${e.message}`);

          if (e.type === 'unavailable-id') {
            window.util.log('⚠️ [P2P] ID冲突，自动更换');
            const newId = 'u_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('p1_my_id', newId);
            window.state.myId = newId;
            setTimeout(() => location.reload(), 500);
            return;
          }
          if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
            window.util.log(`⚠️ [P2P] 网络错误，5秒后重试`);
            setTimeout(() => this.start(), 5000);
          }
        });

      }, 'start');
      
      window.util.log('▶ [P2P] start() 退出');
    },

    // ========== 停止 ==========
    stop() {
      window.util.log('🛑 [P2P] stop() 进入');
      
      if (this._healthTimer) {
        clearInterval(this._healthTimer);
        this._healthTimer = null;
      }
      
      if (window.state.peer) {
        window.util.log(`🛑 [P2P] 销毁peer, destroyed=${window.state.peer.destroyed}`);
        try { 
          window.state.peer.destroy(); 
        } catch(e) {
          window.util.log(`❌ [P2P] destroy异常: ${e.message}`);
        }
        window.state.peer = null;
      }
      
      const connCount = Object.keys(window.state.conns).length;
      window.util.log(`🛑 [P2P] 清空连接表，原有${connCount}个`);
      window.state.conns = {};
      this._connecting.clear();
      
      if (window.ui) window.ui.updateSelf();
      window.util.log('🛑 [P2P] stop() 退出');
    },

    // ========== 连接到目标 ==========
    connectTo(id) {
      if (!id || id === window.state.myId) return;
      
      if (!this._checkPeer('connectTo')) {
        window.util.log(`⚠️ [connectTo] 跳过连接 ${id}，peer无效`);
        return;
      }
      
      if (window.state.conns[id] && window.state.conns[id].open) {
        return; // 已连接，静默跳过
      }
      if (this._connecting.has(id)) {
        return; // 正在连接中，静默跳过
      }

      this._connecting.add(id);
      setTimeout(() => this._connecting.delete(id), 8000);

      // window.util.log(`🔗 [connectTo] 发起连接: ${id.slice(0,8)}`);
      
      this._safeCall(() => {
        const conn = window.state.peer.connect(id, { reliable: true });
        conn.created = Date.now();
        conn._targetId = id;
        window.state.conns[id] = conn;
        this.setupConn(conn);
      }, 'connectTo');
    },

    // ========== 配置连接 ==========
    setupConn(conn) {
      const pid = conn.peer || conn._targetId || 'unknown';
      // window.util.log(`🔧 [setupConn] 配置连接: ${pid.slice(0,8)}`);
      
      const max = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
      if (Object.keys(window.state.conns).length >= max) {
        window.util.log(`⚠️ [setupConn] 超过最大连接数${max}，拒绝`);
        conn.on('open', () => {
          conn.send({ t: MSG_TYPE.PEER_EX, list: Object.keys(window.state.conns).slice(0, 10) });
          setTimeout(() => conn.close(), 500);
        });
        return;
      }

      // ICE 状态监控
      if (conn.peerConnection) {
        conn.peerConnection.oniceconnectionstatechange = () => {
          const s = conn.peerConnection.iceConnectionState;
          window.util.log(`🧊 [ICE] ${pid.slice(0,8)}: ${s}`);
          
          if (s === 'failed') {
            window.util.log(`🚨 [ICE] ${pid.slice(0,8)} 连接失败`);
          }
          if (s === 'disconnected') {
            window.util.log(`⚠️ [ICE] ${pid.slice(0,8)} 断开`);
          }
        };
        
        conn.peerConnection.onconnectionstatechange = () => {
          const s = conn.peerConnection.connectionState;
          window.util.log(`📶 [Conn] ${pid.slice(0,8)}: ${s}`);
        };
      }

      conn.on('open', () => {
        window.util.log(`✅ [Conn] ${pid.slice(0,8)} 已打开`);
        this._connecting.delete(pid);

        conn.lastPong = Date.now();
        conn.created = Date.now();
        window.state.conns[pid] = conn;
        
        this._safeCall(() => {
          const list = Object.keys(window.state.conns);
          list.push(window.state.myId);
          conn.send({ t: MSG_TYPE.HELLO, n: window.state.myName, id: window.state.myId });
          
          setTimeout(() => { 
            if (conn.open) conn.send({ t: MSG_TYPE.PEER_EX, list: list }); 
          }, 100);
          
          window.db.getRecent(1, 'all').then(m => {
            const lastTs = (m && m.length) ? m[0].ts : 0;
            setTimeout(() => {
              if(conn.open) conn.send({t: MSG_TYPE.ASK_PUB, ts: lastTs});
            }, 500);
          });
        }, 'conn.open');

        if (window.protocol) window.protocol.retryPending();
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      });

      conn.on('data', d => {
        this._safeCall(() => this.handleData(d, conn), 'handleData');
      });
      
      const onGone = (reason) => {
        window.util.log(`🔌 [Conn] ${pid.slice(0,8)} 断开: ${reason || 'unknown'}`);
        this._connecting.delete(pid);
        delete window.state.conns[pid];
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      };
      
      conn.on('close', () => onGone('close'));
      conn.on('error', (e) => onGone(`error: ${e.type || e.message || e}`));
    },

    // ========== 处理数据 ==========
    handleData(d, conn) {
      conn.lastPong = Date.now();
      if (!d || !d.t) return;

      if (d.t === MSG_TYPE.PING) { 
        if (conn.open) conn.send({ t: MSG_TYPE.PONG }); 
        return; 
      }
      if (d.t === MSG_TYPE.PONG) return;
      
      if (d.t === MSG_TYPE.HELLO) {
        conn.label = d.n;
        window.util.log(`👋 [Data] HELLO from ${d.n} (${d.id ? d.id.slice(0,6) : '?'})`);
        if (window.protocol) window.protocol.processIncoming({ senderId: d.id, n: d.n });
        return;
      }

      if (d.t === MSG_TYPE.PEER_EX && Array.isArray(d.list)) {
        // 降噪：仅在发现新节点时打印
        let newFound = 0;
        d.list.forEach(id => {
          if (id && id !== window.state.myId && !window.state.conns[id]) {
            if (Object.keys(window.state.conns).length < NET_PARAMS.MAX_PEERS_NORMAL) {
              this.connectTo(id);
              newFound++;
            }
          }
        });
        if (newFound > 0) window.util.log(`📋 [Gossip] 发现 ${newFound} 个新节点`);
        return;
      }
      
      if (d.t === MSG_TYPE.ASK_PUB) {
        window.db.getPublicAfter(d.ts || 0).then(list => {
          if (list.length > 0 && conn.open) conn.send({t: MSG_TYPE.REP_PUB, list: list});
        });
        return;
      }
      if (d.t === MSG_TYPE.REP_PUB && Array.isArray(d.list)) {
        window.util.log(`📥 [Data] REP_PUB 收到 ${d.list.length} 条历史消息`);
        d.list.forEach(m => {
          if (window.protocol) window.protocol.processIncoming(m);
        });
        return;
      }

      if (d.t === MSG_TYPE.MSG) {
        if (window.protocol) window.protocol.processIncoming(d, conn.peer);
      }
    },

    // ========== 巡逻Hub ==========
    patrolHubs() {
      if (!this._checkPeer('patrolHubs')) return;
      
      for (let i = 0; i < NET_PARAMS.HUB_COUNT; i++) {
        const targetId = NET_PARAMS.HUB_PREFIX + i;
        if (!window.state.conns[targetId] || !window.state.conns[targetId].open) {
          this.connectTo(targetId);
        }
      }
    },

    // ========== 维护 ==========
    maintenance() {
      if (!this._checkPeer('maintenance')) return;

      const now = Date.now();
      let cleaned = 0;
      
      Object.keys(window.state.conns).forEach(pid => {
        const c = window.state.conns[pid];
        
        // 清理未打开超时的连接
        if (!c.open && now - (c.created || 0) > NET_PARAMS.CONN_TIMEOUT) {
          window.util.log(`🧹 [维护] 清理超时未打开: ${pid.slice(0,8)}`);
          delete window.state.conns[pid];
          cleaned++;
        }
        
        // 清理心跳超时的连接(非Hub)
        if (c.open && c.lastPong && (now - c.lastPong > NET_PARAMS.PING_TIMEOUT)) {
          if (!pid.startsWith(NET_PARAMS.HUB_PREFIX)) {
            window.util.log(`🧹 [维护] 清理心跳超时: ${pid.slice(0,8)}`);
            try { c.close(); } catch(e) {}
            delete window.state.conns[pid];
            cleaned++;
          }
        }
      });

      // 发送心跳和节点交换
      const all = Object.keys(window.state.conns);
      if (all.length > 0) {
        const pkt = { t: MSG_TYPE.PEER_EX, list: all.slice(0, NET_PARAMS.GOSSIP_SIZE) };
        Object.values(window.state.conns).forEach(c => {
          if (c.open) {
            this._safeCall(() => {
              c.send({ t: MSG_TYPE.PING }); 
              c.send(pkt);
            }, 'maintenance.send');
          }
        });
      }
      
      if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
    }
  };
}