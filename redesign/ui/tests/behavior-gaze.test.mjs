import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const source = name => ts.transpileModule(readFileSync(new URL(`src/${name}.ts`, root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const behaviorCode = source('behavior');
const meta = JSON.parse(readFileSync(new URL('assets/live2d/aliya/actions.json', root), 'utf8')).actions;
const motions = JSON.parse(readFileSync(new URL('assets/live2d/aliya/16.model3.json', root), 'utf8')).FileReferences.Motions;
const idleNames = ['nod', 'sway', 'shake', 'stretch', 'wave', 'doubt', 'yawn', 'cheerful_bounce', 'shy_sway'];
const gazeNames = ['look_around', 'daydream'];

function harness(autoActions = false) {
  let now = 0, nextId = 1, target = null, clears = 0, random = () => 0.5;
  const timers = new Map(), played = [], exports = {};
  const math = Object.create(Math); math.random = () => random();
  const host = {
    isActionPlaying: false,
    playAction(name) { played.push(name); return true; },
    setLookTarget(x, y) { target = [x, y]; },
    clearLookTarget() { target = null; clears++; },
  };
  const globals = { exports, Math: math, performance: { now: () => now },
    setTimeout(fn, delay) { const id = nextId++; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(behaviorCode, globals);
  const b = new exports.BehaviorService(() => host, () => now);
  b.autoActions = autoActions;
  b.start();
  return { b, host, played, timers, globals,
    get target() { return target; }, get clears() { return clears; },
    random(fn) { random = fn; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = end;
    },
  };
}

for (const auto of [false, true]) test(`单次 Android 位置输入静止 5 秒独立释放，autoActions=${auto}`, () => {
  const h = harness(auto);
  h.b.updateLookTarget(0.3, 0.4);
  h.advance(4999); assert.ok(h.target); assert.equal(h.b.gazeReleased, false);
  h.advance(1); assert.equal(h.target, null); assert.equal(h.b.gazeReleased, true);
  assert.equal(h.clears, 1); assert.deepEqual(h.played, [], '释放回调不播放任何动作');
  h.b.updateLookTarget(0.8, 0.2);
  assert.equal(h.b.gazeReleased, false); assert.ok(h.target, '新移动立即恢复视线');
  h.b.stop(); assert.equal(h.timers.size, 0);
});

test('连续移动重置五秒期限，重复坐标与阈值内微抖不延长注视', () => {
  const h = harness();
  h.b.updateLookTarget(0.2, 0.4);
  for (const x of [0.4, 0.6, 0.8]) {
    h.advance(4000); h.b.updateLookTarget(x, 0.4);
    assert.ok(h.target); assert.equal(h.b.gazeReleased, false);
    assert.equal(h.timers.size, 1, '每次移动只保留一个释放定时器');
  }
  h.advance(4000); h.b.updateLookTarget(0.803, 0.403);
  h.advance(999); h.b.updateLookTarget(0.8, 0.4); assert.ok(h.target);
  h.advance(1); assert.equal(h.target, null);
  h.b.updateLookTarget(0.803, 0.403); assert.equal(h.target, null, '释放后微抖不重新开始跟随');
  h.b.updateLookTarget(0.807, 0.4); assert.ok(h.target, '累计越过原移动阈值后恢复');
  h.b.stop();
});

test('计时器提前唤醒会补排剩余期限，不需要新的坐标输入', () => {
  const h = harness(); h.b.updateLookTarget(0.3, 0.4);
  const [id, timer] = [...h.timers][0];
  h.advance(4999); h.timers.delete(id); timer.fn();
  assert.ok(h.target); assert.equal(h.timers.size, 1);
  h.advance(1); assert.equal(h.target, null); assert.equal(h.b.gazeReleased, true);
  h.b.stop();
});

test('切换自动动作开关不影响在途视线释放', () => {
  for (const auto of [false, true]) {
    const h = harness(auto); h.b.updateLookTarget(0.3, 0.4);
    h.advance(2500); h.b.autoActions = !auto;
    h.advance(2500); assert.equal(h.target, null); assert.equal(h.b.gazeReleased, true);
    h.b.stop();
  }
});

for (const [field, inactive, active] of [['isDragging', true, false], ['lookAtEnabled', false, true], ['petRunning', false, true]]) {
  test(`${field} 变化立即取消旧计时，恢复后相同坐标从头计时且不误播 notice`, () => {
    const h = harness(true); h.b.updateLookTarget(0.3, 0.4);
    h.advance(4000);
    const staleCallback = [...h.timers.values()].find(t => t.at === 5000).fn;
    h.b[field] = inactive;
    assert.equal(h.target, null); assert.equal(h.b.gazeReleased, false);
    h.advance(16000);
    h.b[field] = active;
    h.b.updateLookTarget(0.3, 0.4); assert.ok(h.target);
    staleCallback(); assert.ok(h.target, '已取消回调即使排入事件队列也不能释放新目标');
    assert.ok(!h.played.includes('notice'), '暂停/拖动/关闭视线的时间不算静止回神');
    h.advance(4999); assert.ok(h.target);
    h.advance(1); assert.equal(h.target, null);
    h.b.stop(); assert.equal(h.timers.size, 0);
  });
}

test('stop 清理定时器；长暂停后 start 不复活旧坐标和 notice', () => {
  const h = harness(); h.b.updateLookTarget(0.3, 0.4);
  h.advance(4000); h.b.stop(); assert.equal(h.timers.size, 0);
  h.advance(60000); h.b.start(); assert.equal(h.timers.size, 0);
  h.b.updateLookTarget(0.3, 0.4); assert.ok(h.target);
  h.advance(5000); assert.equal(h.b.gazeReleased, true); assert.deepEqual(h.played, []);
  h.b.stop();
});

test('显式 clearLookTarget 清理计时及旧静止状态，新输入重新跟随', () => {
  const h = harness(true); h.b.updateLookTarget(0.3, 0.4);
  h.advance(3000); h.b.clearLookTarget(); h.advance(15000);
  assert.equal(h.b.gazeReleased, false);
  h.b.updateLookTarget(0.3, 0.4); assert.ok(h.target); assert.ok(!h.played.includes('notice'));
  h.advance(5000); assert.equal(h.target, null); h.b.stop();
});

test('静止超过 12 秒再移动回神，30 秒冷却保留，且视线立即恢复', () => {
  const h = harness(true);
  // 排除随机动作本身，仅验证真实 notice 播放入口与冷却。
  h.b.canIdle = () => false;
  h.b.updateLookTarget(0.2, 0.4); h.advance(12001);
  h.b.canIdle = () => true;
  h.b.updateLookTarget(0.4, 0.4); assert.deepEqual(h.played, ['notice']); assert.ok(h.target);
  h.b.canIdle = () => false; h.advance(12001); h.b.canIdle = () => true;
  h.b.updateLookTarget(0.6, 0.4); assert.deepEqual(h.played, ['notice']);
  h.b.canIdle = () => false; h.advance(18000); h.b.canIdle = () => true;
  h.b.updateLookTarget(0.8, 0.4); assert.deepEqual(h.played, ['notice', 'notice']);
  h.b.stop();
});

for (const state of ['interaction', 'AI', 'chat', 'autoActions off']) test(`${state} 期间释放只清视线，不抢动作或聊天表演`, () => {
  const h = harness(state !== 'autoActions off');
  h.b.canIdle = () => state === 'AI' || state === 'autoActions off';
  h.host.isActionPlaying = state === 'AI';
  h.b.updateLookTarget(0.2, 0.4); h.advance(12001);
  assert.equal(h.b.gazeReleased, true); assert.equal(h.target, null);
  h.b.updateLookTarget(0.8, 0.4); assert.ok(h.target); assert.deepEqual(h.played, []);
  h.b.stop();
});

test('释放后自动视线动作允许被 notice 接棒，手动动作通知则撤销该权限', () => {
  for (const manual of [false, true]) {
    const h = harness(true); h.b.setActionMeta(meta); h.random(() => 0); h.b.start();
    h.b.updateLookTarget(0.2, 0.4); h.advance(8000);
    assert.equal(h.played[0], 'look_around');
    h.host.isActionPlaying = true;
    if (manual) h.b.notifyManualAction();
    h.advance(4001); h.b.updateLookTarget(0.8, 0.4);
    assert.equal(h.played.includes('notice'), !manual);
    h.b.stop();
  }
});

test('真实 PetApp Android 暂停入口同步 petRunning，恢复后重新跟随并重启自动调度', () => {
  const h = harness(true);
  let speeches = 0;
  h.b.randomSpeechEnabled = true; h.b.randomSpeechIntervalMinutes = 0.1;
  h.b.onRandomSpeech = () => { speeches++; }; h.b.refreshRandomSpeech();
  const exports = {};
  vm.runInNewContext(source('pet-app'), { ...h.globals, exports, require: id => id === './platform' ? { platform: 'android', androidShell: () => null } : {} });
  const app = Object.create(exports.PetApp.prototype);
  Object.assign(app, { _paused: false, _running: true, _behavior: h.b,
    _syncBackgroundMotion() {}, _cancelInteraction() {}, _resetDragState() {}, _scheduleFrame() {},
  });
  h.b.updateLookTarget(0.3, 0.4); h.advance(4000); app.setPaused(true);
  assert.equal(h.b.petRunning, false); assert.equal(h.target, null); assert.equal(h.timers.size, 0);
  h.advance(20000); app.setPaused(false); assert.equal(h.b.petRunning, true);
  h.b.updateLookTarget(0.3, 0.4); assert.ok(h.target);
  h.advance(5000); assert.equal(h.target, null);
  h.advance(7000); assert.equal(h.played.length, 1); assert.equal(speeches, 2);
  h.b.stop(); assert.equal(h.timers.size, 0);
});

function sample(h, released) {
  if (released) { h.b.updateLookTarget(0.3, 0.4); h.advance(5000); }
  const seen = new Set();
  // 扫描两个随机分支和抽样分位，不依赖概率才能发现越界动作。
  for (let i = 0; i < 100; i++) for (const gazeRoll of [0, 0.99]) {
    let call = 0; h.random(() => released && call++ === 0 ? gazeRoll : i / 100);
    const name = h.b.randomActionName();
    assert.ok(motions[name]?.length, `返回动作 ${name} 必须在正式模型中注册且可播放`);
    for (const entry of motions[name]) assert.ok(readFileSync(new URL(`assets/live2d/aliya/${entry.File}`, root)).length);
    assert.ok(!['angry', 'notice'].includes(name));
    if (!released) assert.ok(!gazeNames.includes(name));
    seen.add(name);
  }
  return seen;
}

for (const [name, entries] of [
  ['正常', meta], ['未加载', null], ['为空', []],
  ['全部缺少分类', meta.map(({ name, weight, moods }) => ({ name, weight, moods }))],
  ['部分缺少条目', meta.filter(m => ['nod', 'daydream', 'notice', 'angry'].includes(m.name))],
  ['仅事件与视线条目', meta.filter(m => ['daydream', 'notice', 'angry'].includes(m.name))],
  ['未知条目', [{ name: 'not-playable', weight: 100 }]],
  ['错误分类不放宽边界', [{ name: 'angry', category: 'idle' }, { name: 'notice', category: 'idle' }, { name: 'daydream', category: 'idle' }]],
]) for (const released of [false, true]) test(`元数据${name}，released=${released} 时随机选择安全且可播放`, () => {
  const h = harness(); h.b.setActionMeta(entries);
  const seen = sample(h, released); assert.ok(seen.size > 0);
  if ((name === '未加载' || name === '为空') && released) {
    assert.ok(seen.has('look_around')); assert.ok(seen.has('daydream'));
  }
  h.b.stop();
});

test('正常元数据的权重×心情亲和与 65% 视线分支保持原分布', () => {
  for (const released of [false, true]) for (const mood of ['neutral', 'happy', 'sleepy', 'angry']) {
    const h = harness(); h.b.setActionMeta(meta); h.b.setMood(mood);
    if (released) { h.b.updateLookTarget(0.3, 0.4); h.advance(5000); }
    for (const branch of [0, 0.6499, 0.65, 0.9999]) for (let i = 0; i < 100; i++) {
      const roll = (i + 0.5) / 100;
      const entries = meta.filter(m => m.category !== 'reaction' && (released && branch < 0.65 ? m.category === 'gaze' : m.category !== 'gaze'));
      const weights = entries.map(m => m.weight * (m.moods?.[mood] ?? 1));
      let value = roll * weights.reduce((a, b) => a + b, 0);
      const expected = entries.find((_, j) => (value -= weights[j]) <= 0).name;
      let call = 0; h.random(() => released && call++ === 0 ? branch : roll);
      assert.equal(h.b.randomActionName(), expected, `${mood}, released=${released}, branch=${branch}, roll=${roll}`);
    }
    h.b.stop();
  }
});

test('非法权重/心情倍率与零权重总和不会返回缺失或事件动作', () => {
  for (const entries of [
    [{ name: 'nod', weight: Infinity, moods: { neutral: NaN } }],
    [{ name: 'sway', weight: NaN, moods: { neutral: -1 } }],
    [{ name: 'nod', moods: { neutral: 0 } }],
    [{ name: 'notice' }],
  ]) {
    const h = harness(); h.b.setActionMeta(entries);
    for (let i = 0; i < 10; i++) assert.ok(idleNames.includes(h.b.randomActionName()));
    h.b.stop();
  }
});
