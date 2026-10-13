// End-to-end check of the API against fake Upstash and fake Anthropic servers (no real keys needed).
import http from 'node:http';
import assert from 'node:assert/strict';

const store = new Map();
const upstash = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const [cmd, key, ...rest] = JSON.parse(Buffer.concat(chunks).toString());
  let result = null;
  if (cmd === 'HSET') { store.set(rest[0], rest[1]); result = 1; }
  else if (cmd === 'HGET') result = store.get(rest[0]) ?? null;
  else if (cmd === 'HDEL') { result = store.delete(rest[0]) ? 1 : 0; }
  else if (cmd === 'HGETALL') result = [...store.entries()].flat();
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }));
});

const crit = (n) => ({ name: `محك ${n}`, advanced: 'أحلّل بعمق.', proficient: 'أحلّل بصورة صحيحة.', developing: 'أحدّد جزءًا بالطريقة التي تناسب مستواي.', beginner: 'أذكر جزءًا بالطريقة التي تناسب مستواي.' });
let anthropicMode = 'ok';
const anthropic = http.createServer(async (req, res) => {
  for await (const _ of req); // drain
  res.setHeader('Content-Type', 'application/json');
  const text = anthropicMode === 'ok' ? JSON.stringify({ criteria: [crit(1), crit(2), crit(3)] })
    : anthropicMode === 'two' ? JSON.stringify({ criteria: [crit(1), crit(2)] }) : 'not json';
  res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `هذا الناتج:\n${text}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
});

const listen = (s) => new Promise((r) => s.listen(0, () => r(s.address().port)));
const up = await listen(upstash), an = await listen(anthropic);
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${up}`;
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${an}`;
process.env.ANTHROPIC_API_KEY = 'test';
process.env.ACCESS_CODE = 'secret-code';

const { createServer } = await import('../dev-server.js');
const app = createServer(); const port = await listen(app);
const call = async (path, { method = 'GET', body, teacher = 'أ. سارة', code = 'secret-code' } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-access-code': encodeURIComponent(code), 'x-teacher': encodeURIComponent(teacher) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

let r = await call('/api/login', { method: 'POST' }); assert.equal(r.status, 200);
r = await call('/api/login', { method: 'POST', code: 'wrong' }); assert.equal(r.status, 401);
r = await call('/api/goals', { teacher: '' }); assert.equal(r.status, 400);
r = await call('/api/generate', { method: 'POST', body: { goal: 'قصير' } }); assert.equal(r.status, 400);

r = await call('/api/generate', { method: 'POST', body: { goal: 'أن يقيّم الطالب حجة الكاتب ويحدد مواضع القوة والضعف' } });
assert.equal(r.status, 200); assert.equal(r.json.goal.criteria.length, 3); assert.equal(r.json.goal.teacher, 'أ. سارة');
const id = r.json.goal.id;

anthropicMode = 'two';
r = await call('/api/generate', { method: 'POST', body: { goal: 'هدف تجريبي طويل بما يكفي' } }); assert.equal(r.status, 502);
anthropicMode = 'junk';
r = await call('/api/generate', { method: 'POST', body: { goal: 'هدف تجريبي طويل بما يكفي' } }); assert.equal(r.status, 502);

r = await call('/api/goals'); assert.equal(r.json.goals.length, 1);
const edited = r.json.goals[0].criteria.map((c, i) => ({ ...c, name: `معدّل ${i}` }));
r = await call('/api/goals', { method: 'PATCH', body: { id, criteria: edited } }); assert.equal(r.status, 200);
r = await call('/api/goals', { method: 'PATCH', body: { id, criteria: edited }, teacher: 'معلم آخر' }); assert.equal(r.status, 403);
r = await call(`/api/goals?id=${id}`, { method: 'DELETE', teacher: 'معلم آخر' }); assert.equal(r.status, 403);
r = await call('/api/goals'); assert.equal(r.json.goals[0].criteria[0].name, 'معدّل 0');
r = await call(`/api/goals?id=${id}`, { method: 'DELETE' }); assert.equal(r.status, 200);
r = await call('/api/goals'); assert.equal(r.json.goals.length, 0);

console.log('all api checks passed');
for (const s of [upstash, anthropic, app]) s.close();
process.exit(0);
