import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Real bundled Core + moc + physics + PetModel.update (same loader as cat-ears/render-margin).
const uiRoot = fileURLToPath(new URL('../', import.meta.url));
const frameworkRoot = resolve(uiRoot, '../../third_party/cubism-web-sdk/Framework/src');
const context = vm.createContext({ console, TextDecoder, TextEncoder, setTimeout, clearTimeout, performance, atob });
vm.runInContext(readFileSync(resolve(uiRoot, 'assets/core/live2dcubismcore.js'), 'utf8'), context);
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
    if (/(^|\/)embed$/.test(id)) return { isEmbed: false, assetUrl: p => String(p), postToHost() {} };
    if (id.startsWith('@framework/')) return load(resolve(frameworkRoot, `${id.slice(11)}.ts`));
    return load(resolve(dirname(filename), `${id}.ts`));
  };
  vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename })(require, module, module.exports);
  return module.exports;
}
const { CubismFramework } = load(resolve(frameworkRoot, 'live2dcubismframework.ts'));
assert.ok(CubismFramework.startUp());
CubismFramework.initialize();
const { PetModel } = load(resolve(uiRoot, 'src/pet-model.ts'));
const { parseFaceCues, faceAt, FaceCueTrack } = load(resolve(uiRoot, 'src/face-cue.ts'));
const assetRoot = resolve(uiRoot, 'assets/live2d/aliya');
const bytes = file => { const b = readFileSync(resolve(assetRoot, file)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const manifest = JSON.parse(readFileSync(resolve(assetRoot, 'actions.json'), 'utf8')).actions;

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

// Drawables each discrete face swap shows (probed from the real moc).
const MESH = { puff: 'ArtMesh38', pucker: 'ArtMesh41', sad: 'ArtMesh10', speechless: 'ArtMesh65', hit: 'ArtMesh66' };
const NORMAL_MOUTH = ['ArtMesh62', 'ArtMesh63', 'ArtMesh70'];
const SELECTORS = ['Param33', 'Param34', 'Param35', 'Param37', 'Param39'];

test('脸部提示解析：丢弃非法区间与未知取值，按开始时间排序', () => {
  const spans = parseFaceCues([
    { from: 1, to: 2, eye: 'sad' }, { from: 0.2, to: 0.5, mouth: 'puff' },
    { from: 2, to: 1, eye: 'sad' }, { from: -1, to: 1, mouth: 'puff' }, { from: 0, to: 1, eye: 'wink' },
    { from: 0, to: 1 }, null, 'x',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(spans)), [{ from: 0.2, to: 0.5, mouth: 'puff' }, { from: 1, to: 2, eye: 'sad' }]);
  assert.equal(parseFaceCues(undefined).length, 0);
  assert.deepEqual({ ...faceAt(spans, 0.2) }, { eye: null, mouth: 'puff' });
  assert.deepEqual({ ...faceAt(spans, 0.5) }, { eye: null, mouth: null }, '区间右开');
  const track = new FaceCueTrack(); track.start(spans);
  assert.equal(track.advance(1.1).eye, 'sad'); assert.equal(track.active, true);
  track.advance(1); assert.equal(track.active, false, '走完时间轴自动停止');
});

test('四个替换脸动作在声明区间内一帧切换完整网格，无中间值，区间外与结束后回到原脸', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const ids = Array.from({ length: m.getDrawableCount() }, (_, i) => m.getDrawableId(i).getString());
    const op = name => Math.round(m.getDrawableOpacity(ids.indexOf(name)) * 1e4) / 1e4;
    const param = name => m.getParameterValueById(CubismFramework.getIdManager().getId(name));
    for (const name of ['puff', 'kiss', 'sob', 'deadpan']) {
      const spans = parseFaceCues(manifest.find(a => a.name === name).face);
      assert.equal(spans.length, 1, `${name}: 恰有一段替换脸`);
      const [span] = spans; const key = span.mouth ?? span.eye;
      p.startExpression(null);
      for (let i = 0; i < 60; i++) p.update(1 / 30);
      assert.ok(p.playAction(name));
      const fps = 60; let t = 0, inside = 0;
      while (t < 6) {
        p.update(1 / fps); t += 1 / fps;
        for (const s of SELECTORS) assert.ok(param(s) === 0 || param(s) === 1, `${name}@${t.toFixed(2)}: ${s}=${param(s)} 出现中间值`);
        const on = t >= span.from + 1e-6 && t < span.to - 1e-6;
        const off = t < span.from - 1 / fps || t > span.to + 1 / fps;
        if (on) {
          inside++;
          assert.equal(op(MESH[key]), 1, `${name}@${t.toFixed(2)}: ${key} 网格未显示`);
          if (span.mouth) for (const n of NORMAL_MOUTH) assert.equal(op(n), 0, `${name}: 原嘴 ${n} 与替换嘴叠加`);
        } else if (off) {
          assert.equal(op(MESH[key]), 0, `${name}@${t.toFixed(2)}: ${key} 在区间外残留`);
        }
      }
      assert.ok(inside > (span.to - span.from) * fps * 0.9, `${name}: 区间内帧数不足`);
      for (const n of NORMAL_MOUTH) assert.equal(op(n), 1, `${name}: 结束后原嘴未恢复`);
      assert.equal(p.faceCue.eye, null); assert.equal(p.faceCue.mouth, null);
    }
  } finally { p.release(); }
});

test('打断立即撤回替换脸；表情眼型在动作结束后接回，受击挤眼不叠替换嘴', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const ids = Array.from({ length: m.getDrawableCount() }, (_, i) => m.getDrawableId(i).getString());
    const op = name => Math.round(m.getDrawableOpacity(ids.indexOf(name)) * 1e4) / 1e4;
    p.startExpression(null);
    assert.ok(p.playAction('puff')); for (let i = 0; i < 40; i++) p.update(1 / 30);
    assert.equal(op(MESH.puff), 1);
    assert.ok(p.playAction('nod')); p.update(1 / 30);
    assert.equal(op(MESH.puff), 0, '无脸部提示的动作接手后立刻撤回鼓嘴');
    for (const n of NORMAL_MOUTH) assert.equal(op(n), 1);

    p.startExpression('speechless'); for (let i = 0; i < 30; i++) p.update(1 / 30);
    assert.equal(op(MESH.speechless), 1);
    assert.ok(p.playAction('sob')); for (let i = 0; i < 40; i++) p.update(1 / 30);
    assert.equal(op(MESH.sad), 1); assert.equal(op(MESH.speechless), 0, '动作哭眼期间不与表情无语眼叠加');
    for (let i = 0; i < 30 * 5; i++) p.update(1 / 30);
    assert.equal(op(MESH.sad), 0); assert.equal(op(MESH.speechless), 1, '动作结束后回到表情自己的眼型');

    p.startExpression('hit'); for (let i = 0; i < 30; i++) p.update(1 / 30);
    assert.ok(p.playAction('puff')); for (let i = 0; i < 40; i++) p.update(1 / 30);
    assert.equal(op(MESH.puff), 0, '受击挤眼自带整张脸，不再叠替换嘴');
    assert.equal(op(MESH.hit), 1);
  } finally { p.release(); }
});
