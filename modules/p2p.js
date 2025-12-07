import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (GC Master v4.1)');
  const CFG = window.config;
  const HARD_LIMIT = 350; // 连接数硬上限

  window.p2p = {
    _searchLogShown: false,
    _waitLogShown: false,
    _connecting: new Set(),
    _healthTimer: null,

    _checkPeer(caller) {
      const p = window.state.peer;
      if (!p) return false;
      if (p.destroyed) return false;
      return true;
    },

    _safeCall(fn, caller) {
      try { return fn(); } catch (e) {
        window.util.log(`❌ [${caller}] 异常: ${e.message}`);
      }
    },

    _hardClose(conn) {
      if (!conn) return;
      try { conn.close(); } catch(e){}
      try { 
        if (conn.peerConnection) {
            conn.peerConnection.oniceconnectionstatechange = null;
            conn.peerConnection.close(); 
        }
      } catch(e){}
      conn.peerConnection = null;
    },

    _ensureQuota() {
      const ids = Object.keys(window.state.conns);
      if (ids.length < HARD_LIMIT) return true;

      let targetId = null;
      let oldest = Infinity;

      for (const id of ids) {
          const c = window.state.conns[id];
          if (!c.open) { targetId = id; break; }
      }

      if (!targetId) {
          for (const id of ids) {
              if (id.startsWith(NET_PARAMS.HUB_PREFIX)) continue;
              const c = window.state.conns[id];
              if (c.created < oldest) {
                  oldest = c.created;
                  targetId = id;
              }
          }
      }

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
      this._safeCall(() => {
        if (window.state.peer && !window.state.peer.destroyed) return;
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
          this.setupConn(conn);
        });

        p.on('disconnected', () => {
          window.util.log(`📡 [P2P] Peer.disconnected`);
          if (p && !p.destroyed) try { p.reconnect(); } catch(e){}
        });

        p.on('error', e => {
          if (e.type === 'unavailable-id') {
            const newId = 'u_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('p1_my_id', newId);
            window.state.myId = newId;
            setTimeout(() => location.reload(), 500);
            return;
          }
          if (e.message && (e.message.includes('Cannot create so many') || e.message.includes('Constructing a PeerConnection'))) {
             window.util.log('🚨 [系统] 资源耗尽(PeerError)，正在重启...');
             this.stop();
             setTimeout(() => this.start(), 1000);
          } else {
             window.util.log(`❌ [P2P] Error: ${e.type} - ${e.message}`);
          }
        });
      }, 'start');
    },

    stop() {
      if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
      if (window.state.peer) {
        try { window.state.peer.destroy(); } catch(e) {}
        window.state.peer = null;
      }
      Object.values(window.state.conns).forEach(c => this._hardClose(c));
      window.state.conns = {};
      this._connecting.clear();
      if (window.ui) window.ui.updateSelf();
    },

    connectTo(id) {
      if (!id || id === window.state.myId) return;
      if (!this._checkPeer('connectTo')) return;
      if (window.state.conns[id] && window.state.conns[id].open) return;
      if (this._connecting.has(id)) return;

      this._connecting.add(id);
      setTimeout(() => this._connecting.delete(id), 8000);

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
            if (err.message && (err.message.includes('Cannot create so many') || err.message.includes('Constructing a PeerConnection'))) {
                window.util.log('🚨 [系统] 资源耗尽(Connect)，重启...');
                this.stop();
                setTimeout(() => this.start(), 1000);
            }
        }
      }, 'connectTo');
    },

    setupConn(conn) {
      const pid = conn.peer || conn._targetId || 'unknown';
      if (!this._ensureQuota()) {
          conn.on('open', () => conn.close());
          return;
      }

      conn.on('open', () => {
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
          this._hardClose(c);
          delete window.state.conns[pid];
        }
        else if (c.open && c.lastPong && (now - c.lastPong > NET_PARAMS.PING_TIMEOUT)) {
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
          if (c.open) this._safeCall(() => { c.send({ t: MSG_TYPE.PING }); c.send(pkt); }, 'maintenance.send');
        });
      }
      if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
    }
  };
}