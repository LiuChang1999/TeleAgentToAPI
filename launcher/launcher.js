#!/usr/bin/env node
/**
 * TeleAgent Linux 内核启动器（多账号）
 *
 * 内核不读进程环境变量，而是从 stdin 读取：
 *   [4 字节大端长度][JSON 环境对象]
 *
 * 账号来源优先级：
 *   1. 命令行参数 <accountId>
 *   2. data/accounts.json 里的 active
 *   3. credential.json（单账号兼容模式）
 *
 * 每个账号使用独立的数据目录 data/instances/<accountId>，
 * 避免不同账号的会话数据库互相污染。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'super-agent-code');
const GLOBAL_DATA = path.join(ROOT, 'data');
const ACCOUNTS_FILE = path.join(GLOBAL_DATA, 'accounts.json');
const CRED = path.join(ROOT, 'credential.json');
const PORT = Number(process.env.TA_KERNEL_PORT || process.env.TA_CONTROL_PORT || 18080);

const PASSWORD = process.env.TA_KERNEL_PASSWORD || crypto.randomBytes(9).toString('base64url').slice(0, 12);
const SESSION_KEY = crypto.randomBytes(32).toString('base64url');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// 与客户端 encryptAuthState 完全一致
function encryptAuthState(state, sessionKey) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(sessionKey).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return {
    version: 'v1',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ct.toString('base64url'),
  };
}

// ---------- 解析要启动哪个账号 ----------
function resolveAccount() {
  const wanted = process.argv[2];
  if (fs.existsSync(ACCOUNTS_FILE)) {
    const db = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const list = db.accounts || [];
    const id = wanted || db.active;
    const acc = list.find((a) => a.id === id) || list[0];
    if (!acc) throw new Error('accounts.json 里没有任何账号');
    return {
      id: acc.id,
      name: acc.name || acc.id,
      token: acc.token,
      deviceId: acc.deviceId,
      installId: acc.installId,
      source: 'accounts.json',
    };
  }
  const c = JSON.parse(fs.readFileSync(CRED, 'utf8'));
  return {
    id: 'default',
    name: c.ownerDir || '默认账号',
    token: c.token,
    deviceId: c.deviceId,
    installId: c.installId,
    source: 'credential.json',
  };
}

const account = resolveAccount();
const DATA = path.join(GLOBAL_DATA, 'instances', account.id);

ensureDir(DATA);
ensureDir(path.join(DATA, 'log'));
ensureDir(path.join(DATA, 'config'));
ensureDir(path.join(DATA, 'tmp'));

// 把 provider 定义写进内核读取的配置文件
const PROVIDER_FILE = path.join(ROOT, 'provider.json');
if (fs.existsSync(PROVIDER_FILE)) {
  const pj = JSON.parse(fs.readFileSync(PROVIDER_FILE, 'utf8'));
  const cfg = {
    provider: pj.provider || {},
    small_model: 'NewApi/chat-lite',
  };
  const cfgPath = path.join(DATA, 'config', 'TeleAgent.jsonc');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

const authState = encryptAuthState(
  { token: account.token, deviceId: account.deviceId, installId: account.installId },
  SESSION_KEY
);

const providerConfig = (() => {
  if (!fs.existsSync(PROVIDER_FILE)) return {};
  const pj = JSON.parse(fs.readFileSync(PROVIDER_FILE, 'utf8'));
  return { provider: pj.provider || {}, small_model: 'NewApi/chat-lite' };
})();

const env = {
  HOME: process.env.HOME || DATA,
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  TMPDIR: path.join(DATA, 'tmp'),
  LANG: process.env.LANG || 'C.UTF-8',
  XDG_DATA_HOME: path.join(DATA, 'xdg-data'),
  XDG_CONFIG_HOME: path.join(DATA, 'xdg-config'),
  XDG_CACHE_HOME: path.join(DATA, 'xdg-cache'),
  XDG_STATE_HOME: path.join(DATA, 'xdg-state'),
  SUPER_AGENT_APP_VERSION: '3.0.0',
  SUPER_AGENT_APP_DATA_DIR: DATA,
  SUPER_AGENT_APP_CONFIG_DIR: path.join(DATA, 'config'),
  SUPER_AGENT_LOG_DIR: path.join(DATA, 'log'),
  SUPER_AGENT_SERVER_URL: `http://127.0.0.1:${PORT}`,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(providerConfig),
  SERVER_PORT: String(PORT),
  SUPER_AGENT_LOCAL_SESSION_KEY: SESSION_KEY,
  SUPER_AGENT_OPENCODE_USERNAME: 'super-agent',
  SUPER_AGENT_OPENCODE_PASSWORD: PASSWORD,
  SUPER_AGENT_AUTH_STATE: JSON.stringify(authState),
  SUPER_AGENT_IGNORE_DOT_GIT: '1',
  SUPER_AGENT_ENABLE_LLM_PERF: '0',
  SUPER_AGENT_ENABLE_WECOM_SDK_DEBUG: '0',
  SUPER_AGENT_INSTRUCTION_REVIEW_APP_ID: account.deviceId || '',
  SUPER_AGENT_SANDBOX_EXECUTION_MODE: 'legacy',
  SUPER_AGENT_SANDBOX_LEVEL: '0',
  OPENCODE_LOG_LEVEL: process.env.OPENCODE_LOG_LEVEL || 'INFO',
};

const payload = Buffer.from(JSON.stringify(env), 'utf8');
const lenBuf = Buffer.alloc(4);
lenBuf.writeUInt32BE(payload.length, 0);

console.log(`[launcher] account=${account.name} (${account.id}) via ${account.source}`);
console.log(`[launcher] kernel=${BIN}`);
console.log(`[launcher] port=${PORT} envBytes=${payload.length} data=${DATA}`);

const child = spawn(BIN, [], {
  cwd: DATA,
  env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR },
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stdout.on('data', (d) => process.stdout.write(`[kernel] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[kernel:err] ${d}`));
child.on('exit', (code, sig) => {
  console.log(`[launcher] kernel exited code=${code} sig=${sig}`);
  process.exit(code === null ? 1 : code);
});

child.stdin.write(Buffer.concat([lenBuf, payload]));
child.stdin.end();

// 把运行期凭据写到全局位置，供 shim 使用
fs.writeFileSync(
  path.join(GLOBAL_DATA, 'runtime-auth.json'),
  JSON.stringify(
    {
      sessionKey: SESSION_KEY,
      password: PASSWORD,
      port: PORT,
      accountId: account.id,
      accountName: account.name,
      startedAt: new Date().toISOString(),
    },
    null,
    2
  ),
  { mode: 0o600 }
);

// 等待 ready
const started = Date.now();
(async () => {
  while (Date.now() - started < 60000) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) {
        console.log(`[launcher] kernel ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return;
      }
    } catch {
      /* not up yet */
    }
  }
  console.error('[launcher] kernel not ready within 60s');
})();

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
