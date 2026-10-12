# Aliya Pet

> 基于 Live2D Cubism 的跨平台桌面宠物 · 一套 Web 内核，Windows / Android 双端薄壳

<!-- Badge Row 1: Core Info -->
[![GitHub](https://img.shields.io/badge/GitHub-liminalselves%2FAliya__pet-181717?logo=github&logoColor=white)](https://github.com/liminalselves/Aliya_pet)
[![Version](https://img.shields.io/badge/version-3.0.0-orange)](https://github.com/liminalselves/Aliya_pet/blob/master/CHANGELOG.md)

<!-- Badge Row 2: Platform -->
[![Windows](https://img.shields.io/badge/Windows-10%2B-0078D6?logo=windows&logoColor=white)](https://github.com/liminalselves/Aliya_pet)
[![Android](https://img.shields.io/badge/Android-8.0%2B-3DDC84?logo=android&logoColor=white)](https://github.com/liminalselves/Aliya_pet)

<!-- Badge Row 3: Tech Stack -->
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Kotlin](https://img.shields.io/badge/Kotlin-Android-7F52FF?logo=kotlin&logoColor=white)](https://kotlinlang.org)
[![Live2D Cubism](https://img.shields.io/badge/Live2D%20Cubism-Web%20SDK%205--r.5-FF6F61)](https://www.live2d.com)

## 目录

- [简介](#简介)
- [功能特点](#功能特点)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [技术栈与架构](#技术栈与架构)
- [文档](#文档)
- [动作库与资源](#动作库与资源)
- [许可与声明](#许可与声明)
- [English](#english)

## 简介

Aliya Pet 是一只基于官方 **Live2D Cubism Web SDK** 渲染的桌面宠物，支持 **Windows** 与 **Android** 双端。

当前实现为重写版（`redesign/`），采用「**共享 Web 内核 + 双端薄壳**」架构：渲染、抚摸 / 点击互动、对话、行为与设置等几乎全部逻辑都用 TypeScript 实现一次（`redesign/ui/`）；Windows 用 Tauri（Rust）壳、Android 用 Kotlin 薄壳，两者只负责窗口、托盘、悬浮窗与系统集成等壳层能力。双端共用同一份前端，功能天然对齐，没有两套实现。

官方渲染链路（SDK 官方支持、随 Live2D 长期维护）取代了旧版自研 C++ 渲染内核，此前的性能与卡顿问题基本消除（30fps 上限下整机 CPU 占用约 0.7%）。旧实现保留在 `flutter/` 与 `native/` 目录作参考。

```
              全部功能与渲染（一套 TypeScript，redesign/ui/）
   ┌───────────────────────────────────────────────────────┐
   │ 官方 Cubism Web SDK + 互动 / 行为 / 对话 / 设置          │  <- 约 95% 代码，双端共用
   └───────────────┬───────────────────────┬───────────────┘
            Windows 薄壳               Android 薄壳
         redesign/src-tauri/         redesign/android/
           （Tauri / Rust）           （Kotlin + WebView）
```

## 功能特点

- **抚摸互动**：手势识别（水平往返、速度、方向反转），配合抚摸台词与闭眼反馈。
- **点击互动**：按区域反应（头 / 脸 / 耳朵），连续点击触发疑惑，快速拖动触发反应。
- **对话系统**：分页气泡、按时间段的问候、洗牌袋抽取与随机台词。
- **自然表现**：视线跟随、自动随机动作、每日互动状态。
- **Windows 桌面集成**：透明无边框置顶窗口、托盘菜单、贴边吸附、镜像、开机自启；透明区域鼠标穿透，只有角色不透明像素才拦截鼠标。
- **Android 桌面集成**：App 内全屏互动，退后台自动转为悬浮窗；省电模式（15fps）、开机自启；透明区域触摸穿透，支持贴边半出屏停靠。
- **设置持久化**：缩放、位置、镜像、贴边、置顶、自启等在双端一致保存。

## 快速开始

### 环境要求

| 组件 | 版本 / 说明 |
| --- | --- |
| Node.js | ≥ 18（前端构建，Vite） |
| Rust + cargo | Windows 壳（Tauri） |
| Android SDK | platform 36 + JDK 17/21（构建 APK） |
| Live2D Cubism Web SDK | 5-r.5，需手动准备，见下 |

> **Live2D SDK 准备**：Cubism 组件有许可限制、不入库。请从 Live2D 官网下载 Cubism Web 样本 / SDK 5-r.5，将 `Framework/` 与 `Core/` 放到 `third_party/CubismWebSamples/` 下，构建依赖其中的 `@framework/*` 别名与 `live2dcubismcore.js`。详见 `docs/BUILD.md`。

### Windows

```bash
cd redesign
npm install                          # 首次

# 开发运行（附带 CDP 调试端口，便于用 redesign/tools/ 检查页面）
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev

# 发布构建（前端先 build，再由 Tauri 打包为 NSIS 安装程序）
cd ui && npm run build && cd ..
npm run tauri build
```

产物：`redesign/src-tauri/target/release/bundle/nsis/Aliya Pet_*.exe`

### Android

```bash
# 1. 构建共享前端（产物进入 redesign/ui/dist，Gradle 自动打包进 assets）
cd redesign/ui && npm run build

# 2. 构建 APK
cd ../android
gradlew.bat assembleDebug            # 或 assembleRelease

# 3. 安装到设备
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> 国内网络：`android/settings.gradle.kts` 已内置阿里云镜像。仅改 Kotlin 壳只需 `assembleDebug`，但前端改动必须**先** `ui:build`。真机需在系统设置单独授予「USB 安装」与「悬浮窗权限」（MIUI / EMUI 等）。

## 项目结构

```
redesign/                    # 重写版（当前主产品）
├── ui/                      # 共享 Web 前端（TypeScript + Vite）
│   ├── src/
│   │   ├── platform.ts      # 平台适配层（tauri / android / 浏览器），唯一平台分叉点
│   │   ├── pet-app.ts       # 应用外壳：渲染循环 / 指针接线 / 窗口
│   │   ├── pet-model.ts     # 模型：动作 / 物理 / 眨眼 / 呼吸 / 视线 / 互动通道
│   │   ├── interaction/     # 抚摸状态机、程序式反应、连点 / 拖动
│   │   ├── dialogue/        # 台词分页 / 播放 / 气泡
│   │   ├── behavior.ts      # 自动动作、随机台词、视线跟随
│   │   └── settings.ts      # 设置存储（localStorage）
│   └── assets/live2d/aliya/ # 模型 + 动作（当前为官方示例占位动作）
├── src-tauri/               # Windows 壳（Rust）：窗口 / 托盘 / 自启 / 设置子窗口
├── android/                 # Android 壳（Kotlin）：Activity / 悬浮窗服务 / JS 桥
└── tools/                   # 本地调试脚本（CDP 检查 / 截屏 / CPU 测量；未入库）

flutter/                     # 旧版 Flutter 实现（已弃用，保留参考）
native/                      # 旧版自研 C++ 渲染内核（已弃用，保留参考）
third_party/                 # Live2D SDK（许可限制，不入库，需自行下载）
scripts/                     # 旧版构建 / 验证脚本
docs/                        # 架构、构建、Android、动作接入文档
```

## 技术栈与架构

- **渲染**：官方 Live2D Cubism Web SDK 5-r.5（Framework + Core 6.0.1 wasm），WebGL2，帧率上限 30fps（URL 参数 `?fps=N` 可调）。
- **共享前端**：TypeScript + Vite；Pointer Events 统一桌面鼠标与触摸输入。
- **Windows 壳**：Tauri 2 + WebView2，透明置顶窗、托盘、注册表自启；后台线程轮询光标位置实现透明区域鼠标穿透。
- **Android 壳**：Kotlin + 系统 WebView（`WebViewAssetLoader` 提供同源资源），`MainActivity`（App 内）+ `PetOverlayService`（前台服务悬浮窗）+ `ShellBridge` JS 桥 + `BootReceiver` 自启。
- **布局适配**：复刻旧版包围盒 fit 算法，避免官方 canvas fit 使角色缩小；渲染余量 1.45（按占位动作实测，接入真动作后收紧）。
- **包名**：双端统一为 `top.liminalselves.aliyapet`。

更多实现细节见 `docs/ARCHITECTURE.md`。

## 文档

| 文档 | 内容 |
| --- | --- |
| `docs/ARCHITECTURE.md` | 架构、渲染 / 布局算法、平台适配与双端差异 |
| `docs/BUILD.md` | Windows / Android 构建、依赖与调试工具 |
| `docs/ANDROID.md` | Android 壳设计（悬浮窗 / 前台服务 / JS 桥 / 权限） |
| `docs/ACTIONS.md` | 动作接入指南（替换占位动作 + 余量重新测量） |
| `CHANGELOG.md` | 版本更新记录 |

## 动作库与资源

`redesign/ui/assets/live2d/aliya/motions/` 下的 9 个动作（摇摆、点头、摇头、疑惑、挥手、伸展、生气、打哈欠、走路）目前是**官方示例（Hiyori）的占位文件**。Aliya 真动作导出后，直接替换同名 `.motion3.json` 并重新构建前端即可，接口已就绪——详见 `docs/ACTIONS.md`。

## 许可与声明

- 本仓库当前**未附带开源许可证文件**；使用与分发前请先与作者确认授权范围。
- **Live2D Cubism SDK**（Core / Framework）受 Live2D 许可协议约束，不随本仓库分发，需自行从官网下载。
- 本程序为**二创桌宠**，角色 Aliya 原创出自《彼方的她》（Liminal Selves），版权归原作者所有。

## English

### Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Tech Stack & Architecture](#tech-stack--architecture)
- [Documentation](#documentation)
- [Motion Library & Assets](#motion-library--assets)
- [License & Notices](#license--notices)

### Overview

Aliya Pet is a desktop pet rendered with the official **Live2D Cubism Web SDK**, supporting both **Windows** and **Android**.

The current implementation is a rewrite (`redesign/`) built on a **shared web core + thin native shells** design: nearly all logic — rendering, petting/click interactions, dialogue, behavior and settings — is written once in TypeScript (`redesign/ui/`). Windows uses a Tauri (Rust) shell and Android a thin Kotlin shell; both only provide shell-level capabilities such as windows, tray, overlay and system integration. Because both platforms share the same frontend, their features stay aligned with no duplicate implementations.

The official rendering pipeline (maintained by Live2D) replaces the old self-built C++ renderer, resolving the earlier performance and stutter issues (≈0.7% total CPU at a 30fps cap). The legacy implementation is kept in `flutter/` and `native/` for reference.

```
           All logic & rendering (one TypeScript codebase, redesign/ui/)
   ┌───────────────────────────────────────────────────────┐
   │ Official Cubism Web SDK + interaction / behavior /      │  <- ~95% of code, shared
   │ dialogue / settings                                     │
   └───────────────┬───────────────────────┬───────────────┘
            Windows shell               Android shell
         redesign/src-tauri/         redesign/android/
           (Tauri / Rust)             (Kotlin + WebView)
```

### Features

- **Petting**: gesture recognition (horizontal back-and-forth, speed, direction reversal) with petting lines and eye-closing feedback.
- **Click interactions**: region-based reactions (head / face / ears); repeated clicks trigger doubt, fast drags trigger reactions.
- **Dialogue system**: paged bubbles, time-of-day greetings, shuffle-bag drawing and random lines.
- **Natural behavior**: gaze following, automatic random motions, daily interaction state.
- **Windows desktop integration**: transparent borderless always-on-top window, tray menu, edge snapping, mirroring, auto-start; click-through over transparent areas — only opaque character pixels capture the mouse.
- **Android desktop integration**: full-screen interaction inside the app, auto-switch to an overlay when backgrounded; power-save mode (15fps), auto-start; touch-through over transparent areas and edge docking that may hang partly off-screen.
- **Persistent settings**: scale, position, mirroring, snapping, always-on-top and auto-start are stored consistently on both platforms.

### Quick Start

#### Requirements

| Component | Version / Notes |
| --- | --- |
| Node.js | ≥ 18 (frontend build, Vite) |
| Rust + cargo | Windows shell (Tauri) |
| Android SDK | platform 36 + JDK 17/21 (APK build) |
| Live2D Cubism Web SDK | 5-r.5, prepare manually (see below) |

> **Preparing the Live2D SDK**: the Cubism components are license-restricted and not committed. Download the Cubism Web samples / SDK 5-r.5 from the Live2D website and place `Framework/` and `Core/` under `third_party/CubismWebSamples/`. The build depends on the `@framework/*` alias and `live2dcubismcore.js`. See `docs/BUILD.md`.

#### Windows

```bash
cd redesign
npm install                          # first time only

# Dev run (with a CDP debug port for inspecting pages via redesign/tools/)
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev

# Release build (build the frontend first, then package with Tauri as an NSIS installer)
cd ui && npm run build && cd ..
npm run tauri build
```

Artifact: `redesign/src-tauri/target/release/bundle/nsis/Aliya Pet_*.exe`

#### Android

```bash
# 1. Build the shared frontend (output goes to redesign/ui/dist, Gradle bundles it into assets)
cd redesign/ui && npm run build

# 2. Build the APK
cd ../android
gradlew.bat assembleDebug            # or assembleRelease

# 3. Install on a device
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> In mainland China, an Aliyun mirror is already configured in `android/settings.gradle.kts`. Kotlin-only changes just need `assembleDebug`, but frontend changes **must** run `ui:build` first. On real devices, grant "USB install" and "overlay" permissions in system settings separately (MIUI / EMUI, etc.).

### Project Structure

```
redesign/                    # The rewrite (current main product)
├── ui/                      # Shared web frontend (TypeScript + Vite)
│   ├── src/
│   │   ├── platform.ts      # Platform layer (tauri / android / browser), the only fork point
│   │   ├── pet-app.ts       # App shell: render loop / pointer wiring / window
│   │   ├── pet-model.ts     # Model: motions / physics / blink / breathe / gaze / channels
│   │   ├── interaction/     # Petting state machine, procedural reactions, clicks / drags
│   │   ├── dialogue/        # Line paging / playback / bubbles
│   │   ├── behavior.ts      # Auto motions, random lines, gaze following
│   │   └── settings.ts      # Settings storage (localStorage)
│   └── assets/live2d/aliya/ # Model + motions (currently official-sample placeholders)
├── src-tauri/               # Windows shell (Rust): window / tray / auto-start / settings window
├── android/                 # Android shell (Kotlin): Activity / overlay service / JS bridge
└── tools/                   # Local debug scripts (CDP inspect / screenshot / CPU; not committed)

flutter/                     # Legacy Flutter implementation (deprecated, kept for reference)
native/                      # Legacy self-built C++ renderer (deprecated, kept for reference)
third_party/                 # Live2D SDK (license-restricted, not committed, download manually)
scripts/                     # Legacy build / validation scripts
docs/                        # Architecture, build, Android and motion-integration docs
```

### Tech Stack & Architecture

- **Rendering**: official Live2D Cubism Web SDK 5-r.5 (Framework + Core 6.0.1 wasm), WebGL2, 30fps cap (tunable via the `?fps=N` URL parameter).
- **Shared frontend**: TypeScript + Vite; Pointer Events unify desktop mouse and touch input.
- **Windows shell**: Tauri 2 + WebView2 — transparent always-on-top window, tray, registry auto-start; a background thread polls the cursor position for click-through over transparent areas.
- **Android shell**: Kotlin + system WebView (`WebViewAssetLoader` serves same-origin assets), `MainActivity` (in-app) + `PetOverlayService` (foreground-service overlay) + `ShellBridge` JS bridge + `BootReceiver` auto-start.
- **Layout adaptation**: replicates the legacy bounding-box fit algorithm to avoid the official canvas fit shrinking the character; render margin 1.45 (measured on placeholder motions, tighten after real motions land).
- **Package name**: unified as `top.liminalselves.aliyapet` on both platforms.

See `docs/ARCHITECTURE.md` for more implementation details.

### Documentation

| Document | Contents |
| --- | --- |
| `docs/ARCHITECTURE.md` | Architecture, rendering / layout algorithms, platform layer and platform differences |
| `docs/BUILD.md` | Windows / Android builds, dependencies and debug tooling |
| `docs/ANDROID.md` | Android shell design (overlay / foreground service / JS bridge / permissions) |
| `docs/ACTIONS.md` | Motion integration guide (replace placeholder motions + re-measure margin) |
| `CHANGELOG.md` | Version history |

### Motion Library & Assets

The 9 motions under `redesign/ui/assets/live2d/aliya/motions/` (sway, nod, shake, doubt, wave, stretch, angry, yawn, walk) are currently **placeholders taken from the official sample (Hiyori)**. Once Aliya's real motions are exported, simply replace the same-named `.motion3.json` files and rebuild the frontend — the interface is ready. See `docs/ACTIONS.md`.

### License & Notices

- This repository currently ships **without an open-source license file**; please confirm the scope of authorization with the author before use or distribution.
- The **Live2D Cubism SDK** (Core / Framework) is governed by the Live2D license and is not distributed with this repository; download it from the official website yourself.
- This program is a **fan-made (derivative) desktop pet**. The character Aliya originates from *Liminal Selves* (《彼方的她》); all rights belong to the original creators.
