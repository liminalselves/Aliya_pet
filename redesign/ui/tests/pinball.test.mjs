import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { reactionHost, reactionStub } from './reaction-stub.mjs';

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

test('computePinballCatchScore 与抓取展示: 速度越快、人物越小得分越高，抓到后显示得分、速度与设置页一致的缩放百分比', () => {
  const { PinballPhysics, computePinballCatchScore } = load('pinball');
  const settingsMod = load('settings', {}, { localStorage: { getItem: () => null, setItem() {} } });
  const slowNormal = computePinballCatchScore(300, 0.5);
  const fastNormal = computePinballCatchScore(1400, 0.5);
  const fastSmall = computePinballCatchScore(1400, 0.25);
  const fastLarge = computePinballCatchScore(1400, 1.0);
  assert.ok(fastNormal.score > slowNormal.score, '速度越快得分应越高');
  assert.ok(fastSmall.score > fastNormal.score, '人物越小得分应越高');
  assert.ok(fastNormal.score > fastLarge.score, '人物越大得分应越低');
  assert.equal(fastSmall.speedPxPerSec, 1400);
  assert.equal(fastSmall.sizePercent, 25);

  const pb = new PinballPhysics();
  pb.launch({ x: 200, y: 200, vx: 900, vy: -200, bounds: { minX: 0, maxX: 800, minY: 0, maxY: 600 } });
  const created = [];
  const makeEl = () => {
    const el = {
      id: '',
      className: '',
      hidden: false,
      textContent: '',
      children: [],
      offsetWidth: 160,
      offsetHeight: 40,
      style: {},
      classList: { remove() {}, add() {} },
      setAttribute() {},
      appendChild(child) { this.children.push(child); },
    };
    created.push(el);
    return el;
  };
  const { PetApp } = load('pet-app', {
    './pinball': { PinballPhysics, computePinballCatchScore },
    './settings': settingsMod,
    './platform': { platform: 'tauri', androidShell: () => null, isAndroidOverlay: () => false },
  }, {
    window: { innerWidth: 500, innerHeight: 500, matchMedia: () => ({ matches: false }) },
    document: { body: { dataset: {}, classList: { remove() {}, add() {} }, appendChild() {} }, createElement: makeEl },
  });
  const monRange = settingsMod.scaleRangeFor(1920, 1040);
  const scale44 = settingsMod.percentToScale(44, monRange.minS, monRange.maxS);
  const app = Object.assign(Object.create(PetApp.prototype), {
    _pinball: pb,
    _settings: { scale: scale44, mirror: false },
    _scaleRange: monRange,
    _dpr: 1,
    _model: {
      isReady: () => true,
      boundsH: 1.2,
      getStaticBounds: () => ({ minX: -0.4, maxX: 0.4, minY: -0.6, maxY: 0.6 }),
    },
    _canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 400 }) },
    _shownSizeFactor: () => scale44 - 0.0005,
    _modelViewportTransform: () => ({ scale: 200, originX: 150, originY: 200 }),
    _snapAnimToken: 0,
    _snapAnimation: null,
    _snapHintTimer: null,
  });

  const expectedPercent = Math.round(settingsMod.scaleToPercent(scale44, monRange.minS, monRange.maxS));
  assert.equal(expectedPercent, 44);
  const caught = app._capturePinballCatch();
  assert.ok(caught && caught.score > 0);
  assert.equal(caught.sizePercent, expectedPercent, '抓取浮标显示的大小应与设置页缩放百分比一致');
  assert.equal(caught.speedPxPerSec, Math.round(pb.speed));
  assert.ok(created[0].children[0].textContent.includes(`${caught.score} 分`));
  assert.ok(created[0].children[1].textContent.includes(`${caught.speedPxPerSec} px/s`));
  assert.ok(created[0].children[1].textContent.includes(`${expectedPercent}%`));

  // 缩放补间进行中且显示比例尚未落定时，取实际显示比例换算百分比
  app._deskScale = { shown: 0.25, target: 0.55, last: 0, input: 0 };
  app._shownSizeFactor = () => 0.25;
  const tweenExpected = Math.round(settingsMod.scaleToPercent(0.25, monRange.minS, monRange.maxS));
  const tweenCaught = app._capturePinballCatch();
  assert.equal(tweenCaught.sizePercent, tweenExpected);

  // 取消弹球后再次触发抓取得分应返回 null，避免重复计分
  app._cancelSnapAnimation();
  assert.equal(app._capturePinballCatch(), null);
  app._hidePinballCatchHud(true);
});

test('Android 悬浮窗: 弹球抓取优先走独立原生浮标不占用台词气泡，原生拖动期间忽略迟到的 pointercancel', () => {
  const { PinballPhysics, computePinballCatchScore } = load('pinball');
  const settingsMod = load('settings', {}, { localStorage: { getItem: () => null, setItem() {} } });
  const huds = [];
  const bubbleCalls = [];
  const prefs = [];
  const shell = {
    getMetrics: () => JSON.stringify({ screenW: 400, screenH: 800 }),
    setPref: (k, v) => prefs.push([k, v]),
    setInteracting() {},
    setPinballCatchHud: json => huds.push(json),
    setDialogueBubble() {},
  };
  const canvasListeners = {};
  const { PetApp } = load('pet-app', {
    './pinball': { PinballPhysics, computePinballCatchScore },
    './settings': { ...settingsMod, saveSettings() {} },
    './platform': { platform: 'android', androidShell: () => shell, isAndroidOverlay: () => true },
  }, {
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { body: { dataset: {}, classList: { remove() {}, add() {} } }, documentElement: {} },
  });

  const pb = new PinballPhysics();
  pb.launch({ x: 200, y: 200, vx: 1000, vy: -300, bounds: { minX: 0, maxX: 400, minY: 0, maxY: 800 } });
  const app = Object.assign(Object.create(PetApp.prototype), {
    _wrapWindow: true,
    _pinball: pb,
    _dpr: 2,
    _screenW: 400,
    _screenH: 800,
    _appliedRectW: 200,
    _appliedRectH: 300,
    _originCssX: 200,
    _originCssY: 200,
    _settings: { ...settingsMod.DEFAULT_SETTINGS, scale: settingsMod.percentToScale(55, ...Object.values(settingsMod.scaleRangeFor(400, 712))), pinballMode: true },
    _model: {
      isReady: () => true,
      boundsH: 1.2,
      getStaticBounds: () => ({ minX: -0.4, maxX: 0.4, minY: -0.6, maxY: 0.6 }),
      getDynamicBounds: () => ({ minX: -0.4, maxX: 0.4, minY: -0.6, maxY: 0.6 }),
    },
    _canvas: {
      style: {},
      addEventListener: (name, fn) => { canvasListeners[name] = fn; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 300 }),
      hasPointerCapture: () => false,
    },
    _shownSizeFactor: () => app._settings.scale,
    _modelViewportTransform: () => ({ scale: 200, originX: 200, originY: 300 }),
    _androidBubble: { hide() {}, close() {}, sync() {} },
    _bubble: { play: arg => bubbleCalls.push(arg), cancel() {} },
    _snapAnimToken: 0,
    _snapAnimation: null,
    _snapHintTimer: null,
    _hitAreas: { mirrored: false },
    _behavior: { clearLookTarget() {}, stop() {}, start() {}, refreshRandomSpeech() {} },
    _coordination: { activity() {} },
    _publishHitMask() {},
  });

  // 1. 抓取计分走 setPinballCatchHud 原生浮标，且百分比与 Android 设置页口径一致（55%），不占用 _bubble
  const caught = app._capturePinballCatch();
  assert.ok(caught && caught.score > 0);
  assert.equal(caught.sizePercent, 55);
  assert.equal(bubbleCalls.length, 0, '不得借用对话气泡显示抓取得分');
  assert.equal(huds.length, 1);
  const hudPayload = JSON.parse(huds[0]);
  assert.equal(hudPayload.score, caught.score);
  assert.equal(hudPayload.speedPxPerSec, caught.speedPxPerSec);
  assert.equal(hudPayload.sizePercent, 55);
  assert.equal(Math.round(hudPayload.centerX), 100);
  assert.equal(Math.round(hudPayload.headY), 90);

  // 2. 暂停时先持久化悬浮窗当前位置、取消弹球并清空原生浮标
  pb.launch({ x: 180, y: 260, vx: 600, vy: 0, bounds: { minX: 0, maxX: 400, minY: 0, maxY: 800 } });
  app._originCssX = 180;
  app._originCssY = 260;
  app.setPaused(true);
  assert.equal(pb.active, false);
  assert.equal(huds.at(-1), '');
  assert.deepEqual(prefs.slice(-2), [['petX', '180'], ['petY', '260']]);

  // 3. 原生拖动已接管时，迟到的 pointercancel / lostpointercapture 不得取消拎起状态
  let cancels = 0;
  app._interaction = { cancel() { cancels++; }, dragReaction: { cancel() {} } };
  app._activePointerId = 1;
  app._nativeDragging = true;
  app._wirePointerEvents();
  canvasListeners.pointercancel({ pointerId: 1 });
  canvasListeners.lostpointercapture({ pointerId: 1 });
  assert.equal(cancels, 0);

  // 4. Android 关闭弹球模式设置立即停掉进行中的弹跳
  pb.launch({ x: 180, y: 260, vx: 600, vy: 0, bounds: { minX: 0, maxX: 400, minY: 0, maxY: 800 } });
  app._applyWindowSettingsAndroid = () => {};
  app.applySettings({ ...app._settings, pinballMode: false }, false);
  assert.equal(pb.bouncing, false);
});

test('PetApp: _kickImmediateFrame 取消低帧率定时器直连 rAF，touch 落底回弹期保持 _interactionBoost', () => {
  const rafs = [];
  const timers = new Map();
  let nextTimerId = 1;
  const { PetApp } = load('pet-app', {
    './platform': { platform: 'android', androidShell: () => null, isAndroidOverlay: () => true },
  }, {
    requestAnimationFrame: fn => { rafs.push(fn); return rafs.length; },
    setTimeout: fn => { const id = nextTimerId++; timers.set(id, fn); return id; },
    clearTimeout: id => { timers.delete(id); },
  });
  const app = Object.create(PetApp.prototype);
  app._running = true;
  app._paused = false;
  app._covered = false;
  app._frameQueued = false;
  app._frameTimerId = null;
  app._fpsCap = 15;
  app._lastFrameTime = performance.now() + 200;
  app._settings = { batterySaver: false };
  app._interactionBoost = () => false;

  app._scheduleFrame();
  assert.equal(timers.size, 1, '低帧率空转应排队等待定时器');
  assert.equal(rafs.length, 0);

  app._pinball = { bouncing: true };
  app._kickImmediateFrame();
  assert.equal(timers.size, 0, '_kickImmediateFrame 应取消排队中的定时器');
  assert.equal(rafs.length, 1, '取消定时器后应立即排队下一帧 rAF');

  // 验证着陆 squash 恢复期间维持 60fps 互动升帧（省电模式除外）
  const appBoost = Object.create(PetApp.prototype);
  appBoost._fpsCap = 30;
  appBoost._boostUntil = 0;
  appBoost._dragging = false;
  appBoost._nativeDragging = false;
  appBoost._leftDown = false;
  appBoost._touchPetting = false;
  appBoost._settings = { batterySaver: false };
  appBoost._pinball = { active: false, squashActive: true };
  assert.equal(PetApp.prototype._interactionBoost.call(appBoost, 1000), true);
  appBoost._settings.batterySaver = true;
  assert.equal(PetApp.prototype._interactionBoost.call(appBoost, 2000), false);
});

test('PetApp Android 悬浮窗: 弹球期间按 DPR 对齐物理像素并通过 syncPinballFrame 驱动高刷，停稳与中断均关闭高刷', () => {
  const { PinballPhysics } = load('pinball');
  const settingsMod = load('settings', {}, { localStorage: { getItem: () => null, setItem() {} } });
  const syncCalls = [];
  const saved = [];
  const rafs = [];
  const shell = {
    getMode: () => 'overlay',
    getMetrics: () => JSON.stringify({ density: 3, screenW: 400, screenH: 850, winX: 0, winY: 0, winW: 200, winH: 300 }),
    setWindowRect: () => {},
    animateWindowTo: () => {},
    setPref: (k, v) => saved.push([k, v]),
    getPref: () => '',
    setInteracting: () => {},
    syncPinballFrame: (active, x, y, w, h, vx, vy, minX, maxX, minY, maxY) => {
      syncCalls.push({ active, x, y, w, h, vx, vy, minX, maxX, minY, maxY });
    },
  };
  const { PetApp } = load('pet-app', {
    './pinball': { PinballPhysics },
    './settings': { ...settingsMod, saveSettings() {} },
    './platform': { platform: 'android', androidShell: () => shell, isAndroidOverlay: () => true },
  }, {
    requestAnimationFrame: fn => { rafs.push(fn); return rafs.length; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    window: { matchMedia: () => ({ matches: false }) },
    document: { body: { dataset: {}, classList: { remove() {}, add() {} } }, documentElement: {} },
  });

  const app = Object.create(PetApp.prototype);
  app._running = true;
  app._paused = false;
  app._covered = false;
  app._frameQueued = false;
  app._frameTimerId = null;
  app._wrapWindow = true;
  app._nativeDragging = false;
  app._dpr = 3;
  app._screenW = 400;
  app._screenH = 850;
  app._originCssX = 180;
  app._originCssY = 300;
  app._contentScaleCss = 100;
  app._scaleFactor = 1;
  app._appliedRectX = 0;
  app._appliedRectY = 0;
  app._appliedRectW = 200;
  app._appliedRectH = 300;
  app._rectInited = true;
  app._rectDirty = false;
  app._boostUntil = 0;
  app._fpsCap = 30;
  app._pinball = new PinballPhysics();
  app._pinballBoundsCss = null;
  app._androidPinballActive = false;
  app._coordination = { activity() {} };
  app._expressForReaction = () => {};
  app._settings = { pinballMode: true, snapEdges: true, scale: 0.5, batterySaver: false };
  app._model = {
    isReady: () => true,
    boundsAspect: 512 / 768,
    getStaticBounds: () => ({ minX: -0.5, maxX: 0.5, minY: -0.8, maxY: 0.6 }),
  };

  app._onDragFinishedAndroid(false, undefined, { vx: 1200, vy: -500 });
  assert.equal(app._pinball.bouncing, true);
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].active, true, 'Launch 时应立即同步首帧并开启原生高刷');
  assert.ok(syncCalls[0].vx > 1000 && syncCalls[0].maxX > syncCalls[0].minX);
  assert.ok(rafs.length >= 1, 'Launch 时应立即触发 rAF 首帧');

  // 子像素推进 1/3 CSS px (= 1 physical px @ dpr=3)，应更新 _appliedRectX 而不被整 CSS px 吃掉
  const prevX = app._appliedRectX;
  app._originCssX += 0.34;
  app._pinball.x = app._originCssX;
  app._rectDirty = true;
  app._syncWrapWindow();
  assert.notEqual(app._appliedRectX, prevX, '高 DPR 下应保留 1 物理像素步进');
  assert.ok(Math.abs((app._appliedRectX - prevX) - 1 / 3) < 0.01);

  // 途中取消：立即发送 active=false 关闭原生高刷循环
  app._cancelPinball();
  assert.equal(syncCalls.at(-1).active, false);
  assert.equal(app._androidPinballActive, false);

  // 重新 launch 并模拟自然落底停稳：_syncWrapWindow 收到停稳帧时发送 active=false
  app._onDragFinishedAndroid(false, undefined, { vx: 600, vy: -200 });
  assert.equal(syncCalls.at(-1).active, true);
  for (let i = 0; i < 1200 && app._pinball.bouncing; i++) {
    app._stepPinball(1 / 60);
  }
  assert.equal(app._pinball.bouncing, false);
  app._syncWrapWindow();
  assert.equal(syncCalls.at(-1).active, false, '自然停稳后应关闭原生高刷模式');
  assert.ok(saved.some(([k]) => k === 'petX'));
});

test('loadSettings 迁移: 旧 gameModeHotkey 占用了 Ctrl+Alt+B 时留空默认弹球热键避免冲突', () => {
  const store = new Map([
    ['aliya_pet_settings_v1', JSON.stringify({ gameModeHotkey: 'alt+ctrl+b' })],
  ]);
  const localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  const { loadSettings } = load('settings', {}, { localStorage });
  const loaded = loadSettings();
  assert.equal(loaded.gameModeHotkey, 'alt+ctrl+b');
  assert.equal(loaded.pinballModeHotkey, '');
});

test('弹球慢速起飞与轻点抓球: 140~160px/s 起飞不触发 landing 蹲顿，轻点抓球抑制点击气泡避免与计分浮标重叠', () => {
  const recognizer = load('interaction/petting-recognizer');
  const petting = load('interaction/petting-controller', { './petting-recognizer': recognizer });
  const procedural = load('interaction/procedural');
  const { InteractionService } = load('interaction/interaction', {
    './petting-controller': petting,
    './procedural': procedural,
  });
  const lines = [];
  const impulses = [];
  let offsets = [0, 0, 0, 0];
  const target = {
    getInteractionParamInfo: () => ({
      angleXMin: -30, angleXMax: 30, angleYMin: -30, angleYMax: 30,
      angleZMin: -30, angleZMax: 30, bodyXMin: -10, bodyXMax: 10,
      eyeLMin: 0, eyeLMax: 1, eyeRMin: 0, eyeRMax: 1, hasEyes: true,
    }),
    setInteractionOffsets(...v) { offsets = v; },
    setBodyTilt() {},
    setEyeOverride() {},
    setPettingLookAtReduction() {},
    setEarInteraction() {},
    setFaceCheek() {},
    setArmInteraction() {},
    setFaceMicroInteraction() {},
    triggerPartImpulse(part, str) { impulses.push([part, str]); },
  };
  const service = new InteractionService({
    hitAreas: { hitAreaAt: () => 'head', isInHeadPetZone: () => true, mirrored: false },
    getTarget: () => target,
    reactions: reactionStub({ actionFor: k => (k === 'drag.slow' ? 'landing' : undefined) }),
    host: reactionHost({ speak: line => lines.push(line.entryId) }),
    pettingHost: { isDialogueActive: () => false },
    random: () => 0,
  });

  // 1. 慢速起飞（145 px/s >= 140 且 < 160）：平滑退出 hold，不触发 landing 蹲顿或 drag.slow 台词
  service.dragReaction.beginDrag();
  service.dragReaction.onDragMove(145);
  service.beginHold();
  service.tick(16);
  assert.equal(service.procedural.isHolding, true);
  service.onClick({ normX: 0.5, normY: 0.3, pxX: 100, pxY: 100, dtSeconds: 0.016, leftPressed: false, isSecondary: false }, true, { pinballLaunch: true });
  assert.equal(service.procedural.isHolding, false);
  assert.equal(lines.includes('drag.slow'), false, '弹球起飞不得说落地台词');
  assert.equal(impulses.some(([p]) => p === 'hair_bounce'), true);
  impulses.length = 0;

  // 2. PetApp 轻点抓球：显示计分浮标并抑制同次点击台词，随后普通单击仍正常说话
  const { PinballPhysics, computePinballCatchScore } = load('pinball');
  const settingsMod = load('settings', {}, { localStorage: { getItem: () => null, setItem() {} } });
  const listeners = {};
  const huds = [];
  const { PetApp } = load('pet-app', {
    './pinball': { PinballPhysics, computePinballCatchScore },
    './settings': settingsMod,
    './platform': {
      platform: 'android',
      androidShell: () => ({
        setInteracting() {},
        setPinballCatchHud: json => huds.push(json),
        syncPinballFrame() {},
        getMetrics: () => JSON.stringify({ screenW: 400, screenH: 800 }),
      }),
      isAndroidOverlay: () => true,
    },
  }, {
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { body: { dataset: {}, classList: { remove() {}, add() {} } }, documentElement: {} },
  });

  const pb = new PinballPhysics();
  pb.launch({ x: 200, y: 200, vx: 900, vy: -200, bounds: { minX: 0, maxX: 400, minY: 0, maxY: 800 } });
  const app = Object.assign(Object.create(PetApp.prototype), {
    _wrapWindow: true,
    _pinball: pb,
    _interaction: service,
    _hitAreas: service.hitAreas,
    _coordination: { activity() {} },
    _behavior: { updateLookTarget() {}, clearLookTarget() {} },
    _model: {
      isReady: () => true,
      boundsW: 1,
      boundsH: 1.2,
      boundsAspect: 0.64,
      getStaticBounds: () => ({ minX: -0.4, maxX: 0.4, minY: -0.6, maxY: 0.6 }),
      getDynamicBounds: () => ({ minX: -0.4, maxX: 0.4, minY: -0.6, maxY: 0.6 }),
    },
    _canvas: {
      width: 200,
      height: 300,
      style: {},
      addEventListener: (name, fn) => { listeners[name] = fn; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 300 }),
      setPointerCapture() {},
      releasePointerCapture() {},
      hasPointerCapture: () => false,
    },
    _dpr: 1,
    _contentScaleCss: 200,
    _originCssX: 200,
    _originCssY: 200,
    _appliedRectX: 100,
    _appliedRectY: 50,
    _appliedRectW: 200,
    _appliedRectH: 300,
    _settings: { ...settingsMod.DEFAULT_SETTINGS, pinballMode: true },
    _scaleRange: { minS: 0.15, maxS: 2 },
    _shownSizeFactor: () => 0.5,
    _modelViewportTransform: () => ({ scale: 200, originX: 100, originY: 150 }),
    _isOnCharacter: () => true,
    _publishHitMask() {},
    _syncWindowMetrics() {},
    _snapAnimToken: 0,
    _snapAnimation: null,
    _snapHintTimer: null,
  });
  app._wirePointerEvents();

  const ev = (overrides = {}) => ({
    isPrimary: true,
    pointerId: 7,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    clientX: 100,
    clientY: 100,
    screenX: 100,
    screenY: 100,
    ...overrides,
  });
  listeners.pointerdown(ev());
  listeners.pointerup(ev({ buttons: 0 }));
  assert.equal(huds.length, 1, '抓球应显示计分浮标');
  assert.equal(lines.length, 0, '抓球同次轻点不得弹出普通台词气泡');
  assert.equal(impulses.some(([p]) => p === 'hair_bounce'), true, '抓球点击仍保留部位物理脉冲反馈');

  // 后续正常轻点恢复台词
  listeners.pointerdown(ev({ pointerId: 8 }));
  listeners.pointerup(ev({ pointerId: 8, buttons: 0 }));
  assert.equal(lines.length, 1);
  assert.ok(Array.isArray(offsets));
});
