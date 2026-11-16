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
const { parseFxCues, EXPRESSION_FX, FX_PARAMETERS } = load(resolve(uiRoot, 'src/fx-cue.ts'));
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
const MESH = { puff: 'ArtMesh15', pucker: 'ArtMesh41', sad: 'ArtMesh10', speechless: 'ArtMesh65', hit: 'ArtMesh66' };
const NORMAL_MOUTH = ['ArtMesh62', 'ArtMesh63', 'ArtMesh70'];
const SELECTORS = ['Param33', 'Param34', 'Param35', 'Param38', 'Param39'];
const FADE_SELECTORS = ['Param34', 'Param35'];

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
      // 眼型过渡时长（EyeVariantTransition：闭眼 + 闭眼下渐变 + 睁眼）+ 余量，过渡期不做全显/全隐断言。
      const GUARD = 0.7;
      while (t < 6) {
        p.update(1 / fps); t += 1 / fps;
        for (const s of SELECTORS) {
          const v = param(s);
          if (v === 0 || v === 1) continue;
          // 流泪/无语只允许在两眼完全闭合时渐变；受击与替换嘴始终 0/1。
          assert.ok(FADE_SELECTORS.includes(s), `${name}@${t.toFixed(2)}: ${s}=${v} 出现中间值`);
          assert.equal(param('ParamEyeLOpen'), 0, `${name}@${t.toFixed(2)}: ${s} 渐变时左眼未闭`);
          assert.equal(param('ParamEyeROpen'), 0, `${name}@${t.toFixed(2)}: ${s} 渐变时右眼未闭`);
        }
        const on = t >= span.from + 1e-6 && t < span.to - 1e-6;
        const settled = t >= span.from + GUARD && t < span.to - GUARD;
        const off = t < span.from - 1 / fps || t > span.to + GUARD;
        if (on) inside++;
        if (settled) {
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
    // sob 的哭眼从 0.62s 开始，过渡（隐藏闭眼 + 淡出 + 淡入）约 0.76s。
    assert.ok(p.playAction('sob')); for (let i = 0; i < 50; i++) p.update(1 / 30);
    assert.equal(op(MESH.sad), 1); assert.equal(op(MESH.speechless), 0, '动作哭眼期间不与表情无语眼叠加');
    for (let i = 0; i < 30 * 5; i++) p.update(1 / 30);
    assert.equal(op(MESH.sad), 0); assert.equal(op(MESH.speechless), 1, '动作结束后回到表情自己的眼型');

    p.startExpression('hit'); for (let i = 0; i < 30; i++) p.update(1 / 30);
    assert.ok(p.playAction('puff')); for (let i = 0; i < 40; i++) p.update(1 / 30);
    assert.equal(op(MESH.puff), 0, '受击挤眼自带整张脸，不再叠替换嘴');
    assert.equal(op(MESH.hit), 1);
  } finally { p.release(); }
});

test('受击挤眼期间原嘴保持显示并随嘴部开合变形', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const ids = Array.from({ length: m.getDrawableCount() }, (_, i) => m.getDrawableId(i).getString());
    const op = name => Math.round(m.getDrawableOpacity(ids.indexOf(name)) * 1e4) / 1e4;
    const height = name => {
      const v = m.getDrawableVertices(ids.indexOf(name));
      let lo = Infinity, hi = -Infinity;
      for (let i = 1; i < v.length; i += 2) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
      return hi - lo;
    };
    p.startExpression(null); for (let i = 0; i < 60; i++) p.update(1 / 30);
    const closed = height('ArtMesh63');
    p.startExpression('hit'); for (let i = 0; i < 60; i++) p.update(1 / 30);
    assert.equal(op(MESH.hit), 1);
    for (const n of NORMAL_MOUTH) assert.equal(op(n), 1, `受击时 ${n} 不应被隐藏`);
    assert.ok(height('ArtMesh63') > closed + 0.005, '受击表情的张嘴值应带动嘴部网格变形');
  } finally { p.release(); }
});

test('流泪/无语切换：两眼先一起闭上，闭眼下选择器 0→1，离开时反向', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const param = name => m.getParameterValueById(CubismFramework.getIdManager().getId(name));
    const run = (expression, selectorOut, selectorIn, seconds = 1) => {
      p.startExpression(expression);
      let closedBeforeFade = false, inStarted = false, outDone = !selectorOut, prevIn = 0;
      for (let t = 0; t < seconds; t += 1 / 60) {
        p.update(1 / 60);
        const l = param('ParamEyeLOpen'), r = param('ParamEyeROpen');
        const vin = selectorIn ? param(selectorIn) : 0, vout = selectorOut ? param(selectorOut) : 0;
        assert.ok(Math.abs(l - r) < 1e-6, `${expression}: 两眼必须一起闭合 L=${l} R=${r}`);
        if (selectorOut && vout === 0) outDone = true;
        if (vin > 0 && vin < 1) {
          assert.ok(outDone, `${expression}: 旧眼型淡出完成前不能淡入新眼型`);
          assert.equal(l, 0, `${expression}: 渐变期间眼睛必须全闭`);
          if (!inStarted) closedBeforeFade = true;
          inStarted = true;
          assert.ok(vin >= prevIn, `${expression}: ${selectorIn} 必须单调 0→1`);
        }
        if (vout > 0 && vout < 1) assert.equal(l, 0, `${expression}: 淡出期间眼睛必须全闭`);
        prevIn = vin;
      }
      if (selectorIn) {
        assert.ok(closedBeforeFade, `${expression}: 未观察到闭眼后的渐变`);
        // 特殊眼显示期间普通眼睑保持闭合（不睁开再闭，猫耳物理输入不变）。
        assert.equal(param(selectorIn), 1); assert.equal(param('ParamEyeLOpen'), 0);
      }
      if (selectorOut) assert.equal(param(selectorOut), 0);
    };
    // 固定掉随机自然眨眼：它会让「睁眼」断言偶发落在眨眼帧上。
    p._eyeBlink.setBlinkingInterval(1e6); p._eyeBlink._nextBlinkingTime = 1e6;
    p.startExpression(null); for (let i = 0; i < 60; i++) p.update(1 / 60);
    run('sad', null, 'Param34');
    run('speechless', 'Param34', 'Param35');
    run('sad', 'Param35', 'Param34');
    run(null, 'Param34', null);
    // 闭眼过程中表情被撤回：不进入特殊眼，直接睁回普通眼。
    p.startExpression('speechless'); for (let i = 0; i < 3; i++) p.update(1 / 60);
    run(null, null, null);
    assert.equal(param('Param35'), 0); assert.equal(param('ParamEyeLOpen'), 1);
  } finally { p.release(); }
});

test('连续点击重播委屈：哭眼保持到新区间开始，只闭眼一次', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const param = name => m.getParameterValueById(CubismFramework.getIdManager().getId(name));
    // 自然眨眼是随机的（_eyeBlink = null 并不能关掉它），会被误计成过渡闭眼：把间隔拉到测试时长之外。
    p._eyeBlink.setBlinkingInterval(1e6); p._eyeBlink._nextBlinkingTime = 1e6;
    for (const clicks of [[0, 1, 2, 3], [0, 1.5], [0, 2]]) {
      p.startExpression(null); for (let i = 0; i < 300; i++) p.update(1 / 60);
      let closes = 0, wasClosed = false, flips = 0, wasSad = false;
      const end = clicks.at(-1) + 5;
      for (let f = 0; f < 60 * end; f++) {
        if (clicks.some(c => Math.abs(c - f / 60) < 1e-6)) assert.ok(p.playAction('sob'));
        p.update(1 / 60);
        const closed = param('ParamEyeLOpen') === 0;
        if (closed && !wasClosed) closes++; wasClosed = closed;
        const sad = param('Param34') > 0; if (sad !== wasSad) flips++; wasSad = sad;
      }
      assert.equal(closes, 1, `点击 ${clicks}: 应只闭眼一次，实际 ${closes} 次`);
      assert.equal(flips, 2, `点击 ${clicks}: 哭眼应只出现、消失各一次`);
      assert.equal(param('Param34'), 0); assert.equal(param('ParamEyeLOpen'), 1);
    }
  } finally { p.release(); }
});

const FX_MESH = { heart: 'heart', question: 'question', surprise: 'exclaim', gloom: 'gloom', sleep: 'zzz', sparkle: 'sparkle', music: 'music' };

test('情绪符号时间轴解析：丢弃非法区间与未知符号', () => {
  const spans = parseFxCues([{ from: 1, to: 2, fx: 'heart' }, { from: 0.2, to: 0.5, fx: 'music' },
    { from: 2, to: 1, fx: 'heart' }, { from: 0, to: 1, fx: 'tear' }, { from: 0, to: 1 }, null]);
  assert.deepEqual(JSON.parse(JSON.stringify(spans)), [{ from: 0.2, to: 0.5, fx: 'music' }, { from: 1, to: 2, fx: 'heart' }]);
  for (const fx of manifest.flatMap(a => a.fx ?? [])) assert.ok(fx.fx in FX_PARAMETERS, `actions.json: 未知符号 ${fx.fx}`);
});

test('情绪符号随动作与表情联动：只显示对应符号，渐入渐出，结束不残留', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const ids = Array.from({ length: m.getDrawableCount() }, (_, i) => m.getDrawableId(i).getString());
    const op = name => m.getDrawableOpacity(ids.indexOf(name));
    const settle = () => { p.startExpression(null); for (let i = 0; i < 240; i++) p.update(1 / 60); };
    // 模型静止时 gloom 网格自带 0.01 不透明度，阈值取 0.05。
    const shown = () => Object.keys(FX_MESH).filter(fx => op(FX_MESH[fx]) > 0.05);
    const check = (label, want, seconds) => {
      let peak = 0, prev = 0, maxStep = 0;
      for (let f = 0; f < 60 * seconds; f++) {
        p.update(1 / 60);
        const s = shown();
        assert.ok(s.length <= 1, `${label}: 同时出现多个符号 ${s}`);
        if (want) {
          assert.ok(s.length === 0 || s[0] === want, `${label}: 出现了 ${s[0]}，应为 ${want}`);
          const o = op(FX_MESH[want]); peak = Math.max(peak, o); maxStep = Math.max(maxStep, Math.abs(o - prev)); prev = o;
        } else assert.equal(s.length, 0, `${label}: 不应出现符号 ${s}`);
      }
      if (want) {
        assert.ok(peak > 0.99, `${label}: ${want} 未完整显示`);
        assert.ok(maxStep < 0.2, `${label}: ${want} 一帧跳变 ${maxStep.toFixed(2)}，应渐入渐出`);
      }
      assert.equal(shown().length, 0, `${label}: 结束后符号残留`);
    };
    for (const entry of manifest) {
      const spans = parseFxCues(entry.fx);
      settle(); assert.ok(p.playAction(entry.name));
      check(`动作 ${entry.name}`, spans[0]?.fx ?? null, 9);
    }
    for (const name of p.getExpressionNames()) {
      settle(); p.startExpression(name);
      check(`表情 ${name}`, EXPRESSION_FX[name] ?? null, 5);
    }
    // 动作接手立即撤回动作符号：疑惑问号中途换成点头。
    settle(); p.playAction('doubt'); for (let i = 0; i < 60; i++) p.update(1 / 60);
    assert.ok(op('question') > 0.99);
    p.playAction('nod'); for (let i = 0; i < 30; i++) p.update(1 / 60);
    assert.ok(op('question') < 0.05, '新动作接手后问号应淡出');
  } finally { p.release(); }
});

test('静态包围盒只统计默认可见网格：情绪符号与替换脸不撑高人物', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const b = p.getStaticBounds();
    const symbols = ['heart', 'question', 'exclaim', 'gloom', 'zzz', 'sparkle', 'music'];
    const ids = Array.from({ length: m.getDrawableCount() }, (_, i) => m.getDrawableId(i).getString());
    let symbolTop = -Infinity;
    for (const name of symbols) {
      const i = ids.indexOf(name);
      assert.ok(i >= 0 && m.getDrawableOpacity(i) < 0.01, `${name} 默认应透明`);
      const v = m.getDrawableVertices(i);
      for (let j = 1; j < v.length; j += 2) symbolTop = Math.max(symbolTop, v[j]);
    }
    assert.ok(symbolTop > b.maxY, '符号顶边高于人物，才有必要排除');
    // 旧模型包围盒高 1.0072：符号不计入时保持同一量级，计入会变成约 1.056。
    assert.ok(p.boundsH < 1.02, `boundsH=${p.boundsH} 不应包含符号`);
  } finally { p.release(); }
});

test('情绪符号动效：每个符号显示期间都在动（相对少动态效果），量程内无跳变，淡出后归位', async () => {
  const p = await model();
  try {
    const m = p.getModel();
    const ids = Array.from({ length: m.getDrawableCount() }, (_, i) => m.getDrawableId(i).getString());
    const center = name => {
      const v = m.getDrawableVertices(ids.indexOf(name));
      let x = 0, y = 0; for (let j = 0; j < v.length; j += 2) { x += v[j]; y += v[j + 1]; }
      return [x / (v.length / 2), y / (v.length / 2)];
    };
    const drivers = ['Param37', 'Param40', 'Param41'];
    const index = id => Array.from({ length: m.getParameterCount() }, (_, i) => i).find(i => m.getParameterId(i).getString() === id);
    const param = id => m.getParameterValueByIndex(index(id));
    const motion = (fx, reduce) => {
      p.setReducedMotion(reduce);
      p.startExpression(null); p.setEyeOverride(true, 1, 1);
      for (let i = 0; i < 240; i++) p.update(1 / 60);
      // 直接经通道显示：表情符号保持 2.6s，取其中 2s 采样。
      const expr = Object.entries(EXPRESSION_FX).find(([, f]) => f === fx)?.[0];
      if (expr) p.startExpression(expr);
      else { const act = manifest.find(a => parseFxCues(a.fx)[0]?.fx === fx); assert.ok(act, fx); p.playAction(act.name); }
      const track = [];
      let prev = null, maxJump = 0;
      for (let i = 0; i < 120; i++) {
        p.update(1 / 60);
        const c = center(FX_MESH[fx]);
        track.push(c);
        if (prev) maxJump = Math.max(maxJump, Math.hypot(c[0] - prev[0], c[1] - prev[1]));
        prev = c;
        for (const d of drivers) { const v = param(d); assert.ok(v >= -10 && v <= 10, `${fx}: ${d}=${v} 超出量程`); }
      }
      return { track, maxJump };
    };
    for (const fx of Object.keys(FX_MESH)) {
      // 同一帧序列各跑一遍：差值只来自符号动效，排除表情/动作带动头部的位移。
      const on = motion(fx, false), off = motion(fx, true);
      const dx = on.track.map((c, i) => c[0] - off.track[i][0]);
      const dy = on.track.map((c, i) => c[1] - off.track[i][1]);
      const swing = Math.max(Math.max(...dx) - Math.min(...dx), Math.max(...dy) - Math.min(...dy));
      assert.ok(swing > 0.006, `${fx}: 显示期间应有可见动效（位移 ${swing.toFixed(4)}）`);
      assert.ok(on.maxJump < 0.01, `${fx}: 一帧位移 ${on.maxJump.toFixed(4)} 过大`);
    }
    // 全部淡出后动效参数回到物理自身的小幅漂浮。
    p.setReducedMotion(false); p.startExpression(null); p.playAction('nod');
    for (let i = 0; i < 600; i++) p.update(1 / 60);
    for (const d of drivers) assert.ok(Math.abs(param(d)) < 1, `${d} 残留 ${param(d)}`);
  } finally { p.release(); }
});
