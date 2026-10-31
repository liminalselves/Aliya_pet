import { defineConfig, mergeConfig, type Plugin } from 'vite';
import fs from 'fs';
import path from 'path';
import base from './vite.config';

/**
 * 网页嵌入构建（docs/EMBED.md）：只出 embed.html，资源路径相对 EMBED_BASE（默认 /pet/），
 * 产物整目录拷到官网 public/pet/。
 */

// publicDir 整体复制后删掉网页用不到的大文件：完整字体（27MB，子集已够用）、未引用的 1024 贴图、应用图标。
const UNUSED = ['fonts/NotoSerifSC-var.ttf', 'live2d/aliya/16.1024', 'icon.png'];

function pruneUnused(): Plugin {
  let outDir = '';
  return {
    name: 'aliya-embed-prune',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      for (const rel of UNUSED) fs.rmSync(path.resolve(__dirname, outDir, rel), { recursive: true, force: true });
    },
  };
}

const config = mergeConfig(base, defineConfig({
  base: process.env.EMBED_BASE ?? '/pet/',
  plugins: [pruneUnused()],
  build: { outDir: 'dist-embed' },
}), false);
// mergeConfig 会合并 input 对象，这里整体替换，只构建嵌入入口。
config.build.rollupOptions = { input: { embed: path.resolve(__dirname, 'embed.html') } };

export default config;
