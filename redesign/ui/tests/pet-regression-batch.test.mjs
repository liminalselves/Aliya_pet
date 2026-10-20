import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadMskConfig } from './msk-config-helper.mjs';

function loadFile(url, imports = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => imports[id] ?? {}, console,
    setTimeout, clearTimeout, performance, ...globals });
  return exports;
}
const load = (name, imports, globals) => loadFile(new URL(`../src/${name}.ts`, import.meta.url), imports, globals);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('真实纹理上传与渲染器预乘模式一致，图层透明度同时衰减 RGB', async () => {
  const { CubismRenderer } = loadFile(new URL('../../../third_party/cubism-web-sdk/Framework/src/rendering/cubismrenderer.ts', import.meta.url));
  const renderer = Object.create(CubismRenderer.prototype);
  renderer._isPremultipliedAlpha = false;
  renderer._modelColor = { r: 1, g: 1, b: 1, a: 1 };
  let uploadPremultiplied = false, bound = false;
  const stopAfterBinding = new Error('texture binding reached');
  const gl = { drawingBufferWidth: 200, drawingBufferHeight: 300,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37440, createTexture: () => ({}), bindTexture() {},
    pixelStorei: (key, value) => { assert.equal(key, 37440); uploadPremultiplied = value === 1; },
    texImage2D() {}, generateMipmap() {},
  };
  renderer.startUp = () => assert.equal(renderer.isPremultipliedAlpha(), true);
  renderer.bindTexture = () => {
    bound = true;
    assert.equal(uploadPremultiplied, renderer.isPremultipliedAlpha());
    for (const opacity of [0, 0.2, 0.6, 1]) {
      const c = renderer.getModelColorWithOpacity(opacity);
      assert.deepEqual([c.r, c.g, c.b, c.a], [opacity, opacity, opacity, opacity]);
    }
    throw stopAfterBinding; // 只隔离后续动作/物理装配，以上执行真实加载及颜色计算。
  };
  const setting = { getModelFileName: () => 'model.moc3', getPhysicsFileName: () => '',
    getTextureCount: () => 1, getTextureFileName: () => 'texture.png' };
  const { PetModel } = load('pet-model', {
    '@framework/model/cubismusermodel': { CubismUserModel: class {} },
    '@framework/cubismmodelsettingjson': { CubismModelSettingJson: class { constructor() { return setting; } } },
  }, { Image: class {
    addEventListener(name, fn) { if (name === 'load') this.loaded = fn; }
    set src(_) { queueMicrotask(() => this.loaded()); }
  } });
  const pet = Object.create(PetModel.prototype);
  Object.assign(pet, { _fetchArrayBuffer: async () => new ArrayBuffer(0), loadModel() {},
    _model: { saveParameters() {}, update() {}, getDrawableCount: () => 1,
      getDrawableVertices: () => [-0.4, -0.6, 0.4, 0.5] },
    createRenderer() {}, getRenderer: () => renderer,
  });
  await assert.rejects(pet.loadFromSetting(new ArrayBuffer(0), 0, '/', { gl }), error => error === stopAfterBinding);
  assert.equal(bound, true);
});

function resizeHarness(sf = 1.5, mirror = false) {
  const positions = [], sizes = [], anchors = [], saved = [], warnings = [], events = [];
  const settings = load('settings');
  const hooks = new Map();
  let pos = { x: -1200, y: 240 }, size = { width: Math.round(400 * sf), height: Math.round(600 * sf) };
  let sizeReads = 0;
  const pause = async stage => { const hook = hooks.get(stage); if (hook) { hooks.delete(stage); await hook(); } };
  const api = { currentMonitor: async () => { await pause('monitor'); return {
    scaleFactor: sf, workArea: { position: { x: -3000, y: 0 }, size: { width: 3000, height: 2400 } },
  }; }, LogicalSize: class { constructor(width, height) { this.width = width; this.height = height; } },
  PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } } };
  const { PetApp } = load('pet-app', { '@tauri-apps/api/window': api,
    './platform': { platform: 'tauri' }, './settings': { ...settings, saveSettings: s => saved.push({ ...s }) },
  }, { document: { body: { classList: { toggle() {} } } },
    console: { warn: (...args) => warnings.push(args) } });
  const app = Object.create(PetApp.prototype);
  Object.assign(app, { _windowSettingsRevision: 0, _windowSettingsTask: Promise.resolve(), _windowResizeRemainder: { x: 0, y: 0 },
    _settings: { scale: 1, mirror }, _baseFpsCap: 30, _hitAreas: {}, _chatView: null,
    _model: { isReady: () => true, boundsH: 1.1, boundsAspect: 0.5 / 1.1,
      getStaticBounds: () => ({ minX: -0.2, maxX: 0.3, minY: -0.6, maxY: 0.5 }) },
    _baseWindowSize: () => ({ baseW: 400, baseH: 600 }), _cancelSnapAnimation() {}, setFpsCap() {}, setMirrored() {},
    _syncChatAnchor: anchor => anchors.push(anchor), _broadcastSettings() {},
    _tauriWindow: { setAlwaysOnTop: async () => {},
      outerPosition: async () => { await pause('before-position'); return { ...pos }; },
      innerSize: async () => { await pause(sizeReads++ % 2 === 0 ? 'before-size' : 'after-size'); return { ...size }; },
      scaleFactor: async () => { await pause('scale-factor'); return sf; },
      setSize: async requested => {
        events.push('size'); sizes.push(requested);
        size = { width: Math.round(requested.width * sf), height: Math.round(requested.height * sf) };
        await pause('resize');
      },
      setPosition: async target => { events.push('position'); await pause('position'); pos = { ...target }; positions.push(pos); },
    },
  });
  return { app, positions, sizes, anchors, saved, warnings, events,
    change(scale, restore = false) { app.applySettings({ ...app._settings, scale }, restore); },
    hold(stage) {
      const reached = deferred(), release = deferred();
      hooks.set(stage, async () => { reached.resolve(); await release.promise; });
      return { reached: reached.promise, release: release.resolve };
    },
    geometry: () => ({ pos, size }),
    // 按渲染坐标计算屏幕上的静态脚底中心，独立于窗口补偿方法。
    foot: () => ({ x: pos.x + size.width / 2 + (app._settings.mirror ? -1 : 1) * 0.05 * size.height / 1.22 / 1.1,
      y: pos.y + size.height / 2 + 0.6 * size.height / 1.22 / 1.1 }),
  };
}
function nearFoot(actual, expected) {
  assert.ok(Math.abs(actual.x - expected.x) <= 0.51, `foot x: ${actual.x} vs ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= 0.51, `foot y: ${actual.y} vs ${expected.y}`);
}

test('缩放固定实际脚底而非窗口底边，兼容负坐标、DPI、镜像和重复往返', async () => {
  for (const sf of [1, 1.5, 2]) for (const mirror of [false, true]) {
    const h = resizeHarness(sf, mirror), foot = h.foot();
    for (const scale of [0.3, 1.3, 0.7, 1, 0.3, 1.3, 1]) {
      h.change(scale); await h.app._windowSettingsTask;
      nearFoot(h.foot(), foot);
      const { pos, size } = h.geometry(), anchor = h.anchors.at(-1);
      assert.equal(anchor.cssW, size.width / sf); assert.equal(anchor.cssH, size.height / sf);
      assert.equal(h.saved.at(-1).posX, pos.x); assert.equal(h.saved.at(-1).posY, pos.y);
    }
    assert.equal(h.warnings.length, 0);
  }
});

test('快速缩放在所有异步边界保持尺寸/位置成对提交，只应用最新排队请求', async () => {
  for (const stage of ['monitor', 'before-position', 'before-size', 'resize', 'after-size', 'scale-factor', 'position']) {
    const h = resizeHarness(), foot = h.foot(), gate = h.hold(stage);
    h.change(0.3); await gate.reached;
    h.change(0.6); h.change(1.2); h.change(0.8);
    gate.release(); await h.app._windowSettingsTask;
    nearFoot(h.foot(), foot);
    const mutated = ['resize', 'after-size', 'scale-factor', 'position'].includes(stage);
    assert.deepEqual(h.events, mutated ? ['size', 'position', 'size', 'position'] : ['size', 'position'], stage);
    assert.equal(h.sizes.at(-1).height, 480);
    assert.ok(Math.abs(h.app._windowResizeRemainder.x) <= 0.5);
    assert.ok(Math.abs(h.app._windowResizeRemainder.y) <= 0.5);
    assert.equal(h.warnings.length, 0);
  }
});

test('缩放期间切换镜像与顺序操作一致，补偿不混用不同镜像状态', async () => {
  const stages = ['monitor', 'before-position', 'before-size', 'resize', 'after-size', 'scale-factor', 'position'];
  for (const sf of [1, 1.5, 2]) for (const mirror of [false, true]) for (const stage of stages) {
    const serial = resizeHarness(sf, mirror), overlap = resizeHarness(sf, mirror);
    const toggleMirror = h => h.app.applySettings({ ...h.app._settings, mirror: !mirror });
    const mutated = ['resize', 'after-size', 'scale-factor', 'position'].includes(stage);
    if (mutated) {
      serial.change(0.3); await serial.app._windowSettingsTask;
      toggleMirror(serial); await serial.app._windowSettingsTask;
    } else {
      toggleMirror(serial); await serial.app._windowSettingsTask;
      serial.change(0.3); await serial.app._windowSettingsTask;
    }
    const gate = overlap.hold(stage);
    overlap.change(0.3); await gate.reached;
    toggleMirror(overlap); gate.release(); await overlap.app._windowSettingsTask;
    assert.deepEqual(overlap.geometry(), serial.geometry(), `${sf}x mirror=${mirror} stage=${stage}`);
    nearFoot(overlap.foot(), serial.foot());
    assert.equal(overlap.warnings.length, 0);
  }
});

test('启动恢复尊重保存位置；失败不伪造位置成功，也不会阻断后续缩放', async () => {
  const h = resizeHarness();
  Object.assign(h.app._settings, { posX: -1800, posY: -200 });
  h.change(0.7, true); await h.app._windowSettingsTask;
  assert.deepEqual(h.geometry().pos, { x: -1800, y: -200 });
  const setPosition = h.app._tauriWindow.setPosition;
  h.app._tauriWindow.setPosition = async () => { throw new Error('position rejected'); };
  h.change(0.4); await h.app._windowSettingsTask;
  assert.equal(h.warnings.length, 1);
  assert.equal(h.saved.at(-1).posX, -1800);
  assert.equal(h.anchors.length, 1);
  h.app._tauriWindow.setPosition = setPosition;
  h.change(1); await h.app._windowSettingsTask;
  assert.equal(h.anchors.length, 2);
});

function playbackHarness() {
  let expression = null, cancellations = 0, reads = 0;
  const timers = new Map();
  const { ChatPerformance } = load('chat/performance');
  const performance = new ChatPerformance({ expressions: () => ['shy'], actions: () => [], busy: () => false,
    expression: () => expression, express: name => { expression = name; }, clearExpression: () => { expression = null; } });
  const controller = { onCue: cue => performance.cue(cue), onCancelPerformance: () => { cancellations++; performance.cancel(); } };
  class Typewriter {
    typing = false;
    start() { this.typing = true; }
    finish() { this.typing = false; this.onDone?.(); }
    cancel() { this.typing = false; }
  }
  const { ChatView } = load('chat/view', { './typewriter': { Typewriter }, './msk/config': loadMskConfig() }, {
    setTimeout: fn => { const id = {}; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  const view = Object.create(ChatView.prototype);
  Object.assign(view, { controller, screen: 'ready', replyActive: true, replyToken: 'reply-1', playing: true,
    historyVisible: false, segments: [], pageIndex: 0, typewriter: null, cueTimer: null,
    content: { scrollTop: 0, scrollHeight: 100, ownerDocument: { getSelection: () => null } },
    updateHint() {}, reportLayout() {}, measureContentHeight: () => 100,
    clearRendering() {}, hidePanelAnimated() {}, updateLayoutMode() {}, markSessionRead() { reads++; },
  });
  const page = (cue = false) => ({ hidden: true, dataset: cue ? { express: 'shy' } : {},
    classList: { contains: name => cue && name === 'msk-cue', add() {} } });
  const click = () => view.onPanelClick({ target: { closest: () => null }, stopPropagation() {}, preventDefault() {} });
  return { view, performance, controller, page, click, expression: () => expression, reads: () => reads,
    cancellations: () => cancellations, advanceCue() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); },
    timers,
  };
}

test('回复分页期间保留表情；末页读完后释放且逐帧 tick 不会恢复旧表情', () => {
  const h = playbackHarness();
  h.view.segments = [h.page(true), h.page(), h.page()];
  h.view.showPage(0, true); assert.equal(h.expression(), 'shy');
  h.advanceCue(); h.view.typewriter.finish(); assert.equal(h.expression(), 'shy');
  h.click(); h.view.typewriter.finish(); assert.equal(h.expression(), 'shy');
  h.click(); h.performance.tick();
  assert.equal(h.expression(), null); assert.equal(h.performance.active, false);
  assert.equal(h.reads(), 1); assert.equal(h.cancellations(), 1);
});

test('中途收起、替换展示和纯指令末页都释放表情，旧指令计时器被清除', () => {
  for (const end of ['hideReply', 'clearPlayback', 'cue-only']) {
    const h = playbackHarness(); h.view.segments = [h.page(true)]; h.view.showPage(0, true);
    assert.equal(h.expression(), 'shy');
    if (end === 'cue-only') h.advanceCue(); else h.view[end]();
    h.performance.tick();
    assert.equal(h.expression(), null); assert.equal(h.performance.active, false);
    assert.equal(h.timers.size, 0); assert.equal(h.reads(), end === 'cue-only' ? 1 : 0);
    h.view.clearPlayback(); assert.equal(h.cancellations(), 1);
  }
});

test('挥手图层在各帧率连续淡入淡出；打断放下也不跳变', () => {
  const { HandRaiseChannel } = load('overlay');
  for (const fps of [15, 30, 60]) for (const interrupt of [false, true]) {
    const channel = new HandRaiseChannel([], { enabled: 'enabled', forearm: 'forearm', hand: 'hand' });
    const samples = []; const model = { setParameterValueById: (id, v) => { if (id === 'enabled') samples.push(v); } };
    channel.trigger();
    let previous = 0, fadingIn = false, fadingOut = false;
    for (let i = 0; i < fps * 6; i++) {
      if (interrupt && i === fps) channel.release();
      channel.apply(model, 1 / fps);
      const current = samples.at(-1);
      assert.ok(current >= 0 && current <= 1);
      // 打断沿现有 120ms 时间常数回落，比正常放下包络更快，但仍不能跳到端点。
      assert.ok(Math.abs(current - previous) <= (interrupt ? 8 : 4) / fps + 0.002, `${fps}fps: ${previous} -> ${current}`);
      if (current > 0.05 && current < 0.95) {
        if (current > previous) fadingIn = true; else fadingOut = true;
      }
      previous = current;
    }
    assert.ok(fadingIn && fadingOut); assert.equal(samples.at(-1), 0);
  }
});
