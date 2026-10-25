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
// Only ID-manager initialization is replaced: no Core or WebGL is required for
// these parameter-level integration tests. Motion assets are read below; nothing is emitted.
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

const { CubismMotion } = sdk('motion/cubismmotion');
const { CubismMotionManager } = sdk('motion/cubismmotionmanager');
const motionRoot = resolve(uiRoot, 'assets/live2d/aliya');
const motionSetting = JSON.parse(readFileSync(resolve(motionRoot, '16.model3.json'), 'utf8'));
const parameterIds = JSON.parse(readFileSync(resolve(motionRoot, '16.cdi3.json'), 'utf8'))
  .Parameters.map(parameter => parameter.Id);
const motionAssets = new Map(Object.entries(motionSetting.FileReferences.Motions).map(([name, entries]) => {
  assert.equal(entries.length, 1, `${name}: select every registered motion explicitly if variants are added`);
  const [entry] = entries;
  const bytes = new TextEncoder().encode(readFileSync(resolve(motionRoot, entry.File), 'utf8'));
  return [name, { entry, bytes, duration: JSON.parse(new TextDecoder().decode(bytes)).Meta.Duration }];
}));
const newActions = ['shy_sway', 'cheerful_bounce'];
const oldActions = [...motionAssets.keys()].filter(name => !newActions.includes(name));
// This is an independent ownership contract, not a list inferred from the motion
// under test: a missing reset curve must leave a dirty snapshot and fail the test.
const motionDefaults = new Map([
  'ParamMouthForm', 'ParamMouthOpenY', 'ParamEyeLSmile', 'ParamEyeRSmile',
  'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLX', 'ParamBrowRX',
  'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm',
  'Param32', 'Param33', 'Param34', 'Param35',
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamEyeBallX', 'ParamEyeBallY',
  'ParamArmL01', 'ParamArmL02', 'ParamArmR01', 'ParamArmR02',
].map(id => [id, 0]).concat(eyeIds.map(id => [id, 1])));
const specialEyeIds = ['Param33', 'Param34', 'Param35'];
const motionEyeIds = motionSetting.Groups.find(group => group.Name === 'EyeBlink').Ids;

function motionHarness(fps, label, { dirty = false, centeredSmile = false } = {}) {
  assert.equal(motionDefaults.size, 30);
  const indices = new Map(parameterIds.map((id, index) => [id, index]));
  let values = parameterIds.map(id => motionDefaults.get(id) ?? 0.37);
  if (dirty) {
    for (const [id, value] of motionDefaults) {
      if (!specialEyeIds.includes(id)) values[indices.get(id)] = value === 1 ? 0.75 : 0.25;
    }
  }
  let saved = values.slice();
  const target = {
    getParameterIndex(id) {
      assert.ok(indices.has(id), `${label}: unknown model parameter ${id}`);
      return indices.get(id);
    },
    getParameterValueByIndex: index => values[index],
    getParameterValueById(id) { return values[this.getParameterIndex(id)]; },
    setParameterValueByIndex(index, value, weight = 1) {
      const id = parameterIds[index];
      assert.ok(motionDefaults.has(id), `${label}: motion stole ownership of ${id}`);
      values[index] = values[index] * (1 - weight) + value * weight;
    },
    setParameterValueById(id, value, weight = 1) {
      this.setParameterValueByIndex(this.getParameterIndex(id), value, weight);
    },
    isRepeat: () => false,
    loadParameters() { values = saved.slice(); },
    saveParameters() { saved = values.slice(); },
  };
  const manager = new CubismMotionManager();
  const motions = new Map();
  let highSmileFrames = 0;
  function assertDefaults(reason) {
    for (const [id, expected] of motionDefaults) {
      const actual = target.getParameterValueById(id);
      assert.ok(Math.abs(actual - expected) < 1e-7,
        `${label}: ${reason}: ${id} froze at ${actual}, expected ${expected}`);
      assert.ok(Math.abs(saved[indices.get(id)] - expected) < 1e-7,
        `${label}: ${reason}: saved ${id} did not reset to ${expected}`);
    }
  }
  function frame() {
    // Match PetModel's persistent motion layer exactly: never replace the saved
    // snapshot with defaults, and never clear outgoing SDK queue entries.
    target.loadParameters();
    manager.updateMotion(target, 1 / fps);
    target.saveParameters();
    for (const id of motionDefaults.keys()) {
      assert.ok(Number.isFinite(target.getParameterValueById(id)), `${label}: nonfinite ${id}`);
    }
    for (const id of specialEyeIds) {
      assert.equal(target.getParameterValueById(id), 0, `${label}: unsafe special-eye selector ${id}`);
    }
    // Strict centering is checked on isolated assets. Crossfades may mix an
    // outgoing smile with an incoming gaze; final displayed eye travel is also
    // constrained by the existing GazeController.
    if (centeredSmile && Math.max(...['ParamEyeLSmile', 'ParamEyeRSmile']
      .map(id => target.getParameterValueById(id))) >= 0.7) {
      highSmileFrames++;
      for (const id of ['ParamEyeBallX', 'ParamEyeBallY']) {
        assert.ok(Math.abs(target.getParameterValueById(id)) < 1e-7, `${label}: smiling gaze moved ${id}`);
      }
    }
  }
  return {
    manager,
    value: id => target.getParameterValueById(id),
    start(name) {
      const asset = motionAssets.get(name);
      assert.ok(asset, `${label}: action missing from model3: ${name}`);
      if (!motions.has(name)) {
        // Consistency checks exercise real SDK parsing and metadata accounting;
        // reuse the same instance on self-retrigger, as PetModel's cache does.
        const motion = CubismMotion.create(asset.bytes.buffer, asset.bytes.byteLength, undefined, undefined, true);
        assert.ok(motion, `${label}: SDK rejected ${name}`);
        motion.setEffectIds(motionEyeIds, []);
        motion.setFadeInTime(asset.entry.FadeInTime ?? 1);
        motion.setFadeOutTime(asset.entry.FadeOutTime ?? 1);
        motions.set(name, motion);
      }
      assert.notEqual(manager.startMotionPriority(motions.get(name), false, 2), -1);
    },
    advance(seconds) {
      for (let frameIndex = 0; frameIndex < Math.ceil(seconds * fps); frameIndex++) frame();
    },
    finish(name) {
      const { duration } = motionAssets.get(name);
      for (let frameIndex = 0; frameIndex < Math.ceil((duration + 0.4) * fps); frameIndex++) {
        frame();
        // The 1.2 s neutral tail must already be stable before the SDK expires
        // the motion, not just be repaired after its queue entry disappears.
        if ((frameIndex + 1) / fps >= duration - 0.9) assertDefaults('neutral tail / post-finish snapshot');
      }
      assert.ok(manager.isFinished(), `${label}: action never completed`);
      assert.equal(manager.getCubismMotionQueueEntries().length, 0, `${label}: expired queue entries remain`);
      assertDefaults('natural finish');
      for (const [index, id] of parameterIds.entries()) {
        if (!motionDefaults.has(id)) assert.equal(values[index], 0.37, `${label}: changed unowned ${id}`);
      }
      return highSmileFrames;
    },
  };
}

function checkMotionHandoff(from, to, fps, interruptAt = 0.85) {
  const label = `${from} -> ${to} at ${interruptAt}s / ${fps} FPS`;
  const harness = motionHarness(fps, label);
  harness.start(from);
  // SDK initializes the local motion clock on its first update, not at start().
  // Prime that frame so even the 15 FPS sample reaches at least interruptAt.
  harness.advance(1 / fps);
  harness.advance(interruptAt);
  if (from === 'shy_sway' && interruptAt === 0.85) {
    // The default handoff matrix must interrupt an actually retracted arm pose,
    // not a neutral frame that could hide missing reset curves in the receiver.
    for (const id of ['ParamArmL02', 'ParamArmR02']) {
      assert.ok(harness.value(id) < -9.5, `${label}: ${id} was not folded inward before interruption`);
    }
    for (const id of ['ParamArmL01', 'ParamArmR01']) {
      assert.ok(harness.value(id) < -4.9 && harness.value(id) > -6.1,
        `${label}: ${id} must tuck the upper arm against the coat while the forearm stays folded`);
    }
  }
  const outgoing = harness.manager.getCubismMotionQueueEntries()[0];
  assert.ok(outgoing && !harness.manager.isFinished(), `${label}: interruption must occur during playback`);
  let released = 0;
  const release = outgoing.release.bind(outgoing);
  outgoing.release = () => { released++; release(); };
  harness.start(to);
  assert.equal(harness.manager.getCubismMotionQueueEntries().length, 2, 'handoff must retain the outgoing fade');
  assert.equal(harness.manager.getCubismMotionQueueEntries()[0], outgoing);
  const incoming = harness.manager.getCubismMotionQueueEntries()[1];
  assert.ok(outgoing.isTriggeredFadeOut(), `${label}: outgoing fade was not scheduled`);
  // Starting a queue entry only schedules its fade. Advance real SDK frames to
  // prove both entries still contribute while incoming weight rises from zero.
  harness.advance(1 / fps);
  assert.equal(incoming.getStateWeight(), 0, `${label}: incoming motion skipped its fade-in origin`);
  harness.advance(1 / fps);
  assert.equal(harness.manager.getCubismMotionQueueEntries().length, 2, `${label}: fade entry was dropped early`);
  assert.ok(outgoing.getStateWeight() > 0 && outgoing.getStateWeight() < 1,
    `${label}: outgoing motion did not retain a partial fade weight`);
  assert.ok(incoming.getStateWeight() > 0 && incoming.getStateWeight() < 1,
    `${label}: incoming motion did not retain a partial fade weight`);
  assert.equal(released, 0, `${label}: outgoing entry was released during its visible fade`);
  harness.finish(to);
  assert.equal(released, 1, `${label}: outgoing entry was not naturally released exactly once`);
}

test('formal SDK motion seeking is deterministic in both directions, including poses and neutral tails', () => {
  function sample(name, seconds) {
    const asset = motionAssets.get(name);
    const motion = CubismMotion.create(asset.bytes.buffer, asset.bytes.byteLength, undefined, undefined, true);
    motion.setEffectIds([], []);
    motion.setFadeInTime(0); motion.setFadeOutTime(0);
    const values = new Map(motionDefaults);
    const model = {
      getParameterIndex: id => parameterIds.indexOf(id),
      getParameterValueByIndex: i => values.get(parameterIds[i]) ?? 0,
      setParameterValueByIndex(i, value, weight = 1) {
        const id = parameterIds[i]; values.set(id, (values.get(id) ?? 0) * (1 - weight) + value * weight);
      },
      isRepeat: () => false,
    };
    const manager = new CubismMotionManager();
    manager.startMotionPriority(motion, false, 3);
    manager.updateMotion(model, 0); // Prime the SDK local clock before an absolute seek.
    manager.updateMotion(model, seconds);
    manager.stopAllMotions();
    return values;
  }
  for (const name of newActions) {
    const first = sample(name, 0.5);
    for (const time of [1.5, 0.2, 2, 0.5]) {
      const values = sample(name, time);
      for (const value of values.values()) assert.ok(Number.isFinite(value));
      if (time === 0.5) assert.deepEqual(values, first, `${name}: forward/backward seek changed a pose`);
    }
    const data = JSON.parse(new TextDecoder().decode(motionAssets.get(name).bytes));
    const curve = data.Curves.find(c => c.Id === 'ParamAngleY');
    const s = curve.Segments;
    const endTime = s[7], endValue = s[8]; // First non-flat Bezier endpoint.
    assert.equal(s[2], 1);
    assert.ok(Math.abs(sample(name, endTime).get(curve.Id) - endValue) < 1e-4, `${name}: key pose`);
    const middle = sample(name, endTime / 2).get(curve.Id);
    assert.ok(middle < Math.max(s[1], endValue) && middle > Math.min(s[1], endValue), `${name}: Bezier intermediate pose`);
    const tail = sample(name, data.Meta.Duration - 0.6);
    for (const [id, value] of motionDefaults) assert.ok(Math.abs(tail.get(id) - value) < 1e-7, `${name}: seek tail ${id}`);
  }
});

for (const fps of [15, 30, 60]) {
  test(`stretch fully closes smiling eyes without upward gaze at ${fps} FPS`, () => {
    const harness = motionHarness(fps, `stretch closed eyes at ${fps} FPS`, { centeredSmile: true });
    harness.start('stretch');
    let previous = 0;
    for (const time of [0.8, 1.27, 2.05]) {
      harness.advance(time - previous);
      previous = time;
      for (const id of eyeIds) assert.ok(Math.abs(harness.value(id)) < 1e-7, `${id}: closed hold still exposes iris`);
      for (const id of ['ParamEyeBallX', 'ParamEyeBallY']) assert.equal(harness.value(id), 0, `${id}: closed smile must stay centered`);
    }
    harness.finish('stretch');
  });
  test(`shy_sway keeps bent forearms throughout the swaying body at ${fps} FPS`, () => {
    const label = `shy_sway held forearms at ${fps} FPS`;
    const harness = motionHarness(fps, label);
    harness.start('shy_sway');
    harness.advance(1 / fps);
    let frames = 0;
    const body = [];
    for (const time of [0.84, 1.34, 1.93, 2.5, 3.04, 3.58]) {
      while (frames < Math.ceil(time * fps)) { harness.advance(1 / fps); frames++; }
      for (const id of ['ParamArmL02', 'ParamArmR02']) {
        assert.ok(harness.value(id) < -9.5, `${label}: ${id} relaxed back to hanging hands at ${time}s`);
      }
      for (const id of ['ParamArmL01', 'ParamArmR01']) {
        assert.ok(harness.value(id) > -6.1 && harness.value(id) < -4.9,
          `${label}: ${id} must keep the upper arm tucked throughout both sway directions`);
      }
      body.push(harness.value('ParamBodyAngleZ'));
      assert.ok(harness.value('ParamBodyAngleX') * (body.length % 2 ? -1 : 1) > 0.45,
        `${label}: torso must visibly counterturn through each sway without releasing the arms`);
    }
    body.forEach((value, i) => assert.ok(value * (i % 2 === 0 ? 1 : -1) > 0.65,
      `three left/right sways must remain visible with folded arms: peak ${i} = ${value}`));
    harness.finish('shy_sway');
  });
  test(`new motion assets naturally finish with all 30 parameters reset at ${fps} FPS`, () => {
    for (const name of newActions) {
      const harness = motionHarness(fps, `${name} at ${fps} FPS`, { dirty: true, centeredSmile: true });
      harness.start(name);
      const highSmileFrames = harness.finish(name);
      if (name === 'cheerful_bounce') assert.ok(highSmileFrames > 0, 'must exercise the >= 0.7 smiling-eye constraint');
    }
  });
  test(`new motion self-retriggers keep the SDK crossfade and fully reset at ${fps} FPS`, () => {
    for (const name of newActions) checkMotionHandoff(name, name, fps);
  });
  test(`every new / legacy motion handoff fully resets in both directions at ${fps} FPS`, () => {
    for (const name of newActions) {
      for (const oldName of oldActions) {
        checkMotionHandoff(name, oldName, fps);
        checkMotionHandoff(oldName, name, fps);
      }
    }
  });
  test(`shy_sway entry / main / exit handoffs retain fades and reset all 30 parameters at ${fps} FPS`, () => {
    assert.equal(motionAssets.size, 10, 'the handoff matrix must include shy_sway and all 9 other actions');
    assert.equal(motionAssets.get('shy_sway').duration, 5.4, 'shy_sway must include its 1.2 s neutral tail');
    for (const other of ['nod', 'wave']) {
      for (const interruptAt of [0.35, 1.4, 3.4, 4.05]) checkMotionHandoff('shy_sway', other, fps, interruptAt);
      // The shorter legacy motions must still be playing when interrupted.
      for (const interruptAt of [0.35, 1.4, 2.1]) checkMotionHandoff(other, 'shy_sway', fps, interruptAt);
    }
  });
  test(`every distinct new motion handoff fully resets at ${fps} FPS`, () => {
    for (const from of newActions) {
      for (const to of newActions) {
        if (from !== to) checkMotionHandoff(from, to, fps);
      }
    }
  });
}
