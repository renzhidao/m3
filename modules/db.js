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
          } else { res.sort((a, b) => a.ts - b.ts); resolve(res); }
        };
      });
    },
    // 新增：查询指定时间之后的公共消息（用于同步）
    async getPublicAfter(ts, limit=50) {
      if (!this._db) return [];
      return new Promise(r => {
        const tx = this._db.transaction(['msgs'], 'readonly');
        // true 表示开区间，即 > ts (不包含 ts 本身)
        const range = IDBKeyRange.lowerBound(ts, true);
        const req = tx.objectStore('msgs').index('ts').openCursor(range); // 默认顺序是升序
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
        const req = tx.objectStore('pending').getAll(null, 5);
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