import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pendant-physics.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } }).outputText;
const { PendantPhysics, RopeChain, MAX_STRETCH, pendantCharHeight } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const DT = 1 / 60;
const run = (p, ax, ay, seconds, each) => {
  for (let t = 0; t < seconds; t += DT) { p.step(ax(t), ay(t), DT); each?.(t); }
};

test('静止时垂挂在指针正下方', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(500, 300);
  run(p, () => 500, () => 300, 3);
  assert.ok(Math.abs(p.x - 500) < 1);
  assert.ok(p.distance >= 100 && p.distance <= 100 * MAX_STRETCH);
  assert.ok(Math.abs(p.angle) < 0.01 && p.settled);
});

test('匀速移动：人物被拖在后下方，身体朝移动方向倾斜，绳子拉直', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(0, 0);
  const v = 900;
  run(p, t => t * v, () => 0, 3);
  assert.ok(p.x < p.anchorX - 25, `落在指针后方 (dx=${(p.x - p.anchorX).toFixed(1)})`);
  assert.ok(p.y > p.anchorY + 25, '仍在指针下方');
  assert.ok(p.distance > 98, '绳子被拉直');
  assert.ok(p.angle > 0.2 && p.angle < Math.PI / 2, `身体朝移动方向倾斜 (angle=${p.angle.toFixed(2)})`);
  assert.ok(Math.abs(p.vx - v) < 30, '与指针同速前进');
});

test('快速甩动：人物被甩过头顶、绕指针打转，绳子会松弛', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(0, 0);
  let above = false, slack = false, sweep = 0, prev = Math.atan2(p.x, p.y);
  run(p, t => Math.cos(t * 14) * 220, t => Math.sin(t * 14) * 220, 2, () => {
    const dx = p.x - p.anchorX, dy = p.y - p.anchorY;
    if (dy < -50) above = true;
    if (p.distance < 92) slack = true;
    const a = Math.atan2(dx, dy);
    let d = a - prev;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    sweep += d; prev = a;
    assert.ok(p.distance <= 100 * MAX_STRETCH + 1e-6, '绳长不超过上限');
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.angle));
  });
  assert.ok(above, '荡到指针上方');
  assert.ok(slack, '绳子出现松弛');
  assert.ok(Math.abs(sweep) > 4 * Math.PI, `绕指针转了至少两圈 (${(sweep / Math.PI / 2).toFixed(1)})`);
});

test('停下：带惯性冲过头，钟摆式来回且摆幅衰减，最后垂挂', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(0, 0);
  run(p, t => t * 900, () => 0, 1.5);
  const stopX = p.anchorX;
  const peaks = [];
  let last = p.x - stopX, lastV = p.vx;
  run(p, () => stopX, () => 0, 10, () => {
    const dx = p.x - stopX;
    if (Math.sign(p.vx) !== Math.sign(lastV) && lastV !== 0) peaks.push(Math.abs(dx));
    last = dx; lastV = p.vx;
  });
  assert.ok(peaks.length >= 4, `来回摆荡多次 (${peaks.length})`);
  assert.ok(peaks[0] > 30, '第一次冲过指针');
  for (let i = 2; i < Math.min(peaks.length, 8); i++) assert.ok(peaks[i] < peaks[i - 2], '摆幅逐渐衰减');
  assert.ok(Math.abs(last) < 2 && p.settled, '最终静止垂挂');
});

test('指针跳变（跨屏）直接复位，不甩飞', () => {
  const p = new PendantPhysics({ ropeLength: 100 });
  p.reset(0, 0);
  assert.equal(p.step(5000, 0, DT), false);
  assert.equal(p.x, 5000);
  assert.equal(p.vx, 0);
});

test('绳子：两端固定在指针尾部与人物身上，距离不足时下垂，超过绳长时拉直', () => {
  const r = new RopeChain(16);
  r.reset(0, 0, 0, 100);
  for (let i = 0; i < 120; i++) r.step(0, 0, 60, 0, 100, DT);
  const first = r.points[0], last = r.points[r.points.length - 1];
  assert.deepEqual([first.x, first.y, last.x, last.y], [0, 0, 60, 0]);
  assert.ok(Math.max(...r.points.map(p => p.y)) > 20, '松弛时下垂');
  for (let i = 0; i < 60; i++) r.step(0, 0, 120, 0, 100, DT);
  assert.ok(Math.max(...r.points.map(p => Math.abs(p.y))) < 1, '拉直');
});

test('人物大小按比例缩放', () => {
  assert.equal(pendantCharHeight(2), pendantCharHeight(1) * 2);
});
