/**
 * 全局常量与配置定义
 * 目的：将所有硬编码的变量集中管理，方便后续修改
 */

export const APP_VERSION = '1.0.32-FullOverwrite';
window.APP_VERSION = APP_VERSION; // 当前版本号

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
  MAX_PEERS_NORMAL: 350,     
  MAX_PEERS_HUB: 500,        
  CONN_TIMEOUT: 3000,       
  PING_TIMEOUT: 6000,       
  LOOP_INTERVAL: 1000,      
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
  MAX_IMG_WIDTH: 9999,          
  IMG_QUALITY: 1.0             
};

// 5. 本地存储键名
export const STORAGE_KEYS = {
  MY_ID: 'p1_my_id',
  NICKNAME: 'nickname',
  CONTACTS: 'p1_contacts',
  UNREAD: 'p1_unread'
};