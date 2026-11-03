// 用 Edge headless + CDP 抓登录页的真实网络请求
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;
const USER_DIR = path.join(os.tmpdir(), 'edge-cdp-profile-' + Date.now());

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const child = spawn(
    EDGE,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${USER_DIR}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false }
  );

  let version = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {}
  }
  if (!version) {
    console.log('无法连接 CDP');
    child.kill();
    return;
  }
  console.log('浏览器:', version['Browser']);

  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    console.log('没有可用页面');
    child.kill();
    return;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const requests = [];

  function send(method, params) {
    return new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
    if (msg.method === 'Network.requestWillBeSent') {
      const r = msg.params.request;
      requests.push({
        url: r.url,
        method: r.method,
        postData: r.postData ? r.postData.slice(0, 300) : null,
        headers: r.headers,
      });
    }
  });

  await new Promise((r) => ws.on('open', r));
  await send('Network.enable', {});
  await send('Page.enable', {});

  console.log('打开登录页…');
  await send('Page.navigate', {
    url: 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth',
  });
  await sleep(9000);

  console.log('\n=== 捕获的请求 ===');
  for (const r of requests) {
    if (!/teleai|upms|sapi|sms|auth/i.test(r.url)) continue;
    console.log(`${r.method} ${r.url.slice(0, 150)}`);
    if (r.postData) console.log(`   body: ${r.postData}`);
    const authH = Object.entries(r.headers || {}).find(([k]) => /authorization|token|client/i.test(k));
    if (authH) console.log(`   ${authH[0]}: ${String(authH[1]).slice(0, 80)}`);
  }

  fs.writeFileSync('cdp-requests.json', JSON.stringify(requests, null, 2));
  console.log('\n全部请求已保存到 cdp-requests.json，共', requests.length, '条');

  ws.close();
  child.kill();
  process.exit(0);
})();
