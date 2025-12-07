
import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P (Stable-v2)');
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
    },

    start() {
      if (typeof Peer === 'undefined') {
          setTimeout(() => this.start(), 200);
          return;
      }
      
      if (window.state.peer && !window.state.peer.destroyed) return;

      window.util.log(`[P2P] 🚀 启动网络... ID: ${window.state.myId}`);
      try {
        // 关键：开启 debug=0 减少控制台噪音，增加 reliable
        const p = new Peer(window.state.myId, { ...CFG.peer, debug: 0 });
        
        p.on('open', id => {
          window.state.myId = id;
          window.state.peer = p;
          window.util.log(`✅ 网络就绪`);
          this.patrolHubs();
          if (window.ui) window.ui.updateSelf();
        });

        p.on('connection', conn => this.setupConn(conn));
        
        p.on('error', e => {
          if (e.type === 'peer-unavailable') {
              // 对方离线，不做处理，等待重连
              return;
          }
          if (e.type === 'unavailable-id') {
             const newId = 'u_' + Math.random().toString(36).substr(2, 9);
             window.state.myId = newId;
             location.reload();
             return;
          }
          if (e.type === 'disconnected') {
             p.reconnect();
             return;    
          }
        });
      } catch (err) {
        window.util.log('❌ P2P 初始化崩溃: ' + err.message);
      }
    },

    stop() {
        if (window.state.peer) window.state.peer.destroy();
        window.state.conns = {};
    },

    connectTo(id) {
      if (!id || id === window.state.myId) return;
      if (!window.state.peer || window.state.peer.destroyed) return;
      // 如果已经连接且打开，直接返回
      if (window.state.conns[id] && window.state.conns[id].open) return;
      // 正在连接中，也不要重复发起
      if (this._connecting.has(id)) return;
      
      this._connecting.add(id);
      
      // 只有连 Hub 时才显示日志，避免刷屏
      if (id.startsWith(NET_PARAMS.HUB_PREFIX)) {
        window.util.log('🔍 寻找房主...');
      }

      // === 关键修改：超时时间延长到 30秒 ===
      setTimeout(() => {
          this._connecting.delete(id);
          // 超时也不要急着杀，万一正在通了呢
      }, 30000);

      try {
        // 先清理旧的死连接
        const oldConn = window.state.conns[id];
        if (oldConn && !oldConn.open) {
            this._hardClose(oldConn);
            delete window.state.conns[id];
        }
        
        const conn = window.state.peer.connect(id, { reliable: true });
        conn.created = window.util.now();
        this.setupConn(conn);
        window.state.conns[id] = conn;
      } catch (e) {
           this._connecting.delete(id);
      }
    },

    setupConn(conn) {
      const pid = conn.peer;
      
      conn.on('open', () => {
        this._connecting.delete(pid);
        conn.lastPong = Date.now();
        conn.created = Date.now();
        
        window.util.log(`✅ 已连接: ${pid.slice(0, 6)}`);
        window.state.conns[pid] = conn;
        
        // 握手包
        conn.send({ t: MSG_TYPE.HELLO, n: window.state.myName, id: window.state.myId });
        
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      });

      conn.on('data', d => this.handleData(d, conn));
      
      conn.on('close', () => {
        this._connecting.delete(pid);
        delete window.state.conns[pid];
        if (window.ui) { window.ui.renderList(); window.ui.updateSelf(); }
      });
      
      conn.on('error', () => {
        this._connecting.delete(pid);
        delete window.state.conns[pid];
      });
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
      
      // 转发给 Smart Core
      if (d.t.startsWith('SMART_')) {
          if (window.protocol) window.protocol.processIncoming(d, conn.peer);
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
      // === 关键修改：彻底禁用自动杀连接逻辑 ===
      // 只做保活 Ping，绝不主动 Close
      if (!window.state.peer || window.state.peer.destroyed) return;
      
      const all = Object.keys(window.state.conns);
      Object.values(window.state.conns).forEach(c => {
          if (c.open) {
              c.send({ t: MSG_TYPE.PING });
          }
      });
    }
  };
}
