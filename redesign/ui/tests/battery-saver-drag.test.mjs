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

test('省电模式：拖动、拎起摆动与其他互动全程保持 15fps', () => {
  const { PetApp } = load('pet-app');
  const app = Object.assign(Object.create(PetApp.prototype), {
    _settings: { batterySaver: true }, _fpsCap: 15, _boostUntil: 0, _lift: { active: true },
    _interaction: { isBusy: true }, _leftDown: true, _dragging: true, _nativeDragging: true,
  });
  assert.equal(app._interactionBoost(1000), false);
  assert.equal(app._frameIntervalMs(1000), 1000 / 15);
  app._settings.batterySaver = false; app._fpsCap = 30;
  assert.equal(app._interactionBoost(1000), true, '非省电模式仍升帧');
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
