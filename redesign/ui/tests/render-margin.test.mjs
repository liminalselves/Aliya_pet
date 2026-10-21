import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const uiRoot = fileURLToPath(new URL('../', import.meta.url));
const frameworkRoot = resolve(uiRoot, '../../third_party/cubism-web-sdk/Framework/src');
const context = vm.createContext({ console, TextDecoder, TextEncoder, setTimeout, clearTimeout, performance, atob });
vm.runInContext(readFileSync(resolve(uiRoot, 'assets/core/live2dcubismcore.js'), 'utf8'), context);
// The bundled asm.js Core installs its exports via a Promise chain, without I/O.
await new Promise(setImmediate);
const modules = new Map();
function load(filename) {
  filename = resolve(filename);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }, fileName: filename,
  }).outputText;
  const require = id => {
    if (id.startsWith('@framework/')) return load(resolve(frameworkRoot, `${id.slice(11)}.ts`));
    assert.ok(id.startsWith('.'), `unexpected import: ${id}`);
    return load(resolve(dirname(filename), `${id}.ts`));
  };
  vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename })(require, module, module.exports);
  return module.exports;
}

// Real bundled Core + moc + physics + PetModel.update. Only texture/GPU setup is
// isolated: this checks drawable vertices, not pixels or native DPI behavior.
const { CubismFramework } = load(resolve(frameworkRoot, 'live2dcubismframework.ts'));
assert.ok(CubismFramework.startUp());
CubismFramework.initialize();
const { PetModel } = load(resolve(uiRoot, 'src/pet-model.ts'));
const assetRoot = resolve(uiRoot, 'assets/live2d/aliya');
const bytes = file => { const b = readFileSync(resolve(assetRoot, file)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
async function model() {
  const p = new PetModel();
  p._fetchArrayBuffer = async name => bytes(name);
  p.createRenderer = () => {};
  p.getRenderer = () => ({ setIsPremultipliedAlpha() {}, startUp() {}, bindTexture() {} });
  p._loadTexture = async () => null;
  const setting = bytes('16.model3.json');
  await p.loadFromSetting(setting, setting.byteLength, '', { gl: { drawingBufferWidth: 800, drawingBufferHeight: 800 }, frameBuffer: null, shaderPath: '' });
  return p;
}

// Deterministic blink scheduling; no motion, gaze, expression or physics is mocked.
vm.runInContext('Math.random = (() => { let seed = 260022; return () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296); })()', context);
const appModule = { exports: {} };
const appCode = ts.transpileModule(readFileSync(resolve(uiRoot, 'src/pet-app.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
vm.runInContext(`(function(require, exports) {\n${appCode}\n})`, context)(id =>
  id.startsWith('@framework/') ? load(resolve(frameworkRoot, `${id.slice(11)}.ts`)) : {}, appModule.exports);
const { PetApp } = appModule.exports;

test('新动作×全部表情×极端注视及动作切换的正式Core顶点均保留5%渲染安全带', async () => {
  const summary = { cases: 0, frames: 0, maxX: 0, maxY: 0, required: 0, worst: null };
  const gazes = [[.5, .5], [0, 0], [1, 0], [0, 1], [1, 1]];
  let p;
  function sample(label) {
    const b = p.getDynamicBounds();
    assert.ok(b && Object.values(b).every(Number.isFinite), label);
    summary.frames++;
    summary.maxX = Math.max(summary.maxX, -b.minX, b.maxX);
    summary.maxY = Math.max(summary.maxY, -b.minY, b.maxY);
    // Use the actual native window aspect, not the old approximate width 0.64H.
    const required = Math.max(-b.minX / (.5 * p.boundsW), b.maxX / (.5 * p.boundsW),
      -b.minY / (.5 * p.boundsH), b.maxY / (.5 * p.boundsH));
    if (required > summary.required) { summary.required = required; summary.worst = { label, bounds: b }; }
  }
  for (const fps of [15, 30, 60]) {
    p = await model();
    try {
      assert.equal(p.getExpressionNames().length, 12);
      assert.equal(p.actionManifest.length, 10);
      for (const action of ['cheerful_bounce', 'shy_sway']) for (const expression of p.getExpressionNames()) for (const gaze of gazes) {
        summary.cases++;
        p.startExpression(expression); p.setLookTarget(...gaze); assert.ok(p.playAction(action));
        for (let frame = 0; frame < fps * 8; frame++) {
          p.update(1 / fps); sample(`${fps}/${action}/${expression}/${gaze}/${frame}`);
        }
      }
      for (const action of ['cheerful_bounce', 'shy_sway']) for (const next of p.actionManifest.map(a => a.name)) for (const at of [.2, 1.8, action === 'shy_sway' ? 5.2 : 3.9]) {
        summary.cases++;
        p.startExpression('shy'); p.setLookTarget(0, 0); assert.ok(p.playAction(action));
        for (let frame = 0; frame < Math.ceil(at * fps) + 8 * fps; frame++) {
          if (frame === Math.ceil(at * fps)) { assert.ok(p.playAction(next)); p.startExpression('happy'); p.setLookTarget(1, 1); }
          p.update(1 / fps); sample(`${fps}/${action}->${next}@${at}/${frame}`);
        }
      }
    } finally { p.release(); }
  }
  const margin = PetApp._renderMarginRatio;
  console.log(JSON.stringify({ ...summary, withSafety: summary.required * 1.05, configured: margin }));
  assert.ok(margin >= summary.required * 1.05, `渲染余量${margin}不足，需至少${summary.required * 1.05}`);

  // Exercise the real PetApp._render and Cubism matrices at minimum/default/
  // monitor-limited maximum size. Stub GL calls, then project the conservative
  // envelope; mirror is the final CSS horizontal flip, not a second model flip.
  p = await model();
  try {
    const app = Object.create(PetApp.prototype), viewport = [];
    Object.assign(app, { _model: p, _wrapWindow: false, _canvas: {},
      _gl: { isContextLost: () => false, viewport: (...args) => viewport.push(args), clearColor() {}, enable() {}, depthFunc() {}, clearDepth() {}, clear() {} },
    });
    const { baseW, baseH } = app._baseWindowSize();
    for (const dpi of [1, 1.5, 2, 3]) {
      const { minS, maxS } = app._scaleLimitsFrom({ scaleFactor: dpi, workArea: { size: { width: 3840, height: 2160 } } }, baseW, baseH);
      for (const scale of [minS, .5, maxS]) for (const mirror of [false, true]) {
        const w = Math.round(baseW * scale * dpi), h = Math.round(baseH * scale * dpi);
        Object.assign(app._canvas, { width: w, height: h });
        p.draw = projection => {
          projection.multiplyByMatrix(p.getModelMatrix());
          for (const x of [-summary.maxX, summary.maxX]) for (const y of [-summary.maxY, summary.maxY]) {
            const px = projection.transformX(x) * (mirror ? -1 : 1), py = projection.transformY(y);
            assert.ok(Math.abs(px) * 1.05 <= 1 && Math.abs(py) * 1.05 <= 1, `投影安全带不足: dpi=${dpi},scale=${scale},mirror=${mirror}`);
          }
        };
        app._render();
        assert.deepEqual(viewport.at(-1), [0, 0, w, h]);
      }
    }
  } finally { p.release(); }
});
