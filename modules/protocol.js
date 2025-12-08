import { MSG_TYPE, NET_PARAMS, CHAT } from './constants.js';

export function init() {
  console.log(' 加载模块: Protocol (Strict-Conn)');
  
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
        txt: txt, // 对于文件/图片，这里是 Base64 数据
        kind: kind,
        ts: now,
        ttl: NET_PARAMS.GOSSIP_SIZE // 使用默认跳数
      };

      // 如果是文件，附加元数据
      if (kind === CHAT.KIND_FILE && fileInfo) {
        pkt.fileName = fileInfo.name;
        pkt.fileSize = fileInfo.size;
        pkt.fileType = fileInfo.type;
      }

      // 本地处理
      this.processIncoming(pkt);
      
      // 存入待发送队列并尝试发送
      window.db.addPending(pkt);
      this.retryPending();
    },

    // 处理接收到的数据包
    async processIncoming(pkt, fromPeerId) {
      if (!pkt || !pkt.id) return;

      // 1. 去重：如果处理过该消息，直接忽略
      if (window.state.seenMsgs.has(pkt.id)) return;
      window.state.seenMsgs.add(pkt.id);

      // 2. 更新逻辑时钟
      pkt.ts = pkt.ts || (window.state.latestTs + 1);
      window.state.latestTs = Math.max(window.state.latestTs, pkt.ts);

      // 3. 更新联系人信息
      if (pkt.n && pkt.senderId) {
        window.state.contacts[pkt.senderId] = { 
           id: pkt.senderId, 
           n: pkt.n, 
           t: window.util.now() 
         };
        localStorage.setItem('p1_contacts', JSON.stringify(window.state.contacts));
      }

      // 4. 存储与UI更新
      const isPublic = pkt.target === CHAT.PUBLIC_ID;
      const isToMe = pkt.target === window.state.myId;
      const isFromMe = pkt.senderId === window.state.myId;

      if (isPublic || isToMe || isFromMe) {
        const chatKey = isPublic ? CHAT.PUBLIC_ID : (isFromMe ? pkt.target : pkt.senderId);
        
        // 只有当前不在该聊天窗口，或者消息不是我发的，才增加未读计数
        if (window.state.activeChat !== chatKey) {
           window.state.unread[chatKey] = (window.state.unread[chatKey] || 0) + 1;
           if (window.ui) window.ui.renderList();
        } else {
           if (window.ui) window.ui.appendMsg(pkt);
        }
        
        // 持久化
        window.db.saveMsg(pkt);
      }

      // 5. 泛洪转发 (仅限公共消息)
      if (isPublic) {
        this.flood(pkt, fromPeerId);
      }
    },

    flood(pkt, excludePeerId) {
      // 泛洪算法：向除来源外的所有邻居转发
      if (typeof pkt.ttl === 'number') {
        if (pkt.ttl <= 0) return; // TTL 耗尽，停止转发
        pkt = { ...pkt, ttl: pkt.ttl - 1 };
      }
      
      Object.values(window.state.conns).forEach(conn => {
        if (conn.open && conn.peer !== excludePeerId) {
          conn.send(pkt);
        }
      });
    },

    // 重试待发送消息队列
    async retryPending() {
      const list = await window.db.getPending();
      if (!list || list.length === 0) return;

      for (const pkt of list) {
        let sent = false;
        
        if (pkt.target === CHAT.PUBLIC_ID) {
          // 公共消息：直接泛洪
          this.flood(pkt, null);
          sent = true;
        } else {
          // 私聊消息：检查直连
          const conn = window.state.conns[pkt.target];
          
          // === 修复：互斥逻辑 ===
          if (conn && conn.open) {
            // 只要连着，直接发，不 BB
            conn.send(pkt);
            sent = true;
          } else {
            // 没连着，才去连
            // 此时 p2p.js 的 connectTo 也会有防抖，但这里也加上判断
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