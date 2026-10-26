import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMacosConfig } from './macos-config.mjs';

// The runner is injectable so failure paths can be checked without an app build
// or invoking Apple tools on other platforms. Real validation always runs them.
export function validateMacosArtifact(appPath, {
  run = spawnSync,
  architectures = ['arm64', 'x86_64'],
  config = readMacosConfig(),
} = {}) {
  if (!appPath || !appPath.endsWith('.app')) throw new Error('Expected a path ending in .app');
  if (!architectures.length || new Set(architectures).size !== architectures.length
      || architectures.some((arch) => !['arm64', 'x86_64'].includes(arch))) {
    throw new Error('Expected arm64 and/or x86_64 architectures');
  }
  const app = resolve(appPath);
  const invoke = (command, args) => {
    const result = run(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout || result.signal || result.status}`);
    }
    return result;
  };
  const info = JSON.parse(invoke('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist'),
  ]).stdout);
  const minimum = config.bundle.macOS.minimumSystemVersion;
  if (info.LSMinimumSystemVersion !== minimum) {
    throw new Error(`LSMinimumSystemVersion must be ${minimum}, got ${info.LSMinimumSystemVersion}`);
  }
  if (info.CFBundleIdentifier !== config.identifier) throw new Error('CFBundleIdentifier does not match config');
  const executable = info.CFBundleExecutable;
  if (typeof executable !== 'string' || !executable || executable === '.' || executable === '..'
      || basename(executable) !== executable || /[\\\0]/.test(executable)) {
    throw new Error('Invalid CFBundleExecutable');
  }
  const binary = join(app, 'Contents', 'MacOS', executable);
  const actual = invoke('/usr/bin/lipo', ['-archs', binary]).stdout.trim().split(/\s+/).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...architectures].sort())) {
    throw new Error(`Expected architectures ${architectures.join(', ')}, got ${actual.join(', ')}`);
  }
  invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', app]);
  for (const arch of architectures) {
    const signature = invoke('/usr/bin/codesign', ['--display', '--verbose=4', '--architecture', arch, app]);
    if (!/^Signature=adhoc\s*$/m.test(`${signature.stdout || ''}\n${signature.stderr || ''}`)) {
      throw new Error(`Expected an ad-hoc signature for ${arch}`);
    }
  }
  return { app, binary, architectures: actual, minimumSystemVersion: minimum, signature: 'adhoc' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [app, flag, arch, ...extra] = process.argv.slice(2);
    if (!app || extra.length || (flag !== undefined && (flag !== '--arch' || !['arm64', 'x86_64'].includes(arch)))) {
      throw new Error('Usage: npm run validate:mac -- "path/Aliya Pet.app" [--arch arm64|x86_64] (default: Universal)');
    }
    console.log(JSON.stringify(validateMacosArtifact(app, arch ? { architectures: [arch] } : {}), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
