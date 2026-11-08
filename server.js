/* 悦读 · 数字藏书楼 —— 静态托管 + 视觉识别 API 代理
 * 启动：node server.js（或 npm start）
 * 静态站点可直接双击打开 / 任意静态服务器托管；
 * 「我的借阅 → 扫码借还」的标签识别走 /api/vision 代理（隐藏密钥、规避浏览器 CORS）。
 * 密钥优先读环境变量 HUNYUAN_KEY，未设置时使用内置默认。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const KEY = process.env.HUNYUAN_KEY || 'mTIUaeYu2TEGcTDu7eFb628a25484b76Bc052d5971D81c5d';
const MODEL = process.env.HUNYUAN_MODEL || 'hunyuan-vision';
const UPSTREAM = process.env.HUNYUAN_URL || 'https://tcamp.qq.com/openai/chat/completions';
const ROOT = __dirname;

const LABEL_PROMPT = '这是图书馆图书标签的照片。标签上通常印有书名（可能带书名号《》），并可能标注状态文字（如"借阅""借出""归还""还书""在库"）。请识别图片内容，只返回一个 JSON 对象，不要任何解释文字或 markdown 代码块，格式：{"title":"识别出的书名，不含书名号","status":"标签上的状态文字，没有则为空字符串","confidence":"high或medium或low"}';

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
        if (!image) throw new Error('缺少图片数据');
        const dataUrl = image.startsWith('data:') ? image : 'data:image/jpeg;base64,' + image;
        const r = await fetch(UPSTREAM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt || LABEL_PROMPT },
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
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message || '识别服务暂不可用' }));
      }
    });
    return;
  }

  /* ---- 静态文件（禁止源码/密钥外泄） ---- */
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
