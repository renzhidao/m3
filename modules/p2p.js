import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (Monitored)');
  const CFG = window.config;

  window.p2p = {
    _searchLogShown: false,
    _waitLogShown: false,
    _connecting: new Set(),

    _hardClose(conn) {
      if (!conn) return;
      const p = window.state.peer;
      try { conn.removeAllListeners(); } catch(e){}
      try { conn.close(); } catch(e){}
      try {
          if (conn.peerConnection) {
            conn.peerConnection.onnegotiationneeded = null;
            conn.peerConnection.onicecandidate = null;
            conn.peerConnection.ondatachannel = null;
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

    start() {
      if (typeof Peer === 'undefined') {
          setTimeout(() => this.start(), 200);
          return;
      }
      
      if (window.state.peer && !window.state.peer.destroyed) return;

      if(window.monitor) window.monitor.info('P2P', `正在启动... ID: ${window.state.myId}`);
      try {
        const p = new Peer(window.state.myId, CFG.peer);
        
        p.on('open', id => {
          window.state.myId = id;
          window.state.peer = p;
          if(window.monitor) window.monitor.info('P2P', `✅ 就绪: ${id.slice(0, 6)}`);
          if (window.ui) window.ui.updateSelf();
          this.patrolHubs();
        });

        p.on('connection', conn => this.setupConn(conn));
        
        p.on('error', e => {
          if(window.monitor) window.monitor.error('P2P', `错误: ${e.type}`, e);
          if (e.type === 'unavailable-id') {
             const newId = 'u_' + Math.random().toString(36).substr(2, 9);
             window.state.myId = newId;
             localStorage.setItem('p1_my_id', newId);
             location.reload();
             return;
          }
          if (e.type === 'disconnected') {
             p.reconnect();
             return;    
          }
          if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
             setTimeout(() => this.start(), 5000);
          }
        });
      } catch (err) {
        if(window.monitor) window.monitor.fatal('P2P', `初始化崩溃: ${err.message}`);
      }
    },

    stop() {
        if(window.monitor) window.monitor.warn('P2P', '停止服务');
        if (window.state.peer) {
            try { window.state.peer.destroy(); } catch(e){}
            window.state.peer = null;
        }
        Object.values(window.state.conns).forEach(c => this._hardClose(c));
        window.state.conns = {};
        this._connecting.clear();
        if (window.ui) window.ui.updateSelf();
    },

    connectTo(id) {
      if (!id || id === window.state.myId) return;
      if (!window.state.peer || window.state.peer.destroyed) return;
      if (window.state.conns[id] && window.state.conns[id].open) return;
      if (this._connecting.has(id)) return;
      
      this._connecting.add(id);
      
      setTimeout(() => {
          this._connecting.delete(id);
          const c = window.state.conns[id];
          if (c && !c.open) {
              this._hardClose(c);
              delete window.state.conns[id];
          }
      }, NET_PARAMS.CONN_TIMEOUT);

      try {
        const oldConn = window.state.conns[id];
        if (oldConn) {
            this._hardClose(oldConn);
            delete window.state.conns[id];
        }
        
        const conn = window.state.peer.connect(id, { reliable: true });
        conn.created = window.util.now();
        conn._targetId = id; 
        this.setupConn(conn);
        window.state.conns[id] = conn;
      } catch (e) {
           this._connecting.delete(id);
      }
    },

    setupConn(conn) {
      const pid = conn.peer || conn._targetId || 'unknown';
      const max = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
      
      if (Object.keys(window.state.conns).length >= max + 50) {
         conn.close();
         return;
      }

      conn.on('open', () => {
        this._connecting.delete(pid);
        conn.lastPong = Date.now();
        conn.created = Date.now();
        
        if(window.monitor) window.monitor.info('P2P', `连接建立: ${pid.slice(0, 8)}`);
        window.state.conns[pid] = conn;
        
        const list = Object.keys(window.state.conns);
        list.push(window.state.myId);
        conn.send({ t: MSG_TYPE.HELLO, n: window.state.myName, id: window.state.myId });
        
        setTimeout(() => { if (conn.open) conn.send({ t: MSG_TYPE.PEER_EX, list: list }); }, 100);
        
        window.db.getRecent(1, 'all').then(m => {
            const lastTs = (m && m.length) ? m[0].ts : 0;
            setTimeout(() => {
                if(conn.open) conn.send({t: MSG_TYPE.ASK_PUB, ts: lastTs});
            }, 500);
        });
        
        if (window.protocol) window.protocol.retryPending();
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      });

      conn.on('data', d => this.handleData(d, conn));
      
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
      
      if (d instanceof ArrayBuffer || d instanceof Uint8Array || (d.buffer && d.buffer instanceof ArrayBuffer)) {
          if (window.smartCore && window.smartCore.handleBinary) {
              window.smartCore.handleBinary(d, conn.peer);
          }
          return;
      }
      
      if (!d || !d.t) return;
      
      if (d.t === MSG_TYPE.PING) { conn.send({ t: MSG_TYPE.PONG }); return; }
      if (d.t === MSG_TYPE.PONG) return;
      
      if (d.t === MSG_TYPE.HELLO) {
        conn.label = d.n;
        if (window.protocol) window.protocol.processIncoming({ senderId: d.id, n: d.n });
        return;
      }
      
      if (d.t === MSG_TYPE.PEER_EX && Array.isArray(d.list)) {
        d.list.forEach(id => {
           if (id && id !== window.state.myId && !window.state.conns[id]) {
             if (Object.keys(window.state.conns).length < NET_PARAMS.MAX_PEERS_NORMAL) {
               this.connectTo(id);
             }
           }
        });
        return;
      }
      
      if (d.t === MSG_TYPE.ASK_PUB) {
         window.db.getPublicAfter(d.ts || 0).then(list => {
             if (list.length > 0) conn.send({t: MSG_TYPE.REP_PUB, list: list});
         });
         return;
      }
      
      if (d.t === MSG_TYPE.REP_PUB && Array.isArray(d.list)) {
          d.list.forEach(m => {
              if (window.protocol) window.protocol.processIncoming(m);
          });
          return;
      }

      if (d.t === MSG_TYPE.MSG) {
        if (window.protocol) window.protocol.processIncoming(d, conn.peer);
      }
    },

    patrolHubs() {
      if (!window.state.peer || window.state.peer.destroyed) return;
      for (let i = 0; i < NET_PARAMS.HUB_COUNT; i++) {
        const targetId = NET_PARAMS.HUB_PREFIX + i;
        if (targetId === window.state.myId) continue;
        if (!window.state.conns[targetId] || !window.state.conns[targetId].open) {
          this.connectTo(targetId);
        }
      }
    },

    maintenance() {
      if (!window.state.peer || window.state.peer.destroyed) return;
      const now = Date.now();
      
      Object.keys(window.state.conns).forEach(pid => {
        const c = window.state.conns[pid];
        if (!c.open && now - (c.created || 0) > NET_PARAMS.CONN_TIMEOUT) {
           this._hardClose(c);
           delete window.state.conns[pid];
           return;
        }
        if (c.open && c.lastPong && (now - c.lastPong > NET_PARAMS.PING_TIMEOUT)) {
           if (!pid.startsWith(NET_PARAMS.HUB_PREFIX)) {
               this._hardClose(c);
               delete window.state.conns[pid];
               return;
           }
        }
      });

      const all = Object.keys(window.state.conns);
      if (all.length > 0) {
         const pkt = { t: MSG_TYPE.PEER_EX, list: all.slice(0, NET_PARAMS.GOSSIP_SIZE) };
         Object.values(window.state.conns).forEach(c => {
             if (c.open) {
                 c.send({ t: MSG_TYPE.PING });
                 c.send(pkt);
             }
         });
      }
    }
  };
}