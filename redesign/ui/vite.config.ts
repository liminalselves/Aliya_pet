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
        bubble: path.resolve(__dirname, 'bubble.html'),
        update: path.resolve(__dirname, 'update.html'),
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
