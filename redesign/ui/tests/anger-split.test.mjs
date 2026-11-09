import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Real bundled Core + moc + PetModel.update; only texture/GPU setup is stubbed.
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
    if (id.startsWith('@framework/')) return load(resolve(frameworkRoot, `${id.slice(11)}.ts`));
    if (/(^|\/)embed$/.test(id)) return { isEmbed: false, assetUrl: p => '/' + String(p).replace(/^\/+/, ''), postToHost() {} };
    return load(resolve(dirname(filename), `${id}.ts`));
  };
  vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename })(require, module, module.exports);
  return module.exports;
}
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

test('黑脸与怒气符号可分开显示，切换表情时被隐藏的一半不会在淡出中闪现', async () => {
  const p = await model();
  try {
    const core = p._model.getModel();
    const shade = core.drawables.ids.indexOf('ArtMesh11'), mark = core.drawables.ids.indexOf('ArtMesh12');
    assert.ok(shade >= 0 && mark >= 0, '黑脸/怒气符号网格必须存在');
    const op = () => [core.drawables.opacities[shade], core.drawables.opacities[mark]];
    const run = (seconds, check) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) { p.update(1 / 60); check?.(op()); } return op(); };

    assert.ok(p.startExpression('angry'));
    let [s, m] = run(1.5);
    assert.ok(s > 0.5 && m > 0.95, `生气：黑脸与符号都显示 ${s} ${m}`);

    assert.ok(p.startExpression('annoyed'));
    // 生气→不爽：Param32 保持，黑脸在遮罩淡出后消失，符号全程保持。
    [s, m] = run(1.5, ([, mk]) => assert.ok(mk > 0.9, `切换中符号不应闪灭 ${mk}`));
    assert.ok(s < 0.01 && m > 0.95, `不爽：只有符号 ${s} ${m}`);

    assert.ok(p.startExpression('gloomy'));
    [s, m] = run(1.5);
    assert.ok(s > 0.5 && m < 0.01, `阴沉：只有黑脸 ${s} ${m}`);

    // 阴沉→开心：Param32 淡出期间符号保持隐藏，不能复现。
    assert.ok(p.startExpression('happy'));
    [s, m] = run(1.5, ([, mk]) => assert.ok(mk < 0.01, `淡出中符号闪现 ${mk}`));
    assert.ok(s < 0.01 && m < 0.01);

    // 之后再进生气，两者恢复原样。
    assert.ok(p.startExpression('angry'));
    [s, m] = run(1.5);
    assert.ok(s > 0.5 && m > 0.95, `恢复生气 ${s} ${m}`);

    // 生气动作（motion 自带 Param32）在中性表情下两者同时出现，与原表现一致。
    assert.ok(p.startExpression(null));
    run(1.5);
    assert.ok(p.playAction('angry'));
    [s, m] = run(1.0);
    assert.ok(s > 0.3 && m > 0.6, `生气动作保持原表现 ${s} ${m}`);
  } finally {
    p.release();
  }
});
