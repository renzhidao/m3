import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

export function init() {
  console.log('📦 加载模块: Protocol (Monitor)');
  
  window.protocol = {
    // 生成并发送消息
    async sendMsg(txt, kind = CHAT.KIND_TEXT, fileInfo = null) {
      const now = window.util.now();
      
      // 防刷屏限制
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

      // 构建消息包
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
      
      // 存入待发送队列并尝试发送
      window.db.addPending(pkt);
      this.retryPending();
    },

    async processIncoming(pkt, fromPeerId) {
      if (!pkt || !pkt.id) return;
      
      // === 新增：SMART_GET 协议探针 (移到最前，防止被 seenMsgs 过滤或后续逻辑吞掉) ===
      if (pkt.t === 'SMART_GET') {
           if(window.monitor) window.monitor.info('Proto', `📨 收到原始 GET 包: Offset ${pkt.offset}`, {from: fromPeerId ? fromPeerId.slice(0,4) : '?'});
           // 注意：这里只打日志，不要 return，因为 smart-core 挂载了 hook 可能会接管处理
           // 或者 smart-core 的 hook 还没执行到？
           // 实际上 smart-core 是 hook 了 processIncoming，所以这里修改的是“原始函数”。
           // 当 hook 执行 originalProcess.apply 时会走到这里。
           // 但 smart-core 的 hook 逻辑是：如果处理了 SMART_GET 就 return，不会调 originalProcess。
           // 所以这段代码其实要加在 smart-core 的 hook 里才最有效，或者加在这里作为兜底？
           // 不，正确的做法是：smart-core 的 hook 已经拦截了 SMART_GET。
           // 如果我们想在 protocol.js 里也能看到，说明 smart-core 没拦截住？
           // 不对，smart-core 是覆盖了 window.protocol.processIncoming。
           // 所以这里的代码，只有在 smart-core 没加载或者没拦截的时候才会执行。
           // **更正**：我在 smart-core.js 里已经处理了 hook。
           // 这里保留原始逻辑即可。如果在 smart-core 加载前收到包，这里会处理。
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
          conn.send(pkt);
        }
      });
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
                conn.send(pkt);
                sent = true;
                if(window.monitor) window.monitor.info('Proto', `➡️ 直连发送: ${pkt.target.slice(0,4)}`);
            } catch(e) {
                if(window.monitor) window.monitor.error('Proto', `发送失败`, e);
            }
          } else {
            if(window.monitor) window.monitor.warn('Proto', `⏳ 目标断开，等待重连: ${pkt.target.slice(0,4)}`);
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
