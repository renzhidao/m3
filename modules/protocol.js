import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

export function init() {
  console.log('📦 加载模块: Protocol (Safe Mode)');
  
  window.protocol = {
    async sendMsg(txt, kind = CHAT.KIND_TEXT, fileInfo = null) {
      const now = window.util.now();
      
      if (now - window.state.lastMsgTime < 1000) {
        window.state.msgCount++;
        if (window.state.msgCount > 5) {
          window.util.log('⚠️ 发送太快，请稍候');
          return;
        }
      } else {
        window.state.msgCount = 0;
        window.state.lastMsgTime = now;
      }

      const pkt = {
        t: MSG_TYPE.MSG,
        id: window.util.uuid(),
        n: window.state.myName,
        senderId: window.state.myId,
        target: window.state.activeChat,
        txt: txt, 
        kind: kind,
        ts: now,
        ttl: NET_PARAMS.GOSSIP_SIZE
      };

      if (kind === CHAT.KIND_FILE && fileInfo) {
        pkt.fileName = fileInfo.name;
        pkt.fileSize = fileInfo.size;
        pkt.fileType = fileInfo.type;
      }

      this.processIncoming(pkt);
      window.db.addPending(pkt);
      this.retryPending();
    },

    async processIncoming(pkt, fromPeerId) {
      if (!pkt || !pkt.id) return;
      
      if (pkt.t === 'SMART_GET') {
           // Debug: 仅用于监控，不处理逻辑
           if(window.monitor) window.monitor.info('Proto', `📨 收到原始 GET 包: Offset ${pkt.offset}`, {from: fromPeerId ? fromPeerId.slice(0,4) : '?'});
      }

      if (window.state.seenMsgs.has(pkt.id)) return;
      window.state.seenMsgs.add(pkt.id);

      pkt.ts = pkt.ts || (window.state.latestTs + 1);
      window.state.latestTs = Math.max(window.state.latestTs, pkt.ts);

      if (pkt.n && pkt.senderId) {
        window.state.contacts[pkt.senderId] = { 
           id: pkt.senderId, 
           n: pkt.n, 
           t: window.util.now() 
         };
        localStorage.setItem('p1_contacts', JSON.stringify(window.state.contacts));
      }

      const isPublic = pkt.target === CHAT.PUBLIC_ID;
      const isToMe = pkt.target === window.state.myId;
      const isFromMe = pkt.senderId === window.state.myId;

      if (isPublic || isToMe || isFromMe) {
        const chatKey = isPublic ? CHAT.PUBLIC_ID : (isFromMe ? pkt.target : pkt.senderId);
        
        if (window.state.activeChat !== chatKey) {
           window.state.unread[chatKey] = (window.state.unread[chatKey] || 0) + 1;
           if (window.ui) window.ui.renderList();
        } else {
           if (window.ui) window.ui.appendMsg(pkt);
        }
        window.db.saveMsg(pkt);
      }

      if (isPublic) {
        this.flood(pkt, fromPeerId);
      }
    },

    flood(pkt, excludePeerId) {
      if (typeof pkt.ttl === 'number') {
        if (pkt.ttl <= 0) return; 
        pkt = { ...pkt, ttl: pkt.ttl - 1 };
      }
      
      Object.values(window.state.conns).forEach(conn => {
        if (conn.open && conn.peer !== excludePeerId) {
          this.safeSend(conn, pkt);
        }
      });
    },

    // === 新增：安全发送（带流控保护） ===
    safeSend(conn, pkt) {
        try {
            const dc = conn.dataChannel;
            // 如果缓冲区太满 (>2MB)，暂缓发送文本（直接丢弃或排队）
            // 这里选择丢弃非关键包，防止阻塞文件流
            if (dc && dc.bufferedAmount > 2 * 1024 * 1024) {
                if (window.monitor) window.monitor.warn('Proto', `⚠️ 通道拥塞，跳过文本广播`, {to: conn.peer.slice(0,4)});
                return;
            }
            conn.send(pkt);
        } catch(e) {
            // console.error(e);
        }
    },

    async retryPending() {
      const list = await window.db.getPending();
      if (!list || list.length === 0) return;

      for (const pkt of list) {
        let sent = false;
        
        if (pkt.target === CHAT.PUBLIC_ID) {
          this.flood(pkt, null);
          sent = true;
          if(window.monitor) window.monitor.info('Proto', `📢 广播消息: ${pkt.id.slice(0,4)}`);
        } else {
          const conn = window.state.conns[pkt.target];
          
          if (conn && conn.open) {
            try {
                this.safeSend(conn, pkt);
                sent = true;
                if(window.monitor) window.monitor.info('Proto', `➡️ 直连发送: ${pkt.target.slice(0,4)}`);
            } catch(e) {
                if(window.monitor) window.monitor.error('Proto', `发送失败`, e);
            }
          } else {
            // if(window.monitor) window.monitor.warn('Proto', `⏳ 目标断开，等待重连: ${pkt.target.slice(0,4)}`);
            if (window.p2p) window.p2p.connectTo(pkt.target);
          }
        }
        
        if (sent) {
            await window.db.removePending(pkt.id);
        }
      }
    }
  };
}
