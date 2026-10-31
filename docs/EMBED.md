# 网页嵌入

官网首页展示的 Aliya 运行的是本体代码：同一套 Live2D 渲染、物理、视线、表情、动作、点击与抚摸互动、台词，以网页嵌入构建的形式放进官网（liminalselves/official-site 的 `public/pet/`）。

## 构建

```powershell
cd redesign/ui
npm run build:embed          # 产物在 ui/dist-embed/
```

- 入口是 `ui/embed.html`，它和 `index.html` 使用同一个 `main.ts`，只多设置一个 `window.__ALIYA_EMBED__ = true`。
- 构建配置在 `ui/vite.embed.config.ts`：
  - 资源根路径默认是 `/pet/`，可以用环境变量 `EMBED_BASE` 改。
  - 只构建嵌入入口。
  - 去掉完整字体、未使用的 1024 贴图和应用图标。
- 构建完成后会运行 `scripts/subset-embed-font.py`。它只保留台词里实际用到的字，生成约 150 KB 的衬线字体，并改写产物里的 `@font-face`。
- 所有资源路径都经过 `ui/src/embed.ts` 的 `assetUrl()`，嵌入产物可以放在任意子目录下。新增资源时，路径也要经过它。

## 嵌入模式的差异

开关是 `ui/src/embed.ts` 里的 `isEmbed`，改动分散在 `pet-app.ts` 和 `main.ts`。

| 行为 | 应用 | 嵌入网页 |
| --- | --- | --- |
| 聊天 | 有 | 不初始化（需要登录，留在应用里） |
| 拖动 | 移动窗口 | 无（整页没有窗口可拖），左键按下按点击处理 |
| 抚摸 | 右键按住头部往返，触屏在头部往返 | 左键或触屏在头部往返 |
| 设置 | 读写本机存档 | 固定使用默认设置，开启闲聊，间隔 1 分钟 |
| 视线 | 跟随全局光标 | 跟随舞台内的指针，以及父页面转发的光标位置 |
| 启动 | 恢复窗口与设置 | 首帧上屏后按时段问候并挥手 |
| 暂停 | 后台或熄屏时 | 另外在舞台滚出视口时 |
| 触屏 | `touch-action: none` | `pan-y`，竖向滑动用来滚动页面 |
| 启动失败 | 页面内显示提示 | 通知父页面，由父页面继续显示静态图 |

## 与父页面通信

两个方向都用 `postMessage`。

- 嵌入页发给父页面：`{ source: 'aliya-pet', type: 'ready' | 'error', detail? }`
- 父页面发给嵌入页：
  - `{ source: 'aliya-pet-host', type: 'look', x, y }`：坐标是嵌入页 iframe 内的 client 坐标。
  - `{ source: 'aliya-pet-host', type: 'leave' }`：光标离开页面，视线回正。

## 更新到官网

模型、动作、台词或互动逻辑有改动后，执行：

```powershell
cd redesign/ui; npm run build:embed
cd <official-site>; node scripts/sync-pet-embed.mjs <Aliya_pet>/redesign/ui/dist-embed
```

同步脚本会把贴图转成无损 WebP（像素不变，体积约减半），然后把产物整体替换 `public/pet/`。

许可：Cubism Core 按 `third_party/cubism-web-sdk/Core/RedistributableFiles.txt` 中允许的文件分发，见 `THIRD_PARTY_NOTICES.md`。
