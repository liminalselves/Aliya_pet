# Aliya Pet

基于 Live2D Cubism 的桌面宠物（**Windows / Android 双端**）。

当前实现为重写版（`redesign/`）：**共享 Web 内核 + 双端薄壳**。

- **Windows**：Tauri 壳 + 官方 Cubism Web SDK（WebGL 渲染）
- **Android**：Kotlin 薄壳 + 系统 WebView（同一份 Web 前端，悬浮窗桌宠）

官方渲染链路（SDK 官方支持、随 Live2D 长期维护）取代了旧版自研 C++ 渲染内核
（Flutter 版与 native/ 内核已移除，历史可在 git 中追溯），之前最常见的性能与
卡顿问题基本消除。

```
        全部功能与渲染（一套 TypeScript，redesign/ui/）
   ┌──────────────────────────────────────────────────┐
   │ 官方 Cubism Web SDK + 互动/行为/对话/设置           │  <- 95% 代码，双端共用
   └────────────────┬───────────────────┬─────────────┘
             Windows 薄壳          Android 薄壳
          redesign/src-tauri/   redesign/android/
            （Tauri/Rust）        （Kotlin + WebView）
```

## 功能

- 抚摸（手势识别：水平往返/速度/方向反转 + 抚摸台词 + 闭眼）
- 点击互动（区域反应：头/脸/耳朵、连续点击疑惑、快速拖动反应）
- 对话系统（分页气泡、时间段问候、洗牌袋抽取、随机台词）
- 视线跟随、自动随机动作、每日互动状态
- Windows：透明无边框置顶窗口、托盘菜单、贴边吸附、镜像、开机自启
- Android：App 内全屏互动 → 退后台转悬浮窗、省电模式（15fps）、开机自启
- 聊天（Misskey 智能体）：GAL 式分页回复、表演指令驱动表情动作、
  记录/会话/托管配置抽屉——双端同功能（Windows 独立窗口，Android 内嵌）

## 快速开始

### Windows

```bash
cd redesign
npm install                # 首次
# 开发运行；不传参数时连接默认远程 Misskey：
npm run dev
# 临时连接指定实例：
npm run dev -- http://127.0.0.1:3000
# 如需 CDP 调试端口：
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run dev
```

打包安装版：`cd redesign && npm run build`。Tauri 会先自动构建共享前端，
默认连接 `https://misskey.liminalselves.top`（详见 `docs/BUILD.md`，含 SDK 依赖准备）。

### Android

```bash
cd redesign/ui && npm run build     # 产出共享前端 dist
cd ../android && gradlew.bat assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> 国内网络需走阿里云镜像（已内置在 `android/settings.gradle.kts`）。

## 项目结构

```
redesign/                 # 重写版（当前主产品）
├── ui/                   # 共享 Web 前端（TypeScript + Vite）
│   ├── src/
│   │   ├── platform.ts   # 平台适配层（tauri / android / 浏览器）
│   │   ├── pet-app.ts    # 应用外壳：渲染循环/指针接线/窗口
│   │   ├── pet-model.ts  # 模型：动作/物理/眨眼/呼吸/视线/互动通道
│   │   ├── interaction/  # 抚摸状态机、程序式反应、连点/拖动
│   │   ├── dialogue/     # 台词分页/播放/气泡
│   │   ├── behavior.ts   # 自动动作、随机台词、视线跟随
│   │   └── settings.ts   # 设置存储（localStorage）
│   └── assets/live2d/aliya/   # 模型 + 动作（自编动作，tools/gen-motions.py 生成）
├── src-tauri/            # Windows 壳（Rust）：窗口/托盘/自启/设置子窗口
├── android/              # Android 壳（Kotlin）：Activity/悬浮窗服务/桥
└── tools/                # 开发调试脚本（CDP 检查/截屏/CPU 测量）

third_party/cubism-web-sdk/  # Live2D Cubism Web SDK（Framework + Core，官方包）
```

## 文档

- `docs/ARCHITECTURE.md` — 架构、渲染/布局算法、平台适配与双端差异
- `docs/BUILD.md` — Windows / Android 构建、依赖与调试工具
- `docs/ANDROID.md` — Android 壳设计（悬浮窗/前台服务/JS 桥/权限）
- `docs/ACTIONS.md` — 动作接入指南（自编动作工程约束 + 余量重新测量）
- `docs/MODEL.md` — 模型能力图谱（参数表/物理链/值域坑）
- `docs/AI-API.md` — PetAI 对外接口（表情/情绪/动作/视线 + 事件总线）

## 说明

- **动作库**：9 个动作是为当前 Aliya 模型自编的 motion3.json，由
  `redesign/tools/gen-motions.py` 生成（设计要点与工程约束见 `docs/ACTIONS.md`）。
- **表情与情绪**：12 个 exp3.json 表情（`gen-expressions.py` 生成）+ 情绪
  引擎（心境→默认表情、动作选择加权、自然衰减），经 `window.petAI` 语义
  API 暴露给 AI/自动化（见 `docs/AI-API.md`）；设置窗口有对应的
  「表情与情绪」控制面板（表情预览/情绪切换，与 AI 共享状态源）。
- **二创声明**：本程序为二创桌宠，人物原创为《彼方的她》。
