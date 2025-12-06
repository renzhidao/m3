import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (Fixed v2)');
  const CFG = window.config;

  window.p2p = {
    _searchLogShown: false,
    _waitLogShown: false,
    _connecting: new Set(), // 连接锁

    start() {
      if (window.state.peer && !window.state.peer.destroyed) return;

      if (typeof Peer === 'undefined') {
          if (!this._waitLogShown) {
              window.util.log('[P2P] ⏳ Peer库未就绪，开始等待...');
              this._waitLogShown = true;
          }
          setTimeout(() => this.start(), 200);
          return;
      }

      window.util.log(`[P2P] 🚀 正在启动... ID: ${window.state.myId}`);
      
      try {
        const p = new Peer(window.state.myId, CFG.peer);

        p.on('open', id => {
          window.state.myId = id;
          window.state.peer = p;
          this._searchLogShown = false;
          window.util.log(`✅ 就绪: ${id.slice(0, 6)}`);
          
          if (window.ui) window.ui.updateSelf();
          this.patrolHubs();
        });

        p.on('connection', conn => this.setupConn(conn));

        p.on('error', e => {
          if (e.type === 'unavailable-id') {
             window.util.log('⚠️ ID冲突，正在自动更换...');
             const newId = 'u_' + Math.random().toString(36).substr(2, 9);
             localStorage.setItem('p1_my_id', newId);
             window.state.myId = newId;
             location.reload(); 
             return;
          }

          if (e.type === 'peer-unavailable') return; 
          
          if (e.type === 'browser-incompatible') {
             window.util.log('❌ [系统] WebRTC 引擎不可用');
             return;
          }

          if (e.type === 'disconnected') {
             if (!this._searchLogShown) {
               window.util.log('📡 正在重连 P2P 网络...');
               this._searchLogShown = true;
             }
             p.reconnect();
             return;
          }

          if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
             setTimeout(() => this.start(), 5000);
          }
        });
      } catch (err) {
        window.util.log('❌ P2P 初始化崩溃: ' + err.message);
      }
    },

    stop() {
        if (window.state.peer) {
            window.util.log('🛑 [系统] 暂停 P2P 服务');
            try { window.state.peer.destroy(); } catch(e){}
            window.state.peer = null;
        }
        window.state.conns = {};
        this._connecting.clear(); // 清空锁
        if (window.ui) window.ui.updateSelf();
    },

    connectTo(id) {
      if (!id || id === window.state.myId) return;
      if (!window.state.peer || window.state.peer.destroyed) return;
      
      // 已连接或正在连接，直接跳过
      if (window.state.conns[id] && window.state.conns[id].open) return;
      if (this._connecting.has(id)) return;

      this._connecting.add(id);

      // 5秒后自动释放锁，防止死锁
      setTimeout(() => this._connecting.delete(id), 5000);

      try {
        const conn = window.state.peer.connect(id, { reliable: true });
        conn.created = window.util.now();
        window.state.conns[id] = conn; 
        this.setupConn(conn);
      } catch (e) { 
          this._connecting.delete(id);
      }
    },

    setupConn(conn) {
      const max = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
      if (Object.keys(window.state.conns).length >= max) {
        conn.on('open', () => {
          conn.send({ t: MSG_TYPE.PEER_EX, list: Object.keys(window.state.conns).slice(0, 10) });
          setTimeout(() => conn.close(), 500);
        });
        return;
      }

      conn.on('open', () => {
        this._connecting.delete(conn.peer); // 连接成功，释放锁

        conn.lastPong = Date.now();
        conn.created = Date.now();
        window.state.conns[conn.peer] = conn;
        
        window.util.log(`✅ [P2P] 连接: ${conn.peer.slice(0, 6)}`);
        
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
        const pid = conn.peer;
        this._connecting.delete(pid); // 断开也释放锁
        delete window.state.conns[pid];
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      };
      conn.on('close', onGone);
      conn.on('error', onGone);
    },

    handleData(d, conn) {
      conn.lastPong = Date.now();
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
           delete window.state.conns[pid];
        }
        if (c.open && c.lastPong && (now - c.lastPong > NET_PARAMS.PING_TIMEOUT)) {
           if (!pid.startsWith(NET_PARAMS.HUB_PREFIX)) {
               c.close();
               delete window.state.conns[pid];
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
      
      if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
    }
  };
}