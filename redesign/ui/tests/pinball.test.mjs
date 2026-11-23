import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const EMBED = { isEmbed: false, assetUrl: p => '/' + String(p).replace(/^\/+/, ''), postToHost() {} };

function load(name, imports = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`src/${name}.ts`, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: id => imports[id] ?? (id === './embed' ? EMBED : id === './pinball' ? load('pinball') : {}),
    console,
    Math,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    ...globals,
  });
  return exports;
}

const settle = () => new Promise(r => setImmediate(r));

test('PinballPhysics: 低速不发射，高速按重力抛物线在四壁间弹性反弹并最终落到底边停稳', () => {
  const { PinballPhysics } = load('pinball');
  const pb = new PinballPhysics();

  assert.equal(pb.canLaunch(80, 60), false);
  assert.equal(pb.launch({ x: 200, y: 200, vx: 80, vy: 60, bounds: { minX: 0, maxX: 800, minY: 0, maxY: 600 } }), false);
  assert.equal(pb.active, false);

  const bounces = [];
  let settledAt = null;
  const ok = pb.launch({
    x: 400,
    y: 120,
    vx: -2600,
    vy: -600,
    bounds: { minX: 0, maxX: 500, minY: 0, maxY: 400 },
    onBounce: e => bounces.push(e),
    onSettled: (x, y) => { settledAt = [x, y]; },
  });
  assert.equal(ok, true);
  assert.equal(pb.active, true);
  assert.equal(pb.bouncing, true);
  assert.ok(Math.hypot(pb.vx, pb.vy) <= PinballPhysics.MAX_SPEED + 1e-6);

  for (let i = 0; i < 1200 && pb.active; i++) {
    pb.step(1 / 60);
    assert.ok(pb.x >= 0 && pb.x <= 500, `x out of bounds: ${pb.x}`);
    assert.ok(pb.y >= 0 && pb.y <= 400, `y out of bounds: ${pb.y}`);
  }

  assert.ok(bounces.length >= 4, '高弹性轻快跳动应连续反弹多次');
  assert.ok(bounces.some(b => b.wall === 'bottom'), '重力下应撞击底边弹起');
  assert.ok(bounces.some(b => b.wall === 'left' || b.wall === 'right'), '应撞击侧壁反弹');
  assert.equal(pb.active, false);
  assert.equal(pb.bouncing, false);
  assert.equal(pb.y, 400, '最终应停在底边');
  assert.ok(Array.isArray(settledAt) && settledAt[1] === 400);
});

test('PinballPhysics: 极窄边界与中途停止不产生 NaN，不改变人物旋转与缩放状态', () => {
  const { PinballPhysics } = load('pinball');
  const pb = new PinballPhysics();
  let settled = false;
  pb.launch({
    x: 10,
    y: 10,
    vx: 600,
    vy: 500,
    bounds: { minX: 10, maxX: 10, minY: 0, maxY: 300 },
    onSettled: () => { settled = true; },
  });
  for (let i = 0; i < 20; i++) pb.step(1 / 60);
  assert.equal(pb.x, 10);
  assert.equal(pb.vx, 0);
  assert.ok(Number.isFinite(pb.y));
  assert.equal('angleDeg' in pb, false);
  assert.equal('ballScale' in pb, false);

  pb.stopBouncing();
  assert.equal(pb.active, false);
  assert.equal(pb.bouncing, false);
  assert.equal(settled, true);
});

test('settings 与 hotkeyFromEvent: 弹球模式配置默认值与热键格式化', () => {
  const store = new Map();
  const localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  const { DEFAULT_SETTINGS, loadSettings, saveSettings, hotkeyFromEvent } = load('settings', {}, { localStorage });
  assert.equal(DEFAULT_SETTINGS.pinballMode, false);
  assert.equal(DEFAULT_SETTINGS.pinballModeHotkey, 'Ctrl+Alt+B');

  const loaded = loadSettings();
  assert.equal(loaded.pinballMode, false);
  assert.equal(loaded.pinballModeHotkey, 'Ctrl+Alt+B');

  saveSettings({ ...loaded, pinballMode: true, pinballModeHotkey: 'Ctrl+Shift+P' });
  const reloaded = loadSettings();
  assert.equal(reloaded.pinballMode, true);
  assert.equal(reloaded.pinballModeHotkey, 'Ctrl+Shift+P');

  assert.equal(hotkeyFromEvent({ code: 'KeyB', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }), 'Ctrl+Alt+B');
  assert.equal(hotkeyFromEvent({ code: 'F9', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }), 'F9');
  assert.equal(hotkeyFromEvent({ code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }), null);
});

function desktopPinballHarness({ pinballMode = true, reduced = false } = {}) {
  const { PinballPhysics } = load('pinball');
  const settingsMod = load('settings', {}, { localStorage: { getItem: () => null, setItem() {} } });
  const pos = [200, 150];
  const positions = [];
  const saved = [];
  const syncCalls = [];
  const expressions = [];
  const impulses = [];
  const applied = [];
  let dizzyCalls = 0;
  let broadcastCount = 0;
  let snapChatCount = 0;
  const mon = { scaleFactor: 1, workArea: { position: { x: 0, y: 0 }, size: { width: 1000, height: 800 } } };
  const api = {
    currentMonitor: async () => mon,
    primaryMonitor: async () => mon,
    PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } },
  };
  const core = {
    invoke: async (cmd, args) => { syncCalls.push([cmd, args]); },
  };
  const { PetApp } = load('pet-app', {
    '@tauri-apps/api/window': api,
    '@tauri-apps/api/core': core,
    './pinball': { PinballPhysics },
    './interaction/procedural': {
      isProceduralReactionType: () => true,
      proceduralReaction: (type, opts) => ({ type, ...opts }),
    },
    './settings': { ...settingsMod, saveSettings: s => saved.push({ ...s }) },
    './platform': { platform: 'tauri', androidShell: () => null, isAndroidOverlay: () => false },
  }, {
    document: { body: { dataset: {}, classList: { remove() {}, add() {} } }, documentElement: {} },
    window: { matchMedia: () => ({ matches: reduced }) },
  });
  const app = Object.create(PetApp.prototype);
  Object.assign(app, {
    _tauriWindow: {
      outerPosition: async () => ({ x: pos[0], y: pos[1] }),
      scaleFactor: async () => 1,
      outerSize: async () => ({ width: 200, height: 300 }),
      setPosition: async p => { pos[0] = p.x; pos[1] = p.y; positions.push([p.x, p.y]); },
    },
    _pinball: new PinballPhysics(),
    _pinballScaleFactor: 1,
    _pinballSyncing: false,
    _pinballNeedsSync: false,
    _pinballSubmittedX: Number.NaN,
    _pinballSubmittedY: Number.NaN,
    _pinballSimMs: 0,
    _pinballLastBounceFeedbackMs: -Infinity,
    _tauriWindowMod: null,
    _snapAnimToken: 0,
    _snapAnimation: null,
    _snapHintTimer: null,
    _windowMoveTask: null,
    _windowSettingsTask: Promise.resolve(),
    _windowGeometryPending: 0,
    _windowGeometryRevision: 0,
    _windowPositionRevision: 0,
    _winPhysX: pos[0],
    _winPhysY: pos[1],
    _scaleFactor: 1,
    _metricsSynced: true,
    _wrapWindow: false,
    _deskCapacityReady: false,
    _dragging: false,
    _nativeDragging: false,
    _settings: { ...settingsMod.DEFAULT_SETTINGS, pinballMode, snapEdges: true },
    _coordination: { activity() {}, canIdle: () => true },
    _interaction: {
      petting: { isPettingSessionActive: false },
      procedural: {
        isHoldDizzyActive: false,
        apply(r) { applied.push(r); },
        triggerHoldDizzy() { dizzyCalls++; },
      },
      tick() {},
    },
    _lift: { active: false, setHolding() {}, update() {} },
    _model: {
      isReady: () => true,
      triggerPartImpulse(part, strength) { impulses.push([part, strength]); },
      update() {},
      setPhysicsWind() {},
    },
    _chatPerformance: { tick() {}, applied: false },
    _expressForReaction: name => expressions.push(name),
    _broadcastSettings: () => { broadcastCount++; },
    _syncChatAnchor: () => { snapChatCount++; },
    _refreshDesktopCapacity() {},
    _showSnapHint() {},
    _physStageRect: s => ({ left: 0, top: 0, width: s?.width ?? 200, height: s?.height ?? 300 }),
  });
  return {
    app, pos, positions, saved, syncCalls, expressions, impulses, applied,
    get dizzyCalls() { return dizzyCalls; },
    get broadcastCount() { return broadcastCount; },
    get snapChatCount() { return snapChatCount; },
  };
}

test('PetApp 桌面端: 弹球模式高速甩出触发重力弹跳与表情，途中抓起立即中断，快捷键动作同步开关', async () => {
  const h = desktopPinballHarness({ pinballMode: true });
  h.app._dragVelX = 2400;
  h.app._dragVelY = -600;
  h.app._dragLastMoveMs = performance.now();
  h.app._onDragFinished(true);
  await settle();
  await settle();
  assert.equal(h.app._pinball.active, true);
  assert.equal(h.app._pinball.bouncing, true);

  for (let i = 0; i < 1200 && h.app._pinball.active; i++) {
    h.app._update(1 / 60);
    await settle();
  }
  assert.equal(h.app._pinball.active, false);
  assert.equal(h.pos[1], 500, '桌面弹球最终应落到底边停稳 (800 - 300)');
  assert.ok(h.positions.length > 10, '弹球飞行期间应推进窗口位置');
  assert.ok(h.app._pinball.bounceCount >= 4, '高幅度低频弹性下应连续反弹多次');
  assert.ok(h.expressions.includes('happy') || h.expressions.includes('surprised'), '碰壁应触发轻快表情');
  assert.equal(h.expressions.includes('sad'), false, '弹球模式不应切到流泪表情');
  assert.equal(h.dizzyCalls, 0, '弹球模式取消轻微转晕触发');
  assert.ok(h.impulses.some(([part, str]) => part === 'hair_bounce' && str > 0), '触地弹起应给出轻快向上的发丝波动而非沉重下压');
  assert.equal(h.applied.some(r => r.type === 'landing'), false, '不应叠加沉重落地蹲顿动作');
  assert.ok(h.saved.length >= 1, '停稳后应持久化终点位置');
  assert.ok(h.snapChatCount >= 1);

  // 飞行途中被抓起（_cancelSnapAnimation）立即停下
  h.app._dragVelX = 1800;
  h.app._dragVelY = -400;
  h.app._dragLastMoveMs = performance.now();
  h.app._onDragFinished(true);
  await settle();
  await settle();
  assert.equal(h.app._pinball.active, true);
  h.app._update(1 / 60);
  await settle();
  h.app._cancelSnapAnimation();
  assert.equal(h.app._pinball.active, false);

  // 托盘 / 全局热键动作切换开关并同步托盘勾选
  h.app.onShellAction({ action: 'toggle-pinball-mode' });
  await settle();
  assert.equal(h.app._settings.pinballMode, false);
  assert.ok(h.syncCalls.some(([cmd, args]) => cmd === 'sync_pinball_menu' && args.checked === false));
  assert.ok(h.broadcastCount >= 1);

  h.app.onShellAction({ action: 'pinball-mode', value: true });
  await settle();
  assert.equal(h.app._settings.pinballMode, true);
  assert.equal(h.app._pinball.active, false, '仅切换开关不应自动触发弹球移动');
});

test('PetApp 桌面端: 减少动态效果下不触发弹球飞行，Android 悬浮窗甩出也进入重力弹跳并保存终点', async () => {
  const reduced = desktopPinballHarness({ pinballMode: true, reduced: true });
  reduced.app._dragVelX = 2000;
  reduced.app._dragVelY = 1200;
  reduced.app._dragLastMoveMs = performance.now();
  reduced.app._onDragFinished(true);
  await settle();
  assert.equal(reduced.app._pinball.active, false);

  // Android 悬浮窗路径
  const { PinballPhysics } = load('pinball');
  const settingsMod = load('settings', {}, { localStorage: { getItem: () => null, setItem() {} } });
  const saved = [];
  const { PetApp } = load('pet-app', {
    './pinball': { PinballPhysics },
    './settings': { ...settingsMod, saveSettings: s => saved.push({ ...s }) },
    './platform': {
      platform: 'android',
      androidShell: () => ({ setPref() {}, getMetrics: () => JSON.stringify({ screenW: 400, screenH: 800 }) }),
      isAndroidOverlay: () => true,
    },
  }, {
    window: { matchMedia: () => ({ matches: false }) },
  });
  const app = Object.create(PetApp.prototype);
  Object.assign(app, {
    _wrapWindow: true,
    _pinball: new PinballPhysics(),
    _pinballSimMs: 0,
    _pinballLastBounceFeedbackMs: -Infinity,
    _pinballLandedOnce: false,
    _snapAnimToken: 0,
    _snapAnimation: null,
    _snapHintTimer: null,
    _originCssX: 200,
    _originCssY: 200,
    _appliedRectX: 150,
    _appliedRectY: 100,
    _screenW: 400,
    _screenH: 800,
    _contentScaleCss: 100,
    _rectDirty: false,
    _nativeDragging: false,
    _nativeDragVelX: 0,
    _nativeDragVelY: 0,
    _nativeDragMoveMs: 0,
    _settings: { ...settingsMod.DEFAULT_SETTINGS, pinballMode: true, snapEdges: true },
    _model: { isReady: () => true, getStaticBounds: () => ({ minX: -0.5, maxX: 0.5, minY: -1, maxY: 1 }), update() {}, setPhysicsWind() {} },
    _coordination: { activity() {}, canIdle: () => true },
    _interaction: { dragReaction: { onDragMove() {}, cancel() {} }, procedural: { cancelAll() {}, triggerHoldDizzy() {} }, onClick() {}, tick() {} },
    _lift: { active: false, setHolding() {}, update() {} },
    _chatPerformance: { tick() {} },
    _expressForReaction() {},
  });
  app.onNativeDragEnd(10, -10, 1800, false, 200, 200, 1600, -400);
  assert.equal(app._pinball.active, true);
  assert.equal(app._pinball.bouncing, true);
  for (let i = 0; i < 1200 && app._pinball.active; i++) app._update(1 / 60);
  assert.equal(app._pinball.active, false);
  assert.ok(saved.length >= 1, 'Android 弹球停稳后应持久化原点坐标');
});

test('PetApp: 弹跳过程中不触发转晕摇晃且直连 rAF 原生高帧率并补发重叠坐标', async () => {
  const { PinballPhysics } = load('pinball');
  const settingsMod = load('settings', {}, { localStorage: { getItem: () => null, setItem() {} } });
  const pendingResolvers = [];
  const positions = [];
  const mon = { scaleFactor: 1, workArea: { position: { x: 0, y: 0 }, size: { width: 1000, height: 800 } } };
  let shakeCalls = 0;
  let dragMoveMax = 0;
  let rafCallbacks = [];
  let setTimeoutCalls = 0;
  const { PetApp } = load('pet-app', {
    '@tauri-apps/api/window': {
      currentMonitor: async () => mon,
      primaryMonitor: async () => mon,
      PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } },
    },
    './pinball': { PinballPhysics },
    './settings': settingsMod,
    './platform': { platform: 'tauri', androidShell: () => null, isAndroidOverlay: () => false },
  }, {
    requestAnimationFrame: fn => { rafCallbacks.push(fn); return rafCallbacks.length; },
    setTimeout: () => { setTimeoutCalls++; return 1; },
    document: { body: { dataset: {}, classList: { remove() {}, add() {} } }, documentElement: {} },
    window: { matchMedia: () => ({ matches: false }) },
  });

  const app = Object.assign(Object.create(PetApp.prototype), {
    _tauriWindow: {
      setPosition: p => new Promise(resolve => pendingResolvers.push(() => { positions.push([p.x, p.y]); resolve(); })),
    },
    _pinball: new PinballPhysics(),
    _pinballScaleFactor: 1,
    _pinballSyncing: false,
    _pinballNeedsSync: false,
    _pinballSubmittedX: Number.NaN,
    _pinballSubmittedY: Number.NaN,
    _pinballSimMs: 0,
    _pinballLastBounceFeedbackMs: -Infinity,
    _tauriWindowMod: null,
    _windowSettingsTask: Promise.resolve(),
    _windowGeometryPending: 0,
    _windowGeometryRevision: 0,
    _windowPositionRevision: 0,
    _winPhysX: 200,
    _winPhysY: 200,
    _scaleFactor: 1,
    _metricsSynced: true,
    _wrapWindow: false,
    _fpsCap: 15,
    _boostUntil: 0,
    _frameQueued: false,
    _lastFrameTime: 1000,
    _running: true,
    _paused: false,
    _covered: false,
    _nativeDragging: true,
    _nativeDragVelX: 0,
    _nativeDragVelY: 0,
    _nativeDragMoveMs: 0,
    _settings: { ...settingsMod.DEFAULT_SETTINGS, pinballMode: true, batterySaver: true },
    _coordination: { activity() {}, canIdle: () => true },
    _interaction: {
      dragReaction: {
        onDragMove(s) { dragMoveMax = Math.max(dragMoveMax, s); },
        onDragMotion() { throw new Error('弹球模式不应调用摇晃转晕检测'); },
      },
      onDragShake() { shakeCalls++; },
      updateHoldVelocity() {},
    },
    _lift: { active: false, setHolding() {}, update() {}, setVelocity() {} },
    _model: { isReady: () => false, update() {}, setPhysicsWind() {} },
  });

  // 1. 弹球模式下拖动甩动只累计速度，不触发摇晃转晕
  app.onNativeDragMove(1800, -400, 0.016);
  assert.equal(shakeCalls, 0);
  assert.ok(dragMoveMax > 1800);

  // 2. 弹跳期间帧间隔为 0，省电模式下也直连 requestAnimationFrame 不走 setTimeout 降频
  app._startPinballDesktop(200, 200, 1200, -300, 1, { minX: 0, maxX: 800, minY: 0, maxY: 500 });
  assert.equal(app._frameIntervalMs(1005), 0);
  app._scheduleFrame();
  assert.equal(setTimeoutCalls, 0);
  assert.equal(rafCallbacks.length, 1);

  // 3. 前一帧 setPosition IPC 未返回时新坐标进入 _pinballNeedsSync，完成后立即补发最新位置
  app._stepPinball(1 / 120);
  await settle();
  const firstPosX = app._pinballSubmittedX;
  assert.equal(pendingResolvers.length, 1);
  app._stepPinball(1 / 120);
  assert.equal(app._pinballNeedsSync, true);
  pendingResolvers.shift()();
  await settle();
  await settle();
  assert.equal(pendingResolvers.length, 1);
  assert.notEqual(app._pinballSubmittedX, firstPosX);
  pendingResolvers.shift()();
  await settle();
  assert.equal(positions.length, 2);

  // 4. 停止弹跳后恢复原帧率控制
  app._pinball.stopBouncing();
  assert.equal(app._frameIntervalMs(2000), 1000 / 15);
});

test('PetApp 桌面端: 弹球边界扣除透明渲染余量，触底时脚底贴近工作区底边而非悬空留白', async () => {
  const h = desktopPinballHarness({ pinballMode: true });
  h.app._model = {
    isReady: () => true,
    boundsH: 1.2,
    boundsAspect: 200 / 300,
    getStaticBounds: () => ({ minX: -0.4, maxX: 0.4, minY: -0.6, maxY: 0.6 }),
    triggerPartImpulse() {},
    update() {},
    setPhysicsWind() {},
  };
  // 舞台高 300 时，角色实际高度 = 300 / 1.39 ≈ 215.8，底部透明留白 ≈ 42px
  const contentRect = h.app._physPinballContentRect({ width: 200, height: 300 });
  assert.ok(contentRect.top > 40 && contentRect.top < 45);
  assert.ok(contentRect.top + contentRect.height < 260);

  h.app._dragVelX = 1200;
  h.app._dragVelY = 600;
  h.app._dragLastMoveMs = performance.now();
  h.app._onDragFinished(true);
  await settle();
  await settle();
  for (let i = 0; i < 1200 && h.app._pinball.active; i++) {
    h.app._update(1 / 60);
    await settle();
  }
  assert.equal(h.app._pinball.active, false);
  // 触底时窗口 y 应下沉到让角色实际脚底接触 workArea 底边 800（大于原先的 500）
  assert.ok(h.pos[1] > 535 && h.pos[1] <= 545, `期望窗口触底 y≈542，实际 ${h.pos[1]}`);
});

test('PinballPhysics 与 PetApp: 弹跳触底瞬间压扁并横舒且以脚底为支点平滑回弹', () => {
  const { PinballPhysics } = load('pinball');
  const pb = new PinballPhysics();
  let bottomSquash = null;
  pb.launch({
    x: 200,
    y: 480,
    vx: 100,
    vy: 800,
    bounds: { minX: 0, maxX: 600, minY: 0, maxY: 500 },
    onBounce: ev => {
      if (ev.wall === 'bottom' && !bottomSquash) bottomSquash = pb.squashScale;
    },
  });
  for (let i = 0; i < 10 && !bottomSquash; i++) pb.step(1 / 120);
  assert.ok(bottomSquash, '触底应立即触发压扁形变');
  assert.ok(bottomSquash.sy < 0.92, `触底时纵向应明显压扁: sy=${bottomSquash.sy}`);
  assert.ok(bottomSquash.sx > 1.04, `触底时横向应轻微舒展: sx=${bottomSquash.sx}`);

  const { PetApp } = load('pet-app', {
    './pinball': { PinballPhysics },
    './platform': { platform: 'tauri', androidShell: () => null, isAndroidOverlay: () => false },
  }, {
    window: { matchMedia: () => ({ matches: false }) },
  });
  const app = Object.assign(Object.create(PetApp.prototype), {
    _pinball: pb,
    _model: {
      isReady: () => true,
      getStaticBounds: () => ({ minX: -0.4, maxX: 0.4, minY: -0.6, maxY: 0.6 }),
    },
  });
  const tr = app._pinballSquashTransform(100, 150, 150);
  assert.ok(tr && tr.sy < 0.92 && tr.sx > 1.04);
  // 脚底模型点 (-0.6) 经压扁矩阵映射后的屏幕 y 应保持在 footY = 150 - (-0.6)*100 = 210
  const mappedFootY = (-100 * tr.sy) * (-0.6) + tr.originY;
  assert.ok(Math.abs(mappedFootY - tr.footY) < 1e-6, '压扁后脚底位置应锚定不变');

  // 继续步进，压扁弹性应收回恢复 1:1
  for (let i = 0; i < 60; i++) pb.stepSquash(1 / 60);
  assert.equal(pb.squashActive, false);
  assert.deepEqual({ ...pb.squashScale }, { sx: 1, sy: 1 });
});
