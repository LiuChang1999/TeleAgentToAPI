/**
 * TeleAgent → OpenAI 兼容网关（带管理后台）
 *
 * 功能：
 *   - OpenAI 兼容接口 /v1/models、/v1/chat/completions（含 SSE）
 *   - API Key 鉴权、积分额度、用量统计
 *   - 管理后台 /admin：登录、Key 管理、积分、调用示例、日志
 *
 * 环境变量：
 *   TA_PORT            监听端口（默认 18787）
 *   TA_ADMIN_PASSWORD  管理员密码（首次启动自动生成并写入 data/admin.json）
 *   TA_KERNEL_URL      内核地址（默认读 runtime-auth.json 的 port）
 *   TA_AUTH_FILE       运行期凭据文件
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ADMIN_DB = path.join(DATA_DIR, 'admin.json');
const ADMIN_HTML = path.join(ROOT, 'admin.html');
const CRED_FILE = path.join(ROOT, 'credential.json');

// 监听配置：环境变量优先，其次 data/admin.json 的 network 设置
let PORT = Number(process.env.TA_PORT || 18787);
let BIND = process.env.TA_HOST || '0.0.0.0';

// ---------- 运行期凭据 ----------
function loadRuntimeAuth() {
  const p = process.env.TA_AUTH_FILE || path.join(DATA_DIR, 'runtime-auth.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
const RT = loadRuntimeAuth();
const KERNEL = process.env.TA_KERNEL_URL || `http://127.0.0.1:${RT.port || 18080}`;

function creds() {
  const rt = loadRuntimeAuth();
  return {
    key: process.env.TA_SESSION_KEY || rt.sessionKey || '',
    pass: process.env.TA_KERNEL_PASSWORD || rt.password || '',
  };
}

// ---------- 数据存储 ----------
function newKey() {
  return 'sk-ta-' + crypto.randomBytes(24).toString('hex');
}

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_DB, 'utf8'));
  } catch {
    return null;
  }
}

function saveDB(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ADMIN_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ADMIN_DB);
}

let db = loadDB();
if (!db) {
  const pwd = process.env.TA_ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db = {
    adminPassword: pwd,
    createdAt: new Date().toISOString(),
    keys: [
      {
        id: crypto.randomUUID(),
        key: newKey(),
        name: '默认应用',
        quota: 1000000,
        used: 0,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        requests: 0,
      },
    ],
    logs: [],
  };
  saveDB(db);
  console.log('');
  console.log('  ==================================================');
  console.log('   管理后台   : http://<服务器IP>:' + PORT + '/admin');
  console.log('   管理员密码 : ' + pwd);
  console.log('   默认 API Key: ' + db.keys[0].key);
  console.log('  ==================================================');
  console.log('');
}

if (!process.env.TA_PORT && db.network && db.network.port) {
  PORT = Number(db.network.port) || PORT;
}
if (!process.env.TA_HOST && db.network && db.network.bind) {
  BIND = String(db.network.bind);
}

function localAddresses() {
  const out = new Set(['0.0.0.0', '::', '::1', '127.0.0.1', 'localhost']);
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4') out.add(a.address);
    }
  }
  return [...out];
}

function isValidBind(host) {
  if (!host) return false;
  if (host === 'localhost') return true;
  if (!net.isIP(host)) return false;
  return localAddresses().includes(host);
}

// ---------- 账号管理 ----------
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const { execFile } = require('child_process');

function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// 从 token 里解析真实身份（用户名 / 账号 ID / 租户 / 有效期）
function decodeToken(token) {
  try {
    const jwt = token.slice(token.indexOf(':') + 1);
    const parts = jwt.split('.');
    if (parts.length !== 3) return {};
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      userName: p.userName || p.accountName || null,
      accountId: p.accountId || p.userId || null,
      tenant: p.tenant || null,
      exp: p.exp ? new Date(p.exp * 1000).toISOString() : null,
    };
  } catch {
    return {};
  }
}

// 从多个字段里猜手机号（账号目录、userId、用户名都可能带）
function pickPhone() {
  for (const v of arguments) {
    if (!v) continue;
    const m = String(v).match(/(?:^|\D)(1[3-9]\d{9})(?:\D|$)/);
    if (m) return m[1];
  }
  return null;
}

function saveAccounts(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

let accDB = loadAccounts();
if (!accDB) {
  const init = { active: null, accounts: [] };
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    const claims = decodeToken(c.token);
    const id = 'acc_' + crypto.randomBytes(6).toString('hex');
    init.accounts.push({
      id,
      name: claims.userName || c.ownerDir || '默认账号',
      userName: claims.userName || null,
      accountId: claims.accountId || null,
      tenant: claims.tenant || null,
      token: c.token,
      deviceId: c.deviceId,
      installId: c.installId,
      exp: c.exp || claims.exp || null,
      ownerDir: c.ownerDir || null,
      createdAt: new Date().toISOString(),
    });
    init.active = id;
  } catch {}
  accDB = init;
  saveAccounts(accDB);
}

// 自动补全历史账号的真实身份信息，并把占位名换成用户名
(function migrateAccounts() {
  let changed = false;
  for (const a of accDB.accounts) {
    const claims = decodeToken(a.token);
    if (!a.userName && claims.userName) {
      a.userName = claims.userName;
      a.accountId = claims.accountId || a.accountId || null;
      a.tenant = claims.tenant || a.tenant || null;
      if (!a.exp && claims.exp) a.exp = claims.exp;
      const placeholder =
        !a.name ||
        /^测试账号/.test(a.name) ||
        /^v1_public_/.test(a.name) ||
        a.name === a.ownerDir;
      if (placeholder) a.name = claims.userName;
      changed = true;
    }
  }
  if (changed) saveAccounts(accDB);
})();

let switching = false;

function activeAccount() {
  return accDB.accounts.find((a) => a.id === accDB.active) || accDB.accounts[0] || null;
}

function daysLeftOf(exp) {
  if (!exp) return null;
  const t = new Date(exp).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86400000);
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').slice(0, 300)));
      else resolve(stdout);
    });
  });
}

async function activateAccount(id) {
  const acc = accDB.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('账号不存在');
  if (accDB.active === id) {
    // 已激活，确认内核活着即可
    try {
      const h = await kernel('GET', '/health', undefined, 3000);
      if (h.status === 200) return { already: true };
    } catch {}
  }
  accDB.active = id;
  saveAccounts(accDB);

  switching = true;
  try {
    await runCmd('systemctl', ['--user', 'restart', 'teleagent-kernel']);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const h = await kernel('GET', '/health', undefined, 2000);
        if (h.status === 200) {
          return { ok: true, ms: Date.now() - t0 };
        }
      } catch {}
    }
    throw new Error('内核重启超时（60s）');
  } finally {
    switching = false;
  }
}

// ---------- 管理员会话 ----------
const sessions = new Map();

function issueSession() {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + 12 * 3600 * 1000);
  return t;
}

function checkSession(req) {
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/ta_admin=([a-f0-9]{64})/);
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(m[1]);
    return false;
  }
  return true;
}

// ---------- 内核调用 ----------
function sign(method, pathWithQuery, key) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = ['local-v1', method.toUpperCase(), pathWithQuery, ts, nonce].join('\n');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return {
    'X-SA-Sign-Version': 'local-v1',
    'X-SA-Timestamp': ts,
    'X-SA-Nonce': nonce,
    'X-SA-Signature': sig,
  };
}

function kernel(method, pathWithQuery, body, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const url = new URL(KERNEL);
    const data = body === undefined ? null : JSON.stringify(body);
    const c = creds();
    const headers = {
      Authorization: 'Basic ' + Buffer.from(`super-agent:${c.pass}`).toString('base64'),
      Accept: 'application/json',
      ...sign(method, pathWithQuery, c.key),
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        path: pathWithQuery,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (ch) => (out += ch));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(out);
          } catch {}
          resolve({ status: res.statusCode, raw: out, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('kernel timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- 内核事件总线 ----------
// 复用单条 /event SSE 连接，按 sessionID 分发，避免每个请求都新建连接
class KernelEvents {
  constructor() {
    this.res = null;
    this.buf = '';
    this.listeners = new Map();
    this.connecting = false;
    this.ready = false;
  }

  start() {
    if (this.res || this.connecting) return;
    this.connecting = true;
    const url = new URL(KERNEL);
    const c = creds();
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        path: '/event',
        method: 'GET',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`super-agent:${c.pass}`).toString('base64'),
          Accept: 'text/event-stream',
          ...sign('GET', '/event', c.key),
        },
      },
      (res) => {
        this.connecting = false;
        if (res.statusCode !== 200) {
          res.resume();
          setTimeout(() => this.start(), 2000);
          return;
        }
        this.res = res;
        this.ready = true;
        res.setEncoding('utf8');
        res.on('data', (chunk) => this.onData(chunk));
        res.on('end', () => this.reset());
        res.on('error', () => this.reset());
      }
    );
    req.on('error', () => {
      this.connecting = false;
      setTimeout(() => this.start(), 2000);
    });
    req.end();
  }

  reset() {
    this.res = null;
    this.buf = '';
    this.ready = false;
    setTimeout(() => this.start(), 1000);
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.dispatch(raw);
    }
  }

  dispatch(raw) {
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    const p = ev.properties || {};
    const sid = p.sessionID || (p.part && p.part.sessionID) || (p.info && p.info.sessionID);
    if (!sid) return;
    const set = this.listeners.get(sid);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev);
      } catch {}
    }
  }

  on(sid, fn) {
    this.start();
    if (!this.listeners.has(sid)) this.listeners.set(sid, new Set());
    this.listeners.get(sid).add(fn);
    return () => {
      const s = this.listeners.get(sid);
      if (s) {
        s.delete(fn);
        if (!s.size) this.listeners.delete(sid);
      }
    };
  }
}

const events = new KernelEvents();

const MODELS = [
  { id: 'chat-pro', name: '智能', context: 400000, weight: 0.6 },
  { id: 'chat-flagship', name: '旗舰', context: 400000, weight: 1.0 },
  { id: 'chat-flash', name: '极速', context: 400000, weight: 0.4 },
  { id: 'chat-lite', name: '轻量', context: 100000, weight: 0.2 },
  { id: 'chat-nano', name: '轻速', context: 100000, weight: 0.1 },
];

function flatten(messages) {
  const sys = [];
  const turns = [];
  for (const m of messages || []) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
          : '';
    if (!text) continue;
    if (m.role === 'system') sys.push(text);
    else if (m.role === 'user') turns.push(`用户：${text}`);
    else if (m.role === 'assistant') turns.push(`助手：${text}`);
    else if (m.role === 'tool') turns.push(`工具结果：${text}`);
  }
  const head = sys.length ? `[系统要求]\n${sys.join('\n')}\n\n` : '';
  return head + turns.join('\n\n');
}

function extractText(msg) {
  const out = [];
  for (const p of (msg && msg.parts) || []) {
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text);
  }
  return out.join('');
}

async function runChat(model, messages, agent) {
  const created = await kernel('POST', '/session', { title: 'openai-proxy' });
  if (created.status !== 200 || !created.json || !created.json.id) {
    throw new Error(`create session failed: ${created.status} ${created.raw.slice(0, 200)}`);
  }
  const sid = created.json.id;
  const payload = {
    model: { providerID: 'NewApi', modelID: model },
    parts: [{ type: 'text', text: flatten(messages) }],
  };
  if (agent) payload.agent = agent;
  const res = await kernel('POST', `/session/${sid}/message`, payload);
  if (res.status !== 200) {
    throw new Error(`message failed: ${res.status} ${res.raw.slice(0, 300)}`);
  }
  const info = (res.json && res.json.data && res.json.data.info) || {};
  return {
    id: `chatcmpl-${(info.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9]/g, '')}`,
    model,
    text: extractText(res.json && res.json.data),
    promptTokens: (info.tokens && info.tokens.input) || 0,
    completionTokens: (info.tokens && info.tokens.output) || 0,
    finish: info.finish || 'stop',
  };
}

// ---------- 工具 ----------
function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function clientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    ''
  ).replace('::ffff:', '');
}

function findKey(raw) {
  if (!raw) return null;
  const token = String(raw).replace(/^Bearer\s+/i, '').trim();
  return db.keys.find((k) => k.key === token) || null;
}

function currentAccount() {
  const rt = loadRuntimeAuth();
  const a = accDB.accounts.find((x) => x.id === rt.accountId);
  return {
    id: rt.accountId || null,
    name: (a && a.name) || rt.accountName || null,
  };
}

function addLog(entry) {
  const cur = currentAccount();
  db.logs.unshift({ accountId: cur.id, accountName: cur.name, ...entry });
  if (db.logs.length > 500) db.logs.length = 500;
}

// ---------- 管理 API ----------
async function handleAdmin(req, res, url) {
  const p = url.pathname;

  if (p === '/admin' || p === '/admin/') {
    try {
      const html = fs.readFileSync(ADMIN_HTML, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('admin.html 缺失');
    }
    return;
  }

  if (p === '/admin/api/login' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    if (!body.password || body.password !== db.adminPassword) {
      await new Promise((r) => setTimeout(r, 400));
      return sendJson(res, 401, { error: '密码错误' });
    }
    const t = issueSession();
    res.setHeader(
      'Set-Cookie',
      `ta_admin=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}`
    );
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/admin/api/logout') {
    const cookie = req.headers['cookie'] || '';
    const m = cookie.match(/ta_admin=([a-f0-9]{64})/);
    if (m) sessions.delete(m[1]);
    res.setHeader('Set-Cookie', 'ta_admin=; Path=/; HttpOnly; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (!checkSession(req)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (p === '/admin/api/overview') {
    // 优先用当前激活账号的凭据，没有账号时才退回 credential.json
    const activeAcc = activeAccount();
    const cred = activeAcc
      ? {
          deviceId: activeAcc.deviceId,
          installId: activeAcc.installId,
          ownerDir: activeAcc.ownerDir,
          exp: activeAcc.exp,
        }
      : (() => {
          try {
            return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
          } catch {
            return {};
          }
        })();
    const exp = cred.exp ? new Date(cred.exp).getTime() : 0;
    const daysLeft = exp ? Math.floor((exp - Date.now()) / 86400000) : null;

    let kernelOk = false;
    let kernelMs = null;
    try {
      const t0 = Date.now();
      const h = await kernel('GET', '/health', undefined, 5000);
      kernelMs = Date.now() - t0;
      kernelOk = h.status === 200;
    } catch {}

    const totalQuota = db.keys.reduce((s, k) => s + (k.quota || 0), 0);
    const totalUsed = db.keys.reduce((s, k) => s + (k.used || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    const todayLogs = db.logs.filter((l) => l.ts && l.ts.startsWith(today));

    return sendJson(res, 200, {
      kernel: { ok: kernelOk, url: KERNEL, latencyMs: kernelMs },
      credential: {
        exp: cred.exp || null,
        daysLeft,
        deviceId: cred.deviceId || null,
        installId: cred.installId || null,
        ownerDir: cred.ownerDir || null,
      },
      keys: { count: db.keys.length, enabled: db.keys.filter((k) => k.enabled).length },
      quota: { total: totalQuota, used: totalUsed, remaining: totalQuota - totalUsed },
      today: {
        requests: todayLogs.length,
        tokens: todayLogs.reduce((s, l) => s + (l.totalTokens || 0), 0),
      },
      models: MODELS,
      endpoint: `http://${req.headers.host || 'localhost'}`,
      account: (() => {
        const a = activeAccount();
        if (!a) return null;
        return {
          id: a.id,
          name: a.name,
          note: a.note || '',
          phone: a.phone || pickPhone(a.phone, a.userName, a.accountId, a.ownerDir),
          userName: a.userName || null,
          accountId: a.accountId || null,
          tenant: a.tenant || null,
          exp: a.exp || null,
          daysLeft: daysLeftOf(a.exp),
          ownerDir: a.ownerDir || null,
          deviceId: a.deviceId || null,
        };
      })(),
      accounts: accDB.accounts.map((a) => {
        const ls = db.logs.filter((l) => l.accountId === a.id);
        return {
          id: a.id,
          name: a.name,
          note: a.note || '',
          phone: a.phone || pickPhone(a.phone, a.userName, a.accountId, a.ownerDir),
          userName: a.userName || null,
          accountId: a.accountId || null,
          tenant: a.tenant || null,
          exp: a.exp || null,
          daysLeft: daysLeftOf(a.exp),
          active: a.id === accDB.active,
          requests: ls.length,
          tokens: ls.reduce((s, l) => s + (l.totalTokens || 0), 0),
          cost: ls.reduce((s, l) => s + (l.cost || 0), 0),
        };
      }),
      switching,
    });
  }

  if (p === '/admin/api/keys' && req.method === 'GET') {
    return sendJson(res, 200, { keys: db.keys });
  }

  if (p === '/admin/api/keys' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    const k = {
      id: crypto.randomUUID(),
      key: newKey(),
      name: String(body.name || '未命名').slice(0, 40),
      quota: Math.max(0, Number(body.quota) || 0),
      used: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      requests: 0,
    };
    db.keys.push(k);
    saveDB(db);
    return sendJson(res, 200, { key: k });
  }

  const keyMatch = p.match(/^\/admin\/api\/keys\/([0-9a-f-]{36})$/);
  if (keyMatch) {
    const k = db.keys.find((x) => x.id === keyMatch[1]);
    if (!k) return sendJson(res, 404, { error: 'not found' });

    if (req.method === 'PATCH') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      if (body.name !== undefined) k.name = String(body.name).slice(0, 40);
      if (body.quota !== undefined) k.quota = Math.max(0, Number(body.quota) || 0);
      if (body.enabled !== undefined) k.enabled = !!body.enabled;
      if (body.resetUsed) k.used = 0;
      saveDB(db);
      return sendJson(res, 200, { key: k });
    }
    if (req.method === 'DELETE') {
      db.keys = db.keys.filter((x) => x.id !== k.id);
      saveDB(db);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---------- 账号 ----------
  if (p === '/admin/api/accounts' && req.method === 'GET') {
    const rt = loadRuntimeAuth();
    return sendJson(res, 200, {
      active: accDB.active,
      runningAccountId: rt.accountId || null,
      switching,
      accounts: accDB.accounts.map((a) => {
        const ls = db.logs.filter((l) => l.accountId === a.id);
        return {
          id: a.id,
          name: a.name,
          note: a.note || '',
          phone: a.phone || pickPhone(a.phone, a.userName, a.accountId, a.ownerDir),
          userName: a.userName || null,
          accountId: a.accountId || null,
          tenant: a.tenant || null,
          ownerDir: a.ownerDir || null,
          deviceId: a.deviceId || null,
          exp: a.exp || null,
          daysLeft: daysLeftOf(a.exp),
          active: a.id === accDB.active,
          tokenTail: a.token ? a.token.slice(-8) : null,
          requests: ls.length,
          tokens: ls.reduce((s, l) => s + (l.totalTokens || 0), 0),
          cost: ls.reduce((s, l) => s + (l.cost || 0), 0),
          createdAt: a.createdAt || null,
        };
      }),
    });
  }

  if (p === '/admin/api/accounts' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    let c = body.credential !== undefined ? body.credential : body;
    if (typeof c === 'string') {
      try {
        c = JSON.parse(c);
      } catch {
        return sendJson(res, 400, { error: '凭据 JSON 解析失败' });
      }
    }
    if (!c || typeof c !== 'object') return sendJson(res, 400, { error: '缺少凭据' });
    if (!c.token || !c.deviceId || !c.installId) {
      return sendJson(res, 400, { error: '凭据缺少 token / deviceId / installId' });
    }
    const phone = pickPhone(c.ownerDir, c.userName, c.userId, c.phone);
    if (accDB.accounts.some((a) => a.token === c.token)) {
      return sendJson(res, 409, { error: '这个账号已经导入过了' });
    }
    const claims = decodeToken(c.token);
    const acc = {
      id: 'acc_' + crypto.randomBytes(6).toString('hex'),
      name: String(
        body.name || claims.userName || c.userName || phone || c.ownerDir || '未命名账号'
      ).slice(0, 40),
      note: String(body.note || '').slice(0, 100),
      phone: phone || pickPhone(claims.userName, claims.accountId) || null,
      userName: claims.userName || c.userName || null,
      accountId: claims.accountId || c.accountId || null,
      tenant: claims.tenant || c.tenant || claims.tenant || c.tenantId || null,
      token: c.token,
      deviceId: c.deviceId,
      installId: c.installId,
      exp: c.exp || claims.exp || null,
      ownerDir: c.ownerDir || null,
      createdAt: new Date().toISOString(),
    };
    accDB.accounts.push(acc);
    if (!accDB.active) accDB.active = acc.id;
    saveAccounts(accDB);
    return sendJson(res, 200, { ok: true, id: acc.id, name: acc.name });
  }

  const accMatch = p.match(/^\/admin\/api\/accounts\/(acc_[0-9a-f]{12})$/);
  if (accMatch) {
    const acc = accDB.accounts.find((a) => a.id === accMatch[1]);
    if (!acc) return sendJson(res, 404, { error: '账号不存在' });
    if (req.method === 'PATCH') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      if (body.name !== undefined) acc.name = String(body.name).slice(0, 40);
      if (body.note !== undefined) acc.note = String(body.note).slice(0, 100);
      saveAccounts(accDB);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      if (accDB.accounts.length <= 1) return sendJson(res, 400, { error: '至少保留一个账号' });
      accDB.accounts = accDB.accounts.filter((a) => a.id !== acc.id);
      if (accDB.active === acc.id) accDB.active = accDB.accounts[0].id;
      saveAccounts(accDB);
      return sendJson(res, 200, { ok: true });
    }
  }

  const activateMatch = p.match(/^\/admin\/api\/accounts\/(acc_[0-9a-f]{12})\/activate$/);
  if (activateMatch && req.method === 'POST') {
    if (switching) return sendJson(res, 409, { error: '正在切换中，请稍候' });
    try {
      const r = await activateAccount(activateMatch[1]);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  if (p === '/admin/api/logs') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    return sendJson(res, 200, { logs: db.logs.slice(0, limit) });
  }

  if (p === '/admin/api/network' && req.method === 'GET') {
    return sendJson(res, 200, {
      bind: BIND,
      port: PORT,
      envLocked: Boolean(process.env.TA_PORT || process.env.TA_HOST),
      addresses: localAddresses(),
    });
  }

  if (p === '/admin/api/network/test' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    const bind = String(body.bind || '').trim();
    const port = Number(body.port);
    if (!isValidBind(bind)) {
      return sendJson(res, 400, {
        error: '不是本机地址，可选：' + localAddresses().join('、'),
      });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJson(res, 400, { error: '端口需为 1-65535 的整数' });
    }
    if (port !== PORT) {
      const free = await probePort(bind, port);
      if (!free) return sendJson(res, 400, { error: '端口 ' + port + ' 已被占用或被系统拒绝' });
    }
    const notes = [];
    if (bind === '127.0.0.1' || bind === '::1' || bind === 'localhost') {
      notes.push('只有本机能访问，外部需要经 nginx 或 tunnel 转发');
    } else if (bind === '0.0.0.0' || bind === '::') {
      notes.push('所有网卡可达');
    } else {
      notes.push('只监听 ' + bind + ' 这张网卡');
    }
    if (port === PORT && bind === BIND) notes.push('与当前配置一致，无需保存');
    else if (port === PORT) notes.push('端口与当前相同，切换时由本进程让出再占回');
    return sendJson(res, 200, {
      ok: true,
      message: '地址可用、端口可绑定 — ' + bind + ':' + port + '；' + notes.join('；'),
    });
  }

  if (p === '/admin/api/network' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    if (process.env.TA_PORT || process.env.TA_HOST) {
      return sendJson(res, 400, {
        error: '当前监听地址由环境变量 TA_HOST / TA_PORT 指定，去掉环境变量后才能在这里修改',
      });
    }
    if (rebinding) return sendJson(res, 409, { error: '正在切换监听地址，请稍候' });

    const bind = String(body.bind || '').trim();
    const port = Number(body.port);
    if (!isValidBind(bind)) {
      return sendJson(res, 400, {
        error: '监听地址必须是本机地址，可选：' + localAddresses().join('、'),
      });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJson(res, 400, { error: '端口需为 1-65535 的整数' });
    }
    if (bind === BIND && port === PORT) {
      return sendJson(res, 200, { ok: true, bind, port, unchanged: true });
    }
    if (port !== PORT) {
      const free = await probePort(bind, port);
      if (!free) return sendJson(res, 400, { error: '端口 ' + port + ' 已被占用或被拒绝' });
    }

    const old = { bind: BIND, port: PORT };
    db.network = { bind, port };
    saveDB(db);
    BIND = bind;
    PORT = port;

    // 先把响应发出去，再切换监听，避免自己把自己的回包掐断
    sendJson(res, 200, { ok: true, bind, port, previous: old });
    setTimeout(() => {
      rebindServer(bind, port).catch(async (e) => {
        console.error('[network] 切换监听失败，回滚', e && e.message);
        BIND = old.bind;
        PORT = old.port;
        db.network = old;
        saveDB(db);
        try {
          await rebindServer(old.bind, old.port);
        } catch (e2) {
          console.error('[network] 回滚也失败，进程将退出', e2 && e2.message);
          process.exit(1);
        }
      });
    }, 200);
    return;
  }

  if (p === '/admin/api/password' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    if (body.old !== db.adminPassword) return sendJson(res, 401, { error: '原密码错误' });
    if (!body.next || body.next.length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
    db.adminPassword = body.next;
    saveDB(db);
    sessions.clear();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ---------- 主服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/admin')) {
      await handleAdmin(req, res, url);
      return;
    }

    // 客户端脚本下载：/collector/export.js、/collector/push.js
    if (url.pathname.startsWith('/collector/')) {
      const name = path.basename(url.pathname);
      if (!/^(export|push)\.js$/.test(name)) return sendJson(res, 404, { error: 'not found' });
      const file = path.join(ROOT, '..', 'collector', name);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      const buf = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + name + '"',
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }

    if (url.pathname === '/healthz') {
      try {
        const r = await kernel('GET', '/health', undefined, 5000);
        return sendJson(res, 200, { ok: r.status === 200, kernel: r.status });
      } catch (e) {
        return sendJson(res, 503, { ok: false, error: String(e.message) });
      }
    }

    if (switching) {
      return sendJson(res, 503, {
        error: {
          message: '正在切换账号，请稍后重试',
          type: 'server_error',
          code: 'account_switching',
        },
      });
    }

    const k = findKey(req.headers['authorization']);
    if (!k) {
      return sendJson(res, 401, {
        error: {
          message: 'invalid api key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
    if (!k.enabled) {
      return sendJson(res, 403, {
        error: { message: 'api key disabled', type: 'invalid_request_error', code: 'key_disabled' },
      });
    }
    if (k.used >= k.quota) {
      return sendJson(res, 429, {
        error: { message: 'quota exceeded', type: 'insufficient_quota', code: 'quota_exceeded' },
      });
    }

    if (url.pathname === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: MODELS.map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: 'teleagent',
          name: m.name,
          context_length: m.context,
        })),
      });
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, {
          error: { message: 'invalid json', type: 'invalid_request_error' },
        });
      }
      const model = body.model || 'chat-pro';
      const stream = body.stream === true;
      const t0 = Date.now();
      const weight = (MODELS.find((m) => m.id === model) || { weight: 1 }).weight;
      let headersSent = false;
      let streamState = null;

      const closeStream = () => {
        if (streamState) {
          streamState.close();
          streamState = null;
        }
      };
      res.on('close', closeStream);

      try {
        // 1) 建会话
        const created = await kernel('POST', '/session', { title: 'openai-proxy' });
        if (created.status !== 200 || !created.json || !created.json.id) {
          throw new Error(
            `create session failed: ${created.status} ${created.raw.slice(0, 200)}`
          );
        }
        const sid = created.json.id;

        const payload = {
          model: { providerID: 'NewApi', modelID: model },
          parts: [{ type: 'text', text: flatten(body.messages || []) }],
        };
        if (body.agent) payload.agent = body.agent;

        // 2) 流式：先挂事件监听，再发请求
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          headersSent = true;

          const base = {
            id: 'chatcmpl-' + sid.replace(/[^a-zA-Z0-9]/g, ''),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
          };
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            })}\n\n`
          );

          const partTypes = new Map();
          let closed = false;
          const off = events.on(sid, (ev) => {
            if (closed) return;
            if (ev.type === 'message.part.updated') {
              const pt = ev.properties.part;
              if (pt && pt.id) partTypes.set(pt.id, pt.type);
              return;
            }
            if (ev.type !== 'message.part.delta') return;
            const pr = ev.properties;
            if (pr.field !== 'text') return;
            // 只转发正文，丢弃 reasoning（思考过程）
            if (partTypes.get(pr.partID) !== 'text') return;
            try {
              res.write(
                `data: ${JSON.stringify({
                  ...base,
                  choices: [
                    { index: 0, delta: { content: pr.delta }, finish_reason: null },
                  ],
                })}\n\n`
              );
            } catch {
              /* client gone */
            }
          });
          streamState = {
            base,
            close: () => {
              closed = true;
              off();
            },
          };
        }

        // 3) 发消息（流式时事件会同步推过来）
        const msgRes = await kernel('POST', `/session/${sid}/message`, payload);
        if (msgRes.status !== 200) {
          throw new Error(`message failed: ${msgRes.status} ${msgRes.raw.slice(0, 300)}`);
        }

        const info = (msgRes.json && msgRes.json.data && msgRes.json.data.info) || {};
        const text = extractText(msgRes.json && msgRes.json.data);
        const promptTokens = (info.tokens && info.tokens.input) || 0;
        const completionTokens = (info.tokens && info.tokens.output) || 0;
        const finish = info.finish || 'stop';
        const totalTokens = promptTokens + completionTokens;
        const cost = Math.round(totalTokens * weight);

        k.used += cost;
        k.requests = (k.requests || 0) + 1;
        k.lastUsedAt = new Date().toISOString();
        addLog({
          ts: new Date().toISOString(),
          keyId: k.id,
          keyName: k.name,
          model,
          promptTokens,
          completionTokens,
          totalTokens,
          cost,
          ms: Date.now() - t0,
          ip: clientIp(req),
          ok: true,
        });
        saveDB(db);

        if (stream) {
          const base = streamState ? streamState.base : {
            id: 'chatcmpl-' + sid.replace(/[^a-zA-Z0-9]/g, ''),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
          };
          closeStream();
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: finish }],
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        return sendJson(res, 200, {
          id: 'chatcmpl-' + sid.replace(/[^a-zA-Z0-9]/g, ''),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: text },
              finish_reason: finish,
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
          },
        });
      } catch (e) {
        closeStream();
        addLog({
          ts: new Date().toISOString(),
          keyId: k.id,
          keyName: k.name,
          model,
          totalTokens: 0,
          cost: 0,
          ms: Date.now() - t0,
          ip: clientIp(req),
          ok: false,
          error: String(e.message).slice(0, 200),
        });
        saveDB(db);

        if (headersSent) {
          try {
            res.write(
              `data: ${JSON.stringify({ error: { message: String(e.message) } })}\n\n`
            );
            res.write('data: [DONE]\n\n');
            res.end();
          } catch {}
          return;
        }
        return sendJson(res, 502, {
          error: { message: String(e.message), type: 'upstream_error' },
        });
      }
    }

    return sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal error' } });
    else res.end();
  }
});

// ---------- 监听地址切换 ----------
let rebinding = false;

function probePort(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

async function rebindServer(host, port) {
  rebinding = true;
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve, reject) => {
      const onErr = (e) => {
        server.removeListener('error', onErr);
        reject(e);
      };
      server.once('error', onErr);
      server.listen(port, host, () => {
        server.removeListener('error', onErr);
        console.log('[network] 已切换到 ' + host + ':' + port);
        resolve();
      });
    });
  } finally {
    rebinding = false;
  }
}

server.listen(PORT, BIND, () => {
  console.log(`[teleagent-openai] listening on ${BIND}:${PORT} -> ${KERNEL}`);
  console.log(`[teleagent-openai] admin: http://<ip>:${PORT}/admin`);
  if (!creds().key) console.warn('[teleagent-openai] 会话密钥缺失，内核调用会失败');
});
