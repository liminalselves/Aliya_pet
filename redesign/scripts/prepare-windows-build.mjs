import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const { target_directory: targetDirectory, workspace_root: workspaceRoot } = JSON.parse(metadata.stdout);
  if (typeof targetDirectory !== 'string' || !isAbsolute(targetDirectory)
    || typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) {
    throw new Error('Cargo 未返回有效的绝对构建目录。');
  }
  const target = resolve(targetDirectory);
  const source = relative(target, resolve(workspaceRoot));
  if (!isAbsolute(source) && source !== '..' && !source.startsWith(`..${sep}`)) {
    throw new Error(`构建目录不能是源码目录或其祖先目录，拒绝修改完整性标签：${target}`);
  }

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
