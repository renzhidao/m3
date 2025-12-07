import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (Leak Guard v7)');
  const CFG = window.config;
  const QUOTA_LIMIT = 3; 

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

    // === 深度清理 ===
    _hardClose(conn) {
      if (!conn) return;
      const p = window.state.peer;
      
      // 0. 移除所有事件监听，防止闭包泄露
      try { conn.removeAllListeners(); } catch(e){}

      // 1. 关闭连接
      try { conn.close(); } catch(e){}
      
      // 2. 关闭底层 PeerConnection
      try { 
        if (conn.peerConnection) {
            conn.peerConnection.onicecandidate = null;
            conn.peerConnection.onnegotiationneeded = null;
            conn.peerConnection.ondatachannel = null;
            conn.peerConnection.close(); 
        }
      } catch(e){}
      
      // 3. 从 PeerJS 内部缓存中移除
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
      const ids = Object.keys(window.state.conns);
      if (ids.length < QUOTA_LIMIT) return true;

      let targetId = null;
      // 1. 先踢没连上的
      for (const id of ids) { if (!window.state.conns[id].open) { targetId = id; break; } }
      
      // 2. 再踢压测产生的
      if (!targetId) {
          for (const id of ids) { if (id.startsWith('cycle_')) { targetId = id; break; } }
      }

      // 3. 踢最旧的
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
        // 只有连接数异常多时才打印
        if (count > QUOTA_LIMIT) window.util.log(`💓 [健康] Conns: ${count}/${QUOTA_LIMIT}`);
      }, 10000);
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
          if (window.ui) window.ui.updateSelf();
          this.patrolHubs();
          this._startHealthCheck();
        });

        p.on('connection', conn => this.setupConn(conn));
        
        p.on('error', e => {
          if (e.type === 'peer-unavailable') {
              // 自动清理连不上的悬挂连接
              const deadId = e.message.replace('Could not connect to peer ', '');
              if (deadId && window.state.conns[deadId]) {
                  this._hardClose(window.state.conns[deadId]);
                  delete window.state.conns[deadId];
              }
              // 不再弹窗刷屏
              // window.util.log(`❌ 节点不可达: ${deadId}`); 
          } 
          else if (e.message && e.message.includes('Cannot create so many')) {
             window.util.log('🚨 [系统] 资源耗尽，重启 Peer...');
             this.stop();
             setTimeout(() => this.start(), 1000);
          } else {
             window.util.log(`❌ [P2P] Error: ${e.type}`);
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
      setTimeout(() => {
        this._connecting.delete(id);
        // [超时清理] 如果5秒还没连上，直接杀掉，不留活口
        const c = window.state.conns[id];
        if (c && !c.open) {
            // window.util.log(`⏱️ 连接超时: ${id}`);
            this._hardClose(c);
            delete window.state.conns[id];
            if (window.ui) window.ui.renderList();
        }
      }, 5000);

      this._safeCall(() => {
        if (window.state.conns[id]) {
            this._hardClose(window.state.conns[id]);
            delete window.state.conns[id];
        }

        this._ensureQuota(); // 腾位置

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
        d.list.forEach(id => {
          if (id && id !== window.state.myId && !window.state.conns[id]) {
            if (Object.keys(window.state.conns).length < NET_PARAMS.MAX_PEERS_NORMAL) this.connectTo(id);
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
          if (c.open) this._safeCall(() => { c.send({ t: MSG_TYPE.PING }); c.send(pkt); }, 'maintenance.send');
        });
      }
      if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
    }
  };
}
