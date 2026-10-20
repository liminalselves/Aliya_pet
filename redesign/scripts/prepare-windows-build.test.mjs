import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { prepareWindowsBuild } from './prepare-windows-build.mjs';

const workspace = resolve('test-workspace');
const target = join(workspace, 'target');
const metadata = (directory = target) => ({
  status: 0,
  stdout: JSON.stringify({ target_directory: directory, workspace_root: workspace }),
});

function harness(results = [metadata(), { status: 0 }]) {
  const calls = [];
  const options = {
    platform: 'win32', cwd: workspace,
    mkdir: (...args) => calls.push(['mkdir', ...args]),
    run: (...args) => { calls.push(args); return results.shift(); },
  };
  return { calls, options };
}

test('non-Windows builds do not invoke Cargo or modify labels', () => {
  for (const platform of ['linux', 'darwin']) {
    const { calls, options } = harness();
    assert.equal(prepareWindowsBuild({ ...options, platform }), null);
    assert.deepEqual(calls, []);
  }
});

test('creates and relabels only the actual Cargo output tree, including old caches', () => {
  const { calls, options } = harness();
  assert.equal(prepareWindowsBuild(options), target);
  assert.deepEqual(calls[0].slice(0, 2), ['cargo', ['metadata', '--no-deps', '--format-version', '1']]);
  assert.equal(calls[0][2].cwd, workspace);
  assert.deepEqual(calls[1], ['mkdir', target, { recursive: true }]);
  assert.equal(calls[2][0], 'powershell.exe');
  assert.deepEqual(calls[2][1].slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(calls[2][1][6], /prepare-windows-build\.ps1$/);
  assert.deepEqual(calls[2][1].slice(7), ['-TargetDirectory', target]);
  assert.equal(calls[2][2].stdio, 'inherit');
});

test('respects a custom target directory returned by Cargo instead of guessing it', () => {
  const custom = resolve('shared-build-cache');
  const { calls, options } = harness([metadata(custom), { status: 0 }]);
  assert.equal(prepareWindowsBuild(options), custom);
  assert.equal(calls[1][1], custom);
  assert.equal(calls[2][1].at(-1), custom);
});

test('Cargo failures and invalid metadata stop before creating or relabeling outputs', () => {
  const badResults = [
    { status: 1, stderr: 'metadata failed' },
    { status: null, error: new Error('cargo missing') },
    { status: 0, stdout: 'invalid JSON' },
    { status: 0, stdout: '{}' },
    metadata('relative-output'),
  ];
  for (const result of badResults) {
    const { calls, options } = harness([result]);
    assert.throws(() => prepareWindowsBuild(options));
    assert.equal(calls.length, 1);
  }
});

test('refuses to relabel the source directory or its ancestors', () => {
  for (const directory of [workspace, dirname(workspace)]) {
    const { calls, options } = harness([metadata(directory)]);
    assert.throws(() => prepareWindowsBuild(options), /拒绝修改完整性标签/);
    assert.equal(calls.length, 1);
  }
});

test('labeling failures stop the build rather than reporting usable outputs', () => {
  for (const failure of [{ status: 1 }, { status: null, error: new Error('access denied') }]) {
    const { options } = harness([metadata(), failure]);
    assert.throws(() => prepareWindowsBuild(options), /已停止构建/);
  }
  const { calls, options } = harness();
  options.mkdir = () => { throw new Error('mkdir denied'); };
  assert.throws(() => prepareWindowsBuild(options), /mkdir denied/);
  assert.equal(calls.length, 1);
});

test('Windows outputs block Low inheritance without forcing child executable integrity or following junctions', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aliya-build-label-test-'));
  const output = join(fixture, 'low-parent', 'target');
  const external = join(fixture, 'external');
  const icacls = (path, ...args) => {
    const result = spawnSync('icacls.exe', [path, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const dacl = (text) => text.split(/\r?\n/).filter((line) => !line.includes('(NW)')).join('\n');
  try {
    mkdirSync(join(fixture, 'low-parent'));
    icacls(join(fixture, 'low-parent'), '/setintegritylevel', '(OI)(CI)L');
    mkdirSync(join(output, 'cached'), { recursive: true });
    const cached = join(output, 'cached', 'old.exe');
    writeFileSync(cached, 'old cache fixture');
    icacls(cached, '/setintegritylevel', 'M');
    const beforeDacl = dacl(icacls(cached));
    mkdirSync(external);
    const externalFile = join(external, 'untouched.exe');
    writeFileSync(externalFile, 'external fixture');
    icacls(externalFile, '/setintegritylevel', 'L');
    const externalBefore = icacls(externalFile);
    symlinkSync(external, join(output, 'external-link'), 'junction');
    const run = (command, args, options) => command === 'cargo' ? metadata(output) : spawnSync(command, args, options);
    assert.equal(prepareWindowsBuild({ cwd: process.cwd(), run }), output);
    assert.match(icacls(output), /\(NW\)/);
    assert.doesNotMatch(icacls(output), /\(OI\)\(CI\)\(NW\)/);
    const cachedAcl = icacls(cached);
    assert.doesNotMatch(cachedAcl, /\(NW\)/);
    assert.equal(dacl(cachedAcl), beforeDacl);
    assert.doesNotMatch(icacls(join(output, 'cached')), /\(NW\)/);
    mkdirSync(join(output, 'fresh'));
    const fresh = join(output, 'fresh', 'new.exe');
    writeFileSync(fresh, 'new output fixture');
    assert.doesNotMatch(icacls(fresh), /\(NW\)/);
    assert.equal(icacls(externalFile), externalBefore);
    assert.throws(() => prepareWindowsBuild({ cwd: process.cwd(), run: (command, args, options) => command === 'cargo' ? metadata(join(output, 'external-link')) : spawnSync(command, args, options) }), /已停止构建/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Tauri build and dev both run preparation before starting their frontend command', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  for (const hook of [config.build.beforeBuildCommand, config.build.beforeDevCommand]) {
    assert.equal(hook.cwd, '../ui');
    assert.match(hook.script, /^node \.\.\/scripts\/prepare-windows-build\.mjs && npm run /);
  }
});
