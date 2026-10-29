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
  vm.runInNewContext(code, { exports, require: () => config, setTimeout, clearTimeout, console, AbortController, DOMException, ...globals });
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
  const iframe = { contentWindow: { postMessage: (message, origin) => posts.push({ message, origin }) }, remove() { this.removed = true; }, classList: { add(c) { (this.classes ??= new Set()).add(c); }, contains(c) { return this.classes?.has(c) ?? false; } } };
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
  // 外观契约钉死当前「茶夜」暗色主题：改主题须同步更新这里与 control.ts
  assert.equal(posts[0].message.appearance.colorScheme, 'dark');
  assert.equal(posts[0].message.appearance.accent, '#e29ba3');
  control.setToken('rotated'); assert.equal(posts[1].message.type, 'misskey:agent-control:update-token');
  assert.equal(control.setPanel('worldbook'), false);
  receive({ origin: config.MSK_BASE, source: iframe.contentWindow, data: { type: 'misskey:agent-control:authenticated' } });
  assert.equal(timers.size, 0);
  // 认证后 iframe 挂 ready 淡入（未认证保持隐藏，错误态不露白帧）
  assert.ok(iframe.classList.contains('ready'));
  assert.equal(control.setPanel('worldbook'), true);
  assert.equal(posts[2].origin, config.MSK_BASE);
  assert.equal(posts[2].message.type, 'misskey:agent-control:set-panel');
  assert.equal(posts[2].message.panel, 'worldbook');
  assert.ok(!JSON.stringify(posts[2].message).includes('secret'));
  assert.equal(iframe.title, 'Aliya · 世界书');
  control.destroy(); assert.equal(listeners.size, 0); assert.equal(iframe.removed, true);
  assert.equal(control.setPanel('rules'), false);
  receive({ origin: config.MSK_BASE, source: iframe.contentWindow, data: { type: 'misskey:agent-control:ready' } });
  assert.equal(posts.length, 3);
});

test('control request accepts replay only with a message id', () => {
  const config = loadMskConfig();
  const bridge = load('control-bridge', config, { Date });
  const now = Date.now();
  const storage = value => ({ getItem: () => JSON.stringify(value) });
  assert.equal(bridge.readControlRequest(storage({ sessionId: 's', action: 'replay', at: now })), null);
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.readControlRequest(storage({ sessionId: 's', action: 'replay', messageId: 'm', at: now })))), {
    sessionId: 's', action: 'replay', messageId: 'm', at: now,
  });
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

test('只读接口网络瞬断重试一次，写接口与超时不重发', async () => {
  const config = loadMskConfig();
  const { MskClient } = load('client', config, { AbortSignal, crypto });
  const calls = [];
  let failures = 1;
  const client = new MskClient('t', async url => {
    calls.push(url);
    if (failures-- > 0) throw new TypeError('Failed to fetch');
    return { status: 200, json: async () => [] };
  });
  assert.deepEqual(await client.timeline('s'), []);
  assert.equal(calls.length, 2, 'timeline 网络失败后重试成功');
  calls.length = 0; failures = 1;
  await assert.rejects(client.post('/agents/sessions/read', { sessionId: 's' }), /网络异常/);
  assert.equal(calls.length, 1, '写接口不重发');
});

test('只读缓存：新鲜期直接命中，过期先回旧值后台刷新，并发合并', async () => {
  const store = new Map();
  const localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const { cachedFetch } = load('cache', Object.assign({}, loadMskConfig(), { fetchCustomEmojis: async () => [] }), { localStorage });
  let n = 0;
  const fetcher = async () => ++n;
  const [a, b] = await Promise.all([cachedFetch('x', 1000, fetcher), cachedFetch('x', 1000, fetcher)]);
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(n, 1, '并发请求只发一次');
  assert.equal(await cachedFetch('x', 1000, fetcher), 1, '新鲜期不请求');
  assert.equal(n, 1);
  const [key] = store.keys();
  store.set(key, JSON.stringify({ at: 0, value: 1 }));
  assert.equal(await cachedFetch('x', 1000, fetcher), 1, '过期先返回旧值');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(n, 2, '后台刷新');
  assert.equal(JSON.parse(store.get(key)).value, 2);
});
