// 流式性能测试：记录首字延迟与增量到达节奏
const BASE = process.env.TA_BASE || 'http://127.0.0.1:18787';
const KEY = process.argv[2] || process.env.TA_KEY;
if (!KEY) { console.error('用法: node ' + require('path').basename(__filename) + ' <API_KEY> [model]'); process.exit(1); }
const MODEL = process.argv[3] || 'chat-flash';

(async () => {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: '写一段 300 字左右的短文，主题是雨后的清晨。' }],
      stream: true,
    }),
  });
  console.log('HTTP', r.status, '| 首字节', Date.now() - t0, 'ms');

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let first = null;
  let chunks = 0;
  let chars = 0;
  let lastT = t0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        console.log(`[${String(Date.now() - t0).padStart(5)}ms] DONE`);
        continue;
      }
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (delta && delta.content) {
        chunks++;
        chars += delta.content.length;
        if (first === null) {
          first = Date.now() - t0;
          console.log(`[${String(first).padStart(5)}ms] 首字: ${JSON.stringify(delta.content)}`);
        }
        lastT = Date.now();
      }
    }
  }

  const total = Date.now() - t0;
  console.log('---');
  console.log(`首字延迟  : ${first} ms`);
  console.log(`总耗时    : ${total} ms`);
  console.log(`增量块数  : ${chunks}`);
  console.log(`总字符数  : ${chars}`);
  if (first != null && total > first) {
    console.log(`推流速度  : ${(chars / ((total - first) / 1000)).toFixed(1)} 字/秒`);
  }
})();
