# Aliya Pet

> 基于 Live2D Cubism 的跨平台桌面宠物 · 一套 Web 内核，Windows / Android 双端薄壳

<!-- Badge Row 1: Core Info -->
[![GitHub](https://img.shields.io/badge/GitHub-liminalselves%2FAliya__pet-181717?logo=github&logoColor=white)](https://github.com/liminalselves/Aliya_pet)
[![Version](https://img.shields.io/badge/version-0.1.0-orange)](https://github.com/liminalselves/Aliya_pet/blob/master/CHANGELOG.md)

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

当前实现为重写版（`redesign/`），采用「**共享 Web 内核 + 双端薄壳**」架构：渲染、抚摸 / 点击互动、对话、聊天、行为与设置等几乎全部逻辑都用 TypeScript 实现一次（`redesign/ui/`）；Windows 用 Tauri（Rust）壳、Android 用 Kotlin 薄壳，两者只负责窗口、托盘、悬浮窗与系统集成等壳层能力。双端共用同一份前端，功能天然对齐，没有两套实现。

官方渲染链路（SDK 官方支持、随 Live2D 长期维护）取代了旧版自研 C++ 渲染内核，此前的性能与卡顿问题基本消除（30fps 上限下整机 CPU 占用约 0.7%）。旧版 Flutter 与 native/ 内核已移除，历史可在 git 中追溯。

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
- **表情与情绪**：情绪引擎驱动默认表情与动作选择，经 `window.petAI` 暴露给 AI / 自动化（见[动作库与资源](#动作库与资源)）。
- **聊天（Misskey 智能体）**：GAL 式分页回复、表演指令驱动表情动作、会话记录 / 新建 / 切换与八面板托管配置——Windows 为独立窗口，Android 在主界面及辅助页。
- **Windows 桌面集成**：透明无边框置顶窗口、托盘菜单、贴边吸附、镜像、开机自启；透明区域鼠标穿透，只有角色不透明像素才拦截鼠标。
- **Android 桌面集成**：App 内全屏互动，退后台自动转为悬浮窗（仅基础互动，双击返回主界面）；省电模式、开机自启；透明区域触摸穿透，支持贴边半出屏停靠。
- **设置持久化**：缩放、位置、镜像、贴边、置顶、自启等在双端一致保存。

## 快速开始

### 环境要求

| 组件 | 版本 / 说明 |
| --- | --- |
| Node.js | Vite 8 要求 `^20.19.0 || >=22.12.0`；推荐 Node.js 24 LTS |
| Rust + cargo | Windows 壳（Tauri），使用 MSVC 工具链 |
| Visual Studio Build Tools 2022 | Windows 构建：安装「使用 C++ 的桌面开发」工作负载（含 MSVC 与 Windows SDK） |
| WebView2 Runtime | Windows 运行环境；未安装时需安装 Microsoft Edge WebView2 Evergreen Runtime |
| Android SDK | platform 36 + JDK 17/21（构建 APK） |
| Live2D Cubism Web SDK | 5-r.5，已随仓库入库 |

> **Live2D SDK**：Cubism 组件（`third_party/cubism-web-sdk/`，仅 Framework + Core，约 1.3MB）已随仓库入库，clone 后即可构建，详见 `docs/BUILD.md`。

### Windows

以下命令使用 **PowerShell**，从仓库根目录开始执行。

```powershell
cd redesign
npm ci                     # 安装 Tauri CLI（首次克隆或依赖更新后）
cd ui
npm ci                     # 安装 Vite、TypeScript 等前端依赖（必需）
cd ..

# 开发运行；不传参数时连接默认远程 Misskey：
npm run dev
# 临时连接指定实例：
npm run dev -- http://127.0.0.1:3000
# 如需 CDP 调试端口：
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
npm run dev
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
```

打包安装版：在上述 `redesign/` 目录运行 `npm run build`。Tauri 会先自动构建共享前端，
默认连接 `https://misskey.liminalselves.top`（详见 `docs/BUILD.md`，SDK 已随仓库入库）。
产物：`redesign/src-tauri/target/release/bundle/nsis/Aliya Pet_<版本>_x64-setup.exe`（另有同版本 MSI）。两种安装器均为简体中文，NSIS 安装器与卸载器使用 Aliya 图标。

### Android

以下命令使用 **PowerShell**，从仓库根目录开始执行。

```powershell
# 1. 安装前端依赖并构建共享前端（产物进入 redesign/ui/dist）
cd redesign/ui
npm ci
npm run build

# 2. 构建 APK
cd ../android
.\gradlew.bat assembleDebug            # 或 assembleRelease

# 3. 安装到设备
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

在 **Bash（Linux / macOS / Git Bash）** 中，前端构建和安装命令不变；构建 APK 时，在 `redesign/android/` 下先执行 `chmod +x gradlew`，再用 `./gradlew assembleDebug`（或 `./gradlew assembleRelease`）替代 `.\gradlew.bat` 命令。

> 国内网络：`android/settings.gradle.kts` 已内置阿里云镜像。仅改 Kotlin 壳只需 `assembleDebug`，但前端改动必须**先**在 `redesign/ui/` 运行 `npm run build`。正式签名包依赖 `android/keystore.properties`（不入库，见 `docs/BUILD.md`）。真机需在系统设置单独授予「USB 安装」与「悬浮窗权限」（MIUI / EMUI 等）。

## 项目结构

```
redesign/                    # 重写版（当前主产品）
├── ui/                      # 共享 Web 前端（TypeScript + Vite）
│   ├── src/
│   │   ├── platform.ts      # 平台适配层（tauri / android / 浏览器），唯一平台分叉点
│   │   ├── pet-app.ts       # 应用外壳：渲染循环 / 指针接线 / 窗口
│   │   ├── pet-model.ts     # 模型：动作 / 物理 / 眨眼 / 呼吸 / 视线 / 互动通道
│   │   ├── pet-ai.ts        # PetAI 语义 API（表情 / 情绪 / 动作 / 视线，见 docs/AI-API.md）
│   │   ├── interaction/     # 抚摸状态机、程序式反应、连点 / 拖动
│   │   ├── dialogue/        # 台词分页 / 播放 / 气泡
│   │   ├── chat/            # Misskey 智能体聊天（GAL 式回复 / 会话管理）
│   │   ├── behavior.ts      # 自动动作、随机台词、视线跟随
│   │   └── settings.ts      # 设置存储（localStorage）
│   └── assets/live2d/aliya/ # 模型 + 自编动作 / 表情（tools 生成脚本产出）
├── src-tauri/               # Windows 壳（Rust）：窗口 / 托盘 / 自启 / 设置子窗口
├── android/                 # Android 壳（Kotlin）：Activity / 悬浮窗服务 / JS 桥
└── tools/                   # 动作 / 表情生成脚本（入库）与 CDP 调试脚本（未入库）

third_party/cubism-web-sdk/  # Live2D Cubism Web SDK（Framework + Core，已入库）
docs/                        # 架构、构建、Android、聊天、动作接入等文档
```

## 技术栈与架构

- **渲染**：官方 Live2D Cubism Web SDK 5-r.5（Framework + Core 6.0.1 wasm），WebGL2，帧率上限 30fps（URL 参数 `?fps=N` 可调）。
- **共享前端**：TypeScript + Vite；Pointer Events 统一桌面鼠标与触摸输入。
- **Windows 壳**：Tauri 2 + WebView2，透明置顶窗、托盘、注册表自启；后台线程轮询光标位置实现透明区域鼠标穿透。
- **Android 壳**：Kotlin + 系统 WebView（`WebViewAssetLoader` 提供同源资源），`MainActivity`（App 内）+ `PetOverlayService`（前台服务悬浮窗）+ `ShellBridge` JS 桥 + `BootReceiver` 自启。
- **布局适配**：按模型包围盒适配窗口；动作渲染余量与测量依据见 `docs/ACTIONS.md`。
- **包名**：双端统一为 `top.liminalselves.aliyapet`。

更多实现细节见 `docs/ARCHITECTURE.md`。

## 文档

| 文档 | 内容 |
| --- | --- |
| `docs/ARCHITECTURE.md` | 架构、渲染 / 布局算法、平台适配与双端差异 |
| `docs/BUILD.md` | Windows / Android 构建、依赖与调试工具 |
| `docs/ANDROID.md` | Android 壳设计（悬浮窗 / 前台服务 / JS 桥 / 权限） |
| `docs/CHAT.md` | 聊天系统（Misskey 智能体、会话与八面板托管） |
| `docs/PERFORMANCE.md` | 表演指令协议（`[[agent_cue]]`，AI 回复驱动表情/动作） |
| `docs/INTERACTION.md` | 普通互动规则（操作约定、手势生命周期与互斥） |
| `docs/ACTIONS.md` | 动作接入指南（自编动作工程约束 + 余量重新测量） |
| `docs/MODEL.md` | 模型能力图谱（参数表 / 物理链 / 值域坑） |
| `docs/AI-API.md` | PetAI 对外接口（表情 / 情绪 / 动作 / 视线 + 事件总线） |
| `CHANGELOG.md` | 版本更新记录 |

## 动作库与资源

- **动作库**：10 个动作（摇摆、点头、摇头、疑惑、挥手、伸展、生气、打哈欠、开心雀跃、撒娇）是为当前 Aliya 模型自编的 motion3.json，由 `redesign/tools/gen-motions.py` 生成（设计要点与工程约束见 `docs/ACTIONS.md`）。
- **表情与情绪**：12 个 exp3.json 表情（`gen-expressions.py` 生成）+ 情绪引擎（心境 → 默认表情、动作选择加权、自然衰减），经 `window.petAI` 语义 API 暴露给 AI / 自动化（见 `docs/AI-API.md`）；设置窗口有对应的「表情与情绪」控制面板（表情预览 / 情绪切换，与 AI 共享状态源）。

## 许可与声明

### 免责声明

本程序（Aliya Pet）与以下列出的所有游戏、开发者、发行商、个人、团体、公司均无任何关系、联系：

- 游戏《彼方的她-Aliya》（Aliya: Timelink）：[Steam 商店](https://store.steampowered.com/app/2704110/)
- 开发者【瞳电游工作室】（TDGame Studio）：[B站官号](https://space.bilibili.com/1104337773)、[Steam](https://store.steampowered.com/developer/tdgame)
- 发行商【AnotherIndie】：[官网](https://anotherindie.com.cn/)、[Steam](https://store.steampowered.com/publisher/AnotherIndie)

本程序中的角色美术，以《彼方的她-Aliya》（Aliya: Timelink）的游戏内原始素材为基础，经 AI 图像生成辅助加工后，重新绘制并绑定为 Live2D 模型（含 `.moc3` 模型文件、贴图、动作与表情数据）。

上述游戏内原始素材及角色形象的著作权归原作者与各自权利人所有，本程序对原素材不主张任何权利，亦未获其授权或认可。

本程序由多位作者共同完成，程序代码与项目贡献归 **liminalselves** 组织所有。其中 Live2D 模型文件、贴图、动作与表情数据由本项目作者之一制作：AI 加工、重新绘制与绑定均由其完成，由此形成的这部分内容属于其创作，未经许可不得提取或再分发；作为基于原作素材的衍生内容，这部分仍受原作权利约束，AI 加工不改变原作权属，也不构成获得授权。

本程序为**二创桌宠**。角色 Aliya 及其名称、形象均原创于《彼方的她-Aliya》（Aliya: Timelink），相关版权归游戏开发者【瞳电游工作室】（TDGame Studio）所有，本程序不享有其中任何权利。

本程序为非盈利性质的粉丝向项目，非官方作品。

如权利人认为上述使用方式不妥，可通过 GitHub Issue 联系，本程序将在收到通知后移除相关内容。

### 许可

- **程序代码**：**保留所有权利**。源码公开仅供审阅与协作，未授予使用、修改或再分发的许可；版权归 **liminalselves** 组织所有。
- **美术资产**（`redesign/ui/assets/` 下除第三方文件外的部分：Live2D 模型文件、贴图、动作与表情数据、背景、图标、对话文本）：**保留所有权利**。允许在非商业前提下随本程序原样分发并注明出处；禁止商用，禁止拆分提取模型、贴图或动作单独再分发。
- **角色 IP**：角色 Aliya 的形象与名称权利归原作方，上述美术条款只在作者有权处分的范围内有效，不构成对角色形象的使用授权。
- **第三方组件**（Live2D Cubism SDK 与 Core、Cubism WebGL 着色器、Noto Serif SC 字体）：适用其各自许可，不受上述条款约束，清单与要点见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

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

The current implementation is a rewrite (`redesign/`) built on a **shared web core + thin native shells** design: nearly all logic — rendering, petting/click interactions, dialogue, chat, behavior and settings — is written once in TypeScript (`redesign/ui/`). Windows uses a Tauri (Rust) shell and Android a thin Kotlin shell; both only provide shell-level capabilities such as windows, tray, overlay and system integration. Because both platforms share the same frontend, their features stay aligned with no duplicate implementations.

The official rendering pipeline (maintained by Live2D) replaces the old self-built C++ renderer, resolving the earlier performance and stutter issues (≈0.7% total CPU at a 30fps cap). The legacy Flutter and native/ cores have been removed; their history remains in git.

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
- **Expressions & emotion**: an emotion engine drives the default expression and motion selection, exposed to AI/automation via `window.petAI` (see [Motion Library & Assets](#motion-library--assets)).
- **Chat (Misskey agent)**: GAL-style paged replies, performance-cue-driven expressions and motions, session log / creation / switching and eight-panel managed config — a separate window on Windows, in-app pages on Android.
- **Windows desktop integration**: transparent borderless always-on-top window, tray menu, edge snapping, mirroring, auto-start; click-through over transparent areas — only opaque character pixels capture the mouse.
- **Android desktop integration**: full-screen interaction inside the app; when backgrounded it becomes an overlay with basic interactions (double-tap returns to the main screen); power-save mode, auto-start; touch-through over transparent areas and edge docking that may hang partly off-screen.
- **Persistent settings**: scale, position, mirroring, snapping, always-on-top and auto-start are stored consistently on both platforms.

### Quick Start

#### Requirements

| Component | Version / Notes |
| --- | --- |
| Node.js | Vite 8 requires `^20.19.0 || >=22.12.0`; Node.js 24 LTS recommended |
| Rust + cargo | Windows shell (Tauri), using the MSVC toolchain |
| Visual Studio Build Tools 2022 | Windows build: install the “Desktop development with C++” workload (including MSVC and the Windows SDK) |
| WebView2 Runtime | Windows runtime; install Microsoft Edge WebView2 Evergreen Runtime if missing |
| Android SDK | platform 36 + JDK 17/21 (APK build) |
| Live2D Cubism Web SDK | 5-r.5, committed to the repo |

> **Live2D SDK**: the Cubism components (`third_party/cubism-web-sdk/`, Framework + Core only, ~1.3MB) are committed to the repository — a plain clone is enough to build. See `docs/BUILD.md`.

#### Windows

Use **PowerShell**, starting from the repository root.

```powershell
cd redesign
npm ci                     # Install the Tauri CLI (first clone or dependency update)
cd ui
npm ci                     # Install Vite/TypeScript frontend dependencies (required)
cd ..

# Dev run; without arguments it connects to the default remote Misskey:
npm run dev
# Temporarily target a specific instance:
npm run dev -- http://127.0.0.1:3000
# With a CDP debug port:
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
npm run dev
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
```

Release build: run `npm run build` from the `redesign/` directory reached above. Tauri builds the shared frontend first and connects to `https://misskey.liminalselves.top` by default (see `docs/BUILD.md`; the SDK is committed to the repo).
Artifact: `redesign/src-tauri/target/release/bundle/nsis/Aliya Pet_<version>_x64-setup.exe` (plus an MSI of the same version). Both installers use Simplified Chinese; the NSIS installer and uninstaller use the Aliya icon.

#### Android

Use **PowerShell**, starting from the repository root.

```powershell
# 1. Install frontend dependencies and build the shared UI
cd redesign/ui
npm ci
npm run build

# 2. Build the APK
cd ../android
.\gradlew.bat assembleDebug            # or assembleRelease

# 3. Install on a device
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

In **Bash (Linux / macOS / Git Bash)**, the frontend build and installation commands are unchanged. To build the APK, run `chmod +x gradlew` in `redesign/android/`, then use `./gradlew assembleDebug` (or `./gradlew assembleRelease`) instead of the `.\gradlew.bat` command.

> In mainland China, an Aliyun mirror is already configured in `android/settings.gradle.kts`. Kotlin-only changes just need `assembleDebug`, but frontend changes **must** run `npm run build` in `redesign/ui/` first. Signed release builds require `android/keystore.properties` (not committed; see `docs/BUILD.md`). On real devices, grant "USB install" and "overlay" permissions in system settings separately (MIUI / EMUI, etc.).

### Project Structure

```
redesign/                    # The rewrite (current main product)
├── ui/                      # Shared web frontend (TypeScript + Vite)
│   ├── src/
│   │   ├── platform.ts      # Platform layer (tauri / android / browser), the only fork point
│   │   ├── pet-app.ts       # App shell: render loop / pointer wiring / window
│   │   ├── pet-model.ts     # Model: motions / physics / blink / breathe / gaze / channels
│   │   ├── pet-ai.ts        # PetAI semantic API (expressions / emotion / motions / gaze, see docs/AI-API.md)
│   │   ├── interaction/     # Petting state machine, procedural reactions, clicks / drags
│   │   ├── dialogue/        # Line paging / playback / bubbles
│   │   ├── chat/            # Misskey agent chat (GAL-style replies / session management)
│   │   ├── behavior.ts      # Auto motions, random lines, gaze following
│   │   └── settings.ts      # Settings storage (localStorage)
│   └── assets/live2d/aliya/ # Model + self-authored motions / expressions (from tools generators)
├── src-tauri/               # Windows shell (Rust): window / tray / auto-start / settings window
├── android/                 # Android shell (Kotlin): Activity / overlay service / JS bridge
└── tools/                   # Motion/expression generators (committed) + CDP debug scripts (not committed)

third_party/cubism-web-sdk/  # Live2D Cubism Web SDK (Framework + Core, committed)
docs/                        # Architecture, build, Android, chat and motion-integration docs
```

### Tech Stack & Architecture

- **Rendering**: official Live2D Cubism Web SDK 5-r.5 (Framework + Core 6.0.1 wasm), WebGL2, 30fps cap (tunable via the `?fps=N` URL parameter).
- **Shared frontend**: TypeScript + Vite; Pointer Events unify desktop mouse and touch input.
- **Windows shell**: Tauri 2 + WebView2 — transparent always-on-top window, tray, registry auto-start; a background thread polls the cursor position for click-through over transparent areas.
- **Android shell**: Kotlin + system WebView (`WebViewAssetLoader` serves same-origin assets), `MainActivity` (in-app) + `PetOverlayService` (foreground-service overlay) + `ShellBridge` JS bridge + `BootReceiver` auto-start.
- **Layout adaptation**: fits the model's bounding box to the window. See `docs/ACTIONS.md` for motion render margins and measurement evidence.
- **Package name**: unified as `top.liminalselves.aliyapet` on both platforms.

See `docs/ARCHITECTURE.md` for more implementation details.

### Documentation

| Document | Contents |
| --- | --- |
| `docs/ARCHITECTURE.md` | Architecture, rendering / layout algorithms, platform layer and platform differences |
| `docs/BUILD.md` | Windows / Android builds, dependencies and debug tooling |
| `docs/ANDROID.md` | Android shell design (overlay / foreground service / JS bridge / permissions) |
| `docs/CHAT.md` | Chat system (Misskey agent, sessions and eight-panel managed config) |
| `docs/PERFORMANCE.md` | Performance-cue protocol (`[[agent_cue]]`, AI-reply-driven expressions/motions) |
| `docs/INTERACTION.md` | Local interaction rules (gestures, lifecycles and mutual exclusion) |
| `docs/ACTIONS.md` | Motion integration guide (self-authored motion constraints + re-measuring the margin) |
| `docs/MODEL.md` | Model capability map (parameters / physics chains / value-range pitfalls) |
| `docs/AI-API.md` | PetAI external API (expressions / emotion / motions / gaze + event bus) |
| `CHANGELOG.md` | Version history |

### Motion Library & Assets

- **Motions**: the 10 motions under `redesign/ui/assets/live2d/aliya/motions/` (sway, nod, shake, doubt, wave, stretch, angry, yawn, cheerful bounce, shy sway) are motion3.json files authored for the current Aliya model, generated by `redesign/tools/gen-motions.py` (design notes and constraints in `docs/ACTIONS.md`).
- **Expressions & emotion**: 12 exp3.json expressions (generated by `gen-expressions.py`) plus an emotion engine (mood → default expression, weighted motion selection, natural decay), exposed to AI/automation via the `window.petAI` semantic API (see `docs/AI-API.md`); the settings window has a matching "Expressions & Emotion" panel.

### License & Notices

#### Disclaimer

This program (Aliya Pet) has no relationship or connection with any of the games, developers, publishers, individuals, groups, or companies listed below:

- The game *Aliya: Timelink* (《彼方的她-Aliya》): [Steam](https://store.steampowered.com/app/2704110/)
- The developer 【瞳电游工作室】(TDGame Studio): [Bilibili](https://space.bilibili.com/1104337773), [Steam](https://store.steampowered.com/developer/tdgame)
- The publisher 【AnotherIndie】: [Website](https://anotherindie.com.cn/), [Steam](https://store.steampowered.com/publisher/AnotherIndie)

The character artwork in this program is based on in-game original assets from *Aliya: Timelink* (《彼方的她-Aliya》), processed with the aid of AI image generation and then redrawn and rigged into a Live2D model (including the `.moc3` file, textures, motions and expression data).

The copyright in those in-game original assets and in the character's likeness belongs to the original creators and their respective rights holders; this program claims no rights to the original assets and has not been authorized or endorsed by them.

This program is a joint work of several authors, and the code and project contributions are attributed to the **liminalselves** organization. The Live2D model files, textures, motions and expression data were created by one of the project's authors: the AI-assisted processing, redrawing and rigging were all carried out by that author, and the resulting content is that author's creative work and may not be extracted or redistributed without permission; as derivative content based on the original assets, however, it remains subject to the original rights. AI processing neither changes ownership of the original work nor constitutes authorization.

This program is a **fan-made (derivative) desktop pet**. The character Aliya, together with her name and likeness, originates from *Aliya: Timelink* (《彼方的她-Aliya》); all related copyrights are owned by the developer 【瞳电游工作室】(TDGame Studio), and this program claims no rights to them.

This program is a non-commercial fan project and is not an official product.

Should a rights holder consider this use inappropriate, please reach out via GitHub Issue; the relevant content will be removed upon notice.

#### License

- **Source code**: **all rights reserved**. The source is published for review and collaboration only; no permission to use, modify or redistribute it is granted. Copyright in the code is held by the **liminalselves** organization.
- **Art assets** (everything under `redesign/ui/assets/` except the third-party files below — Live2D model files, textures, motions and expression data, backgrounds, icons, dialogue text): **all rights reserved**. Non-commercial redistribution of the program as a whole with attribution is allowed; commercial use, and extracting or redistributing the model, textures or motions separately, are not.
- **Character IP**: rights in the character Aliya's likeness and name belong to the original rights holders. The asset terms above apply only to what the author is entitled to license, and grant no rights to the character itself.
- **Third-party components** (Live2D Cubism SDK and Core, Cubism WebGL shaders, Noto Serif SC font): governed by their own licenses and not by the terms above; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
