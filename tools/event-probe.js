// 探测内核 /event SSE 的事件格式
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

function baseHeaders(extra) {
  return {
    Authorization: 'Basic ' + Buffer.from(`super-agent:${auth.password}`).toString('base64'),
    Accept: 'application/json',
    ...(extra || {}),
  };
}

function post(p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: p,
        method: 'POST',
        headers: {
          ...baseHeaders(),
          ...sign('POST', p),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(data);
    req.end();
  });
}

// 订阅 /event
function subscribe(onEvent) {
  const p = '/event';
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: p,
      method: 'GET',
      headers: { ...baseHeaders({ Accept: 'text/event-stream' }), ...sign('GET', p) },
    },
    (res) => {
      console.log('event stream status:', res.statusCode, res.headers['content-type']);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          onEvent(raw);
        }
      });
      res.on('end', () => console.log('event stream ended'));
    }
  );
  req.on('error', (e) => console.log('event err:', e.message));
  req.end();
  return req;
}

(async () => {
  const types = new Map();
  const t0 = Date.now();
  const stream = subscribe((raw) => {
    const lines = raw.split('\n');
    let data = '';
    for (const l of lines) {
      if (l.startsWith('data:')) data += l.slice(5).trim();
    }
    if (!data) return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    const t = ev.type || ev.name || '?';
    types.set(t, (types.get(t) || 0) + 1);
    if (t.includes('delta') || t.includes('part') || t.includes('message')) {
      const s = JSON.stringify(ev);
      console.log(`[${Date.now() - t0}ms] ${t} :: ${s.slice(0, 220)}`);
    }
  });

  await new Promise((r) => setTimeout(r, 800));

  const s = await post('/session', { title: 'stream-probe' });
  const sid = JSON.parse(s.body).id;
  console.log('session =', sid);

  const m = await post(`/session/${sid}/message`, {
    model: { providerID: 'NewApi', modelID: 'chat-flash' },
    parts: [{ type: 'text', text: '数到五，每个数字之间换行' }],
  });
  console.log('message status', m.status, 'len', m.body.length);

  await new Promise((r) => setTimeout(r, 3000));
  console.log('\n=== 事件类型统计 ===');
  for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  stream.destroy();
  process.exit(0);
})();
