import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (Strict GC v5)');
  const CFG = window.config;
  // 严格配额：平时不超过50，压测时会被压满但应能循环回收
  const QUOTA_LIMIT = 50; 

  window.p2p = {
    _searchLogShown: false,
    _waitLogShown: false,
    _connecting: new Set(),
    _healthTimer: null,

    _checkPeer(caller) {
      const p = window.state.peer;
      if (!p || p.destroyed) return false;
      return true;
    },

    _safeCall(fn, caller) {
      try { return fn(); } catch (e) {
        window.util.log(`❌ [${caller}] 异常: ${e.message}`);
      }
    },

    // === 终极回收 ===
    _hardClose(conn) {
      if (!conn) return;
      // 1. 清理 PeerJS 引用
      try { conn.close(); } catch(e){}
      
      // 2. 清理底层 RTC
      try { 
        if (conn.peerConnection) {
            conn.peerConnection.onicecandidate = null;
            conn.peerConnection.oniceconnectionstatechange = null;
            conn.peerConnection.onnegotiationneeded = null;
            conn.peerConnection.close(); 
        }
      } catch(e){}
      
      // 3. 斩断引用，辅助 GC
      conn.peerConnection = null;
      conn.dataChannel = null;
    },

    // === 严格控量 ===
    _ensureQuota() {
      const ids = Object.keys(window.state.conns);
      if (ids.length < QUOTA_LIMIT) return true;

      // 必须腾出至少一个位置
      let targetId = null;
      
      // 1. 优先杀废弃连接
      for (const id of ids) {
          if (!window.state.conns[id].open) { targetId = id; break; }
      }
      
      // 2. 其次杀最早的非 Hub 连接
      if (!targetId) {
          let oldest = Infinity;
          for (const id of ids) {
              if (id.startsWith(NET_PARAMS.HUB_PREFIX)) continue;
              if (id.startsWith('stress_')) { targetId = id; break; } // 压测产生的优先杀
              const c = window.state.conns[id];
              if (c.created < oldest) { oldest = c.created; targetId = id; }
          }
      }

      // 3. 实在没得杀（全是 Hub），也得杀一个 Hub
      if (!targetId && ids.length > 0) targetId = ids[0];

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
      const count = Object.keys(s.conns || {}).length;
      let peerStatus = p ? `open=${p.open}` : 'N/A';
      window.util.log(`💓 [健康] Peer(${peerStatus}) 连接(${count}) MQTT(${s.mqttStatus})`);
    },

    start() {
      this._safeCall(() => {
        if (window.state.peer && !window.state.peer.destroyed) return;
        if (typeof Peer === 'undefined') { setTimeout(() => this.start(), 200); return; }

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

        p.on('connection', conn => this.setupConn(conn));
        
        p.on('disconnected', () => {
           // window.util.log(`📡 [P2P] Disconnected`);
           if(p && !p.destroyed) try { p.reconnect(); } catch(e){}
        });

        p.on('error', e => {
          if (e.type === 'unavailable-id') {
            const newId = 'u_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('p1_my_id', newId);
            window.state.myId = newId;
            setTimeout(() => location.reload(), 500);
            return;
          }
          if (e.message && e.message.includes('Cannot create so many')) {
             window.util.log('🚨 [系统] 资源耗尽，重启 Peer...');
             this.stop();
             setTimeout(() => this.start(), 1000);
          }
        });
      }, 'start');
    },

    stop() {
      if (this._healthTimer) clearInterval(this._healthTimer);
      if (window.state.peer) { try { window.state.peer.destroy(); } catch(e){} window.state.peer = null; }
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
      setTimeout(() => this._connecting.delete(id), 5000);

      this._safeCall(() => {
        if (window.state.conns[id]) {
            this._hardClose(window.state.conns[id]);
            delete window.state.conns[id];
        }

        // 关键：确保有位置再连
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
                window.util.log('🚨 [系统] 资源耗尽(Connect)，重启...');
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
        } else if (c.open && c.lastPong && (now - c.lastPong > NET_PARAMS.PING_TIMEOUT)) {
          if (!pid.startsWith(NET_PARAMS.HUB_PREFIX)) {
            this._hardClose(c);
            delete window.state.conns[pid];
          }
        }
      });
      // 心跳
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