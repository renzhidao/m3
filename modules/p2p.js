import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (Hard-Kill & Anti-Suicide)');
  const CFG = window.config;

  window.p2p = {
    _searchLogShown: false,
    _waitLogShown: false,
    _connecting: new Set(),

    // === 修复：暴力端口释放 ===
    _hardClose(conn) {
      if (!conn) return;
      
      const p = window.state.peer;
      const pid = conn.peer;

      // 1. 移除所有JS监听器，防止回调诈尸
      try { conn.removeAllListeners(); } catch(e){}
      
      // 2. 强制关闭 DataChannel
      try { conn.close(); } catch(e){}
      
      // 3. 深入底层：直接销毁 RTCPeerConnection，释放 UDP 端口
      try {
          if (conn.peerConnection) {
            conn.peerConnection.onnegotiationneeded = null;
            conn.peerConnection.onicecandidate = null;
            conn.peerConnection.ondatachannel = null;
            conn.peerConnection.close(); // 这是释放端口的关键
            conn.peerConnection = null;
         }
      } catch(e){}
      
      // 4. 从 PeerJS 内部缓存中剔除
      if (p && p._connections && pid) {
          const list = p._connections.get(pid);
          if (list) {
              const idx = list.indexOf(conn);
              if (idx > -1) list.splice(idx, 1);
              if (list.length === 0) p._connections.delete(pid);
          }
      }
      
      // 5. 显式 GC 标记
      conn = null;
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
          if (e.type === 'peer-unavailable') {
              // 仅记录 info，不报错
              // if(window.monitor) window.monitor.info('P2P', `节点离线: ${e.message}`);
              
              const deadId = e.message.replace('Could not connect to peer ', '');
              if (deadId && window.state.conns[deadId]) {
                  this._hardClose(window.state.conns[deadId]);
                  delete window.state.conns[deadId];
              }
              return;
          }
          
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
      
      // === 修复：铁闸机制 ===
      // 如果已经有活着的连接，绝对不要发起新的！防止自杀式重连
      const existing = window.state.conns[id];
      if (existing && existing.open) {
          return;
      }
      
      if (this._connecting.has(id)) return;
      this._connecting.add(id);
      
      setTimeout(() => {
          this._connecting.delete(id);
          // 超时没连上，清理残骸
          const c = window.state.conns[id];
          if (c && !c.open) {
              this._hardClose(c);
              delete window.state.conns[id];
          }
      }, NET_PARAMS.CONN_TIMEOUT);

      try {
        // === 修复：连接前先清理僵尸 ===
        // 既然决定要连，说明旧连接肯定不行了（或者不存在），先杀干净
        if (existing) {
            this._hardClose(existing);
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
        
        // 覆盖旧连接（如果有）
        if (window.state.conns[pid] && window.state.conns[pid] !== conn) {
            this._hardClose(window.state.conns[pid]);
        }
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
        // 只有当这个 conn 确实是当前记录的 conn 时才清理，防止误删新连接
        if (window.state.conns[pid] === conn) {
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