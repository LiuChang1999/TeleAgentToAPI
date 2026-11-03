// 探测内核的真实用量接口
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = __dirname;
const auth = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runtime-auth.json'), 'utf8'));
const PORT = auth.port || 18080;

function sign(method, p) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = ['local-v1', method.toUpperCase(), p, ts, nonce].join('\n');
  const sig = crypto.createHmac('sha256', auth.sessionKey).update(payload).digest('base64url');
  return {
    'X-SA-Sign-Version': 'local-v1',
    'X-SA-Timestamp': ts,
    'X-SA-Nonce': nonce,
    'X-SA-Signature': sig,
  };
}

function call(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: 'Basic ' + Buffer.from(`super-agent:${auth.password}`).toString('base64'),
      Accept: 'application/json',
      ...sign(method, p),
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method, headers, timeout: 15000 },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const paths = [
    ['GET', '/usage/statistics'],
    ['POST', '/usage/statistics'],
    ['GET', '/usage'],
    ['GET', '/account'],
    ['GET', '/quota'],
  ];
  for (const [m, p] of paths) {
    const r = await call(m, p, m === 'POST' ? {} : undefined);
    console.log(`\n${m} ${p} -> ${r.status}`);
    console.log('  ', r.body.slice(0, 600).replace(/\n/g, ' '));
  }
})();
