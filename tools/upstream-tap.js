// 上游抓包代理：内核 → 本代理(HTTP) → 真实上游(HTTPS)
// 记录请求体与响应体的关键字段，用于确认底层模型
const http = require('http');
const https = require('https');
const fs = require('fs');

const PORT = 9999;
const UPSTREAM_HOST = 'agent.teleai.com.cn';
const UPSTREAM_PREFIX = '';
const LOG = __dirname + '/upstream-tap.log';

function log(obj) {
  fs.appendFileSync(LOG, JSON.stringify(obj) + '\n');
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString());
    } catch {}

    log({
      ts: new Date().toISOString(),
      dir: 'request',
      method: req.method,
      path: req.url,
      model: parsed && parsed.model,
      stream: parsed && parsed.stream,
      messages: parsed && parsed.messages ? parsed.messages.length : null,
      bodyLen: body.length,
    });

    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];

    const upstream = https.request(
      {
        host: UPSTREAM_HOST,
        port: 443,
        path: UPSTREAM_PREFIX + req.url,
        method: req.method,
        headers,
      },
      (upRes) => {
        const isSse = (upRes.headers['content-type'] || '').includes('event-stream');
        res.writeHead(upRes.statusCode, upRes.headers);

        if (isSse) {
          let buf = '';
          upRes.on('data', (c) => {
            buf += c.toString();
            res.write(c);
          });
          upRes.on('end', () => {
            res.end();
            // 从 SSE 里找 model 字段
            const models = new Set();
            for (const line of buf.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const p = line.slice(5).trim();
              if (!p || p === '[DONE]') continue;
              try {
                const j = JSON.parse(p);
                if (j.model) models.add(j.model);
                if (j.system_fingerprint) models.add('fp:' + j.system_fingerprint);
              } catch {}
            }
            // 取最后两个 data 行（通常含 usage 与 finish_reason）
            const dataLines = buf.split('\n').filter((l) => l.startsWith('data:') && l.trim() !== 'data: [DONE]');
            const tail = dataLines.slice(-2).join('\n');
            let usage = null;
            let fps = null;
            for (const l of dataLines) {
              try {
                const j = JSON.parse(l.slice(5).trim());
                if (j.usage) usage = j.usage;
                if (j.system_fingerprint) fps = j.system_fingerprint;
              } catch {}
            }
            log({
              ts: new Date().toISOString(),
              dir: 'response-sse',
              status: upRes.statusCode,
              models: [...models],
              fingerprint: fps,
              usage,
              tail: tail.slice(0, 900),
            });
          });
        } else {
          let buf = '';
          upRes.on('data', (c) => {
            buf += c.toString();
          });
          upRes.on('end', () => {
            res.end(buf);
            let j = null;
            try {
              j = JSON.parse(buf);
            } catch {}
            log({
              ts: new Date().toISOString(),
              dir: 'response',
              status: upRes.statusCode,
              model: j && j.model,
              id: j && j.id,
              fingerprint: j && j.system_fingerprint,
              usage: j && j.usage,
              head: buf.slice(0, 1500),
            });
          });
        }
      }
    );

    upstream.on('error', (e) => {
      log({ ts: new Date().toISOString(), dir: 'error', error: e.message });
      res.writeHead(502).end('upstream error');
    });

    upstream.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log('upstream tap on ' + PORT));
