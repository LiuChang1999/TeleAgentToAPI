/**
 * 一键推送：把本机 TeleAgent 的登录态直接推到服务器，不用手动复制粘贴
 *
 * 用法（在已登录 TeleAgent 的 Windows 上执行）：
 *   node collector/push.js http://192.168.31.221:18787 <管理员密码>
 *
 * 可选环境变量：
 *   TA_OWNER  指定账号目录（默认读 current-owner.json）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = process.argv[2];
const PWD = process.argv[3];

if (!BASE || !PWD) {
  console.error('用法: node collector/push.js <服务器地址> <管理员密码>');
  console.error('例如: node collector/push.js http://192.168.31.221:18787 mypassword');
  process.exit(1);
}

const TA = path.join(os.homedir(), '.local', 'share', 'TeleAgent');

function dpapiUnprotect(buf) {
  const ps = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String('${buf.toString('base64')}')
[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
`;
  return Buffer.from(
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
    }).trim(),
    'base64'
  );
}

function aesKey() {
  const ls = JSON.parse(fs.readFileSync(path.join(TA, 'Local State'), 'utf8'));
  let ek = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
  if (ek.subarray(0, 5).toString() === 'DPAPI') ek = ek.subarray(5);
  return dpapiUnprotect(ek);
}

function currentOwner() {
  const p = path.join(TA, 'current-owner.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).ownerDir;
}

function decryptToken(ownerDir) {
  const p = path.join(TA, 'users', ownerDir, 'app-auth', 'token.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const blob = Buffer.from(raw.encryptedToken, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), blob.subarray(3, 15));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(15, blob.length - 16)), d.final()]).toString('utf8');
}

function jwtClaims(token) {
  try {
    const jwt = token.slice(token.indexOf(':') + 1);
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
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

let cookie = '';

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}

(async () => {
  const ownerDir = process.env.TA_OWNER || currentOwner();
  const token = decryptToken(ownerDir);
  const claims = jwtClaims(token);
  const meta = JSON.parse(fs.readFileSync(path.join(TA, 'app-auth', 'device-meta.json'), 'utf8'));

  console.log(`账号      : ${claims.userName || '(未知)'}`);
  console.log(`账号 ID   : ${claims.accountId || '-'}`);
  console.log(`租户      : ${claims.tenant || '-'}`);
  console.log(`有效期至  : ${claims.exp || '-'}`);

  const login = await api('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: PWD }),
  });
  if (login.status !== 200) {
    console.error('\n登录服务器失败：', login.json ? login.json.error : login.status);
    process.exit(1);
  }

  const res = await api('/admin/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: claims.userName || ownerDir,
      credential: {
        token,
        deviceId: meta.deviceId,
        installId: meta.installId,
        ownerDir,
        exp: claims.exp,
      },
    }),
  });

  if (res.status === 200) {
    console.log(`\n✓ 已导入服务器（账号 ${res.json.name}）`);
    console.log('  到管理后台「账号」页即可切换使用');
  } else if (res.status === 409) {
    console.log('\n该账号已在服务器上，无需重复导入');
  } else {
    console.error('\n导入失败：', res.json ? res.json.error : res.text.slice(0, 200));
    process.exit(1);
  }
})();
