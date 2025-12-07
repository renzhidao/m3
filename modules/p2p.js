import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (NoTimeout v37)');
  const CFG = window.config;

  window.p2p = {
    _connecting: new Set(),
    _healthTimer: null,
    _lastReconnect: 0,

    _checkPeer(caller) {
      const p = window.state.peer;
      return (p && !p.destroyed);
    },

    _safeCall(fn, caller) {
      try { return fn(); } catch (e) {
        window.util.log(`❌ [${caller}] 异常: ${e.message}`);
      }
    },

    // === 深度清理 (仅在断开后执行) ===
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
      const limit = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
      const ids = Object.keys(window.state.conns);
      if (ids.length < limit) return true;

      // 满了只踢死链
      let targetId = null;
      for (const id of ids) { if (!window.state.conns[id].open) { targetId = id; break; } }
      
      if (targetId) {
          this._hardClose(window.state.conns[targetId]);
          delete window.state.conns[targetId];
          return true;
      }
      return false;
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
          
          if (this._healthTimer) clearInterval(this._healthTimer);
          this._healthTimer = setInterval(() => this.maintenance(), 5000);
        });

        p.on('connection', conn => {
            window.util.log(`🔗 收到连接请求: ${conn.peer.slice(0,6)}..`);
            this.setupConn(conn);
        });
        
        p.on('disconnected', () => {
             window.util.log('🔌 与信令服务器断开，自动重连...');
             this._reconnect(p);
        });

        p.on('close', () => {
             window.util.log('☠️ Peer 销毁，准备重启...');
             this.stop();
             setTimeout(() => this.start(), 1000);
        });
        
        p.on('error', e => {
          if (e.type === 'peer-unavailable') {
              // 只有对方真不存在了才删
              const deadId = e.message.replace('Could not connect to peer ', '');
              if (deadId && window.state.conns[deadId]) {
                  this._hardClose(window.state.conns[deadId]);
                  delete window.state.conns[deadId];
              }
          } 
          else if (e.type === 'disconnected' || e.type === 'network' || e.type === 'server-error') {
             this._reconnect(p);
          }
          else if (e.message && e.message.includes('Cannot create so many')) {
             window.util.log('🚨 资源耗尽，重启...');
             this.stop();
             setTimeout(() => this.start(), 1000);
          } else {
             window.util.log(`❌ [P2P] ${e.type}`);
          }
        });
      }, 'start');
    },

    _reconnect(p) {
        if (!p || p.destroyed) return;
        const now = Date.now();
        if (now - this._lastReconnect < 2000) return;
        this._lastReconnect = now;
        try { p.reconnect(); } catch(e) { this.stop(); setTimeout(() => this.start(), 1000); }
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
      if (window.state.conns[id] && window.state.conns[id].open) return;
      if (this._connecting.has(id)) return;

      this._connecting.add(id);
      
      // === 移除这里所有的 setTimeout 超时强杀 ===
      // 让它一直连，直到成功或者报错 error

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
        
        window.util.log(`✅ 连接建立: ${pid.slice(0,6)}..`);
        
        const list = Object.keys(window.state.conns);
        list.push(window.state.myId);
        
        conn.send({ t: MSG_TYPE.HELLO, n: window.state.myName, id: window.state.myId });
        conn.send({ t: MSG_TYPE.PEER_EX, list: list });
        
        window.db.getRecent(1, 'all').then(m => {
           const lastTs = (m && m.length) ? m[0].ts : 0;
           if(conn.open) conn.send({t: MSG_TYPE.ASK_PUB, ts: lastTs});
        });

        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      });

      conn.on('data', d => this._safeCall(() => this.handleData(d, conn), 'handleData'));
      
      const onGone = () => {
        this._connecting.delete(pid);
        // 只有真的断了才清理
        if (window.state.conns[pid]) {
             window.util.log(`🔌 连接断开: ${pid.slice(0,6)}..`);
             this._hardClose(conn);
             delete window.state.conns[pid];
             if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
        }
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
        window.util.log(`👋 收到Hello: ${d.n}`);
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
        
        // 握手超时放宽到 30秒
        if (!c.open && now - (c.created || 0) > 30000) {
          // window.util.log(`💀 握手太久放弃: ${pid}`);
          this._hardClose(c);
          delete window.state.conns[pid];
        } 
        // 心跳超时放宽到 60秒
        else if (c.open && c.lastPong && (now - c.lastPong > 60000)) {
          if (!pid.startsWith(NET_PARAMS.HUB_PREFIX)) {
            // window.util.log(`💔 心跳丢失: ${pid}`);
            this._hardClose(c);
            delete window.state.conns[pid];
          }
        }
      });
      const all = Object.keys(window.state.conns);
      if (all.length > 0) {
        const pkt = { t: MSG_TYPE.PEER_EX, list: all.slice(0, NET_PARAMS.GOSSIP_SIZE) };
        Object.values(window.state.conns).forEach(c => {
          if (c.open) { c.send({t: MSG_TYPE.PING}); c.send(pkt); }
        });
      }
      if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
    }
  };
}
