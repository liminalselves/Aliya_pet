import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { File } from 'node:buffer';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/chat/view.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function pixels(width = 2, height = 1) {
  const raw = new ArrayBuffer(8 + width * height * 4);
  const header = new DataView(raw);
  header.setUint32(0, width, true); header.setUint32(4, height, true);
  return raw;
}
const image = name => new File(['image'], name, { type: 'image/png' });

// Real ChatView constructor, event handlers and async methods; only browser/native/network boundaries are stubbed.
function harness({ reducedMotion = true } = {}) {
  const elements = new Map(), timers = new Map(), windowEvents = new Map();
  const captures = [], encodings = [], calls = [], revoked = [], urls = [], sent = [], uploads = [], toasts = [];
  let nextTimer = 0;
  class Element {
    constructor(selector = '') {
      this.children = []; this.value = ''; this.textContent = ''; this.hidden = false;
      this.disabled = false; this.readOnly = false; this.dataset = {}; this.events = new Map();
      this.offsetWidth = 320; this.offsetHeight = 64; this.scrollHeight = 64;
      const classes = new Set(selector.split(/[ .]/).filter(Boolean));
      this.classList = {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; },
      };
      const styles = new Map();
      this.style = { setProperty: (key, value) => styles.set(key, value),
        getPropertyValue: key => styles.get(key) ?? '', removeProperty: key => styles.delete(key) };
    }
    querySelector(selector) { return get(selector); }
    querySelectorAll(selector) { return selector === '.attach' ? [get('.attach'), get('.capture-screen')] : []; }
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(fn); }
    dispatch(name, overrides = {}) {
      const event = { preventDefault() { this.prevented = true; }, stopPropagation() {}, ...overrides };
      for (const fn of this.events.get(name) ?? []) fn(event);
      this[`on${name}`]?.(event);
      return event;
    }
    click() { if (!this.disabled) this.dispatch('click'); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute() {}
    focus() { document.activeElement = this; this.onfocus?.(); }
    blur() { document.activeElement = null; this.onblur?.(); }
  }
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element(selector));
    return elements.get(selector);
  };
  const document = {
    body: new Element('body'), activeElement: null,
    createElement(tag) {
      if (tag !== 'canvas') return new Element(tag);
      return { width: 0, height: 0, getContext: () => ({ putImageData() {}, drawImage() {} }),
        toBlob(callback, type, quality) { encodings.push({ callback, type, quality, width: this.width, height: this.height }); } };
    },
  };
  get('.composer-attachment').hidden = true;
  const storageValues = new Map();
  const storage = { getItem: key => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value), removeItem: key => storageValues.delete(key) };
  const controller = {
    busy: false, error: '', messages: [], latest: undefined,
    stop() { this.busy = false; this.onChange?.(); },
    replaceHistory(messages) { this.messages = messages; this.onChange?.(); },
    useProvider() {}, onCancelPerformance() {},
    send(text, file) { sent.push({ text, file }); return Promise.resolve(); },
  };
  class MskClient {
    async listAliyaSessions() { return []; }
    async post() { return {}; }
    async timeline() { return []; }
    uploadFile(...args) { const pending = deferred(); uploads.push({ ...pending, args }); return pending.promise; }
    async messagesAround() { return []; }
  }
  const imports = {
    '../platform': { platform: 'tauri' },
    '../toast': { showToast: (message, options = {}) => toasts.push({ message, kind: options.kind ?? 'info' }) },
    './msk/config': { mskSessionKey: () => 'session' },
    './msk/control-bridge': { CONTROL_REQUEST_KEY: 'control', readControlRequest: store => JSON.parse(store?.getItem('control') ?? 'null') },
    './msk/client': { MskClient, MAX_UPLOAD_BYTES: 20 * 1024 * 1024 },
    './msk/provider': { MskChatProvider: class {} },
    './rendering/renderer': { MskMessageRenderer: class { cancelAll() {} } },
    './rendering/rules': { normalizeRegexRules: () => [] },
    './rendering/emoji': { normalizeCharacterStickers: () => [], buildStickerResolver: () => () => null },
    '@tauri-apps/api/core': { invoke(command, args) {
      calls.push({ command, args });
      if (command !== 'capture_screen') return Promise.resolve();
      const pending = deferred(); captures.push(pending); return pending.promise;
    } },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => imports[name] ?? {}, document,
    window: { innerWidth: 800, matchMedia: () => ({ matches: reducedMotion }),
      addEventListener(name, fn) { if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(fn); } },
    Blob, File, URL: { createObjectURL(blob) { const url = `blob:test-${urls.length}`; urls.push({ url, blob }); return url; },
      revokeObjectURL: url => revoked.push(url) },
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    Uint8Array, Uint8ClampedArray, DataView, ArrayBuffer, AbortController, Error, console,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
  });
  const view = new exports.ChatView(controller, { token: 'token', savedUser: () => ({ id: 'user' }), logout() {} }, () => {}, storage);
  view.screen = 'ready'; view.activeSession = { id: 's1' }; view.setOpen(true); view.syncComposerState();
  const capture = () => { get('.capture-screen').click(); return flush(); };
  const encode = async (index = captures.length - 1, raw = pixels()) => { captures[index].resolve(raw); await flush(); };
  const finish = async (index = encodings.length - 1, blob = new Blob(['jpeg'], { type: 'image/jpeg' })) => {
    encodings[index].callback(blob); await flush(); return blob;
  };
  const windowEvent = async (name, event = {}) => { for (const fn of windowEvents.get(name) ?? []) fn(event); await flush(); };
  return { view, get, controller, storage, captures, encodings, calls, revoked, urls, sent, uploads, timers, toasts,
    capture, encode, finish, windowEvent,
    runTimer(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
  };
}

test('截图进入预览、不上传或发送；保留文本，只禁截图按钮并在完成后恢复', async () => {
  const h = harness(); h.get('textarea').value = '保留这段文字';
  await h.capture();
  assert.equal(h.captures.length, 1);
  assert.equal(h.get('.capture-screen').disabled, true);
  for (const selector of ['.attach', '.remove-attachment', '.send', '.sessions', '.close-window', 'textarea']) {
    assert.equal(h.get(selector).disabled, false, `${selector} remains interactive`);
  }
  assert.equal(h.get('textarea').readOnly, false);
  await h.capture(); assert.equal(h.captures.length, 1, '重复点击不重发正在处理的截图');
  await h.encode(0, pixels(2000, 1000));
  assert.equal(h.encodings[0].width, 1600); assert.equal(h.encodings[0].height, 800);
  assert.equal(h.encodings[0].type, 'image/jpeg'); assert.equal(h.encodings[0].quality, 0.85);
  const blob = await h.finish();
  assert.equal(h.view.attachment.blob, blob); assert.equal(h.view.attachment.name, 'screen.jpg');
  assert.equal(h.get('textarea').value, '保留这段文字'); assert.equal(h.get('.composer-attachment').hidden, false);
  assert.equal(h.get('.capture-screen').disabled, false); assert.equal(h.get('.chat-status').textContent, '');
  assert.equal(h.uploads.length, 0); assert.equal(h.sent.length, 0);
});

test('截图预览可移除并释放URL，不会上传或发送', async () => {
  const h = harness(); await h.capture(); await h.encode(); await h.finish();
  const url = h.view.attachment.url;
  h.get('.remove-attachment').click();
  assert.equal(h.view.attachment, null); assert.equal(h.get('.composer-attachment').hidden, true);
  assert.deepEqual(h.revoked, [url]); assert.equal(h.uploads.length, 0); assert.equal(h.sent.length, 0);
});

test('截图经用户确认才上传发送，成功后清理草稿及预览URL', async () => {
  const h = harness(); await h.capture(); await h.encode(); const blob = await h.finish();
  const url = h.view.attachment.url;
  h.get('.chat-composer').dispatch('submit');
  assert.equal(h.uploads.length, 1); assert.equal(h.sent.length, 0);
  assert.equal(h.uploads[0].args[0], blob); assert.equal(h.uploads[0].args[1], 'screen.jpg');
  const file = { id: 'screen-file', name: 'screen.jpg', type: 'image/jpeg' };
  h.uploads[0].resolve(file); await flush();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].text, '看看我现在在干什么？'); assert.equal(h.sent[0].file, file);
  assert.equal(h.get('textarea').value, ''); assert.equal(h.view.attachment, null);
  assert.equal(h.get('.composer-attachment').hidden, true); assert.deepEqual(h.revoked, [url]);
});

test('空文本才加截图提示语，编码期间新输入的文本不被覆盖', async () => {
  for (const typed of ['', '正在输入']) {
    const h = harness(); await h.capture(); await h.encode();
    h.get('textarea').value = typed; h.get('textarea').dispatch('input');
    await h.finish();
    assert.equal(h.get('textarea').value, typed || '看看我现在在干什么？');
  }
});

const invalidations = {
  '选择图片': h => { const picker = h.get('.attach-input'); picker.files = [image('picked.png')]; picker.dispatch('change'); },
  '粘贴图片': h => h.get('textarea').dispatch('paste', { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => image('pasted.png') }] } }),
  '拖放图片': h => h.get('.chat-composer').dispatch('drop', { dataTransfer: { types: ['Files'], files: [image('dropped.png')] } }),
  '移除附件': h => h.get('.remove-attachment').click(),
  '打开图片选择器': h => h.get('.attach').click(),
  '切换会话': async h => { await h.view.enterSession({ id: 's2' }); },
  '打开会话列表': async h => { h.get('.sessions').click(); await flush(); },
  '直接关闭再重开': h => { h.view.setOpen(false); h.view.setOpen(true); },
  '发送带图消息': h => { h.get('textarea').value = '已经发送'; h.get('.chat-composer').dispatch('submit'); },
  '外部请求开始生成': h => { h.controller.busy = true; h.controller.onChange(); h.controller.busy = false; h.controller.onChange(); },
  '外部定位记录': async h => { h.storage.setItem('control', JSON.stringify({ sessionId: 's1', action: 'navigate', messageId: 'm1', at: 1 })); await h.windowEvent('storage', { key: 'control' }); },
  '外部刷新会话': async h => { h.storage.setItem('control', JSON.stringify({ sessionId: 's1', action: 'refresh', at: 2 })); await h.windowEvent('storage', { key: 'control' }); },
  '外部删除会话': async h => { h.storage.setItem('control', JSON.stringify({ sessionId: 's1', action: 'deleted', at: 3 })); await h.windowEvent('storage', { key: 'control' }); },
  '外部重播失败提示': async h => { h.storage.setItem('control', JSON.stringify({ sessionId: 's1', action: 'replay', messageId: 'missing', at: 4 })); await h.windowEvent('storage', { key: 'control' }); },
};
for (const [name, invalidate] of Object.entries(invalidations)) {
  for (const stage of ['native', 'encoding']) test(`${name}在${stage}阶段立即使旧截图失效`, async () => {
    const h = harness(); const original = image('original.png'); h.view.setAttachment(original); h.get('textarea').value = '原始文本';
    await h.capture(); if (stage === 'encoding') await h.encode();
    await invalidate(h);
    const attachment = h.view.attachment, text = h.get('textarea').value;
    h.get('.chat-status').textContent = '新操作的状态';
    if (stage === 'native') await h.encode(); else await h.finish();
    assert.equal(h.view.attachment, attachment); assert.equal(h.get('textarea').value, text);
    assert.equal(h.get('.chat-status').textContent, '新操作的状态');
    assert.equal(h.get('.capture-screen').disabled, h.view.attachBlocked());
    if (stage === 'native') assert.equal(h.encodings.length, 0, '失效的原生结果不再编码');
  });
}

test('无附件发送通过提交或Enter立即使截图失效，完成发送后旧截图也不能重新填充草稿', async () => {
  for (const via of ['submit', 'Enter']) for (const stage of ['native', 'encoding']) {
    const h = harness(); await h.capture(); if (stage === 'encoding') await h.encode();
    h.get('textarea').value = '纯文本消息';
    if (via === 'submit') h.get('.chat-composer').dispatch('submit');
    else h.get('textarea').dispatch('keydown', { key: 'Enter' });
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].text, '纯文本消息');
    assert.equal(h.get('textarea').value, '');
    if (stage === 'native') await h.encode(); else await h.finish();
    assert.equal(h.view.attachment, null); assert.equal(h.get('textarea').value, '');
    assert.equal(h.get('.capture-screen').disabled, false);
  }
});

test('取消在动态导入完成前已生效，不应继续调用原生截图', async () => {
  const h = harness(); h.get('.capture-screen').click(); h.get('.remove-attachment').click();
  await flush();
  assert.equal(h.captures.length, 0); assert.equal(h.get('.capture-screen').disabled, false);
});

test('关闭动画开始即失效，动画内返回的结果与重开都不能复活旧截图', async () => {
  for (const reopen of [false, true]) {
    const h = harness({ reducedMotion: false }); await h.capture(); await h.encode();
    h.get('.close-window').click();
    assert.equal(h.view.isOpen, true, '150ms退出期间尚未切换open');
    assert.ok(h.view.exitTimer, '确实进入关闭动画');
    assert.equal(h.view.capturing, false, '无需等待动画结束就已失效');
    if (reopen) h.view.setOpen(true);
    await h.finish();
    assert.equal(h.view.attachment, null); assert.equal(h.get('textarea').value, '');
    if (!reopen) { h.runTimer(150); await flush(); assert.equal(h.view.isOpen, false); }
  }
});

test('旧请求finally不解锁新截图；晚到的成功或失败均不能覆盖新截图结果', async () => {
  for (const oldStage of ['native', 'encoding']) for (const oldFails of [false, true]) {
    const h = harness(); await h.capture(); if (oldStage === 'encoding') await h.encode(0);
    h.get('.remove-attachment').click();
    await h.capture(); assert.equal(h.captures.length, 2, '失效后可以立即开始新截图');
    if (oldStage === 'native') {
      if (oldFails) h.captures[0].reject(new Error('旧截图失败')); else h.captures[0].resolve(pixels());
      await flush();
    } else {
      await h.finish(0, oldFails ? null : new Blob(['old'], { type: 'image/jpeg' }));
    }
    assert.equal(h.get('.capture-screen').disabled, true, '旧finally不能清除新请求的锁');
    assert.equal(h.get('.chat-status').textContent, '截图中……');
    await h.encode(1); const blob = await h.finish();
    assert.equal(h.view.attachment.blob, blob); assert.equal(h.get('.capture-screen').disabled, false);
  }
  // New result wins even when the obsolete encoding completes after the new preview is committed.
  const h = harness(); await h.capture(); await h.encode(); h.get('.remove-attachment').click();
  await h.capture(); await h.encode(1); const newest = await h.finish(1);
  await h.finish(0);
  assert.equal(h.view.attachment.blob, newest); assert.equal(h.urls.length, 1);
});

for (const failure of ['native', 'short header', 'invalid pixels', 'encode']) test(`${failure}失败保留文本、原附件与预览URL，且恢复截图按钮`, async () => {
  const h = harness(); const original = image('keep.png'); h.view.setAttachment(original); const attachment = h.view.attachment;
  h.get('textarea').value = '保留文本'; await h.capture();
  if (failure === 'native') { h.captures[0].reject(new Error('权限不足')); await flush(); }
  else if (failure === 'short header') await h.encode(0, new ArrayBuffer(4));
  else if (failure === 'invalid pixels') await h.encode(0, new ArrayBuffer(8));
  else { await h.encode(); await h.finish(0, null); }
  assert.equal(h.view.attachment, attachment); assert.equal(h.view.attachment.blob, original);
  assert.equal(h.get('textarea').value, '保留文本'); assert.equal(h.get('.composer-attachment').hidden, false);
  assert.equal(h.get('.chat-status').textContent, '', '进行中的状态已清除');
  assert.match(h.toasts.at(-1).message, /^截图失败：/); assert.equal(h.toasts.at(-1).kind, 'error');
  assert.equal(h.get('.capture-screen').disabled, false); assert.deepEqual(h.revoked, []);
  assert.equal(h.sent.length, 0); assert.equal(h.uploads.length, 0);
});

test('附件发送上传失败后仍保留草稿，旧截图不能替换可重试的附件', async () => {
  const h = harness(); h.view.setAttachment(image('retry.png')); h.get('textarea').value = '待重发';
  const attachment = h.view.attachment; await h.capture(); await h.encode();
  h.get('.chat-composer').dispatch('submit');
  assert.equal(h.uploads.length, 1); h.uploads[0].reject(new Error('upload failed')); await flush();
  await h.finish();
  assert.equal(h.view.attachment, attachment); assert.equal(h.get('textarea').value, '待重发');
  assert.equal(h.get('.attachment-state').textContent, '上传失败'); assert.deepEqual(h.toasts.at(-1), { message: 'upload failed', kind: 'error' });
  assert.equal(h.get('.capture-screen').disabled, false); assert.equal(h.sent.length, 0);
  h.get('.chat-composer').dispatch('submit'); assert.equal(h.uploads.length, 2);
  assert.equal(h.uploads[1].args[0], attachment.blob); assert.equal(h.uploads[1].args[1], attachment.name);
  const file = { id: 'retried-file', type: 'image/png' };
  h.uploads[1].resolve(file); await flush();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].text, '待重发'); assert.equal(h.sent[0].file, file);
  assert.equal(h.view.attachment, null); assert.equal(h.get('textarea').value, '');
  assert.equal(h.get('.composer-attachment').hidden, true); assert.deepEqual(h.revoked, [attachment.url]);
});

test('session、sequence、attachment身份独立守卫，旧异常也不能改写当前状态', async () => {
  for (const field of ['session', 'sequence', 'attachment']) for (const fails of [false, true]) {
    const h = harness(); await h.capture();
    if (field === 'session') h.view.activeSession = { id: 's2' };
    else if (field === 'sequence') ++h.view.sequence;
    else h.view.attachment = { blob: image('external.png'), name: 'external.png', url: 'blob:external', uploaded: null };
    const attachment = h.view.attachment; h.get('.chat-status').textContent = '当前状态';
    if (fails) h.captures[0].reject(new Error('过期失败')); else h.captures[0].resolve(pixels());
    await flush();
    assert.equal(h.view.attachment, attachment); assert.equal(h.encodings.length, 0);
    assert.equal(h.get('.chat-status').textContent, '当前状态'); assert.equal(h.get('.capture-screen').disabled, false);
  }
});
