import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { reactionHost, reactionStub } from './reaction-stub.mjs';

const uiRoot = fileURLToPath(new URL('../', import.meta.url));
const frameworkRoot = resolve(uiRoot, '../../third_party/cubism-web-sdk/Framework/src');

let nowMs = 1000;
const context = vm.createContext({
  console,
  TextDecoder,
  TextEncoder,
  setTimeout,
  clearTimeout,
  performance: { now: () => nowMs },
  atob,
  matchMedia: () => ({ matches: false }),
});
vm.runInContext(readFileSync(resolve(uiRoot, 'assets/core/live2dcubismcore.js'), 'utf8'), context);
await new Promise(setImmediate);

const modules = new Map();
function load(filename, overrides = {}) {
  filename = resolve(filename);
  if (Object.keys(overrides).length === 0 && modules.has(filename)) {
    return modules.get(filename).exports;
  }
  const module = { exports: {} };
  if (Object.keys(overrides).length === 0) modules.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    fileName: filename,
  }).outputText;
  const require = id => {
    if (overrides[id]) return overrides[id];
    if (/(^|\/)embed$/.test(id)) return { isEmbed: false, assetUrl: p => String(p), postToHost() {} };
    if (id.startsWith('@framework/')) return load(resolve(frameworkRoot, `${id.slice(11)}.ts`));
    return load(resolve(dirname(filename), `${id}.ts`));
  };
  vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename })(require, module, module.exports);
  return module.exports;
}

const { CubismFramework } = load(resolve(frameworkRoot, 'live2dcubismframework.ts'));
CubismFramework.startUp();
CubismFramework.initialize();

const { PetModel } = load(resolve(uiRoot, 'src/pet-model.ts'));
const { HitAreas } = load(resolve(uiRoot, 'src/interaction/hit-areas.ts'));
const { InteractionService } = load(resolve(uiRoot, 'src/interaction/interaction.ts'));

const assetRoot = resolve(uiRoot, 'assets/live2d/aliya');
const bytes = file => {
  const b = readFileSync(resolve(assetRoot, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

async function createRealModel() {
  const p = new PetModel();
  p._fetchArrayBuffer = async name => bytes(name);
  p.createRenderer = () => {};
  p.getRenderer = () => ({ setIsPremultipliedAlpha() {}, startUp() {}, bindTexture() {} });
  p._loadTexture = async () => null;
  const setting = bytes('16.model3.json');
  await p.loadFromSetting(setting, setting.byteLength, '', {
    gl: { drawingBufferWidth: 800, drawingBufferHeight: 800 },
    frameBuffer: null,
    shaderPath: '',
  });
  p.setReducedMotion(false);
  return p;
}

function paramOf(petModel, id) {
  const m = petModel.getModel();
  const count = m.getParameterCount();
  for (let i = 0; i < count; i++) {
    if (m.getParameterId(i).getString() === id) return m.getParameterValueByIndex(i);
  }
  throw new Error(`Parameter not found: ${id}`);
}

async function createRealInteraction({ area = 'body' } = {}) {
  const petModel = await createRealModel();
  const hitAreasDoc = JSON.parse(readFileSync(resolve(uiRoot, 'assets/interaction/aliya_hit_areas.json'), 'utf8'));
  const hitAreas = {
    areas: hitAreasDoc.areas,
    mirrored: false,
    disabled: new Set(),
    referenceRenderMargin: hitAreasDoc.referenceRenderMargin,
    hitAreaAt: () => area,
    isInHeadPetZone: () => area === 'head' || area === 'crown' || area === 'head_pet_zone',
  };
  const service = new InteractionService({
    hitAreas,
    getTarget: () => petModel,
    reactions: reactionStub({
      known: ['click.face', 'click.body', 'click.head', 'click.tie', 'click.legs', 'click.ear_left', 'click.ear_right', 'drag.fast', 'drag.slow'],
      actionFor: key => ({
        'click.tie': 'tie_tug',
        'click.face': 'flinch',
        'click.head': 'nuzzle',
        'click.legs': 'leg_pout',
        'click.ear_left': 'ear_blink',
        'click.ear_right': 'ear_blink',
      })[key],
    }),
    host: reactionHost({ playMotion: name => petModel.playAction(name) }),
    pettingHost: { isDialogueActive: () => false },
  });
  const step = (ms = 1000 / 60) => {
    nowMs += ms;
    service.tick(ms);
    petModel.update(ms / 1000);
  };
  return {
    petModel,
    service,
    hitAreas,
    setArea: a => { area = a; },
    step,
  };
}

test('互动头身偏移在物理之前应用，确实带动头发、猫耳与领带物理输出', async () => {
  const p = await createRealModel();
  try {
    p._breath.setParameters([]);
    for (let i = 0; i < 30; i++) p.update(1 / 60);
    const baseHair = paramOf(p, 'Param_Angle_Rotation_5_ArtMesh59');
    const baseBangs = paramOf(p, 'Param_Angle_Rotation_5_ArtMesh8');
    const baseTie = paramOf(p, 'Param_Angle_Rotation_2_ArtMesh42');

    // 施加互动头身偏移
    p.setInteractionOffsets(10, -4, 8, 3);
    p.setBodyTilt(3, 2.5);
    for (let i = 0; i < 12; i++) p.update(1 / 60);

    const movedHair = paramOf(p, 'Param_Angle_Rotation_5_ArtMesh59');
    const movedBangs = paramOf(p, 'Param_Angle_Rotation_5_ArtMesh8');
    const movedTie = paramOf(p, 'Param_Angle_Rotation_2_ArtMesh42');
    assert.ok(Math.abs(movedHair - baseHair) > 0.3, `马尾物理应被互动头偏移带动 (${baseHair} -> ${movedHair})`);
    assert.ok(Math.abs(movedBangs - baseBangs) > 0.2, `刘海物理应被互动头偏移带动 (${baseBangs} -> ${movedBangs})`);
    assert.ok(Math.abs(movedTie - baseTie) > 0.15, `领带物理应被互动身偏移带动 (${baseTie} -> ${movedTie})`);
  } finally {
    p.release();
  }
});

test('程序化反应与拎起驱动 BodyY/Z、四腕、猫耳、微表情，并在 wave 期间让位左臂', async () => {
  const h = await createRealInteraction();
  try {
    // 1) flinch：缩身(BodyY<0)、收双臂(ArmL01/02<0, ArmR01/02<0)、折耳(Param8/12>0)、微张嘴
    h.setArea('face');
    h.service.onClick({ normX: 0.5, normY: 0.43, pxX: 400, pxY: 344, dtSeconds: 1 / 60, leftPressed: true, isSecondary: false }, false);
    for (let i = 0; i < 10; i++) h.step(16);

    assert.ok(paramOf(h.petModel, 'ParamBodyAngleY') < -0.5, 'flinch 应产生明显缩身 BodyY');
    assert.ok(paramOf(h.petModel, 'ParamArmL01') < -1.0, 'flinch 应驱动左上臂内收');
    assert.ok(paramOf(h.petModel, 'ParamArmR02') < -1.5, 'flinch 应驱动右前臂内折');
    assert.ok(paramOf(h.petModel, 'Param8') > 0.3, 'flinch 应驱动左猫耳折叠');
    assert.ok(paramOf(h.petModel, 'Param12') > 0.3, 'flinch 应驱动右猫耳折叠');
    assert.ok(paramOf(h.petModel, 'ParamMouthOpenY') > 0.05, 'flinch 应驱动嘴微张');

    // 等反应结束恢复
    for (let i = 0; i < 65; i++) h.step(16);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamArmL01')) < 0.05);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamArmR02')) < 0.05);

    // 2) wave 期间左臂由 Param30 挥手图层独占，ArmL 互动增量被平滑让位
    h.petModel.playAction('wave');
    for (let i = 0; i < 40; i++) h.step(16);
    assert.ok(paramOf(h.petModel, 'Param30') > 0.5, 'wave 期间 Param30 应开启');
    h.service.procedural.apply({ type: 'eyes_widen', strength: 1 });
    for (let i = 0; i < 12; i++) h.step(16);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamArmL01')) < 0.5, 'wave 期间左臂互动必须让位');
    assert.ok(paramOf(h.petModel, 'ParamArmR01') > 0.8, 'wave 期间右臂仍可正常响应');
  } finally {
    h.petModel.release();
  }
});

test('猫耳通道遵守解剖侧映射与显隐开关，特殊眼型下微笑通道仍被安全清零', async () => {
  const h = await createRealInteraction();
  try {
    h.petModel._breath.setParameters([]);
    h.petModel.setEyeOverride(true, 1, 1);
    for (let i = 0; i < 10; i++) h.step(16);

    // 解剖侧映射：点击 ear_left（画面左侧）主要抖动 Param12/13/14，而非 Param8/9/10
    h.setArea('ear_left');
    h.service.onClick({ normX: 0.26, normY: 0.19, pxX: 208, pxY: 152, dtSeconds: 1 / 60, leftPressed: true, isSecondary: false }, false);
    for (let i = 0; i < 7; i++) h.step(16);
    const leftSideAmp = Math.abs(paramOf(h.petModel, 'Param12'));
    const rightSideAmp = Math.abs(paramOf(h.petModel, 'Param8'));
    assert.ok(leftSideAmp > 0.2 && leftSideAmp > rightSideAmp * 1.5,
      `点击画面左耳应主要驱动解剖右耳 Param12=${leftSideAmp} > Param8=${rightSideAmp}`);

    // 隐藏猫耳后猫耳通道和猫耳脉冲都保持静默（先让前面点击的头身反应与物理彻底回稳）
    h.petModel.setCatEarsVisible(false, true);
    for (let i = 0; i < 90; i++) h.step(16);
    const baseP8 = paramOf(h.petModel, 'Param8');
    h.petModel.setEarInteraction(true, 0.9, 0.9);
    h.petModel.triggerPartImpulse('ear_right', 1.0);
    for (let i = 0; i < 8; i++) h.step(16);
    assert.ok(Math.abs(paramOf(h.petModel, 'Param8') - baseP8) < 0.05, '隐藏猫耳时不应叠加猫耳互动');
    h.petModel.setEarInteraction(false, 0, 0);
    h.petModel.setCatEarsVisible(true, true);
    h.petModel.setEyeOverride(false, 0, 0);

    // 特殊眼型（sad）期间即便开启抚摸笑眼微表情，ParamEyeLSmile/RSmile 仍必须保持 0
    h.petModel.startExpression('sad');
    h.petModel.setFaceMicroInteraction(true, { eyeSmile: 0.95, mouthForm: 0.4 });
    for (let i = 0; i < 40; i++) h.step(16);
    assert.equal(paramOf(h.petModel, 'Param34'), 1, 'sad 特殊眼型应激活');
    assert.equal(paramOf(h.petModel, 'ParamEyeLSmile'), 0, '特殊眼型期间不得残留左笑眼');
    assert.equal(paramOf(h.petModel, 'ParamEyeRSmile'), 0, '特殊眼型期间不得残留右笑眼');
  } finally {
    h.petModel.release();
  }
});

test('局部触碰弹簧脉冲在 15/30/60fps 下均稳定收敛回 0，且尊重减少动态效果', async () => {
  const parts = [
    ['tie', 'Param_Angle_Rotation_2_ArtMesh42'],
    ['bangs', 'Param_Angle_Rotation_5_ArtMesh8'],
    ['side_hair_left', 'Param_Angle_Rotation_5_FrontHair_L'],
    ['side_hair_right', 'Param_Angle_Rotation_5_FrontHair_R'],
    ['ponytail', 'Param_Angle_Rotation_9_ArtMesh59'],
    ['hair_bounce', 'Param4'],
    ['hand_left', 'Param_Angle_B_BODY_8'],
    ['hand_right', 'Param_Angle_B_BODY_11'],
  ];

  for (const fps of [15, 30, 60]) {
    const p = await createRealModel();
    try {
      p._breath.setParameters([]);
      p._physics = null; // 隔离物理本身，纯粹验证 PartImpulseChannel 自身响应与收敛
      for (const [part, paramId] of parts) {
        p.triggerPartImpulse(part, 1.0);
        let peak = 0;
        const activeSteps = Math.round(0.4 * fps);
        for (let i = 0; i < activeSteps; i++) {
          p.update(1 / fps);
          const v = paramOf(p, paramId);
          assert.ok(Number.isFinite(v), `${fps}fps ${part} 不可出现 NaN/Infinity`);
          peak = Math.max(peak, Math.abs(v));
        }
        assert.ok(peak > 1.0, `${fps}fps ${part} 应产生明显弹性位移: peak=${peak}`);

        // 充分静置后回 0
        for (let i = 0; i < Math.round(2.0 * fps); i++) p.update(1 / fps);
        assert.equal(paramOf(p, paramId), 0, `${fps}fps ${part} 收敛后应精确回 0`);
      }

      // 减少动态效果时禁用局部弹簧脉冲
      p.setReducedMotion(true);
      p.triggerPartImpulse('hair_bounce', 1.0);
      for (let i = 0; i < 10; i++) p.update(1 / fps);
      assert.equal(paramOf(p, 'Param4'), 0, '减少动态效果时 Param4 弹簧应静默');
    } finally {
      p.release();
    }
  }
});

test('抚摸调用身体俯仰侧倾、猫耳、四腕、微笑与发丝脉冲，松手后完整恢复归零', async () => {
  const h = await createRealInteraction({ area: 'head' });
  try {
    h.petModel._breath.setParameters([]);
    const ctx = (x, y = 150, sec = true) => ({
      normX: x / 800,
      normY: y / 800,
      pxX: x,
      pxY: y,
      dtSeconds: 1 / 60,
      leftPressed: !sec,
      isSecondary: sec,
      pointerType: 'mouse',
    });

    assert.equal(h.service.onPointerDown(ctx(400)), true);
    for (let i = 1; i <= 60; i++) {
      const dx = 42 * Math.sin((i / 40) * Math.PI * 2);
      h.service.onPointerMove(ctx(400 + dx));
      h.step(1000 / 60);
    }
    assert.equal(h.service.petting.state, 'petting');
    // 持续向右侧抚摸检验头身水平 XY 幅度
    for (let i = 1; i <= 16; i++) {
      h.service.onPointerMove(ctx(370 + i * 4));
      h.step(1000 / 60);
    }
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamAngleX')) > 8, '水平抚摸应充分调动头部 AngleX');
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamBodyAngleX')) > 2.2, '水平抚摸应调动身体 BodyAngleX');
    assert.ok(paramOf(h.petModel, 'ParamBodyAngleY') < -0.5, '抚摸期间身体微沉');
    assert.ok(paramOf(h.petModel, 'Param8') > 0.25 && paramOf(h.petModel, 'Param12') > 0.25, '抚摸期间猫耳温柔放平');
    assert.ok(paramOf(h.petModel, 'ParamArmL02') < -1.0 && paramOf(h.petModel, 'ParamArmR02') < -1.0, '抚摸期间双前臂微收');
    assert.ok(paramOf(h.petModel, 'ParamEyeLSmile') > 0.5 && paramOf(h.petModel, 'ParamMouthForm') > 0.25, '抚摸期间笑眼微笑');
    assert.ok(paramOf(h.petModel, 'ParamCheek') > 0.05, '抚摸期间脸颊泛红');

    // 松手并走完 finishing + 通道平滑回中
    h.service.onPointerUp(ctx(434));
    for (let i = 0; i < 90; i++) h.step(1000 / 60);
    assert.equal(h.service.petting.state, 'inactive');
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamBodyAngleY')) < 0.01);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamArmL02')) < 0.01);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamEyeLSmile')) < 0.01);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamMouthForm')) < 0.01);
  } finally {
    h.petModel.release();
  }
});

test('极端交互参数组合（拎起+风力+挥臂、抚摸+折耳、马尾脉冲）严格低于 1.39 渲染余量', async () => {
  const p = await createRealModel();
  try {
    const bw = p.boundsW;
    const bh = p.boundsH;
    let worstRatio = 0;

    const sampleBounds = () => {
      const b = p.getDynamicBounds();
      assert.ok(b);
      const rx = Math.max(Math.abs(b.minX), Math.abs(b.maxX)) / (0.5 * bw);
      const ry = Math.max(Math.abs(b.minY), Math.abs(b.maxY)) / (0.5 * bh);
      worstRatio = Math.max(worstRatio, rx, ry);
    };

    // 场景 A：拎起 + 甩头 + 强 XY 惯性 + 物理风力 + 双臂张开
    p.setInteractionOffsets(16, 17, 6, 5.5);
    p.setBodyTilt(5.5, 2.1);
    p.setArmInteraction(true, { armL01: 4.8, armL02: -2.2, armR01: 0.8, armR02: -2.2 });
    p.setEarInteraction(true, -0.5, -0.5);
    p.setPhysicsWind(0.7, 0.35);
    p.triggerPartImpulse('hair_bounce', 1.0);
    for (let i = 0; i < 45; i++) { p.update(1 / 60); sampleBounds(); }

    // 场景 B：强 XY 抚摸 + 折耳 + 歪身 + 脸红 + 刘海/马尾脉冲
    p.setPhysicsWind(0, 0);
    p.setInteractionOffsets(16, -21, -9, 6.5);
    p.setBodyTilt(-7.5, -1.8);
    p.setArmInteraction(true, { armL01: -1.5, armL02: -2.6, armR01: -1.5, armR02: -2.6 });
    p.setEarInteraction(true, 0.65, 0.45);
    p.triggerPartImpulse('ponytail', 1.0);
    p.triggerPartImpulse('bangs', -1.0);
    p.triggerPartImpulse('side_hair_left', -1.0);
    p.triggerPartImpulse('side_hair_right', 1.0);
    for (let i = 0; i < 60; i++) { p.update(1 / 60); sampleBounds(); }

    // 场景 C：视线跟随含身体 XY 满幅 + 极端上下拖动动态叠加
    p.setInteractionOffsets(0, 20.7, 0, 0);
    p.setBodyTilt(10, 0);
    p.setArmInteraction(true, { armL01: 7.9, armL02: 0.5, armR01: 7.9, armR02: 0.5 });
    p.setEarInteraction(true, -1, -1);
    p.setPhysicsWind(0, -0.8);
    p.triggerPartImpulse('hair_bounce', 1.0);
    p.setLookTarget(1, 1);
    for (let i = 0; i < 45; i++) { p.update(1 / 60); sampleBounds(); }

    p.setInteractionOffsets(0, -5.7, 0, 0);
    p.setBodyTilt(-0.4, 0);
    p.setArmInteraction(true, { armL01: -2.3, armL02: -4.9, armR01: -2.3, armR02: -4.9 });
    p.setEarInteraction(true, 0.35, 0.35);
    p.setPhysicsWind(0, 0.8);
    p.triggerPartImpulse('hair_bounce', -1.0);
    p.setLookTarget(0, 0);
    for (let i = 0; i < 45; i++) { p.update(1 / 60); sampleBounds(); }

    const marginWithSafety = worstRatio * 1.05;
    assert.ok(marginWithSafety < 1.39, `交互极端包络×1.05=${marginWithSafety.toFixed(4)} 必须低于 1.39`);
  } finally {
    p.release();
  }
});

test('视线追随同步调动身体 XY（ParamBodyAngleX/Y），清除目标后平滑回零', async () => {
  const p = await createRealModel();
  try {
    p._breath.setParameters([]);
    for (let i = 0; i < 20; i++) p.update(1 / 60);

    p.setLookTarget(1, 0.5);
    for (let i = 0; i < 45; i++) p.update(1 / 60);
    const rightBodyX = paramOf(p, 'ParamBodyAngleX');
    assert.ok(rightBodyX > 5.0, `右看时身体 X 应跟随转动: ${rightBodyX}`);

    p.setLookTarget(0, 0.5);
    for (let i = 0; i < 60; i++) p.update(1 / 60);
    const leftBodyX = paramOf(p, 'ParamBodyAngleX');
    assert.ok(leftBodyX < -5.0, `左看时身体 X 应跟随转动: ${leftBodyX}`);

    p.setLookTarget(0.5, 1);
    for (let i = 0; i < 60; i++) p.update(1 / 60);
    const upBodyY = paramOf(p, 'ParamBodyAngleY');
    assert.ok(upBodyY > 4.5, `上看时身体 Y 应跟随仰起: ${upBodyY}`);

    p.setLookTarget(0.5, 0);
    for (let i = 0; i < 60; i++) p.update(1 / 60);
    const downBodyY = paramOf(p, 'ParamBodyAngleY');
    assert.ok(downBodyY < -4.5, `下看时身体 Y 应跟随前倾: ${downBodyY}`);

    p.clearLookTarget();
    for (let i = 0; i < 90; i++) p.update(1 / 60);
    assert.ok(Math.abs(paramOf(p, 'ParamBodyAngleX')) < 0.05, '清除注视后身体 X 应回中');
    assert.ok(Math.abs(paramOf(p, 'ParamBodyAngleY')) < 0.05, '清除注视后身体 Y 应回中');
  } finally {
    p.release();
  }
});

test('上下拖动呈现纵向弹性拉伸/回弹、模型多部位惯性联动与垂直摇晃检测', async () => {
  const { LiftPose, liftMatrix } = load(resolve(uiRoot, 'src/lift-pose.ts'));
  const ap = (m, x, y) => [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]];
  const frame = {
    scale: 400, originX: 500, originY: 600, pivotX: 500, pivotY: 300,
    angleDeg: 0, lift: 1, bounds: { minX: -0.5, maxX: 0.5, minY: -0.9, maxY: 0.9 },
    width: 1000, height: 1300,
  };

  // 1) LiftPose 纵向弹性与画布越界约束
  const lp = new LiftPose();
  lp.setHolding(true);
  for (let i = 0; i < 20; i++) { lp.setVelocity(0, -1000); lp.update(1 / 60); }
  assert.ok(lp.bounce > 0.3, `向上快速拖动应产生正向拉伸 bounce=${lp.bounce}`);
  const baseMat = liftMatrix({ ...frame, bounce: 0 });
  const stretchMat = liftMatrix({ ...frame, bounce: lp.bounce });
  assert.deepEqual(ap(stretchMat, 0, 0.75).map(v => +v.toFixed(3)), [500, 300], '纵向弹性期间抓取支点不动');
  assert.ok(ap(stretchMat, 0, -0.9)[1] > ap(baseMat, 0, -0.9)[1] + 5, '向上拖动时下半身相对支点向下拉伸');

  for (let i = 0; i < 25; i++) { lp.setVelocity(0, 1000); lp.update(1 / 60); }
  assert.ok(lp.bounce < -0.3, `向下快速拖动应产生负向压缩 bounce=${lp.bounce}`);

  for (let i = 0; i < 180; i++) lp.update(1 / 60);
  assert.ok(Math.abs(lp.bounce) < 0.05, `停手后纵向弹性应回中: ${lp.bounce}`);

  lp.setHolding(false);
  for (let i = 0; i < 120; i++) lp.update(1 / 60);
  assert.equal(lp.active, false, '松手后 LiftPose 完全复位');

  const rp = new LiftPose();
  rp.setHolding(true);
  for (let i = 0; i < 30; i++) { rp.setVelocity(0, -1500); rp.update(1 / 60, true); }
  assert.equal(rp.active, false, '少动态效果下不产生纵向弹性');

  const tightMat = liftMatrix({ ...frame, height: 990, bounce: 1 });
  for (const [x, y] of [[-0.5, -0.9], [0.5, -0.9], [-0.5, 0.9], [0.5, 0.9]]) {
    const [px, py] = ap(tightMat, x, y);
    assert.ok(px >= 2 && px <= 998 && py >= 2 && py <= 988, `窄画布纵向弹性不得出画: ${px},${py}`);
  }

  // 2) Live2D 头/身 Y、双臂、猫耳、头发纵向回弹 + 垂直摇晃检测
  const h = await createRealInteraction();
  try {
    h.petModel._breath.setParameters([]);
    h.service.dragReaction.beginDrag();
    h.service.beginHold();
    for (let i = 0; i < 20; i++) h.step(16);

    const baseHeadY = paramOf(h.petModel, 'ParamAngleY');
    const baseBodyY = paramOf(h.petModel, 'ParamBodyAngleY');
    const baseArmL = paramOf(h.petModel, 'ParamArmL01');

    // 向下快拖：头身上抬滞后、双臂上扬、发丝正向弹性
    for (let i = 0; i < 16; i++) {
      h.service.updateHoldVelocity(0, 450);
      h.step(16);
    }
    const downDragHeadY = paramOf(h.petModel, 'ParamAngleY');
    const downDragBodyY = paramOf(h.petModel, 'ParamBodyAngleY');
    const downDragArmL = paramOf(h.petModel, 'ParamArmL01');
    assert.ok(downDragHeadY > baseHeadY + 6, `向下拖头应大幅仰起滞后: ${baseHeadY} -> ${downDragHeadY}`);
    assert.ok(downDragBodyY > baseBodyY + 2.5, `向下拖身 Y 应大幅上抬: ${baseBodyY} -> ${downDragBodyY}`);
    assert.ok(downDragArmL > baseArmL + 2.0, `向下拖手臂应上抬滞后: ${baseArmL} -> ${downDragArmL}`);
    assert.ok(Math.abs(paramOf(h.petModel, 'Param4')) > 0.5, '垂直拖动突变应触发发丝 Param4 回弹');

    // 反向向上快拖：头身下沉、双臂下收、发丝反向回弹
    for (let i = 0; i < 20; i++) {
      h.service.updateHoldVelocity(0, -450);
      h.step(16);
    }
    assert.ok(paramOf(h.petModel, 'ParamAngleY') < baseHeadY - 6, '向上拖头应下沉');
    assert.ok(paramOf(h.petModel, 'ParamBodyAngleY') < baseBodyY - 2.5, '向上拖身 Y 应下沉');
    assert.ok(paramOf(h.petModel, 'ParamArmL01') < baseArmL - 2.0, '向上拖手臂应随势下摆');

    // 垂直快速往返摇晃触发摇晃检测
    let triggered = false;
    for (const vy of [500, 500, -500, -500, 500, 500, -500, -500, 500, 500]) {
      nowMs += 40;
      if (h.service.dragReaction.onDragMotion(0, vy, 0.04).shakeTriggered) triggered = true;
    }
    assert.equal(triggered, true, '上下快速往返拖动应触发摇晃反应');

    // 松手落地并完整归零
    h.service.dragReaction.onDragMove(100);
    h.service.onClick({ normX: 0.5, normY: 0.5, pxX: 400, pxY: 400, dtSeconds: 1 / 60, leftPressed: false, isSecondary: false }, true);
    for (let i = 0; i < 120; i++) h.step(16);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamBodyAngleY')) < 0.02);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamArmL01')) < 0.02);
    assert.ok(Math.abs(paramOf(h.petModel, 'Param4')) < 0.02);
  } finally {
    h.petModel.release();
  }
});

test('拖拽期间猫耳 3 段耦合弹簧物理：左右同向滞后、无 S 形反折、耳尖鞭梢滞后与急停回弹（15/30/60fps）', async () => {
  const { EarDragPhysics } = load(resolve(uiRoot, 'src/overlay.ts'));
  for (const fps of [15, 30, 60]) {
    const p = await createRealModel();
    try {
      p._breath.setParameters([]);
      p.setEyeOverride(true, 1, 1);
      const dragPhys = new EarDragPhysics({
        leftRot: CubismFramework.getIdManager().getId('Param8'),
        leftMid: CubismFramework.getIdManager().getId('Param9'),
        leftTip: CubismFramework.getIdManager().getId('Param10'),
        rightRot: CubismFramework.getIdManager().getId('Param12'),
        rightMid: CubismFramework.getIdManager().getId('Param13'),
        rightTip: CubismFramework.getIdManager().getId('Param14'),
      });
      const m = p.getModel();
      const dt = 1 / fps;
      let basePeakAt = -1;
      let tipPeakAt = -1;
      let maxBase = 0;
      let maxTip = 0;
      let minOvershoot = 0;
      const totalStartFrames = Math.round(0.45 * fps);
      dragPhys.setWind(0.65, 0);
      for (let i = 0; i < totalStartFrames; i++) {
        p.update(dt);
        dragPhys.apply(m, dt);
        const b = paramOf(p, 'Param12');
        const tip = paramOf(p, 'Param14');
        assert.ok(Number.isFinite(b) && Number.isFinite(tip));
        assert.ok(Math.abs(b) < 1 && Math.abs(tip) < 1, `${fps}fps 软限幅不得硬顶 ±1`);
        if (b > maxBase) { maxBase = b; basePeakAt = i / fps; }
        if (tip > maxTip) { maxTip = tip; tipPeakAt = i / fps; }
      }
      assert.ok(tipPeakAt > basePeakAt, `${fps}fps 耳尖峰值(${tipPeakAt}s)应滞后于耳根(${basePeakAt}s)`);

      // 急停应产生反向回弹过冲，随后在 1.6s 内收敛
      dragPhys.setWind(0, 0);
      for (let i = 0; i < Math.round(1.6 * fps); i++) {
        p.update(dt);
        dragPhys.apply(m, dt);
        minOvershoot = Math.min(minOvershoot, paramOf(p, 'Param12'));
      }
      assert.ok(minOvershoot < -0.05, `${fps}fps 急停应产生明显回弹过冲: ${minOvershoot}`);
      assert.ok(Math.abs(paramOf(p, 'Param12') - paramOf(p, 'Param8')) < 0.05, `${fps}fps 停止后应收敛对称`);
    } finally {
      p.release();
    }
  }

  const h = await createRealInteraction();
  try {
    h.petModel._breath.setParameters([]);
    h.petModel.setEyeOverride(true, 1, 1);

    const m = h.petModel.getModel();
    const idOf = name => {
      for (let i = 0; i < m.getParameterCount(); i++) {
        if (m.getParameterId(i).getString() === name) return i;
      }
      return -1;
    };
    let tipLeft = null;
    let tipRight = null;
    m.loadParameters();
    m.update();
    for (let i = 0; i < m.getDrawableCount(); i++) {
      if (!h.petModel.isEarDrawable(i) || m.getDrawableOpacity(i) < 0.5) continue;
      const v = m.getDrawableVertices(i);
      for (let j = 0; j < v.length; j += 2) {
        if (v[j] < 0 && (!tipLeft || v[j + 1] > tipLeft.y)) tipLeft = { i, vi: j };
        if (v[j] > 0 && (!tipRight || v[j + 1] > tipRight.y)) tipRight = { i, vi: j };
      }
    }
    const earTipDelta = () => {
      m.update();
      const vL1 = m.getDrawableVertices(tipLeft.i);
      const vR1 = m.getDrawableVertices(tipRight.i);
      const l1 = [vL1[tipLeft.vi], vL1[tipLeft.vi + 1]];
      const r1 = [vR1[tipRight.vi], vR1[tipRight.vi + 1]];
      const earKeys = ['Param7', 'Param8', 'Param9', 'Param10', 'Param11', 'Param12', 'Param13', 'Param14'];
      const saved = earKeys.map(k => [idOf(k), m.getParameterValueByIndex(idOf(k))]);
      for (const [idx] of saved) m.setParameterValueByIndex(idx, 0);
      m.update();
      const vL0 = m.getDrawableVertices(tipLeft.i);
      const vR0 = m.getDrawableVertices(tipRight.i);
      const d = {
        leftDx: l1[0] - vL0[tipLeft.vi],
        leftDy: l1[1] - vL0[tipLeft.vi + 1],
        rightDx: r1[0] - vR0[tipRight.vi],
        rightDy: r1[1] - vR0[tipRight.vi + 1],
      };
      for (const [idx, val] of saved) m.setParameterValueByIndex(idx, val);
      m.update();
      return d;
    };

    // 1) 右拖完整拖动：双耳 6 段参数均无 S 形反折，且双耳尖均朝左（dX < 0）
    h.service.dragReaction.beginDrag();
    h.service.beginHold();
    for (let i = 0; i < 15; i++) h.step(1000 / 60);

    h.petModel.setPhysicsWind(0.65, 0);
    for (let i = 0; i < 24; i++) {
      h.service.updateHoldVelocity(720, 0);
      h.step(1000 / 60);
    }
    const rightDrag = earTipDelta();
    for (const k of ['Param8', 'Param9', 'Param10']) {
      assert.ok(paramOf(h.petModel, k) < -0.35, `右拖画面右耳 ${k} 应朝左偏: ${paramOf(h.petModel, k)}`);
    }
    for (const k of ['Param12', 'Param13', 'Param14']) {
      assert.ok(paramOf(h.petModel, k) > 0.35, `右拖画面左耳 ${k} 应全段同向朝左偏: ${paramOf(h.petModel, k)}`);
    }
    assert.ok(rightDrag.leftDx < -0.04 && rightDrag.rightDx < -0.04,
      `右拖时双耳尖均应大幅向左滞后: ${JSON.stringify(rightDrag)}`);

    // 2) 左拖完整拖动：双耳 6 段参数均朝右偏，双耳尖 dX > 0
    h.petModel.setPhysicsWind(-0.65, 0);
    for (let i = 0; i < 30; i++) {
      h.service.updateHoldVelocity(-720, 0);
      h.step(1000 / 60);
    }
    const leftDrag = earTipDelta();
    for (const k of ['Param8', 'Param9', 'Param10']) {
      assert.ok(paramOf(h.petModel, k) > 0.35, `左拖画面右耳 ${k} 应朝右偏: ${paramOf(h.petModel, k)}`);
    }
    for (const k of ['Param12', 'Param13', 'Param14']) {
      assert.ok(paramOf(h.petModel, k) < -0.35, `左拖画面左耳 ${k} 应全段同向朝右偏: ${paramOf(h.petModel, k)}`);
    }
    assert.ok(leftDrag.leftDx > 0.04 && leftDrag.rightDx > 0.04,
      `左拖时双耳尖均应大幅向右滞后: ${JSON.stringify(leftDrag)}`);

    // 3) 垂直风力：向上拖（windY > 0）压低耳尖，向下拖（windY < 0）抬高耳尖
    h.service.onClick({ normX: 0.5, normY: 0.5, pxX: 400, pxY: 400, dtSeconds: 1 / 60, leftPressed: false, isSecondary: false }, true);
    h.petModel.setPhysicsWind(0, 0.8);
    for (let i = 0; i < 24; i++) h.step(1000 / 60);
    const upDrag = earTipDelta();
    assert.ok(upDrag.leftDy < -0.02 && upDrag.rightDy < -0.02,
      `向上拖动风力应压低双耳尖: ${JSON.stringify(upDrag)}`);

    h.petModel.setPhysicsWind(0, -0.8);
    for (let i = 0; i < 24; i++) h.step(1000 / 60);
    const downDrag = earTipDelta();
    assert.ok(downDrag.leftDy > 0.01 && downDrag.rightDy > 0.01,
      `向下拖动风力应托起双耳尖: ${JSON.stringify(downDrag)}`);

    // 4) 清零风力后收敛，隐藏猫耳与 reducedMotion 下不写入弹簧输出
    h.petModel.setPhysicsWind(0, 0);
    for (let i = 0; i < 90; i++) h.step(1000 / 60);
    assert.ok(Math.abs(paramOf(h.petModel, 'Param12') - paramOf(h.petModel, 'Param8')) < 0.05);

    h.petModel.setCatEarsVisible(false, true);
    h.petModel.setPhysicsWind(0.65, 0);
    for (let i = 0; i < 30; i++) h.step(1000 / 60);
    assert.ok(paramOf(h.petModel, 'Param12') < 0, '隐藏猫耳时应跳过拖拽弹簧接管');

    h.petModel.setCatEarsVisible(true, true);
    h.petModel.setReducedMotion(true);
    for (let i = 0; i < 30; i++) h.step(1000 / 60);
    assert.ok(paramOf(h.petModel, 'Param12') < 0, '减少动态效果时应跳过拖拽弹簧接管');
  } finally {
    h.petModel.release();
  }
});

test('上下抚摸头部可识别为抚摸，头部与身体随上下滑动明显俯仰，松手后平滑回零', async () => {
  const h = await createRealInteraction({ area: 'head' });
  try {
    h.petModel._breath.setParameters([]);
    const ctx = (y, x = 400, sec = true) => ({
      normX: x / 800,
      normY: y / 800,
      pxX: x,
      pxY: y,
      dtSeconds: 1 / 60,
      leftPressed: !sec,
      isSecondary: sec,
      pointerType: 'mouse',
    });

    // 1) 单向垂直下滑不触发抚摸
    assert.equal(h.service.onPointerDown(ctx(140)), true);
    for (let i = 1; i <= 15; i++) {
      h.service.onPointerMove(ctx(140 + i * 3));
      h.step(1000 / 60);
    }
    assert.equal(h.service.petting.state, 'pressed', '单向垂直移动不应触发 petting');
    h.service.onPointerUp(ctx(185));
    assert.equal(h.service.petting.state, 'inactive');

    // 2) 上下往返抚摸进入 petting，且头随上下滑动俯仰
    assert.equal(h.service.onPointerDown(ctx(150)), true);
    for (let i = 1; i <= 45; i++) {
      const dy = 36 * Math.sin((i / 30) * Math.PI * 2);
      h.service.onPointerMove(ctx(150 + dy));
      h.step(1000 / 60);
    }
    assert.equal(h.service.petting.state, 'petting', '上下往返应识别为抚摸');

    // 持续向下抚摸：大幅低头、身体明显下沉
    for (let i = 1; i <= 16; i++) {
      h.service.onPointerMove(ctx(130 + i * 3.5));
      h.step(1000 / 60);
    }
    const downAngleY = paramOf(h.petModel, 'ParamAngleY');
    const downBodyY = paramOf(h.petModel, 'ParamBodyAngleY');
    assert.ok(downAngleY < -10, `向下抚摸应明显低头: AngleY=${downAngleY}`);
    assert.ok(downBodyY < -2.5, `向下抚摸应适度沉身: BodyY=${downBodyY}`);

    // 反向持续向上抚摸：大幅抬头、身体抬起
    for (let i = 1; i <= 18; i++) {
      h.service.onPointerMove(ctx(186 - i * 3.5));
      h.step(1000 / 60);
    }
    const upAngleY = paramOf(h.petModel, 'ParamAngleY');
    const upBodyY = paramOf(h.petModel, 'ParamBodyAngleY');
    assert.ok(upAngleY > 8 && upAngleY > downAngleY + 18,
      `向上抚摸应明显抬头: upAngleY=${upAngleY}, downAngleY=${downAngleY}`);
    assert.ok(upBodyY > 0.3 && upBodyY > downBodyY + 3.0,
      `向上抚摸身体应抬起: upBodyY=${upBodyY}, downBodyY=${downBodyY}`);

    // 松手平滑归零
    h.service.onPointerUp(ctx(123));
    for (let i = 0; i < 90; i++) h.step(1000 / 60);
    assert.equal(h.service.petting.state, 'inactive');
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamAngleY')) < 0.01);
    assert.ok(Math.abs(paramOf(h.petModel, 'ParamBodyAngleY')) < 0.01);
  } finally {
    h.petModel.release();
  }
});
