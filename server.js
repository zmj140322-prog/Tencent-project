/* 悦读 · 数字藏书楼 —— 静态托管 + 视觉识别 API 代理
 * 启动：node server.js（或 npm start）
 * 静态站点可直接双击打开 / 任意静态服务器托管；
 * 「我的借阅 → 扫码借还」的标签识别走 /api/vision 代理（隐藏密钥、规避浏览器 CORS）。
 * 密钥优先读环境变量 HUNYUAN_KEY，未设置时使用内置默认。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const KEY = process.env.HUNYUAN_KEY || 'mTIUaeYu2TEGcTDu7eFb628a25484b76Bc052d5971D81c5d';
const MODEL = process.env.HUNYUAN_MODEL || 'hunyuan-vision';
const UPSTREAM = process.env.HUNYUAN_URL || 'https://tcamp.qq.com/openai/chat/completions';
const ROOT = __dirname;

/* 兜底识别提示词：客户端未传 prompt 时使用；覆盖 标签 / 封面 / 书脊 三种拍摄对象 */
const BOOK_PROMPT = '这是一张图书馆相关的照片，可能是：①图书标签（印有书名与状态文字如"借阅""归还"）；②图书封面；③书脊。请识别照片中最清晰、最居中的一本书的书名。只返回一个 JSON 对象，不要任何解释文字或 markdown 代码块，格式：{"title":"识别出的书名，不含书名号","source":"label或cover或spine","status":"标签状态文字，没有则为空字符串","confidence":"high或medium或low"}';

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};

/* =============================================================
 * 用户认证（双身份：管理者 admin / 读者 reader）
 * 存储：data/users.json（sha256(salt+密码) 哈希，不存明文）
 * 会话：HMAC-SHA256 签名 token（7 天有效，重启服务不掉线）
 * 首次启动自动创建管理员账号 admin / admin123
 * ============================================================= */
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'auth-secret.key');
const TOKEN_TTL = 7 * 24 * 3600 * 1000;

function ensureAuthData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), 'utf8');
  if (!fs.existsSync(USERS_FILE)) {
    const salt = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [{
      username: 'admin', nickname: '馆长', role: 'admin',
      salt: salt, hash: hashPwd('admin123', salt), createdAt: Date.now()
    }] }, null, 2), 'utf8');
    console.log('[auth] 已创建默认管理员账号：admin / admin123（请登录后在右上角修改密码）');
  }
}
function hashPwd(pwd, salt) { return crypto.createHash('sha256').update(salt + ':' + pwd).digest('hex'); }
function readUsers() { try { return (JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users) || []; } catch (e) { return []; } }
function writeUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify({ users: users }, null, 2), 'utf8'); }
function secret() { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); }
function b64url(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
function sign(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function issueToken(u) {
  const payload = b64url(JSON.stringify({ u: u.username, r: u.role, n: u.nickname, exp: Date.now() + TOKEN_TTL }));
  return payload + '.' + sign(payload);
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  var i = token.lastIndexOf('.');
  if (i <= 0) return null;
  var payload = token.slice(0, i), sig = token.slice(i + 1);
  var expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    var data = JSON.parse(unb64url(payload));
    if (!data.u || Date.now() > data.exp) return null;
    var u = readUsers().find(function (x) { return x.username === data.u; });
    if (!u) return null;
    return { username: u.username, nickname: u.nickname, role: u.role };
  } catch (e) { return null; }
}
function publicUser(u) { return { username: u.username, nickname: u.nickname, role: u.role }; }

function readBody(req) {
  return new Promise(function (resolve) {
    var body = '';
    req.on('data', function (c) { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', function () { resolve(body); });
  });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleAuth(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/auth/me') {
    var user = verifyToken(url.searchParams.get('token') || '');
    return user ? json(res, 200, { ok: true, user: user }) : json(res, 401, { ok: false, error: '登录状态已过期，请重新登录' });
  }
  if (req.method === 'POST' && (p === '/api/auth/login' || p === '/api/auth/register' || p === '/api/auth/password')) {
    var body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { /* 保持空对象 */ }
    var users = readUsers();

    if (p === '/api/auth/register') {
      var username = String(body.username || '').trim();
      var password = String(body.password || '');
      var nickname = String(body.nickname || '').trim() || username;
      if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,20}$/.test(username))
        return json(res, 400, { ok: false, error: '用户名须为 2–20 位中文、字母、数字或下划线' });
      if (password.length < 6) return json(res, 400, { ok: false, error: '密码至少 6 位' });
      if (users.some(function (x) { return x.username === username; }))
        return json(res, 409, { ok: false, error: '该用户名已被注册' });
      var salt = crypto.randomBytes(8).toString('hex');
      var nu = { username: username, nickname: nickname.slice(0, 20), role: 'reader', salt: salt, hash: hashPwd(password, salt), createdAt: Date.now() };
      users.push(nu); writeUsers(users);
      return json(res, 200, { ok: true, token: issueToken(nu), user: publicUser(nu) });
    }

    if (p === '/api/auth/login') {
      var lu = users.find(function (x) { return x.username === String(body.username || '').trim(); });
      if (!lu || lu.hash !== hashPwd(String(body.password || ''), lu.salt))
        return json(res, 401, { ok: false, error: '用户名或密码不正确' });
      return json(res, 200, { ok: true, token: issueToken(lu), user: publicUser(lu) });
    }

    /* 修改密码：须携带有效 token */
    var mu = verifyToken(body.token || '');
    if (!mu) return json(res, 401, { ok: false, error: '请先登录' });
    var target = users.find(function (x) { return x.username === mu.username; });
    if (!target || target.hash !== hashPwd(String(body.oldPassword || ''), target.salt))
      return json(res, 401, { ok: false, error: '原密码不正确' });
    if (String(body.newPassword || '').length < 6) return json(res, 400, { ok: false, error: '新密码至少 6 位' });
    target.salt = crypto.randomBytes(8).toString('hex');
    target.hash = hashPwd(String(body.newPassword), target.salt);
    writeUsers(users);
    return json(res, 200, { ok: true, message: '密码已修改' });
  }
  return json(res, 404, { ok: false, error: '接口不存在' });
}

ensureAuthData();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  /* ---- 视觉识别代理（扫码借还） ---- */
  if (url.pathname === '/api/vision' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 15e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { image, prompt } = JSON.parse(body || '{}');
        if (!image) { const e = new Error('缺少图片数据'); e.status = 400; throw e; }
        if (!KEY) { const e = new Error('服务端未配置识别密钥（HUNYUAN_KEY）'); e.status = 500; throw e; }
        const dataUrl = image.startsWith('data:') ? image : 'data:image/jpeg;base64,' + image;
        const r = await fetch(UPSTREAM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt || BOOK_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]}]
          })
        });
        const data = await r.json().catch(() => ({}));
        const content = data && data.choices && data.choices[0] && data.choices[0].message
          && data.choices[0].message.content;
        if (!content) {
          const msg = (data.error && data.error.message) || ('上游响应异常 HTTP ' + r.status);
          throw new Error(msg);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, content }));
      } catch (err) {
        res.writeHead(err && err.status || 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message || '识别服务暂不可用' }));
      }
    });
    return;
  }

  /* ---- 用户认证 API（登录 / 注册 / 会话 / 改密） ---- */
  if (url.pathname.startsWith('/api/auth/')) {
    try { return await handleAuth(req, res, url); }
    catch (err) { return json(res, 500, { ok: false, error: err.message || '认证服务异常' }); }
  }

  /* ---- 静态文件（禁止源码/密钥/用户数据外泄） ---- */
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p.startsWith('/data/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(ROOT) || /(^|[\/\\])server\.js$/.test(file) || /[\/\\]\./.test(p)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('悦读 · 数字藏书楼 listening on port ' + PORT));
