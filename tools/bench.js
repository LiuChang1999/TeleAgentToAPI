// 接口吞吐测试：用不同输出长度推算纯生成速度
const BASE = process.env.TA_BASE || 'http://127.0.0.1:18787';
const KEY = process.argv[2] || process.env.TA_KEY;
if (!KEY) { console.error('用法: node ' + require('path').basename(__filename) + ' <API_KEY> [model]'); process.exit(1); }

async function chat(model, content, label) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false }),
  });
  const ms = Date.now() - t0;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log(`${label} 失败: ${r.status} ${JSON.stringify(j).slice(0, 150)}`);
    return null;
  }
  const u = j.usage || {};
  const speed = u.completion_tokens ? (u.completion_tokens / (ms / 1000)).toFixed(2) : '-';
  console.log(
    `${label.padEnd(26)} ${String(ms).padStart(6)}ms  ` +
      `prompt=${String(u.prompt_tokens).padStart(6)}  out=${String(u.completion_tokens).padStart(4)}  ` +
      `${speed} tok/s`
  );
  return { ms, ...u };
}

(async () => {
  console.log('模型            耗时      prompt  输出   端到端速度');
  console.log('─'.repeat(72));

  const a = await chat('chat-flash', '用一句话介绍你自己。', 'chat-flash 短输出');
  const b = await chat('chat-flash', '写一段 400 字左右的散文，主题是秋天的傍晚。', 'chat-flash 长输出');
  const c = await chat('chat-pro', '写一段 400 字左右的散文，主题是秋天的傍晚。', 'chat-pro 长输出');
  const d = await chat('chat-flagship', '写一段 400 字左右的散文，主题是秋天的傍晚。', 'chat-flagship 长输出');

  console.log('\n— 推算纯生成速度（扣除固定 prompt 开销）—');
  if (a && b && b.completion_tokens > a.completion_tokens) {
    const dt = (b.ms - a.ms) / 1000;
    const dTok = b.completion_tokens - a.completion_tokens;
    console.log(`chat-flash : (${b.completion_tokens}-${a.completion_tokens}) tokens / (${dt.toFixed(1)}s) = ${(dTok / dt).toFixed(2)} tok/s`);
  }
  if (b && c && c.completion_tokens > b.completion_tokens) {
    const dt = (c.ms - b.ms) / 1000;
    const dTok = c.completion_tokens - b.completion_tokens;
    console.log(`chat-pro   : ${(dTok / dt).toFixed(2)} tok/s`);
  }
})();
