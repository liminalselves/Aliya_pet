import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8'));

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
        main: path.resolve(import.meta.dirname, 'index.html'),
        settings: path.resolve(import.meta.dirname, 'settings.html'),
        chat: path.resolve(import.meta.dirname, 'chat.html'),
        records: path.resolve(import.meta.dirname, 'records.html'),
        bubble: path.resolve(import.meta.dirname, 'bubble.html'),
        update: path.resolve(import.meta.dirname, 'update.html'),
        pendant: path.resolve(import.meta.dirname, 'pendant.html'),
      },
    },
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@framework': path.resolve(
        import.meta.dirname,
        '../../third_party/cubism-web-sdk/Framework/src'
      ),
    },
  },
});
