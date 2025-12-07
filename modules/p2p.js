import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (AutoFix v3)');
  const CFG = window.config;

  window.p2p = {
    _searchLogShown: false,
    _waitLogShown: false,
    _connecting: new Set(),
    _healthTimer: null,

    _checkPeer(caller) {
      const p = window.state.peer;
      if (!p) { /* window.util.log(`⚠️ [${caller}] peer不存在`); */ return false; }
      if (p.destroyed) { /* window.util.log(`⚠️ [${caller}] peer已销毁`); */ return false; }
      return true;
    },

    _safeCall(fn, caller) {
      try { return fn(); } catch (e) {
        window.util.log(`❌ [${caller}] 异常: ${e.message}`);
      }
    },

    _startHealthCheck() {
      if (this._healthTimer) clearInterval(this._healthTimer);
      this._healthTimer = setInterval(() => {
        if (document.hidden) return;
        this._outputHealthSnapshot();
      }, 10000);
    },

    _outputHealthSnapshot() {
      const s = window.state;
      const p = s.peer;
      const openCount = Object.values(s.conns || {}).filter(c => c.open).length;
      const totalCount = Object.keys(s.conns || {}).length;
      let peerStatus = p ? `open=${p.open},destroyed=${p.destroyed}` : 'N/A';
      window.util.log(`💓 [健康] Peer(${peerStatus}) 连接(${openCount}/${totalCount}) MQTT(${s.mqttStatus}) Hub(${s.isHub})`);
    },

    start() {
      window.util.log('▶ [P2P] start() 进入');
      this._safeCall(() => {
        if (window.state.peer && !window.state.peer.destroyed) {
          window.util.log('▶ [P2P] peer已存在且未销毁，跳过');
          return;
        }
        if (typeof Peer === 'undefined') {
          setTimeout(() => this.start(), 200);
          return;
        }

        window.util.log(`🚀 [P2P] 创建Peer: ${window.state.myId}`);
        const p = new Peer(window.state.myId, CFG.peer);
        
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
          if (p && !p.destroyed) {
            window.util.log(`📡 [P2P] 尝试 reconnect()`);
            try { p.reconnect(); } catch(e){}
          }
        });

        p.on('close', () => window.util.log(`🔴 [P2P] Peer.close`));

        p.on('error', e => {
          window.util.log(`❌ [P2P] Peer.error: type=${e.type}, msg=${e.message}`);
          if (e.type === 'unavailable-id') {
            const newId = 'u_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('p1_my_id', newId);
            window.state.myId = newId;
            setTimeout(() => location.reload(), 500);
            return;
          }
          // 资源耗尽，自动重启
          if (e.message && (e.message.includes('Cannot create so many') || e.message.includes('Constructing a PeerConnection'))) {
             window.util.log('🚨 [系统] 资源耗尽(PeerError)，正在重启 P2P...');
             this.stop();
             setTimeout(() => this.start(), 500);
          }
        });
      }, 'start');
      window.util.log('▶ [P2P] start() 退出');
    },

    stop() {
      window.util.log('🛑 [P2P] stop() 进入');
      if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
      if (window.state.peer) {
        try { window.state.peer.destroy(); } catch(e) {}
        window.state.peer = null;
      }
      window.state.conns = {};
      this._connecting.clear();
      if (window.ui) window.ui.updateSelf();
      window.util.log('🛑 [P2P] stop() 退出');
    },

    connectTo(id) {
      if (!id || id === window.state.myId) return;
      if (!this._checkPeer('connectTo')) return;
      
      if (window.state.conns[id] && window.state.conns[id].open) return;
      if (this._connecting.has(id)) return;

      this._connecting.add(id);
      setTimeout(() => this._connecting.delete(id), 8000);

      this._safeCall(() => {
        // 强力清理旧连接，释放配额
        const old = window.state.conns[id];
        if (old) {
            try { old.close(); } catch(e){}
            delete window.state.conns[id];
        }

        try {
            const conn = window.state.peer.connect(id, { reliable: true });
            conn.created = Date.now();
            conn._targetId = id;
            window.state.conns[id] = conn;
            this.setupConn(conn);
        } catch(err) {
            this._connecting.delete(id);
            // 捕获资源耗尽错误
            if (err.message && (err.message.includes('Cannot create so many') || err.message.includes('Constructing a PeerConnection'))) {
                window.util.log('🚨 [系统] 资源耗尽(ConnectError)，正在重启 P2P...');
                this.stop();
                setTimeout(() => this.start(), 500);
            } else {
                window.util.log('❌ 连接异常: ' + err.message);
            }
        }
      }, 'connectTo');
    },

    setupConn(conn) {
      const pid = conn.peer || conn._targetId || 'unknown';
      // window.util.log(`🔧 [setupConn] 配置连接: ${pid.slice(0,8)}`);
      
      const max = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
      if (Object.keys(window.state.conns).length >= max) {
        conn.on('open', () => {
          conn.send({ t: MSG_TYPE.PEER_EX, list: Object.keys(window.state.conns).slice(0, 10) });
          setTimeout(() => conn.close(), 500);
        });
        return;
      }

      if (conn.peerConnection) {
        conn.peerConnection.oniceconnectionstatechange = () => {
          const s = conn.peerConnection.iceConnectionState;
          if (s === 'failed' || s === 'disconnected') {
             window.util.log(`🧊 [ICE] ${pid.slice(0,8)}: ${s}`);
          }
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
          setTimeout(() => { if (conn.open) conn.send({ t: MSG_TYPE.PEER_EX, list: list }); }, 100);
          window.db.getRecent(1, 'all').then(m => {
            const lastTs = (m && m.length) ? m[0].ts : 0;
            setTimeout(() => { if(conn.open) conn.send({t: MSG_TYPE.ASK_PUB, ts: lastTs}); }, 500);
          });
        }, 'conn.open');
        if (window.protocol) window.protocol.retryPending();
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      });

      conn.on('data', d => this._safeCall(() => this.handleData(d, conn), 'handleData'));
      const onGone = (reason) => {
        window.util.log(`🔌 [Conn] ${pid.slice(0,8)} 断开: ${reason}`);
        this._connecting.delete(pid);
        delete window.state.conns[pid];
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      };
      conn.on('close', () => onGone('close'));
      conn.on('error', (e) => onGone(`error: ${e.type || e.message || e}`));
    },

    handleData(d, conn) {
      conn.lastPong = Date.now();
      if (!d || !d.t) return;
      if (d.t === MSG_TYPE.PING) { if (conn.open) conn.send({ t: MSG_TYPE.PONG }); return; }
      if (d.t === MSG_TYPE.PONG) return;
      
      if (d.t === MSG_TYPE.HELLO) {
        conn.label = d.n;
        window.util.log(`👋 [Data] HELLO from ${d.n}`);
        if (window.protocol) window.protocol.processIncoming({ senderId: d.id, n: d.n });
        return;
      }
      if (d.t === MSG_TYPE.PEER_EX && Array.isArray(d.list)) {
        let newFound = 0;
        d.list.forEach(id => {
          if (id && id !== window.state.myId && !window.state.conns[id]) {
            if (Object.keys(window.state.conns).length < NET_PARAMS.MAX_PEERS_NORMAL) {
              this.connectTo(id);
              newFound++;
            }
          }
        });
        if(newFound > 0) window.util.log(`📋 [Gossip] 发现 ${newFound} 个新节点`);
        return;
      }
      if (d.t === MSG_TYPE.ASK_PUB) {
        window.db.getPublicAfter(d.ts || 0).then(list => { if (list.length > 0 && conn.open) conn.send({t: MSG_TYPE.REP_PUB, list: list}); });
        return;
      }
      if (d.t === MSG_TYPE.REP_PUB && Array.isArray(d.list)) {
        d.list.forEach(m => { if (window.protocol) window.protocol.processIncoming(m); });
        return;
      }
      if (d.t === MSG_TYPE.MSG && window.protocol) window.protocol.processIncoming(d, conn.peer);
    },

    patrolHubs() {
      if (!this._checkPeer('patrolHubs')) return;
      for (let i = 0; i < NET_PARAMS.HUB_COUNT; i++) {
        const targetId = NET_PARAMS.HUB_PREFIX + i;
        if (!window.state.conns[targetId] || !window.state.conns[targetId].open) this.connectTo(targetId);
      }
    },

    maintenance() {
      if (!this._checkPeer('maintenance')) return;
      const now = Date.now();
      Object.keys(window.state.conns).forEach(pid => {
        const c = window.state.conns[pid];
        if (!c.open && now - (c.created || 0) > NET_PARAMS.CONN_TIMEOUT) {
          window.util.log(`🧹 [维护] 清理超时未打开: ${pid.slice(0,8)}`);
          delete window.state.conns[pid];
        }
        if (c.open && c.lastPong && (now - c.lastPong > NET_PARAMS.PING_TIMEOUT)) {
          if (!pid.startsWith(NET_PARAMS.HUB_PREFIX)) {
            window.util.log(`🧹 [维护] 清理心跳超时: ${pid.slice(0,8)}`);
            try { c.close(); } catch(e) {}
            delete window.state.conns[pid];
          }
        }
      });
      const all = Object.keys(window.state.conns);
      if (all.length > 0) {
        const pkt = { t: MSG_TYPE.PEER_EX, list: all.slice(0, NET_PARAMS.GOSSIP_SIZE) };
        Object.values(window.state.conns).forEach(c => {
          if (c.open) this._safeCall(() => { c.send({ t: MSG_TYPE.PING }); c.send(pkt); }, 'maintenance.send');
        });
      }
      if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
    }
  };
}