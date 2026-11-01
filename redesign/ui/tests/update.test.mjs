/** 更新模块纯逻辑测试：版本比较、提示决策（跳过/稍后/强制）、markdown 安全渲染、服务回退。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function transpile(name, replacements = []) {
  let source = readFileSync(new URL(`../src/update/${name}.ts`, import.meta.url), 'utf8');
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
}

function makeStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}

/** 每个用例加载全新模块实例（跳过/稍后是模块级状态，不能跨用例复用）。 */
function loadCheck({ bases, storage } = {}) {
  const configCode = transpile('config', [['import.meta.env.VITE_UPDATE_BASES', 'configuredBases']]);
  const configExports = {};
  vm.runInNewContext(configCode, { exports: configExports, configuredBases: bases });
  const checkCode = transpile('check');
  const checkExports = {};
  vm.runInNewContext(checkCode, {
    exports: checkExports,
    require: () => configExports,
    localStorage: storage ?? makeStorage(),
    setTimeout,
    clearTimeout,
    AbortController,
  });
  return { config: configExports, check: checkExports };
}

const UPDATE = (over = {}) => ({
  updateAvailable: true,
  mandatory: false,
  current: '0.1.0',
  latest: '0.2.0',
  ...over,
});

test('version compare: numeric segments, missing parts, v-prefix, non-numeric', () => {
  const { compareVersions, isNewer } = loadCheck().check;
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1', '0.1.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('v0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0-beta', '0.1.0'), 0); // 非数字段按 0
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
});

test('decision: no update or same version never prompts', () => {
  const { shouldPromptUpdate } = loadCheck().check;
  assert.equal(shouldPromptUpdate(UPDATE({ updateAvailable: false, latest: '0.1.0' })), false);
  assert.equal(shouldPromptUpdate(UPDATE({ updateAvailable: true, latest: '0.1.0' })), false);
});

test('decision: skipped version is suppressed until a newer one appears', () => {
  const storage = makeStorage();
  const { check } = loadCheck({ storage });
  check.skipVersion('0.2.0');
  assert.equal(check.shouldPromptUpdate(UPDATE()), false, '跳过的版本不再提示');
  assert.equal(check.shouldPromptUpdate(UPDATE({ latest: '0.3.0' })), true, '出现更新版本后恢复提示');
  assert.equal(storage.getItem('aliya_pet_update_skip'), '0.2.0');
});

test('decision: mandatory overrides skip and defer; later defers for this launch', () => {
  const skipped = makeStorage();
  const { check } = loadCheck({ storage: skipped });
  check.skipVersion('0.2.0');
  check.deferUpdateForLaunch();
  assert.equal(check.shouldPromptUpdate(UPDATE({ mandatory: true })), true, '强制更新无视抑制');
  const fresh = loadCheck().check;
  assert.equal(fresh.shouldPromptUpdate(UPDATE()), true, '未抑制时提示');
  fresh.deferUpdateForLaunch();
  assert.equal(fresh.shouldPromptUpdate(UPDATE()), false, '稍后=本次启动不再提醒');
  assert.equal(fresh.shouldPromptUpdate(UPDATE({ updateAvailable: false })), false);
});

test('markdown: escape first, then headings / bullets / bold / code / paragraphs', () => {
  const code = transpile('markdown');
  const exports = {};
  vm.runInNewContext(code, { exports });
  const { renderUpdateNotes } = exports;
  const html = renderUpdateNotes(
    '# 标题\n' +
      '包含 <script>alert(1)</script> 与 & 和 **加粗** 及 `code`\n' +
      '\n' +
      '## 次级\n' +
      '- 第一项 **重点**\n' +
      '* 第二项 <img src=x onerror=1>\n' +
      '\n' +
      '### 三级\n' +
      '第二段第一行\n' +
      '第二段第二行\n'
  );
  assert.ok(!html.includes('<script>') && !html.includes('<img'), '原始 HTML 必须被转义');
  assert.ok(html.includes('&lt;script&gt;'), '标签转义为实体');
  assert.ok(html.includes('&amp;'), '与号转义');
  assert.ok(/<h3>标题<\/h3>/.test(html), '# 映射 h3');
  assert.ok(/<h4>次级<\/h4>/.test(html), '## 映射 h4');
  assert.ok(/<h5>三级<\/h5>/.test(html), '### 映射 h5');
  assert.ok(/<ul><li>第一项 <strong>重点<\/strong><\/li><li>第二项 /.test(html), '- 与 * 都进列表');
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'), '列表项内标签同样转义');
  assert.ok(html.includes('<strong>加粗</strong>'), '** 加粗');
  assert.ok(html.includes('<code>code</code>'), '行内代码');
  assert.ok(/第二段第一行<br>第二段第二行/.test(html), '段内换行保留为 br');
});

function jsonResponse(data, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}

test('service client: first base wins, non-2xx and bad payloads fall through', async () => {
  const { check } = loadCheck({ bases: 'https://a.example, https://b.example' });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://a.example')) return jsonResponse({ updateAvailable: false, mandatory: false, current: '0.1.0', latest: '0.1.0' });
    throw new Error('should not reach base b');
  };
  const result = await check.checkForUpdate('windows', '0.1.0', { fetchImpl });
  assert.equal(result.updateAvailable, false);
  assert.equal(calls.length, 1);

  calls.length = 0;
  const fetch500 = async (url) => {
    calls.push(url);
    return url.startsWith('https://a.example') ? jsonResponse({}, 500) : jsonResponse(UPDATE());
  };
  const fell = await check.checkForUpdate('windows', '0.1.0', { fetchImpl: fetch500 });
  assert.equal(fell.latest, '0.2.0', '非 2xx 回退到下一个 base');
  assert.equal(calls.length, 2);

  calls.length = 0;
  const fetchBad = async (url) => {
    calls.push(url);
    return url.startsWith('https://a.example') ? jsonResponse({ hello: 1 }) : jsonResponse(UPDATE());
  };
  const recovered = await check.checkForUpdate('android', '0.1.0', { fetchImpl: fetchBad });
  assert.equal(recovered.latest, '0.2.0', '非法载荷视作失败并回退');
  assert.equal(calls.length, 2);
});

test('service client: timeout aborts the base and moves on; all failures reject', async () => {
  const { check } = loadCheck({ bases: 'https://slow.example, https://ok.example' });
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const fetchImpl = async (url, init) => (url.startsWith('https://slow.example') ? hang(url, init) : jsonResponse(UPDATE()));
  const result = await check.checkForUpdate('windows', '0.1.0', { fetchImpl, timeoutMs: 10 });
  assert.equal(result.latest, '0.2.0', '超时后落到下一个 base');

  await assert.rejects(
    () => check.checkForUpdate('windows', '0.1.0', { fetchImpl: async () => { throw new Error('offline'); } }),
    (error) => error instanceof check.UpdateCheckError,
    '全部 base 失败抛 UpdateCheckError'
  );
});

test('config: bases parsing trims, drops trailing slashes, falls back to default', () => {
  const load = (raw) => {
    const configExports = {};
    const code = transpile('config', [['import.meta.env.VITE_UPDATE_BASES', 'configuredBases']]);
    vm.runInNewContext(code, { exports: configExports, configuredBases: raw });
    // 展开回本 realm 数组，避免跨 context 原型导致 deepEqual 误判
    return [...configExports.UPDATE_SERVICE_BASES];
  };
  assert.deepEqual(load(undefined), ['https://aliyapet.liminalselves.top'], '默认内置列表');
  assert.deepEqual(load(' http://127.0.0.1:8787/ ,, https://b.example '), ['http://127.0.0.1:8787', 'https://b.example']);
  assert.deepEqual(load('not-a-url'), ['https://aliyapet.liminalselves.top'], '无有效项回退默认');
  assert.equal(load('http://127.0.0.1:8787')[0], 'http://127.0.0.1:8787');
});
