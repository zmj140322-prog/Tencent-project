/* =============================================================
 * 悦读 · 应用逻辑层
 * 三页：首页门户 / 藏书检索与借阅 / 阅览室选座与签到
 * 所有业务数据经 YueDuDB 读写（云端共享库 + 本地 IndexedDB 兜底）
 * ============================================================= */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };

  var S = {
    page: 'home', query: '', category: '全部门类', location: '全部馆区', status: '不限',
    sort: 'relevance', pageNo: 1, perPage: 10,
    forecastSlot: 'pm', room: '三层古籍阅览室',
    picked: ['C-04', 'C-05'], fav: ['D-03'],
    seeded: false
  };
  var ROOMS = ['一层开架阅览室', '三层古籍阅览室', '四层特藏室'];
  var ROWS = ['A', 'B', 'C', 'D', 'E'];
  var CATS = ['全部门类', '古籍善本', '文 学', '史 地', '艺 术'];
  var LOCS = ['全部馆区', '一层开架阅览室', '三层古籍阅览室', '四层特藏室'];
  var STATES = ['不限', '可借 (在架)', '已借出'];

  /* ---------------- 通用反馈 ---------------- */
  var toastTimer;
  function toast(msg) {
    var el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2800);
  }
  function modal(title, html, actions) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    if (actions && actions.length) {
      var bar = document.createElement('div');
      actions.forEach(function (a) {
        var b = document.createElement('button');
        b.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-outline');
        b.textContent = a.label;
        b.onclick = function () { if (a.onClick) a.onClick(); if (!a.keep) closeModal(); };
        bar.appendChild(b);
      });
      $('#modalBody').appendChild(bar);
    }
    $('#modal').classList.add('open'); $('#modal').setAttribute('aria-hidden', 'false');
  }
  function closeModal() { $('#modal').classList.remove('open'); $('#modal').setAttribute('aria-hidden', 'true'); }

  function fmtDue(d) { return String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0'); }
  function parseDue(s) { var p = s.split('.'); return new Date(new Date().getFullYear(), +p[0] - 1, +p[1]); }
  function daysLeft(s) { return Math.max(0, Math.ceil((parseDue(s) - new Date().setHours(0, 0, 0, 0)) / 86400000)); }
  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return fmtDue(d); }
  function uid(p) { return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }

  /* ---------------- 日期 ---------------- */
  function renderDates() {
    var d = new Date(), wk = '日一二三四五六'[d.getDay()];
    $('#todayLabel').textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + wk;
    $('#seatDate').textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日  周' + wk;
  }

  /* ---------------- 数据源状态 ---------------- */
  function renderStatus(snap) {
    var el = $('#dbStatus'), st = YueDuDB.state();
    var mode = snap ? snap.mode : st.mode;
    var db = YueDuDB.get();
    if (mode === 'cloud') { el.className = 'db-status cloud'; el.textContent = '云端共享事件库 · 已同步'; }
    else if (mode === 'local') { el.className = 'db-status local'; el.textContent = '本地 IndexedDB · 离线可用'; }
    else { el.className = 'db-status'; el.textContent = '本地 IndexedDB · 已就绪（同步中）'; }
    el.title = '书目 ' + (db.books || []).length + ' 种 · 在借 ' + (db.loans || []).length + ' 册 · 预约 ' + (db.reservations || []).length + ' 条 · 事件 ' + (snap && snap.events != null ? snap.events : st.events) + ' 条（点击查看架构说明）';
  }

  /* ---------------- 首页：榜单 / 公告 / 借阅 ---------------- */
  function renderRank() {
    var books = YueDuDB.get().books.slice().sort(function (a, b) { return b.hot - a.hot; }).slice(0, 3);
    $('#rankList').innerHTML = books.map(function (b, i) {
      return '<li><span class="rank-num">' + '一二三'[i] + '</span>' +
        '<div class="rank-body"><strong>《' + esc(b.title) + '》</strong>' +
        '<small>' + esc(b.author) + ' · ' + esc(b.publisher) + ' · ' + esc(b.callNo) + '</small></div>' +
        '<div class="rank-side">在架 ' + b.stock + ' 册' +
        '<button data-borrow="' + b.id + '">' + (b.stock > 0 ? '预约借阅' : '排队预约') + '</button></div></li>';
    }).join('');
  }
  function renderNotices() {
    var ns = YueDuDB.get().notices || [];
    $('#noticeList').innerHTML = ns.map(function (n) {
      return '<li><time>' + esc(n.date) + '</time><span>' + esc(n.text) + '</span></li>';
    }).join('');
  }
  function renderLoans() {
    var db = YueDuDB.get(), loans = (db.loans || []).slice().reverse();
    var picks = activePickups(db).slice().reverse();
    $('.panel-note', $('#loansPanel')).textContent = '在借 ' + loans.length + ' 册 · 待办理 ' + picks.length + ' 册 · 最多 6 册';
    var pickHtml = picks.map(function (p) {
      return '<li><span class="loan-spine red"></span>' +
        '<div class="loan-body"><strong>《' + esc(p.title) + '》</strong>' +
        '<small>预约借阅 · 待到馆办理 <b>' + esc(p.code) + '</b></small></div>' +
        '<div class="loan-actions"><button data-pickup="' + esc(p.id) + '">办理</button>' +
        '<button data-pickcancel="' + esc(p.id) + '">取消</button></div></li>';
    }).join('');
    var loanHtml = loans.map(function (l, i) {
      var left = daysLeft(l.due);
      return '<li><span class="loan-spine' + (i % 2 ? ' red' : '') + '"></span>' +
        '<div class="loan-body"><strong>《' + esc(l.title) + '》</strong>' +
        '<small>应还 ' + esc(l.due) + ' · 剩余 <b>' + left + '</b> 天</small></div>' +
        '<div class="loan-actions">' +
        (l.renewable ? '<button data-renew="' + esc(l.id) + '">续借</button>' : '') +
        '<button data-return="' + esc(l.id) + '">归还</button></div></li>';
    }).join('');
    $('#loanList').innerHTML = (pickHtml + loanHtml) || '<li class="empty-note">暂无在借与预约，去藏书检索约一本吧</li>';
  }
  function renderFeature() {
    var b = (YueDuDB.get().books || []).find(function (x) { return x.id === 'b1'; });
    if (b) $('#featureStock').textContent = b.stock;
  }

  /* ---------------- 空座预测 ---------------- */
  function renderForecast() {
    var db = YueDuDB.get(), arr = (db.forecast && db.forecast[S.forecastSlot]) || [];
    var max = Math.max.apply(null, arr);
    $('#forecastSegment').querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.dataset.slot === S.forecastSlot); });
    $('#forecastChart').innerHTML = arr.map(function (v) {
      return '<div class="fc-bar' + (v === max ? ' peak' : '') + '" data-v="' + v + '"></div>';
    }).join('');
    requestAnimationFrame(function () {
      $$('#forecastChart .fc-bar').forEach(function (el, i) { el.style.height = Math.round(arr[i] / 100 * 100) + '%'; });
    });
    InkFX.countTo($('#forecastSeats'), max);
    $('#heroOpenSeats').textContent = db.stats ? db.stats.openSeats : max;
  }

  /* ---------------- 检索页 ---------------- */
  function renderFilters() {
    var db = YueDuDB.get(), books = db.books || [];
    var catCounts = {};
    CATS.forEach(function (c) { catCounts[c] = c === '全部门类' ? books.length : books.filter(function (b) { return b.category === c; }).length; });
    $('#categoryFilter').innerHTML = CATS.map(function (c) {
      return '<li data-filter="category" data-value="' + c + '" class="' + (S.category === c ? 'active' : '') + '">' + c + '<span>' + catCounts[c] + '</span></li>';
    }).join('');
    $('#locationFilter').innerHTML = LOCS.map(function (c) {
      return '<li data-filter="location" data-value="' + c + '" class="' + (S.location === c ? 'active' : '') + '">' + c + '</li>';
    }).join('');
    $('#statusFilter').innerHTML = STATES.map(function (c) {
      return '<li data-filter="status" data-value="' + c + '" class="' + (S.status === c ? 'active' : '') + '">' + c + '</li>';
    }).join('');
  }

  function filteredBooks() {
    var q = S.query.trim().toLowerCase();
    var list = (YueDuDB.get().books || []).filter(function (b) {
      if (q && [b.title, b.author, b.callNo, b.publisher, b.category].join(' ').toLowerCase().indexOf(q) < 0) return false;
      if (S.category !== '全部门类' && b.category !== S.category) return false;
      if (S.location !== '全部馆区' && b.location !== S.location) return false;
      if (S.status === '可借 (在架)' && b.stock <= 0) return false;
      if (S.status === '已借出' && b.stock > 0) return false;
      return true;
    });
    if (S.sort === 'title') list.sort(function (a, b) { return a.title.localeCompare(b.title, 'zh'); });
    else if (S.sort === 'year') list.sort(function (a, b) { return b.year - a.year; });
    else list.sort(function (a, b) { return b.hot - a.hot; });
    return list;
  }

  function renderResults() {
    var all = filteredBooks(), total = all.length;
    var pages = Math.max(1, Math.ceil(total / S.perPage));
    if (S.pageNo > pages) S.pageNo = pages;
    var start = (S.pageNo - 1) * S.perPage;
    var list = all.slice(start, start + S.perPage);
    $('#resultCount').textContent = total;
    $('#resultList').innerHTML = list.length ? list.map(function (b, i) {
      var spine = b.spine || b.title;
      var half = Math.ceil(spine.length / 2);
      return '<article class="result-card" style="animation-delay:' + (i * 45) + 'ms">' +
        '<div class="book-spine" style="background:' + b.color + '">' + esc(spine.slice(0, half)) + '<br>' + esc(spine.slice(half)) + '</div>' +
        '<div class="rc-body"><h3>《' + esc(b.title) + '》</h3>' +
        '<p class="rc-meta">' + esc(b.author) + ' · ' + esc(b.publisher) + ' ' + b.year + ' · ' + esc(b.callNo) + '</p>' +
        '<p class="rc-meta">' + esc(b.location) + ' · ' + esc(b.shelf) +
        ' <em>·</em> <span class="' + (b.stock > 0 ? 'ok' : 'no') + '">' + (b.stock > 0 ? '可借' : '已借出') + '</span></p></div>' +
        '<button class="btn ' + (b.stock > 0 ? 'btn-primary' : 'btn-outline') + '" data-borrow="' + b.id + '">' + (b.stock > 0 ? '预约借阅' : '排队预约') + '</button>' +
        '</article>';
    }).join('') : '<div class="result-card" style="justify-content:center;color:#8A7E6E">未找到符合条件的馆藏，试试其他关键词或放宽筛选</div>';

    var nums = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    var pager = '<button data-page-no="' + (S.pageNo - 1) + '"' + (S.pageNo === 1 ? ' disabled' : '') + '>上一页</button>';
    for (var p = 1; p <= pages; p++) pager += '<button data-page-no="' + p + '" class="' + (p === S.pageNo ? 'active' : '') + '">' + (nums[p - 1] || p) + '</button>';
    pager += '<button data-page-no="' + (S.pageNo + 1) + '"' + (S.pageNo === pages ? ' disabled' : '') + '>下一页</button>' +
      '<span>共 ' + pages + ' 页 / ' + total + ' 条</span>';
    $('#pager').innerHTML = pager;
  }

  /* ---------------- 选座页 ---------------- */
  function renderRoomTabs() {
    $('#roomTabs').innerHTML = ROOMS.map(function (r) {
      return '<button role="tab" data-room="' + r + '" class="' + (S.room === r ? 'active' : '') + '">' + r + '</button>';
    }).join('');
  }
  function seatState(db, id) {
    var taken = (db.rooms[S.room] && db.rooms[S.room].taken) || [];
    if (taken.indexOf(id) >= 0) return 'taken';
    if (S.picked.indexOf(id) >= 0) return 'picked';
    if (S.fav.indexOf(id) >= 0) return 'fav';
    return 'free';
  }
  function renderSeats() {
    var db = YueDuDB.get(), html = '';
    ROWS.forEach(function (row) {
      html += '<span class="row-label">' + row + '</span>';
      for (var c = 1; c <= 10; c++) {
        if (c === 6) html += '<span class="aisle" aria-hidden="true"></span>';
        var id = row + '-' + String(c).padStart(2, '0');
        var st = seatState(db, id);
        html += '<button class="seat ' + st + '" data-seat="' + id + '" data-state="' + st + '" aria-label="' + id + ' ' + st + '"' + (st === 'taken' ? ' disabled' : '') + '>' + id + '</button>';
      }
    });
    $('#seatGrid').innerHTML = html;
    $('#infoRoom').textContent = S.room;
    $('#infoSeats').textContent = S.picked.length ? S.picked.slice().sort().join(' · ') : '未选择';
    $('#confirmResv').disabled = S.picked.length === 0;
    $('#resvTip').innerHTML = '14:00 – 16:00 为今日最宽裕时段<br>该时段' + S.room.replace('阅览室', '') + '余位预计 30 席以上';
    var last = (db.reservations || []).slice(-1)[0];
    if (last) $('#infoSlot').textContent = last.slot || '14:00 – 17:00';
  }

  function renderCheckin() {
    var db = YueDuDB.get();
    var active = (db.reservations || []).filter(function (r) { return !r.checkedIn; }).slice(-1)[0];
    var last = (db.reservations || []).slice(-1)[0];
    var code = active ? active.code : (last ? last.code : 'YUEDU-GUEST');
    InkFX.qr($('#qrBox'), code);
    if (active) {
      $('#checkinState').textContent = '今日未签到';
      $('#checkinState').className = 'tag tag-warn';
      $('#checkinTitle').textContent = active.room + ' · ' + active.seats.join(' / ');
      $('#checkinDesc').textContent = active.slot + ' · 请于预约时段前 15 分钟内扫码';
    } else if (last && last.checkedIn) {
      $('#checkinState').textContent = '今日已签到';
      $('#checkinState').className = 'tag';
      $('#checkinTitle').textContent = last.room + ' · ' + last.seats.join(' / ');
      $('#checkinDesc').textContent = '签到时间 ' + (last.checkinTime || '刚刚') + ' · 祝您阅读愉快';
    } else {
      $('#checkinTitle').textContent = '当前无生效预约';
      $('#checkinDesc').textContent = '预约席位后，此处生成签到码';
    }
  }

  /* ---------------- 全量渲染 ---------------- */
  var renderQueued = false;
  function renderAll() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      renderRank(); renderNotices(); renderLoans(); renderFeature();
      renderForecast(); renderFilters(); renderResults();
      renderRoomTabs(); renderSeats(); renderCheckin();
      renderStatus();
    });
  }

  /* ---------------- 业务操作：预约借阅 · 到馆办理 ---------------- */
  function activePickups(db) {
    return (db.pickups || []).filter(function (p) { return !p.fulfilled && !p.cancelled; });
  }
  function reservePickup(bookId, ev) {
    var db = YueDuDB.get(), b = (db.books || []).find(function (x) { return x.id === bookId; });
    if (!b) return;
    if ((db.loans || []).some(function (l) { return l.bookId === bookId; })) { toast('该书已在您的借阅中'); return; }
    if (activePickups(db).some(function (p) { return p.bookId === bookId; })) { toast('《' + b.title + '》已在预约队列中'); return; }
    var holding = (db.loans || []).length + activePickups(db).length;
    if (holding >= 6) { toast('在借与待办理合计已达 6 册上限，请先归还'); return; }
    var code = 'PU-' + Date.now().toString(36).toUpperCase().slice(-6);
    YueDuDB.commit({
      type: 'pickup',
      item: { id: uid('p'), bookId: bookId, title: b.title, code: code, createdAt: Date.now(), fulfilled: false, cancelled: false }
    }).then(function () {
      toast('《' + b.title + '》预约成功 · 凭取书码到馆办理');
      if (ev && InkFX) InkFX.burst(ev.clientX, ev.clientY, 22);
      renderAll();
    });
  }
  function showPickup(id) {
    var p = activePickups(YueDuDB.get()).find(function (x) { return x.id === id; });
    if (!p) return;
    modal('到馆办理 · 预约借阅',
      '<p>请向工作人员出示取书码，办理《<b>' + esc(p.title) + '</b>》的借出手续：</p>' +
      '<div style="text-align:center;font-size:22px;letter-spacing:2px;margin:10px 0"><b>' + esc(p.code) + '</b></div>' +
      '<div id="pickupQr" style="width:110px;height:110px;margin:0 auto 6px;border:1px solid #DED3BE;padding:6px;background:#fff"></div>' +
      '<div class="m-note">取书码保留 3 天，逾期预约自动取消；此二维码为演示码，正式部署时由馆内扫码终端读取。</div>',
      [{ label: '工作人员核销（演示）', primary: true, onClick: function () { fulfillPickup(id); } }, { label: '稍后办理' }]);
    InkFX.qr($('#pickupQr'), p.code);
  }
  function fulfillPickup(id) {
    var db = YueDuDB.get();
    var p = activePickups(db).find(function (x) { return x.id === id; });
    if (!p) return;
    if ((db.loans || []).some(function (l) { return l.bookId === p.bookId; })) { toast('该书已在您的借阅中'); return; }
    var b = (db.books || []).find(function (x) { return x.id === p.bookId; });
    if (!b || b.stock <= 0) { toast('该书当前无在架馆藏，可继续排队等待回架'); return; }
    var due = addDays(30);
    YueDuDB.commit({
      type: 'pickup-fulfill', pickupId: id, bookId: p.bookId,
      loan: { id: uid('l'), bookId: p.bookId, title: p.title, due: due, renewable: true, createdAt: Date.now() }
    }).then(function () {
      toast('《' + p.title + '》借出办理完成 · 应还 ' + due);
      InkFX.burst(innerWidth / 2, innerHeight / 2, 26);
      renderAll();
    });
  }
  function cancelPickup(id) {
    var p = activePickups(YueDuDB.get()).find(function (x) { return x.id === id; });
    if (!p) return;
    YueDuDB.commit({ type: 'pickup-cancel', pickupId: id })
      .then(function () { toast('《' + p.title + '》的预约已取消'); renderAll(); });
  }
  function addWish(bookId) {
    var db = YueDuDB.get(), b = (db.books || []).find(function (x) { return x.id === bookId; });
    if (!b) return;
    if ((db.wishlist || []).some(function (w) { return w.bookId === bookId && w.type === 'wish'; })) {
      toast('《' + b.title + '》已在书单中'); return;
    }
    YueDuDB.commit({ type: 'wish', item: { id: uid('w'), bookId: bookId, title: b.title, type: 'wish', createdAt: Date.now() } })
      .then(function () { toast('《' + b.title + '》已加入我的书单'); });
  }
  function renew(id) {
    var l = (YueDuDB.get().loans || []).find(function (x) { return x.id === id; });
    if (!l) return;
    var cur = parseDue(l.due); cur.setDate(cur.getDate() + 14);
    YueDuDB.commit({ type: 'renew', loanId: id, due: fmtDue(cur) })
      .then(function () { toast('续借成功 · 借期延长 14 天'); renderAll(); });
  }
  function returnBook(id) {
    YueDuDB.commit({ type: 'return', loanId: id })
      .then(function () { toast('归还成功，库存已更新'); renderAll(); });
  }
  function confirmResv(ev) {
    if (!S.picked.length) return;
    var seats = S.picked.slice().sort(), room = S.room;
    var code = 'YD-' + Date.now().toString(36).toUpperCase();
    YueDuDB.commit({
      type: 'resv',
      resv: {
        id: uid('r'), code: code, room: room, seats: seats, slot: '14:00 – 17:00',
        date: new Date().toISOString().slice(0, 10), createdAt: Date.now(), checkedIn: false
      }
    }).then(function () {
      S.picked = [];
      toast('预约成功 · ' + room + ' ' + seats.join(' / '));
      if (InkFX) InkFX.burst(ev.clientX || innerWidth / 2, ev.clientY || innerHeight / 2, 30);
      renderAll();
      modal('预约成功', '<p>已为您保留 <b>' + esc(room) + '</b> 的席位：<b>' + esc(seats.join(' / ')) + '</b></p>' +
        '<p>预约时段 14:00 – 17:00，可提前 30 分钟到馆。</p>' +
        '<div class="m-note">签到码 ' + code + '。到馆后请在首页「到馆签到」扫码，逾期 15 分钟席位将自动释放。</div>',
        [{ label: '知道了', primary: true }]);
    });
  }
  function checkIn() {
    var db = YueDuDB.get();
    var active = (db.reservations || []).filter(function (r) { return !r.checkedIn; }).slice(-1)[0];
    if (!active) {
      modal('到馆签到', '<p>当前没有待签到的预约。</p><p>请先到「阅览选座」预约席位，系统会在预约成功后生成签到码。</p>',
        [{ label: '去选座', primary: true, onClick: function () { location.hash = '#/seat'; } }, { label: '关闭' }]);
      InkFX.qr($('#qrBox'), 'YUEDU-GUEST');
      return;
    }
    var time = new Date().toTimeString().slice(0, 5);
    modal('扫码签到', '<p>请核对预约信息后确认签到：</p>' +
      '<ul class="m-list"><li><span>阅览区域</span><span>' + esc(active.room) + '</span></li>' +
      '<li><span>席位</span><span>' + esc(active.seats.join(' / ')) + '</span></li>' +
      '<li><span>时段</span><span>' + esc(active.slot) + '</span></li>' +
      '<li><span>签到码</span><span>' + esc(active.code) + '</span></li></ul>' +
      '<div id="modalQr" style="width:110px;height:110px;margin:0 auto 6px;border:1px solid #DED3BE;padding:6px;background:#fff"></div>' +
      '<div class="m-note">本页二维码为演示签到码；正式部署时可替换为馆内闸机/扫码终端的真实二维码。</div>',
      [{ label: '确认签到', primary: true, onClick: function () {
        YueDuDB.commit({ type: 'checkin', resvId: active.id, time: time })
          .then(function () { toast('签到成功 · ' + time + ' · 祝您阅读愉快'); InkFX.burst(innerWidth / 2, innerHeight / 2, 26); renderAll(); });
      } }, { label: '稍后再说' }]);
    InkFX.qr($('#modalQr'), active.code);
  }

  function showLoans() {
    var db = YueDuDB.get(), loans = db.loans || [];
    var picks = activePickups(db);
    var pickPart = picks.length
      ? '<p class="m-note" style="margin:0 0 6px">到馆预约 · 待办理（凭取书码到馆借出）</p><ul class="m-list">' +
        picks.map(function (p) {
          return '<li><span>《' + esc(p.title) + '》</span><span>取书码 ' + esc(p.code) + '</span></li>';
        }).join('') + '</ul>'
      : '';
    modal('我的借阅', pickPart + (loans.length
      ? '<ul class="m-list">' + loans.map(function (l) {
          return '<li><span>《' + esc(l.title) + '》</span><span>应还 ' + esc(l.due) + ' · 剩余 ' + daysLeft(l.due) + ' 天</span></li>';
        }).join('') + '</ul><div class="m-note">在借 ' + loans.length + ' 册 + 待办理 ' + picks.length + ' 册 · 合计最多 6 册 · 每册可续借一次（+14 天）。数据已写入共享数据库，其他访客可见库存变化。</div>'
      : '<p>暂无在借图书。</p>'), [{ label: '去检索', primary: true, onClick: function () { location.hash = '#/search'; } }, { label: '关闭' }]);
  }
  function showReservations() {
    var list = (YueDuDB.get().reservations || []).slice().reverse();
    modal('我的预约', list.length ? '<ul class="m-list">' + list.map(function (r) {
      return '<li><span>' + esc(r.room) + ' · ' + esc(r.seats.join(' / ')) + '</span><span>' + esc(r.slot) + ' · ' + (r.checkedIn ? '已签到' : '待签到') + '</span></li>';
    }).join('') + '</ul>' : '<p>暂无预约记录。</p>', [{ label: '关闭', primary: true }]);
  }
  function showNotices() {
    var ns = YueDuDB.get().notices || [];
    modal('馆讯 · 公告', '<ul class="m-list">' + ns.map(function (n) {
      return '<li><span>' + esc(n.date) + '</span><span style="text-align:right">' + esc(n.text) + '</span></li>';
    }).join('') + '</ul>', [{ label: '关闭', primary: true }]);
  }
  function showHelp(kind) {
    var map = {
      help: ['检索与借阅指南', '<p><b>检索</b>：可按书名、作者、出版社、索书号或门类关键词检索；左侧筛选可叠加馆藏地与借阅状态。</p><p><b>借阅</b>：采用「预约借阅 · 到馆办理」——线上预约生成取书码，凭码到馆由工作人员核销借出；在借与待办理合计最多 6 册，借期 30 天，可续借一次（+14 天）。库存为零的书目可排队预约，回架后优先办理。</p><p><b>数据</b>：预约、核销、归还、续借、选座与签到均写入云端共享数据库，并同步至本地 IndexedDB。</p>'],
      advanced: ['高级检索', '<p>组合条件：书名 / 作者 / 索书号 / 门类 / 馆藏地 / 借阅状态。</p><p>试试在检索框输入「明」「园」「I264」等关键词，或在左侧选择「古籍善本」+「四层特藏室」。</p>'],
      db: ['数据库说明', '<p>本站点采用 <b>云端共享事件日志 + 本地 IndexedDB 物化视图</b> 架构。</p><p><b>读</b>：拉取共享事件流 → 按事件 ID 去重、按服务段时间排序 → 在基线馆藏目录上重放，得到最新的库存、在借、预约与签到状态。</p><p><b>写</b>：借阅 / 归还 / 续借 / 预约 / 签到都作为一条不可变事件追加到云端，多位访客并发写入互不覆盖；离线时事件进入待发队列，恢复连接后自动补发。</p><div class="m-note">当前模式：' + (YueDuDB.state().mode === 'cloud' ? '云端共享（多访客数据互通）' : '本地离线') + ' · 已重放 ' + YueDuDB.state().events + ' 条事件 · 待发 ' + YueDuDB.state().pending + ' 条<br>云端公共通道缓存近期事件，本地 IndexedDB 长期保存完整状态；生产环境可替换为腾讯云开发 CloudBase 等正式数据库。</div>']
    };
    var m = map[kind] || map.help;
    modal(m[0], m[1], [{ label: '知道了', primary: true }]);
  }

  /* ---------------- 路由 ---------------- */
  function switchPage(page, initial) {
    if (['home', 'search', 'seat'].indexOf(page) < 0) page = 'home';
    if (!initial) InkFX.transition();
    S.page = page;
    $$('.page').forEach(function (p) { p.classList.toggle('is-active', p.dataset.page === page); });
    $$('.main-nav a[data-route]').forEach(function (a) { a.classList.toggle('active', a.dataset.route === page); });
    $('#navToggle').setAttribute('aria-expanded', 'false');
    $('#mainNav').classList.remove('open');
    if (!initial) window.scrollTo({ top: 0, behavior: 'auto' });
    $$('#page-' + page + ' .panel, #page-' + page + ' .result-card, #page-' + page + ' .side-card, #page-' + page + ' .seat-map-card').forEach(function (el) { el.classList.add('reveal'); });
    InkFX.reveal(document.getElementById('page-' + page));
    if (page === 'home') renderForecast();
    if (page === 'search') renderResults();
    if (page === 'seat') renderSeats();
  }
  function route() {
    var page = (location.hash || '').replace(/^#\/?/, '').split('?')[0] || 'home';
    switchPage(page, !S.seeded);
    S.seeded = true;
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    window.addEventListener('hashchange', route);

    $('#navToggle').addEventListener('click', function () {
      var open = $('#mainNav').classList.toggle('open');
      this.setAttribute('aria-expanded', String(open));
    });

    $('#heroSearchForm').addEventListener('submit', function (e) {
      e.preventDefault(); S.query = $('#heroSearchInput').value.trim(); S.pageNo = 1;
      $('#searchInput').value = S.query; location.hash = '#/search'; renderResults();
    });
    $('#searchForm').addEventListener('submit', function (e) {
      e.preventDefault(); S.query = $('#searchInput').value.trim();
      S.category = $('#categorySelect').value; S.pageNo = 1; renderFilters(); renderResults();
      toast(S.query ? '检索「' + S.query + '」' : '已列出当前目录全部书目');
    });
    $('#categorySelect').addEventListener('change', function () {
      S.category = this.value; S.pageNo = 1; renderFilters(); renderResults();
    });
    $('#sortSelect').addEventListener('change', function () { S.sort = this.value; renderResults(); });

    document.addEventListener('click', function (e) {
      var t = e.target;
      var hot = t.closest('[data-hot]');
      if (hot) { S.query = hot.dataset.hot; S.pageNo = 1; $('#searchInput').value = S.query; renderResults(); toast('热门检索：' + S.query); return; }

      var fil = t.closest('[data-filter]');
      if (fil) {
        S[fil.dataset.filter] = fil.dataset.value; S.pageNo = 1;
        renderFilters(); renderResults(); return;
      }
      var pg = t.closest('[data-page-no]');
      if (pg && !pg.disabled) { S.pageNo = +pg.dataset.pageNo; renderResults(); window.scrollTo({ top: 180, behavior: 'smooth' }); return; }

      var slot = t.closest('#forecastSegment button');
      if (slot) { S.forecastSlot = slot.dataset.slot; renderForecast(); return; }

      var room = t.closest('[data-room]');
      if (room) { S.room = room.dataset.room; S.picked = []; renderRoomTabs(); renderSeats(); return; }

      var seat = t.closest('[data-seat]');
      if (seat && seat.dataset.state !== 'taken') {
        var id = seat.dataset.seat, i = S.picked.indexOf(id);
        if (i >= 0) S.picked.splice(i, 1);
        else if (S.picked.length >= 2) { toast('单次最多预约 2 个连座席位'); return; }
        else S.picked.push(id);
        renderSeats(); InkFX.burst(e.clientX, e.clientY, 9); return;
      }

      if (t.closest('[data-borrow]')) { reservePickup(t.closest('[data-borrow]').dataset.borrow, e); return; }
      if (t.closest('[data-wishlist]')) { addWish(t.closest('[data-wishlist]').dataset.wishlist); return; }
      if (t.closest('[data-renew]')) { renew(t.closest('[data-renew]').dataset.renew); return; }
      if (t.closest('[data-return]')) { returnBook(t.closest('[data-return]').dataset.return); return; }
      if (t.closest('[data-pickup]')) { showPickup(t.closest('[data-pickup]').dataset.pickup); return; }
      if (t.closest('[data-pickcancel]')) { cancelPickup(t.closest('[data-pickcancel]').dataset.pickcancel); return; }

      var act = t.closest('[data-action]');
      if (act) {
        var a = act.dataset.action;
        if (act.tagName === 'A' || act.tagName === 'BUTTON') {
          if (['myloans', 'notices', 'checkin', 'help', 'advanced', 'myresv'].indexOf(a) >= 0) {
            e.preventDefault();
            if (a === 'myloans') showLoans();
            else if (a === 'notices') showNotices();
            else if (a === 'checkin') checkIn();
            else if (a === 'myresv') showReservations();
            else showHelp(a);
            return;
          }
        }
      }
      if (t.closest('[data-close]')) { closeModal(); return; }
      if (t.closest('#dbStatus')) { showHelp('db'); return; }
    });

    $('#confirmResv').addEventListener('click', confirmResv);
    $('#modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    YueDuDB.subscribe(renderAll);
  }

  /* ---------------- 启动 ----------------
     本地优先：先用种子/IndexedDB 数据把整站渲染出来，云端同步在后台进行，
     即使共享库不可达，页面与全部交互依然完整可用。                    */
  document.documentElement.classList.add('anim');
  renderDates();
  bind();
  renderAll();
  route();
  YueDuDB.init().then(function () {
    renderAll();
    // 首页首次进入时给粒子一点轻微扰动，暗示可交互
    setTimeout(function () { if (InkFX) InkFX.burst(innerWidth * .28, innerHeight * .45, 6); }, 900);
  });
  setTimeout(function () { if (YueDuDB.state().mode === 'connecting') renderStatus(); }, 5200);
})();
