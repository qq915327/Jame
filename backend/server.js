'use strict';
/**
 * VKM 演示交易所 · 后端服务
 * 零依赖：仅使用 Node 内置模块（node:http / node:fs / node:crypto）
 * 数据：data/db.json 持久化用户、余额、委托、持仓
 * 职责：账号鉴权、资金托管、现货市价/限价成交、U 本位永续开平仓、强平、管理后台
 * 注意：本服务仅为前端演示配套，不含真实入金出金与真实撮合，禁止用于实际业务
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
// 数据目录：优先用 DATA_DIR（容器挂载卷），否则用 backend/data
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PAGE = path.join(ROOT, '..', '虚拟货币交易网站-云端版.html');
const PAGE_B64 = path.join(ROOT, '..', 'page.html.gz.b64');  // 页面不存在时的压缩备份
const PORT = Number(process.env.PORT || 8787);
const FEE = 0.0005;   // 开/平仓手续费率
const MMR = 0.005;    // 维持保证金率

/* 站点访问口令：设置 SITE_CODE 后，未验证的访客只能看到口令页 */
const SITE_CODE = String(process.env.SITE_CODE || '');
const GATE_COOKIE = 'vkm_gate';
const GATE_MAX_AGE = 7 * 24 * 3600;
const gateSign = () => crypto.createHmac('sha256', 'vkm-gate-v1').update(SITE_CODE).digest('hex').slice(0, 32);
const tokenSign = t => crypto.createHmac('sha256', 'vkm-token-v1').update(String(t)).digest('hex').slice(0, 32);

/* 密码哈希：scrypt(salt) ，兼容历史明文密码并在登录时自动升级 */
function hashPwd(pwd, salt = crypto.randomBytes(16).toString('hex')) {
  return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pwd), salt, 32).toString('hex');
}
function verifyPwd(pwd, stored) {
  if (!stored) return false;
  if (String(stored).startsWith('scrypt$')) {
    const [, salt, h] = String(stored).split('$');
    const calc = crypto.scryptSync(String(pwd), salt, 32).toString('hex');
    try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(calc, 'hex')); } catch (e) { return false; }
  }
  return String(stored) === String(pwd);
}

const PAIRS = [
  { sym: 'BTC/USDT',  asset: 'BTC',  gate: 'BTC_USDT'  },
  { sym: 'ETH/USDT',  asset: 'ETH',  gate: 'ETH_USDT'  },
  { sym: 'SOL/USDT',  asset: 'SOL',  gate: 'SOL_USDT'  },
  { sym: 'BNB/USDT',  asset: 'BNB',  gate: 'BNB_USDT'  },
  { sym: 'XRP/USDT',  asset: 'XRP',  gate: 'XRP_USDT'  },
  { sym: 'DOGE/USDT', asset: 'DOGE', gate: 'DOGE_USDT' },
  { sym: 'AVAX/USDT', asset: 'AVAX', gate: 'AVAX_USDT' },
  { sym: 'LINK/USDT', asset: 'LINK', gate: 'LINK_USDT' }
];
const pairOf = sym => PAIRS.find(p => p.sym === sym);

/* 页面读取：优先读明文文件，其次读 gzip+base64 备份（适配只提交备份的仓库） */
let PAGE_CACHE = null;
function pageHtml() {
  if (PAGE_CACHE) return PAGE_CACHE;
  try { PAGE_CACHE = fs.readFileSync(PAGE, 'utf8'); return PAGE_CACHE; } catch (e) { /* 继续尝试备份 */ }
  try {
    const b64 = fs.readFileSync(PAGE_B64, 'utf8').replace(/\s+/g, '');
    PAGE_CACHE = require('node:zlib').gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
    return PAGE_CACHE;
  } catch (e) { return null; }
}

/* ---------------- 数据层 ---------------- */
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const r8 = n => Math.round((Number(n) || 0) * 1e8) / 1e8;
const pad2 = n => String(n).padStart(2, '0');
function nowStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function seed() {
  return {
    users: [
      { id: 'u_admin', name: 'admin', email: 'admin@vkm.io', pwd: hashPwd('admin123'), role: 'admin',
        usdt: 100000, coins: {}, frozen: false, createdAt: nowStr() },
      { id: 'u_1', name: '张伟', email: 'zhangwei@vkm.io', pwd: hashPwd('123456'), role: 'user',
        usdt: 5820.4, coins: { BTC: 0.0421, ETH: 0.8 }, frozen: false, createdAt: nowStr() },
      { id: 'u_2', name: '李娜', email: 'lina@vkm.io', pwd: hashPwd('123456'), role: 'user',
        usdt: 1280, coins: { SOL: 6.2 }, frozen: false, createdAt: nowStr() }
    ],
    orders: [], corders: [], positions: [], logs: [], sessions: {}, seq: 1
  };
}

let DB = load();
function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return Object.assign(seed(), parsed);
    }
  } catch (e) {
    console.error('[db] 读取失败，使用初始数据', e.message);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fresh = seed();
  fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
  return fresh;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('[db] 写入失败', e.message); }
  }, 30);
}
const nextId = () => { DB.seq = (DB.seq || 1) + 1; return DB.seq; };
const findUser = id => DB.users.find(u => u.id === id) || null;
const byEmail = email => DB.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase()) || null;
const pub = u => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, usdt: r2(u.usdt), coins: u.coins || {}, frozen: !!u.frozen, createdAt: u.createdAt });
const coinOf = (u, asset) => Number((u.coins || {})[asset] || 0);

/* ---------------- 行情 ---------------- */
const MARKS = {};   // sym -> 最新标记价
async function getJson(url, ms = 4500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'vkm-demo/1.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function refreshMarks() {
  const tasks = PAIRS.map(async p => {
    try {
      const t = await getJson(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${p.gate.replace('_', '_')}`);
      const last = Number((t && t[0] && t[0].last) || 0);
      if (last > 0) MARKS[p.sym] = last;
    } catch (e) {
      try {
        const s = await getJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${p.gate}`);
        const last = Number((s && s[0] && s[0].last) || 0);
        if (last > 0) MARKS[p.sym] = last;
      } catch (e2) { /* 行情源不可用则沿用上次价格 */ }
    }
  });
  await Promise.all(tasks);
}
const markOf = sym => MARKS[sym] || 0;

/* ---------------- 交易引擎 ---------------- */
const liqPrice = p => p.dir === 'long' ? p.entry * (1 - 1 / p.lev + MMR) : p.entry * (1 + 1 / p.lev - MMR);
const posPnl = p => { const mk = markOf(p.sym) || p.entry; return (mk - p.entry) * (p.dir === 'long' ? 1 : -1) * p.qty; };

function engineTick() {
  // 1) 现货限价成交
  let changed = false;
  for (const o of DB.orders) {
    if (o.status !== 'open' || o.type !== 'limit') continue;
    const mk = markOf(o.sym);
    if (!mk) continue;
    const hit = o.side === 'buy' ? mk <= o.px : mk >= o.px;
    if (!hit) continue;
    const u = findUser(o.uid); if (!u) continue;
    const fillPx = o.px;
    if (o.side === 'buy') {
      const cost = r2(fillPx * o.amt);
      if (cost > u.usdt) continue;
      u.usdt = r2(u.usdt - cost);
      u.coins[o.asset] = r8(coinOf(u, o.asset) + o.amt);
      o.freezeUsdt = 0;
    } else {
      if (o.freezeCoin > coinOf(u, o.asset)) continue;
      u.coins[o.asset] = r8(coinOf(u, o.asset) - o.freezeCoin);
      u.usdt = r2(u.usdt + r2(fillPx * o.amt));
      o.freezeCoin = 0;
    }
    o.status = 'filled';
    o.filled = o.amt;
    o.time = nowStr();
    changed = true;
  }

  // 2) 合约限价委托成交
  for (const o of DB.corders) {
    if (o.status !== 'open') continue;
    const mk = markOf(o.sym); if (!mk) continue;
    const hit = o.dir === 'long' ? mk <= o.px : mk >= o.px;
    if (!hit) continue;
    o.status = 'filled';
    DB.positions.unshift({ id: 'pos' + nextId(), uid: o.uid, sym: o.sym, dir: o.dir, lev: o.lev,
      qty: o.qty, entry: o.px, margin: o.margin, openedAt: nowStr() });
    changed = true;
  }

  // 3) 强平
  for (const p of [...DB.positions]) {
    const mk = markOf(p.sym); if (!mk) continue;
    const lp = liqPrice(p);
    const hit = (p.dir === 'long' && mk <= lp) || (p.dir === 'short' && mk >= lp);
    if (!hit) continue;
    closePos(p.id, true);
    changed = true;
  }

  if (changed) save();
}

function closePos(pid, force) {
  const p = DB.positions.find(x => x.id === pid);
  if (!p) return null;
  const u = findUser(p.uid);
  const pnl = posPnl(p);
  const fee = force ? 0 : p.qty * (markOf(p.sym) || p.entry) * FEE;
  const back = Math.max(0, r2(p.margin + pnl - fee));
  if (u) u.usdt = r2(u.usdt + back);
  DB.positions = DB.positions.filter(x => x.id !== pid);
  save();
  return { pnl: r2(pnl), back, sym: p.sym, dir: p.dir, liq: !!force };
}

/* ---------------- 工具 ---------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
const ok = (res, data = {}) => send(res, 200, Object.assign({ ok: true }, data));
const fail = (res, msg, code = 400) => send(res, code, { ok: false, error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}
function tokenOf(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : '';
}
const SESSION_TTL = 7 * 24 * 3600 * 1000;
function sessionOf(token) {
  const s = token && DB.sessions[token];
  if (!s) return null;
  const rec = typeof s === 'string' ? { uid: s, at: Date.now() } : s;
  if (rec.at && Date.now() - rec.at > SESSION_TTL) { delete DB.sessions[token]; return null; }
  return rec.uid;
}
function auth(req) {
  const uid = sessionOf(tokenOf(req));
  return uid ? findUser(uid) : null;
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function gateOk(req) {
  if (!SITE_CODE) return true;
  const raw = String(req.headers.cookie || '');
  const m = new RegExp(GATE_COOKIE + '=([^;]+)').exec(raw);
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(gateSign());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function gatePage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要访问口令 · VKM</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:grid;place-items:center;background:#0b0e11;color:#eaecef;
font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{width:min(380px,92vw);background:#12161c;border:1px solid #1f2733;border-radius:14px;padding:28px 24px}
.logo{font-size:20px;font-weight:700;letter-spacing:-.5px;margin-bottom:6px}
.tip{font-size:12.5px;color:#76808f;line-height:1.6;margin-bottom:18px}
input{width:100%;height:44px;border-radius:8px;border:1px solid #1f2733;background:#0b0e11;
color:#eaecef;padding:0 12px;font-size:14px;outline:none}
input:focus{border-color:#4a5a70}
button{width:100%;height:44px;margin-top:12px;border:0;border-radius:8px;background:#eaecef;
color:#0b0e11;font-size:14px;font-weight:600;cursor:pointer}
button:active{opacity:.85}
.err{min-height:18px;margin-top:10px;font-size:12.5px;color:#f6465d}
</style></head><body>
<div class="card">
  <div class="logo">vkm</div>
  <div class="tip">该站点为受限演示环境，请输入访问口令后继续。</div>
  <input id="code" placeholder="访问口令" autocomplete="off">
  <button id="go">进入</button>
  <div class="err" id="err"></div>
</div>
<script>
document.getElementById('go').addEventListener('click', async ()=>{
  const code = document.getElementById('code').value.trim();
  const err = document.getElementById('err');
  if(!code){ err.textContent='请输入口令'; return; }
  err.textContent='';
  try{
    const r = await fetch('/api/gate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const d = await r.json();
    if(d.ok){ location.reload(); } else { err.textContent = d.error || '口令错误'; }
  }catch(e){ err.textContent='网络异常，请重试'; }
});
document.getElementById('code').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('go').click(); });
</script>
</body></html>`;
}

/* ---------------- 接口 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '') || '/';
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return send(res, 204, {});

  /* 访问口令 */
  if (p === '/gate' && method === 'POST') {
    const b = await readBody(req);
    const code = String(b.code || '');
    if (!SITE_CODE) return ok(res, { message: '未启用访问口令' });
    if (code !== SITE_CODE) return fail(res, '口令错误', 403);
    res.setHeader('Set-Cookie', `${GATE_COOKIE}=${gateSign()}; Path=/; Max-Age=${GATE_MAX_AGE}; HttpOnly; SameSite=Lax`);
    return ok(res, { message: '口令验证通过' });
  }

  /* 注册 */
  if (p === '/register' && method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), pwd = String(b.pwd || '');
    if (name.length < 2) return fail(res, '昵称至少 2 个字符');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, '请输入有效邮箱');
    if (pwd.length < 6) return fail(res, '密码至少 6 位');
    if (byEmail(email)) return fail(res, '该邮箱已注册');
    const u = { id: 'u' + nextId(), name, email, pwd: hashPwd(pwd), role: 'user', usdt: 0, coins: {}, frozen: false, createdAt: nowStr() };
    DB.users.push(u);
    const token = newToken(); DB.sessions[token] = { uid: u.id, at: Date.now() };
    save();
    return ok(res, { token, user: pub(u), message: '注册成功，余额为 0，可由管理员充值' });
  }

  /* 登录 */
  if (p === '/login' && method === 'POST') {
    const b = await readBody(req);
    const u = byEmail(b.email);
    if (!u || !verifyPwd(String(b.pwd || ''), u.pwd)) return fail(res, '邮箱或密码错误', 401);
    if (!String(u.pwd).startsWith('scrypt$')) { u.pwd = hashPwd(b.pwd); save(); }  // 历史明文密码自动升级
    if (u.frozen) return fail(res, '该账户已被冻结，请联系管理员', 403);
    const token = newToken(); DB.sessions[token] = { uid: u.id, at: Date.now() }; save();
    return ok(res, { token, user: pub(u), message: '已登录：' + u.name });
  }

  /* 登出 */
  if (p === '/logout' && method === 'POST') {
    delete DB.sessions[tokenOf(req)]; save();
    return ok(res, { message: '已退出登录' });
  }

  if (SITE_CODE && !gateOk(req)) return fail(res, '需要访问口令，请刷新页面重新验证', 401);

  const user = auth(req);

  /* 状态同步：登录用户返回自己的委托/持仓；管理员额外返回用户表与操作日志 */
  if (p === '/state' && method === 'GET') {
    if (!user) return fail(res, '未登录', 401);
    const mine = {
      orders: DB.orders.filter(o => o.uid === user.id).map(o => ({ ...o, pxTxt: o.type === 'market' ? '市价' : o.px })),
      corders: DB.corders.filter(o => o.uid === user.id && o.status === 'open'),
      positions: DB.positions.filter(x => x.uid === user.id).map(x => ({ ...x, mark: markOf(x.sym), pnl: r2(posPnl(x)), liq: liqPrice(x) })),
      user: pub(user)
    };
    if (user.role === 'admin') {
      mine.users = DB.users.map(pub);
      mine.logs = DB.logs.slice(0, 60);
      mine.allOrders = DB.orders.slice(0, 60);
    }
    return ok(res, Object.assign(mine, { marks: MARKS, fee: FEE, mmr: MMR }));
  }

  /* 行情快照（服务端代理，规避浏览器跨域限制） */
  if (p === '/markets' && method === 'GET') {
    return ok(res, { marks: MARKS });
  }

  if (!user) return fail(res, '未登录', 401);

  /* 现货下单 */
  if (p === '/spot/orders' && method === 'POST') {
    if (user.frozen) return fail(res, '账户已冻结，无法交易');
    const b = await readBody(req);
    const pair = pairOf(b.sym);
    if (!pair) return fail(res, '不支持的交易对');
    const amt = Number(b.amt), mk = markOf(b.sym);
    if (!(amt > 0)) return fail(res, '请输入有效数量');
    if (!mk) return fail(res, '行情尚未就绪，请稍后重试');
    const type = b.type === 'market' ? 'market' : 'limit';
    const px = type === 'market' ? mk : Number(b.px);
    if (!(px > 0)) return fail(res, '请输入有效价格');
    const total = r2(px * amt);
    const o = { id: nextId(), uid: user.id, sym: b.sym, asset: pair.asset, side: b.side === 'sell' ? 'sell' : 'buy',
      type, px, amt: r8(amt), filled: 0, status: 'open', time: nowStr(), freezeUsdt: 0, freezeCoin: 0 };

    if (o.side === 'buy') {
      if (type === 'market') {
        if (total > user.usdt) return fail(res, '可用 USDT 不足，请先充值');
        user.usdt = r2(user.usdt - total);
        user.coins[o.asset] = r8(coinOf(user, o.asset) + amt);
        o.status = 'filled'; o.filled = o.amt;
      } else {
        if (total > user.usdt) return fail(res, '可用 USDT 不足，请先充值');
        user.usdt = r2(user.usdt - total);
        o.freezeUsdt = total;
      }
    } else {
      if (type === 'market') {
        if (amt > coinOf(user, o.asset)) return fail(res, `可用 ${o.asset} 不足`);
        user.coins[o.asset] = r8(coinOf(user, o.asset) - amt);
        user.usdt = r2(user.usdt + total);
        o.status = 'filled'; o.filled = o.amt;
      } else {
        if (amt > coinOf(user, o.asset)) return fail(res, `可用 ${o.asset} 不足`);
        user.coins[o.asset] = r8(coinOf(user, o.asset) - amt);
        o.freezeCoin = amt;
      }
    }
    DB.orders.unshift(o); save();
    return ok(res, { order: o, user: pub(user), message: o.status === 'filled'
      ? `${o.side === 'buy' ? '买入' : '卖出'}成交 · ${o.amt} ${o.asset} @ ${px}`
      : `委托已挂出 · ${o.amt} ${o.asset}，资金已冻结` });
  }

  /* 撤销单笔 */
  const mCancel = /^\/spot\/orders\/(\d+)\/cancel$/.exec(p);
  if (mCancel && method === 'POST') {
    const o = DB.orders.find(x => x.id === Number(mCancel[1]) && x.uid === user.id);
    if (!o || o.status !== 'open') return fail(res, '委托不存在或已成交');
    if (o.freezeUsdt) { user.usdt = r2(user.usdt + o.freezeUsdt); o.freezeUsdt = 0; }
    if (o.freezeCoin) { user.coins[o.asset] = r8(coinOf(user, o.asset) + o.freezeCoin); o.freezeCoin = 0; }
    o.status = 'canceled'; save();
    return ok(res, { user: pub(user), message: '已撤销委托，冻结资金退回余额' });
  }

  /* 撤销全部 */
  if (p === '/spot/orders/cancel-all' && method === 'POST') {
    let n = 0;
    DB.orders.filter(o => o.uid === user.id && o.status === 'open').forEach(o => {
      if (o.freezeUsdt) { user.usdt = r2(user.usdt + o.freezeUsdt); o.freezeUsdt = 0; }
      if (o.freezeCoin) { user.coins[o.asset] = r8(coinOf(user, o.asset) + o.freezeCoin); o.freezeCoin = 0; }
      o.status = 'canceled'; n++;
    });
    save();
    return ok(res, { count: n, user: pub(user), message: n ? `已撤销 ${n} 笔委托` : '当前没有可撤销的委托' });
  }

  /* 合约开仓 */
  if (p === '/contract/open' && method === 'POST') {
    if (user.frozen) return fail(res, '账户已冻结，无法交易');
    const b = await readBody(req);
    const pair = pairOf(b.sym); if (!pair) return fail(res, '不支持的合约');
    const margin = Number(b.margin), lev = Math.min(100, Math.max(1, Number(b.lev) || 1));
    if (!(margin > 0)) return fail(res, '请输入保证金金额');
    const mk = markOf(b.sym); if (!mk) return fail(res, '合约行情尚未就绪');
    const type = b.type === 'limit' ? 'limit' : 'market';
    const px = type === 'market' ? mk : Number(b.px);
    if (!(px > 0)) return fail(res, '请输入有效价格');
    if (type === 'limit') {
      const bad = b.dir === 'long' ? px > mk : px < mk;
      if (bad) return fail(res, b.dir === 'long' ? '开多限价需低于标记价' : '开空限价需高于标记价');
    }
    const notional = margin * lev, qty = r8(notional / px), fee = r2(notional * FEE), cost = r2(margin + fee);
    if (cost > user.usdt) return fail(res, '可用 USDT 不足，请先充值');
    user.usdt = r2(user.usdt - cost);
    const dir = b.dir === 'short' ? 'short' : 'long';
    if (type === 'limit') {
      DB.corders.unshift({ id: nextId(), uid: user.id, sym: b.sym, dir, type, px, qty, lev, margin, fee, status: 'open', time: nowStr() });
      save();
      return ok(res, { user: pub(user), message: `限价委托已挂出 · ${qty} ${pair.asset} @ ${px}` });
    }
    DB.positions.unshift({ id: 'pos' + nextId(), uid: user.id, sym: b.sym, dir, lev, qty, entry: px, margin, openedAt: nowStr() });
    save();
    return ok(res, { user: pub(user), message: `${dir === 'long' ? '开多' : '开空'} ${qty} ${pair.asset} · ${lev}x · 保证金 ${r2(margin)} USDT` });
  }

  /* 平仓 */
  const mClose = /^\/contract\/([^/]+)\/close$/.exec(p);
  if (mClose && method === 'POST') {
    const pid = decodeURIComponent(mClose[1]);
    const pos = DB.positions.find(x => x.id === pid && x.uid === user.id);
    if (!pos) return fail(res, '持仓不存在');
    const r = closePos(pid, false);
    return ok(res, { user: pub(user), message: `已平仓 ${r.sym} · 盈亏 ${r.pnl > 0 ? '+' : ''}${r.pnl.toFixed(2)} USDT`, result: r });
  }

  /* 撤销合约委托 */
  const mCCancel = /^\/contract\/orders\/(\d+)\/cancel$/.exec(p);
  if (mCCancel && method === 'POST') {
    const o = DB.corders.find(x => x.id === Number(mCCancel[1]) && x.uid === user.id);
    if (!o || o.status !== 'open') return fail(res, '委托不存在或已成交');
    user.usdt = r2(user.usdt + o.margin + o.fee);
    o.status = 'canceled'; save();
    return ok(res, { user: pub(user), message: '已撤销合约委托，保证金已退回' });
  }

  /* 后台：冻结/解冻 */
  const mFreeze = /^\/admin\/users\/([^/]+)\/freeze$/.exec(p);
  if (mFreeze && method === 'POST') {
    if (user.role !== 'admin') return fail(res, '需要管理员权限', 403);
    const t = findUser(decodeURIComponent(mFreeze[1]));
    if (!t) return fail(res, '用户不存在');
    t.frozen = !t.frozen; save();
    return ok(res, { users: DB.users.map(pub), message: `${t.name} ${t.frozen ? '已冻结' : '已解冻'}` });
  }

  /* 后台：加减余额（带操作日志） */
  const mBal = /^\/admin\/users\/([^/]+)\/balance$/.exec(p);
  if (mBal && method === 'POST') {
    if (user.role !== 'admin') return fail(res, '需要管理员权限', 403);
    const t = findUser(decodeURIComponent(mBal[1]));
    if (!t) return fail(res, '用户不存在');
    const b = await readBody(req);
    const delta = r2(b.delta);
    if (!delta) return fail(res, '请输入有效金额');
    if (delta < 0 && Math.abs(delta) > t.usdt) return fail(res, '扣减金额超过该账户余额');
    t.usdt = r2(t.usdt + delta);
    DB.logs.unshift({ time: nowStr(), uid: t.name, delta, note: String(b.note || '').trim() || (delta > 0 ? '后台加余额' : '后台扣款'), by: user.name });
    save();
    return ok(res, { users: DB.users.map(pub), logs: DB.logs.slice(0, 60), message: `${t.name} 余额${delta > 0 ? '+' : '-'}${Math.abs(delta).toFixed(2)} USDT` });
  }

  return fail(res, '接口不存在: ' + p, 404);
}

/* ---------------- HTTP 服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith('/api/')) {
    try { return await handleApi(req, res, url); }
    catch (e) { return fail(res, e.message || '服务异常', 500); }
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!gateOk(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(gatePage());
    }
    const html = pageHtml();
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('页面文件缺失：' + PAGE + ' 或 ' + PAGE_B64);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

refreshMarks();
setInterval(refreshMarks, 5000);
setInterval(engineTick, 3000);

server.listen(PORT, () => {
  console.log(`VKM 演示交易所后端已启动： http://127.0.0.1:${PORT}`);
  console.log(`数据文件：${DB_FILE}`);
  console.log(SITE_CODE ? '访问口令：已启用（SITE_CODE）' : '访问口令：未启用（设置环境变量 SITE_CODE 可开启）');
});
