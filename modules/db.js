export function init() {
  console.log('📦 加载模块: DB');
  window.db = {
    _db: null,
    async init() {
      return new Promise(r => {
        const req = indexedDB.open('P1_DB', 2);
        req.onupgradeneeded = e => {
          const d = e.target.result;
          if (!d.objectStoreNames.contains('msgs')) {
            d.createObjectStore('msgs', { keyPath: 'id' }).createIndex('ts', 'ts');
          }
          if (!d.objectStoreNames.contains('pending')) d.createObjectStore('pending', { keyPath: 'id' });
        };
        req.onsuccess = e => { this._db = e.target.result; r(); };
        req.onerror = () => r();
      });
    },

    async saveMsg(msg) {
      if (!this._db) return;
      const tx = this._db.transaction(['msgs'], 'readwrite');
      tx.objectStore('msgs').put(msg);
    },

    async getRecent(limit, target='all', beforeTs) {
      if (typeof beforeTs === 'undefined') beforeTs = window.util.now();
      if (!this._db) return [];
      
      return new Promise(resolve => {
        const tx  = this._db.transaction(['msgs'], 'readonly');
        const range = (beforeTs === Infinity) ? null : IDBKeyRange.upperBound(beforeTs, true);
        const req  = tx.objectStore('msgs').index('ts').openCursor(range, 'prev');
        const res  = [];
        
        req.onsuccess = e => {
          const cursor = e.target.result;
          if (cursor && res.length < limit) {
            const m = cursor.value;
            const isPublic  = target === 'all' && m.target === 'all';
            const isPrivate = target !== 'all' && m.target !== 'all' && (m.target === target || m.senderId === target);
            
            if (isPublic || isPrivate) res.push(m);
            cursor.continue();
          } else { 
            res.sort((a, b) => a.ts - b.ts); 
            resolve(res); 
          }
        };
      });
    },

    // 新增：专门查询文件元数据（不论频道，全量扫描最近的文件）
    // 解决重启后无法加载历史文件的问题
    async getRecentFiles(limit) {
      if (!this._db) return [];
      return new Promise(resolve => {
        const tx = this._db.transaction(['msgs'], 'readonly');
        const req = tx.objectStore('msgs').index('ts').openCursor(null, 'prev');
        const res = [];
        
        req.onsuccess = e => {
          const cursor = e.target.result;
          if (cursor && res.length < limit) {
             const m = cursor.value;
             // 只提取带 Meta 的文件消息
             if (m.kind === 'SMART_FILE_UI' && m.meta) {
                 res.push(m);
             }
             cursor.continue();
          } else {
             resolve(res);
          }
        };
        req.onerror = () => resolve([]);
      });
    },

    async getPublicAfter(ts, limit=50) {
      if (!this._db) return [];
      return new Promise(r => {
        const tx = this._db.transaction(['msgs'], 'readonly');
        // true 表示开区间，即 > ts
        const range = IDBKeyRange.lowerBound(ts, true);
        const req = tx.objectStore('msgs').index('ts').openCursor(range);
        const res = [];
        
        req.onsuccess = e => {
          const c = e.target.result;
          if (c && res.length < limit) {
            if (c.value.target === 'all') res.push(c.value);
            c.continue();
          } else r(res);
        };
      });
    },

    async addPending(msg) {
      if (!this._db) return;
      const tx = this._db.transaction(['pending'], 'readwrite');
      tx.objectStore('pending').put(msg);
    },

    async getPending() {
      if (!this._db) return [];
      return new Promise(r => {
        const tx  = this._db.transaction(['pending'], 'readonly');
        const req = tx.objectStore('pending').getAll();
        req.onsuccess = () => r(req.result);
      });
    },

    async removePending(id) {
      if (!this._db) return;
      const tx = this._db.transaction(['pending'], 'readwrite');
      tx.objectStore('pending').delete(id);
    }
  };
}