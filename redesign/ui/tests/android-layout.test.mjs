// Real Chromium layout regression, no browser-library dependency. Starts an isolated
// Vite server unless ALIYA_UI_URL is provided. ALIYA_BROWSER selects Chrome/Edge.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const browserPath = process.env.ALIYA_BROWSER || (process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '/usr/bin/chromium');
let base = process.env.ALIYA_UI_URL;

test('Android production pages survive phone widths, worst-case content and reduced motion', {
  skip: !existsSync(browserPath) && 'set ALIYA_BROWSER to an installed Chrome/Edge executable', timeout: 90000,
}, async t => {
  if (!base) {
    const allocator = createServer();
    await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
    const port = allocator.address().port;
    await new Promise(resolve => allocator.close(resolve));
    base = `http://127.0.0.1:${port}`;
    const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'ignore' });
    t.after(() => vite.kill());
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* waiting for our server */ }
      await delay(100);
    }
    assert.ok(ready, 'isolated Vite server must start');
  }
  assert.equal(await (await fetch(`${base}/android-theme.js`)).text(), readFileSync(new URL('../assets/android-theme.js', import.meta.url), 'utf8'), 'dev server must serve this checkout');
  const profile = mkdtempSync(path.join(tmpdir(), 'aliya-android-ui-'));
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  let socket;
  t.after(async () => {
    socket?.close();
    browser.kill();
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]);
    // Only this test's mkdtemp profile is removed; never use a human browser profile.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await delay(100); }
  }
  assert.ok(port, 'headless browser must start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  }
  async function js(expression) {
    const value = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.text + JSON.stringify(value.exceptionDetails.exception));
    return value.result.value;
  }
  async function waitFor(expression) {
    for (let i = 0; i < 150; i++) { if (await js(expression)) return; await delay(50); }
    throw new Error(`page did not settle: ${expression}`);
  }
  async function navigate(page, width = 390, height = 844) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await cdp('Page.navigate', { url: `${base}/${page}` });
    await waitFor(`location.href === ${JSON.stringify(`${base}/${page}`)} && document.readyState === 'complete'`);
  }
  async function capture(suffix = '') {
    if (!process.env.ALIYA_SCREENSHOT) return;
    const file = path.parse(process.env.ALIYA_SCREENSHOT);
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(file.dir, `${file.name}${suffix}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });

  for (const width of [320, 390, 768]) {
    await navigate('settings.html?platform=android', width);
    await waitFor('document.querySelectorAll(".card").length > 3');
    assert.equal(await js('getComputedStyle(document.body).backgroundColor'), 'rgb(248, 246, 252)');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, `settings overflow at ${width}`);
    assert.equal(await js('[...document.querySelectorAll(".sw input")].every(e => e.getAttribute("aria-label") && getComputedStyle(e).display !== "none")'), true);
    if (width === 390) await capture('-settings');
    // Long unbroken labels, CJK/emoji and 200% type, using only this test profile.
    await js(`document.querySelector('.label').firstChild.textContent = '很长的设置名称👩🏽‍💻'.repeat(12); document.body.style.fontSize = '32px'; document.querySelectorAll('.sub').forEach(e => e.style.fontSize = '26px')`);
    assert.equal(await js('document.querySelector("#app").scrollWidth <= innerWidth'), true, `large-text settings overflow at ${width}`);
    assert.equal(await js('[...document.querySelectorAll(".sw")].every(e => e.getBoundingClientRect().height >= 44)'), true);
  }
  await navigate('settings.html?platform=android');
  await waitFor('document.querySelector(".sw input")');
  const saved = await js(`(() => { const e = document.querySelector('.sw input'); e.click(); return { checked: e.checked, stored: localStorage.getItem('aliya_pet_settings_v1') }; })()`);
  assert.ok(saved.stored, 'a switch persists settings');
  await js('window.__beforeReload = true');
  await cdp('Page.reload');
  await waitFor('!window.__beforeReload && document.querySelector(".sw input")');
  assert.equal(await js('document.querySelector(".sw input").checked'), saved.checked);

  await navigate('records.html?platform=android', 320);
  await waitFor('document.querySelector(".records-list")');
  await js(`(() => {
    const list = document.querySelector('.records-list'); list.replaceChildren();
    for (let i = 0; i < 1000; i++) {
      const item = document.createElement('article'); item.className = 'record-message' + (i % 2 ? ' record-user' : '');
      item.innerHTML = '<header><strong>Aliya👩🏽‍💻</strong><time>23:59</time><button class="record-replay">重新播放</button></header><div class="message-text"></div>';
      item.lastElementChild.textContent = i % 3 ? 'https://example.com/' + 'unbroken'.repeat(80) : '你好 مرحبا 👩🏽‍💻'.repeat(100);
      list.append(item);
    }
    document.querySelector('.records-title').textContent = '很长的会话标题'.repeat(30);
    document.querySelector('.records-meta').textContent = '1000000000 条消息';
  })()`);
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth && document.querySelector(".records-list").scrollWidth <= innerWidth'), true, 'records worst-case width');
  assert.equal(await js('getComputedStyle(document.querySelector(".record-replay")).opacity'), '1');
  assert.equal(await js('document.querySelector(".records-list").scrollHeight > document.querySelector(".records-list").clientHeight'), true);

  await navigate('index.html?platform=android', 320);
  await waitFor('window.__pet && document.querySelector(".gal-panel")');
  assert.equal(await js('getComputedStyle(document.body).backgroundColor'), 'rgb(248, 246, 252)');
  assert.equal(await js('getComputedStyle(document.querySelector(".android-home-heading")).display'), 'block', JSON.stringify(await js('({dataset:{...document.documentElement.dataset},width:innerWidth,height:innerHeight,body:document.body.className})')));
  assert.equal(await js('document.querySelector(".gal-panel").getBoundingClientRect().height <= innerHeight * .7'), true, 'setup must leave visible room for the character');
  // Use the actual production controller/view with a local stub provider; no remote API.
  await js(`(async () => {
    const { ChatController } = await import('/src/chat/controller.ts');
    const { ChatView } = await import('/src/chat/view.ts');
    document.querySelector('#chat-ui').remove();
    const controller = new ChatController({ label: 'local test', async *reply() { yield '本地测试回复'; } });
    const auth = { token: null, resumeCallback: async () => false, validateSaved: async () => {}, savedUser: () => null };
    const view = new ChatView(controller, auth, () => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    view.screen = 'ready'; view.input.disabled = false; view.setOpen(true);
    window.__androidTestView = view;
  })()`);
  await waitFor('document.querySelector(".chat-composer:not([hidden])")');
  for (const [width, height] of [[320, 640], [390, 844], [390, 380], [768, 540]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await js('window.dispatchEvent(new Event("resize"))');
    await delay(100);
    assert.equal(await js('getComputedStyle(document.querySelector(".android-home-heading")).display'), height <= 480 ? 'none' : 'block', `caption adapts to keyboard-height viewport ${width}x${height}`);
    assert.equal(await js('document.querySelector(".chat-composer").scrollWidth <= innerWidth'), true, `composer overflow ${width}x${height}`);
    assert.equal(await js('[...document.querySelectorAll(".composer-toolbar button")].filter(e=>!e.hidden).every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})'), true, `touch controls visible ${width}x${height}`);
  }
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await js('getComputedStyle(document.querySelector(".chat-composer")).animationName'), 'none');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await js('window.dispatchEvent(new Event("resize"))');
  await delay(100);
  await capture();
  await navigate('index.html?platform=android&mode=overlay');
  await waitFor('document.querySelector("canvas")');
  assert.equal(await js('getComputedStyle(document.documentElement).backgroundColor'), 'rgba(0, 0, 0, 0)');
  assert.equal(await js('getComputedStyle(document.body).backgroundColor'), 'rgba(0, 0, 0, 0)');
  assert.equal(await js('getComputedStyle(document.querySelector(".android-home-heading")).display'), 'none');
  await navigate('settings.html');
  await waitFor('document.querySelector(".card")');
  assert.equal(await js('getComputedStyle(document.body).backgroundColor'), 'rgb(27, 20, 18)', 'desktop keeps its dark palette');
});
