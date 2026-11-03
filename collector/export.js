/**
 * Windows 侧凭据采集器
 *
 * 作用：从本机 TeleAgent 安装中读出当前登录态，导出为可迁移的凭据包。
 * 输出：{ token, deviceId, installId, exportedAt }
 *
 * 说明：
 *  - token 存储为 Chromium os_crypt(v10)：AES-256-GCM 密文，密钥由 Windows DPAPI 保护。
 *    因此必须在登录过的那台 Windows、那个用户下运行本脚本。
 *  - 不修改任何 TeleAgent 数据，只读。
 *
 * 用法：node export.js [输出文件]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = path.join(os.homedir(), '.local', 'share', 'TeleAgent');

function dpapiUnprotect(buf) {
  const ps = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String('${buf.toString('base64')}')
[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
`;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
  }).trim();
  return Buffer.from(out, 'base64');
}

function aesKey() {
  const ls = JSON.parse(fs.readFileSync(path.join(BASE, 'Local State'), 'utf8'));
  let ek = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
  if (ek.subarray(0, 5).toString() === 'DPAPI') ek = ek.subarray(5);
  return dpapiUnprotect(ek);
}

function currentOwner() {
  const p = path.join(BASE, 'current-owner.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).ownerDir;
  } catch {
    return null;
  }
}

function decryptToken(ownerDir) {
  const p = path.join(BASE, 'users', ownerDir, 'app-auth', 'token.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (raw.scheme !== 'safe_storage') throw new Error('unexpected scheme: ' + raw.scheme);
  const blob = Buffer.from(raw.encryptedToken, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), blob.subarray(3, 15));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(15, blob.length - 16)), d.final()]).toString('utf8');
}

function deviceMeta() {
  const p = path.join(BASE, 'app-auth', 'device-meta.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function jwtExp(token) {
  const jwt = token.slice(token.indexOf(':') + 1);
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function jwtClaims(token) {
  const jwt = token.slice(token.indexOf(':') + 1);
  const parts = jwt.split('.');
  if (parts.length !== 3) return {};
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      userName: p.userName || p.accountName || null,
      accountName: p.accountName || null,
      accountId: p.accountId || p.userId || null,
      tenant: p.tenant || null,
    };
  } catch {
    return {};
  }
}

const ownerDir = process.argv[3] || currentOwner();
if (!ownerDir) {
  console.error('找不到当前账号目录（current-owner.json）');
  process.exit(1);
}

const token = decryptToken(ownerDir);
const meta = deviceMeta();
const exp = jwtExp(token);
const claims = jwtClaims(token);

const bundle = {
  token,
  deviceId: meta.deviceId,
  installId: meta.installId,
  ownerDir,
  userName: claims.userName || null,
  accountId: claims.accountId || null,
  tenant: claims.tenant || null,
  exp: exp ? new Date(exp).toISOString() : null,
  exportedAt: new Date().toISOString(),
};

const out = process.argv[2] || path.join(__dirname, 'credential.json');
fs.writeFileSync(out, JSON.stringify(bundle, null, 2), { mode: 0o600 });

const daysLeft = exp ? Math.round((exp - Date.now()) / 86400000) : '?';
console.log(`已导出到 ${out}`);
console.log(`  账号:     ${claims.userName || '未知'}`);
console.log(`  账号 ID:  ${claims.accountId || '-'}`);
console.log(`  租户:     ${claims.tenant || '-'}`);
console.log(`  设备号:   ${bundle.deviceId}`);
console.log(`  安装号:   ${bundle.installId}`);
console.log(`  有效期:   ${bundle.exp}（剩余 ${daysLeft} 天）`);
