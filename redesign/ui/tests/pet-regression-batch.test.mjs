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
  let decodePremultiplied = false, closed = false, bound = false;
  const stopAfterBinding = new Error('texture binding reached');
  const gl = { drawingBufferWidth: 200, drawingBufferHeight: 300,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37440, createTexture: () => ({}), bindTexture() {},
    // ImageBitmap 上传时 WebGL 忽略预乘标志，预乘只能在解码时完成；这里钉死不二次预乘。
    pixelStorei: (key, value) => { assert.equal(key, 37440); assert.equal(value, 0); },
    texImage2D() {}, generateMipmap() {},
  };
  renderer.startUp = () => assert.equal(renderer.isPremultipliedAlpha(), true);
  renderer.bindTexture = () => {
    bound = true;
    assert.equal(decodePremultiplied, renderer.isPremultipliedAlpha());
    assert.equal(closed, true, '上传后释放解码位图');
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
  }, {
    fetch: async () => ({ ok: true, blob: async () => ({}) }),
    createImageBitmap: async (_, options) => {
      decodePremultiplied = options?.premultiplyAlpha === 'premultiply';
      return { close: () => { closed = true; } };
    },
  });
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
  // set_pet_bounds：位置+尺寸一次原生提交；impl 可被用例替换以模拟 IPC 失败。
  const bounds = { impl: async ({ x, y, w, h }) => {
    await pause('position-before-effect');
    events.push('bounds'); sizes.push({ width: w / sf, height: h / sf });
    size = { width: w, height: h }; pos = { x, y }; positions.push(pos);
    await pause('resize'); await pause('position');
  } };
  const core = { invoke: async (command, args) => { if (command === 'set_pet_bounds') return bounds.impl(args); } };
  const { PetApp } = load('pet-app', { '@tauri-apps/api/window': api, '@tauri-apps/api/core': core,
    './platform': { platform: 'tauri' }, './settings': { ...settings, saveSettings: s => saved.push({ ...s }) },
  }, { document: { body: { classList: { toggle() {}, remove() {} }, dataset: {}, style: {} } },
    window: { get innerWidth() { return size.width / sf; }, get innerHeight() { return size.height / sf; } },
    requestAnimationFrame: fn => setImmediate(() => fn(0)),
    console: { warn: (...args) => warnings.push(args) } });
  const app = Object.create(PetApp.prototype);
  Object.assign(app, { _windowSettingsRevision: 0, _windowSettingsTask: Promise.resolve(), _windowResizeRemainder: { x: 0, y: 0 },
    _settings: { scale: 1, mirror }, _baseFpsCap: 30, _hitAreas: {}, _chatView: null,
    _winPhysX: pos.x, _winPhysY: pos.y, _scaleFactor: sf, _metricsSynced: true,
    _model: { isReady: () => true, boundsH: 1.1, boundsAspect: 0.5 / 1.1,
      getStaticBounds: () => ({ minX: -0.2, maxX: 0.3, minY: -0.6, maxY: 0.5 }) },
    _baseWindowSize: () => ({ baseW: 400, baseH: 600 }), _cancelSnapAnimation() {}, setFpsCap() {}, setMirrored() {},
    // 这些用例验证原生几何补偿（启动恢复、换显示器时仍走这条路径）：不按显示器开足容量，
    // 外窗尺寸跟随比例，每次设置都重新走一次完整补偿。
    _scaleLimitsFrom: () => null,
    _syncChatAnchor: anchor => anchors.push(anchor), _broadcastSettings() {},
    _tauriWindow: { setAlwaysOnTop: async () => {},
      outerPosition: async () => { await pause('before-position'); return { ...pos }; },
      innerSize: async () => { await pause(sizeReads++ % 2 === 0 ? 'before-size' : 'after-size'); return { ...size }; },
      outerSize: async () => ({ ...size }),
      scaleFactor: async () => { await pause('scale-factor'); return sf; },
      setSize: async requested => {
        events.push('size'); sizes.push(requested);
        size = { width: Math.round(requested.width * sf), height: Math.round(requested.height * sf) };
        await pause('resize');
      },
      setPosition: async target => { await pause('position-before-effect'); events.push('position'); pos = { ...target }; positions.push(pos); await pause('position'); },
    },
  });
  // 每次设置都走原生几何补偿路径（不进入固定容量的窗内缩放）。
  Object.defineProperty(app, '_deskCapacityReady', { get: () => false, set() {} });
  /** 位置写入失败（尺寸已生效）：原子提交只改尺寸后拒绝，单独 setPosition 也拒绝。 */
  const failPosition = message => {
    const setPosition = app._tauriWindow.setPosition, original = bounds.impl;
    app._tauriWindow.setPosition = async () => { throw new Error(message); };
    bounds.impl = async args => { await original({ ...args, x: pos.x, y: pos.y }); throw new Error(message); };
    return () => { app._tauriWindow.setPosition = setPosition; bounds.impl = original; };
  };
  return { app, positions, sizes, anchors, saved, warnings, events, bounds, failPosition,
    change(scale, restore = false) { app.applySettings({ ...app._settings, scale }, restore); },
    hold(stage) {
      const reached = deferred(), release = deferred();
      hooks.set(stage, async () => { reached.resolve(); await release.promise; });
      return { reached: reached.promise, release: release.resolve };
    },
    geometry: () => ({ pos, size }),
    // 按渲染坐标计算屏幕上的静态脚底中心，独立于窗口补偿方法。
    foot: () => ({ x: pos.x + size.width / 2 + (app._settings.mirror ? -1 : 1) * 0.05 * size.height / PetApp._renderMarginRatio / 1.1,
      y: pos.y + size.height / 2 + 0.6 * size.height / PetApp._renderMarginRatio / 1.1 }),
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
    // 每次缩放只有一次原子提交；预测命中时补偿不再追加位置写入。
    assert.deepEqual(h.events, mutated ? ['bounds', 'bounds'] : ['bounds'], stage);
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

test('快捷尺寸保留三档循环，两次放大的实际尺寸增量相等', () => {
  const { nextSizePreset, scaleToPercent } = load('settings');
  for (const [minS, maxS] of [[0.15, 2], [0.1, 1.05], [0.24, 3.5]]) {
    const middle = nextSizePreset(minS, minS, maxS);
    const large = nextSizePreset(middle, minS, maxS);
    assert.ok(Math.abs((middle - minS) - (large - middle)) < 1e-12);
    assert.ok(Math.abs(scaleToPercent(middle, minS, maxS) - 55) < 1e-10);
    assert.equal(large, maxS);
    assert.equal(nextSizePreset(large, minS, maxS), minS);
    assert.equal(nextSizePreset(minS + (maxS - minS) * 0.2, minS, maxS), middle);
    assert.equal(nextSizePreset(minS + (maxS - minS) * 0.8, minS, maxS), large);
    assert.equal(nextSizePreset(maxS * 2, minS, maxS), minS);
  }
  assert.equal(nextSizePreset(0.2, 0.2, 0.2), 0.2);
});

test('首次启动默认缩放取设置页滑杆的 40%', async () => {
  const { scaleToPercent, scaleRangeFor, DEFAULT_SCALE_PERCENT } = load('settings');
  for (const sf of [1, 1.25, 1.5, 2]) {
    const h = resizeHarness(sf);
    const scale = await h.app._defaultScale();
    const range = scaleRangeFor(3000 / sf, 2400 / sf);
    const percent = scaleToPercent(scale, range.minS, range.maxS);
    assert.ok(Math.abs(percent - DEFAULT_SCALE_PERCENT) < 0.5, `sf=${sf} percent=${percent}`);
    assert.ok(scale >= range.minS && scale <= range.maxS, `sf=${sf} scale=${scale}`);
  }
});

test('快捷切换按设备范围等步长缩放，连续点击不丢档位且脚底不漂移', async () => {
  for (const sf of [1, 1.5, 2]) {
    const h = resizeHarness(sf), foot = h.foot();
    const { minS } = await h.app._deviceScaleRange();
    h.change(minS); await h.app._windowSettingsTask;
    const heights = [h.geometry().size.height];
    for (let i = 0; i < 2; i++) {
      await h.app._cycleSize(); await h.app._windowSettingsTask;
      heights.push(h.geometry().size.height); nearFoot(h.foot(), foot);
    }
    assert.ok(Math.abs((heights[1] - heights[0]) - (heights[2] - heights[1])) <= 1);
    await h.app._cycleSize(); await h.app._windowSettingsTask;
    assert.equal(h.app.settings.scale, minS);
    const gate = h.hold('resize');
    await h.app._cycleSize(); await gate.reached;
    await Promise.all([h.app._cycleSize(), h.app._cycleSize()]);
    gate.release(); await h.app._windowSettingsTask;
    assert.equal(h.app.settings.scale, minS);
    nearFoot(h.foot(), foot); assert.equal(h.warnings.length, 0);
  }
});

test('缩放补间以静态脚底为锚：任意中间比例脚底像素不动，播完落定撤销补间', () => {
  const { PetApp } = load('pet-app', { './platform': { platform: 'tauri' } });
  const app = Object.create(PetApp.prototype);
  let now = 1000;
  const bounds = { minX: -0.2, maxX: 0.3, minY: -0.6, maxY: 0.5 };
  Object.assign(app, { _wrapWindow: false, _dpr: 1.5, _chatView: null, _canvas: { width: 600, height: 900 },
    _model: { boundsH: 1.1, boundsAspect: 0.5 / 1.1, getStaticBounds: () => bounds } });
  const foot = t => ({ x: t.originX + ((bounds.minX + bounds.maxX) / 2) * t.scale, y: t.originY - bounds.minY * t.scale });
  const natural = app._modelViewportTransform();
  for (const k of [0.4, 0.75, 1.3]) {
    app._scaleTween = { from: natural.scale / 1.5 * k, to: 0, start: null, settled: false };
    const t = app._modelViewportTransform();
    assert.ok(Math.abs(t.scale - natural.scale * k) < 1e-9);
    const a = foot(t), b = foot(natural);
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
  }
  const perf = globalThis.performance.now;
  globalThis.performance.now = () => now;
  try {
    app._scaleTween = { from: 100, to: 200, start: 1000, settled: true };
    now = 1100; const mid = app._scaleTweenValue(now);
    assert.ok(mid > 150 && mid < 200, '缓出：前半程走过一半以上');
    now = 1300; assert.equal(app._scaleTweenValue(now), null); assert.equal(app._scaleTween, null);
    app._scaleTween = { from: 100, to: 200, start: 1000, settled: false };
    assert.equal(app._scaleTweenValue(1300), 200, '原生尺寸未落定前停在终点、不撤销');
  } finally { globalThis.performance.now = perf; }
});

test('启动恢复尊重保存位置；失败不伪造位置成功，也不会阻断后续缩放', async () => {
  const h = resizeHarness();
  Object.assign(h.app._settings, { posX: -1800, posY: -200 });
  h.change(0.7, true); await h.app._windowSettingsTask;
  assert.deepEqual(h.geometry().pos, { x: -1800, y: -200 });
  const restore = h.failPosition('position rejected');
  h.change(0.4); await h.app._windowSettingsTask;
  assert.equal(h.warnings.length, 1);
  assert.equal(h.saved.at(-1).posX, -1800);
  assert.equal(h.anchors.length, 1);
  restore();
  h.change(1); await h.app._windowSettingsTask;
  assert.equal(h.anchors.length, 2);
});

test('聊天 IPC 只上报局部归一化矩形；发送期间移动与 DPI 不会混入旧原点', async () => {
  const calls = [];
  const { PetApp } = load('pet-app', { './platform': { platform: 'tauri' },
    '@tauri-apps/api/core': { invoke: async (_command, payload) => calls.push(payload) },
  }, { window: { innerWidth: 400, innerHeight: 600 } });
  const app = Object.create(PetApp.prototype);
  Object.assign(app, { _metricsSynced: true, _winPhysX: -1200, _winPhysY: 300, _scaleFactor: 1.5,
    _canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 600 }) },
    _model: { isReady: () => false } });
  app._syncChatAnchor();
  app._winPhysX = -2300; app._winPhysY = -500; app._scaleFactor = 2;
  app._syncChatAnchor(); await new Promise(setImmediate);
  assert.deepEqual(calls.map(p => [p.x,p.y,p.w,p.h]), [[0,0,1,1],[0,0,1,1]]);
  assert.ok(Number.isSafeInteger(calls[0].revision)); assert.ok(calls[1].revision > calls[0].revision);
});

test('尺寸副作用已发生时重置仍在补偿之后执行，最终位置意图不会被旧缩放覆盖', async () => {
  for (const stage of ['resize', 'after-size', 'scale-factor', 'position-before-effect', 'position']) {
    const h = resizeHarness(), gate = h.hold(stage);
    h.change(0.3); await gate.reached;
    h.app.resetPosition();
    await new Promise(setImmediate); gate.release(); await h.app._windowSettingsTask; await new Promise(setImmediate);
    const { pos, size } = h.geometry();
    assert.deepEqual(pos, { x: -3000 + Math.round((3000-size.width)/2), y: Math.round((2400-size.height)/2) }, stage);
    assert.equal(h.saved.at(-1).posX, pos.x); assert.equal(h.saved.at(-1).posY, pos.y);
    assert.equal(h.warnings.length, 0);
  }
});

test('拖动与缩放共用几何队列，补偿会重定位待提交的拖动目标且不保存中间位置', async () => {
  for (const sf of [1, 1.5, 2]) for (const stage of ['resize', 'after-size', 'scale-factor', 'position']) {
    const h = resizeHarness(sf), before = h.foot(), gate = h.hold(stage);
    h.app._dragging = true; h.change(0.3); await gate.reached;
    const saved = h.saved.length;
    h.app._moveWindowBy(25, -10); h.app._moveWindowBy(5, 4);
    gate.release(); await h.app._windowSettingsTask; await new Promise(setImmediate);
    nearFoot(h.foot(), { x: before.x + 30*sf, y: before.y - 6*sf });
    assert.equal(h.saved.length, saved, '拖动完成前不持久化缩放中间位置');
    h.app._dragging = false; h.app._persistDesktopPos();
    assert.equal(h.saved.at(-1).posX, h.geometry().pos.x);
    assert.equal(h.warnings.length, 0);
  }
});

test('原生尺寸修改后即使 Promise 拒绝也完成补偿；位置失败的补偿债务先于后续缩放恢复', async () => {
  const h = resizeHarness(), before = h.foot(), originalBounds = h.bounds.impl;
  // 尺寸生效但位置没跟上，且 IPC 仍报错：补偿必须按实测尺寸把脚底拉回。
  h.bounds.impl = async args => { await originalBounds({ ...args, x: args.x + 37, y: args.y - 19 }); throw new Error('resize IPC failed after effect'); };
  h.change(0.4); await h.app._windowSettingsTask;
  nearFoot(h.foot(), before); assert.equal(h.warnings.length, 1);
  h.bounds.impl = originalBounds;
  const restore = h.failPosition('position failed before effect');
  h.change(0.7); await h.app._windowSettingsTask;
  assert.equal(h.warnings.length, 2);
  restore();
  h.change(1.2); await h.app._windowSettingsTask;
  nearFoot(h.foot(), before); assert.equal(h.warnings.length, 2);
});

test('聊天按页锁高取自然高并按 max-height 钳制；测量后恢复约束', () => {
  let measuring = false, naturalHeight = 96, maxHeight = '240px';
  const { ChatView } = load('chat/view', {}, { getComputedStyle: () => ({ maxHeight }), window: { matchMedia: () => ({ matches: true }) } });
  const view = Object.create(ChatView.prototype), styles = new Map();
  view.root = { classList: { add() { measuring = true; }, remove() { measuring = false; } } };
  view.panel = { hidden: false, style: { setProperty(k, v) { styles.set(k, v); }, removeProperty(k) { styles.delete(k); }, getPropertyValue: k => styles.get(k) ?? '' },
    classList: { contains: () => false },
    get offsetHeight() { return measuring ? naturalHeight : 50; } };
  view.morph = null;
  assert.equal(view.lockPanel(), 96); assert.equal(measuring, false);
  assert.equal(styles.get('--chat-panel-height'), '96px');
  naturalHeight = 400;
  assert.equal(view.lockPanel(), 240);
  view.panel.hidden = true;
  assert.equal(view.lockPanel(), 0);
});

test('整条回复在异步渲染期间脱离布局，settled 后才按页显示与量高', async () => {
  const { ChatView } = load('chat/view', {}, { document: { createElement: () => ({ style: {},
    classList: { add() {} }, setAttribute() {}, append() {}, remove() {} }) } });
  const view = Object.create(ChatView.prototype), task = deferred(), children = [];
  let update, syncs = 0, measures = 0;
  Object.assign(view, { playing: false, clearPlayback() { this.playing = false; }, clearRendering() {},
    clearContentAnimation() {}, showPanel() {}, updateHint() {},
    content: { replaceChildren() {}, append(...nodes) { children.push(...nodes); } },
    bindMessage(_message, _target, _segmented, onUpdate) { update = onUpdate; return { settled: task.promise }; },
    resyncPages() { syncs++; }, reportLayout() { measures++; } });
  view.showReply({ id: 'multi-page', role: 'assistant' });
  assert.equal(children[1].hidden, true);
  update(); update();
  assert.equal(syncs, 0); assert.equal(measures, 0);
  task.resolve(); await task.promise; await new Promise(setImmediate);
  assert.equal(children[1].hidden, false); assert.equal(view.playing, true); assert.equal(syncs, 1);
});

test('面板高度变化从上次高度补间，补间中途与隐藏态不改基准', () => {
  const { ChatView } = load('chat/view', {}, { window: { matchMedia: () => ({ matches: false }) }, document: { timeline: { currentTime: 1000 } } });
  const view = Object.create(ChatView.prototype), animations = [];
  view.panel = { hidden: false, classList: { contains: () => false },
    animate(frames) { const a = { frames, cancel() {} }; animations.push(a); return a; } };
  Object.assign(view, { morph: null, panelHeight: 0 });
  view.onPanelResize(120);
  assert.equal(animations.length, 0); assert.equal(view.panelHeight, 120);
  view.onPanelResize(200);
  assert.deepEqual(JSON.parse(JSON.stringify(animations[0].frames)), [{ height: '120px' }, { height: '200px' }]);
  assert.equal(animations[0].startTime, 1000);
  view.onPanelResize(160);
  assert.equal(animations.length, 1); assert.equal(view.panelHeight, 200);
  animations[0].onfinish(); assert.equal(view.morph, null);
  view.panel.hidden = true; view.onPanelResize(0);
  assert.equal(view.panelHeight, 0);
  view.panel.hidden = false; view.onPanelResize(150);
  assert.equal(animations.length, 1);
});

test('等待回复时停止键可用、状态行让位给占位提示，结束后复位并重新上报高度', () => {
  const { ChatView } = load('chat/view');
  const view = Object.create(ChatView.prototype), elements = new Map(), measured = [];
  Object.assign(view, { screen: 'connect', lastBusy: false, status: { textContent: '' },
    controller: { busy: true }, notify() {}, applyControlRequest() {},
    get(selector) { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); },
    reportLayout() { measured.push([this.status.textContent, this.get('.stop').disabled]); } });
  view.changed();
  view.controller.busy = false;
  view.changed();
  assert.deepEqual(measured, [['', false], ['', true]]);
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
    updateHint() {}, reportLayout() {}, lockPanel: () => 100,
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

test('仅含配图的回复被隐藏后收起空白面板，不误报已读', () => {
  const h = playbackHarness();
  let hidden = false;
  h.view.content.querySelectorAll = () => [];
  h.view.hidePanelAnimated = () => { hidden = true; };
  h.view.resyncPages();
  assert.equal(hidden, true);
  assert.equal(h.view.replyActive, false);
  assert.equal(h.view.playing, false);
  assert.equal(h.reads(), 0);
  assert.equal(h.cancellations(), 1);
});

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

for (const platform of ['tauri', 'android', 'web']) {
  test(`聊天设置入口与会话配置分流且不提交消息（${platform}）`, async () => {
    const calls = [], elements = new Map();
    const root = { innerHTML: '', querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { hidden: false, addEventListener() {} });
      return elements.get(selector);
    } };
    const { ChatView } = load('chat/view', {
      './msk/config': loadMskConfig(),
      '../platform': { platform, shellAction: action => calls.push(action) },
      '@tauri-apps/api/core': { invoke: (command, args) => { calls.push([command, args.target]); return Promise.resolve(); } },
    }, { document: { createElement: () => root, body: { append() {} } }, window: { addEventListener() {} } });
    ChatView.prototype.bootstrap = async () => {}; // 只隔离网络初始化，使用真实构造器与按钮处理器。
    const view = new ChatView({}, {}, () => {});
    const config = view.get('.session-config'), settings = view.get('.app-settings');
    assert.match(root.innerHTML, /class="session-config"[^>]*>配置<\/button><button type="button" class="app-settings"[^>]*>设置<\/button>/);
    assert.equal(settings.hidden, platform === 'web');
    assert.equal(config.hidden, platform === 'web');
    settings.onclick(); config.onclick();
    await new Promise(resolve => setImmediate(resolve));
    if (platform === 'tauri') assert.deepEqual(calls, [['show_settings', 'main'], ['show_settings', 'session-control']]);
    else assert.deepEqual(calls, platform === 'android' ? ['open-settings', 'open-session-control'] : []);
  });
}

test('Android 气泡复用画布顶部余量：外窗收紧但人物位置、大小和三行气泡空间不变', () => {
  const { PetApp } = load('pet-app', {
    './platform': { platform: 'android', androidShell: () => null },
    './dialogue/bubble-fit': load('dialogue/bubble-fit'),
  });
  const bounds = { minX: -0.2, maxX: 0.3, minY: -0.6, maxY: 0.5 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  for (const scale of [0.15, 0.4, 0.8, 1.6]) for (const dpr of [1, 2.75]) {
    const baseH = 675 * 1.18 * scale, contentScale = baseH / 1.30 / 1.1;
    const app = Object.assign(Object.create(PetApp.prototype), {
      _wrapWindow: true, _settings: { scale }, _scaleTween: null, _dpr: dpr,
      _originCssX: -120, _originCssY: 650, _contentScaleCss: contentScale,
      _model: { isReady: () => true, boundsH: 1.1, boundsAspect: 0.5 / 1.1,
        getStaticBounds: () => bounds, getDynamicBounds: () => bounds },
    });
    const oldBottom = app._originCssY - (bounds.minY + bounds.maxY) / 2 * contentScale + baseH / 2;
    const headY = app._originCssY - bounds.maxY * contentScale;
    const r = app._fixedWindowRect();
    assert.ok(r.h < baseH + 116 - 1, '必须缩小实际外窗，而不是仅修改气泡样式');
    assert.ok(r.h >= baseH, '不裁减人物动作区域');
    near(r.y + r.h, oldBottom);
    near(r.w, baseH * 0.5 / 1.1);
    assert.ok(headY - r.y >= 116 - 1e-6, '保留三行气泡所需高度、头部间隙和顶部边距');
    app._appliedRectX = r.x; app._appliedRectY = r.y;
    const t = app._modelViewportTransform();
    near(t.scale, contentScale * dpr);
    for (const [x, y] of [[bounds.minX, bounds.maxY], [0.05, bounds.minY]]) {
      near(r.x + (t.originX + x * t.scale) / dpr, app._originCssX + x * contentScale);
      near(r.y + (t.originY - y * t.scale) / dpr, app._originCssY - y * contentScale);
    }
    const el = { style: { setProperty() {} }, offsetWidth: 240, offsetHeight: 76, textContent: '第一行\n第二行\n第三行' };
    app._bubble = { isActive: true, el };
    app._canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: r.w, height: r.h }) };
    app._positionBubble();
    const top = Number.parseFloat(el.style.top);
    assert.ok(top >= 4);
    assert.ok(top + app._bubbleFitH <= r.h, '多行气泡不超出窗口');
    const font = Number.parseFloat(el.style.fontSize);
    assert.ok(font >= 11 && font <= 30, '字号随人物缩放并钳在可读范围');
    assert.ok(top + app._bubbleFitH + font * 0.3 <= headY - r.y + 0.51, '不挤占人物头部');
    const fixed = app._fixedWindowRect();
    app._bubble.isActive = false;
    assert.deepEqual(app._fixedWindowRect(), fixed, '气泡显隐不反复调整窗口表面');
  }
});

test('独立原生气泡取消人物气泡带，保留动作余量、脚底与缩放补间的头顶锚点', () => {
  const shell = { setDialogueBubble() {} };
  const fit = load('dialogue/bubble-fit');
  const { PetApp } = load('pet-app', { './platform': { platform: 'android', androidShell: () => shell }, './dialogue/bubble-fit': fit });
  const bounds = { minX: -0.2, maxX: 0.3, minY: -0.6, maxY: 0.5 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  for (const scale of [0.15, 0.4, 0.8, 1.6]) for (const dpr of [1, 2.75]) {
    const baseH = 675 * 1.18 * scale, s = baseH / 1.30 / 1.1;
    const sent = [];
    const app = Object.assign(Object.create(PetApp.prototype), {
      _wrapWindow: true, _settings: { scale }, _scaleTween: null, _dpr: dpr, _screenW: 400, _screenH: 800,
      _originCssX: -120, _originCssY: 650, _contentScaleCss: s,
      _model: { isReady: () => true, boundsH: 1.1, boundsAspect: 0.5 / 1.1,
        getStaticBounds: () => bounds, getDynamicBounds: () => bounds },
      _androidBubble: { sync: (...args) => sent.push(args), hide: () => sent.push('hide') },
      _bubble: { isActive: true, el: { textContent: '独立气泡不会被人物窗口裁掉' } },
    });
    const r = app._fixedWindowRect();
    near(r.h, baseH);
    near(r.y + r.h, 650 - (bounds.minY + bounds.maxY) / 2 * s + baseH / 2);
    app._appliedRectX = r.x; app._appliedRectY = r.y;
    app._canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: r.w, height: r.h }) };
    const t = app._modelViewportTransform();
    near(r.y + (t.originY - bounds.maxY * t.scale) / dpr, 650 - bounds.maxY * s);
    near(t.scale / dpr, s);
    app._scaleTweenValue = () => s * 0.7;
    app._positionBubble();
    const shown = app._modelViewportTransform();
    near(sent.at(-1)[2], (shown.originY - bounds.maxY * shown.scale) / dpr);
    // 独立气泡窗不受人物窗裁切：可用宽只受屏幕限制；字号随人物当前显示大小（含补间）。
    near(sent.at(-1)[3], 400 - 16); near(sent.at(-1)[4], 400);
    near(sent.at(-1)[5], fit.bubbleFontFor(scale * 0.7));
    app._bubble.isActive = false; app._positionBubble();
    assert.equal(sent.at(-1), 'hide');
    assert.deepEqual(app._fixedWindowRect(), r, '气泡显隐不重配人物窗口');
  }
});

test('独立气泡静止不重复 IPC，动作限频，翻页、淡出和取消立即同步', () => {
  let now = 0;
  const calls = [];
  const { AndroidDialogueBubble } = load('dialogue/android-bubble', {}, {
    performance: { now: () => now }, getComputedStyle: () => assert.fail('样式由气泡页面直接加载，不在桥接中重画'),
  });
  const bubble = new AndroidDialogueBubble(json => calls.push(JSON.parse(json)));
  bubble.sync('第一页', 100, 20, 260, 500);
  for (let i = 0; i < 60; i++) { now += 16; bubble.sync('第一页', 100, 20, 260, 500); }
  assert.equal(calls.length, 1, '静止气泡没有逐帧通信或重读 CSS');
  now = 1000; bubble.sync('第一页', 100, 22, 260, 500);
  now = 1016; bubble.sync('第一页', 100, 24, 260, 500);
  assert.equal(calls.length, 2, '动作锚点变化限频');
  bubble.sync('第二页\n<纯文本>', 100, 24, 260, 500);
  assert.equal(calls.length, 3, '翻页不受动作限频影响');
  assert.equal(calls.at(-1).text, '第二页\n<纯文本>');
  assert.equal(calls.at(-1).viewportWidth, 260);
  assert.equal(calls.at(-1).viewportHeight, 500);
  bubble.close(); bubble.close();
  assert.equal(calls.length, 4); assert.equal(calls.at(-1).closing, true);
  bubble.sync('第二页\n<纯文本>', 100, 24, 260, 500);
  assert.equal(calls.length, 5, '相同台词也能打断淡出并立即恢复');
  bubble.hide(); bubble.hide();
  assert.equal(calls.length, 6); assert.equal(calls.at(-1).text, '');
});

test('独立气泡复用原 DialogueBubble 的安全文本、翻页动效与淡出，不另设字体或外观', () => {
  const classes = new Set();
  const el = { id: '', style: { removeProperty() {} }, textContent: '', offsetHeight: 60,
    // 适配会把换行宽度写回 style.width，这里让 offsetWidth 跟随它（真浏览器同样如此）。
    get offsetWidth() { return Number.parseFloat(this.style.width) || 200; },
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) } };
  const { DialogueBubble } = load('dialogue/bubble', {}, { document: { createElement: () => el } });
  const bubble = new DialogueBubble({ appendChild() {} });
  const { createBubbleRenderer } = load('dialogue/bubble-window', {
    './bubble-fit': load('dialogue/bubble-fit'),
  });
  const render = createBubbleRenderer(bubble);
  const size = render({ text: '<纯文本>\n第二行', viewportWidth: 100, viewportHeight: 200 });
  assert.equal(el.textContent, '<纯文本>\n第二行');
  assert.equal(classes.has('turn'), false, '首次显示保留原来的弹入');
  // 可用宽 100px → 94px 换行；默认 20px 字号时四周留 0.3em=6px，窗口宽 = 气泡宽 + 12。
  assert.equal(size.width, 106, '窗口随气泡实际宽度收紧');
  assert.equal(size.bottom, 66, '气泡底边取实际高度');
  assert.equal(el.style.fontSize, '20px', '字号由人物页传入，缺省 20');
  const small = render({ text: '小字', viewportWidth: 100, viewportHeight: 200, font: 12 });
  assert.equal(el.style.fontSize, '12px', '人物缩小时字号随之变小');
  assert.equal(small.bottom, 4 + 60, '边距随字号等比（0.3em 取整）');
  render({ text: '翻页', viewportWidth: 100, viewportHeight: 200 });
  assert.equal(classes.has('turn'), true, '翻页仍走原 turn 样式');
  render({ closing: true });
  assert.equal(classes.has('closing'), true);
  render({ text: '翻页', viewportWidth: 100, viewportHeight: 200 });
  assert.equal(classes.has('closing'), false, '打断淡出不留下隐藏计时器');
  render({ text: '' });
  assert.equal(el.style.display, 'none');
  for (const prop of ['font', 'fontFamily', 'background', 'color', 'border', 'borderRadius', 'boxShadow']) {
    assert.equal(el.style[prop], undefined, `${prop} 必须保留原 pet.css 定义`);
  }
});

test('Android 左下角贴边在松手时保存终点，进入 App 打断动画也不丢位置', () => {
  const saved = [], prefs = [], animations = [];
  const settings = load('settings');
  const shell = {
    getMetrics: () => JSON.stringify({ screenW: 400, screenH: 800 }),
    setPref: (key, value) => prefs.push([key, value]),
    animateWindowTo: (x, y, duration) => animations.push({ x, y, duration }),
  };
  const { PetApp } = load('pet-app', {
    './platform': { platform: 'android', androidShell: () => shell },
    './settings': { ...settings, saveSettings: value => saved.push({ ...value }) },
  }, { window: { matchMedia: () => ({ matches: false }) } });
  const app = Object.create(PetApp.prototype);
  Object.assign(app, {
    _wrapWindow: true, _settings: { ...settings.DEFAULT_SETTINGS, snapEdges: true },
    _originCssX: 30, _originCssY: 760, _appliedRectX: -50, _appliedRectY: 500,
    _contentScaleCss: 100, _rectInited: true, _nativeSnapping: false, _scaleTween: null,
    _model: { getStaticBounds: () => ({ minX: -0.2, maxX: 0.2, minY: -1, maxY: 1 }) },
    _cancelSnapAnimation() {},
  });
  app._onDragFinishedAndroid();
  assert.deepEqual(prefs, [['petX', '20'], ['petY', '700']], '必须在原生动画结束回调之前双写最终原点');
  assert.equal(saved.at(-1).posX, 20); assert.equal(saved.at(-1).posY, 700);
  assert.equal(animations.length, 1);
});

for (const entry of ['resume', 'startup']) {
  test(`Android 主界面${entry}不把旧坐标写回悬浮窗存档`, () => {
    const storage = new Map();
    const settings = load('settings', {}, {
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    });
    const shell = {
      getMetrics: () => JSON.stringify({ screenW: 400, screenH: 800 }),
      setPref() {},
    };
    const { PetApp } = load('pet-app', {
      './platform': { platform: 'android', androidShell: () => shell }, './settings': settings,
    });
    const stale = { ...settings.DEFAULT_SETTINGS, posX: 360, posY: 360, snapEdges: false };
    settings.saveSettings(stale);
    const makeApp = wrap => Object.assign(Object.create(PetApp.prototype), {
      _wrapWindow: wrap, _settings: { ...stale }, _baseFpsCap: 30, _hitAreas: {}, _canvas: { style: {} },
      _originCssX: stale.posX, _originCssY: stale.posY, _appliedRectX: 280, _appliedRectY: 160,
      _contentScaleCss: 100, _rectInited: false, _model: null, _scaleTween: null,
      _coordination: { activity() {} }, _chatBackground: { apply() {}, setStill() {} },
      _cancelSnapAnimation() {}, setPaused() {}, _reloadAfterContextLoss() {},
    });
    // 主界面 WebView 留在后台，悬浮窗是另一个持有同一份存储的实例。
    const main = makeApp(false), overlay = makeApp(true);
    for (const target of [{ x: 30, y: 700 }, { x: 120, y: 650 }]) {
      overlay.onNativeDragEnd(target.x - overlay._originCssX, target.y - overlay._originCssY, 0, true);
      if (entry === 'resume') main.onShellEvent('resume');
      else main.applySettings({ ...stale }, true); // 主界面异步加载完成时也不能回写初始化快照。
      assert.deepEqual([settings.loadSettings().posX, settings.loadSettings().posY], [target.x, target.y]);
      assert.deepEqual([main.settings.posX, main.settings.posY], [target.x, target.y]);
      const restored = makeApp(true);
      restored.applySettings(settings.loadSettings(), true);
      assert.deepEqual([restored._originCssX, restored._originCssY], [target.x, target.y], '退出后新悬浮窗恢复最后拖动位置');
      main.applySettings({ ...main.settings, batterySaver: true }, false);
      assert.equal(settings.loadSettings().batterySaver, true, '其他设置仍正常保存');
      assert.deepEqual([settings.loadSettings().posX, settings.loadSettings().posY], [target.x, target.y]);
    }
  });
}

test('真实拖动收尾不持久化尺寸已生效但补偿失败的位置', async () => {
  for (const sf of [1, 1.5, 2]) {
    const h = resizeHarness(sf), before = h.foot();
    h.app._settings.snapEdges = false; h.app._snapAnimToken = 0; h.app._dragging = true;
    const restore = h.failPosition('position failed before effect');
    h.change(0.3); await h.app._windowSettingsTask;
    assert.ok(h.app._windowResizeRecovery, '失败后必须保留补偿债务');
    const saved = h.saved.length;
    h.app._onDragFinished(); h.app._dragging = false;
    await new Promise(setImmediate);
    assert.equal(h.saved.length, saved, '真实收尾不得保存尚未补偿的原点');
    restore();
    h.change(1); await h.app._windowSettingsTask;
    nearFoot(h.foot(), before);
    assert.equal(h.saved.at(-1).posX, h.geometry().pos.x);
    assert.equal(h.saved.at(-1).posY, h.geometry().pos.y);
  }
});

test('重置位置已生效但 IPC 拒绝后，下一次真实拖动不跳回旧原点', async () => {
  for (const sf of [1, 1.5, 2]) for (const mirror of [false, true]) {
    const h = resizeHarness(sf, mirror), win = h.app._tauriWindow, setPosition = win.setPosition;
    h.app._settings.snapEdges = false; h.app._snapAnimToken = 0;
    win.setPosition = async target => { await setPosition(target); throw new Error('position IPC failed after effect'); };
    h.app.resetPosition(); await h.app._windowSettingsTask;
    const reset = { ...h.geometry().pos };
    win.setPosition = setPosition; h.app._dragging = true;
    h.app._moveWindowBy(10, -4); await h.app._windowSettingsTask;
    h.app._onDragFinished(); h.app._dragging = false;
    await new Promise(setImmediate);
    const expected = { x: reset.x + 10 * sf, y: reset.y - 4 * sf };
    assert.deepEqual(h.geometry().pos, expected, `${sf}x mirror=${mirror}`);
    assert.equal(h.saved.at(-1).posX, expected.x);
    assert.equal(h.saved.at(-1).posY, expected.y);
  }
});

test('Windows 固定容量外窗：缩放只改窗内舞台，脚底浮点不动，反向输入从当前显示比例继续', () => {
  const W = 800, H = 1200;
  const { PetApp } = load('pet-app', { './platform': { platform: 'tauri' }, './settings': { saveSettings() {} } },
    { window: { innerWidth: W, innerHeight: H, devicePixelRatio: 1 } });
  const app = Object.create(PetApp.prototype);
  const bounds = { minX: -0.2, maxX: 0.3, minY: -0.6, maxY: 0.5 };
  const queued = [], anchors = [];
  const stage = { style: {} };
  Object.assign(app, { _wrapWindow: false, _dpr: 1, _chatView: null, _deskScale: null, _deskCapacityReady: true,
    _stageKey: '', _settings: { scale: 1, mirror: false }, _scaleFactor: 1, _winPhysX: 0, _winPhysY: 0,
    _canvas: { width: 400, height: 600, parentElement: stage },
    _model: { isReady: () => true, boundsH: 1.1, boundsAspect: 0.5 / 1.1, getStaticBounds: () => bounds },
    _baseWindowSize: () => ({ baseW: 400, baseH: 600 }), _persistDesktopPos() {}, _syncChatAnchor() { anchors.push(1); },
    _queueWindowGeometry: (op, label) => { queued.push(label); return new Promise(() => {}); } });
  // 舞台在外窗内的屏幕脚底 = 舞台左上 + 画布内脚底（缓冲 = 舞台 CSS 尺寸，dpr 1）。
  const screenFoot = () => {
    const r = app._deskScale ? { left: 0, top: 0, width: W, height: H } : app._stageRect(app._deskRestScale, W, H, 1);
    app._canvas.width = r.width; app._canvas.height = r.height;
    const t = app._modelViewportTransform();
    return { x: r.left + t.originX + ((bounds.minX + bounds.maxX) / 2) * t.scale, y: r.top + t.originY - bounds.minY * t.scale };
  };
  const near = (a, b) => assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, `${a.x},${a.y} vs ${b.x},${b.y}`);
  let now = 1000;
  const perf = globalThis.performance.now;
  globalThis.performance.now = () => now;
  try {
  app._layoutStage();
  assert.deepEqual([stage.style.width, stage.style.height], ['400px', '600px'], '静止舞台 = 当前比例的自然矩形');
  const foot = screenFoot();
  app._settings.scale = 0.6; app._setDesktopScaleTarget(0.6);
  const shown = [];
  for (let i = 0; i < 6; i++) {
    now += 16; app._stepDesktopScale(now); app._layoutStage(); shown.push(app._deskScale.shown);
    near(screenFoot(), foot);
  }
  assert.deepEqual([stage.style.width, stage.style.height], [`${W}px`, `${H}px`], '补间期间舞台铺满外窗');
  assert.ok(shown.every((v, i) => i === 0 || v < shown[i - 1]), '缩小过程单调');
  const mid = app._deskScale.shown;
  app._settings.scale = 1.8; app._setDesktopScaleTarget(1.8); now += 16; app._stepDesktopScale(now);
  assert.ok(app._deskScale.shown > mid, '反向从当前显示值继续');
  assert.ok(app._deskScale.target <= app._deskCapacityCss() + 1e-9, '目标钳在外窗容量内');
  for (let i = 0; i < 60; i++) { now += 16; app._stepDesktopScale(now); app._layoutStage(); near(screenFoot(), foot); }
  assert.equal(app._deskScale, null, '到位且静置后结束补间');
  app._layoutStage(); near(screenFoot(), foot);
  assert.deepEqual(queued, [], '缩放全程不触发任何原生窗口几何');
  assert.ok(anchors.length > 0, 'chat 锚点随显示比例更新');
  } finally { globalThis.performance.now = perf; }
});
