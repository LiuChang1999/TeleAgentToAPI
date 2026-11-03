// 更严格的吞吐测试：同一 prompt，只改输出长度要求，用差值扣除固定开销
const BASE = process.env.TA_BASE || 'http://127.0.0.1:18787';
const KEY = process.argv[2] || process.env.TA_KEY;
if (!KEY) { console.error('用法: node ' + require('path').basename(__filename) + ' <API_KEY> [model]'); process.exit(1); }

async function chat(model, content) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false }),
  });
  const ms = Date.now() - t0;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, ms };
  const u = j.usage || {};
  return {
    ok: true,
    ms,
    prompt: u.prompt_tokens || 0,
    out: u.completion_tokens || 0,
    text: (j.choices && j.choices[0].message.content) || '',
  };
}

const SHORT = '写一段 200 字左右的短文，主题是秋天的傍晚，不要用列表。';
const LONG = '写一段 800 字左右的短文，主题是秋天的傍晚，不要用列表。';

(async () => {
  for (const model of ['chat-flash', 'chat-pro', 'chat-flagship']) {
    const a = await chat(model, SHORT);
    const b = await chat(model, LONG);
    if (!a.ok || !b.ok) {
      console.log(`${model}: 请求失败`);
      continue;
    }
    const dt = (b.ms - a.ms) / 1000;
    const dTok = b.out - a.out;
    const gen = dt > 0 && dTok > 0 ? (dTok / dt).toFixed(2) : 'n/a';
    console.log(
      `${model.padEnd(14)} 短: ${String(a.ms).padStart(6)}ms ${String(a.out).padStart(4)}tok | ` +
        `长: ${String(b.ms).padStart(6)}ms ${String(b.out).padStart(4)}tok | ` +
        `差值生成速度 ${gen} tok/s`
    );
  }
})();
