import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Real bundled Core + moc + physics + PetModel.update (same loader as render-margin).
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

const EAR_MESHES = ['ArtMesh69', 'ArtMesh16', 'ArtMesh17', 'ArtMesh18', 'ArtMesh110', 'ArtMesh109', 'ArtMesh68', 'ArtMesh108'];

test('隐藏猫耳：全部 8 个耳朵网格淡出到 0，其他网格不受影响，头顶包围盒随之下降，再开启淡回', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const ids = Array.from({ length: m.getDrawableCount() }, (_, i) => m.getDrawableId(i).getString());
    const ears = EAR_MESHES.map(id => ids.indexOf(id));
    assert.ok(ears.every(i => i >= 0), 'model must contain every ear mesh');
    assert.equal(p.hasCatEars, true);
    // 眨眼会切换眼部网格不透明度；锁定睁眼，让「其他网格不变」只反映猫耳开关。
    p.setEyeOverride(true, 1, 1);
    for (let i = 0; i < 30; i++) p.update(1 / 30);
    const shown = p.getDynamicBounds();
    const others = ids.map((_, i) => m.getDrawableOpacity(i));
    p.setCatEarsVisible(false);
    p.update(0.09);
    const mid = m.getDrawableOpacity(ears[0]);
    assert.ok(mid > 0.05 && mid < 0.95, `ears must fade, not pop (got ${mid})`);
    for (let i = 0; i < 10; i++) p.update(1 / 30);
    for (const i of ears) assert.equal(m.getDrawableOpacity(i), 0, ids[i]);
    ids.forEach((id, i) => { if (!ears.includes(i)) assert.equal(m.getDrawableOpacity(i), others[i], id); });
    const hidden = p.getDynamicBounds();
    assert.ok(hidden.maxY < shown.maxY, `visible top must drop without ears (${shown.maxY} -> ${hidden.maxY})`);
    // Motions and expressions never restore the part.
    p.startExpression('happy'); assert.ok(p.playAction('cheerful_bounce'));
    for (let i = 0; i < 60; i++) { p.update(1 / 30); for (const e of ears) assert.equal(m.getDrawableOpacity(e), 0); }
    p.setCatEarsVisible(true);
    for (let i = 0; i < 10; i++) p.update(1 / 30);
    for (const i of ears) assert.ok(m.getDrawableOpacity(i) > 0.99, ids[i]);
    p.setCatEarsVisible(false, true); p.update(0);
    for (const i of ears) assert.equal(m.getDrawableOpacity(i), 0, 'immediate restore skips the fade');
  } finally { p.release(); }
});

function loadSource(name, globals = {}) {
  const code = ts.transpileModule(readFileSync(resolve(uiRoot, `src/${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => /embed$/.test(id) ? { isEmbed: false, assetUrl: p => p } : {}, console, ...globals });
  return exports;
}

test('隐藏猫耳时耳朵命中让给头部，耳朵台词停用且洗牌袋立即刷新，开启后恢复', async () => {
  const config = JSON.parse(readFileSync(resolve(uiRoot, 'assets/interaction/aliya_hit_areas.json'), 'utf8'));
  const { HitAreas } = loadSource('interaction/hit-areas', { fetch: async () => ({ ok: true, json: async () => config }) });
  const hit = new HitAreas(); await hit.load();
  const ear = config.areas.find(a => a.id === 'ear_left');
  assert.equal(hit.hitAreaAt(ear.x, ear.y), 'ear_left');
  hit.disabled.add('ear_left'); hit.disabled.add('ear_right');
  assert.ok(['head', 'hair', 'head_pet_zone'].includes(hit.hitAreaAt(ear.x, ear.y)));
  assert.equal(hit.isInArea('ear_left', ear.x, ear.y), false);
  hit.disabled.clear(); assert.equal(hit.hitAreaAt(ear.x, ear.y), 'ear_left');

  const reactions = JSON.parse(readFileSync(resolve(uiRoot, 'assets/interaction/reactions.json'), 'utf8'));
  const { DialogueStore } = loadSource('dialogue/dialogue');
  const d = new DialogueStore();
  const group = reactions.groups.find(g => g.lines.some(l => l.tags?.includes('ears')) && g.lines.some(l => !l.tags));
  d.setScene(group.id, { entries: group.lines });
  const earIds = new Set(group.lines.filter(l => l.tags?.includes('ears')).map(l => l.id));
  const n = group.lines.length * 3;
  d.select(group.id); // 先建出含耳朵台词的洗牌袋
  d.setExcludedTags(['ears']);
  for (let i = 0; i < n; i++) assert.ok(!earIds.has(d.select(group.id).id));
  d.setExcludedTags([]);
  const seen = new Set(); for (let i = 0; i < n; i++) seen.add(d.select(group.id).id);
  assert.ok([...earIds].some(id => seen.has(id)), '开启后耳朵台词重新可用');
});
