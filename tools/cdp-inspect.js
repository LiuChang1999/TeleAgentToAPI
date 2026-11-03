// 打开登录页后读取 cookie / localStorage / 页面结构，寻找匿名令牌
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9223;
const USER_DIR = path.join(os.tmpdir(), 'edge-cdp2-' + Date.now());

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn(
    EDGE,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DIR}`, '--headless=new',
     '--disable-gpu', '--no-first-run', 'about:blank'],
    { stdio: 'ignore' }
  );

  let v = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch {}
  }
  if (!v) { console.log('CDP 不可用'); child.kill(); return; }

  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => ws.on('open', r));

  await send('Page.enable', {});
  await send('Network.enable', {});
  await send('Page.navigate', { url: 'https://www.teleai.com.cn/master-auth?redirect_uri=https%3A%2F%2Fagent.teleai.com.cn%2FsuperCowork%2Fsapi%2Fcowork%2Fauth%3FappVersion%3D&client_id=Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi' });
  await sleep(8000);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result ? r.result.value : null;
  };

  console.log('=== document.cookie ===');
  console.log(await evalJs('document.cookie'));

  console.log('\n=== localStorage keys ===');
  console.log(await evalJs('JSON.stringify(Object.keys(localStorage))'));

  console.log('\n=== sessionStorage keys ===');
  console.log(await evalJs('JSON.stringify(Object.keys(sessionStorage))'));

  console.log('\n=== 输入框 ===');
  console.log(await evalJs(`JSON.stringify([...document.querySelectorAll('input')].map(i=>({type:i.type,ph:i.placeholder,name:i.name,id:i.id})))`));

  console.log('\n=== 按钮 ===');
  console.log(await evalJs(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean).slice(0,10))`));

  ws.close();
  child.kill();
  process.exit(0);
})();
