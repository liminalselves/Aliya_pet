import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cacheSignature = 'Signature: 8a477f597d28d172789f06886806bc55';
const contains = (parent, child) => {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};
const refuse = (target, reason, recoverable = false) => {
  const recovery = recoverable
    ? '\n可在仓库根目录显式运行 node redesign/scripts/prepare-windows-build.mjs --backup-cache，将默认 target 完整移入同级 target-backup-* 目录后重建；不会删除旧文件。自定义 CARGO_TARGET_DIR 不支持此备份操作，请另选新的空目录。'
    : '';
  throw new Error(`${reason}；拒绝修改完整性标签，已停止构建：${target}${recovery}`);
};

function isRegularFile(path) {
  const item = lstatSync(path, { throwIfNoEntry: false });
  return item?.isFile() && !item.isSymbolicLink();
}

function hasCargoBuildArtifacts(target, entries) {
  if (!entries.some((entry) => entry.name === '.rustc_info.json' && entry.isFile() && !entry.isSymbolicLink())) return false;
  return entries.some((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    if (['debug', 'release', 'doc', 'tmp', 'package'].includes(entry.name)) {
      return isRegularFile(join(target, entry.name, '.cargo-lock'));
    }
    const triple = join(target, entry.name);
    const profiles = readdirSync(triple, { withFileTypes: true });
    return profiles.some((profile) => profile.isDirectory() && !profile.isSymbolicLink()
      && isRegularFile(join(triple, profile.name, '.cargo-lock')));
  });
}

function checkBuildPath(target, sources) {
  const source = sources.find((source) => contains(target, source));
  if (source) refuse(target, `构建目录包含源码或工作区：${source}`);
  const home = homedir();
  if (['', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'AppData']
    .some((name) => relative(join(home, name), target) === '')) refuse(target, '构建目录指向受保护的用户目录');
  // Check from the volume root down: lstat(target) alone follows junction ancestors.
  let current = parse(target).root;
  for (const part of ['', ...relative(current, target).split(sep).filter(Boolean)]) {
    current = join(current, part);
    const item = lstatSync(current, { throwIfNoEntry: false });
    if (!item) return; // The remaining path will be created only after this check.
    if (item.isSymbolicLink()) refuse(target, `路径包含符号链接或 junction：${current}`);
    if (!item.isDirectory()) refuse(target, `路径组件不是目录：${current}`);
  }
}

function checkBuildDirectory(target) {
  if (!lstatSync(target, { throwIfNoEntry: false })) return;
  const entries = readdirSync(target, { withFileTypes: true });
  if (!entries.length) return; // Empty custom CARGO_TARGET_DIR is a valid first build.
  const tag = join(target, 'CACHEDIR.TAG');
  const tagEntry = lstatSync(tag, { throwIfNoEntry: false });
  if (tagEntry) {
    if (tagEntry.isSymbolicLink()) refuse(target, `缓存标签是链接：${tag}`, true);
    if (!tagEntry.isFile()) refuse(target, `缓存标签不是普通文件：${tag}`, true);
    if (!readFileSync(tag, 'utf8').startsWith(cacheSignature)) refuse(target, `缓存标签签名无效：${tag}`, true);
  } else if (!hasCargoBuildArtifacts(target, entries)) {
    refuse(target, `缺少 CACHEDIR.TAG，且未同时找到 .rustc_info.json 与 Cargo profile 的 .cargo-lock：${target}`, true);
  }
  const profile = (directory) => {
    const lock = lstatSync(join(directory, '.cargo-lock'), { throwIfNoEntry: false });
    return lock?.isFile() && !lock.isSymbolicLink();
  };
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // The helper also skips these, without reading targets.
    if (entry.isFile() && ['CACHEDIR.TAG', '.rustc_info.json'].includes(entry.name)) continue;
    if (!entry.isDirectory()) refuse(target, `构建目录存在非预期文件：${join(target, entry.name)}`, true);
    const directory = join(target, entry.name);
    if (['debug', 'release', 'doc', 'tmp', 'package'].includes(entry.name) || profile(directory)) continue;
    // Cargo --target triples contain profile directories; custom profiles have .cargo-lock.
    const children = readdirSync(directory, { withFileTypes: true });
    if (!children.length) refuse(target, `非预期的空目录（无法识别 Cargo profile 或 target triple）：${directory}`, true);
    for (const child of children) {
      const childPath = join(directory, child.name);
      if (!child.isDirectory() || child.isSymbolicLink() || !profile(childPath)) {
        refuse(target, `target triple 子项不是带普通 .cargo-lock 的 profile 目录：${childPath}`, true);
      }
    }
  }
  // Only mark recognizable legacy caches after the entire structure passes validation.
  if (!tagEntry) writeFileSync(tag, `${cacheSignature}\n`, { flag: 'wx' });
}

// Only build outputs are relabeled; source/workspace and ancestor ACLs stay intact.
export function prepareWindowsBuild({
  platform = process.platform,
  cwd = fileURLToPath(new URL('../src-tauri/', import.meta.url)),
  run = spawnSync,
  mkdir = mkdirSync,
  backupCache = false,
  report = console.log,
} = {}) {
  if (platform !== 'win32') return null;

  const metadata = run('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  if (metadata.error || metadata.status !== 0) {
    throw new Error(`无法查询 Cargo 构建目录：${metadata.error?.message || metadata.stderr || metadata.stdout || metadata.status}`);
  }
  const { target_directory: targetDirectory, workspace_root: workspaceRoot, packages = [] } = JSON.parse(metadata.stdout);
  if (typeof targetDirectory !== 'string' || !isAbsolute(targetDirectory)
    || typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) {
    throw new Error('Cargo 未返回有效的绝对构建目录。');
  }
  const target = resolve(targetDirectory);
  const sources = [resolve(workspaceRoot), resolve(cwd)];
  for (const pkg of packages) {
    const packageRoot = dirname(resolve(pkg.manifest_path));
    sources.push(packageRoot);
    for (const entry of pkg.targets || []) {
      if (typeof entry.src_path !== 'string') continue;
      const source = dirname(resolve(entry.src_path));
      if (relative(packageRoot, source) !== '' && contains(source, target)) refuse(target, `构建目录位于源码目录内：${source}`);
      sources.push(source);
    }
  }
  checkBuildPath(target, sources);
  if (backupCache) {
    if (relative(resolve(cwd, 'target'), target) !== '') {
      refuse(target, '--backup-cache 仅允许备份当前项目默认的 target 目录，不会移动自定义 Cargo 输出');
    }
    if (lstatSync(target, { throwIfNoEntry: false }) && readdirSync(target).length) {
      // A freshly reserved sibling container prevents overwriting any previous backup.
      const container = mkdtempSync(`${target}-backup-`);
      const backup = join(container, 'target');
      renameSync(target, backup);
      report(`[build] 旧 Cargo 缓存已完整备份（未删除文件）：${backup}`);
    }
  }
  checkBuildDirectory(target);

  mkdir(target, { recursive: true });
  // Mark an empty target before Cargo populates it; Cargo omits this marker on Windows.
  if (lstatSync(target, { throwIfNoEntry: false }) && readdirSync(target).length === 0) {
    writeFileSync(join(target, 'CACHEDIR.TAG'), `${cacheSignature}\n`, { flag: 'wx' });
  }
  // Block Low only at the root; child executables must retain normal launch integrity.
  const helper = fileURLToPath(new URL('./prepare-windows-build.ps1', import.meta.url));
  const result = run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helper, '-TargetDirectory', target,
  ], {
    cwd, stdio: 'inherit', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`无法清理构建输出的强制完整性标签，已停止构建：${result.error?.message || result.status}。请在普通用户终端构建，或检查构建目录的权限；不会自动提权。`);
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--backup-cache') || args.length > 1) {
      throw new Error('用法：node redesign/scripts/prepare-windows-build.mjs [--backup-cache]；备份为显式操作，不会删除旧文件。');
    }
    const target = prepareWindowsBuild({ backupCache: args.includes('--backup-cache') });
    if (target) console.log(`[build] Windows 构建输出：已隔离 Low 继承，子产物不强制降级 (${target})`);
  } catch (error) {
    console.error(`[build] ${error.message}`);
    process.exitCode = 1;
  }
}
