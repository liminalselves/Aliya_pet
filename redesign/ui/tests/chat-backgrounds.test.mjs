/** 聊天背景场景目录、随时间流转匹配与跨端背景层测试。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);

function createFakeDom() {
  const makeStyle = () => {
    const props = new Map();
    return {
      setProperty: (k, v) => props.set(k, String(v)),
      getPropertyValue: (k) => props.get(k) ?? '',
    };
  };
  const makeClassList = (el) => {
    const set = new Set();
    return {
      add: (...names) => names.forEach((n) => set.add(n)),
      remove: (...names) => names.forEach((n) => set.delete(n)),
      toggle: (name, force) => {
        const on = force !== undefined ? Boolean(force) : !set.has(name);
        if (on) set.add(name);
        else set.delete(name);
        return on;
      },
      contains: (name) => set.has(name),
      toString: () => [...set].join(' '),
    };
  };
  function createEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      parentNode: null,
      attributes: new Map(),
      dataset: {},
      style: makeStyle(),
      _innerHTML: '',
      _className: '',
      classList: null,
      append(...nodes) {
        for (const n of nodes) {
          if (n && typeof n === 'object') {
            n.parentNode = el;
            el.children.push(n);
          }
        }
      },
      prepend(...nodes) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i];
          if (n && typeof n === 'object') {
            n.parentNode = el;
            el.children.unshift(n);
          }
        }
      },
      replaceChildren(...nodes) {
        el.children = [];
        el.append(...nodes);
      },
      remove() {
        if (!el.parentNode) return;
        const idx = el.parentNode.children.indexOf(el);
        if (idx >= 0) el.parentNode.children.splice(idx, 1);
        el.parentNode = null;
      },
      setAttribute(k, v) {
        el.attributes.set(k, String(v));
      },
      getAttribute(k) {
        return el.attributes.get(k) ?? null;
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }),
      decode: async () => {},
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] ?? null;
      },
      querySelectorAll(sel) {
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        const hits = [];
        const walk = (node) => {
          for (const child of node.children ?? []) {
            if (cls && child.classList?.contains(cls)) hits.push(child);
            walk(child);
          }
        };
        walk(el);
        return hits;
      },
      set innerHTML(html) {
        el._innerHTML = String(html);
        const child = createEl('svg');
        child._innerHTML = el._innerHTML;
        el.children = [child];
      },
      get innerHTML() {
        return el._innerHTML;
      },
      get firstElementChild() {
        return el.children[0] ?? null;
      },
      set className(v) {
        el._className = String(v);
        el.classList = makeClassList(el);
        for (const token of el._className.split(/\s+/).filter(Boolean)) {
          el.classList.add(token);
        }
      },
      get className() {
        return el.classList?.toString() ?? el._className;
      },
    };
    el.classList = makeClassList(el);
    return el;
  }

  const body = createEl('body');
  const document = {
    body,
    createElement: (tag) => createEl(tag),
  };
  const windowListeners = new Map();
  const window = {
    innerWidth: 400,
    innerHeight: 800,
    addEventListener(name, fn) {
      windowListeners.set(name, fn);
    },
    removeEventListener(name, fn) {
      if (windowListeners.get(name) === fn) windowListeners.delete(name);
    },
  };
  return { document, window, createEl };
}

function loadModule(relPath, imports = {}, globals = {}) {
  const source = readFileSync(new URL(relPath, root), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (id) => imports[id] ?? {},
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} },
    ...globals,
  });
  return exports;
}

test('CHAT_SCENES 包含动态场景与插画背景，资源文件完整且构建确定', () => {
  const { document } = createFakeDom();
  const scenes = loadModule('src/chat-scenes.ts', {}, { document });

  assert.ok(Array.isArray(scenes.CHAT_SCENES) && scenes.CHAT_SCENES.length >= 9);
  const ids = new Set();
  let animatedCount = 0;
  let illusCount = 0;

  for (const scene of scenes.CHAT_SCENES) {
    assert.ok(scene.id && !ids.has(scene.id), `场景 id 必须唯一: ${scene.id}`);
    ids.add(scene.id);
    assert.ok(scene.name.trim().length > 0);
    if (scene.kind === 'animated') animatedCount++;
    if (scene.kind === 'illustration') {
      illusCount++;
      assert.ok(scene.imageUrl?.startsWith('/backgrounds/'));
      const diskPath = new URL(`assets${scene.imageUrl}`, root);
      assert.equal(existsSync(diskPath), true, `缺少背景插画资源: ${diskPath}`);
    }
    const elA = scene.build();
    const elB = scene.build();
    assert.ok(elA.classList.contains('bg-scene'));
    assert.equal(elA.getAttribute('aria-hidden'), 'true');
    assert.equal(elA.children.length, elB.children.length, `${scene.id} 伪随机构建应稳定`);
  }

  assert.equal(animatedCount, 5);
  assert.equal(illusCount, 4);
  for (const expected of ['starry', 'moon-window', 'ripple', 'eternal-dusk', 'snowfall-moon', 'illus-cabin', 'illus-greenhouse', 'illus-spaceport', 'illus-moonsea']) {
    assert.ok(ids.has(expected), `应包含场景 ${expected}`);
  }
  assert.equal(ids.has('otter-bridge'), false);
  assert.equal(ids.has('firefly-garden'), false);
});

test('resolveAutoScene 与 resolveChatScene 按时段边界准确切换', () => {
  const { document } = createFakeDom();
  const scenes = loadModule('src/chat-scenes.ts', {}, { document });

  const at = (h, m) => new Date(2026, 0, 1, h, m, 0);
  const cases = [
    [4, 59, 'deep_night', 'illus-moonsea'],
    [5, 0, 'morning', 'illus-spaceport'],
    [8, 59, 'morning', 'illus-spaceport'],
    [9, 0, 'day', 'illus-greenhouse'],
    [16, 59, 'day', 'illus-greenhouse'],
    [17, 0, 'dusk', 'eternal-dusk'],
    [19, 59, 'dusk', 'eternal-dusk'],
    [20, 0, 'night', 'illus-cabin'],
    [22, 59, 'night', 'illus-cabin'],
    [23, 0, 'deep_night', 'illus-moonsea'],
    [2, 15, 'deep_night', 'illus-moonsea'],
  ];

  for (const [h, m, expectedPeriod, expectedScene] of cases) {
    const match = scenes.resolveAutoScene(at(h, m));
    assert.equal(match.periodId, expectedPeriod, `${h}:${m} 时段匹配`);
    assert.equal(match.scene.id, expectedScene, `${h}:${m} 场景匹配`);
    assert.equal(scenes.resolveChatScene('auto', at(h, m))?.id, expectedScene);
  }

  assert.equal(scenes.resolveChatScene('none'), null);
  assert.equal(scenes.resolveChatScene('custom'), null);
  assert.equal(scenes.resolveChatScene('nonexistent'), null);
  assert.equal(scenes.resolveChatScene('eternal-dusk')?.id, 'eternal-dusk');
});

test('ChatBackgroundLayer 支持多表面挂载、插画解码切换、静止冻结与随时间流转', async () => {
  const { document, window, createEl } = createFakeDom();
  const scenes = loadModule('src/chat-scenes.ts', {}, { document });
  const bg = loadModule(
    'src/chat-background.ts',
    {
      './chat-scenes': scenes,
      './platform': { platform: 'web', isTouchDevice: false },
    },
    { document, window }
  );

  const container = createEl('div');
  const activeEvents = [];
  const layer = new bg.ChatBackgroundLayer({
    container,
    surface: 'records',
    pinViewport: false,
    onActiveChange: (on) => activeEvents.push(on),
  });

  assert.equal(container.children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(container.children[0].dataset.surface, 'records');

  // 动态场景 + 静止切换
  await layer.apply('snowfall-moon', 0.4);
  assert.equal(activeEvents.at(-1), true);
  assert.equal(container.children[0].classList.contains('active'), true);
  layer.setStill(true);
  assert.equal(container.children[0].querySelector('.bg-scene')?.classList.contains('still'), true);

  // 自动流转跨时段更新
  await layer.apply('auto', 0.25, new Date(2026, 0, 1, 18, 0));
  assert.ok(container.children[0].querySelector('.scene-dusk'));
  layer.refreshAuto(new Date(2026, 0, 1, 21, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(container.children[0].querySelector('.scene-illus-cabin'));

  // 插画模式等待 decode 完成且保留静止状态
  await layer.apply('illus-cabin', 0.5);
  const illus = container.children[0].querySelector('.scene-illus');
  assert.ok(illus);
  assert.equal(illus.classList.contains('still'), true);

  // 关闭背景
  await layer.apply('none', 0.35);
  assert.equal(activeEvents.at(-1), false);
  assert.equal(container.children[0].classList.contains('active'), false);
  layer.destroy();
});

test('PetApp 在 Web 舞台与 Android 主界面启用聊天背景，而在嵌入页与悬浮窗不启用', () => {
  const loadPet = (platform, embed) => {
    const calls = [];
    class FakeBg {
      constructor(opts) {
        calls.push({ kind: 'ctor', opts });
      }
      apply(id, dim) {
        calls.push({ kind: 'apply', id, dim });
      }
      setStill(still) {
        calls.push({ kind: 'still', still });
      }
    }
    const { document, window } = createFakeDom();
    const settingsMod = loadModule('src/settings.ts', {}, { localStorage: { getItem: () => null, setItem() {} } });
    const { PetApp } = loadModule(
      'src/pet-app.ts',
      {
        './chat-background': { ChatBackgroundLayer: FakeBg },
        './platform': { platform, isTouchDevice: false, androidShell: () => null, isAndroidOverlay: () => false },
        '@tauri-apps/api/core': { invoke: async () => {} },
        './embed': { isEmbed: embed, assetUrl: (p) => p, postToHost() {} },
        './settings': settingsMod,
      },
      { document, window, performance: { now: () => 0 } }
    );
    const app = Object.assign(Object.create(PetApp.prototype), {
      _wrapWindow: false,
      _settings: { ...settingsMod.DEFAULT_SETTINGS },
      _baseFpsCap: 30,
      _hitAreas: { mirrored: false },
      _canvas: { style: {} },
      _coordination: { activity() {} },
      setFpsCap() {},
      setMirrored() {},
      _applyCatEars() {},
      _syncChatLauncherVisible() {},
      _applyWindowSettingsAndroid() {},
    });
    return { app, calls, defaults: settingsMod.DEFAULT_SETTINGS };
  };

  // Web 非嵌入模式启用
  const web = loadPet('web', false);
  web.app.applySettings({ ...web.defaults, chatBackground: 'eternal-dusk', chatBackgroundDim: 0.45 }, false);
  assert.equal(web.calls.some((c) => c.kind === 'apply' && c.id === 'eternal-dusk' && c.dim === 0.45), true);

  // Web 嵌入页不启用
  const embed = loadPet('web', true);
  embed.app.applySettings({ ...embed.defaults, chatBackground: 'eternal-dusk' }, false);
  assert.equal(embed.calls.length, 0);

  // Android 悬浮窗不启用
  const overlay = loadPet('android', false);
  overlay.app._wrapWindow = true;
  overlay.app.applySettings({ ...overlay.defaults, chatBackground: 'eternal-dusk' }, false);
  assert.equal(overlay.calls.length, 0);

  // Windows 桌面透明桌宠不加载全屏舞台背景（由独立 chat/records 窗口承载）
  const tauri = loadPet('tauri', false);
  tauri.app.applySettings({ ...tauri.defaults, chatBackground: 'eternal-dusk' }, false);
  assert.equal(tauri.calls.length, 0);
});
