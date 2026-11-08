/* 悦读 · 数字藏书楼 —— 静态托管 + 视觉识别 API 代理（云端识别的本地回退）
 * 启动：node server.js（或 npm start）
 * 登录注册已迁移至 WorkBuddy 云服务 Auth（手机验证码，见 assets/js/app.js），
 * 图书识别优先走云服务内置视觉大模型；本服务的 /api/vision 作为离线回退。
 * 密钥优先读环境变量 HUNYUAN_KEY，未设置时使用内置默认。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

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

  /* ---- 静态文件（禁止源码/密钥/用户数据外泄） ---- */
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
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
