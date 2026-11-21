import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(name, imports = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => imports[id] ?? {}, console, performance, ...globals });
  return exports;
}

test('省电模式：拖动与拎起摆动期间升到 60fps，其余互动仍保持 15fps', () => {
  const { PetApp } = load('pet-app');
  const app = Object.assign(Object.create(PetApp.prototype), {
    _settings: { batterySaver: true }, _fpsCap: 15, _boostUntil: 0, _lift: { active: false },
    _interaction: { isBusy: true }, _leftDown: true, _dragging: false, _nativeDragging: false,
  });
  assert.equal(app._interactionBoost(1000), false, '点击/抚摸不升帧');
  app._dragging = true;
  assert.equal(app._interactionBoost(1000), true, '拖动升帧');
  assert.equal(app._frameIntervalMs(1000), 1000 / 60);
  app._dragging = false; app._leftDown = false;
  assert.equal(app._interactionBoost(1200), true, '收尾 400ms 保持');
  assert.equal(app._interactionBoost(1500), false);
  app._nativeDragging = true;
  assert.equal(app._interactionBoost(2000), true, 'Android 原生拖动也升帧');
});

test('拖动期间不做 GPU 画布回读', () => {
  const { PetApp } = load('pet-app', { './platform': { platform: 'tauri' } });
  let reads = 0;
  const app = Object.assign(Object.create(PetApp.prototype), {
    _hitMaskSend() {}, _model: { isReady: () => true }, _dragging: true,
    _canvas: { getBoundingClientRect() { reads++; return { left: 0, top: 0, width: 1, height: 1 }; } },
  });
  app._maybeSendHitMask();
  assert.equal(reads, 0);
});

test('LiftPose 低帧率下与 60fps 结果接近，且速度不会在两帧间被误清零', () => {
  const { LiftPose } = load('lift-pose');
  const run = fps => {
    const p = new LiftPose(); p.setHolding(true);
    let max = 0;
    for (let i = 0; i < fps; i++) {
      p.setVelocity(1500); p.update(1 / fps); max = Math.max(max, Math.abs(p.angle));
      assert.ok(Number.isFinite(p.angle) && Number.isFinite(p.lift));
    }
    return { max, angle: p.angle };
  };
  const a = run(60), b = run(15);
  assert.ok(Math.abs(a.max - b.max) < 1.5, `${a.max} vs ${b.max}`);
});
