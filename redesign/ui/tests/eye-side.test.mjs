import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);

// Run the bundled Core and real moc without WebGL or mocked model geometry.
async function loadModel() {
  // No process/window: use Core's standalone, embedded runtime path. Its
  // initialization completes asynchronously; drain that turn before allocating.
  const context = vm.createContext({ console, setTimeout, clearTimeout, atob });
  vm.runInContext(readFileSync(new URL('assets/core/live2dcubismcore.js', root), 'utf8'), context, {
    filename: 'live2dcubismcore.js', timeout: 10000,
  });
  await new Promise(resolve => setImmediate(resolve));
  const core = context.Live2DCubismCore;
  assert.ok(core?.Moc && core?.Model, 'bundled Cubism Core must initialize');
  const bytes = readFileSync(new URL('assets/live2d/aliya/16.moc3', root));
  const moc = core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(moc, 'real Aliya moc must load');
  const model = core.Model.fromMoc(moc);
  assert.ok(model, 'real Aliya model must initialize');
  return { model, release() { model.release(); moc._release(); } };
}

function loadSource(name, globals = {}, imports = null) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`src/${name}.ts`, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, ...globals,
    require(id) { if (imports) return imports[id] ?? {}; throw new Error(`unexpected runtime import: ${id}`); },
  }, { filename: `${name}.ts` });
  return exports;
}

const vertices = model => Array.from(model.drawables.vertexPositions, positions => Array.from(positions));

function snapshot(model, leftOpen, rightOpen) {
  const { parameters } = model;
  parameters.values.set(parameters.defaultValues);
  for (const [id, value] of [['ParamEyeLOpen', leftOpen], ['ParamEyeROpen', rightOpen]]) {
    const index = parameters.ids.indexOf(id);
    assert.notEqual(index, -1, `model must contain ${id}`);
    parameters.values[index] = value;
  }
  model.update();
  // Core vertex views are live; copy before evaluating the other eye state.
  return vertices(model);
}

function changedGeometry(model, baseline, changed) {
  const drawables = [];
  let sumX = 0;
  let count = 0;
  for (let drawable = 0; drawable < baseline.length; drawable++) {
    const before = baseline[drawable];
    const after = changed[drawable];
    let changedCount = 0;
    let changedX = 0;
    let drawableX = 0;
    for (let vertex = 0; vertex < before.length; vertex += 2) {
      drawableX += before[vertex];
      if (Math.hypot(after[vertex] - before[vertex], after[vertex + 1] - before[vertex + 1]) > 1e-6) {
        changedCount++;
        changedX += before[vertex];
      }
    }
    if (changedCount) {
      sumX += changedX;
      count += changedCount;
      drawables.push({ id: model.drawables.ids[drawable], centroidX: drawableX / (before.length / 2) });
    }
  }
  assert.ok(count > 0, 'eye toggle must deform real drawable vertices');
  return { changedVertices: count, centroidX: sumX / count, drawables };
}

test('real Aliya eye geometry matches ear hit areas, procedural masks and mirroring', { timeout: 10000 }, async t => {
  const loaded = await loadModel();
  try {
    const { model } = loaded;
    const bothOpen = snapshot(model, 1, 1);
    const closeL = changedGeometry(model, bothOpen, snapshot(model, 0, 1));
    const closeR = changedGeometry(model, bothOpen, snapshot(model, 1, 0));
    const summary = change => ({ x: change.centroidX, vertices: change.changedVertices, ids: change.drawables.map(d => d.id) });
    t.diagnostic(JSON.stringify({ ParamEyeLOpen: summary(closeL), ParamEyeROpen: summary(closeR) }));
    // Expectations are established from real geometry, not the L/R convention.
    assert.ok(closeL.centroidX > 0, 'ParamEyeLOpen closes the unmirrored image-right eye');
    assert.ok(closeR.centroidX < 0, 'ParamEyeROpen closes the unmirrored image-left eye');
    assert.ok(closeL.drawables.every(d => d.centroidX > 0), 'all L-affected meshes are image-right');
    assert.ok(closeR.drawables.every(d => d.centroidX < 0), 'all R-affected meshes are image-left');

    const config = JSON.parse(readFileSync(new URL('assets/interaction/aliya_hit_areas.json', root), 'utf8'));
    const { HitAreas } = loadSource('interaction/hit-areas', {
      fetch: async () => ({ ok: true, json: async () => config }),
    });
    const hitAreas = new HitAreas();
    await hitAreas.load();
    let now = 0;
    const { ProceduralReactionService, ProceduralReactions } = loadSource('interaction/procedural', {
      performance: { now: () => now },
    });
    const { EyeOverrideChannel } = loadSource('overlay');
    const parameterIndex = id => model.parameters.ids.indexOf(id);
    const writes = [];
    const adapter = {
      getParameterValueById: id => model.parameters.values[parameterIndex(id)],
      setParameterValueById(id, value) {
        assert.notEqual(parameterIndex(id), -1);
        writes.push(id);
        model.parameters.values[parameterIndex(id)] = value;
      },
    };
    for (const mirrored of [false, true]) for (const areaId of ['ear_left', 'ear_right']) {
      hitAreas.mirrored = mirrored;
      const area = hitAreas.areas.find(candidate => candidate.id === areaId);
      assert.ok(area, `real hit-area config must contain ${areaId}`);
      const pointerX = mirrored ? 1 - area.x : area.x;
      const hit = hitAreas.hitAreaAt(pointerX, area.y);
      assert.equal(hit, areaId, 'HitAreas must undo mirroring exactly once');
      const channel = new EyeOverrideChannel({ left: 'ParamEyeLOpen', right: 'ParamEyeROpen' });
      const target = {
        // Isolate the eye channel; head tilt and cheek/ear outputs are unrelated
        // to the eye-side geometry being measured here.
        setInteractionOffsets() {}, setEarInteraction() {}, setFaceCheek() {},
        setEyeOverride(enabled, left, right, side) {
          Object.assign(channel, { enabled, left, right, side });
        },
      };
      const procedural = new ProceduralReactionService({
        getTarget: () => target, isPettingActive: () => false, playCharacterAction: () => true,
      });
      procedural.apply(ProceduralReactions.earBlink(1, hit));
      now += 120;
      procedural.tick();
      const baseline = snapshot(model, 1, 1);
      writes.length = 0;
      channel.apply(adapter, 0.1);
      model.update();
      const change = changedGeometry(model, baseline, vertices(model));
      assert.deepEqual(writes, [areaId === 'ear_left' ? 'ParamEyeROpen' : 'ParamEyeLOpen'],
        `${areaId}, mirrored=${mirrored}: only the selected eye may be written`);
      assert.equal(Math.sign(change.centroidX), areaId === 'ear_left' ? -1 : 1,
        'actual procedural mask must deform the matching unmirrored eye');
      assert.equal(Math.sign(change.centroidX) * (mirrored ? -1 : 1), Math.sign(pointerX - 0.5),
        'after visual mirroring, the deformed eye must remain on the clicked screen side');
    }
  } finally {
    loaded.release();
  }
});

test('正式模型顶点与命中椭圆经真实渲染投影后，余量、镜像、DPI、聊天和贴合模式命中不漂移', { timeout: 15000 }, async t => {
  const loaded = await loadModel();
  try {
    const positions = snapshot(loaded.model, 1, 1);
    const config = JSON.parse(readFileSync(new URL('assets/interaction/aliya_hit_areas.json', root), 'utf8'));
    const { HitAreas } = loadSource('interaction/hit-areas', { fetch: async () => ({ ok: true, json: async () => config }) });
    const hit = new HitAreas(); await hit.load(); await hit.load();
    assert.equal(hit.areas.length, config.areas.length, '重载不积累椭圆');
    assert.equal(hit.referenceRenderMargin, 1.22, '保留原校准参考，不冒充实机重新测量');
    const sdkExports = {};
    const matrixCode = ts.transpileModule(readFileSync(new URL('../../third_party/cubism-web-sdk/Framework/src/math/cubismmatrix44.ts', root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText;
    vm.runInNewContext(matrixCode, { exports: sdkExports, require: () => ({}) });
    const { CubismMatrix44 } = sdkExports;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const mesh of positions) for (let i = 0; i < mesh.length; i += 2) {
      minX = Math.min(minX, mesh[i]); maxX = Math.max(maxX, mesh[i]);
      minY = Math.min(minY, mesh[i + 1]); maxY = Math.max(maxY, mesh[i + 1]);
    }
    const boundsW = maxX - minX, boundsH = maxY - minY, aspect = boundsW / boundsH;
    const ref = (x, y) => ({ nx: .5 + x / (boundsW * hit.referenceRenderMargin), ny: .5 - y / (boundsH * hit.referenceRenderMargin) });
    // 全部真实顶点 + 各椭圆中心、内外边缘；既核对分类，也核对反投影坐标。
    const points = positions.flatMap(mesh => {
      const result = []; for (let i = 0; i < mesh.length; i += 2) result.push([mesh[i], mesh[i + 1]]); return result;
    });
    for (const area of hit.areas) for (const offset of [0, .45, .55]) {
      points.push([(area.x + area.width * offset - .5) * boundsW * hit.referenceRenderMargin,
        (.5 - area.y) * boundsH * hit.referenceRenderMargin]);
    }
    const expected = points.map(([x, y]) => { const n = ref(x, y); return [n, hit.hitAreaAt(n.nx, n.ny), hit.isInHeadPetZone(n.nx, n.ny)]; });
    let cases = 0;
    for (const mode of ['native', 'chat', 'android', 'wrap']) {
      const { PetApp } = loadSource('pet-app', { performance }, {
        './platform': { platform: mode === 'android' ? 'android' : 'tauri' },
        '@framework/math/cubismmatrix44': { CubismMatrix44 },
      });
      const currentMargin = PetApp._renderMarginRatio;
      for (const margin of [1.22, currentMargin, 1.5]) for (const dpr of [1, 1.25, 2, 3])
        for (const size of [120, 600, 2160]) for (const mirror of [false, true]) {
          PetApp._renderMarginRatio = margin;
          const width = Math.round(size * aspect * (mode === 'chat' ? .6 : 1)), height = size;
          const rect = { left: 117, top: 31, width, height };
          const modelMatrix = new CubismMatrix44(); let projection;
          const model = { isReady: () => true, boundsW, boundsH, boundsAspect: aspect,
            getModelMatrix: () => modelMatrix, draw(p) { p.multiplyByMatrix(modelMatrix); projection = p; } };
          const app = Object.create(PetApp.prototype);
          hit.mirrored = mirror;
          Object.assign(app, { _model: model, _hitAreas: hit, _settings: { mirror, scale: 1 },
            _canvas: { width: Math.round(width * dpr), height: Math.round(height * dpr), getBoundingClientRect: () => rect },
            _gl: { isContextLost: () => false, viewport() {}, clearColor() {}, enable() {}, depthFunc() {}, clearDepth() {}, clear() {} },
            _chatView: { isOpen: mode === 'chat' }, _wrapWindow: mode === 'wrap', _dpr: dpr,
            _contentScaleCss: size / currentMargin / boundsH,
            _originCssX: 701, _originCssY: 503, _appliedRectX: 701 - width * .43, _appliedRectY: 503 - height * .61,
          });
          app._render(); cases++;
          // 独立核对重构前的渲染公式，避免共享变换把渲染和反解一起改错。
          const vpW = app._canvas.width, vpH = app._canvas.height;
          const fitH = ['chat', 'android'].includes(mode) ? Math.min(vpH, vpW / aspect) : vpH;
          const oldScale = mode === 'wrap' ? app._contentScaleCss * dpr : fitH / margin / boundsH;
          const oldX = mode === 'wrap' ? (app._originCssX - app._appliedRectX) * dpr : vpW / 2;
          const oldY = mode === 'wrap' ? (app._originCssY - app._appliedRectY) * dpr : vpH / 2;
          assert.ok(Math.abs(projection.transformX(.1) - (2 * (oldX + .1 * oldScale) / vpW - 1)) < 2e-6);
          assert.ok(Math.abs(projection.transformY(.1) - (1 - 2 * (oldY - .1 * oldScale) / vpH)) < 2e-6);
          const eventAt = (x, y) => {
            const screenX = (projection.transformX(x) + 1) * width / 2;
            return { clientX: rect.left + (mirror ? width - screenX : screenX),
              clientY: rect.top + (1 - projection.transformY(y)) * height / 2, pointerType: 'touch' };
          };
          for (let i = 0; i < points.length; i++) {
            const [x, y] = points[i], [want, area, headZone] = expected[i];
            const n = app._hitEventNorm(eventAt(x, y));
            assert.ok(Math.abs((mirror ? 1 - n.nx : n.nx) - want.nx) < 2e-6 && Math.abs(n.ny - want.ny) < 2e-6,
              `${mode}, margin=${margin}, DPI=${dpr}, size=${size}, mirror=${mirror}: 反投影必须回到同一模型坐标`);
            assert.equal(hit.hitAreaAt(n.nx, n.ny), area);
            assert.equal(hit.isInHeadPetZone(n.nx, n.ny), headZone);
          }
          const far = app._hitEventNorm(eventAt(boundsW * 10, boundsH * 10));
          assert.equal(hit.hitAreaAt(far.nx, far.ny), null, '远处点击不能被clamp成边缘命中');
          const e = eventAt(0, 0); let gaze;
          app._behavior = { updateLookTarget: (nx, ny) => gaze = { nx, ny } };
          app._updatePointerLook(e); const oldGaze = app._eventNorm(e);
          assert.equal(gaze.nx, oldGaze.nx); assert.equal(gaze.ny, oldGaze.ny, '注视仍用旧视口口径');
          app._lastMoveMs = 0; const ctx = app._ctx(e), n = app._hitEventNorm(e);
          assert.equal(ctx.normX, n.nx); assert.equal(ctx.normY, n.ny, '指针实际入口使用新命中口径');
        }
      PetApp._renderMarginRatio = currentMargin;
    }
    t.diagnostic(JSON.stringify({ cases, modelPoints: points.length, boundsW, boundsH }));
  } finally { loaded.release(); }
});
