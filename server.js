'use strict';
// Сервер онлайн-рынка. Без зависимостей, нужен только Node 18+.  Запуск: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const GAME = process.env.GAME_FILE || path.join(__dirname, 'rynok-telefony-v5-16-online.html');

let db = { list: {} };
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); if (!db.list) db.list = {}; } catch (e) {}
let saveT = null;
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(DATA + '.tmp', JSON.stringify(db), e => { if (!e) fs.rename(DATA + '.tmp', DATA, () => {}); }), 400); };

// pid (секрет игрока) никогда не рассылается; наружу идёт только его хэш
const pub = pid => crypto.createHash('sha256').update('bu:' + pid).digest('hex').slice(0, 12);
const view = () => Object.entries(db.list).map(([id, l]) => ({ id, seller: l.seller, ask: l.ask, item: l.item, ts: l.ts, sold: !!l.sold }));

const clients = new Set();
let bT = null;
const broadcast = () => { clearTimeout(bT); bT = setTimeout(() => { const s = 'data: ' + JSON.stringify(view()) + '\n\n'; clients.forEach(r => r.write(s)); persist(); }, 80); };
setInterval(() => clients.forEach(r => r.write(': ping\n\n')), 20000);

// чистим данные от других игроков: только числа/строки/массивы, без HTML-символов
function clean(v, d = 0) {
  if (d > 4) return undefined;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v === 'boolean' || v === null) return v;
  if (typeof v === 'string') return v.replace(/[<>&"'`\\]/g, '').slice(0, 160);
  if (Array.isArray(v)) return v.slice(0, 40).map(x => clean(x, d + 1)).filter(x => x !== undefined);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 60)) {
      if (!/^[A-Za-z0-9_]{1,24}$/.test(k) || k === '__proto__') continue;
      const c = clean(v[k], d + 1);
      if (c !== undefined) o[k] = c;
    }
    return o;
  }
  return undefined;
}

const hits = new Map();
setInterval(() => hits.clear(), 60000);
const J = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 20000) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); });

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,x-pid');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') return fs.readFile(GAME, (e, b) => { if (e) { res.writeHead(404); return res.end('Положите игру рядом с server.js: ' + path.basename(GAME)); } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(b); });
    if (p === '/api/market') return J(res, 200, { list: view() });
    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\ndata: ' + JSON.stringify(view()) + '\n\n');
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (p === '/healthz') return J(res, 200, { ok: 1 });
    res.writeHead(404); return res.end();
  }
  if (req.method !== 'POST' || !p.startsWith('/api/')) { res.writeHead(404); return res.end(); }

  const ip = req.socket.remoteAddress, n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
  if (n > 120) return J(res, 429, { error: 'Слишком часто, подождите минуту' });
  const pid = String(req.headers['x-pid'] || '');
  if (!/^[a-f0-9]{32}$/.test(pid)) return J(res, 401, { error: 'Нет игрока' });
  const me = pub(pid);
  let b; try { b = await body(req); } catch (e) { return J(res, 400, { error: 'Плохой запрос' }); }
  const [, , act, id] = p.split('/');

  if (act === 'hello') return J(res, 200, { pub: me });

  if (act === 'list') {
    const ask = Math.round(+b.ask), it = b.item;
    if (!(ask >= 1 && ask <= 1e7) || !it || typeof it !== 'object') return J(res, 400, { error: 'Неверная цена или телефон' });
    const item = clean(it);
    if (!/^[A-Za-z0-9_]{1,30}$/.test(item.m || '') || !(item.cond >= 1 && item.cond <= 9) || !(item.batt >= 0 && item.batt <= 100) || !Number.isInteger(item.ci) || item.ci < 0 || item.ci > 9 || JSON.stringify(item).length > 8000) return J(res, 400, { error: 'Неверные данные телефона' });
    const all = Object.values(db.list);
    if (all.length >= 3000) return J(res, 503, { error: 'Рынок переполнен' });
    if (all.filter(l => l.seller === me && !l.sold).length >= 30) return J(res, 400, { error: 'Не больше 30 объявлений сразу' });
    const lid = 'l' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    db.list[lid] = { seller: me, ask, item, ts: Date.now(), sold: false };
    broadcast(); return J(res, 200, { id: lid });
  }

  const l = db.list[id];
  if (!l) return J(res, 404, { error: 'Объявление не найдено' });
  if (act === 'buy') {
    if (l.sold) return J(res, 409, { error: 'Уже купил другой игрок' });
    if (l.seller === me) return J(res, 400, { error: 'Это ваше объявление' });
    l.sold = true; l.buyer = me; broadcast();
    return J(res, 200, { ask: l.ask, item: l.item });
  }
  if (act === 'cancel') {
    if (l.seller !== me) return J(res, 403, { error: 'Не ваше объявление' });
    if (l.sold) return J(res, 409, { error: 'Уже куплено' });
    delete db.list[id]; broadcast(); return J(res, 200, { item: l.item });
  }
  if (act === 'payout') {
    if (l.seller !== me) return J(res, 403, { error: 'Не ваше объявление' });
    if (!l.sold) return J(res, 409, { error: 'Ещё не куплено' });
    delete db.list[id]; broadcast(); return J(res, 200, { ask: l.ask });
  }
  J(res, 404, { error: 'Неизвестное действие' });
}).listen(PORT, () => console.log('Онлайн-рынок: http://localhost:' + PORT));
