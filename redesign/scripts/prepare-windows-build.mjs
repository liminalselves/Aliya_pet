import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cacheSignature = 'Signature: 8a477f597d28d172789f06886806bc55';
const contains = (parent, child) => {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};
const refuse = (target) => {
  throw new Error(`不是独立的 Cargo 构建目录或路径含链接，拒绝修改完整性标签，已停止构建：${target}`);
};

function checkBuildDirectory(target, sources) {
  if (sources.some((source) => contains(target, source))) refuse(target);
  const home = homedir();
  if (['', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'AppData']
    .some((name) => relative(join(home, name), target) === '')) refuse(target);
  // Check from the volume root down: lstat(target) alone follows junction ancestors.
  let current = parse(target).root;
  for (const part of ['', ...relative(current, target).split(sep).filter(Boolean)]) {
    current = join(current, part);
    const item = lstatSync(current, { throwIfNoEntry: false });
    if (!item) return; // The remaining path will be created only after this check.
    if (!item.isDirectory() || item.isSymbolicLink()) refuse(target);
  }

  const entries = readdirSync(target, { withFileTypes: true });
  if (!entries.length) return; // Empty custom CARGO_TARGET_DIR is a valid first build.
  const tag = join(target, 'CACHEDIR.TAG');
  if (!lstatSync(tag, { throwIfNoEntry: false })?.isFile()
    || !readFileSync(tag, 'utf8').startsWith(cacheSignature)) refuse(target);
  const profile = (directory) => {
    const lock = lstatSync(join(directory, '.cargo-lock'), { throwIfNoEntry: false });
    return lock?.isFile() && !lock.isSymbolicLink();
  };
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // The helper also skips these, without reading targets.
    if (entry.isFile() && ['CACHEDIR.TAG', '.rustc_info.json'].includes(entry.name)) continue;
    if (!entry.isDirectory()) refuse(target);
    const directory = join(target, entry.name);
    if (['debug', 'release', 'doc', 'tmp', 'package'].includes(entry.name) || profile(directory)) continue;
    // Cargo --target triples contain profile directories; custom profiles have .cargo-lock.
    const children = readdirSync(directory, { withFileTypes: true });
    if (!children.length || !children.every((child) => child.isDirectory()
      && !child.isSymbolicLink() && profile(join(directory, child.name)))) refuse(target);
  }
}

// Only build outputs are relabeled; source/workspace and ancestor ACLs stay intact.
export function prepareWindowsBuild({
  platform = process.platform,
  cwd = fileURLToPath(new URL('../src-tauri/', import.meta.url)),
  run = spawnSync,
  mkdir = mkdirSync,
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
      if (relative(packageRoot, source) !== '' && contains(source, target)) refuse(target);
      sources.push(source);
    }
  }
  checkBuildDirectory(target, sources);

  mkdir(target, { recursive: true });
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
    const target = prepareWindowsBuild();
    if (target) console.log(`[build] Windows 构建输出：已隔离 Low 继承，子产物不强制降级 (${target})`);
  } catch (error) {
    console.error(`[build] ${error.message}`);
    process.exitCode = 1;
  }
}
