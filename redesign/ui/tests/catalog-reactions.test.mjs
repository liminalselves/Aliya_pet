import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const cache = {};
function load(name, globals = {}) {
  const key = name + JSON.stringify(Object.keys(globals));
  if (cache[key]) return cache[key];
  const code = ts.transpileModule(readFileSync(new URL(`src/${name}.ts`, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {}; cache[key] = exports;
  const require = id => {
    if (id.endsWith('catalog')) return load('catalog');
    if (id.endsWith('dialogue/dialogue')) return load('dialogue/dialogue');
    if (id.endsWith('embed')) return { isEmbed: false, assetUrl: p => p, postToHost() {} };
    return {};
  };
  vm.runInNewContext(code, { exports, require, console, Math, Date, setTimeout, clearTimeout, ...globals });
  return exports;
}

const plain = v => JSON.parse(JSON.stringify(v));
const catalog = load('catalog');
const model = json('assets/live2d/aliya/16.model3.json').FileReferences;

test('目录是唯一来源：动作、表情与模型、资源、上报清单一致', () => {
  const sorted = xs => [...xs].sort();
  assert.deepEqual(sorted(Object.keys(model.Motions)), sorted(catalog.MOTION_NAMES));
  assert.deepEqual(sorted(model.Expressions.map(e => e.Name)), sorted(catalog.EXPRESSIONS.map(e => e.name)));
  assert.deepEqual(
    sorted(readdirSync(new URL('assets/live2d/aliya/motions/', root)).filter(n => n.endsWith('.motion3.json'))),
    sorted(catalog.MOTION_NAMES.map(n => `${n}.motion3.json`)));
  const names = catalog.ACTIONS.map(a => a.name);
  assert.equal(new Set(names).size, names.length, '动作名不重复');
  assert.ok(!names.includes('angry'), '动作不再与表情 angry 重名');
  for (const a of catalog.ACTIONS) assert.match(a.label, /[\u4e00-\u9fff]/, a.name);
  const { PERFORMANCE_ACTIONS, PERFORMANCE_EXPRESSIONS } = load('chat/performance-manifest');
  assert.deepEqual(plain(PERFORMANCE_ACTIONS.map(a => a.name)), plain(catalog.MOTION_NAMES), '只上报 Live2D 动作');
  assert.deepEqual(plain(PERFORMANCE_EXPRESSIONS.map(e => e.name)), plain(catalog.EXPRESSIONS.map(e => e.name)));
  for (const item of [...PERFORMANCE_ACTIONS, ...PERFORMANCE_EXPRESSIONS]) assert.ok(item.hint.length <= 64 && item.name.length <= 64);
  const { isProceduralReactionType } = load('interaction/procedural', { performance });
  assert.deepEqual(plain(catalog.PROCEDURAL_NAMES.filter(n => !isProceduralReactionType(n))), [], '程序微动都有实现');
  for (const a of json('assets/live2d/aliya/actions.json').actions) assert.ok(catalog.MOTION_NAMES.includes(a.name), a.name);
});

test('状态的默认表情存在，待机池只含 Live2D 动作且权重为正', () => {
  for (const s of catalog.STATES) {
    if (s.expression) assert.ok(catalog.EXPRESSION_BY_NAME.has(s.expression), s.name);
    const pool = Object.entries(s.idle);
    assert.ok(pool.some(([n]) => !catalog.isGazeAction(n)), `${s.name} 需要普通待机动作`);
    for (const [name, weight] of pool) {
      assert.ok(catalog.isMotion(name), `${s.name}: ${name}`);
      assert.ok(weight > 0 && Number.isFinite(weight));
      assert.notEqual(name, 'notice', 'notice 只由事件触发');
    }
  }
});

test('状态引擎：自动恒为平静（深夜困倦暂停），手动优先且一直保持，可回到自动', () => {
  const { StateEngine, autoStateAt } = load('state');
  const at = h => new Date(2026, 10, 10, h, 0);
  for (const h of [2, 10, 23]) assert.equal(autoStateAt(at(h)), 'neutral', `${h} 点自动不困倦`);
  let now = at(23); const faces = [], changes = [];
  const engine = new StateEngine({ startExpression: name => { faces.push(name); return true; } }, () => now);
  engine.onChanged(s => changes.push([s.name, s.manual]));
  assert.deepEqual(plain(engine.current), { name: 'neutral', manual: null });
  engine.tick(); assert.deepEqual(changes, [], '自动下时段推进不切换');
  assert.ok(engine.setManual('sleepy')); assert.equal(faces.at(-1), 'sleepy', '手动仍可选困倦');
  now = at(10); engine.tick();
  assert.deepEqual(plain(engine.current), { name: 'sleepy', manual: 'sleepy' }, '手动选择一直保持');
  assert.equal(engine.setManual('cheerful'), false, '未知状态被拒绝');
  engine.setManual(null);
  assert.deepEqual(plain(engine.current), { name: 'neutral', manual: null });
  assert.equal(faces.at(-1), null, '回到自动恢复平静脸');
  assert.deepEqual(changes, [['sleepy', 'sleepy'], ['neutral', null]]);
  // 启动恢复存档的手动状态（安卓悬浮窗与主界面共用同一份），未知名按自动处理。
  const restoredFaces = [];
  const restored = new StateEngine({ startExpression: name => { restoredFaces.push(name); return true; } }, () => now, 'shy');
  assert.deepEqual(plain(restored.current), { name: 'shy', manual: 'shy' });
  assert.deepEqual(restoredFaces, ['shy']);
  assert.deepEqual(plain(new StateEngine({ startExpression: () => true }, () => now, 'cheerful').current), { name: 'neutral', manual: null });
});

test('反应组数据合规：台词必填、表情动作至少一个、引用全部存在，区域都有点击反应', () => {
  const { validateReactions } = load('interaction/reactions');
  const raw = json('assets/interaction/reactions.json');
  const { problems, file } = validateReactions(raw);
  assert.deepEqual(plain(problems), []);
  assert.equal(file.groups.length, raw.groups.length);
  const ids = file.groups.flatMap(g => g.lines.map(l => l.id));
  assert.equal(new Set(ids).size, ids.length, '台词 id 不重复');
  for (const area of json('assets/interaction/aliya_hit_areas.json').areas) {
    if (area.id === 'head_pet_zone') continue;
    const groups = file.triggers[`click.${area.id}`];
    assert.ok(groups?.length >= 2, `${area.id} 至少两组反应`);
  }
  for (const key of ['click.repeat', 'click.annoyed', 'drag.fast', 'drag.slow', 'random', 'greet',
    'petting.start', 'petting.soft', 'petting.active', 'petting.fast', 'petting.long', 'petting.repeat', 'petting.end',
    'time.morning', 'time.forenoon', 'time.lunch', 'time.afternoon', 'time.dinner', 'time.evening', 'time.late_night', 'time.deep_night']) {
    assert.ok(file.triggers[key]?.length, key);
  }
  // 校验能拦住三类坏数据
  const bad = validateReactions({ groups: [
    { id: 'a', lines: [{ id: 'x', text: '只有台词' }] },
    { id: 'b', action: 'nod', lines: [] },
    { id: 'c', expression: 'not_a_face', lines: [{ id: 'y', text: '表情不存在' }] },
  ], triggers: { k: ['a', 'missing'] } });
  assert.equal(bad.file.groups.length, 0); assert.equal(bad.problems.length, 5, "三个坏组 + 两个失效引用");
});

test('反应组抽取：同一触发键不连续重复，隐藏猫耳后只剩不提猫耳的台词', () => {
  const { ReactionLibrary } = load('interaction/reactions');
  const lib = new ReactionLibrary(() => 0);
  lib.setData(json('assets/interaction/reactions.json'));
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(lib.pick('click.face').group.id);
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
  assert.equal(lib.pick('click.face', { withLine: false }).line, null, '台词位被占时只表演');
  lib.setExcludedTags(['ears']);
  for (let i = 0; i < 40; i++) {
    const { line } = lib.pick('petting.soft');
    assert.ok(!/耳朵/.test(line.finalText), line.finalText);
  }
});
