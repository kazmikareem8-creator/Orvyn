'use strict';
// ORVYN BRAIN server. No npm packages needed (Node 18+).
const http = require('http'), fs = require('fs'), path = require('path');

// Load .env (simple KEY=value lines)
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const E = process.env, PORT = +E.PORT || 3000, PUB = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname; // works with index.html next to server.js too
const CFG = {
  ai:  { key: E.ANTHROPIC_API_KEY, url: E.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', model: E.AI_MODEL || 'claude-sonnet-5-5' },
  img: { key: E.GEMINI_API_KEY, base: E.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta', model: E.IMAGE_MODEL || 'gemini-2.5-flash-image', txt: E.TEXT_MODEL || 'gemini-2.5-flash' },
  vid: { key: E.VIDEO_API_KEY, base: E.VIDEO_BASE || 'https://api.muapi.ai/api/v1', path: E.VIDEO_PATH || '/gemini-omni-flash-1-1' }
};
const CODE = E.ACCESS_CODE || '';

const send = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const readBody = req => new Promise((ok, no) => {
  let d = '', n = 0;
  req.on('data', c => { n += c.length; if (n > 2e6) { no(new Error('Request too large')); req.destroy(); } else d += c; });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new Error('Bad JSON')); } });
});

// Tiny per-IP rate limiter so a stranger can't run up your bill
const hits = new Map();
function allow(ip, k, max, ms) {
  const key = ip + k, now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(now); hits.set(key, a); return true;
}

function findUrl(o, loose) {
  if (typeof o === 'string') {
    if (!/^https?:\/\/\S+$/.test(o)) return null;
    return loose || /\.(mp4|webm|mov)(\?|$)/i.test(o) ? o : null;
  }
  if (o && typeof o === 'object') for (const k in o) { const r = findUrl(o[k], loose); if (r) return r; }
  return null;
}

const vh = () => ({ 'Authorization': 'Bearer ' + CFG.vid.key, 'x-api-key': CFG.vid.key, 'Content-Type': 'application/json' });
const asp = a => (a === '9:16' || a === '16:9' || a === '1:1') ? a : '1:1';

async function api(req, res, p) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'x';
  if (p === '/api/health') return send(res, 200, { ai: !!(CFG.ai.key || CFG.img.key), image: !!CFG.img.key, video: !!CFG.vid.key, needsCode: !!CODE });
  if (CODE && req.headers['x-access-code'] !== CODE) return send(res, 401, { error: 'Access code required' });

  if (p === '/api/ai' && req.method === 'POST') {
    if (!CFG.ai.key && !CFG.img.key) return send(res, 503, { error: 'Set GEMINI_API_KEY (or ANTHROPIC_API_KEY) on the server' });
    if (!allow(ip, 'ai', 30, 60e3)) return send(res, 429, { error: 'Too many requests, slow down' });
    const b = await readBody(req);
    const messages = (b.messages || []).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-30);
    if (!messages.length) return send(res, 400, { error: 'No messages' });
    if (!CFG.ai.key) { // no Anthropic key: use the free Gemini key for text too
      const g = await fetch(`${CFG.img.base}/models/${CFG.img.txt}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': CFG.img.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) }) });
      const gj = await g.json().catch(() => ({}));
      if (!g.ok) return send(res, 502, { error: gj.error?.message || 'AI request failed' });
      return send(res, 200, { text: (gj.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('') });
    }
    const r = await fetch(CFG.ai.url, { method: 'POST', headers: { 'x-api-key': CFG.ai.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: CFG.ai.model, max_tokens: 2000, messages }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: j.error?.message || 'AI request failed' });
    return send(res, 200, { text: (j.content || []).map(c => c.text || '').join('') });
  }

  if (p === '/api/image' && req.method === 'POST') {
    if (!CFG.img.key) return send(res, 503, { error: 'GEMINI_API_KEY is not set on the server' });
    if (!allow(ip, 'img', 15, 3600e3)) return send(res, 429, { error: 'Image limit reached for this hour' });
    const b = await readBody(req), prompt = String(b.prompt || '').slice(0, 1500);
    if (!prompt) return send(res, 400, { error: 'Describe the image first' });
    const full = `${prompt}\n\nStyle: ${String(b.style || 'photorealistic').slice(0, 40)}. ${b.quality === 'Ultra' ? 'Ultra-detailed, highest quality. ' : ''}Aspect ratio ${asp(b.aspect)}.`;
    const r = await fetch(`${CFG.img.base}/models/${CFG.img.model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': CFG.img.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: full }] }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: j.error?.message || 'Image request failed' });
    const part = (j.candidates?.[0]?.content?.parts || []).find(x => x.inlineData || x.inline_data), d = part && (part.inlineData || part.inline_data);
    if (!d) return send(res, 502, { error: 'The model returned no image (it may have declined that prompt)' });
    return send(res, 200, { image: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}` });
  }

  if (p === '/api/video' && req.method === 'POST') {
    if (!CFG.vid.key) return send(res, 503, { error: 'VIDEO_API_KEY is not set on the server' });
    if (!allow(ip, 'vid', 4, 3600e3)) return send(res, 429, { error: 'Video limit reached for this hour' });
    const b = await readBody(req), prompt = String(b.prompt || '').slice(0, 1500);
    if (!prompt) return send(res, 400, { error: 'Describe the scene first' });
    const r = await fetch(CFG.vid.base + CFG.vid.path, { method: 'POST', headers: vh(), body: JSON.stringify({ prompt, duration: Math.min(10, Math.max(3, +b.duration || 6)), resolution: '720p', aspect_ratio: b.aspect === '9:16' ? '9:16' : '16:9' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: j.error?.message || j.error || j.message || j.detail || 'Video request failed' });
    const id = j.request_id || j.id;
    if (!id) return send(res, 502, { error: 'Video provider returned no job id' });
    return send(res, 200, { id: String(id) });
  }

  const m = p.match(/^\/api\/video\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    if (!CFG.vid.key) return send(res, 503, { error: 'VIDEO_API_KEY is not set on the server' });
    const r = await fetch(`${CFG.vid.base}/predictions/${m[1]}/result`, { headers: vh() });
    const j = await r.json().catch(() => ({})), st = String(j.status || '').toLowerCase();
    if (!r.ok) return send(res, 502, { error: j.error || j.message || 'Status check failed' });
    if (['failed', 'error', 'cancelled'].includes(st)) return send(res, 200, { status: 'failed', error: String(j.error || 'Video generation failed') });
    if (['completed', 'succeeded', 'success', 'done'].includes(st)) {
      const u = findUrl(j) || findUrl(j, true);
      return u ? send(res, 200, { status: 'done', url: u }) : send(res, 200, { status: 'failed', error: 'Finished but no video URL was returned' });
    }
    return send(res, 200, { status: 'pending' });
  }
  return send(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/api/')) return await api(req, res, p);
    const rel = p === '/' ? '/index.html' : p;
    if (PUB === __dirname && rel !== '/index.html') { res.writeHead(404); return res.end('Not found'); } // never serve server.js or .env
    const f = path.join(PUB, path.normalize(rel));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { send(res, 500, { error: e.message || 'Server error' }); }
}).listen(PORT, () => console.log('ORVYN BRAIN running on http://localhost:' + PORT));
