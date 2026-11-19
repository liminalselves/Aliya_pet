/** 设置页模块化分组导航与外部路由目标解析测试。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadNavigation() {
  const source = readFileSync(new URL('../src/settings/navigation.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports });
  return exports;
}

test('getSettingsTabs 返回固定顺序，首项为表演，并按平台区分窗口/悬浮窗文案', () => {
  const { DEFAULT_SETTINGS_TAB, getSettingsTabs } = loadNavigation();
  assert.equal(DEFAULT_SETTINGS_TAB, 'stage');

  const desktopTabs = getSettingsTabs('tauri');
  assert.deepEqual(
    Array.from(desktopTabs, (t) => t.id),
    ['stage', 'character', 'window', 'chat', 'about']
  );
  assert.equal(desktopTabs[0].label, '表演');
  assert.equal(desktopTabs[2].label, '窗口');

  const webTabs = getSettingsTabs('web');
  assert.equal(webTabs[2].label, '窗口');

  const androidTabs = getSettingsTabs('android');
  assert.deepEqual(
    Array.from(androidTabs, (t) => t.id),
    ['stage', 'character', 'window', 'chat', 'about']
  );
  assert.equal(androidTabs[2].label, '悬浮窗');
  assert.equal(androidTabs[2].title, '悬浮窗');

  for (const list of [desktopTabs, webTabs, androidTabs]) {
    for (const tab of list) {
      assert.ok(tab.label.trim().length > 0);
      assert.ok(tab.title.trim().length > 0);
      assert.ok(tab.description.trim().length > 0);
    }
  }
});

test('resolveOpenTarget 正确映射外部唤醒 target 与 URL hash', () => {
  const { resolveOpenTarget } = loadNavigation();

  for (const emptyOrDefault of ['', '  ', null, undefined, 'main', 'unknown', '#main']) {
    assert.deepEqual(
      { ...resolveOpenTarget(emptyOrDefault) },
      { tab: 'stage', openSessionControl: false }
    );
  }

  assert.deepEqual(
    { ...resolveOpenTarget('about') },
    { tab: 'about', openSessionControl: false }
  );
  assert.deepEqual(
    { ...resolveOpenTarget('#ABOUT ') },
    { tab: 'about', openSessionControl: false }
  );

  assert.deepEqual(
    { ...resolveOpenTarget('session-control') },
    { tab: 'chat', openSessionControl: true }
  );
  assert.deepEqual(
    { ...resolveOpenTarget('#session-control') },
    { tab: 'chat', openSessionControl: true }
  );

  for (const id of ['stage', 'character', 'window', 'chat']) {
    assert.deepEqual(
      { ...resolveOpenTarget(id) },
      { tab: id, openSessionControl: false }
    );
    assert.deepEqual(
      { ...resolveOpenTarget(`#${id}`) },
      { tab: id, openSessionControl: false }
    );
  }
});

test('isValidSettingsTab 与 isExplicitOpenTarget 区分通用唤醒与显式页签目标', () => {
  const { isValidSettingsTab, isExplicitOpenTarget } = loadNavigation();
  for (const id of ['stage', 'character', 'window', 'chat', 'about']) {
    assert.equal(isValidSettingsTab(id), true);
    assert.equal(isExplicitOpenTarget(id), true);
    assert.equal(isExplicitOpenTarget(`#${id}`), true);
  }
  assert.equal(isExplicitOpenTarget('session-control'), true);
  assert.equal(isExplicitOpenTarget('#session-control'), true);
  for (const generic of ['', '  ', null, undefined, 'main', '#main', 'unknown']) {
    assert.equal(isValidSettingsTab(generic), false);
    assert.equal(isExplicitOpenTarget(generic), false);
  }
});
