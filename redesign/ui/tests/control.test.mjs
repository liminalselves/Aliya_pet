import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadMskConfig } from './msk-config-helper.mjs';

function load(name, config, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../src/chat/msk/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => config, setTimeout, clearTimeout, console, ...globals });
  return exports;
}

test('instance origin defaults, normalizes and isolates local credentials', () => {
  const remote = loadMskConfig();
  const local = loadMskConfig(' http://127.0.0.1:3000/ ');
  assert.equal(remote.MSK_BASE, 'https://misskey.liminalselves.top');
  assert.equal(remote.MSK_TOKEN_KEY, 'aliya_msk_token');
  assert.equal(local.MSK_BASE, 'http://127.0.0.1:3000');
  for (const key of ['MSK_TOKEN_KEY', 'MSK_USER_KEY', 'MSK_PENDING_KEY']) assert.notEqual(local[key], remote[key]);
  assert.notEqual(local.mskSessionKey('same-user'), remote.mskSessionKey('same-user'));
  for (const invalid of ['127.0.0.1:3000', 'file:///tmp', 'https://x/path', 'https://u:p@x', 'https://x/?token=a']) assert.throws(() => loadMskConfig(invalid));
});

test('HTTP client and authorization use the configured local instance', async () => {
  const config = loadMskConfig('http://127.0.0.1:3000');
  const calls = [];
  const { MskClient } = load('client', config, { AbortSignal, crypto });
  await new MskClient('local-token', async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ id: 'u' }) }; }).validate();
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/i');
  assert.equal(calls[0].body.i, 'local-token');
});

test('control protocol verifies both origin and frame, rotates tokens and destroys resources', () => {
  const config = loadMskConfig('http://127.0.0.1:3000');
  const listeners = new Set(); const posts = []; const events = []; const timers = new Set();
  const iframe = { contentWindow: { postMessage: (message, origin) => posts.push({ message, origin }) }, remove() { this.removed = true; } };
  const { AgentControlFrame, CONTROL_PANELS } = load('control', config, {
    document: { createElement: () => iframe },
    window: { addEventListener: (_, cb) => listeners.add(cb), removeEventListener: (_, cb) => listeners.delete(cb) },
    setTimeout: cb => { timers.add(cb); return cb; }, clearTimeout: cb => timers.delete(cb),
  });
  assert.equal(Object.keys(CONTROL_PANELS).length, 8);
  const control = new AgentControlFrame({ append() {} }, 'session/1', 'memory', () => 'secret', event => events.push(event));
  assert.equal(iframe.src, 'http://127.0.0.1:3000/agents/embed/session%2F1/memory');
  assert.ok(!iframe.src.includes('secret'));
  const receive = [...listeners][0];
  receive({ origin: 'https://other.test', source: iframe.contentWindow, data: { type: 'misskey:agent-control:ready' } });
  receive({ origin: config.MSK_BASE, source: {}, data: { type: 'misskey:agent-control:ready' } });
  assert.equal(posts.length, 0);
  receive({ origin: config.MSK_BASE, source: iframe.contentWindow, data: { type: 'misskey:agent-control:ready' } });
  assert.equal(posts[0].origin, config.MSK_BASE);
  assert.equal(posts[0].message.token, 'secret');
  assert.equal(posts[0].message.appearance.colorScheme, 'dark');
  control.setToken('rotated'); assert.equal(posts[1].message.type, 'misskey:agent-control:update-token');
  receive({ origin: config.MSK_BASE, source: iframe.contentWindow, data: { type: 'misskey:agent-control:authenticated' } });
  assert.equal(timers.size, 0);
  control.destroy(); assert.equal(listeners.size, 0); assert.equal(iframe.removed, true);
  receive({ origin: config.MSK_BASE, source: iframe.contentWindow, data: { type: 'misskey:agent-control:ready' } });
  assert.equal(posts.length, 2);
});

test('message navigation loads visible surrounding records including an old divider', async () => {
  const config = loadMskConfig();
  const { MskClient } = load('client', config, { AbortSignal, crypto });
  const calls = [];
  const client = new MskClient('test', async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    return { status: 200, json: async () => body.sinceId ? [{ id: '103', role: 'assistant' }, { id: '102', role: 'user' }] : [{ id: '101', role: 'system' }, { id: '100', role: 'assistant' }] };
  });
  const messages = await client.messagesAround('s', '101');
  assert.equal(calls[0].sinceId, '101'); assert.equal(calls[1].untilId, '102');
  assert.equal(messages.map(m => m.id).join(','), '100,101,102,103');
  assert.ok(messages.some(m => m.id === '101' && m.role === 'system'));
});
