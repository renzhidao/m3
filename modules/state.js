export function init() {
  console.log(' 加载模块: State');
  
  window.state = {
    myId:  localStorage.getItem('p1_my_id') || ('u_' + Math.random().toString(36).substr(2, 9)),
    myName: localStorage.getItem('nickname') || ('用户' + Math.floor(Math.random() * 1000)),
    peer: null, hubPeer: null, isHub: false, hubIndex: -1,
    conns: {}, contacts: JSON.parse(localStorage.getItem('p1_contacts') || '{}'),
    mqttClient: null, mqttStatus: '初始化', hubHeartbeats: {}, 
    activeChat: 'all', activeChatName: '公共频道',
    unread: JSON.parse(localStorage.getItem('p1_unread') || '{}'),
    seenMsgs: new Set(),
    latestTs: 0, oldestTs: Infinity, loading: false, timeOffset: 0,
    lastMsgTime: 0, msgCount: 0,
    mqttFailCount: 0
  };
}