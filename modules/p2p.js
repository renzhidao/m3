import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (Ultimate v32)');
  const CFG = window.config;

  window.p2p = {
    _connecting: new Set(),
    _healthTimer: null,

    _checkPeer(caller) {
      const p = window.state.peer;
      return (p && !p.destroyed);
    },

    _safeCall(fn, caller) {
      try { return fn(); } catch (e) {
        window.util.log(`❌ [${caller}] 异常: ${e.message}`);
      }
    },

    // === 深度清理: 强制移除 PeerJS 内部引用 ===
    _hardClose(conn) {
      if (!conn) return;
      const p = window.state.peer;
      
      try { conn.removeAllListeners(); } catch(e){}
      try { conn.close(); } catch(e){}
      try { 
        if (conn.peerConnection) {
            conn.peerConnection.onicecandidate = null;
            conn.peerConnection.close(); 
        }
      } catch(e){}
      
      if (p && p._connections && conn.peer) {
          const list = p._connections.get(conn.peer);
          if (list) {
              const idx = list.indexOf(conn);
              if (idx > -1) list.splice(idx, 1);
              if (list.length === 0) p._connections.delete(conn.peer);
          }
      }
      conn.peerConnection = null;
    },

    _ensureQuota() {
      // 动态使用 350/500 限制
      const limit = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
      const ids = Object.keys(window.state.conns);
      if (ids.length < limit) return true;

      let targetId = null;
      // 1. 优先清理死链
      for (const id of ids) { if (!window.state.conns[id].open) { targetId = id; break; } }
      
      // 2. 清理压测残留
      if (!targetId) {
          for (const id of ids) { if (id.startsWith('cycle_')) { targetId = id; break; } }
      }

      // 3. 清理最旧连接
      if (!targetId) targetId = ids[0];

      if (targetId) {
          this._hardClose(window.state.conns[targetId]);
          delete window.state.conns[targetId];
          return true;
      }
      return false;
    },

    _startHealthCheck() {
      if (this._healthTimer) clearInterval(this._healthTimer);
      this._healthTimer = setInterval(() => {
        if (document.hidden) return;
        const count = Object.keys(window.state.conns||{}).length;
        const limit = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
        if (count > limit * 0.8) window.util.log(`💓 [HighLoad] Conns: ${count}/${limit}`);
      }, 10000);
    },

    start() {
      this._safeCall(() => {
        if (window.state.peer && !window.state.peer.destroyed) return;
        if (typeof Peer === 'undefined') { setTimeout(() => this.start(), 200); return; }

        window.util.log(`🚀 [P2P] 启动: ${window.state.myId}`);
        const p = new Peer(window.state.myId, CFG.peer);
        
        p.on('open', id => {
          window.util.log(`✅ [P2P] 就绪: ${id}`);
          window.state.myId = id;
          window.state.peer = p;
          if (window.ui) window.ui.updateSelf();
          this.patrolHubs();
          this._startHealthCheck();
        });

        p.on('connection', conn => this.setupConn(conn));
        
        p.on('error', e => {
          if (e.type === 'peer-unavailable') {
              // 立即清理无效ID
              const deadId = e.message.replace('Could not connect to peer ', '');
              if (deadId && window.state.conns[deadId]) {
                  this._hardClose(window.state.conns[deadId]);
                  delete window.state.conns[deadId];
              }
          } 
          else if (e.message && e.message.includes('Cannot create so many')) {
             window.util.log('🚨 [系统] 资源耗尽，重启...');
             this.stop();
             setTimeout(() => this.start(), 1000);
          }
        });
      }, 'start');
    },

    stop() {
      if (this._healthTimer) clearInterval(this._healthTimer);
      if (window.state.peer) { try { window.state.peer.destroy(); } catch(e) {} window.state.peer = null; }
      Object.values(window.state.conns).forEach(c => this._hardClose(c));
      window.state.conns = {};
      this._connecting.clear();
    },

    connectTo(id) {
      if (!id || id === window.state.myId) return;
      if (!this._checkPeer('connectTo')) return;
      if (window.state.conns[id] && window.state.conns[id].open) return;
      if (this._connecting.has(id)) return;

      this._connecting.add(id);
      
      // 3秒超时强杀
      setTimeout(() => {
        this._connecting.delete(id);
        const c = window.state.conns[id];
        if (c && !c.open) {
            this._hardClose(c);
            delete window.state.conns[id];
            if (window.ui) window.ui.renderList();
        }
      }, 3000);

      this._safeCall(() => {
        if (window.state.conns[id]) {
            this._hardClose(window.state.conns[id]);
            delete window.state.conns[id];
        }

        this._ensureQuota();

        try {
            const conn = window.state.peer.connect(id, { reliable: true });
            conn.created = Date.now();
            conn._targetId = id;
            window.state.conns[id] = conn;
            this.setupConn(conn);
        } catch(err) {
            this._connecting.delete(id);
            if (err.message && err.message.includes('Cannot create so many')) {
                this.stop();
                setTimeout(() => this.start(), 1000);
            }
        }
      }, 'connectTo');
    },

    setupConn(conn) {
      const pid = conn.peer || conn._targetId || 'unknown';
      if (!this._ensureQuota()) { conn.close(); return; }

      conn.on('open', () => {
        this._connecting.delete(pid);
        conn.lastPong = Date.now();
        conn.created = Date.now();
        window.state.conns[pid] = conn;
        
        this._safeCall(() => {
          const list = Object.keys(window.state.conns);
          list.push(window.state.myId);
          
          // [光速握手] 立即发送 Hello 和 邻居列表
          conn.send({ t: MSG_TYPE.HELLO, n: window.state.myName, id: window.state.myId });
          conn.send({ t: MSG_TYPE.PEER_EX, list: list });
          
          window.db.getRecent(1, 'all').then(m => {
            const lastTs = (m && m.length) ? m[0].ts : 0;
            if(conn.open) conn.send({t: MSG_TYPE.ASK_PUB, ts: lastTs});
          });
        }, 'conn.open');
        
        if (window.protocol) window.protocol.retryPending();
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      });

      conn.on('data', d => this._safeCall(() => this.handleData(d, conn), 'handleData'));
      
      const onGone = () => {
        this._connecting.delete(pid);
        this._hardClose(conn);
        delete window.state.conns[pid];
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      };
      conn.on('close', onGone);
      conn.on('error', onGone);
    },

    handleData(d, conn) {
      conn.lastPong = Date.now();
      if (!d || !d.t) return;
      if (d.t === MSG_TYPE.PING) { if (conn.open) conn.send({ t: MSG_TYPE.PONG }); return; }
      if (d.t === MSG_TYPE.PONG) return;
      
      if (d.t === MSG_TYPE.HELLO) {
        conn.label = d.n;
        if (window.protocol) window.protocol.processIncoming({ senderId: d.id, n: d.n });
        return;
      }
      
      if (d.t === MSG_TYPE.PEER_EX && Array.isArray(d.list)) {
        d.list.forEach(id => {
          if (id && id !== window.state.myId && !window.state.conns[id]) {
            const limit = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
            if (Object.keys(window.state.conns).length < limit) this.connectTo(id);
          }
        });
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
          this._hardClose(c);
          delete window.state.conns[pid];
        } else if (c.open && c.lastPong && (now - c.lastPong > NET_PARAMS.PING_TIMEOUT)) {
          if (!pid.startsWith(NET_PARAMS.HUB_PREFIX)) {
            this._hardClose(c);
            delete window.state.conns[pid];
          }
        }
      });
      const all = Object.keys(window.state.conns);
      if (all.length > 0) {
        const pkt = { t: MSG_TYPE.PEER_EX, list: all.slice(0, NET_PARAMS.GOSSIP_SIZE) };
        Object.values(window.state.conns).forEach(c => {
          if (c.open) c.send(pkt);
        });
      }
      if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
    }
  };
}
