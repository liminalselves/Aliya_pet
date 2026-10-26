import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: 'assets',
  define: {
    // 构建期注入版本号，唯一来源为 ui/package.json（设置页「关于」展示）
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Tauri sets the target even for cross builds; standalone UI builds use the host.
    __DESKTOP_OS__: JSON.stringify(process.env.TAURI_ENV_PLATFORM ??
      (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform)),
  },
  server: {
    port: 5175,
    strictPort: true,
  },
  build: {
    target: 'baseline-widely-available',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        settings: path.resolve(__dirname, 'settings.html'),
        chat: path.resolve(__dirname, 'chat.html'),
        records: path.resolve(__dirname, 'records.html'),
      },
    },
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@framework': path.resolve(
        __dirname,
        '../../third_party/cubism-web-sdk/Framework/src'
      ),
    },
  },
});
