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
    seeded: false,
    user: null,
    scan: { mode: 'borrow', stream: null, busy: false, matched: null, status: '', raw: '', error: null, pendingReturn: null }
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

  /* ================= 用户认证（云服务 · 与云图书馆同源） =================
   * WorkBuddy 云服务 Auth：手机号 + 短信验证码登录（新号自动注册）、微信扫码登录，
   * 会话由云端管理、自动随请求携带；管理员身份存于云数据库 yuedu_staff，
   * 登录后通过「管理员认证」输入口令开通（口令校验在云端安全函数内完成）。
   * 读者：预约借阅 · 我的借阅 · 书评评分 · 选座签到；
   * 管理员：以上全部 + 「我的借阅」扫码借还工作台与预约核销。   */
  var cloud = window.WorkBuddyCloud ? window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: 'https://yuedu-library.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_uhGNjNnaJayLlBMt0hET0E_LGyeTXb97yIFGdKfj6c4rqaf068pBBOr'
  }) : null;

  function userLabel(u) {
    if (!u) return '未登录';
    if (u.name) return u.name;
    if (u.phone) return u.phone.length === 11 ? u.phone.slice(0, 3) + '****' + u.phone.slice(7) : u.phone;
    if (u.email) return u.email.split('@')[0];
    return '读者';
  }
  function isAdmin() { return !!(S.user && S.user.role === 'admin'); }
  function requireLogin(what) {
    if (S.user) return true;
    toast('请先登录' + (what ? '后再' + what : '') + ' · 右上角登录');
    openAuth();
    return false;
  }

  function renderUserChip() {
    var el = document.getElementById('userChip');
    if (!el) return;
    if (S.user) {
      el.classList.add('logged');
      el.innerHTML = '<span class="avatar">' + esc(S.user.label.charAt(0)) + '</span>' +
        '<span class="uc-name">' + esc(S.user.label) + '</span>' +
        '<span class="role-badge' + (isAdmin() ? ' is-admin' : '') + '">' +
        (isAdmin() ? '管理员' : '读者') + '</span>' +
        (isAdmin() ? '' : '<button class="uc-btn" data-auth="admin">管理员认证</button>') +
        '<button class="uc-btn" data-auth="logout">退出</button>';
    } else {
      el.classList.remove('logged');
      el.innerHTML = '<button class="btn btn-outline uc-login" data-auth="open">登录 / 注册</button>';
    }
  }

  function authMsg(msg, ok) {
    var el = document.getElementById('authErr');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? '' : 'none';
    el.classList.toggle('ok', !!ok);
  }

  function openAuth() {
    if (!cloud) {
      modal('登录 · 悦读', '<p class="auth-notice">云服务组件未加载，请检查网络后刷新页面重试。</p>');
      return;
    }
    modal('登录 · 悦读',
      '<p class="auth-notice" id="authErr" style="display:none"></p>' +
      '<div class="auth-form">' +
      '<label>手机号<input id="authPhone" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号 · 新号验证后自动注册" autocomplete="tel"></label>' +
      '<label>短信验证码<span class="code-row"><input id="authCode" maxlength="8" placeholder="4–8 位验证码" autocomplete="one-time-code"><button type="button" class="btn btn-outline" data-authdo="sendcode">获取验证码</button></span></label>' +
      '<button class="btn btn-primary btn-block" data-authdo="otp">登 录 / 注 册</button>' +
      '<button class="btn btn-outline btn-block" data-authdo="wechat">微信扫码登录</button>' +
      '<p class="auth-note">读者登录后：预约借阅 · 我的借阅 · 书评评分 · 选座签到<br>管理员：登录后点右上角「管理员认证」输入口令开通，可使用扫码借还工作台与预约核销</p></div>');
    var p = document.getElementById('authPhone');
    if (p) p.focus();
  }

  function startCountdown(sec) {
    var btn = document.querySelector('[data-authdo="sendcode"]');
    if (!btn) return;
    var left = sec;
    btn.disabled = true; btn.textContent = left + 's 后重发';
    clearInterval(codeTimer);
    codeTimer = setInterval(function () {
      left--;
      if (left <= 0) { clearInterval(codeTimer); btn.disabled = false; btn.textContent = '获取验证码'; return; }
      btn.textContent = left + 's 后重发';
    }, 1000);
  }

  var pendingOtp = null, codeTimer = null, authBusyFlag = false;

  async function sendPhoneCode() {
    if (authBusyFlag) return;
    var phone = (document.getElementById('authPhone') || {}).value || '';
    phone = phone.trim();
    if (!/^1\d{10}$/.test(phone)) { authMsg('请输入正确的 11 位手机号'); return; }
    authMsg('');
    authBusyFlag = true;
    var btn = document.querySelector('[data-authdo="sendcode"]');
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    try {
      var sent = await cloud.auth.sendOtp({ phone: phone });
      if (sent.error) throw sent.error;
      pendingOtp = { phone: phone, verificationId: sent.data.verificationId, isExistingUser: !!sent.data.isExistingUser };
      startCountdown(60);
      authMsg('验证码已发送' + (pendingOtp.isExistingUser ? '' : '，新手机号将自动注册'), true);
      var c = document.getElementById('authCode');
      if (c) c.focus();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '获取验证码'; }
      authMsg('验证码发送失败：' + (err && err.message ? err.message : '请稍后再试'));
    }
    authBusyFlag = false;
  }

  async function submitPhoneLogin() {
    if (authBusyFlag) return;
    var phone = ((document.getElementById('authPhone') || {}).value || '').trim();
    var token = ((document.getElementById('authCode') || {}).value || '').trim();
    var pending = pendingOtp;
    if (!pending || pending.phone !== phone) { authMsg('请先为当前手机号获取验证码'); return; }
    if (!/^\d{4,8}$/.test(token)) { authMsg('请输入收到的短信验证码'); return; }
    authMsg('');
    authBusyFlag = true;
    var btn = document.querySelector('[data-authdo="otp"]');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    try {
      var done = await cloud.auth.verifyOtp({
        phone: pending.phone, verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser, token: token
      });
      if (done.error) throw done.error;
      pendingOtp = null;
      await afterSignIn(done.data && done.data.user);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '登 录 / 注 册'; }
      authMsg('登录失败：' + (err && err.message ? err.message : '请稍后再试'));
    }
    authBusyFlag = false;
  }

  async function wechatLogin() {
    if (!cloud || typeof cloud.auth.signInWithOAuth !== 'function') { authMsg('当前版本暂不支持微信登录'); return; }
    try {
      var back = new URL(location.href);
      back.pathname = '/';
      ['code', 'state', 'provider'].forEach(function (k) { back.searchParams.delete(k); });
      var r = await cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: back.toString() });
      if (r.error) throw r.error;
      if (r.data && r.data.url) location.assign(r.data.url);
      else authMsg('未获取到微信授权跳转地址');
    } catch (err) {
      authMsg('微信登录暂不可用：' + (err && err.message ? err.message : '微信授权需在正式发布域名下使用'));
    }
  }

  async function afterSignIn(u) {
    if (!u) throw new Error('登录会话建立失败');
    S.user = { id: String(u.id || ''), label: userLabel(u), role: 'reader' };
    await refreshRole();
    clearInterval(codeTimer);
    closeModal();
    renderUserChip(); renderAll();
    toast('欢迎，' + S.user.label + (isAdmin() ? '（管理员）' : ''));
  }

  async function refreshRole() {
    if (!S.user || !cloud) return;
    try {
      var r = await cloud.database.from('yuedu_staff').select('owner_id').eq('owner_id', S.user.id).maybeSingle();
      S.user.role = (!r.error && r.data) ? 'admin' : 'reader';
    } catch (e) { S.user.role = 'reader'; }
  }

  async function doLogout() {
    if (cloud) { try { await cloud.auth.signOut(); } catch (e) { /* 忽略 */ } }
    S.user = null; renderUserChip(); renderAll();
    toast('已退出登录');
  }

  /* OAuth 回调分发（微信 / WorkBuddy 授权返回）：普通访问直接跳过 */
  async function handleOAuthCallback() {
    if (!cloud) return false;
    var url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return false;
    var provider = url.searchParams.get('provider');
    if (provider !== 'wechat' && provider !== 'workbuddy') return false;
    var handle = provider === 'wechat' ? cloud.auth.handleWechatWebCallback : cloud.auth.handleWorkBuddyCallback;
    if (typeof handle !== 'function') return false;
    var r = await handle.call(cloud.auth);
    if (r && !r.error && r.data) {
      ['code', 'state', 'provider'].forEach(function (k) { url.searchParams.delete(k); });
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      await afterSignIn(r.data.user || (r.data.session && r.data.session.user));
      return true;
    }
    if (r && r.error) toast('授权登录失败：' + r.error.message);
    return false;
  }

  /* 启动时恢复会话：云端 getSession + 管理员身份判定 */
  async function restoreSession() {
    if (!cloud) { renderUserChip(); return; }
    try {
      if (await handleOAuthCallback()) return;
      var r = await cloud.auth.getSession();
      var s = r && r.data;
      if (s && s.user) {
        S.user = { id: String(s.user.id || ''), label: userLabel(s.user), role: 'reader' };
        await refreshRole();
      }
    } catch (e) { /* 云服务不可达：保持未登录，站点浏览不受影响 */ }
    renderUserChip();
  }

  /* 管理员认证：口令校验在云端安全函数 yuedu_claim_admin 内完成 */
  function openClaimModal() {
    if (!S.user) return;
    modal('管理员认证',
      '<div class="auth-form">' +
      '<label>管理员口令<input id="claimCode" type="password" maxlength="40" placeholder="请向馆方获取管理员口令"></label>' +
      '<button class="btn btn-primary btn-block" data-authdo="claim">认证为管理员</button>' +
      '<p class="auth-note">认证通过后可使用「我的借阅」扫码借还工作台与预约核销。</p></div>');
  }
  var AUTH_LABELS = { claim: '认证为管理员' };
  function authBusy(on, kind) {
    var b = document.querySelector('[data-authdo="' + kind + '"]');
    if (b) { b.disabled = on; b.textContent = on ? '请稍候…' : AUTH_LABELS[kind]; }
  }
  async function claimAdmin() {
    if (!cloud || !S.user) return;
    var code = ((document.getElementById('claimCode') || {}).value || '').trim();
    if (!code) { toast('请输入管理员口令'); return; }
    authBusy(true, 'claim');
    try {
      var r = await cloud.database.rpc('yuedu_claim_admin', { p_code: code });
      if (r.error) throw r.error;
      S.user.role = 'admin';
      closeModal(); renderUserChip(); renderAll();
      toast('管理员认证成功');
    } catch (err) {
      toast((err && err.message) ? err.message : '认证失败，请稍后再试');
      authBusy(false, 'claim');
    }
  }

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
    var db = YueDuDB.get();
    var books = db.books.slice().sort(function (a, b) { return b.hot - a.hot; }).slice(0, 3);
    $('#rankList').innerHTML = books.map(function (b, i) {
      var ri = ratingInfo(db, b.id);
      return '<li><span class="rank-num">' + '一二三'[i] + '</span>' +
        '<div class="rank-body"><strong><a href="javascript:void(0)" data-book="' + b.id + '" title="查看详情与书评">《' + esc(b.title) + '》</a></strong>' +
        '<small>' + esc(b.author) + ' · ' + esc(b.publisher) + ' · ' + esc(b.callNo) +
        (ri.count ? ' · ★' + ri.avg.toFixed(1) + '（' + ri.count + ' 评）' : '') + '</small></div>' +
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
    var noteEl = document.getElementById('loansNote');
    if (noteEl) noteEl.textContent = '在借 ' + loans.length + ' 册 · 待办理 ' + picks.length + ' 册 · 最多 6 册';
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
    var db = YueDuDB.get();
    $('#resultList').innerHTML = list.length ? list.map(function (b, i) {
      var spine = b.spine || b.title;
      var half = Math.ceil(spine.length / 2);
      var ri = ratingInfo(db, b.id);
      return '<article class="result-card" style="animation-delay:' + (i * 45) + 'ms">' +
        '<div class="book-spine" style="background:' + b.color + '">' + esc(spine.slice(0, half)) + '<br>' + esc(spine.slice(half)) + '</div>' +
        '<div class="rc-body"><h3><a href="javascript:void(0)" data-book="' + b.id + '" title="查看详情与书评">《' + esc(b.title) + '》</a></h3>' +
        '<p class="rc-meta">' + esc(b.author) + ' · ' + esc(b.publisher) + ' ' + b.year + ' · ' + esc(b.callNo) + '</p>' +
        '<p class="rc-meta">' + esc(b.location) + ' · ' + esc(b.shelf) +
        ' <em>·</em> <span class="' + (b.stock > 0 ? 'ok' : 'no') + '">' + (b.stock > 0 ? '可借' : '已借出') + '</span></p>' +
        '<p class="rc-rate">' + (ri.count
          ? starsHTML(ri.avg) + '<b>' + ri.avg.toFixed(1) + '</b><span>' + ri.count + ' 条书评</span>'
          : '<span class="rate-none">暂无书评</span>') +
        '<a href="javascript:void(0)" data-book="' + b.id + '">详情 · 写书评 ›</a></p></div>' +
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
      renderStatus(); renderUserChip();
      if (S.page === 'loans') renderLoansPage();
    });
  }

  /* ---------------- 业务操作：预约借阅 · 到馆办理 ---------------- */
  function activePickups(db) {
    return (db.pickups || []).filter(function (p) { return !p.fulfilled && !p.cancelled; });
  }
  function reservePickup(bookId, ev) {
    if (!requireLogin('预约借阅')) return;
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
      '<div class="m-note">取书码保留 3 天，逾期预约自动取消；到馆后由工作人员核销办理。</div>',
      (isAdmin()
        ? [{ label: '工作人员核销', primary: true, onClick: function () { fulfillPickup(id); } }, { label: '稍后办理' }]
        : [{ label: '稍后办理', primary: true }]));
    InkFX.qr($('#pickupQr'), p.code);
  }
  function fulfillPickup(id) {
    if (!isAdmin()) { toast('预约核销须由管理员（工作人员）办理'); return; }
    var db = YueDuDB.get();
    var p = activePickups(db).find(function (x) { return x.id === id; });
    if (!p) return;
    if ((db.loans || []).some(function (l) { return l.bookId === p.bookId; })) { toast('该书已在您的借阅中'); return; }
    var b = (db.books || []).find(function (x) { return x.id === p.bookId; });
    if (!b || b.stock <= 0) { toast('该书当前无在架馆藏，可继续排队等待回架'); return; }
    var due = addDays(30);
    YueDuDB.commit({
      type: 'pickup-fulfill', pickupId: id, bookId: p.bookId,
      loan: { id: uid('l'), bookId: p.bookId, title: p.title, due: due, renewable: true, code: loanCode(), createdAt: Date.now() }
    }).then(function () {
      toast('《' + p.title + '》借出办理完成 · 应还 ' + due);
      InkFX.burst(innerWidth / 2, innerHeight / 2, 26);
      renderAll();
    });
  }
  function cancelPickup(id) {
    if (!requireLogin('取消预约')) return;
    var p = activePickups(YueDuDB.get()).find(function (x) { return x.id === id; });
    if (!p) return;
    YueDuDB.commit({ type: 'pickup-cancel', pickupId: id })
      .then(function () { toast('《' + p.title + '》的预约已取消'); renderAll(); });
  }

  /* ================= 图书评论与评分 ================= */
  function reviewsOf(db, bookId) {
    return (db.reviews || []).filter(function (r) { return r.bookId === bookId; })
      .sort(function (a, b) { return (b.time || 0) - (a.time || 0); });
  }
  function ratingInfo(db, bookId) {
    var rs = reviewsOf(db, bookId);
    if (!rs.length) return { avg: 0, count: 0 };
    var sum = rs.reduce(function (s, r) { return s + (r.rating || 0); }, 0);
    return { avg: Math.round(sum / rs.length * 10) / 10, count: rs.length };
  }
  function starsHTML(avg) {
    var full = Math.round(avg), out = '';
    for (var i = 1; i <= 5; i++) out += '<i class="st' + (i <= full ? ' on' : '') + '">★</i>';
    return '<span class="stars">' + out + '</span>';
  }
  function fmtDay(ts) { var d = new Date(ts || Date.now()); return (d.getMonth() + 1) + '.' + d.getDate(); }

  /* 书籍详情弹层：馆藏信息 + 评分总览 + 书评列表 + 写书评表单 */
  function showBook(id) {
    var db = YueDuDB.get(), b = (db.books || []).find(function (x) { return x.id === id; });
    if (!b) return;
    var ri = ratingInfo(db, id), rs = reviewsOf(db, id);
    S.revDraft = { bookId: id, rating: 0 };
    var form =
      '<div class="rev-form">' +
      '<div class="rev-line"><span class="rev-label">我的评分</span>' +
      '<span class="rev-stars" id="revStars">' +
      [1, 2, 3, 4, 5].map(function (i) { return '<button type="button" data-star="' + i + '" title="' + i + ' 星">★</button>'; }).join('') +
      '</span><span class="rev-hint" id="revRatingHint">未评分</span></div>' +
      '<div class="rev-line"><span class="rev-label">昵称</span>' +
      '<input id="revName" maxlength="20" placeholder="匿名读者" value="' + esc(readerName()) + '"></div>' +
      '<textarea id="revText" maxlength="300" rows="3" placeholder="写下您的阅读感受（可只评分不留文字，300 字内）"></textarea>' +
      '<div class="rev-actions"><button class="btn btn-primary" data-revpost="' + esc(id) + '">发布书评</button>' +
      '<span class="rev-note">再次以同一昵称发布即视为修改</span></div></div>';
    var list = rs.length ? rs.map(function (r) {
      return '<div class="rev-item"><div class="rev-head"><b>' + esc(r.user || '匿名读者') + '</b>' +
        starsHTML(r.rating) + '<time>' + fmtDay(r.time) + '</time></div>' +
        (r.content ? '<p>' + esc(r.content) + '</p>' : '') + '</div>';
    }).join('') : '<p class="rev-empty">还没有书评，抢个沙发吧</p>';
    var body =
      '<p class="bk-meta">' + esc(b.author) + ' · ' + esc(b.publisher) + ' ' + b.year + ' · ' + esc(b.callNo) + '</p>' +
      '<p class="bk-meta">' + esc(b.location) + ' · ' + esc(b.shelf) + ' · <span class="' + (b.stock > 0 ? 'ok' : 'no') + '">' + (b.stock > 0 ? '可借' : '已借出') + '</span></p>' +
      '<div class="bk-rating">' + (ri.count
        ? '<b class="bk-avgr">' + ri.avg.toFixed(1) + '</b>' + starsHTML(ri.avg) + '<span>' + ri.count + ' 位读者评分</span>'
        : '<span class="rate-none">暂无读者评分</span>') + '</div>' +
      '<div class="rev-list">' + list + '</div>' +
      '<h4 class="rev-form-title">写书评</h4>' + form;
    modal('《' + b.title + '》· 详情与书评', body,
      [{ label: b.stock > 0 ? '预约借阅' : '排队预约', primary: true, onClick: function () { reservePickup(id); } }, { label: '关闭' }]);
  }
  function readerName() {
    if (S.user) return S.user.label;
    try { return localStorage.getItem('yuedu-reader-name') || ''; } catch (e) { return ''; }
  }
  function postReview(bookId) {
    if (!requireLogin('发布书评')) return;
    var rating = S.revDraft && S.revDraft.bookId === bookId ? S.revDraft.rating : 0;
    if (!rating) { toast('请先点选评分星级'); return; }
    var nameEl = document.getElementById('revName'), textEl = document.getElementById('revText');
    var name = ((nameEl && nameEl.value) || '').trim() || (S.user ? S.user.label : '匿名读者');
    var text = ((textEl && textEl.value) || '').trim();
    if (!S.user) { try { localStorage.setItem('yuedu-reader-name', name); } catch (e) { /* 隐私模式忽略 */ } }
    YueDuDB.commit({
      type: 'review',
      item: { id: uid('rv'), bookId: bookId, user: name, rating: rating, content: text, time: Date.now() }
    }).then(function () {
      toast('书评已发布 · ' + rating + ' 星 · 感谢分享');
      showBook(bookId);   // 刷新弹层，展示新列表与均分
    });
  }

  /* ================= 我的借阅独立版块（预约办理 · 在借管理 · 扫码借还） ================= */
  function renderLoansPage() {
    var db = YueDuDB.get();
    var picks = activePickups(db), loans = db.loans || [];
    var note = document.getElementById('loansPageNote');
    if (note) note.textContent = '到馆预约 ' + picks.length + ' 项 · 在借 ' + loans.length + ' 册 · 合计最多 6 册 · 借还办理集中于此';
    var pn = document.getElementById('pickupNote');
    if (pn) pn.textContent = picks.length ? '共 ' + picks.length + ' 项待办理' : '暂无待办理预约';
    var ln = document.getElementById('loanNote');
    if (ln) ln.textContent = '在借 ' + loans.length + ' 册 · 最多 6 册';
    var pickHtml = picks.slice().reverse().map(function (p) {
      var created = new Date(p.createdAt || Date.now());
      return '<li><span class="loan-spine red"></span>' +
        '<div class="loan-body"><strong>《' + esc(p.title) + '》</strong>' +
        '<small>取书码 <b>' + esc(p.code) + '</b> · 预约于 ' + (created.getMonth() + 1) + '.' + created.getDate() + ' · 待到馆办理</small></div>' +
        '<div class="loan-actions"><button data-pickup="' + esc(p.id) + '">出码办理</button>' +
        '<button data-pickcancel="' + esc(p.id) + '">取消预约</button></div></li>';
    }).join('');
    $('#pickupList').innerHTML = pickHtml || '<li class="empty-note">暂无到馆预约，去藏书检索预约一本吧</li>';
    var loanHtml = loans.slice().reverse().map(function (l, i) {
      var left = daysLeft(l.due);
      var ret = S.scan.pendingReturn === l.id;
      return '<li' + (ret ? ' class="ret-target"' : '') + '><span class="loan-spine' + (i % 2 ? ' red' : '') + '"></span>' +
        '<div class="loan-body"><strong>《' + esc(l.title) + '》</strong>' +
        '<small>应还 ' + esc(l.due) + ' · 剩余 <b>' + left + '</b> 天' + (left <= 3 ? ' · 即将到期' : '') +
        ' · 还书码 <b>' + esc(l.code || '—') + '</b></small></div>' +
        '<div class="loan-actions">' +
        (l.renewable ? '<button data-renew="' + esc(l.id) + '">续借</button>' : '') +
        '<button data-return="' + esc(l.id) + '">' + (ret ? '办理中…' : '归还') + '</button>' +
        '<button data-loancancel="' + esc(l.id) + '">取消借阅</button></div></li>';
    }).join('');
    $('#loanFullList').innerHTML = loanHtml || '<li class="empty-note">暂无在借图书，去藏书检索预约一本吧</li>';
    renderScan();
  }

  function resetScan() {
    var sc = S.scan;
    sc.matched = null; sc.error = null; sc.raw = ''; sc.status = ''; sc.busy = false; sc.source = '';
  }

  /* 在借记录的还书码：办理归还时的凭证之一（扫标签 / 输书名 / 输码 三选一） */
  function loanCode() { return 'RT-' + Date.now().toString(36).toUpperCase().slice(-6); }

  function renderScan() {
    var box = document.getElementById('scanResult');
    if (!box) return;
    var sc = S.scan;
    $$('#scanModePills .mode-pill').forEach(function (b) { b.classList.toggle('on', b.dataset.v === sc.mode); });
    /* 权限门槛：扫码借还工作台仅限管理员（工作人员） */
    if (!isAdmin()) {
      var st0 = document.getElementById('scanStateNote');
      if (st0) st0.textContent = '工作人员操作台 · 未授权';
      var sb0 = document.getElementById('scanBtns');
      if (sb0) sb0.innerHTML = '<button class="btn btn-primary" disabled>开启摄像头（仅管理员）</button>';
      var man0 = document.querySelector('.manual-locate');
      if (man0) man0.style.display = 'none';
      box.innerHTML = '<div class="scan-idle admin-gate"><b>工作人员操作台 · 仅限管理员使用</b><br>' +
        (S.user
          ? '您当前是「读者」身份，可点右上角「管理员认证」输入口令开通'
          : '请先在右上角登录，再通过「管理员认证」开通操作台') + '</div>';
      return;
    }
    var manEl = document.querySelector('.manual-locate');
    if (manEl) manEl.style.display = '';
    $('#scanBtns').innerHTML = (sc.stream
      ? '<button class="btn btn-primary" data-scan="camShot">拍摄并识别</button><button class="btn btn-ghost" data-scan="camStop">关闭摄像头</button>'
      : '<button class="btn btn-primary" data-scan="camStart">开启摄像头</button>')
      + '<button class="btn btn-ghost file-btn">上传图书照片（标签/封面/书脊）<input type="file" id="scanFile" accept="image/*"></button>';
    var hint = document.getElementById('camHintText');
    if (hint) hint.innerHTML = sc.stream
      ? '摄像头已开启 · 对准图书标签、封面或书脊拍摄'
      : '先开启摄像头，将图书标签/封面/书脊对准取景框<br>没有摄像头也可以直接上传照片或输入还书码';
    $('#scanCam').classList.toggle('live', !!sc.stream);
    var st = document.getElementById('scanStateNote');
    var pending = sc.pendingReturn ? (YueDuDB.get().loans || []).find(function (l) { return l.id === sc.pendingReturn; }) : null;
    if (st) st.textContent = sc.busy ? '正在识别…'
      : (pending ? '归还办理中 ·《' + pending.title + '》· 待识别' : (sc.mode === 'borrow' ? '模式：借出登记' : '模式：归还登记'));

    var html = '';
    if (pending) {
      html += '<div class="scan-pending">归还办理中 ·《<b>' + esc(pending.title) + '》</b> 应还 ' + esc(pending.due) +
        ' · 还书码 <b>' + esc(pending.code || '—') + '</b>' +
        ' — 请拍摄该册图书（标签/封面/书脊均可识别），或在下方输入还书码定位' +
        ' <button class="btn btn-ghost" data-scan="clearPending">放弃办理</button></div>';
    }
    if (sc.busy) {
      html += '<div class="scan-spin"><i></i>正在识别…（支持图书标签、封面、书脊）</div>';
    } else if (sc.error) {
      html += '<div class="scan-err">' + esc(sc.error) + '</div>';
    } else if (sc.matched) {
      var b = sc.matched, db = YueDuDB.get();
      var pick = activePickups(db).filter(function (p) { return p.bookId === b.id; })[0];
      var onLoan = (db.loans || []).some(function (l) { return l.bookId === b.id; });
      var note = sc.mode === 'borrow'
        ? (pick
            ? '该书有到馆预约 · 确认后核销取书码 ' + esc(pick.code) + ' 并登记借出（借期 30 天）'
            : (b.stock > 0
                ? '该书暂无到馆预约 · 在架 ' + b.stock + ' 册，可直接办理借出（借期 30 天）'
                : '该书暂无到馆预约 · 在架 0 册，暂不能办理借出'))
        : (onLoan ? '该书有在借记录，确认后将登记归还' : '该书当前没有在借记录，无需归还');
      var spine = b.spine || b.title, half = Math.ceil(spine.length / 2);
      html = '<div class="match-card">' +
        '<div class="book-spine" style="background:' + b.color + '">' + esc(spine.slice(0, half)) + '<br>' + esc(spine.slice(half)) + '</div>' +
        '<div class="match-info"><b>《' + esc(b.title) + '》</b>' +
        '<div class="match-meta">' + esc(b.author) + ' · ' + esc(b.publisher) + ' ' + b.year + ' · ' + esc(b.callNo) + ' · 在架 ' + b.stock + ' / ' + b.total + ' 册</div>' +
        (sc.status ? '<span class="match-status">标签状态：' + esc(sc.status) + '</span>' : '') +
        (sc.source ? '<span class="match-status">识别来源：' + ({ label: '图书标签', cover: '图书封面', spine: '书脊' }[sc.source] || sc.source) + '</span>' : '') +
        '<div class="match-note">' + note + '</div>' +
        '<div class="match-act"><button class="btn ' + (sc.mode === 'borrow' && (!pick && (b.stock <= 0 || onLoan)) ? 'btn-ghost' : 'btn-primary') + '" data-scan="confirm">' +
        (sc.mode === 'borrow' ? '确认借出 · ' + esc(b.title) : '确认归还 · ' + esc(b.title)) + '</button></div>' +
        '<div class="match-raw">' + (sc.raw ? '模型原始返回：' + esc(sc.raw) : '来源：手动定位') + '</div>' +
        '</div></div>';
    } else {
      html += '<div class="scan-idle">拍摄图书标签、封面或书脊均可识别书名<br>识别结果会显示在这里</div>';
    }
    box.innerHTML = html;
  }

  /* ---- 摄像头与识别（移植自云图书馆扫码台） ---- */
  function startScanCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('当前环境不支持摄像头，可上传标签照片或手动定位'); return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false
    }).then(function (stream) {
      S.scan.stream = stream; S.scan.error = null; S.scan.matched = null;
      renderScan();
      var v = document.getElementById('scanVideo');
      if (v) v.srcObject = stream;
    }).catch(function () {
      toast('摄像头开启失败，可改用上传照片或手动定位');
    });
  }
  function stopScanCam() {
    if (S.scan.stream) {
      S.scan.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      S.scan.stream = null;
    }
  }
  function shotScanCam() {
    var v = document.getElementById('scanVideo');
    if (!v || !v.videoWidth) { toast('摄像头画面还未就绪'); return; }
    var c = document.createElement('canvas');
    var scale = Math.min(1, 900 / v.videoWidth);
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    recognizeScan(c.toDataURL('image/jpeg', 0.85));
  }
  function fileScan(input) {
    var f = input.files && input.files[0];
    if (!f) return;
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, 900 / img.width);
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      input.value = '';
      recognizeScan(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = function () { toast('图片读取失败'); };
    img.src = URL.createObjectURL(f);
  }

  /* 识别提示词：兼容三种拍摄对象 —— ①粘贴的图书标签 ②图书封面 ③书脊 */
  var BOOK_PROMPT = '这是一张图书馆相关的照片，可能是以下三种之一：①贴在书上的标签（印有书名，可能带书名号《》，并可能标注状态文字如"借阅""借出""归还""在库"）；②图书封面（书名印在封面上）；③书脊（书名竖排或横排印在书脊上）。请识别照片中出现的图书书名。照片中若出现多本书，只取最清晰、最居中的那一本。只返回一个 JSON 对象，不要任何解释文字或 markdown 代码块，格式：{"title":"识别出的书名，不含书名号","source":"label或cover或spine，标明书名来自标签、封面还是书脊","status":"标签上的状态文字，没有则为空字符串","confidence":"high或medium或low"}';

  /* 识别链路：优先走云服务内置视觉大模型（免密钥，混元等，任意来源页面均可直连），
   * 云端不可用时回退本机 /api/vision 代理（须通过 node server.js 访问）。 */
  var visionModelsCache = null;
  async function pickVisionModel() {
    if (!cloud) return null;
    if (visionModelsCache) return visionModelsCache;
    try {
      var list = await cloud.llm.models.list();
      visionModelsCache = (list || []).filter(function (m) { return m.supportsImages === true && m.disabled !== true; });
    } catch (e) { visionModelsCache = []; }
    return visionModelsCache;
  }
  async function visionViaCloud(dataUrl) {
    var models = await pickVisionModel();
    if (!models || !models.length) throw new Error('云端视觉模型暂不可用');
    /* 优先混元系列（hy*），其次 GLM 视觉模型；auto 为路由模型，图像识别不稳，排除 */
    var model = models.find(function (m) { return /^hy/.test(m.id); }) ||
      models.find(function (m) { return /vision|4\.6v|vl/i.test(m.id); }) ||
      models.find(function (m) { return m.id !== 'auto'; }) || models[0];
    var answer = '';
    for await (const chunk of cloud.llm.chat.completions.create({
      model: model.id,
      messages: [
        { role: 'system', content: '你是图书馆的图书识别助手。只输出一个 JSON 对象，不要任何解释文字或 markdown 代码块。' },
        { role: 'user', content: [
          { type: 'text', text: BOOK_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } }
        ] }
      ],
      stream: true
    })) {
      var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) answer += d.content;
    }
    if (!answer) throw new Error('云端识别未返回内容');
    return answer;
  }

  async function recognizeScan(dataUrl) {
    var sc = S.scan;
    if (sc.busy) return;
    sc.busy = true; sc.matched = null; sc.error = null; sc.raw = '';
    renderScan();
    try {
      var content;
      try {
        content = await visionViaCloud(dataUrl);
      } catch (eCloud) {
        var r = await fetch('/api/vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl, prompt: BOOK_PROMPT })
        });
        var data = await r.json().catch(function () { return {}; });
        if (!data.ok) throw new Error(data.error || ('识别服务不可用（HTTP ' + r.status + '）'));
        content = data.content;
      }
      applyScanResult(String(content || ''));
    } catch (err) {
      sc.busy = false;
      sc.error = '识别失败：' + (err && err.message ? err.message : '网络异常') + '。可用下方「手动定位」输入书名完成登记。';
      renderScan();
    }
  }

  function applyScanResult(content) {
    var sc = S.scan;
    sc.busy = false; sc.raw = content; sc.source = '';
    var obj = null;
    try {
      var t = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      var a = t.indexOf('{'), bIdx = t.lastIndexOf('}');
      if (a >= 0 && bIdx > a) obj = JSON.parse(t.slice(a, bIdx + 1));
    } catch (e) { /* 忽略 */ }
    if (!obj || !obj.title) {
      sc.error = '没有识别出图书标签，请确认照片清晰后重试，或使用手动定位';
      sc.matched = null; renderScan(); return;
    }
    sc.status = String(obj.status || '');
    if (obj.source) sc.source = String(obj.source);
    sc.matched = matchBook(obj.title);
    if (!sc.matched) {
      sc.error = '识别出书名「' + obj.title + '」，但馆藏中找不到这本书，请核对后重试';
    }
    renderScan();
  }

  /* 书名模糊匹配馆藏：精确 → 包含 → 索书号 */
  function matchBook(title) {
    var norm = function (s) { return String(s).replace(/[《》\s“”‘’·.。,:：!！?？\-—_]/g, '').toLowerCase(); };
    var t = norm(title);
    if (!t) return null;
    var books = YueDuDB.get().books || [];
    return books.find(function (b) { return norm(b.title) === t; })
        || books.find(function (b) { return norm(b.title).indexOf(t) >= 0 || t.indexOf(norm(b.title)) >= 0; })
        || books.find(function (b) { return b.callNo && norm(b.callNo) === t; })
        || null;
  }

  function manualLocate() {
    var input = document.getElementById('scanManual');
    var q = (input && input.value || '').trim();
    if (!q) { toast('请输入书名、索书号或还书码'); return; }
    var b = matchBook(q);
    var sc = S.scan;
    if (!b) {
      /* 还书码定位：输入在借记录的 RT-XXXXXX 直接锁定该书 */
      var norm = function (s) { return String(s).trim().toUpperCase(); };
      var loan = (YueDuDB.get().loans || []).find(function (l) { return l.code && norm(l.code) === norm(q); });
      if (loan) b = (YueDuDB.get().books || []).find(function (x) { return x.id === loan.bookId; }) || null;
    }
    if (!b) {
      sc.error = '馆藏中找不到「' + q + '」，可输入书名、索书号或在借记录上的还书码';
      sc.matched = null; sc.raw = ''; sc.status = '';
      renderScan(); return;
    }
    sc.error = null; sc.status = ''; sc.raw = ''; sc.matched = b;
    renderScan();
  }

  /* 确认借出 / 归还登记（事件溯源写入） */
  function confirmScan() {
    if (!isAdmin()) { toast('借还核销须由管理员（工作人员）办理'); return; }
    var sc = S.scan, b = sc.matched;
    if (!b) return;
    var db = YueDuDB.get();
    if (sc.mode === 'borrow') {
      var pick = activePickups(db).filter(function (p) { return p.bookId === b.id; })[0];
      if (pick) {
        if (b.stock <= 0) { toast('该书在架 0 册，暂不能办理借出'); return; }
        var due = addDays(30);
        YueDuDB.commit({ type: 'pickup-fulfill', pickupId: pick.id, bookId: b.id,
          loan: { id: uid('l'), bookId: b.id, title: b.title, due: due, renewable: true, code: loanCode(), createdAt: Date.now() }
        }).then(function () {
          resetScan(); S.scan.pendingReturn = null; renderScan(); renderAll();
          toast('已核销预约 ·《' + b.title + '》借出 · 应还 ' + due);
        });
      } else {
        if (b.stock <= 0) { toast('该书在架 0 册，暂不能直接借出'); return; }
        if ((db.loans || []).some(function (l) { return l.bookId === b.id; })) { toast('该书已在借阅中'); return; }
        if ((db.loans || []).length >= 6) { toast('在借已达 6 册上限，请先归还'); return; }
        var due2 = addDays(30);
        YueDuDB.commit({ type: 'borrow', bookId: b.id,
          loan: { id: uid('l'), bookId: b.id, title: b.title, due: due2, renewable: true, code: loanCode(), createdAt: Date.now() }
        }).then(function () {
          resetScan(); S.scan.pendingReturn = null; renderScan(); renderAll();
          toast('借出办理完成 ·《' + b.title + '》应还 ' + due2);
        });
      }
    } else {
      /* 归还登记：若从「我的借阅」发起，须与待归还册次一致 */
      var target = sc.pendingReturn ? (db.loans || []).find(function (l) { return l.id === sc.pendingReturn; }) : null;
      if (target && target.bookId !== b.id) {
        sc.error = '识别到《' + b.title + '》，但当前待归还的是《' + target.title + '》，请核对后再试';
        sc.matched = null; renderScan(); return;
      }
      var row = target || (db.loans || []).filter(function (l) { return l.bookId === b.id; })[0];
      if (!row) { toast('这本书当前没有在借记录'); return; }
      YueDuDB.commit({ type: 'return', loanId: row.id })
        .then(function () {
          resetScan(); sc.pendingReturn = null; renderScan(); renderAll();
          toast('归还登记完成 ·《' + b.title + '》感谢爱护图书');
        });
    }
  }

  /* 取消借阅：撤销在借记录，库存即时回架 */
  function cancelLoan(id) {
    if (!requireLogin('取消借阅')) return;
    var l = (YueDuDB.get().loans || []).find(function (x) { return x.id === id; });
    if (!l) return;
    modal('取消借阅', '<p>确认取消《<b>' + esc(l.title) + '》的借阅？</b></p>' +
      '<p>取消后该书即时回架，等同于完成一次归还登记。</p>',
      [{ label: '确认取消借阅', primary: true, onClick: function () {
          YueDuDB.commit({ type: 'cancel-loan', loanId: id })
            .then(function () { toast('已取消借阅 ·《' + l.title + '》库存回架'); renderAll(); });
      } }, { label: '再想想' }]);
  }
  function addWish(bookId) {
    if (!requireLogin('加入书单')) return;
    var db = YueDuDB.get(), b = (db.books || []).find(function (x) { return x.id === bookId; });
    if (!b) return;
    if ((db.wishlist || []).some(function (w) { return w.bookId === bookId && w.type === 'wish'; })) {
      toast('《' + b.title + '》已在书单中'); return;
    }
    YueDuDB.commit({ type: 'wish', item: { id: uid('w'), bookId: bookId, title: b.title, type: 'wish', createdAt: Date.now() } })
      .then(function () { toast('《' + b.title + '》已加入我的书单'); });
  }
  function renew(id) {
    if (!requireLogin('续借')) return;
    var l = (YueDuDB.get().loans || []).find(function (x) { return x.id === id; });
    if (!l) return;
    var cur = parseDue(l.due); cur.setDate(cur.getDate() + 14);
    YueDuDB.commit({ type: 'renew', loanId: id, due: fmtDue(cur) })
      .then(function () { toast('续借成功 · 借期延长 14 天'); renderAll(); });
  }
  /* 归还办理：不能一键完成 —— 引导到扫码台，扫描该书标签/封面，
     或输入还书码 / 书名，识别匹配后才可确认归还 */
  function returnBook(id) {
    if (!requireLogin('发起归还')) return;
    var l = (YueDuDB.get().loans || []).find(function (x) { return x.id === id; });
    if (!l) return;
    if (S.page !== 'loans') location.hash = '#/loans';
    var sc = S.scan;
    sc.mode = 'return';
    sc.pendingReturn = id;
    resetScan();
    renderAll();
    var el = document.querySelector('.scan-station');
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var input = document.getElementById('scanManual');
    if (input) { input.value = ''; input.placeholder = '输入《' + l.title + '》的还书码 ' + (l.code || '') + ' 或书名'; }
    toast('请扫描《' + l.title + '》的标签或封面，或输入还书码 ' + (l.code || '—') + ' 完成归还');
  }
  function confirmResv(ev) {
    if (!requireLogin('选座预约')) return;
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
    if (!requireLogin('到馆签到')) return;
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
    if (['home', 'search', 'seat', 'loans'].indexOf(page) < 0) page = 'home';
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
    if (page === 'loans') renderLoansPage();
    else stopScanCam();
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

      /* ---- 用户认证入口（登录 / 退出 / 管理员认证） ---- */
      var at = t.closest('[data-auth]');
      if (at) {
        var av = at.dataset.auth;
        if (av === 'open') openAuth();
        else if (av === 'logout') doLogout();
        else if (av === 'admin') openClaimModal();
        return;
      }
      var ado = t.closest('[data-authdo]');
      if (ado) {
        var ak = ado.dataset.authdo;
        if (ak === 'sendcode') sendPhoneCode();
        else if (ak === 'otp') submitPhoneLogin();
        else if (ak === 'wechat') wechatLogin();
        else if (ak === 'claim') claimAdmin();
        return;
      }

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

      var bkLink = t.closest('[data-book]');
      if (bkLink) { showBook(bkLink.dataset.book); return; }
      var star = t.closest('[data-star]');
      if (star) {
        var sv2 = +star.dataset.star;
        if (S.revDraft) S.revDraft.rating = sv2;
        var wrap = document.getElementById('revStars');
        if (wrap) $$('button', wrap).forEach(function (b2) { b2.classList.toggle('on', +b2.dataset.star <= sv2); });
        var rh = document.getElementById('revRatingHint');
        if (rh) rh.textContent = sv2 + ' 星';
        return;
      }
      if (t.closest('[data-revpost]')) { postReview(t.closest('[data-revpost]').dataset.revpost); return; }

      if (t.closest('[data-borrow]')) { reservePickup(t.closest('[data-borrow]').dataset.borrow, e); return; }
      if (t.closest('[data-wishlist]')) { addWish(t.closest('[data-wishlist]').dataset.wishlist); return; }
      if (t.closest('[data-renew]')) { renew(t.closest('[data-renew]').dataset.renew); return; }
      if (t.closest('[data-return]')) { returnBook(t.closest('[data-return]').dataset.return); return; }
      if (t.closest('[data-pickup]')) { showPickup(t.closest('[data-pickup]').dataset.pickup); return; }
      if (t.closest('[data-pickcancel]')) { cancelPickup(t.closest('[data-pickcancel]').dataset.pickcancel); return; }
      if (t.closest('[data-loancancel]')) { cancelLoan(t.closest('[data-loancancel]').dataset.loancancel); return; }

      var scb = t.closest('[data-scan]');
      if (scb) {
        var sv = scb.dataset.scan;
        if (sv === 'mode') { S.scan.mode = scb.dataset.v; S.scan.matched = null; S.scan.error = null; S.scan.status = ''; S.scan.source = ''; if (S.scan.mode === 'borrow') S.scan.pendingReturn = null; renderScan(); return; }
        if (sv === 'clearPending') { S.scan.pendingReturn = null; S.scan.matched = null; S.scan.error = null; renderScan(); toast('已放弃本次归还办理'); return; }
        if (sv === 'camStart') { if (!isAdmin()) { toast('扫码台仅限管理员（工作人员）使用'); return; } startScanCam(); return; }
        if (sv === 'camStop') { stopScanCam(); S.scan.matched = null; renderScan(); return; }
        if (sv === 'camShot') { shotScanCam(); return; }
        if (sv === 'manual') { manualLocate(); return; }
        if (sv === 'confirm') { confirmScan(); return; }
      }

      var act = t.closest('[data-action]');
      if (act) {
        var a = act.dataset.action;
        if (act.tagName === 'A' || act.tagName === 'BUTTON') {
          if (['myloans', 'notices', 'checkin', 'help', 'advanced', 'myresv'].indexOf(a) >= 0) {
            e.preventDefault();
            if (a === 'myloans') location.hash = '#/loans';
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
    document.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'scanFile') fileScan(e.target);
    });
    window.addEventListener('beforeunload', stopScanCam);
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
  restoreSession();
  YueDuDB.init().then(function () {
    renderAll();
    // 首页首次进入时给粒子一点轻微扰动，暗示可交互
    setTimeout(function () { if (InkFX) InkFX.burst(innerWidth * .28, innerHeight * .45, 6); }, 900);
  });
  setTimeout(function () { if (YueDuDB.state().mode === 'connecting') renderStatus(); }, 5200);
})();
