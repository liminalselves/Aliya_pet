import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const uiRoot = fileURLToPath(new URL('../', import.meta.url));
const frameworkRoot = resolve(uiRoot, '../../third_party/cubism-web-sdk/Framework/src');

// Execute the repository SDK, including its JSON parser and easing functions, in
// one realm. Cache before evaluating to support the SDK's self/cyclic imports.
// Only ID-manager initialization is replaced: no Core, WebGL or model assets are
// required for these parameter-level integration tests. Nothing is emitted.
const context = vm.createContext({ console, TextDecoder, TextEncoder });
const modules = new Map();
function load(filename) {
  filename = resolve(filename);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    fileName: filename,
  }).outputText;
  const require = id => {
    if (id.startsWith('@framework/')) return load(resolve(frameworkRoot, `${id.slice(11)}.ts`));
    assert.ok(id.startsWith('.'), `unexpected nonlocal SDK import: ${id}`);
    return load(resolve(dirname(filename), `${id}.ts`));
  };
  vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, {
    filename,
  })(require, module, module.exports);
  return module.exports;
}
const sdk = name => load(resolve(frameworkRoot, `${name}.ts`));
const { CubismFramework } = sdk('live2dcubismframework');
CubismFramework.getIdManager = () => ({ getId: id => id });
sdk('utils/cubismjson').Value.staticInitializeNotForClientCall();
const { CubismEyeBlink } = sdk('effect/cubismeyeblink');
const { CubismExpressionMotion } = sdk('motion/cubismexpressionmotion');
const { CubismExpressionMotionManager } = sdk('motion/cubismexpressionmotionmanager');
const { ContinuousEyeBlinkUpdater, FadingExpressionUpdater } = load(resolve(uiRoot, 'src/animation-updaters.ts'));

const eyeIds = ['ParamEyeLOpen', 'ParamEyeROpen'];
function model(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getParameterValueById: id => values.get(id) ?? 0,
    setParameterValueById(id, value, weight = 1) {
      values.set(id, this.getParameterValueById(id) * (1 - weight) + value * weight);
    },
  };
}
function blink(interval = 0.12) {
  const result = CubismEyeBlink.create();
  result.setParameterIds(eyeIds);
  result.setBlinkingSetting(0.08, 0.04, 0.12);
  // Keep the real SDK state machine while removing only random scheduling.
  result.determinNextBlinkingTiming = () => result._userTimeSeconds + interval;
  return result;
}
function expression(value, fadeIn = 0.4, fadeOut = 0.4) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    FadeInTime: fadeIn,
    FadeOutTime: fadeOut,
    // Aliya happy/sleepy eye-open expressions use Multiply, not Overwrite.
    Parameters: [{ Id: eyeIds[0], Value: value, Blend: 'Multiply' }],
  }));
  return CubismExpressionMotion.create(bytes.buffer, bytes.byteLength);
}
function expressionFrame(updater, target, dt) {
  // The motion/base layer is restored each frame, as in the application pipeline.
  target.setParameterValueById(eyeIds[0], 1);
  updater.onLateUpdate(target, dt);
  const value = target.getParameterValueById(eyeIds[0]);
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `invalid eye value ${value}`);
  return value;
}

// This would fail with SDK CubismEyeBlinkUpdater's motion-active early return:
// the reference passes through complete blinks while the displayed motion wins.
test('motion-owned eyes retain asymmetric output while the real blink clock and phase advance', () => {
  const running = blink();
  const reference = blink();
  const target = model();
  const referenceModel = model();
  const updater = new ContinuousEyeBlinkUpdater(() => true, running);
  let referenceClosedFrames = 0;
  for (let frame = 0; frame < 180; frame++) {
    target.setParameterValueById(eyeIds[0], 0.23);
    target.setParameterValueById(eyeIds[1], 0.81);
    updater.onLateUpdate(target, 1 / 120);
    reference.updateParameters(referenceModel, 1 / 120);
    assert.equal(target.getParameterValueById(eyeIds[0]), 0.23);
    assert.equal(target.getParameterValueById(eyeIds[1]), 0.81);
    assert.equal(running._blinkingState, reference._blinkingState);
    if (referenceModel.getParameterValueById(eyeIds[0]) === 0) referenceClosedFrames++;
  }
  assert.ok(referenceClosedFrames > 0, 'the reference must actually blink during the motion');
  assert.ok(Math.abs(running._userTimeSeconds - 1.5) < 1e-12);
  assert.equal(running._userTimeSeconds, reference._userTimeSeconds);
});

test('releasing a motion blends each eye from its last displayed value, then rejoins SDK blink output', () => {
  let active = true;
  const running = blink(100);
  const target = model({ [eyeIds[0]]: 0.15, [eyeIds[1]]: 0.72 });
  const updater = new ContinuousEyeBlinkUpdater(() => active, running);
  updater.onLateUpdate(target, 1 / 120);
  active = false;
  const previous = [0.15, 0.72];
  for (let frame = 0; frame < 24; frame++) {
    updater.onLateUpdate(target, 1 / 120);
    eyeIds.forEach((id, i) => {
      const value = target.getParameterValueById(id);
      assert.ok(value >= previous[i] && value <= 1, `eye ${i} must open monotonically`);
      assert.ok(value - previous[i] < 0.08, `eye ${i} jumped on motion release`);
      previous[i] = value;
    });
    if (frame === 0) {
      assert.ok(previous[0] < 0.17, 'first release frame must not snap to fully open');
      assert.ok(previous[1] < 0.74, 'both eyes need their own release origin');
    }
  }
  eyeIds.forEach(id => assert.equal(target.getParameterValueById(id), 1));
  // Re-enter with a different motion output: its next release must originate
  // from the new motion's output, not from the previous motion's cached values.
  active = true;
  target.setParameterValueById(eyeIds[0], 0.85);
  target.setParameterValueById(eyeIds[1], 0.25);
  updater.onLateUpdate(target, 1 / 120);
  active = false;
  updater.onLateUpdate(target, 1 / 120);
  assert.ok(target.getParameterValueById(eyeIds[0]) >= 0.85);
  assert.ok(target.getParameterValueById(eyeIds[1]) >= 0.25 && target.getParameterValueById(eyeIds[1]) < 0.27);
});

test('real SDK expression handoff retains the outgoing expression until the incoming fade is visible', () => {
  const manager = new CubismExpressionMotionManager();
  const updater = new FadingExpressionUpdater(manager);
  const target = model();
  manager.startMotion(expression(0), false);
  expressionFrame(updater, target, 0.01);
  expressionFrame(updater, target, 0.5);
  assert.equal(target.getParameterValueById(eyeIds[0]), 0);
  const outgoing = manager.getCubismMotionQueueEntries()[0];
  manager.startMotion(expression(1), false);
  const first = expressionFrame(updater, target, 0.01);
  assert.equal(manager.getCubismMotionQueueEntries().length, 2);
  assert.ok(manager.getCubismMotionQueueEntries().includes(outgoing));
  assert.ok(first < 0.02, `handoff erased outgoing expression: ${first}`);
  let previous = first;
  for (let frame = 0; frame < 9; frame++) {
    const value = expressionFrame(updater, target, 0.05);
    assert.ok(value >= previous - 1e-12, 'crossfade must not reverse');
    assert.ok(value - previous < 0.21, 'crossfade must not snap to the new expression');
    previous = value;
    if (frame === 3) {
      assert.equal(manager.getCubismMotionQueueEntries().length, 2);
      assert.ok(value > 0.35 && value < 0.65, `expected visible half-fade, got ${value}`);
    }
  }
  assert.equal(manager.getCubismMotionQueueEntries().length, 1);
  assert.equal(target.getParameterValueById(eyeIds[0]), 1);
});

test('rapid SDK expression retriggers reclaim expired entries before the latest fade-in completes', () => {
  const manager = new CubismExpressionMotionManager();
  const rawManager = new CubismExpressionMotionManager();
  const updater = new FadingExpressionUpdater(manager);
  const target = model();
  const rawModel = model();
  let released = 0;
  let maximumQueue = 0;
  let latest;
  for (let frame = 0; frame < 180; frame++) {
    const motion = expression(frame % 2, 0.6, 0.12);
    manager.startMotion(motion, false);
    rawManager.startMotion(expression(frame % 2, 0.6, 0.12), false);
    latest = manager.getCubismMotionQueueEntries().at(-1);
    const release = latest.release.bind(latest);
    latest.release = () => { released++; release(); };
    expressionFrame(updater, target, 1 / 120);
    rawManager.updateMotion(rawModel, 1 / 120);
    const entries = manager.getCubismMotionQueueEntries();
    maximumQueue = Math.max(maximumQueue, entries.length);
    assert.equal(entries.at(-1), latest, 'the active incoming expression must survive cleanup');
    assert.ok(entries.slice(0, -1).every(entry => entry.getEndTime() > manager._userTimeSeconds),
      'an already-faded expression remained queued');
  }
  // With continuous retriggering no latest expression reaches its 0.6 s fade-in,
  // so SDK-only latest-weight cleanup never runs. This control proves that the
  // test exercises the queue-growth regression rather than a normal fade finish.
  assert.equal(rawManager.getCubismMotionQueueEntries().length, 180);
  assert.ok(maximumQueue <= 18, `expired expression queue grew to ${maximumQueue}`);
  assert.ok(released > 150, `expired entries were not released: ${released}`);
  expressionFrame(updater, target, 0.61);
  assert.equal(manager.getCubismMotionQueueEntries().length, 1);
  assert.equal(manager.getCubismMotionQueueEntries()[0], latest);
});
