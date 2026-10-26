import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { mergeConfig, readMacosConfig } from './macos-config.mjs';
import { validateMacosArtifact } from './validate-macos-artifact.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url));
const json = (path) => JSON.parse(read(path));
const common = json('../src-tauri/tauri.conf.json');
const overlay = json('../src-tauri/tauri.macos.conf.json');
const labels = ['pet', 'chat', 'settings', 'records'];

test('merge follows JSON Merge Patch: arrays replace, objects recurse, null deletes; inputs remain intact', () => {
  const base = { app: { windows: [{ label: 'pet' }, { label: 'chat' }], keep: true }, icons: ['old'], remove: 1 };
  const patch = { app: { windows: [{ label: 'replacement' }] }, icons: [], remove: null };
  const before = structuredClone({ base, patch });
  const result = mergeConfig(base, patch);
  assert.deepEqual(result, { app: { windows: [{ label: 'replacement' }], keep: true }, icons: [] });
  result.app.windows[0].label = 'mutated';
  assert.deepEqual({ base, patch }, before);
  assert.deepEqual(mergeConfig({ a: 1 }, [1, 2]), [1, 2]);
  assert.deepEqual(mergeConfig(['old'], { a: 1 }), { a: 1 });
  assert.equal(mergeConfig({ a: 1 }, null), null);
});

test('macOS merged configuration retains all four full windows and applies only platform packaging', () => {
  const config = readMacosConfig();
  assert.deepEqual(config.app.windows.map(({ label }) => label), labels);
  assert.deepEqual(config.app.windows, common.app.windows);
  assert.equal(Object.hasOwn(overlay.app ?? {}, 'windows'), false, 'A partial windows array would discard other windows');
  assert.equal(config.app.macOSPrivateApi, true);
  assert.equal(config.bundle.macOS.minimumSystemVersion, '14.4');
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.deepEqual(config.bundle.targets, ['app', 'dmg']);
  assert.deepEqual(config.bundle.icon, ['icons/icon.icns', 'icons/icon.png']);
  assert.deepEqual(config.build, common.build);
  for (const icon of config.bundle.icon) assert.ok(existsSync(new URL(`../src-tauri/${icon}`, import.meta.url)), icon);
});

test('common/Windows config keeps installer targets, ICO resources, hooks and window behavior', () => {
  assert.equal(common.app.macOSPrivateApi, true, 'Tauri 2.11 checks common Cargo features against this macOS-only option');
  assert.deepEqual(common.bundle.macOS, { minimumSystemVersion: '14.4', signingIdentity: '-' });
  assert.equal(common.bundle.active, true);
  assert.equal(common.bundle.targets, 'all');
  assert.deepEqual(new Set(common.bundle.icon), new Set(['icons/tray.ico', 'icons/icon.png', 'icons/icon.icns']));
  assert.deepEqual(common.bundle.windows, {
    nsis: { installerIcon: 'icons/tray.ico', uninstallerIcon: 'icons/tray.ico', languages: ['SimpChinese'] },
    wix: { language: 'zh-CN' },
  });
  assert.deepEqual(common.app.windows.map(({ label }) => label), labels);
  for (const window of common.app.windows.slice(0, 2)) {
    for (const flag of ['transparent', 'alwaysOnTop', 'skipTaskbar', 'acceptFirstMouse']) assert.equal(window[flag], true);
    for (const flag of ['decorations', 'resizable', 'shadow', 'focus']) assert.equal(window[flag], false);
  }
  assert.equal(common.app.windows[0].visible ?? true, true);
  for (const window of common.app.windows.slice(1)) {
    assert.equal(window.visible, false);
    assert.equal(window.url, `${window.label}.html`);
  }
  for (const window of common.app.windows.slice(2)) assert.equal(window.resizable, true);
  for (const hook of [common.build.beforeBuildCommand, common.build.beforeDevCommand]) {
    assert.equal(hook.cwd, '../ui');
    assert.match(hook.script, /^node \.\.\/scripts\/prepare-windows-build\.mjs && npm run /);
  }
  const ico = read('../src-tauri/icons/tray.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) > 0);
});

// Decode real pixel data, not just PNG headers: opaque/empty template icons
// otherwise appear to pass a dimensions-only check. No image dependency needed.
function decodeRgbaPng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = [];
  let header;
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    assert.ok(offset + 12 <= bytes.length, 'truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + 12 + length <= bytes.length, 'truncated PNG data');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { assert.equal(header, undefined); header = data; }
    if (type === 'IDAT') chunks.push(data);
    offset += 12 + length;
    if (type === 'IEND') { assert.equal(offset, bytes.length); ended = true; break; }
  }
  assert.ok(ended && header && chunks.length, 'PNG needs IHDR, IDAT and IEND');
  assert.equal(header.length, 13);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.ok(width > 0 && width <= 1024 && height > 0 && height <= 1024);
  assert.deepEqual([...header.subarray(8)], [8, 6, 0, 0, 0], '8-bit RGBA, standard compression/filter, no interlace');
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return distances[0] <= distances[1] && distances[0] <= distances[2] ? a : distances[1] <= distances[2] ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4, 'valid PNG row filter');
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? pixels[index - 4] : 0;
      const up = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[index - stride - 4] : 0;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      pixels[index] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return { width, height, pixels };
}

function assertAlpha(image) {
  const alpha = image.pixels.filter((_, index) => index % 4 === 3);
  assert.ok(alpha.includes(0), 'transparent pixels');
  assert.ok(alpha.includes(255), 'opaque pixels');
  assert.ok(alpha.some((value) => value > 0 && value < 255), 'antialiased pixels');
  assert.equal(alpha[0], 0, 'transparent corner');
}

test('app PNG is 256px RGBA with transparent padding and visible artwork', () => {
  const image = decodeRgbaPng(read('../src-tauri/icons/icon.png'));
  assert.equal(image.width, 256);
  assert.equal(image.height, 256);
  assertAlpha(image);
  assert.ok(image.pixels.some((value, index) => index % 4 !== 3 && value > 0));
});

test('template PNGs are 18pt at 1x/2x, black RGBA masks with clear A counter and crossbar', () => {
  for (const [name, size] of [['tray-template.png', 18], ['tray-template@2x.png', 36]]) {
    const image = decodeRgbaPng(read(`../src-tauri/icons/${name}`));
    assert.equal(image.width, size);
    assert.equal(image.height, size);
    assertAlpha(image);
    assert.ok(image.pixels.every((value, index) => index % 4 === 3 || value === 0), 'template uses alpha, not color');
    const alphaAt = (x, y) => image.pixels[(Math.floor(y * size / 18) * size + Math.floor(x * size / 18)) * 4 + 3];
    assert.ok(alphaAt(9, 8) < 20, 'A counter stays clear');
    assert.ok(alphaAt(9, 11) > 240, 'A crossbar remains visible');
    assert.ok(alphaAt(4, 14) > 200, 'A leg remains visible');
    assert.ok(alphaAt(9, 15) < 20, 'space between legs stays clear');
  }
});

test('ICNS includes full-size and Retina RGBA images through 1024px with alpha', () => {
  const bytes = read('../src-tauri/icons/icon.icns');
  assert.equal(bytes.toString('ascii', 0, 4), 'icns');
  assert.equal(bytes.readUInt32BE(4), bytes.length);
  const sizes = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
    ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
  const seen = new Set();
  for (let offset = 8; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length);
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= bytes.length, `ICNS chunk ${type}`);
    if (Object.hasOwn(sizes, type)) {
      assert.ok(!seen.has(type), `unique ICNS chunk ${type}`);
      const image = decodeRgbaPng(bytes.subarray(offset + 8, offset + length));
      assert.equal(image.width, sizes[type], type);
      assert.equal(image.height, sizes[type], type);
      assertAlpha(image);
      seen.add(type);
    }
    offset += length;
  }
  for (const type of ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) assert.ok(seen.has(type), type);
});

test('Apple iconutil decodes all ten standard and Retina ICNS representations', { skip: process.platform !== 'darwin' }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'aliya-macos-icon-test-'));
  try {
    const iconset = join(temporary, 'icon.iconset');
    const result = spawnSync('/usr/bin/iconutil', ['--convert', 'iconset', '--output', iconset,
      fileURLToPath(new URL('../src-tauri/icons/icon.icns', import.meta.url))], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const image = decodeRgbaPng(readFileSync(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)));
        assert.equal(image.width, size * scale);
        assert.equal(image.height, size * scale);
        assertAlpha(image);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('build script watches all macOS resources and retains Windows ICO', () => {
  const script = read('../src-tauri/build.rs').toString();
  for (const file of ['tray.ico', 'icon.png', 'icon.icns', 'tray-template.png', 'tray-template@2x.png']) {
    assert.ok(script.includes(`"icons/${file}"`), file);
  }
  assert.match(script, /tauri_build::build\(\)/);
  const scripts = json('../package.json').scripts;
  assert.match(scripts['build:mac'], /--target universal-apple-darwin/);
  assert.equal(scripts['test:mac'], 'node --test scripts/macos-packaging.test.mjs');
});

function harness({ info = {}, archs = 'x86_64 arm64\n', signatures = ['Signature=adhoc\n', 'Signature=adhoc\n'] } = {}) {
  const calls = [];
  const results = [
    { status: 0, stdout: JSON.stringify({ LSMinimumSystemVersion: '14.4',
      CFBundleIdentifier: common.identifier, CFBundleExecutable: 'aliya-pet', ...info }) },
    { status: 0, stdout: archs },
    { status: 0 },
    ...signatures.map((stderr) => ({ status: 0, stderr })),
  ];
  const run = (...args) => { calls.push(args); assert.ok(results.length, 'unexpected command'); return results.shift(); };
  return { calls, results, run };
}

test('artifact validator reads the plist executable and checks both architectures/signatures with shell-safe paths', () => {
  const { calls, run } = harness({ info: { CFBundleExecutable: 'renamed executable' } });
  const app = resolve('build with spaces', 'Aliya Pet.app');
  const binary = join(app, 'Contents', 'MacOS', 'renamed executable');
  assert.deepEqual(validateMacosArtifact(app, { run }), {
    app, binary, architectures: ['arm64', 'x86_64'], minimumSystemVersion: '14.4', signature: 'adhoc',
  });
  assert.deepEqual(calls.map(([command, args]) => [command, args]), [
    ['/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]],
    ['/usr/bin/lipo', ['-archs', binary]],
    ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', app]],
    ...['arm64', 'x86_64'].map((arch) => ['/usr/bin/codesign', ['--display', '--verbose=4', '--architecture', arch, app]]),
  ]);
  assert.ok(calls.every(([, , options]) => options.encoding === 'utf8' && !options.shell));
});

test('native artifacts require an explicit architecture and cannot pass Universal validation', () => {
  for (const arch of ['arm64', 'x86_64']) {
    assert.throws(() => validateMacosArtifact('Aliya Pet.app', harness({ archs: arch })), /Expected architectures/);
    const { run, calls } = harness({ archs: arch });
    assert.deepEqual(validateMacosArtifact('Aliya Pet.app', { run, architectures: [arch] }).architectures, [arch]);
    assert.equal(calls.length, 4);
  }
  for (const archs of ['', 'arm64 x86_64 i386', 'arm64 arm64']) {
    assert.throws(() => validateMacosArtifact('Aliya Pet.app', harness({ archs })), /Expected architectures/);
  }
});

test('artifact validator rejects wrong minimum, identifier and invalid executable before inspecting binary', () => {
  for (const info of [{ LSMinimumSystemVersion: undefined }, { LSMinimumSystemVersion: '14.3' },
    { LSMinimumSystemVersion: '15.0' }, { CFBundleIdentifier: 'other.app' },
    ...['', '..', '../outside', '/absolute', 'windows\\path', null].map((CFBundleExecutable) => ({ CFBundleExecutable }))]) {
    const { run, calls } = harness({ info });
    assert.throws(() => validateMacosArtifact('Aliya Pet.app', { run }));
    assert.equal(calls.length, 1);
  }
});

test('artifact validator fails on command errors, invalid JSON, tampered signatures and non-ad-hoc signatures', () => {
  for (let index = 0; index < 5; index++) {
    for (const failure of [{ status: 1, stderr: 'verification failure' },
      { status: null, error: new Error('tool missing') }, { status: null, signal: 'SIGTERM' }]) {
      const { results, run, calls } = harness();
      results[index] = failure;
      assert.throws(() => validateMacosArtifact('Aliya Pet.app', { run }), /failed/);
      assert.equal(calls.length, index + 1);
    }
  }
  const invalid = harness();
  invalid.results[0].stdout = 'not JSON';
  assert.throws(() => validateMacosArtifact('Aliya Pet.app', invalid), SyntaxError);
  for (const signatures of [['Authority=Developer ID Application: Example\n'],
    ['Signature=adhoc\n', ''], ['Signature=adhoc-invalid\n']]) {
    assert.throws(() => validateMacosArtifact('Aliya Pet.app', harness({ signatures })), /Expected an ad-hoc signature/);
  }
  assert.throws(() => validateMacosArtifact('app.dmg'), /Expected a path/);
  assert.throws(() => validateMacosArtifact('app.app', { architectures: ['i386'] }), /Expected arm64/);
});
