/**
 * 全局常量与配置定义
 * 目的：将所有硬编码的变量集中管理，方便后续修改
 */

export const APP_VERSION = '1.0.31-Ultra-350'; // m1改版

// 1. 网络消息协议类型
export const MSG_TYPE = {
  PING: 'PING',         
  PONG: 'PONG',         
  HELLO: 'HELLO',       
  PEER_EX: 'PEER_EX',   
  ASK_PUB: 'ASK_PUB',   
  REP_PUB: 'REP_PUB',   
  MSG: 'MSG',           
  HUB_PULSE: 'HUB_PULSE' 
};

// 2. 网络参数配置
export const NET_PARAMS = {
  GOSSIP_SIZE: 20,          
  MAX_PEERS_NORMAL: 350,    // 扩容至350
  MAX_PEERS_HUB: 500,       // 网关扩容至500
  CONN_TIMEOUT: 5000,       // 5秒连不上就杀
  PING_TIMEOUT: 8000,       // 8秒没心跳就杀
  LOOP_INTERVAL: 1000,      // 保持1秒轮询
  RETRY_DELAY: 3000,        
  HUB_PREFIX: 'p1-hub-v3-', 
  HUB_COUNT: 5              
};

// 3. 聊天相关
export const CHAT = {
  PUBLIC_ID: 'all',         
  PUBLIC_NAME: '公共频道',   
  KIND_TEXT: 'text',        
  KIND_IMAGE: 'image',      
  KIND_FILE: 'file',        
  TTL_DEFAULT: 16           
};

// 4. UI 配置
export const UI_CONFIG = {
  COLOR_ONLINE: '#22c55e',     
  COLOR_OFFLINE: '#666666',    
  COLOR_GROUP: '#2a7cff',      
  MSG_LOAD_BATCH: 20,          
  LONG_PRESS_DURATION: 500,    
  MAX_IMG_WIDTH: 800,          
  IMG_QUALITY: 0.7             
};

// 5. 本地存储键名
export const STORAGE_KEYS = {
  MY_ID: 'p1_my_id',
  NICKNAME: 'nickname',
  CONTACTS: 'p1_contacts',
  UNREAD: 'p1_unread'
};