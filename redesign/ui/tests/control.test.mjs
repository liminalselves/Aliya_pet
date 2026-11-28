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
  assert.equal(posts[0].message.appearance.fontSize, '13px');
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

test('Android 端托管配置 iframe 传递 15px 适配字号并保持暮石主题色', () => {
  const config = loadMskConfig();
  const listeners = new Set();
  const posts = [];
  const iframe = { contentWindow: { postMessage: message => posts.push(message) }, remove() {}, classList: { add() {} } };
  const { AgentControlFrame } = load('control', config, {
    document: { body: { classList: { contains: name => name === 'platform-android' } }, createElement: () => iframe },
    window: { addEventListener: (_, cb) => listeners.add(cb), removeEventListener: () => {} },
    setTimeout: () => 1, clearTimeout: () => {},
  });
  new AgentControlFrame({ append() {} }, 's1', 'model', () => 'tk', () => {});
  [...listeners][0]({ origin: config.MSK_BASE, source: iframe.contentWindow, data: { type: 'misskey:agent-control:ready' } });
  assert.equal(posts[0].appearance.fontSize, '15px');
  assert.equal(posts[0].appearance.colorScheme, 'dark');
  assert.equal(posts[0].appearance.accent, '#e29ba3');
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

test('renameSession 校验非空并调用 agents/sessions/update 返回新名称', async () => {
  const config = loadMskConfig();
  const { MskClient } = load('client', config, { AbortSignal, crypto });
  const calls = [];
  const client = new MskClient('tk', async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: 's1', name: '新的星海会话' }) };
  });
  await assert.rejects(client.renameSession('s1', '   '), /会话名称不能为空/);
  assert.equal(calls.length, 0);
  const nextName = await client.renameSession('s1', '  新的星海会话  ');
  assert.equal(nextName, '新的星海会话');
  assert.match(calls[0].url, /\/api\/agents\/sessions\/update$/);
  assert.deepEqual(calls[0].body, { i: 'tk', sessionId: 's1', name: '新的星海会话' });
});

test('preconnectMskOrigin 为同一源只注入一次 dns-prefetch 与双模式 preconnect', () => {
  const config = loadMskConfig('http://127.0.0.1:3000');
  const headLinks = [];
  const { preconnectMskOrigin } = load('control', config, {
    document: {
      head: { append: link => headLinks.push(link) },
      createElement: tag => ({ tag }),
    },
  });
  preconnectMskOrigin();
  preconnectMskOrigin();
  assert.equal(headLinks.length, 3);
  assert.deepEqual(
    headLinks.map(l => ({ rel: l.rel, href: l.href, crossOrigin: l.crossOrigin ?? '' })),
    [
      { rel: 'dns-prefetch', href: 'http://127.0.0.1:3000', crossOrigin: '' },
      { rel: 'preconnect', href: 'http://127.0.0.1:3000', crossOrigin: '' },
      { rel: 'preconnect', href: 'http://127.0.0.1:3000', crossOrigin: 'anonymous' },
    ],
  );
});

test('AgentControlFrame 维护连接状态、支持刷新超时并在超时后转入错误态', () => {
  const config = loadMskConfig('http://127.0.0.1:3000');
  const timers = [];
  const cleared = [];
  const events = [];
  const iframe = {
    contentWindow: { postMessage() {} },
    remove() { this.removed = true; },
    classList: { add() {} },
  };
  const { AgentControlFrame } = load('control', config, {
    document: { createElement: () => iframe },
    window: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (cb, ms) => { const entry = { cb, ms, active: true }; timers.push(entry); return entry; },
    clearTimeout: entry => { if (entry) { entry.active = false; cleared.push(entry); } },
  });
  const frame = new AgentControlFrame({ append() {} }, 's1', 'model', () => 'tk', e => events.push(e));
  assert.equal(frame.isLoading, true);
  assert.equal(frame.isAuthenticated, false);
  assert.equal(frame.currentPanel, 'model');
  assert.equal(timers.length, 1);

  frame.refreshTimeout(15_000);
  assert.equal(timers[0].active, false);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 15_000);

  timers[1].cb();
  assert.equal(frame.hasError, true);
  assert.equal(frame.isLoading, false);
  assert.equal(events[0].code, 'LOAD_TIMEOUT');
  frame.refreshTimeout();
  assert.equal(timers.length, 2, '已失败的 frame 不再重启超时计时');
  frame.destroy();
  assert.equal(frame.status, 'destroyed');
});

function createDrawerHarness(platformName = 'tauri') {
  const config = loadMskConfig('http://127.0.0.1:3000');
  const storageMap = new Map();
  const localStorage = {
    getItem: k => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: k => storageMap.delete(k),
  };
  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cs) => cs.forEach(c => set.add(c)),
      remove: (...cs) => cs.forEach(c => set.delete(c)),
      toggle: (c, force) => (force === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (force ? set.add(c) : set.delete(c))),
      contains: c => set.has(c),
    };
  };
  const makeEl = (tag = 'div') => {
    const listeners = new Map();
    const attrs = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      title: '',
      hidden: false,
      disabled: false,
      dataset: {},
      children: [],
      offsetLeft: 0,
      offsetWidth: 40,
      scrollLeft: 0,
      scrollWidth: 100,
      clientWidth: 100,
      classList: makeClassList(),
      append(...nodes) { this.children.push(...nodes); },
      remove() { this.removed = true; },
      focus() { this.focused = true; },
      scrollTo() {},
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, cb) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(cb); },
      removeEventListener(type, cb) { listeners.get(type)?.delete(cb); },
      dispatch(type, event = {}) { for (const cb of [...(listeners.get(type) ?? [])]) cb({ preventDefault() {}, stopPropagation() {}, ...event }); },
      querySelectorAll(sel) { return sel === 'button' ? this.children.filter(c => c.tagName === 'BUTTON') : []; },
      querySelector(sel) { return this._slots?.[sel] ?? null; },
    };
    return el;
  };
  const winListeners = new Map();
  const timers = [];
  const headLinks = [];
  const createdIframes = [];
  const windowObj = {
    addEventListener(type, cb) { (winListeners.get(type) ?? winListeners.set(type, new Set()).get(type)).add(cb); },
    removeEventListener(type, cb) { winListeners.get(type)?.delete(cb); },
    dispatch(type, event = {}) { for (const cb of [...(winListeners.get(type) ?? [])]) cb(event); },
    matchMedia: () => ({ matches: true }),
    setTimeout: (cb, ms) => { const entry = { cb, ms, active: true }; timers.push(entry); return entry; },
    clearTimeout: entry => { if (entry) entry.active = false; },
  };
  let drawerEl = null;
  const documentObj = {
    head: { append: link => headLinks.push(link) },
    body: { classList: makeClassList(), append: el => { drawerEl = el; } },
    createElement(tag) {
      if (tag === 'iframe') {
        const posts = [];
        const iframe = {
          tagName: 'IFRAME',
          posts,
          contentWindow: { postMessage: (message, origin) => posts.push({ message, origin }) },
          classList: makeClassList(),
          remove() { this.removed = true; },
        };
        createdIframes.push(iframe);
        return iframe;
      }
      if (tag === 'dialog') {
        const d = makeEl('dialog');
        const statusEl = makeEl('div');
        const retryEl = makeEl('button'); retryEl.hidden = true;
        const bodyEl = makeEl('div');
        const navEl = makeEl('nav');
        const sessionEl = makeEl('p');
        const reloadEl = makeEl('button');
        const closeEl = makeEl('button');
        d._slots = {
          '.control-status': statusEl,
          '.control-retry': retryEl,
          '.control-body': bodyEl,
          nav: navEl,
          '.control-session': sessionEl,
          '.control-reload': reloadEl,
          '.control-close': closeEl,
        };
        d.open = false;
        d.showModal = () => { d.open = true; };
        d.close = () => { if (!d.open) return; d.open = false; d.dispatch('close'); };
        return d;
      }
      return makeEl(tag);
    },
  };
  const controlExports = load('control', config, {
    document: documentObj,
    window: windowObj,
    setTimeout: windowObj.setTimeout,
    clearTimeout: windowObj.clearTimeout,
  });
  const drawerCode = ts.transpileModule(readFileSync(new URL('../src/chat/msk/control-drawer.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const drawerExports = {};
  const requireShim = spec => {
    if (spec === './control') return controlExports;
    if (spec === './config') return config;
    if (spec === './control-bridge') return { CONTROL_REQUEST_KEY: 'aliya_control_request' };
    if (spec === './client') return { MskClient: class {} };
    if (spec === '../../platform') return { openUrl: async () => true, platform: platformName };
    if (spec === '../../toast') return { showToast() {} };
    if (spec === './control.css') return {};
    throw new Error(`unexpected require: ${spec}`);
  };
  vm.runInNewContext(drawerCode, {
    exports: drawerExports,
    require: requireShim,
    document: documentObj,
    window: windowObj,
    localStorage,
    navigator: { onLine: true },
    ResizeObserver: class { observe() {} },
    setTimeout: windowObj.setTimeout,
    clearTimeout: windowObj.clearTimeout,
    console,
    URL,
  });
  const seedSession = (token, userId, sessionId, name = 'Aliya') => {
    localStorage.setItem(config.MSK_TOKEN_KEY, token);
    localStorage.setItem(config.MSK_USER_KEY, JSON.stringify({ id: userId, username: 'u' }));
    localStorage.setItem(config.mskSessionKey(userId), JSON.stringify({ id: sessionId, name }));
  };
  const emitFromFrame = (iframe, data) => {
    windowObj.dispatch('message', { origin: config.MSK_BASE, source: iframe.contentWindow, data });
  };
  const container = makeEl('div');
  const handle = drawerExports.mountAgentControls(container, async () => {}, () => {});
  return {
    config, localStorage, seedSession, handle, drawer: drawerEl, slots: drawerEl._slots,
    createdIframes, emitFromFrame, timers, headLinks, windowObj,
  };
}

test('会话配置关闭后保留已认证 iframe，再次打开同会话免重连；手动重载才重建', () => {
  const h = createDrawerHarness('tauri');
  h.seedSession('tk1', 'u1', 's1', '星海对话');
  h.handle.sync();

  // 打开并完成认证
  h.handle.open();
  assert.equal(h.createdIframes.length, 1);
  assert.equal(h.drawer.open, true);
  assert.equal(h.drawer.getAttribute('aria-hidden'), null);
  h.emitFromFrame(h.createdIframes[0], { type: 'misskey:agent-control:ready' });
  h.emitFromFrame(h.createdIframes[0], { type: 'misskey:agent-control:authenticated' });
  assert.equal(h.slots['.control-status'].textContent, '');

  // 关闭抽屉：iframe 保活且抽屉挂 .warm 与 aria-hidden
  h.handle.close();
  assert.equal(h.drawer.open, false);
  assert.equal(h.createdIframes[0].removed, undefined);
  assert.equal(h.drawer.classList.contains('warm'), true);
  assert.equal(h.drawer.getAttribute('aria-hidden'), 'true');

  // 再次打开同会话：直接复用原 iframe，不新建也不显示“正在连接”
  h.handle.open();
  assert.equal(h.createdIframes.length, 1);
  assert.equal(h.slots['.control-status'].textContent, '');
  assert.equal(h.drawer.getAttribute('aria-hidden'), null);

  // 点击顶部重载按钮才销毁并新建 iframe
  h.slots['.control-reload'].onclick();
  assert.equal(h.createdIframes[0].removed, true);
  assert.equal(h.createdIframes.length, 2);
});

test('预热中打开抽屉复用在途连接；连接中切换页签不销毁重建，认证后立即切换', () => {
  const h = createDrawerHarness('tauri');
  h.seedSession('tk1', 'u1', 's1');
  h.handle.warm();
  assert.equal(h.createdIframes.length, 1);
  assert.equal(h.drawer.open, false);
  assert.equal(h.drawer.classList.contains('warm'), true);

  // 预热尚未完成时用户打开抽屉：沿用同一 iframe
  h.handle.open();
  assert.equal(h.createdIframes.length, 1);
  assert.equal(h.slots['.control-status'].textContent, '正在连接配置页');

  // 连接进行中点“记忆”页签：不销毁重建
  const memoryTab = h.slots.nav.children.find(b => b.dataset.panel === 'memory');
  memoryTab.onclick();
  assert.equal(h.createdIframes.length, 1);
  assert.equal(memoryTab.getAttribute('aria-pressed'), 'true');

  // 认证落地后立刻经 set-panel 切至“记忆”
  h.emitFromFrame(h.createdIframes[0], { type: 'misskey:agent-control:ready' });
  h.emitFromFrame(h.createdIframes[0], { type: 'misskey:agent-control:authenticated' });
  const setPanelPost = h.createdIframes[0].posts.find(p => p.message.type === 'misskey:agent-control:set-panel');
  assert.ok(setPanelPost);
  assert.equal(setPanelPost.message.panel, 'memory');
});

test('后台预热失败静默清理；切会话或退出登录立即销毁保活 iframe', () => {
  const h = createDrawerHarness('tauri');
  h.seedSession('tk1', 'u1', 's1');
  h.handle.warm();
  assert.equal(h.createdIframes.length, 1);

  // 后台预热出错：静默销毁，不显示错误提示
  h.emitFromFrame(h.createdIframes[0], { type: 'misskey:agent-control:error', code: 'LOAD_TIMEOUT' });
  assert.equal(h.createdIframes[0].removed, true);
  assert.equal(h.drawer.classList.contains('warm'), false);
  assert.equal(h.slots['.control-retry'].hidden, true);

  // 之后打开抽屉会重新创建连接
  h.handle.open();
  assert.equal(h.createdIframes.length, 2);
  h.emitFromFrame(h.createdIframes[1], { type: 'misskey:agent-control:ready' });
  h.emitFromFrame(h.createdIframes[1], { type: 'misskey:agent-control:authenticated' });
  h.handle.close();

  // 切换到新会话：旧会话 iframe 立即销毁
  h.seedSession('tk1', 'u1', 's2', '另一段对话');
  h.handle.sync();
  assert.equal(h.createdIframes[1].removed, true);

  // 预热 s2 后退出登录：s2 iframe 立即销毁
  h.handle.warm();
  assert.equal(h.createdIframes.length, 3);
  h.localStorage.removeItem(h.config.MSK_TOKEN_KEY);
  h.handle.sync();
  assert.equal(h.createdIframes[2].removed, true);
});
