import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadMskConfig } from './msk-config-helper.mjs';

function loadFile(url, imports = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => imports[id] ?? {}, console,
    setTimeout, clearTimeout, performance, ...globals });
  return exports;
}
const load = (name, imports, globals) => loadFile(new URL(`../src/${name}.ts`, import.meta.url), imports, globals);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('真实纹理上传与渲染器预乘模式一致，图层透明度同时衰减 RGB', async () => {
  const { CubismRenderer } = loadFile(new URL('../../../third_party/cubism-web-sdk/Framework/src/rendering/cubismrenderer.ts', import.meta.url));
  const renderer = Object.create(CubismRenderer.prototype);
  renderer._isPremultipliedAlpha = false;
  renderer._modelColor = { r: 1, g: 1, b: 1, a: 1 };
  let uploadPremultiplied = false, bound = false;
  const stopAfterBinding = new Error('texture binding reached');
  const gl = { drawingBufferWidth: 200, drawingBufferHeight: 300,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37440, createTexture: () => ({}), bindTexture() {},
    pixelStorei: (key, value) => { assert.equal(key, 37440); uploadPremultiplied = value === 1; },
    texImage2D() {}, generateMipmap() {},
  };
  renderer.startUp = () => assert.equal(renderer.isPremultipliedAlpha(), true);
  renderer.bindTexture = () => {
    bound = true;
    assert.equal(uploadPremultiplied, renderer.isPremultipliedAlpha());
    for (const opacity of [0, 0.2, 0.6, 1]) {
      const c = renderer.getModelColorWithOpacity(opacity);
      assert.deepEqual([c.r, c.g, c.b, c.a], [opacity, opacity, opacity, opacity]);
    }
    throw stopAfterBinding; // 只隔离后续动作/物理装配，以上执行真实加载及颜色计算。
  };
  const setting = { getModelFileName: () => 'model.moc3', getPhysicsFileName: () => '',
    getTextureCount: () => 1, getTextureFileName: () => 'texture.png' };
  const { PetModel } = load('pet-model', {
    '@framework/model/cubismusermodel': { CubismUserModel: class {} },
    '@framework/cubismmodelsettingjson': { CubismModelSettingJson: class { constructor() { return setting; } } },
  }, { Image: class {
    addEventListener(name, fn) { if (name === 'load') this.loaded = fn; }
    set src(_) { queueMicrotask(() => this.loaded()); }
  } });
  const pet = Object.create(PetModel.prototype);
  Object.assign(pet, { _fetchArrayBuffer: async () => new ArrayBuffer(0), loadModel() {},
    _model: { saveParameters() {}, update() {}, getDrawableCount: () => 1,
      getDrawableVertices: () => [-0.4, -0.6, 0.4, 0.5] },
    createRenderer() {}, getRenderer: () => renderer,
  });
  await assert.rejects(pet.loadFromSetting(new ArrayBuffer(0), 0, '/', { gl }), error => error === stopAfterBinding);
  assert.equal(bound, true);
});

test('挥手图层在各帧率连续淡入淡出；打断放下也不跳变', () => {
  const { HandRaiseChannel } = load('overlay');
  for (const fps of [15, 30, 60]) for (const interrupt of [false, true]) {
    const channel = new HandRaiseChannel([], { enabled: 'enabled', forearm: 'forearm', hand: 'hand' });
    const samples = []; const model = { setParameterValueById: (id, v) => { if (id === 'enabled') samples.push(v); } };
    channel.trigger();
    let previous = 0, fadingIn = false, fadingOut = false;
    for (let i = 0; i < fps * 6; i++) {
      if (interrupt && i === fps) channel.release();
      channel.apply(model, 1 / fps);
      const current = samples.at(-1);
      assert.ok(current >= 0 && current <= 1);
      // 打断沿现有 120ms 时间常数回落，比正常放下包络更快，但仍不能跳到端点。
      assert.ok(Math.abs(current - previous) <= (interrupt ? 8 : 4) / fps + 0.002, `${fps}fps: ${previous} -> ${current}`);
      if (current > 0.05 && current < 0.95) {
        if (current > previous) fadingIn = true; else fadingOut = true;
      }
      previous = current;
    }
    assert.ok(fadingIn && fadingOut); assert.equal(samples.at(-1), 0);
  }
});
