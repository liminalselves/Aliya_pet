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

function loadSource(name, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`src/${name}.ts`, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, ...globals,
    require(id) { throw new Error(`unexpected runtime import: ${id}`); },
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
