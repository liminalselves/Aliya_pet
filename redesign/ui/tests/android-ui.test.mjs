import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../assets/android-theme.js', import.meta.url), 'utf8');
function theme(search = '', shell) {
  const root = { dataset: {}, style: {} };
  vm.runInNewContext(script, { URLSearchParams, location: { search }, window: { AndroidShell: shell }, document: { documentElement: root } });
  return root;
}
test('Android Activity and overlay select separate surfaces before first paint', () => {
  const activity = theme('', { getMode: () => 'activity' });
  assert.equal(activity.dataset.container, 'activity');
  assert.equal(activity.dataset.platform, 'android');
  assert.equal(activity.style.colorScheme, 'light');
  assert.equal(theme('', { getMode: () => 'overlay' }).dataset.container, 'overlay');
});
test('unknown or failing older Android shells stay transparent', () => {
  for (const shell of [{}, { getMode() { throw new Error('old bridge'); } }, { getMode: () => 'unknown' }]) {
    assert.equal(theme('', shell).dataset.container, 'overlay');
  }
});
test('desktop is unchanged and development preview can select either Android container', () => {
  assert.equal(Object.keys(theme().dataset).length, 0);
  assert.equal(Object.keys(theme('?platform=tauri').dataset).length, 0);
  assert.equal(theme('?platform=android').dataset.container, 'activity');
  assert.equal(theme('?platform=android&mode=overlay').dataset.container, 'overlay');
});
test('every shipped entry includes prepaint theme bootstrap and accessible mobile viewport', () => {
  for (const page of ['index', 'chat', 'settings', 'records']) {
    const html = readFileSync(new URL(`../${page}.html`, import.meta.url), 'utf8');
    assert.ok(html.indexOf('/android-theme.js') < html.indexOf('<body>'), page);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /interactive-widget=resizes-content/);
    assert.doesNotMatch(html, /user-scalable=no/);
  }
});
