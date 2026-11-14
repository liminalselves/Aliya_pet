import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { LogicalSize, PhysicalSize, LogicalPosition, PhysicalPosition, Size, Position } from '@tauri-apps/api/dpi';

function load(name, imports, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => { assert.ok(id in imports, id); return imports[id]; },
    console, URLSearchParams, ...globals });
  return exports;
}

function harness(os = 'macos', label = 'pet') {
  const calls = [];
  let scaleListener, error = null;
  const unlisten = () => calls.push(['unlisten']);
  const geometry = {
    outer: { x: -1400.5, y: -300.25, width: 400, height: 600 },
    inner: { x: -1400.5, y: -300.25, width: 400, height: 600 }, backingScale: 2,
    monitor: { name: 'Retina', bounds: { x: -1920, y: -1080, width: 1920, height: 1080 },
      workArea: { x: -1920, y: -1055, width: 1920, height: 1000 } },
  };
  const primary = { name: 'Primary', bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 25, width: 1440, height: 825 } };
  const nativeMonitor = { scaleFactor: 1.5, name: 'Windows', position: new PhysicalPosition(-3000, 0),
    size: new PhysicalSize(3000, 2400), workArea: { position: new PhysicalPosition(-3000, 40), size: new PhysicalSize(3000, 2300) } };
  const native = { label,
    outerPosition: async () => new PhysicalPosition(300, 600),
    innerPosition: async () => new PhysicalPosition(300, 630),
    outerSize: async () => new PhysicalSize(600, 900), innerSize: async () => new PhysicalSize(600, 870),
    scaleFactor: async () => 1.5,
    setPosition: async value => calls.push(['position', value]),
    setSize: async value => calls.push(['size', value]),
    setAlwaysOnTop: async value => calls.push(['top', value]),
    onMoved: async callback => { calls.push(['moved', callback]); return unlisten; },
    onScaleChanged: async callback => { scaleListener = callback; return unlisten; },
  };
  const api = { LogicalSize, PhysicalSize, PhysicalPosition, getCurrentWindow: () => native,
    currentMonitor: async () => nativeMonitor, primaryMonitor: async () => nativeMonitor };
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (error) throw error;
    if (command === 'desktop_geometry') return structuredClone(geometry);
    if (command === 'desktop_primary_monitor') return structuredClone(primary);
    if (command === 'desktop_set_position') Object.assign(geometry.outer, args);
  };
  const module = load('desktop-window', {
    '@tauri-apps/api/window': api, '@tauri-apps/api/core': { invoke }, './platform': { desktopOS: os },
  });
  return { module, window: module.getCurrentWindow(), geometry, primary, calls, nativeMonitor, native,
    fail: value => { error = value; },
    emitScale: (factor, width, height) => scaleListener({ event: 'tauri://scale-change', id: 1,
      payload: { scaleFactor: factor, size: new PhysicalSize(width, height) } }),
  };
}

test('macOS geometry stays in desktop points when backing scale changes or pet/chat span different displays', async () => {
  for (const label of ['pet', 'chat']) {
    const h = harness('macos', label);
    for (const backingScale of [2, 1, 2]) {
      h.geometry.backingScale = backingScale;
      assert.equal(await h.window.scaleFactor(), 1);
      assert.deepEqual(await h.window.outerPosition(), new PhysicalPosition(-1400.5, -300.25));
      assert.deepEqual(await h.window.innerSize(), new PhysicalSize(400, 600));
    }
    for (const value of [new PhysicalPosition(-500.5, -100.25), new LogicalPosition(700.5, 100.25),
      new Position(new PhysicalPosition(-400.5, -500.25))]) {
      await h.window.setPosition(value);
      const expected = 'position' in value ? value.position : value;
      assert.deepEqual(await h.window.outerPosition(), new PhysicalPosition(expected.x, expected.y));
    }
    assert.ok(!h.calls.some(([command]) => command === 'position'), 'no raw Tauri physical-coordinate setter');
  }
});

test('macOS work areas preserve menu/Dock margins, negative origins and unavailable monitors', async () => {
  const h = harness();
  const current = await h.module.currentMonitor();
  assert.equal(current.scaleFactor, 1);
  assert.deepEqual(current.position, new PhysicalPosition(-1920, -1080));
  assert.deepEqual(current.workArea.position, new PhysicalPosition(-1920, -1055));
  assert.deepEqual(current.workArea.size, new PhysicalSize(1920, 1000));
  assert.deepEqual((await h.module.primaryMonitor()).workArea.position, new PhysicalPosition(0, 25));
  h.geometry.monitor = null;
  assert.equal(await h.module.currentMonitor(), null);
});

test('macOS resizes remain logical and DPI notifications cannot inject a physical scale into drag caches', async () => {
  const h = harness();
  for (const value of [new LogicalSize(400.5, 600.5), new PhysicalSize(200, 300), new Size(new PhysicalSize(250, 350))]) {
    await h.window.setSize(value);
    assert.ok(h.calls.at(-1)[1] instanceof LogicalSize);
    const expected = 'size' in value ? value.size : value;
    assert.equal(h.calls.at(-1)[1].width, expected.width);
    assert.equal(h.calls.at(-1)[1].height, expected.height);
  }
  const events = [];
  const stop = await h.window.onScaleChanged(event => events.push(event));
  h.emitScale(2, 800, 1200); h.emitScale(1, 400, 600);
  for (const event of events) {
    assert.equal(event.payload.scaleFactor, 1);
    assert.deepEqual(event.payload.size, new PhysicalSize(400, 600));
  }
  stop(); assert.equal(h.calls.at(-1)[0], 'unlisten');
});

test('Windows geometry continues to delegate physical coordinates, DPI, size and monitor queries', async () => {
  const h = harness('windows');
  assert.equal(await h.window.scaleFactor(), 1.5);
  assert.deepEqual(await h.window.outerPosition(), new PhysicalPosition(300, 600));
  assert.deepEqual(await h.window.innerPosition(), new PhysicalPosition(300, 630));
  assert.deepEqual(await h.window.outerSize(), new PhysicalSize(600, 900));
  assert.equal(await h.module.currentMonitor(), h.nativeMonitor);
  assert.equal(await h.module.primaryMonitor(), h.nativeMonitor);
  const point = new PhysicalPosition(-2500, -300), size = new LogicalSize(600, 800);
  await h.window.setPosition(point); await h.window.setSize(size);
  assert.deepEqual(h.calls, [['position', point], ['size', size]]);
  let event;
  await h.window.onScaleChanged(value => { event = value; });
  h.emitScale(1.5, 600, 900);
  assert.equal(event.payload.scaleFactor, 1.5);
  assert.deepEqual(event.payload.size, new PhysicalSize(600, 900));
});

test('pet always-on-top uses the native/menu synchronization command; unrelated windows retain native behavior', async () => {
  for (const os of ['macos', 'windows']) {
    const h = harness(os);
    await h.window.setAlwaysOnTop(false); await h.window.setAlwaysOnTop(true);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [
      ['set_pet_always_on_top', { enabled: false }], ['set_pet_always_on_top', { enabled: true }],
    ]);
    const auxiliary = harness(os, 'settings');
    await auxiliary.window.setAlwaysOnTop(false);
    assert.deepEqual(auxiliary.calls, [['top', false]]);
  }
});

test('native errors propagate for geometry, moving and top state instead of reporting a successful operation', async () => {
  const h = harness();
  const error = new Error('native window unavailable'); h.fail(error);
  for (const operation of [() => h.window.outerPosition(), () => h.window.innerSize(),
    () => h.module.currentMonitor(), () => h.module.primaryMonitor(),
    () => h.window.setPosition(new PhysicalPosition(1, 2)), () => h.window.setAlwaysOnTop(false)]) {
    await assert.rejects(operation(), value => value === error);
  }
});

test('platform identifies the Tauri build target, not the host/browser user-agent, and reports macOS metrics in CSS points', async () => {
  for (const [kind, target, expected] of [['tauri', 'macos', 'macos'], ['tauri', 'windows', 'windows'],
    ['web', 'macos', 'unknown'], ['android', 'macos', 'unknown']]) {
    const h = harness(target);
    const platform = load('platform', { './desktop-window': h.module }, {
      __DESKTOP_OS__: target, location: { search: `?platform=${kind}` },
      window: {}, navigator: { maxTouchPoints: 0, userAgent: 'Not used for OS detection' },
    });
    assert.equal(platform.desktopOS, expected);
    assert.equal(platform.platform, kind);
    if (kind === 'tauri' && target === 'macos') {
      const metrics = await platform.getWindowMetrics();
      assert.equal(metrics.winX, -1400.5); assert.equal(metrics.winY, -300.25);
      assert.equal(metrics.winW, 400); assert.equal(metrics.density, 1);
      assert.equal(metrics.screenW, 1920);
      await platform.moveWindowBy(20.25, -40.5);
      assert.deepEqual(await h.window.outerPosition(), new PhysicalPosition(-1380.25, -340.75));
    }
  }
});
