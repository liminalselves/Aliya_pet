import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pendant-physics.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } }).outputText;
const { PendantPhysics, RopeChain, MAX_STRETCH, pendantCharHeight } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const settingsJs = ts.transpileModule(readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 },
}).outputText;
const { clampPendantScale, clampPendantRope, PENDANT_SCALE_MIN, PENDANT_SCALE_MAX, PENDANT_ROPE_MIN, PENDANT_ROPE_MAX } =
  await import(`data:text/javascript,${encodeURIComponent(settingsJs)}`);

const DT = 1 / 60;
const run = (p, ax, ay, seconds, each) => {
  for (let t = 0; t < seconds; t += DT) { p.step(ax(t), ay(t), DT); each?.(t); }
};

test('静止时垂挂在指针正下方', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(500, 300);
  run(p, () => 500, () => 300, 3);
  assert.ok(Math.abs(p.x - 500) < 1);
  assert.ok(p.distance >= 100 && p.distance <= 100 * MAX_STRETCH);
  assert.ok(Math.abs(p.angle) < 0.01 && p.settled);
});

test('匀速移动：人物被拖在后下方，身体朝移动方向倾斜，绳子拉直', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(0, 0);
  const v = 900;
  run(p, t => t * v, () => 0, 3);
  assert.ok(p.x < p.anchorX - 25, `落在指针后方 (dx=${(p.x - p.anchorX).toFixed(1)})`);
  assert.ok(p.y > p.anchorY + 25, '仍在指针下方');
  assert.ok(p.distance > 98, '绳子被拉直');
  assert.ok(p.angle > 0.2 && p.angle < Math.PI / 2, `身体朝移动方向倾斜 (angle=${p.angle.toFixed(2)})`);
  assert.ok(Math.abs(p.vx - v) < 30, '与指针同速前进');
});

test('快速甩动：人物被甩过头顶、绕指针打转，绳子会松弛', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(0, 0);
  let above = false, slack = false, sweep = 0, prev = Math.atan2(p.x, p.y);
  run(p, t => Math.cos(t * 14) * 220, t => Math.sin(t * 14) * 220, 2, () => {
    const dx = p.x - p.anchorX, dy = p.y - p.anchorY;
    if (dy < -50) above = true;
    if (p.distance < 92) slack = true;
    const a = Math.atan2(dx, dy);
    let d = a - prev;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    sweep += d; prev = a;
    assert.ok(p.distance <= 100 * MAX_STRETCH + 1e-6, '绳长不超过上限');
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.angle));
  });
  assert.ok(above, '荡到指针上方');
  assert.ok(slack, '绳子出现松弛');
  assert.ok(Math.abs(sweep) > 4 * Math.PI, `绕指针转了至少两圈 (${(sweep / Math.PI / 2).toFixed(1)})`);
});

test('停下：带惯性冲过头，钟摆式来回且摆幅衰减，最后垂挂', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(0, 0);
  run(p, t => t * 900, () => 0, 1.5);
  const stopX = p.anchorX;
  const peaks = [];
  let last = p.x - stopX, lastV = p.vx;
  run(p, () => stopX, () => 0, 10, () => {
    const dx = p.x - stopX;
    if (Math.sign(p.vx) !== Math.sign(lastV) && lastV !== 0) peaks.push(Math.abs(dx));
    last = dx; lastV = p.vx;
  });
  assert.ok(peaks.length >= 4, `来回摆荡多次 (${peaks.length})`);
  assert.ok(peaks[0] > 30, '第一次冲过指针');
  for (let i = 2; i < Math.min(peaks.length, 8); i++) assert.ok(peaks[i] < peaks[i - 2], '摆幅逐渐衰减');
  assert.ok(Math.abs(last) < 2 && p.settled, '最终静止垂挂');
});

test('指针跳变（跨屏）直接复位，不甩飞', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(0, 0);
  assert.equal(p.step(5000, 0, DT), false);
  assert.equal(p.x, 5000);
  assert.equal(p.vx, 0);
});

test('绳子：两端固定在指针尾部与人物身上，距离不足时下垂，超过绳长时拉直', () => {
  const r = new RopeChain(16);
  r.reset(0, 0, 0, 100);
  for (let i = 0; i < 120; i++) r.step(0, 0, 60, 0, 100, DT);
  const first = r.points[0], last = r.points[r.points.length - 1];
  assert.deepEqual([first.x, first.y, last.x, last.y], [0, 0, 60, 0]);
  assert.ok(Math.max(...r.points.map(p => p.y)) > 20, '松弛时下垂');
  for (let i = 0; i < 60; i++) r.step(0, 0, 120, 0, 100, DT);
  assert.ok(Math.max(...r.points.map(p => Math.abs(p.y))) < 1, '拉直');
});

test('人物大小按比例缩放', () => {
  assert.equal(pendantCharHeight(2), pendantCharHeight(1) * 2);
});

test('吊坠设置值钳制到范围内，非法输入回到默认', () => {
  assert.equal(clampPendantScale(0), PENDANT_SCALE_MIN);
  assert.equal(clampPendantScale(99), PENDANT_SCALE_MAX);
  assert.equal(clampPendantScale('x'), 1);
  assert.equal(clampPendantRope(1), PENDANT_ROPE_MIN);
  assert.equal(clampPendantRope(9999), PENDANT_ROPE_MAX);
  assert.equal(clampPendantRope(Number.NaN), 80);
  assert.equal(clampPendantRope(80.4), 80);
});

test('吊坠视图：节拍调度、后台暂停、少动态、风力低通滤波与随身体倾角反旋视线', async () => {
  const vm = (await import('node:vm')).default;
  let now = 1000, nextId = 1, hidden = false, reduceMotion = false;
  const timers = new Map(), rafs = new Map(), listeners = new Map(), docListeners = new Map();
  const winds = [], looks = [], modelUpdates = [];
  const ctx2d = { clearRect() {}, beginPath() {}, moveTo() {}, quadraticCurveTo() {}, lineTo() {}, stroke() {} };
  const gl = {
    FRAMEBUFFER_BINDING: 0, COLOR_BUFFER_BIT: 1, DEPTH_BUFFER_BIT: 2, DEPTH_TEST: 3, LEQUAL: 4,
    getParameter: () => null, isContextLost: () => false, viewport() {}, clearColor() {},
    enable() {}, depthFunc() {}, clearDepth() {}, clear() {},
  };
  const canvasFactory = () => ({
    style: {}, width: 100, height: 100,
    getContext: (kind) => kind === 'webgl2' ? gl : ctx2d,
  });
  class FakePetModel {
    async loadFromSetting() {}
    setCatEarsVisible() {}
    update(dt) { modelUpdates.push(dt); }
    isReady() { return true; }
    getStaticBounds() { return { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5 }; }
    getModel() { return { getDrawableCount: () => 1, getDrawableOpacity: () => 1, getDrawableVertices: () => [0, 0] }; }
    isEarDrawable() { return false; }
    getModelMatrix() { return { setMatrix() {} }; }
    draw() {}
    setPhysicsWind(wx, wy) { winds.push([wx, wy]); }
    setLookTarget(x, y) { looks.push([x, y]); }
  }
  const pendantCode = ts.transpileModule(readFileSync(new URL('../src/pendant.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const settingsModule = await import(`data:text/javascript,${encodeURIComponent(settingsJs)}`);
  const physicsModule = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  const windowObj = {
    devicePixelRatio: 1,
    matchMedia: () => ({ get matches() { return reduceMotion; } }),
  };
  const storage = { getItem: () => JSON.stringify({ pendantEnabled: true, pendantScale: 1, pendantRopeLength: 100 }), setItem() {} };
  const deps = {
    '@framework/live2dcubismframework': { CubismFramework: { startUp() {}, initialize() {} } },
    '@framework/math/cubismmatrix44': { CubismMatrix44: class { scale() {} translate() {} } },
    './pet-model': { PetModel: FakePetModel },
    './pendant-physics': physicsModule,
    './settings': settingsModule,
    '@tauri-apps/api/window': { getCurrentWindow: () => ({ show: async () => {}, hide: async () => {} }) },
    '@tauri-apps/api/event': { listen: async (name, cb) => { listeners.set(name, cb); } },
  };
  const context = vm.createContext({
    console, Math, Number, Array, Promise,
    Float32Array, Uint8Array, ArrayBuffer,
    localStorage: storage,
    fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    Live2DCubismCore: { Version: { csmGetLatestMocVersion: () => 1, csmGetMocVersion() {} } },
    window: windowObj,
    document: {
      get hidden() { return hidden; },
      getElementById: () => ({ clientWidth: 1920, clientHeight: 1080, appendChild() {} }),
      createElement: canvasFactory,
      addEventListener: (ev, cb) => docListeners.set(ev, cb),
    },
    performance: { now: () => now },
    setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => { const id = nextId++; rafs.set(id, fn); return id; },
    cancelAnimationFrame: (id) => rafs.delete(id),
    exports: {},
    require: (id) => {
      if (deps[id]) return deps[id];
      throw new Error(`unexpected require: ${id}`);
    },
  });
  vm.runInContext(pendantCode, context);
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);

  // 通过 settings-changed 显式开启吊坠（不依赖模块外 ESM global localStorage），并等待模型与节拍器就绪。
  await listeners.get('settings-changed')({ payload: { pendantEnabled: true, pendantScale: 1, pendantRopeLength: 100 } });
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);

  // 1) 首次 cursor 到达：静止时用 setTimeout 预睡眠等待 30fps 间隔，而非每 vsync 空转 rAF。
  listeners.get('pendant-cursor')({ payload: { x: 400, y: 200, wx: 0, wy: 0 } });
  assert.equal(timers.size, 1, '30fps 空闲态应使用 setTimeout 睡眠对齐，避免高刷屏空转 rAF');
  assert.equal(rafs.size, 0);

  // 推进一帧，光标陡移激发风力，验证风力被平滑滤波（单帧不瞬间飙到 MAX_WIND=1）。
  const stepFrame = (advanceMs) => {
    now += advanceMs;
    for (const [id, t] of [...timers]) { if (t.at <= now) { timers.delete(id); t.fn(); } }
    for (const [id, fn] of [...rafs]) { rafs.delete(id); fn(now); }
  };
  stepFrame(40);
  listeners.get('pendant-cursor')({ payload: { x: 900, y: 200, wx: 0, wy: 0 } });
  stepFrame(20);
  const firstWind = winds.at(-1);
  assert.ok(Math.hypot(firstWind[0], firstWind[1]) > 0 && Math.hypot(firstWind[0], firstWind[1]) < 0.5,
    `突跳加速度的风力应经低通平滑而非单帧打满: ${JSON.stringify(firstWind)}`);
  // 刚向右拉开、身体倾角尚未追上绳角时，局部视线应向右偏往锚点。
  assert.ok(looks.at(-1)[0] > 0.6, `锚点在身体右上方时局部视线应偏右，实际 ${JSON.stringify(looks.at(-1))}`);

  // 2) 摆荡越过下方（倾角仍朝右、锚点转为左上方）时，局部视线应反旋到左侧追踪锚点。
  for (let i = 0; i < 10; i++) {
    listeners.get('pendant-cursor')({ payload: { x: 900 + i * 25, y: 200, wx: 0, wy: 0 } });
    stepFrame(18);
  }
  const latestLook = looks.at(-1);
  assert.ok(latestLook[0] < 0.5 && latestLook[1] > 0.5,
    `身体顺时针过冲后锚点落在头部左上方，局部视线应偏左上，实际 ${JSON.stringify(latestLook)}`);

  // 3) 少动态效果下关闭摆荡与风力，只保持 30fps 垂挂。
  reduceMotion = true;
  stepFrame(40);
  assert.deepEqual(winds.at(-1), [0, 0]);
  assert.equal(timers.size, 1);

  // 4) 后台 hidden 暂停调度，回到可见后恢复。
  hidden = true;
  stepFrame(40);
  assert.equal(timers.size, 0);
  assert.equal(rafs.size, 0);
  hidden = false;
  docListeners.get('visibilitychange')?.();
  assert.equal(timers.size + rafs.size > 0, true, '切回可见后应恢复渲染调度');

  // 清理避免进程残留定时器。
  await listeners.get('settings-changed')({ payload: { pendantEnabled: false } });
  assert.equal(timers.size, 0);
  assert.equal(rafs.size, 0);
});
