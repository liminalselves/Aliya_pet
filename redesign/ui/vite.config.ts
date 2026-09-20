import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: 'assets',
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
