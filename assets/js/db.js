/* =============================================================
 * 悦读 · 数据库层 (YueDuDB) —— 事件溯源 + 本地物化视图
 * -------------------------------------------------------------
 * 云端共享库：append-only 事件日志（支持 CORS 的公共消息通道）
 *   GET <TOPIC>/json?poll=1&since=all   拉取共享事件流
 *   PUT <TOPIC>                         追加一条业务事件
 * 本地数据库：IndexedDB（objectStore: kv），失败自动回退 localStorage
 *
 * 读：拉取事件 → 按事件 ID 去重 → 按服务段时间排序 → 在物化状态上重放
 * 写：先同步他人事件 → 本地乐观应用 → 追加发布到云端（失败入待发队列）
 * 优点：多访客并发写入互不覆盖（不是整库覆盖），离线可用、恢复后自动补发
 * ============================================================= */
(function (global) {
  'use strict';

  var TOPIC = 'https://ntfy.sh/yuedu-read-2026-p7q3v8';
  var IDB_NAME = 'yuedu-library';
  var IDB_STORE = 'kv';
  var LS_KEY = 'yuedu-db-v2';
  var SYNC_MS = 20000;

  var listeners = [];
  var cache = null;             // 物化后的完整库（前端直接读它）
  var seen = [];                // 已重放的事件 ID
  var seenMap = Object.create(null);
  var pending = [];             // 离线待发事件
  var mode = 'connecting';
  var lastSync = 0;
  var eventCount = 0;
  var queue = Promise.resolve();          // 本地写入串行队列
  var publishQueue = Promise.resolve();   // 云端发布串行队列（与界面反馈解耦）

  /* ---------------- 基线数据（静态馆藏目录） ---------------- */
  function seed() {
    var rooms = {
      '一层开架阅览室': { taken: ['A-02', 'A-06', 'B-03', 'B-08', 'C-01', 'C-09', 'D-05', 'D-06', 'E-02', 'E-07', 'E-08'] },
      '三层古籍阅览室': { taken: ['A-02', 'A-07', 'B-01', 'B-04', 'B-10', 'C-02', 'C-06', 'C-08', 'D-01', 'D-04', 'D-08', 'E-05', 'E-09'] },
      '四层特藏室': { taken: ['A-04', 'B-02', 'B-07', 'C-03', 'C-10', 'D-02', 'E-01', 'E-06'] }
    };
    return {
      version: 1, revision: 1, updatedAt: 0, name: 'yuedu-library-db',
      books: [
        { id: 'b1', title: '陶庵梦忆', author: '[明] 张岱 著', publisher: '中华书局', year: 2021, callNo: 'I264.9/12', category: '古籍善本', location: '三层古籍阅览室', shelf: '在架 3 册', stock: 3, total: 5, state: '可借', spine: '陶庵梦忆', color: '#3F5B4C', hot: 98 },
        { id: 'b2', title: '东京梦华录', author: '[宋] 孟元老 著', publisher: '中华书局', year: 2019, callNo: 'K296.1/08', category: '史 地', location: '三层古籍阅览室', shelf: '在架 1 册', stock: 1, total: 2, state: '可借', spine: '东京梦华录', color: '#9E3B32', hot: 92 },
        { id: 'b3', title: '园冶', author: '[明] 计成 著', publisher: '建筑工业出版社', year: 2018, callNo: 'TU986/24', category: '艺 术', location: '一层开架阅览室', shelf: '在架 0 册', stock: 0, total: 2, state: '已借出', spine: '园冶', color: '#8B6A3E', hot: 87 },
        { id: 'b4', title: '校雠通义', author: '[清] 章学诚 著', publisher: '古籍出版社', year: 1957, callNo: 'G257.1/8', category: '古籍善本', location: '三层古籍阅览室', shelf: '在架 2 册', stock: 2, total: 3, state: '可借', spine: '校雠通义', color: '#3F5B4C', hot: 74 },
        { id: 'b5', title: '万历十五年', author: '黄仁宇 著', publisher: '中华书局', year: 2006, callNo: 'K248.3/15', category: '史 地', location: '一层开架阅览室', shelf: '在架 4 册', stock: 4, total: 6, state: '可借', spine: '万历十五年', color: '#9E3B32', hot: 96 },
        { id: 'b6', title: '长物志', author: '[明] 文震亨 著', publisher: '浙江人民美术出版社', year: 2016, callNo: 'TU986/31', category: '艺 术', location: '一层开架阅览室', shelf: '在架 2 册', stock: 2, total: 2, state: '可借', spine: '长物志', color: '#8B6A3E', hot: 70 },
        { id: 'b7', title: '闲情偶寄', author: '[清] 李渔 著', publisher: '中华书局', year: 2014, callNo: 'I264.9/33', category: '文 学', location: '一层开架阅览室', shelf: '在架 5 册', stock: 5, total: 5, state: '可借', spine: '闲情偶寄', color: '#6B5B8A', hot: 68 },
        { id: 'b8', title: '洛阳伽蓝记', author: '[北魏] 杨衒之 著', publisher: '中华书局', year: 2012, callNo: 'K928.6/4', category: '史 地', location: '四层特藏室', shelf: '在架 1 册', stock: 1, total: 1, state: '可借', spine: '洛阳伽蓝记', color: '#3F5B4C', hot: 61 },
        { id: 'b9', title: '书目答问', author: '[清] 张之洞 著', publisher: '上海古籍出版社', year: 2011, callNo: 'Z835/2', category: '古籍善本', location: '四层特藏室', shelf: '在架 2 册', stock: 2, total: 2, state: '可借', spine: '书目答问', color: '#8B6A3E', hot: 55 },
        { id: 'b10', title: '中国古典园林分析', author: '彭一刚 著', publisher: '中国建筑工业出版社', year: 1986, callNo: 'TU986/09', category: '艺 术', location: '一层开架阅览室', shelf: '在架 3 册', stock: 3, total: 4, state: '可借', spine: '古典园林分析', color: '#6B5B8A', hot: 64 },
        { id: 'b11', title: '藏书纪事诗', author: '[清] 叶昌炽 著', publisher: '上海古籍出版社', year: 1999, callNo: 'G259.2/7', category: '古籍善本', location: '四层特藏室', shelf: '在架 1 册', stock: 1, total: 2, state: '可借', spine: '藏书纪事诗', color: '#3F5B4C', hot: 49 },
        { id: 'b12', title: '浮生六记', author: '[清] 沈复 著', publisher: '人民文学出版社', year: 2010, callNo: 'I264.9/51', category: '文 学', location: '一层开架阅览室', shelf: '在架 2 册', stock: 2, total: 4, state: '可借', spine: '浮生六记', color: '#9E3B32', hot: 83 }
      ],
      loans: [
        { id: 'l-seed-1', bookId: 'b1', title: '陶庵梦忆', due: '11.22', renewable: true, code: 'RT-7E2K9A', createdAt: 0 },
        { id: 'l-seed-2', bookId: 'b5', title: '万历十五年', due: '11.15', renewable: true, code: 'RT-3B8M4C', createdAt: 0 }
      ],
      reviews: [
        { id: 'rv-seed-1', bookId: 'b1', user: '墨痕', rating: 5, content: '张岱的文字里有晚明的月光，繁华落尽后追忆，字字皆是深情。', time: 1762483200000 },
        { id: 'rv-seed-2', bookId: 'b5', user: '青简', rating: 4, content: '大历史观下的万历十五年，几个人物的切片竟能照见整个王朝的困局。', time: 1762569600000 },
        { id: 'rv-seed-3', bookId: 'b12', user: '南山', rating: 5, content: '浮生若梦，为欢几何。沈复与芸娘的日常，是中国文学里最动人的烟火气。', time: 1762656000000 }
      ],
      reservations: [],
      pickups: [],
      wishlist: [],
      rooms: rooms,
      notices: [
        { date: '11.08', text: '二层古籍阅览室本周起延长开放至 21:30' },
        { date: '11.05', text: '「藏书面面观」专题图书展，展于三层回廊' },
        { date: '10.28', text: '2026 年度读者荐购通道已开启' }
      ],
      forecast: {
        am: [42, 58, 74, 66, 51, 38, 29],
        pm: [52, 61, 78, 87, 72, 55, 41],
        night: [71, 66, 59, 48, 39, 33, 26]
      },
      stats: { totalBooks: 128460, visitors: 1286, openSeats: 87 }
    };
  }

  /* ---------------- 事件重放（幂等） ---------------- */
  function applyEvent(db, ev) {
    if (!ev || !ev.type) return;
    var i, bk, l, r, p;
    switch (ev.type) {
      case 'borrow':
        if ((db.loans || []).some(function (x) { return x.id === ev.loan.id; })) break;
        bk = db.books.find(function (x) { return x.id === ev.bookId; });
        if (bk && bk.stock > 0) {
          bk.stock -= 1; bk.shelf = '在架 ' + bk.stock + ' 册'; bk.state = bk.stock > 0 ? '可借' : '已借出';
        }
        db.loans.push(ev.loan);
        break;
      case 'return':
      case 'cancel-loan':   /* 取消借阅：效果同归还（库存回架），事件类型区分用途 */
        i = db.loans.findIndex(function (x) { return x.id === ev.loanId; });
        if (i >= 0) {
          l = db.loans[i]; db.loans.splice(i, 1);
          bk = db.books.find(function (x) { return x.id === l.bookId; });
          if (bk) { bk.stock = Math.min(bk.total, bk.stock + 1); bk.shelf = '在架 ' + bk.stock + ' 册'; bk.state = bk.stock > 0 ? '可借' : '已借出'; }
        }
        break;
      case 'renew':
        l = db.loans.find(function (x) { return x.id === ev.loanId; });
        if (l) { l.due = ev.due; l.renewable = false; }
        break;
      case 'wish':
        db.wishlist = db.wishlist || [];
        if (!db.wishlist.some(function (w) { return w.id === ev.item.id; })) db.wishlist.push(ev.item);
        break;
      case 'resv':
        db.reservations = db.reservations || [];
        if (db.reservations.some(function (x) { return x.id === ev.resv.id; })) break;
        r = ev.resv;
        db.rooms[r.room] = db.rooms[r.room] || { taken: [] };
        db.rooms[r.room].taken = Array.from(new Set(db.rooms[r.room].taken.concat(r.seats)));
        db.reservations.push(r);
        if (db.stats) db.stats.openSeats = Math.max(0, db.stats.openSeats - r.seats.length);
        break;
      case 'checkin':
        r = (db.reservations || []).find(function (x) { return x.id === ev.resvId; });
        if (r) { r.checkedIn = true; r.checkinTime = ev.time; }
        break;
      case 'review': {
        /* 书评评分：同一读者对同一本书仅保留最新一条（再次提交视为修改） */
        db.reviews = db.reviews || [];
        var it = ev.item;
        if (!it || !it.bookId || !(it.rating >= 1 && it.rating <= 5)) break;
        db.reviews = db.reviews.filter(function (x) {
          return !(x.bookId === it.bookId && x.user === it.user && x.id !== it.id);
        });
        if (!db.reviews.some(function (x) { return x.id === it.id; })) db.reviews.push(it);
        break;
      }
      case 'review-del':
        db.reviews = (db.reviews || []).filter(function (x) { return x.id !== ev.reviewId; });
        break;
      case 'pickup':
        /* 预约借阅：线上预约，不占库存，到馆核销后才真正借出 */
        db.pickups = db.pickups || [];
        if (!db.pickups.some(function (x) { return x.id === ev.item.id; })) db.pickups.push(ev.item);
        break;
      case 'pickup-cancel':
        p = (db.pickups || []).find(function (x) { return x.id === ev.pickupId; });
        if (p) p.cancelled = true;
        break;
      case 'pickup-fulfill':
        /* 到馆办理：工作人员核销取书码 → 扣库存 → 生成在借记录 */
        p = (db.pickups || []).find(function (x) { return x.id === ev.pickupId; });
        if (p && !p.fulfilled) {
          p.fulfilled = true; p.fulfilledAt = ev.ts || Date.now();
          bk = db.books.find(function (x) { return x.id === (ev.bookId || p.bookId); });
          if (bk && bk.stock > 0) {
            bk.stock -= 1; bk.shelf = '在架 ' + bk.stock + ' 册'; bk.state = bk.stock > 0 ? '可借' : '已借出';
          }
          if (ev.loan && !(db.loans || []).some(function (x) { return x.id === ev.loan.id; })) {
            db.loans = db.loans || [];
            db.loans.push(ev.loan);
          }
        }
        break;
      default: break; // init / 未知类型：忽略但记入已读
    }
    db.revision = (db.revision || 1) + 1;
    db.updatedAt = Math.max(db.updatedAt || 0, ev.ts || 0);
  }

  /* ---------------- IndexedDB 本地库 ---------------- */
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('no indexedDB'));
      var req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        r.onsuccess = function () { resolve(r.result); db.close(); };
        r.onerror = function () { reject(r.error); db.close(); };
      });
    });
  }
  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { resolve(true); db.close(); };
        tx.onerror = function () { reject(tx.error); db.close(); };
      });
    });
  }
  function localGet() {
    return idbGet('state').catch(function () {
      try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; }
    });
  }
  function localSet() {
    var snapshot = { v: 2, db: cache, seen: seen, pending: pending };
    try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch (e) { /* 隐私模式 */ }
    return idbSet('state', snapshot).catch(function () { return false; });
  }

  /* ---------------- 云端事件日志 ---------------- */
  function withTimeout(ms) {
    if (typeof AbortController === 'undefined') return {};
    var c = new AbortController();
    var timer = setTimeout(function () { c.abort(); }, ms);
    return { signal: c.signal, done: function () { clearTimeout(timer); } };
  }
  function pullEvents(ms) {
    var ctl = withTimeout(ms || 6000);
    return fetch(TOPIC + '/json?poll=1&since=all', { cache: 'no-store', signal: ctl.signal })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (text) {
        var out = [];
        text.split('\n').forEach(function (line) {
          if (!line.trim()) return;
          try {
            var envelope = JSON.parse(line);
            if (envelope.event !== 'message' || !envelope.message) return;
            var ev = JSON.parse(envelope.message);
            if (ev && ev.id) out.push({ ev: ev, time: (envelope.time || 0) * 1000 });
          } catch (e) { /* 忽略非本站消息 */ }
        });
        return out;
      })
      .finally(function () { if (ctl.done) ctl.done(); });
  }
  function publish(ev) {
    var ctl = withTimeout(6500);
    return fetch(TOPIC, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify(ev),
      signal: ctl.signal
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return true; })
      .finally(function () { if (ctl.done) ctl.done(); });
  }
  function ingest(records) {
    var fresh = records.filter(function (x) { return !seenMap[x.ev.id]; });
    fresh.sort(function (a, b) { return (a.time || a.ev.ts || 0) - (b.time || b.ev.ts || 0); });
    fresh.forEach(function (x) {
      seenMap[x.ev.id] = 1; seen.push(x.ev.id);
      applyEvent(cache, x.ev);
    });
    if (seen.length > 600) {
      seen = seen.slice(-600);
      seenMap = Object.create(null);
      seen.forEach(function (id) { seenMap[id] = 1; });
    }
    eventCount += fresh.length;
    return fresh.length;
  }
  function flushPending() {
    if (!pending.length) return Promise.resolve(true);
    var item = pending[0];
    return publish(item).then(function () {
      pending.shift();
      return flushPending();
    }).catch(function () { return false; });
  }

  function schedulePublish() {
    publishQueue = publishQueue.then(function () {
      if (!pending.length) return;
      return flushPending().then(function (ok) {
        mode = ok ? 'cloud' : 'local';
        if (ok) lastSync = Date.now();
        return localSet();
      }).then(emit).catch(function () { mode = 'local'; emit(); });
    });
    return publishQueue;
  }

  function emit() {
    var snap = { mode: mode, lastSync: lastSync, db: cache, events: eventCount };
    listeners.forEach(function (fn) { try { fn(snap); } catch (e) { /* noop */ } });
  }

  /* ---------------- 对外 API ---------------- */
  var api = {
    state: function () { return { mode: mode, lastSync: lastSync, events: eventCount, pending: pending.length }; },
    get: function () { return cache || seed(); },
    subscribe: function (fn) {
      listeners.push(fn);
      if (cache) fn({ mode: mode, lastSync: lastSync, db: cache, events: eventCount });
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },

    init: function () {
      return localGet().then(function (snapshot) {
        if (snapshot && snapshot.v === 2 && snapshot.db && snapshot.db.version) {
          cache = snapshot.db;
          cache.pickups = cache.pickups || [];   // 旧快照迁移：补预约集合
          cache.reviews = cache.reviews || [];   // 旧快照迁移：补书评集合
          seen = snapshot.seen || [];
          pending = snapshot.pending || [];
          seen.forEach(function (id) { seenMap[id] = 1; });
        } else { cache = seed(); }
        return pullEvents();
      }).then(function (records) {
        ingest(records);
        mode = 'cloud'; lastSync = Date.now();
        return flushPending();
      }).then(function (ok) {
        if (!ok) mode = 'local';
        return localSet();
      }).catch(function () {
        mode = 'local';
        if (!cache) cache = seed();
      }).then(function () {
        emit();
        setInterval(api.refresh, SYNC_MS);
        return api.get();
      });
    },

    refresh: function () {
      return pullEvents().then(function (records) {
        var n = ingest(records);
        mode = 'cloud'; lastSync = Date.now();
        schedulePublish();               // 顺带补发离线事件，不阻塞拉取结果
        return n;
      }).then(function (n) {
        if (n) localSet();
        emit();
      }).catch(function () {
        if (mode !== 'local') { mode = 'local'; emit(); }
      });
    },

    /* 追加一条业务事件：本地乐观应用（即时返回）→ 后台追加发布到云端
       界面反馈不依赖网络；他人事件由定时 refresh 幂等重放合并。      */
    commit: function (event) {
      event.id = 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      event.ts = Date.now();
      var done;
      var localAck = new Promise(function (res) { done = res; });
      queue = queue.then(function () {
        seenMap[event.id] = 1; seen.push(event.id);
        applyEvent(cache, event);
        eventCount++;
        emit();                          // 乐观更新，界面即时响应
        done(true);                      // 调用方立即收到确认
        pending.push(event);
        return localSet();
      }).then(function () {
        schedulePublish();               // 后台补发，不进入本地写入队列
      }).catch(function () {
        mode = 'local'; emit(); done(true);
      });
      return localAck;
    }
  };

  global.YueDuDB = api;
  global.YueDuDB.seed = seed;   // 便于部署脚本导出基线数据
})(window);
