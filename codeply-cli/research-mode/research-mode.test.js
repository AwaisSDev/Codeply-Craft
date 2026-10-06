'use strict';
// Run: node codeply-cli/research-mode/research-mode.test.js
// Uses fake HTTP servers only; no real Ollama and no real keys.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.OLLAMA_API_KEY;
delete process.env.OLLAMA_MODEL;

const FAKE_KEY = 'fake-test-key-1234567890abcd';
const seen = { local: [], cloud: [] };

function fakeServer(label, requireKey) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen[label].push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
      if (requireKey && req.headers.authorization !== `Bearer ${FAKE_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ name: 'llama3:8b', size: 1, details: { family: 'llama', parameter_size: '8B' } }, { name: 'qwen2.5-coder:7b' }] }));
      }
      if (req.url === '/api/chat') {
        seen[label].push({ chat: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const parts = ['Hel', 'lo ', 'there'];
        let i = 0;
        const tick = () => {
          if (i < parts.length) {
            // Split one JSON line across two writes to exercise buffering.
            const line = JSON.stringify({ message: { role: 'assistant', content: parts[i++] }, done: false }) + '\n';
            res.write(line.slice(0, 10));
            setTimeout(() => { res.write(line.slice(10)); setTimeout(tick, 10); }, 5);
          } else {
            res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
          }
        };
        return tick();
      }
      res.writeHead(404); res.end();
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
  const local = fakeServer('local', false);
  const cloud = fakeServer('cloud', true);
  const lp = await listen(local);
  const cp = await listen(cloud);
  // A closed port stands in for "Ollama is not running".
  const dead = http.createServer();
  const dp = await listen(dead);
  await new Promise((r) => dead.close(r));

  const config = require('../lib/config.js');
  const ai = require('../lib/ai.js');
  const ollama = require('./ollama.js');
  const { preprocess, withSystem } = require('./preprocessor.js');
  const results = [];
  const t = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ': ' + e.message]); } };

  process.env.CODEPLY_RESEARCH_LOCAL_URL = `http://127.0.0.1:${lp}`;
  process.env.CODEPLY_RESEARCH_CLOUD_URL = `http://127.0.0.1:${cp}`;

  await t('preprocessor passes messages through; context only as system text', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    const a = preprocess({ messages: msgs, mode: 'local', model: 'm', researchContext: '' });
    assert.strictEqual(a.messages, msgs); assert.strictEqual(a.system, '');
    assert.strictEqual(withSystem(a), msgs);
    const b = preprocess({ messages: msgs, researchContext: ' testing my own app ' });
    assert.strictEqual(b.system, 'testing my own app');
    assert.deepStrictEqual(withSystem(b), [{ role: 'system', content: 'testing my own app' }, ...msgs]);
  });

  await t('settings persistence round trip (config file)', () => {
    const r = config.saveConfig({ research: { enabled: true, mode: 'local', model: 'llama3:8b', context: 'ctx' } });
    assert.ok(r.ok);
    const rm = config.getConfig().research;
    assert.deepStrictEqual([rm.enabled, rm.mode, rm.model, rm.context], [true, 'local', 'llama3:8b', 'ctx']);
    const raw = JSON.parse(fs.readFileSync(config.configPath, 'utf8'));
    assert.strictEqual(raw.research.model, 'llama3:8b');
    assert.ok(config.configPath.startsWith(tmpHome));
  });

  await t('local ok: lists models via /api/tags', async () => {
    const r = await ollama.listModels({ mode: 'local' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.models.map((m) => m.name), ['llama3:8b', 'qwen2.5-coder:7b']);
  });

  await t('local ok: tokens stream in order to onToken, full text returned', async () => {
    const tokens = [];
    const r = await ai.chat([{ role: 'user', content: 'hi' }], { onToken: (x) => tokens.push(x) });
    assert.ok(r.success, r.error);
    assert.deepStrictEqual(tokens, ['Hel', 'lo ', 'there']);
    assert.strictEqual(r.data.choices[0].message.content, 'Hello there');
    const chatReq = seen.local.find((x) => x.chat).chat;
    assert.strictEqual(chatReq.model, 'llama3:8b'); assert.strictEqual(chatReq.stream, true);
    assert.strictEqual(seen.local.find((x) => x.url === '/api/chat').auth, '');
  });

  await t('research context is sent as a system message, messages unchanged', async () => {
    seen.local.length = 0;
    await ai.chat([{ role: 'user', content: 'hi' }], {});
    const sent = seen.local.find((x) => x.chat).chat.messages;
    assert.deepStrictEqual(sent, [{ role: 'system', content: 'ctx' }, { role: 'user', content: 'hi' }]);
  });

  await t('local not running: exact error text', async () => {
    process.env.CODEPLY_RESEARCH_LOCAL_URL = `http://127.0.0.1:${dp}`;
    const r = await ai.chat([{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(r.success, false); assert.strictEqual(r.error, 'Start Ollama with `ollama serve`');
    const l = await ollama.listModels({ mode: 'local' });
    assert.strictEqual(l.ok, false); assert.strictEqual(l.error, 'Start Ollama with `ollama serve`');
    process.env.CODEPLY_RESEARCH_LOCAL_URL = `http://127.0.0.1:${lp}`;
  });

  await t('cloud missing key: exact error text, no request made', async () => {
    config.saveConfig({ research: { mode: 'cloud', apiKey: '' } });
    const before = seen.cloud.length;
    const r = await ai.chat([{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(r.error, 'Add your Ollama Cloud API key in Settings');
    assert.strictEqual(seen.cloud.length, before);
  });

  await t('cloud invalid key: 401 maps to exact error text', async () => {
    config.saveConfig({ research: { mode: 'cloud', apiKey: 'wrong-key-000000000000' } });
    const r = await ai.chat([{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(r.success, false); assert.strictEqual(r.error, 'Add your Ollama Cloud API key in Settings');
    const l = await ollama.listModels(config.getConfig().research);
    assert.strictEqual(l.error, 'Add your Ollama Cloud API key in Settings');
  });

  await t('cloud valid key: bearer header sent and tokens stream', async () => {
    config.saveConfig({ research: { mode: 'cloud', apiKey: FAKE_KEY } });
    const tokens = [];
    const r = await ai.chat([{ role: 'user', content: 'hi' }], { onToken: (x) => tokens.push(x) });
    assert.ok(r.success, r.error);
    assert.deepStrictEqual(tokens, ['Hel', 'lo ', 'there']);
    assert.ok(seen.cloud.some((x) => x.url === '/api/chat' && x.auth === `Bearer ${FAKE_KEY}`));
  });

  await t('key masking: preview never contains the full key', () => {
    const masked = config.maskKey(FAKE_KEY);
    assert.ok(!masked.includes(FAKE_KEY) && masked.length < FAKE_KEY.length);
    assert.strictEqual(masked, FAKE_KEY.slice(0, 4) + '…' + FAKE_KEY.slice(-4));
  });

  await t('disabled research mode does not take over routing', () => {
    config.saveConfig({ research: { enabled: false } });
    assert.strictEqual(config.getConfig().research.enabled, false);
  });

  local.close(); cloud.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  let failed = 0;
  for (const [s, n] of results) { if (s === 'FAIL') failed++; console.log(s + '  ' + n); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
