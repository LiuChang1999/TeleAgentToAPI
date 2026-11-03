// 在服务器上验证内核配置是否可读（用 launcher 生成的本地凭据签名）
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname);
const auth = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runtime-auth.json'), 'utf8'));
const PORT = auth.port && auth.port !== 4397 ? auth.port : 18080;

function sign(method, pathq) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = ['local-v1', method.toUpperCase(), pathq, ts, nonce].join('\n');
  const sig = crypto.createHmac('sha256', auth.sessionKey).update(payload).digest('base64url');
  return {
    'X-SA-Sign-Version': 'local-v1',
    'X-SA-Timestamp': ts,
    'X-SA-Nonce': nonce,
    'X-SA-Signature': sig,
  };
}

function call(method, p, body) {
  return new Promise((resolve, reject) => {
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
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const cfg = await call('GET', '/config');
  console.log('GET /config ->', cfg.status);
  if (cfg.status === 200) {
    try {
      const j = JSON.parse(cfg.body);
      console.log('  provider keys:', Object.keys(j.provider || {}));
      console.log('  small_model:', j.small_model);
      const np = (j.provider || {}).NewApi;
      if (np) console.log('  NewApi baseURL:', np.options && np.options.baseURL, '| useSuperAgentAuth:', np.options && np.options.useSuperAgentAuth);
      console.log('  models:', Object.keys((np && np.models) || {}).join(','));
    } catch (e) {
      console.log('  raw:', cfg.body.slice(0, 300));
    }
  } else {
    console.log('  body:', cfg.body.slice(0, 300));
  }

  const sess = await call('POST', '/session', { title: 'linux-probe' });
  console.log('\nPOST /session ->', sess.status, sess.body.slice(0, 160));
  let sid = null;
  try {
    sid = JSON.parse(sess.body).id;
  } catch {}
  if (!sid) return;

  const msg = await call('POST', `/session/${sid}/message`, {
    model: { providerID: 'NewApi', modelID: 'chat-pro' },
    parts: [{ type: 'text', text: '只回复两个字：正常' }],
  });
  console.log('\nPOST /session/message ->', msg.status);
  if (msg.status === 200) {
    const j = JSON.parse(msg.body);
    const parts = (j.data && j.data.parts) || [];
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    const info = (j.data && j.data.info) || {};
    console.log('  回复:', text.slice(0, 200));
    console.log('  tokens:', JSON.stringify(info.tokens || {}));
    console.log('  finish:', info.finish);
    if (info.error) console.log('  error:', JSON.stringify(info.error).slice(0, 300));
  } else {
    console.log('  body:', msg.body.slice(0, 400));
  }
})();
