import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const EMBED = { isEmbed: false, assetUrl: p => '/' + String(p).replace(/^\/+/, ''), postToHost() {} };
const root = new URL('../', import.meta.url);
const uiRoot = fileURLToPath(root);
const frameworkRoot = resolve(uiRoot, '../../third_party/cubism-web-sdk/Framework/src');

function load(name, imports = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`src/${name}.ts`, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: id => imports[id] ?? (['./embed', '../embed'].includes(id) ? EMBED : {}),
    console,
    setTimeout,
    clearTimeout,
    performance,
    ...globals,
  }, { filename: `${name}.ts` });
  return exports;
}

async function createHarness({ mirrored = false } = {}) {
  let now = 1000;
  const globals = { performance: { now: () => now } };
  const areasDoc = JSON.parse(readFileSync(new URL('assets/interaction/aliya_hit_areas.json', root), 'utf8'));
  const { HitAreas } = load('interaction/hit-areas', {}, {
    ...globals,
    fetch: async () => ({ ok: true, json: async () => areasDoc }),
  });
  const hitAreas = new HitAreas();
  await hitAreas.load();
  hitAreas.mirrored = mirrored;

  const recognizer = load('interaction/petting-recognizer', {}, globals);
  const { PettingController } = load('interaction/petting-controller', {
    './petting-recognizer': recognizer,
  }, globals);

  const offsets = [0, 0, 0, 0];
  const bodyTilt = [0, 0];
  let reduced = false;
  const target = {
    getInteractionParamInfo: () => ({
      angleXMin: -30, angleXMax: 30,
      angleYMin: -30, angleYMax: 30,
      angleZMin: -30, angleZMax: 30,
      bodyXMin: -10, bodyXMax: 10,
      bodyYMin: -10, bodyYMax: 10,
      eyeLMin: 0, eyeLMax: 1,
      eyeRMin: 0, eyeRMax: 1,
      hasEyes: true,
    }),
    setInteractionOffsets(ax, ay, az, bx) {
      offsets[0] = ax;
      offsets[1] = ay;
      offsets[2] = az;
      offsets[3] = bx;
    },
    setBodyTilt(by, bz) {
      bodyTilt[0] = by;
      bodyTilt[1] = bz;
    },
    setEyeOverride() {},
    setEarInteraction() {},
    setFaceCheek() {},
    setPettingLookAtReduction(v) {
      reduced = v;
    },
  };

  const c = new PettingController({
    hitAreas,
    getTarget: () => target,
    host: { isDialogueActive: () => false },
    react: () => null,
  });

  const head = hitAreas.areas.find(a => a.id === 'head');
  const hw = head.width / 2;
  const hh = head.height / 2;

  const ctx = (mx, my) => {
    const nx = mirrored ? 1 - mx : mx;
    return {
      normX: nx,
      normY: my,
      pxX: nx * 800,
      pxY: my * 800,
      dtSeconds: 1 / 60,
      leftPressed: false,
      isSecondary: true,
      pointerType: 'mouse',
    };
  };

  const frame = () => {
    now += 1000 / 60;
    c.tick(1000 / 60);
  };

  let curMx = head.x;
  let curMy = head.y;

  const press = (mx, my) => {
    curMx = mx;
    curMy = my;
    return c.onPointerDown(ctx(mx, my));
  };

  const moveTo = (mx, my, n = 12) => {
    const startX = curMx;
    const startY = curMy;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      curMx = startX + (mx - startX) * t;
      curMy = startY + (my - startY) * t;
      c.onPointerMove(ctx(curMx, curMy));
      frame();
    }
  };

  const hold = (n) => {
    for (let i = 0; i < n; i++) frame();
  };

  return {
    c, hitAreas, head, hw, hh, offsets, bodyTilt,
    isReduced: () => reduced,
    ctx, frame, press, moveTo, hold,
  };
}

test('右键在头部左右边缘起手及移动偏头朝向指针所在侧，回中心平滑回正（含镜像）', async () => {
  for (const mirrored of [false, true]) {
    const h = await createHarness({ mirrored });
    const { hitAreas, head, hw, offsets, bodyTilt, press, moveTo, hold } = h;

    // 保留触屏耳区边界，同时桌面右键允许完整头部/耳区直接起手、身体不起手
    assert.equal(hitAreas.isInHeadPetZone(0.26, 0.19), false);
    assert.equal(hitAreas.isInHeadRegion(0.26, 0.19), true);
    assert.equal(press(0.5, 0.7), false, `mirrored=${mirrored}: 右键点身体不进入摸头`);

    // 直接在模型右侧边缘右键按下并保持，无需大幅滑动即向右侧偏倾
    assert.equal(press(head.x + 0.88 * hw, head.y), true, `mirrored=${mirrored}: 右边缘应可直接起手`);
    hold(45);
    assert.ok(offsets[0] > 10, `mirrored=${mirrored}: 右边缘 AngleX=${offsets[0]} 应 > 10`);
    assert.ok(offsets[2] > 6, `mirrored=${mirrored}: 右边缘 AngleZ=${offsets[2]} 应 > 6`);
    assert.ok(Math.abs(offsets[2]) <= 12 + 1e-9, `mirrored=${mirrored}: |AngleZ|=${Math.abs(offsets[2])} 应 <= 12`);
    assert.ok(offsets[3] > 2.5, `mirrored=${mirrored}: 右边缘 BodyX=${offsets[3]} 应 > 2.5`);
    assert.ok(bodyTilt[1] > 1.5, `mirrored=${mirrored}: 右边缘 BodyZ=${bodyTilt[1]} 应 > 1.5`);
    assert.equal(h.isReduced(), true, `mirrored=${mirrored}: 边缘偏头期间应降低 LookAt 权重`);

    // 切到模型左侧边缘
    moveTo(head.x - 0.88 * hw, head.y, 24);
    hold(45);
    assert.ok(offsets[0] < -10, `mirrored=${mirrored}: 左边缘 AngleX=${offsets[0]} 应 < -10`);
    assert.ok(offsets[2] < -6, `mirrored=${mirrored}: 左边缘 AngleZ=${offsets[2]} 应 < -6`);
    assert.ok(Math.abs(offsets[2]) <= 12 + 1e-9, `mirrored=${mirrored}: |AngleZ|=${Math.abs(offsets[2])} 应 <= 12`);
    assert.ok(offsets[3] < -2.5, `mirrored=${mirrored}: 左边缘 BodyX=${offsets[3]} 应 < -2.5`);
    assert.ok(bodyTilt[1] < -1.5, `mirrored=${mirrored}: 左边缘 BodyZ=${bodyTilt[1]} 应 < -1.5`);

    // 回到中心后平滑回正
    moveTo(head.x, head.y);
    hold(60);
    assert.ok(Math.abs(offsets[0]) < 1.5, `mirrored=${mirrored}: 回中心 AngleX=${offsets[0]} 应接近 0`);
    assert.ok(Math.abs(offsets[2]) < 1.5, `mirrored=${mirrored}: 回中心 AngleZ=${offsets[2]} 应接近 0`);
    assert.ok(Math.abs(bodyTilt[1]) < 0.5, `mirrored=${mirrored}: 回中心 BodyZ=${bodyTilt[1]} 应接近 0`);
  }
});

test('右键在头部上下边缘时抬头/低头贴手（含镜像）', async () => {
  for (const mirrored of [false, true]) {
    const h = await createHarness({ mirrored });
    const { head, hh, offsets, press, moveTo, hold } = h;

    assert.equal(press(head.x, head.y), true);

    moveTo(head.x, head.y - 0.9 * hh);
    hold(45);
    assert.ok(offsets[1] > 5, `mirrored=${mirrored}: 上边缘 AngleY=${offsets[1]} 应 > 5`);

    moveTo(head.x, head.y + 0.9 * hh);
    hold(45);
    assert.ok(offsets[1] < -5, `mirrored=${mirrored}: 下边缘 AngleY=${offsets[1]} 应 < -5`);
  }
});

test('边缘往返抚摸保持偏向该侧且不超过 AngleZ 上限，中心往返不偏且松手归零（含镜像）', async () => {
  for (const mirrored of [false, true]) {
    // 1) 边缘往返
    const hEdge = await createHarness({ mirrored });
    const { c, head, hw, offsets, bodyTilt, ctx, frame, press, hold } = hEdge;
    const base = head.x + 0.85 * hw;
    assert.equal(press(base, head.y), true);

    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    let maxAbsZ = 0;
    let lastMx = base;
    for (let i = 1; i <= 90; i++) {
      lastMx = base + (25 / 800) * Math.sin((2 * Math.PI * i) / 30);
      c.onPointerMove(ctx(lastMx, head.y));
      frame();
      if (i >= 30) {
        sumX += offsets[0];
        sumZ += offsets[2];
        count++;
        maxAbsZ = Math.max(maxAbsZ, Math.abs(offsets[2]));
      }
    }
    const meanEdgeX = sumX / count;
    const meanEdgeZ = sumZ / count;
    assert.equal(c.state, 'petting', `mirrored=${mirrored}: 往返划动应进入 petting`);
    assert.ok(meanEdgeX > 10, `mirrored=${mirrored}: 边缘往返 AngleX 均值=${meanEdgeX} 应 > 10`);
    assert.ok(meanEdgeZ > 6, `mirrored=${mirrored}: 边缘往返 AngleZ 均值=${meanEdgeZ} 应 > 6`);
    assert.ok(maxAbsZ <= 12 + 1e-9, `mirrored=${mirrored}: 边缘往返 max|AngleZ|=${maxAbsZ} 应 <= 12`);
    assert.ok(bodyTilt[1] > 1.5, `mirrored=${mirrored}: 边缘往返 BodyZ=${bodyTilt[1]} 应 > 1.5`);

    c.onPointerUp(ctx(lastMx, head.y));
    assert.equal(c.state, 'finishing');
    hold(40);
    assert.equal(c.state, 'inactive');
    assert.deepEqual(offsets, [0, 0, 0, 0]);
    assert.deepEqual(bodyTilt, [0, 0]);

    // 2) 中心往返
    const hCenter = await createHarness({ mirrored });
    assert.equal(hCenter.press(head.x, head.y), true);
    let sumCenterX = 0;
    let countCenter = 0;
    for (let i = 1; i <= 90; i++) {
      const mx = head.x + (25 / 800) * Math.sin((2 * Math.PI * i) / 30);
      hCenter.c.onPointerMove(hCenter.ctx(mx, head.y));
      hCenter.frame();
      if (i >= 30) {
        sumCenterX += hCenter.offsets[0];
        countCenter++;
      }
    }
    const meanCenterX = sumCenterX / countCenter;
    assert.equal(hCenter.c.state, 'petting');
    assert.ok(Math.abs(meanCenterX) < 2.5, `mirrored=${mirrored}: 中心往返 AngleX 均值=${meanCenterX} 应接近 0`);
  }
});

async function createRealPettingHarness() {
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
  function loadReal(filename) {
    filename = resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
      fileName: filename,
    }).outputText;
    const require = id => {
      if (/(^|\/)embed$/.test(id)) return EMBED;
      if (id.startsWith('@framework/')) return loadReal(resolve(frameworkRoot, `${id.slice(11)}.ts`));
      return loadReal(resolve(dirname(filename), `${id}.ts`));
    };
    vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename })(require, module, module.exports);
    return module.exports;
  }

  const { CubismFramework } = loadReal(resolve(frameworkRoot, 'live2dcubismframework.ts'));
  CubismFramework.startUp();
  CubismFramework.initialize();

  const { PetModel } = loadReal(resolve(uiRoot, 'src/pet-model.ts'));
  const { HitAreas } = loadReal(resolve(uiRoot, 'src/interaction/hit-areas.ts'));
  const { PettingController } = loadReal(resolve(uiRoot, 'src/interaction/petting-controller.ts'));

  const assetRoot = resolve(uiRoot, 'assets/live2d/aliya');
  const bytes = file => {
    const b = readFileSync(resolve(assetRoot, file));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };

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
  p._breath.setParameters([]);

  const areasDoc = JSON.parse(readFileSync(resolve(uiRoot, 'assets/interaction/aliya_hit_areas.json'), 'utf8'));
  const hitAreas = new HitAreas();
  const origFetch = context.fetch;
  context.fetch = async () => ({ ok: true, json: async () => areasDoc });
  await hitAreas.load();
  context.fetch = origFetch;

  const controller = new PettingController({
    hitAreas,
    getTarget: () => p,
    host: { isDialogueActive: () => false },
    react: () => null,
  });

  const head = hitAreas.areas.find(a => a.id === 'head');
  const m = p.getModel();
  const idMgr = CubismFramework.getIdManager();

  return {
    p, m, idMgr, hitAreas, head, hw: head.width / 2, controller,
    advanceNow: (ms = 1000 / 60) => { nowMs += ms; },
  };
}

test('真实 Live2D 模型几何验证：左右边缘抚摸使双眼中点与头部倾角朝手侧偏移且低于 1.39 渲染余量', async () => {
  const { p, m, idMgr, head, hw, controller, advanceNow } = await createRealPettingHarness();
  try {
    const eyeLId = idMgr.getId('ArtMesh112');
    const eyeRId = idMgr.getId('ArtMesh4');

    const eyePose = () => {
      const center = id => {
        const v = m.getDrawableVertices(m.getDrawableIndex(id));
        let sx = 0;
        let sy = 0;
        const n = v.length / 2;
        for (let j = 0; j < v.length; j += 2) {
          sx += v[j];
          sy += v[j + 1];
        }
        return { x: sx / n, y: sy / n };
      };
      const eL = center(eyeLId);
      const eR = center(eyeRId);
      return {
        midX: (eL.x + eR.x) / 2,
        tiltDeg: (Math.atan2(eL.y - eR.y, eL.x - eR.x) * 180) / Math.PI,
      };
    };

    const ctx = (nx, ny) => ({
      normX: nx,
      normY: ny,
      pxX: nx * 800,
      pxY: ny * 800,
      dtSeconds: 1 / 60,
      leftPressed: false,
      isSecondary: true,
      pointerType: 'mouse',
    });

    let worstRatio = 0;
    const step = (ms = 1000 / 60) => {
      advanceNow(ms);
      controller.tick(ms);
      p.update(ms / 1000);
      const b = p.getDynamicBounds();
      assert.ok(b);
      worstRatio = Math.max(
        worstRatio,
        Math.max(Math.abs(b.minX), Math.abs(b.maxX)) / (0.5 * p.boundsW),
        Math.max(Math.abs(b.minY), Math.abs(b.maxY)) / (0.5 * p.boundsH)
      );
    };

    p.update(1 / 60);
    const openBase = eyePose();

    // 1) 右边缘按下保持（睁眼态）：头与双眼中点立即向右侧偏移、右倾
    const rightX = head.x + 0.88 * hw;
    assert.equal(controller.onPointerDown(ctx(rightX, head.y)), true);
    for (let i = 0; i < 45; i++) step();
    const pressedRight = eyePose();
    assert.ok(pressedRight.midX - openBase.midX > 0.02,
      `pressed 右边缘双眼中点右移=${pressedRight.midX - openBase.midX} 应 > 0.02`);
    assert.ok(pressedRight.tiltDeg - openBase.tiltDeg < -6,
      `pressed 右边缘头部右倾=${pressedRight.tiltDeg - openBase.tiltDeg} 应 < -6`);
    controller.onPointerUp(ctx(rightX, head.y));
    for (let i = 0; i < 45; i++) step();

    // 2) 中心进入 petting（闭眼微笑基准）
    assert.equal(controller.onPointerDown(ctx(head.x, head.y)), true);
    for (let i = 1; i <= 60; i++) {
      const mx = head.x + (25 / 800) * Math.sin((2 * Math.PI * i) / 30);
      controller.onPointerMove(ctx(mx, head.y));
      step();
    }
    for (let i = 0; i < 30; i++) step();
    assert.equal(controller.state, 'petting');
    const petCenter = eyePose();

    // 3) 移至右边缘往返抚摸（相对同闭眼基准比较真实头部偏倾）
    for (let i = 1; i <= 15; i++) {
      controller.onPointerMove(ctx(head.x + 0.88 * hw * (i / 15), head.y));
      step();
    }
    for (let i = 1; i <= 45; i++) {
      const mx = rightX + (25 / 800) * Math.sin((2 * Math.PI * i) / 30);
      controller.onPointerMove(ctx(mx, head.y));
      step();
    }
    const rightPose = eyePose();
    const rightShift = rightPose.midX - petCenter.midX;
    const rightTilt = rightPose.tiltDeg - petCenter.tiltDeg;
    assert.ok(rightShift > 0.02, `右边缘双眼中点右移 dEyeMidX=${rightShift} 应 > 0.02`);
    assert.ok(rightTilt < -6, `右边缘头部右倾 dTiltDeg=${rightTilt} 应 < -6`);

    // 4) 移至左边缘往返抚摸
    const leftX = head.x - 0.88 * hw;
    for (let i = 1; i <= 20; i++) {
      const t = i / 20;
      controller.onPointerMove(ctx(rightX + (leftX - rightX) * t, head.y));
      step();
    }
    for (let i = 1; i <= 45; i++) {
      const mx = leftX + (25 / 800) * Math.sin((2 * Math.PI * i) / 30);
      controller.onPointerMove(ctx(mx, head.y));
      step();
    }
    const leftPose = eyePose();
    const leftShift = leftPose.midX - petCenter.midX;
    const leftTilt = leftPose.tiltDeg - petCenter.tiltDeg;
    assert.ok(leftShift < -0.02, `左边缘双眼中点左移 dEyeMidX=${leftShift} 应 < -0.02`);
    assert.ok(leftTilt > 4, `左边缘头部左倾 dTiltDeg=${leftTilt} 应 > 4`);

    controller.onPointerUp(ctx(leftX, head.y));
    for (let i = 0; i < 60; i++) step();
    assert.equal(controller.state, 'inactive');

    assert.ok(worstRatio * 1.05 < 1.39, `动态包络×1.05=${(worstRatio * 1.05).toFixed(4)} 应 < 1.39`);
  } finally {
    p.release();
  }
});

test('GazeController 平滑过渡 reduction，进入/退出抚摸不发生单帧跳变', () => {
  const { GazeController } = load('gaze');
  let bodyY = 0;
  const values = new Map();
  const model = {
    getParameterValueById: id => values.get(id) ?? 0,
    setParameterValueById: (id, v) => values.set(id, v),
    addParameterValueById: (id, v) => values.set(id, (values.get(id) ?? 0) + v),
  };
  const look = { updateParameters(_m, _hx, hy) { bodyY = hy * 7; } };
  const gaze = new GazeController(look, 'eyeX', 'eyeY');
  gaze.setTarget(0.5, 1);

  for (let i = 0; i < 90; i++) {
    gaze.update(model, 1 / 60, { motionActive: false, reduction: 1 });
  }
  assert.ok(bodyY > 6.5, `稳态悬停 BodyY=${bodyY} 应接近 7`);

  let prev = bodyY;
  for (let i = 0; i < 90; i++) {
    gaze.update(model, 1 / 60, { motionActive: false, reduction: 0.25 });
    const delta = Math.abs(bodyY - prev);
    assert.ok(delta < 0.5, `降权第 ${i} 帧 BodyY 跳变=${delta} 应 < 0.5`);
    prev = bodyY;
  }
  assert.ok(Math.abs(bodyY - 1.75) < 0.15, `降权稳态 BodyY=${bodyY} 应收敛到 1.75 附近`);

  for (let i = 0; i < 90; i++) {
    gaze.update(model, 1 / 60, { motionActive: false, reduction: 1 });
    const delta = Math.abs(bodyY - prev);
    assert.ok(delta < 0.5, `恢复第 ${i} 帧 BodyY 跳变=${delta} 应 < 0.5`);
    prev = bodyY;
  }
  assert.ok(Math.abs(bodyY - 7.0) < 0.3, `恢复稳态 BodyY=${bodyY} 应回到 7.0 附近`);
});

test('真实 Live2D 模型悬停头顶后按住并水平抚摸，全程无单帧突然下沉', async () => {
  const { p, m, controller, advanceNow } = await createRealPettingHarness();
  try {
    const scalePx = 800 / (1.39 * p.boundsH);
    const avgY = () => {
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < m.getDrawableCount(); i++) {
        if (m.getDrawableOpacity(i) < 0.5) continue;
        const v = m.getDrawableVertices(i);
        for (let j = 1; j < v.length; j += 2) {
          sum += v[j];
          cnt++;
        }
      }
      return sum / cnt;
    };

    const ctx = (nx, ny) => ({
      normX: nx,
      normY: ny,
      pxX: nx * 800,
      pxY: ny * 800,
      dtSeconds: 1 / 60,
      leftPressed: false,
      isSecondary: true,
      pointerType: 'mouse',
    });

    p.setLookTarget(0.72, 0.82);
    for (let i = 0; i < 60; i++) {
      advanceNow(1000 / 60);
      controller.tick(1000 / 60);
      p.update(1 / 60);
    }

    let prevPx = avgY() * scalePx;
    let maxStepDrop = 0;
    const checkFrame = (tag) => {
      advanceNow(1000 / 60);
      controller.tick(1000 / 60);
      p.update(1 / 60);
      const curPx = avgY() * scalePx;
      const d = curPx - prevPx;
      maxStepDrop = Math.max(maxStepDrop, Math.abs(d));
      assert.ok(Math.abs(d) < 1.0, `${tag}: 单帧垂直位移 Δy=${d.toFixed(3)}px 应小于 1.0px`);
      prevPx = curPx;
    };

    assert.equal(controller.onPointerDown(ctx(0.72, 0.18)), true);
    for (let i = 0; i < 10; i++) checkFrame(`press-${i}`);

    for (let i = 1; i <= 45; i++) {
      const nx = 0.72 + (25 / 800) * Math.sin((2 * Math.PI * i) / 30);
      const jitterNy = 0.18 + (0.2 / 800) * Math.sin((2 * Math.PI * i) / 15);
      controller.onPointerMove(ctx(nx, jitterNy));
      checkFrame(`stroke-${i}`);
    }
    assert.equal(controller.state, 'petting');

    controller.onPointerUp(ctx(0.72, 0.18));
    for (let i = 0; i < 60; i++) checkFrame(`release-${i}`);
    assert.ok(maxStepDrop < 1.0, `最大单帧垂直位移 ${maxStepDrop.toFixed(3)}px 应 < 1.0px`);
  } finally {
    p.release();
  }
});
