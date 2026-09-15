import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_MSK_ORIGIN = 'https://misskey.liminalselves.top';

function parseOrigin(value = DEFAULT_MSK_ORIGIN) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Misskey URL 无效：${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Misskey URL 必须是仅含协议、主机和可选端口的 HTTP(S) 地址。');
  }
  return url.origin;
}

if (process.argv.length > 3) {
  console.error('用法：npm run dev -- [Misskey URL]');
  process.exit(1);
}

let origin;
try { origin = parseOrigin(process.argv[2]); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }

console.log(`[dev] Misskey: ${origin}`);
const child = spawn('npm', ['run', 'tauri', '--', 'dev'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, VITE_MSK_ORIGIN: origin },
  shell: process.platform === 'win32',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', error => { console.error(`[dev] 无法启动 Tauri：${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
