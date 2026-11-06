import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = new Map();
function load(name, imports, globals) {
  if (!code.has(name)) code.set(name, ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText);
  const exports = {};
  vm.runInNewContext(code.get(name), { exports, require: id => imports[id] ?? {}, ...globals }, { filename: `${name}.ts` });
  return exports;
}

// Real PetApp listeners -> BehaviorService -> GazeController, plus the real
// interaction/petting/coordinator services. Only DOM, native shell and model I/O
// are boundaries here; this is not an Android WebView or physical-device test.
function harness({ overlay = false, autoActions = false, mirror = false, platform = 'android' } = {}) {
  let now = 0, nextTimer = 0, area = 'body', speaking = false;
  const timers = new Map(), targets = [], actions = [], lines = [], shellCalls = [], moves = [];
  const globals = {
    console, performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const { BehaviorService } = load('behavior', {}, globals);
  const { GazeController } = load('gaze', {}, globals);
  const gaze = new GazeController({ updateParameters() {} }, 'eyeX', 'eyeY');
  const parameters = new Map();
  const model = {
    boundsW: 0.6, boundsH: 1, boundsAspect: 0.6, isReady: () => true, isActionPlaying: false,
    setLookTarget(x, y) { targets.push([x, y]); gaze.setTarget(x, y); },
    clearLookTarget() { gaze.clearTarget(); },
    playAction(name) { actions.push(name); return true; },
    getParameterValueById: id => parameters.get(id) ?? 0,
    setParameterValueById: (id, value) => parameters.set(id, value),
    addParameterValueById: (id, value) => parameters.set(id, (parameters.get(id) ?? 0) + value),
    getInteractionParamInfo: () => ({ angleXMin: -30, angleXMax: 30, angleYMin: -30, angleYMax: 30,
      angleZMin: -30, angleZMax: 30, bodyXMin: -10, bodyXMax: 10,
      eyeLMin: 0, eyeLMax: 1, eyeRMin: 0, eyeRMax: 1, hasEyes: true }),
    setInteractionOffsets() {}, setEyeOverride() {}, setEarInteraction() {}, setFaceCheek() {},
    setPettingLookAtReduction(value) { this.reduction = value ? 0.25 : 1; },
    update(dt) {
      parameters.set('eyeX', 0); parameters.set('eyeY', 0);
      gaze.update(model, dt, { motionActive: model.isActionPlaying, reduction: model.reduction ?? 1 });
    },
  };
  const recognizer = load('interaction/petting-recognizer', {}, globals);
  const petting = load('interaction/petting-controller', { './petting-recognizer': recognizer }, globals);
  const procedural = load('interaction/procedural', {}, globals);
  const { InteractionService } = load('interaction/interaction', { './petting-controller': petting, './procedural': procedural }, globals);
  const { InteractionCoordinator } = load('interaction/coordination', {}, globals);
  const hitAreas = { referenceRenderMargin: 1.22, hitAreaAt: () => area, isInHeadPetZone: () => area === 'head' };
  const interaction = new InteractionService({ hitAreas, getTarget: () => model,
    dialogue: { resolveSceneTag: (_scene, tag) => ({ entryId: tag, pages: [{ text: tag }] }) },
    pettingHost: { isDialogueActive: () => speaking, playPettingDialogue: line => lines.push(line) },
    playCharacterAction: name => model.playAction(name),
  });
  const window = new EventTarget();
  Object.assign(window, { innerWidth: 800, innerHeight: 800 });
  const canvas = new EventTarget(), captured = new Set();
  Object.assign(canvas, {
    width: 800, height: 800, style: {},
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }),
  });
  const shell = { setInteracting: value => shellCalls.push(value), moveWindowBy: (x, y) => moves.push([x, y]) };
  const { PetApp } = load('pet-app', {
    './platform': { platform, androidShell: () => shell },
    './embed': { isEmbed: false },
  }, { ...globals, window });
  const app = Object.create(PetApp.prototype);
  const behavior = new BehaviorService(() => model, () => now);
  const coordinator = new InteractionCoordinator(() => ({ interacting: interaction.isBusy, speaking, paused: false }), () => now);
  behavior.canIdle = () => coordinator.canIdle(); behavior.autoActions = autoActions; behavior.mirrorX = mirror; behavior.start();
  Object.assign(app, {
    _canvas: canvas, _model: model, _behavior: behavior, _interaction: interaction, _hitAreas: hitAreas, _coordination: coordinator,
    _settings: { scale: 1, mirror }, _dpr: 1, _scaleFactor: 1, _wrapWindow: overlay,
    _activePointerId: null, _leftDown: false, _touchPetting: false, _touchTapCandidate: false,
    _dragCandidate: false, _dragging: false, _nativeDragging: false, _fullClickThrough: false,
    _hitMaskData: new Uint8Array(96 * 96).fill(1), _hitMaskRows: 96,
    _originCssX: 500, _originCssY: 600, _appliedRectX: 100, _appliedRectY: 200, _contentScaleCss: 600,
    _cancelSnapAnimation() {}, _syncWindowMetrics() {}, _onDragFinished() {},
  });
  interaction.playClickDialogue = tag => lines.push(tag);
  interaction.isDialogueActive = () => speaking;
  app._wirePointerEvents();
  function pointer(type, overrides = {}) {
    const up = ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave'].includes(type);
    const event = new Event(type);
    Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true,
      button: type === 'pointermove' ? -1 : 0, buttons: up ? 0 : 1,
      clientX: 540, clientY: 300, screenX: 540, screenY: 300, ...overrides });
    if (type === 'lostpointercapture') captured.delete(event.pointerId);
    canvas.dispatchEvent(event);
  }
  function advance(ms) {
    const end = now + ms;
    while (now < end) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      const to = Math.min(end, now + 1000 / 60, next?.[1].at ?? Infinity);
      const dt = to - now; now = to;
      if (dt > 0) app._update(dt / 1000);
      if (next && next[1].at <= now) { timers.delete(next[0]); next[1].fn(); }
    }
  }
  return { app, behavior, gaze, model, interaction, pointer, advance, targets, timers, actions, lines, shellCalls, moves, captured,
    get eyeX() { return parameters.get('eyeX') ?? 0; },
    get eyeY() { return parameters.get('eyeY') ?? 0; },
    area(value) { area = value; }, speaking(value) { speaking = value; },
    end(overrides = {}) { pointer('pointerup', overrides); pointer('lostpointercapture', overrides); pointer('pointerleave', overrides); },
    dispose() { behavior.stop(); },
  };
}

for (const overlay of [false, true]) for (const autoActions of [false, true]) {
  const mode = overlay ? 'Android overlay' : 'Android activity';
  test(`${mode}, autoActions=${autoActions}: 短触摸 down/up/leave 后眼球仍跟随，五秒超时平滑回中`, () => {
    const h = harness({ overlay, autoActions });
    try {
      h.pointer('pointerdown'); assert.equal(h.gaze.active, true, 'down 同步设置目标，不等长按或 move');
      assert.equal(h.targets.length, 1, '同一次按下只更新一次目标');
      const target = h.targets.at(-1);
      assert.ok(target[0] > 0.7 && target[1] > 0.5, '实际主界面/悬浮窗坐标都指向右上');
      h.end(); assert.equal(h.gaze.active, true, '触摸抬起产生 leave 不能撤销目标');
      assert.equal(h.app._activePointerId, null); assert.equal(h.app._leftDown, false);
      assert.equal(h.lines.length, 1, '普通点击台词仍发生一次');
      h.advance(200); assert.ok(h.eyeX > 4 && h.eyeY > 1, `短触摸随后产生可见眼球参数: ${h.eyeX}, ${h.eyeY}`);
      h.advance(4799); assert.equal(h.gaze.active, true);
      h.advance(1); assert.equal(h.gaze.active, false); assert.equal(h.behavior.gazeReleased, true);
      const before = h.eyeX; h.advance(1000 / 60);
      assert.ok(h.eyeX > 0 && h.eyeX < before, '释放不是瞬间清零');
      h.advance(1500); assert.ok(Math.abs(h.eyeX) < 0.01 && Math.abs(h.eyeY) < 0.01);
      assert.deepEqual(h.actions, [], '释放本身不播放动作');
    } finally { h.dispose(); }
  });
}

for (const overlay of [false, true]) test(`${overlay ? 'overlay' : 'activity'}: 超时后在相同位置重新轻点也立即恢复，不会被移动阈值吞掉`, () => {
  const h = harness({ overlay });
  try {
    h.pointer('pointerdown'); h.end(); h.advance(6500);
    assert.equal(h.gaze.active, false); assert.equal(h.behavior.gazeReleased, true); assert.ok(Math.abs(h.eyeX) < 0.01);
    h.pointer('pointerdown');
    assert.equal(h.gaze.active, true, '新触摸不是静止鼠标的重复坐标'); assert.equal(h.behavior.gazeReleased, false);
    h.end(); h.advance(200); assert.ok(h.eyeX > 4, '无需移动或长按便再次产生眼球反馈');
    h.advance(4799); assert.equal(h.gaze.active, true);
    h.advance(1); assert.equal(h.gaze.active, false);
  } finally { h.dispose(); }
});

for (const overlay of [false, true]) test(`${overlay ? 'overlay' : 'activity'}: 最终 pointerup 坐标被保留，短滑动不需要长按`, () => {
  const h = harness({ overlay });
  try {
    h.pointer('pointerdown'); h.advance(20);
    const down = h.targets.at(-1);
    h.pointer('pointermove', { clientX: 542, screenX: 542 }); h.advance(20);
    h.end({ clientX: 544, screenX: 544 });
    assert.equal(h.app._dragging, false, '短滑动保持原五像素拖动阈值');
    assert.ok(h.targets.at(-1)[0] > down[0], 'UP 中的最后有效触点也应送入跟随');
    assert.equal(h.gaze.active, true); h.advance(200); assert.ok(h.eyeX > 4);
    h.advance(4799); assert.equal(h.gaze.active, true);
    h.advance(1); assert.equal(h.gaze.active, false);
    assert.equal(h.lines.length, 1);
  } finally { h.dispose(); }
});

for (const overlay of [false, true]) test(`${overlay ? 'overlay' : 'activity'}: 持续 move 不被 leave/重入打断，手势抚摸优先且眼球平滑`, () => {
  const h = harness({ overlay }); h.area('head');
  try {
    h.pointer('pointerdown', { clientX: 360, screenX: 360 });
    assert.equal(h.interaction.petting.state, 'pressed');
    const count = h.targets.length;
    h.pointer('pointerdown', { clientX: 700, screenX: 700 });
    h.pointer('pointermove', { isPrimary: false, pointerId: 2, clientX: 700, screenX: 700 });
    assert.equal(h.targets.length, count, '重入的 down 与第二根手指不能改写当前目标');
    for (const x of [365, 370, 375, 380, 385, 390]) {
      h.advance(50);
      const before = h.eyeX;
      h.pointer('pointermove', { clientX: x, screenX: x });
      h.pointer('pointerleave', { clientX: x, screenX: x });
      assert.equal(h.gaze.active, true, '触摸 leave 不能清除仍由捕获提供的目标');
      assert.equal(h.eyeX, before, '输入事件本身不直接写眼球参数');
      const targetX = 18 * (h.targets.at(-1)[0] * 2 - 1);
      const expected = before + (targetX - before) * (1 - Math.exp(-1 / 60 / 0.12));
      h.advance(1000 / 60);
      assert.ok(Math.abs(h.eyeX - expected) < 1e-6, '实际事件输入沿原有时间常数平滑逼近，而非每次事件重置或跳到目标');
      assert.equal(h.app._dragging, false);
    }
    h.end({ clientX: 390, screenX: 390 });
    assert.equal(h.gaze.active, true); assert.equal(h.interaction.dragReaction.isDragging, false);
    if (overlay) { assert.equal(h.shellCalls[0], true); assert.equal(h.shellCalls.at(-1), false); }
  } finally { h.dispose(); }
});

for (const overlay of [false, true]) test(`${overlay ? 'overlay' : 'activity'}: pointercancel 终止跟随及互动，取消不是一次点击`, () => {
  const h = harness({ overlay }); h.area('head');
  try {
    h.pointer('pointerdown'); h.advance(50); assert.equal(h.gaze.active, true);
    h.pointer('pointercancel', { pointerId: 2 }); assert.equal(h.gaze.active, true, '无关指针不能取消');
    h.pointer('pointercancel');
    assert.equal(h.gaze.active, false, '系统取消本身就应清理，而不是依赖随后的 leave');
    h.pointer('pointerleave');
    assert.equal(h.gaze.active, false); assert.equal(h.app._activePointerId, null);
    assert.equal(h.app._touchPetting, false); assert.equal(h.interaction.petting.recognizer.isGestureActive, false);
    assert.equal(h.timers.size, 0, '真实取消清掉释放定时器'); assert.equal(h.lines.length, 0);
    h.advance(6000); assert.equal(h.gaze.active, false); assert.equal(h.behavior.gazeReleased, false);
    h.pointer('pointerdown'); assert.equal(h.gaze.active, true, '取消后新的短触摸立即生效');
  } finally { h.dispose(); }
});

for (const overlay of [false, true]) test(`${overlay ? 'overlay' : 'activity'}: 意外 lostcapture 取消，正常 up 后的 lostcapture 不清视线`, () => {
  const h = harness({ overlay });
  try {
    h.pointer('pointerdown'); h.pointer('lostpointercapture');
    assert.equal(h.gaze.active, false); assert.equal(h.timers.size, 0); assert.equal(h.lines.length, 0);
    h.pointer('pointerdown'); h.end(); assert.equal(h.gaze.active, true); assert.equal(h.lines.length, 1);
  } finally { h.dispose(); }
});

test('主界面 JS 拖动接管后停止视线，拖动抬起不恢复旧坐标', () => {
  const h = harness();
  try {
    h.pointer('pointerdown'); h.pointer('pointermove', { clientX: 560, screenX: 560 });
    assert.equal(h.app._dragging, true); assert.equal(h.behavior.isDragging, true); assert.equal(h.gaze.active, false);
    h.end({ clientX: 560, screenX: 560 }); assert.equal(h.behavior.isDragging, false); assert.equal(h.gaze.active, false);
    assert.equal(h.timers.size, 0); assert.equal(h.moves.length, 1);
    h.pointer('pointerdown'); h.end(); assert.equal(h.gaze.active, true);
  } finally { h.dispose(); }
});

test('悬浮窗原生 CANCEL -> DragStart -> DragEnd 保留接管，不能用过期触点重新开始跟随', () => {
  for (const cancelled of [false, true]) {
    const h = harness({ overlay: true });
    try {
      h.pointer('pointerdown'); h.pointer('pointercancel'); h.app.onNativeDragStart();
      assert.equal(h.app._nativeDragging, true); assert.equal(h.behavior.isDragging, true); assert.equal(h.gaze.active, false);
      h.pointer('pointerleave'); assert.equal(h.timers.size, 0);
      h.app.onNativeDragEnd(20, 10, 0, cancelled);
      assert.equal(h.app._nativeDragging, false); assert.equal(h.behavior.isDragging, false); assert.equal(h.gaze.active, false);
      assert.equal(h.app._appliedRectX, 120); assert.equal(h.app._appliedRectY, 210);
      assert.equal(h.moves.length, 0, 'JS 不重复搬运原生拖动');
      h.pointer('pointerdown'); h.end(); assert.equal(h.gaze.active, true);
    } finally { h.dispose(); }
  }
});

test('触摸 leave 与真正鼠标离开分流；桌面 Tauri 全局鼠标跟随保持不变', () => {
  for (const platform of ['android', 'web', 'tauri']) {
    const h = harness({ platform });
    try {
      h.pointer('pointerdown'); h.end(); assert.equal(h.gaze.active, true);
      h.pointer('pointerleave', { pointerType: 'mouse' });
      assert.equal(h.gaze.active, platform === 'tauri');
    } finally { h.dispose(); }
  }
});

test('重复触点和微抖不续期，超时后新手势恢复跟随且不抢点击台词', () => {
  const h = harness({ autoActions: true });
  try {
    h.pointer('pointerdown'); h.end(); h.speaking(true);
    h.advance(12001); assert.equal(h.behavior.gazeReleased, true);
    h.speaking(false); h.pointer('pointerdown', { clientX: 500, screenX: 500 }); h.end({ clientX: 500, screenX: 500 });
    assert.equal(h.gaze.active, true); assert.ok(!h.actions.includes('notice'), 'down 的互动安静期先于回神判断');
    h.advance(4000); h.pointer('pointermove', { clientX: 500.5, screenX: 500.5, buttons: 0 });
    h.advance(1000); assert.equal(h.gaze.active, false);
  } finally { h.dispose(); }
});

test('悬浮窗只使用实际提供的窗外点位，屏蔽零坐标，不伪造持续跟随', () => {
  const h = harness({ overlay: true });
  try {
    h.app.onOutsideTouch(0, 0); assert.equal(h.gaze.active, false); assert.equal(h.targets.length, 0);
    h.app.onOutsideTouch(640, 500); assert.equal(h.gaze.active, true); assert.equal(h.targets.length, 1);
    h.advance(5000); assert.equal(h.gaze.active, false, '没有新窗外点时仍按期限释放');
  } finally { h.dispose(); }
  const main = harness();
  try { main.app.onOutsideTouch(640, 500); assert.equal(main.gaze.active, false); }
  finally { main.dispose(); }
});

for (const overlay of [false, true]) test(`${overlay ? 'overlay' : 'activity'}: 镜像短触摸仅翻转一次且保持原命中掩码`, () => {
  const h = harness({ overlay, mirror: true });
  try {
    const mask = h.app._hitMaskData;
    h.pointer('pointerdown'); h.end();
    assert.equal(h.app._hitMaskData, mask); assert.ok(mask.every(v => v === 1));
    assert.equal(h.lines.length, 1); assert.equal(h.app._activePointerId, null);
    assert.ok(h.targets.at(-1)[0] < 0.5); assert.equal(h.gaze.active, true);
    h.advance(200); assert.ok(h.eyeX < -4);
  } finally { h.dispose(); }
});

test('主界面画布透明区只更新视线，不接管互动或扩张命中掩码', () => {
  const h = harness();
  try {
    const mask = h.app._hitMaskData; mask.fill(0);
    h.pointer('pointerdown'); h.end();
    assert.equal(h.app._hitMaskData, mask); assert.ok(mask.every(v => v === 0));
    assert.equal(h.lines.length, 0); assert.equal(h.app._activePointerId, null); assert.equal(h.captured.size, 0);
    assert.equal(h.gaze.active, true);
    // In overlay mode the native transparent region is routed to the underlying
    // app before WebView dispatch; do not manufacture those missing events here.
  } finally { h.dispose(); }
});

for (const overlay of [false, true]) test(`${overlay ? 'overlay' : 'activity'}: 真正往返抚摸继续优先，结束仍保留最后有效视线`, () => {
  const h = harness({ overlay }); h.area('head');
  try {
    h.pointer('pointerdown', { clientX: 360, screenX: 360 });
    for (let i = 1; i <= 90; i++) {
      h.advance(1000 / 60);
      const x = 360 + 35 * Math.sin(i / 60 * Math.PI * 2);
      h.pointer('pointermove', { clientX: x, screenX: x });
    }
    assert.equal(h.interaction.petting.state, 'petting'); assert.equal(h.app._dragging, false);
    assert.equal(h.model.reduction, 0.25, '保持抚摸的视线降权，而不是抢走抚摸');
    h.end({ clientX: 360, screenX: 360 });
    assert.equal(h.gaze.active, true); assert.equal(h.interaction.petting.state, 'finishing');
    assert.equal(h.interaction.petting.dailyState.headPettingCountToday, 1); assert.equal(h.moves.length, 0);
  } finally { h.dispose(); }
});
