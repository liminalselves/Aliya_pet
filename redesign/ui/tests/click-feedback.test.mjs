import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(name, imports = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => imports[id] ?? {}, console,
    setTimeout, clearTimeout, performance, ...globals });
  return exports;
}

function harness({ platform = 'browser', touchDevice = false } = {}) {
  let now = 0, area = 'body', speaking = false;
  const globals = { performance: { now: () => now } };
  const recognizer = load('interaction/petting-recognizer', {}, globals);
  const procedural = load('interaction/procedural', {}, globals);
  const petting = load('interaction/petting-controller', { './petting-recognizer': recognizer }, globals);
  const { InteractionService } = load('interaction/interaction', {
    './petting-controller': petting, './procedural': procedural,
  }, globals);
  const writes = {}, trace = [], lines = [], captures = [], masks = [], shellCalls = [], actions = [];
  const target = {
    getInteractionParamInfo: () => ({ angleXMin: -30, angleXMax: 30, angleYMin: -30, angleYMax: 30,
      angleZMin: -30, angleZMax: 30, bodyXMin: -10, bodyXMax: 10,
      eyeLMin: 0, eyeLMax: 1, eyeRMin: 0, eyeRMax: 1, hasEyes: true }),
    setInteractionOffsets(...v) { writes.offsets = v; trace.push(['offsets', ...v]); },
    setEyeOverride(...v) { writes.eyes = v; trace.push(['eyes', ...v]); },
    setPettingLookAtReduction(v) { writes.reduced = v; },
    setEarInteraction(...v) { writes.ears = v; }, setFaceCheek(...v) { writes.cheek = v; },
  };
  const hitAreas = { hitAreaAt: () => area, isInHeadPetZone: () => area === 'head' };
  const service = new InteractionService({ hitAreas, getTarget: () => target,
    dialogue: { resolveSceneTag: (_scene, tag) => ({ entryId: tag, pages: [{ text: tag }] }) },
    pettingHost: { isDialogueActive: () => speaking, playPettingDialogue() {} }, playCharacterAction: name => { actions.push(name); return true; } });
  const canvasEvents = {}, windowEvents = {};
  const window = { innerWidth: 800, innerHeight: 800, addEventListener: (name, fn) => { windowEvents[name] = fn; } };
  const { PetApp } = load('pet-app', { './platform': { platform, isTouchDevice: touchDevice,
    androidShell: () => ({ setInteracting: value => shellCalls.push(value) }) } }, { ...globals, window });
  const { InteractionCoordinator } = load('interaction/coordination', {}, globals);
  const app = Object.create(PetApp.prototype);
  Object.assign(app, {
    _canvas: { width: 800, addEventListener: (name, fn) => { canvasEvents[name] = fn; },
      setPointerCapture: id => captures.push(id), getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }) },
    _interaction: service, _hitAreas: hitAreas,
    _coordination: new InteractionCoordinator(() => ({ interacting: service.isBusy, speaking, paused: false }), () => now),
    _behavior: { updateLookTarget() {}, clearLookTarget() {}, isDragging: false },
    _remoteChat: { open: false }, _chatView: { isOpen: false, pointerActive: false },
    _dialogue: { resolveSceneTag: (_scene, tag) => ({ pages: [{ text: tag }] }) },
    _bubble: { play: r => lines.push(r.pages[0].text), cancel: () => assert.fail('点击不能取消现有气泡') },
    _activePointerId: null, _leftDown: false, _touchPetting: false, _touchTapCandidate: false,
    _dragCandidate: false, _dragging: false, _wrapWindow: false, _scaleFactor: 1,
    _winPhysX: 0, _winPhysY: 0, _hitMaskData: new Uint8Array(96 * 96).fill(1), _hitMaskRows: 96,
    _hitMaskInteracting: false, _hitMaskLastMs: 0, _hitMaskSentMs: 0,
    _hitMaskSend: args => masks.push(args), _settings: { mirror: false },
    _syncWindowMetrics() {}, _cancelSnapAnimation() {}, _moveWindowBy() {}, _onDragFinished() {},
  });
  service.playClickDialogue = tag => app._playInteraction(tag);
  service.isDialogueActive = () => speaking;
  app._wirePointerEvents();
  const event = (overrides = {}) => ({ pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons: 1, clientX: 400, clientY: 200, screenX: 400, screenY: 200, ...overrides });
  const ctx = (x = 400, secondary = true) => ({ normX: .5, normY: .2, pxX: x, pxY: 200,
    dtSeconds: 1 / 60, leftPressed: !secondary, isSecondary: secondary });
  const advance = ms => { now += ms; service.tick(ms); };
  return { app, service, writes, trace, lines, captures, masks, shellCalls, actions, canvasEvents, windowEvents, event, ctx, advance,
    area: value => { area = value; }, speaking: value => { speaking = value; }, setTime: value => { now = value; },
    click(overrides = {}) { canvasEvents.pointerdown(event(overrides)); canvasEvents.pointerup(event({ ...overrides, buttons: 0 })); },
    stroke() { for (let i = 1; i <= 90; i++) { now += 1000 / 60;
      service.onPointerMove(ctx(400 + 40 * Math.sin(i / 60 * Math.PI * 2))); service.tick(1000 / 60); } },
  };
}

test('八连点后的冷却仍有低幅反馈，耳朵共享限频且不续台词或高强度动作', () => {
  for (const area of ['body', 'head', 'hand', 'tablet', 'ear_left', 'ear_right']) {
    const h = harness(); h.area('body');
    for (let i = 0; i < 8; i++) { h.click(); h.advance(100); }
    assert.equal(h.service.clickSequence.isInCooldown, true);
    for (let i = 0; i < 40; i++) h.advance(16); // 按帧推进至中性。
    const lines = h.lines.length, actions = h.actions.length;
    const apply = h.service.procedural.apply.bind(h.service.procedural); let starts = 0;
    h.service.procedural.apply = reaction => { starts++; return apply(reaction); };
    h.area(area); h.click(); h.advance(140);
    assert.equal(starts, 1); assert.ok(Math.abs(h.writes.offsets[1]) > .5);
    assert.ok(Math.abs(h.writes.offsets[1]) <= 1.05 + 1e-6, '仅低幅度点头');
    h.click(); assert.equal(starts, 1, '240ms内不重启反馈');
    h.advance(100); h.click(); assert.equal(starts, 2, '限频结束即可打断续接');
    for (let i = 0; i < 10; i++) { h.advance(100); h.click(); }
    assert.equal(h.lines.length, lines); assert.equal(h.actions.length, actions);
    for (let i = 0; i < 40; i++) h.advance(16);
    assert.deepEqual(h.writes.offsets, [0, 0, 0, 0]);
    h.advance(1000); h.area('body'); h.click();
    assert.equal(h.service.clickSequence.isInCooldown, false, '持续点击不延长全局冷却');
    assert.equal(h.lines.length, lines + 1, '冷却后重新允许正常台词');
  }
});

for (const ending of ['cancel', 'onModelReloaded', 'onWindowClosed']) test(`冷却反馈经${ending}释放且重置限频`, () => {
  const h = harness();
  for (let i = 0; i < 8; i++) { h.click(); h.advance(100); }
  h.advance(600); h.click(); h.advance(60);
  h.service[ending](); for (let i = 0; i < 100; i++) h.advance(16);
  assert.deepEqual(h.writes.offsets, [0, 0, 0, 0]);
  assert.equal(h.service.procedural.isPlaying, false);
  assert.equal(h.service._basicClickUntilMs, 0);
});

for (const chat of ['local', 'remote']) test(`${chat}聊天打开时身体、手部、平板和未命名可见区仍有视觉反馈`, () => {
  for (const area of ['body', 'hand', 'tablet', null]) {
    const h = harness(); h.area(area);
    if (chat === 'local') h.app._chatView.isOpen = true; else h.app._remoteChat.open = true;
    h.click(); h.advance(100);
    assert.equal(h.service.procedural.isPlaying, true, `${area}必须独立于台词产生反应`);
    assert.ok(h.writes.offsets.some(v => Math.abs(v) > .1), `${area}存在可见偏移`);
    assert.deepEqual(h.lines, []);
  }
});

test('气泡播放或协调器拒绝台词时，普通点击仍响应且不重启台词', () => {
  for (const blocked of ['speaking', 'coordinator']) for (const area of ['head', 'face', 'body', 'hand', 'tablet', 'ear_left']) {
    const h = harness(); h.area(area);
    if (blocked === 'speaking') h.speaking(true); else h.app._coordination.canSpeak = () => false;
    h.click(); h.advance(100);
    assert.equal(h.service.procedural.isPlaying, true);
    assert.ok(h.writes.offsets.some(v => Math.abs(v) > .01) || h.writes.cheek?.[1] > 0 || h.writes.eyes?.[0]);
    assert.deepEqual(h.lines, []);
  }
});

test('finishing立即接受新点击：无清零帧、单写入者、连续恢复闭眼与头部', () => {
  for (const area of ['head', 'face', 'body', 'ear_left', 'ear_right']) {
    const h = harness(); h.area('head'); h.service.onPointerDown(h.ctx()); h.stroke();
    assert.equal(h.service.petting.state, 'petting');
    h.service.onPointerUp(h.ctx()); assert.equal(h.service.petting.state, 'finishing');
    const offsets = [...h.writes.offsets], eyes = [...h.writes.eyes];
    h.area(area); h.trace.length = 0;
    h.service.onPointerDown(h.ctx(400, false)); h.service.onPointerUp(h.ctx(400, false));
    h.service.onClick(h.ctx(400, false), false);
    assert.equal(h.service.procedural.isPlaying, true, area);
    assert.equal(h.service.petting.state, 'inactive');
    assert.equal(h.trace.length, 0, '交接时不能重置覆盖参数');
    h.service.tick(0);
    assert.deepEqual(h.writes.offsets, offsets);
    assert.deepEqual(h.writes.eyes.slice(0, 3), eyes.slice(0, 3));
    const effectiveEyes = ([enabled, left, right, side = 'both']) => !enabled ? [1, 1]
      : [side === 'right' ? 1 : left, side === 'left' ? 1 : right];
    let previous = [...h.writes.offsets], previousEyes = effectiveEyes(h.writes.eyes);
    for (let i = 0; i < 190; i++) {
      h.trace.length = 0; h.advance(16);
      assert.ok(h.trace.filter(w => w[0] === 'offsets').length <= 1, '一帧仅一个通道所有者');
      h.writes.offsets.forEach((v, j) => assert.ok(Math.abs(v - previous[j]) < 1.5, `${area}头部不能跳变`));
      const eyesNow = effectiveEyes(h.writes.eyes);
      eyesNow.forEach((v, j) => assert.ok(Math.abs(v - previousEyes[j]) < .22, `${area}眼睛不能跳变`));
      previous = [...h.writes.offsets]; previousEyes = eyesNow;
    }
    assert.equal(h.service.isBusy, false); assert.deepEqual(h.writes.offsets, [0, 0, 0, 0]);
    assert.equal(h.writes.eyes[0], false); assert.equal(h.writes.reduced, false);
  }
});

test('接管过程中再次点击从可见姿态续接，取消短反应也完整释放恢复通道', () => {
  for (const cancel of [false, true]) {
    const h = harness(); h.area('head'); h.service.onPointerDown(h.ctx()); h.stroke();
    h.service.onPointerUp(h.ctx()); h.area('body'); h.service.onClick(h.ctx(400, false), false);
    h.advance(80);
    const visible = [...h.writes.offsets], eyes = [...h.writes.eyes];
    if (cancel) h.service.cancel();
    else { h.area('face'); h.service.onClick(h.ctx(400, false), false); }
    h.service.tick(0);
    assert.deepEqual(h.writes.offsets, visible, '重复接管不回到初始抚摸姿态');
    assert.deepEqual(h.writes.eyes.slice(0, 3), eyes.slice(0, 3));
    for (let i = 0; i < 190; i++) h.advance(16);
    assert.equal(h.service.isBusy, false); assert.deepEqual(h.writes.offsets, [0, 0, 0, 0]);
    assert.equal(h.writes.eyes[0], false);
  }
});

test('Android头部触摸保留抚摸仲裁，结束与取消成对解锁且不触发窗口拖动', () => {
  for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
    const h = harness({ platform: 'android' }); h.app._wrapWindow = true; h.area('head');
    h.canvasEvents.pointerdown(h.event({ pointerType: 'touch' }));
    assert.equal(h.service.petting.state, 'pressed'); assert.deepEqual(h.shellCalls, [true]);
    h.canvasEvents.pointermove(h.event({ pointerType: 'touch', clientX: 420, screenX: 420 }));
    assert.equal(h.app._dragging, false);
    if (ending === 'blur') h.windowEvents.blur();
    else h.canvasEvents[ending](h.event({ pointerType: 'touch', buttons: 0 }));
    assert.deepEqual(h.shellCalls, [true, false]); assert.equal(h.app._activePointerId, null);
    assert.equal(h.app._touchPetting, false); assert.equal(h.app._dragCandidate, false);
  }
});

test('带触屏设备的鼠标左键仍可点击和拖动，只有touch头部走抚摸候选', () => {
  const h = harness({ touchDevice: true }); h.area('head');
  h.canvasEvents.pointerdown(h.event());
  assert.equal(h.app._touchPetting, false); assert.equal(h.service.petting.state, 'inactive');
  assert.equal(h.app._dragCandidate, true);
  h.canvasEvents.pointerup(h.event({ buttons: 0 })); h.advance(100);
  assert.equal(h.service.procedural.isPlaying, true);
  h.canvasEvents.pointerdown(h.event()); h.canvasEvents.pointermove(h.event({ clientX: 410, screenX: 410 }));
  assert.equal(h.app._dragging, true); h.canvasEvents.pointerup(h.event({ buttons: 0 }));
  const t = harness({ touchDevice: true }); t.area('head'); t.click({ pointerType: 'touch' }); t.advance(100);
  assert.equal(t.service.procedural.isPlaying, true, '触摸轻点也必须有视觉反应');
  assert.equal(t.service.petting.dailyState.headPettingCountToday, 0);
});

test('Windows透明命中与指针交接立即锁定右键，up/cancel/失焦后恢复按像素穿透', () => {
  for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
    const h = harness({ platform: 'tauri' }); h.area('head');
    h.canvasEvents.pointerdown(h.event({ button: 2, buttons: 2 }));
    assert.equal(h.masks.at(-1)?.interacting, true, `${ending}: 不能等待下一渲染帧`);
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      h.canvasEvents[event](h.event({ pointerId: 2, button: 2, buttons: 0 }));
      assert.equal(h.app._activePointerId, 1, '无关指针不能解除当前手势');
      assert.equal(h.masks.at(-1).interacting, true);
    }
    h.app._hitMaskData.fill(0);
    h.canvasEvents.pointermove(h.event({ button: -1, buttons: 2, clientX: 600, screenX: 600 }));
    if (ending === 'blur') h.windowEvents.blur();
    else h.canvasEvents[ending](h.event({ button: 2, buttons: 0 }));
    assert.equal(h.masks.at(-1).interacting, false);
    assert.ok(h.masks.at(-1).data.every(v => v === 0), '恢复真实掩码而非整窗接收');
  }
  const h = harness({ platform: 'tauri' }); h.app._hitMaskData.fill(0); h.click();
  assert.equal(h.captures.length, 0); assert.deepEqual(h.lines, []); assert.equal(h.service.procedural.isPlaying, false);
});

test('静止剪影保持TTL心跳，窗口移动和DPI/尺寸改变不会被相同掩码去重', () => {
  const h = harness({ platform: 'tauri' });
  const pixels = new Uint8ClampedArray(96 * 96 * 4).fill(255);
  Object.assign(h.app, { _model: { isReady: () => true },
    _hitMaskCanvas: { width: 96, height: 96 }, _hitMaskCtx: {
      clearRect() {}, save() {}, translate() {}, scale() {}, drawImage() {}, restore() {}, fillRect() {},
      getImageData: () => ({ data: pixels }),
    }, _chatView: { hitRects: () => [] },
  });
  h.setTime(200); h.app._maybeSendHitMask();
  const initial = h.masks.length;
  h.app._winPhysX = 321; h.app._winPhysY = -123; h.setTime(400); h.app._maybeSendHitMask();
  assert.equal(h.masks.length, initial + 1); assert.equal(h.masks.at(-1).winX, 321); assert.equal(h.masks.at(-1).winY, -123);
  h.app._scaleFactor = 1.5; h.setTime(600); h.app._maybeSendHitMask();
  assert.equal(h.masks.at(-1).winW, 1200); assert.equal(h.masks.at(-1).winH, 1200);
  const before = h.masks.length; h.setTime(800); h.app._maybeSendHitMask();
  assert.equal(h.masks.length, before, '仍保留短期去重');
  h.setTime(1800); h.app._maybeSendHitMask(); assert.equal(h.masks.length, before + 1, '在1.5s TTL前刷新');
});

test('监听降级提示区域加入Windows命中掩码，成功移除提示后恢复穿透', () => {
  const h = harness({ platform: 'tauri' }), pixels = new Uint8ClampedArray(96 * 96 * 4), fills = [];
  Object.assign(h.app, { _model: { isReady: () => true },
    _shellSyncNotice: { getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }) },
    _hitMaskCanvas: { width: 96, height: 96 }, _hitMaskCtx: {
      clearRect() { pixels.fill(0); }, save() {}, translate() {}, scale() {}, drawImage() {}, restore() {},
      fillRect(x, y, w, h) {
        fills.push([x, y, w, h]);
        for(let row=y;row<Math.min(96,y+h);row++)for(let col=x;col<Math.min(96,x+w);col++)pixels[(row*96+col)*4+3]=255;
      }, getImageData: () => ({ data: pixels }),
    }, _chatView: { hitRects: () => [] },
  });
  h.setTime(200); h.app._maybeSendHitMask();
  assert.deepEqual(fills, [[12, 6, 25, 13]]);assert.equal(h.masks.at(-1).data[8 * 96 + 14], 1);
  h.app._shellSyncNotice = null; h.setTime(400); h.app._maybeSendHitMask();
  assert.ok(h.masks.at(-1).data.every(v => v === 0));
});
