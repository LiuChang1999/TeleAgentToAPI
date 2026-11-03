// 多账号功能端到端测试
const fs = require('fs');
const path = require('path');

const BASE = process.env.TA_BASE || 'http://127.0.0.1:18787';
const PWD = process.argv[2] || process.env.TA_ADMIN_PASSWORD;
if (!PWD) { console.error('用法: node tools/test-accounts.js <管理员密码>'); process.exit(1); }

let cookie = '';

async function req(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}

(async () => {
  console.log('--- 登录 ---');
  const login = await req('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: PWD }),
  });
  console.log(login.status, login.text.slice(0, 100));

  console.log('\n--- 当前账号 ---');
  let list = await req('/admin/api/accounts');
  console.log('active:', list.json.active);
  for (const a of list.json.accounts) {
    console.log(`  ${a.id} ${a.name} 剩余${a.daysLeft}天 请求${a.requests}`);
  }

  console.log('\n--- 导入两个账号 ---');
  const files = [
    ['collector/tmp-v1_public_1903019733816377344.json', '测试账号B'],
    ['collector/tmp-v1_public_2056546192992890880.json', '测试账号C'],
  ];
  for (const [f, name] of files) {
    const cred = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = await req('/admin/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ name, credential: cred }),
    });
    console.log(`  ${name}:`, r.status, r.text.slice(0, 120));
  }

  console.log('\n--- 导入后列表 ---');
  list = await req('/admin/api/accounts');
  for (const a of list.json.accounts) {
    console.log(`  ${a.id} ${a.name} 剩余${a.daysLeft}天 ${a.active ? '[当前]' : ''}`);
  }

  const target = list.json.accounts.find((a) => a.name === '测试账号B');
  if (!target) return console.log('找不到测试账号B');

  console.log('\n--- 切换到测试账号B ---');
  const sw = await req(`/admin/api/accounts/${target.id}/activate`, { method: 'POST' });
  console.log('  ', sw.status, sw.text.slice(0, 200));

  console.log('\n--- 切换后当前账号 ---');
  const ov = await req('/admin/api/overview');
  console.log('  account:', JSON.stringify(ov.json.account));

  console.log('\n--- 用默认 key 调一次 ---');
  const keys = await req('/admin/api/keys');
  const key = keys.json.keys[0].key;
  const chat = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'chat-flash',
      messages: [{ role: 'user', content: '只回复四个字：账号B在线' }],
    }),
  });
  const cj = await chat.json().catch(() => ({}));
  console.log('  ', chat.status, JSON.stringify(cj.choices ? cj.choices[0].message.content : cj).slice(0, 200));

  console.log('\n--- 最新日志 ---');
  const logs = await req('/admin/api/logs?limit=3');
  for (const l of logs.json.logs) {
    console.log(`  ${l.accountName || '(无)'} | ${l.model} | ${l.totalTokens} tokens | ${l.ok ? 'ok' : 'fail'}`);
  }
})();
