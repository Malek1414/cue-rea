// Local provider tests against a mock OpenAI-compatible server. Run: npm test
// Set CUE_LIVE_URL=http://127.0.0.1:8080/v1 to also hit a real local model.
const assert = require('assert');
const http = require('http');
const { createLLM, probeLocal, thinkFilter } = require('../src/llm');
const { createSTT } = require('../src/stt');

const seen = [];

function sse(res, pieces) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  pieces.forEach((p, i) => res.write('data: ' + JSON.stringify({
    id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta: { content: p }, finish_reason: i === pieces.length - 1 ? 'stop' : null }]
  }) + '\n\n'));
  res.end('data: [DONE]\n\n');
}

const server = http.createServer((req, res) => {
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    body = Buffer.concat(body);
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-a' }, { id: 'mock-b' }] }));
    }
    if (req.url === '/v1/audio/transcriptions') {
      seen.push({ stt: true, auth: req.headers.authorization, bytes: body.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text: ' hello from local whisper ' }));
    }
    if (req.url === '/v1/chat/completions') {
      const json = JSON.parse(body.toString());
      const hasImage = json.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
      seen.push({ model: json.model, hasImage, max_tokens: json.max_tokens, auth: req.headers.authorization });
      if (json.model === 'textonly' && hasImage) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'image input is not supported - hint: you may need to provide the mmproj', type: 'invalid_request_error' } }));
      }
      if (json.model === 'thinker') return sse(res, ['<thi', 'nk>let me reason', ' about it</th', 'ink>\n\nHello', ' world']);
      return sse(res, ['Hel', 'lo', ' local']);
    }
    res.writeHead(404); res.end();
  });
});

const settingsFor = (baseUrl, model, extra = {}) => ({
  provider: 'local', smart: false,
  apiKeys: { local: extra.key || '' },
  models: { local: { fast: model, smart: model } },
  local: { baseUrl, vision: extra.vision !== false, sttBaseUrl: extra.stt || '', sttModel: 'whisper-1' }
});

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function streamAll(llm, imageDataUrl) {
  const tokens = [], notices = [];
  const full = await llm.stream({
    system: 'sys', turns: [{ role: 'user', text: 'hi' }], imageDataUrl,
    onToken: (t) => tokens.push(t), onNotice: (m) => notices.push(m)
  });
  return { full, text: tokens.join(''), notices };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('thinkFilter drops <think> blocks split across any chunk boundary', () => {
  const src = 'A<think>secret</think>B <c> d<thinking? no';
  for (let size = 1; size <= src.length; size++) {
    let out = '';
    const f = thinkFilter((t) => { out += t; });
    for (let i = 0; i < src.length; i += size) f.push(src.slice(i, i + size));
    f.flush();
    assert.strictEqual(out, 'AB <c> d<thinking? no', 'chunk size ' + size);
  }
});

test('local provider streams tokens from an OpenAI-compatible server', async (base) => {
  const llm = createLLM(settingsFor(base, 'plain', { key: 'sk-local' }));
  assert.ok(llm.ready);
  const r = await streamAll(llm, IMG);
  assert.strictEqual(r.text, 'Hello local');
  const req = seen.at(-1);
  assert.strictEqual(req.model, 'plain');
  assert.strictEqual(req.hasImage, true);
  assert.strictEqual(req.max_tokens, 700);
  assert.strictEqual(req.auth, 'Bearer sk-local');
});

test('works with no API key (placeholder bearer)', async (base) => {
  const llm = createLLM(settingsFor(base, 'plain'));
  assert.ok(llm.ready);
  await streamAll(llm, null);
  assert.strictEqual(seen.at(-1).auth, 'Bearer local');
});

test('reasoning text is stripped from stream and return value', async (base) => {
  const r = await streamAll(createLLM(settingsFor(base, 'thinker')), null);
  assert.strictEqual(r.text, 'Hello world');
  assert.strictEqual(r.full, 'Hello world');
});

test('text-only model: retries once without the screenshot and tells the user', async (base) => {
  const before = seen.length;
  const r = await streamAll(createLLM(settingsFor(base, 'textonly')), IMG);
  assert.strictEqual(r.text, 'Hello local');
  assert.strictEqual(r.notices.length, 1);
  const reqs = seen.slice(before);
  assert.deepStrictEqual(reqs.map((x) => x.hasImage), [true, false]);
});

test('vision off: screenshot never sent', async (base) => {
  const llm = createLLM(settingsFor(base, 'plain', { vision: false }));
  assert.strictEqual(llm.vision, false);
  await streamAll(llm, IMG);
  assert.strictEqual(seen.at(-1).hasImage, false);
});

test('probeLocal lists served models; trailing slash in URL is fine', async (base) => {
  const r = await probeLocal(settingsFor(base + '/', 'x'));
  assert.deepStrictEqual(r, { ok: true, baseUrl: base, models: ['mock-a', 'mock-b'] });
});

test('server down: friendly errors from probe and stream', async () => {
  const dead = 'http://127.0.0.1:9/v1';
  const p = await probeLocal(settingsFor(dead, 'x'));
  assert.strictEqual(p.ok, false);
  assert.match(p.message, /Can't reach http:\/\/127\.0\.0\.1:9\/v1/);
  await assert.rejects(streamAll(createLLM(settingsFor(dead, 'x')), null), /Can't reach the local model at http:\/\/127\.0\.0\.1:9\/v1/);
});

test('local STT endpoint is tried first and returns trimmed text', async (base) => {
  const stt = createSTT(settingsFor(base, 'x', { stt: base }));
  assert.deepStrictEqual(stt.providers, ['local']);
  const pcm = Buffer.alloc(16000 * 2); // 1s of silence
  const r = await stt.transcribe(pcm);
  assert.deepStrictEqual(r, { text: 'hello from local whisper', provider: 'local' });
  assert.ok(seen.at(-1).stt && seen.at(-1).bytes > pcm.length);
});

if (process.env.CUE_LIVE_URL) {
  test('LIVE: real local model answers (text + screenshot)', async () => {
    const base = process.env.CUE_LIVE_URL;
    const probe = await probeLocal(settingsFor(base, 'x'));
    assert.ok(probe.ok, probe.message);
    const llm = createLLM(settingsFor(base, probe.models[0] || 'local'));
    const t0 = Date.now();
    const r = await llm.stream({
      system: 'Answer in one short sentence.',
      turns: [{ role: 'user', text: 'What colour is this image? One word.' }],
      imageDataUrl: IMG, onToken: () => {}, onNotice: (m) => console.log('   notice:', m)
    });
    console.log('   live model ' + probe.models.join(',') + ' said: ' + JSON.stringify(r) + ' in ' + (Date.now() - t0) + 'ms');
    assert.ok(r.length > 0 && !/<think>/.test(r));
  });
}

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(base); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
  }
  server.close();
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
});
