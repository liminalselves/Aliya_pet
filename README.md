# Aliya Pet

基于 Live2D Cubism 的桌面宠物（**Windows / Android 双端**）。

当前实现为重写版（`redesign/`）：**共享 Web 内核 + 双端薄壳**。

- **Windows**：Tauri 壳 + 官方 Cubism Web SDK（WebGL 渲染）
- **Android**：Kotlin 薄壳 + 系统 WebView（同一份 Web 前端，悬浮窗桌宠）

官方渲染链路（SDK 官方支持、随 Live2D 长期维护）取代了旧版自研 C++ 渲染内核，
之前最常见的性能与卡顿问题基本消除。旧版实现保留在 `flutter/` 与 `native/` 作参考。

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

## 快速开始

### Windows

```bash
cd redesign
npm install                # 首次
# 开发运行（带 CDP 调试端口）：
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev
```

打包安装版：`cd redesign/ui && npm run build && cd .. && npm run tauri build`
（详见 `docs/BUILD.md`，含 SDK 依赖准备。）

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
│   └── assets/live2d/aliya/   # 模型 + 动作（当前为官方示例占位动作）
├── src-tauri/            # Windows 壳（Rust）：窗口/托盘/自启/设置子窗口
├── android/              # Android 壳（Kotlin）：Activity/悬浮窗服务/桥
└── tools/                # 开发调试脚本（CDP 检查/截屏/CPU 测量）

flutter/                  # 旧版 Flutter 实现（已弃用，保留参考）
native/                   # 旧版自研 C++ 渲染内核（已弃用，保留参考）
third_party/              # Live2D SDK（许可限制，不入库）
scripts/                  # 旧版构建/验证脚本
```

## 文档

- `docs/ARCHITECTURE.md` — 架构、渲染/布局算法、平台适配与双端差异
- `docs/BUILD.md` — Windows / Android 构建、依赖与调试工具
- `docs/ANDROID.md` — Android 壳设计（悬浮窗/前台服务/JS 桥/权限）
- `docs/ACTIONS.md` — 动作接入指南（替换占位动作 + 余量重新测量）

## 说明

- **动作库**：当前 9 个动作是官方示例（Hiyori）的占位文件，Aliya 真动作导出后
  直接替换同名文件即可（见 `docs/ACTIONS.md`）。
- **二创声明**：本程序为二创桌宠，人物原创为《彼方的她》。
