import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareWindowsBuild } from './prepare-windows-build.mjs';

const workspace = resolve('test-workspace');
const target = join(workspace, 'target');
const cacheTag = 'Signature: 8a477f597d28d172789f06886806bc55\n';
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

test('Cargo package metadata protects empty source directories and nested workspace members', () => {
  for (const directory of [join(workspace, 'src', 'future-output'), join(workspace, 'member')]) {
    const result = metadata(directory);
    result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), packages: [
      { manifest_path: join(workspace, 'Cargo.toml'), targets: [{ src_path: join(workspace, 'src', 'lib.rs') }] },
      { manifest_path: join(workspace, 'member', 'Cargo.toml'), targets: [] },
    ] });
    const { calls, options } = harness([result]);
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
    writeFileSync(join(output, 'CACHEDIR.TAG'), cacheTag);
    writeFileSync(join(output, 'cached', '.cargo-lock'), '');
    const parentBefore = icacls(join(fixture, 'low-parent'));
    const rootDacl = dacl(icacls(output));
    const cached = join(output, 'cached', 'old.exe');
    writeFileSync(cached, 'old cache fixture');
    icacls(cached, '/setintegritylevel', 'M');
    const beforeDacl = dacl(icacls(cached));
    const beforeMtime = statSync(cached).mtimeMs;
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
    assert.equal(dacl(icacls(output)), rootDacl);
    assert.equal(icacls(join(fixture, 'low-parent')), parentBefore);
    assert.equal(statSync(cached).mtimeMs, beforeMtime);
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

test('Windows refuses ordinary non-build directories and source subdirectories without touching their labels', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aliya-build-scope-test-'));
  try {
    const source = join(fixture, 'workspace');
    mkdirSync(source);
    for (const directory of [join(fixture, 'ordinary-user-files'), join(source, 'src')]) {
      mkdirSync(directory, { recursive: true });
      const file = join(directory, 'keep.txt');
      writeFileSync(file, 'not a build output');
      const beforeMtime = statSync(file).mtimeMs;
      const before = spawnSync('icacls.exe', [file], { encoding: 'utf8' });
      assert.equal(before.status, 0);
      const run = (command, args, options) => command === 'cargo'
        ? { status: 0, stdout: JSON.stringify({ target_directory: directory, workspace_root: source }) }
        : spawnSync(command, args, options);
      assert.throws(() => prepareWindowsBuild({ cwd: source, run }), /拒绝修改完整性标签/);
      assert.equal(spawnSync('icacls.exe', [file], { encoding: 'utf8' }).stdout, before.stdout);
      assert.equal(readFileSync(file, 'utf8'), 'not a build output');
      assert.equal(statSync(file).mtimeMs, beforeMtime);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Windows refuses a junction ancestor before mkdir or relabeling its external target', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aliya-build-junction-test-'));
  try {
    const external = join(fixture, 'external');
    mkdirSync(external);
    const link = join(fixture, 'linked-parent');
    symlinkSync(external, link, 'junction');
    const directory = join(link, 'must-not-be-created');
    const run = (command, args, options) => command === 'cargo' ? metadata(directory) : spawnSync(command, args, options);
    assert.throws(() => prepareWindowsBuild({ run }), /拒绝修改完整性标签/);
    assert.throws(() => readFileSync(join(external, 'must-not-be-created')), { code: 'ENOENT' });
    const existing = join(external, 'existing-output');
    mkdirSync(existing);
    const before = spawnSync('icacls.exe', [existing], { encoding: 'utf8' });
    assert.equal(before.status, 0);
    const direct = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(new URL('./prepare-windows-build.ps1', import.meta.url)),
      '-TargetDirectory', join(link, 'existing-output')], { encoding: 'utf8' });
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /no link ancestors/);
    assert.equal(spawnSync('icacls.exe', [existing], { encoding: 'utf8' }).stdout, before.stdout);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Windows does not relabel directory or file symlinks and rejects symlink roots', { skip: process.platform !== 'win32' }, (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'aliya-build-symlink-test-'));
  try {
    const output = join(fixture, 'output');
    const external = join(fixture, 'external');
    mkdirSync(output);
    mkdirSync(external);
    writeFileSync(join(output, 'CACHEDIR.TAG'), cacheTag);
    const file = join(external, 'keep.txt');
    writeFileSync(file, 'external symlink fixture');
    try {
      symlinkSync(external, join(output, 'directory-link'), 'dir');
      symlinkSync(file, join(output, 'file-link'), 'file');
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('Creating symlinks requires Windows developer mode or privilege');
      throw error;
    }
    const before = spawnSync('icacls.exe', [file], { encoding: 'utf8' });
    assert.equal(before.status, 0);
    const run = (command, args, options) => command === 'cargo' ? metadata(output) : spawnSync(command, args, options);
    assert.equal(prepareWindowsBuild({ run }), output);
    assert.equal(spawnSync('icacls.exe', [file], { encoding: 'utf8' }).stdout, before.stdout);
    const rootRun = (command, args, options) => command === 'cargo'
      ? metadata(join(output, 'directory-link')) : spawnSync(command, args, options);
    assert.throws(() => prepareWindowsBuild({ run: rootRun }), /拒绝修改完整性标签/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Windows preserves real Cargo custom output paths for first builds, caches and custom profiles', { skip: process.platform !== 'win32' }, (t) => {
  if (spawnSync('cargo', ['--version']).error?.code === 'ENOENT') return t.skip('Cargo is not installed');
  const fixture = mkdtempSync(join(tmpdir(), 'aliya-build-cargo-test-'));
  try {
    const source = join(fixture, 'workspace');
    mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'Cargo.toml'), '[package]\nname = "build_scope_fixture"\nversion = "0.0.0"\nedition = "2021"\n');
    writeFileSync(join(source, 'src', 'lib.rs'), 'pub fn fixture() {}\n');
    writeFileSync(join(source, 'build.rs'), 'fn main() {}\n');
    const sourceBefore = statSync(join(source, 'src', 'lib.rs')).mtimeMs;
    for (const state of ['missing', 'empty', 'cache']) {
      const custom = join(fixture, `custom output ${state}`);
      if (state !== 'missing') mkdirSync(custom);
      if (state === 'cache') {
        writeFileSync(join(custom, 'CACHEDIR.TAG'), cacheTag);
        writeFileSync(join(custom, '.rustc_info.json'), '{}');
        for (const profile of ['debug', 'custom-profile', join('x86_64-pc-windows-msvc', 'custom-profile')]) {
          mkdirSync(join(custom, profile), { recursive: true });
          writeFileSync(join(custom, profile, '.cargo-lock'), '');
        }
      }
      const run = (command, args, options) => spawnSync(command,
        command === 'cargo' ? [...args, '--offline'] : args,
        { ...options, env: { ...process.env, CARGO_TARGET_DIR: custom } });
      assert.equal(prepareWindowsBuild({ cwd: source, run }), custom);
      assert.equal(statSync(join(source, 'src', 'lib.rs')).mtimeMs, sourceBefore);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Windows label handles reject deterministic post-check root and child junction swaps', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aliya-build-race-test-'));
  try {
    const script = join(fixture, 'swap.ps1');
    writeFileSync(script, `param([string]$Helper, [string]$Output, [string]$External, [string]$Mode)
$ErrorActionPreference = 'Stop'
$global:AliyaRaceSwapped = $false
$global:AliyaRaceOutput = $Output
$global:AliyaRaceExternal = $External
$global:AliyaRaceMode = $Mode
$pattern = switch ($Mode) {
  'root' { '::OpenRoot\\(|^& icacls.exe' }
  'pinned-root' { '::BlockLow\\(|^& icacls.exe' }
  'child' { '::Clear\\(' }
}
$line = @(Select-String -LiteralPath $Helper -Pattern $pattern)[0].LineNumber
$breakpoint = Set-PSBreakpoint -Script $Helper -Line $line -Action {
  if (!$global:AliyaRaceSwapped -and ($global:AliyaRaceMode -ne 'child' -or $item.Name -eq 'debug')) {
    $global:AliyaRaceSwapped = $true
    $path = if ($global:AliyaRaceMode -eq 'child') { Join-Path $global:AliyaRaceOutput 'debug' } else { $global:AliyaRaceOutput }
    try { Move-Item -LiteralPath $path -Destination ($path + '-before') -ErrorAction Stop }
    catch {
      if ($global:AliyaRaceMode -ne 'pinned-root') { throw }
      Write-Output '[race] root replacement blocked by held handle'
      return
    }
    New-Item -ItemType Junction -Path $path -Target $global:AliyaRaceExternal | Out-Null
  }
}
try { & $Helper -TargetDirectory $Output }
catch { Write-Output ('[race] visible failure: ' + $_.Exception.Message) }
finally { Remove-PSBreakpoint $breakpoint }
if (!$global:AliyaRaceSwapped) { throw 'The post-check replacement was not exercised.' }
`);
    for (const mode of ['root', 'pinned-root', 'child']) {
      const output = join(fixture, `output-${mode}`);
      const external = join(fixture, `external-${mode}`);
      mkdirSync(join(output, 'debug'), { recursive: true });
      mkdirSync(external);
      writeFileSync(join(output, 'CACHEDIR.TAG'), cacheTag);
      writeFileSync(join(output, 'debug', '.cargo-lock'), '');
      const label = spawnSync('icacls.exe', [external, '/setintegritylevel', 'L'], { encoding: 'utf8' });
      assert.equal(label.status, 0, label.stderr || label.stdout);
      const before = spawnSync('icacls.exe', [external], { encoding: 'utf8' }).stdout;
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Helper', fileURLToPath(new URL('./prepare-windows-build.ps1', import.meta.url)),
        '-Output', output, '-External', external, '-Mode', mode], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      if (mode !== 'pinned-root' || !result.stdout.includes('root replacement blocked by held handle')) {
        assert.match(result.stdout, /visible failure/);
        if (mode === 'pinned-root') {
          // Windows may allow a directory rename despite its open handle. Label the held
          // original object, never the junction substituted at its former name.
          assert.match(spawnSync('icacls.exe', [output + '-before'], { encoding: 'utf8' }).stdout, /\(NW\)/);
        }
      }
      assert.equal(spawnSync('icacls.exe', [external], { encoding: 'utf8' }).stdout, before, mode);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Windows refuses to relabel a multiply-linked output instead of changing an external file', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aliya-build-hardlink-test-'));
  try {
    const output = join(fixture, 'output');
    mkdirSync(join(output, 'debug'), { recursive: true });
    writeFileSync(join(output, 'CACHEDIR.TAG'), cacheTag);
    const external = join(fixture, 'external.exe');
    writeFileSync(external, 'external hardlink fixture');
    assert.equal(spawnSync('icacls.exe', [external, '/setintegritylevel', 'L'], { encoding: 'utf8' }).status, 0);
    linkSync(external, join(output, 'debug', 'linked.exe'));
    const before = spawnSync('icacls.exe', [external], { encoding: 'utf8' }).stdout;
    const beforeMtime = statSync(external).mtimeMs;
    const run = (command, args, options) => command === 'cargo' ? metadata(output) : spawnSync(command, args, options);
    assert.throws(() => prepareWindowsBuild({ run }), /已停止构建/);
    assert.equal(spawnSync('icacls.exe', [external], { encoding: 'utf8' }).stdout, before);
    assert.equal(statSync(external).mtimeMs, beforeMtime);
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
