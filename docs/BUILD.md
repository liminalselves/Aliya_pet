# 构建与调试

## 依赖

| 组件 | 用途 | 说明 |
| ---- | ---- | ---- |
| Node.js ≥ 18 | 前端构建（Vite） | UI 源码在 `redesign/ui/` |
| Rust + cargo | Tauri 壳 | `redesign/src-tauri/` |
| Android SDK（platform 36）+ JDK 17/21 | Android 构建 | 本地 `gradle wrapper` 自动下载 Gradle 8.11.1 + AGP 8.9 |
| **Live2D Cubism SDK** | 第三方法/Web 组件 | 见下节 |

### Live2D SDK 准备

Cubism 组件来自官方便利包/样本（有许可限制，不入 git）。当前机器上位于
`third_party/`（.gitignore 已忽略 whole 目录），构建实际用到：

- `third_party/CubismWebSamples/Framework` —— 前端构建的 `@framework/*` 别名目标
- `third_party/CubismWebSamples/Core` —— 资产同步时的 `live2dcubismcore.js`
  （被拷贝进 `ui/assets/core/`，随构建进 dist）

若换机器，从官网下载 Cubism Web 样本或 SDK 5-r.5，恢复上述目录即可。

## Windows（Tauri）

```bash
cd redesign
npm install

# 开发运行：省略参数连接默认远程实例
npm run dev
# 临时连接指定 Misskey 实例
npm run dev -- http://127.0.0.1:3000
# 可加 CDP 调试端口，便于用 tools/ 检查页面
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run dev

# 发布构建（Tauri 自动先构建前端，再打包成 NSIS 安装程序）
npm run build
```

产物：`redesign/src-tauri/target/release/bundle/nsis/Aliya Pet_*.exe`

### 常见问题

- `cargo-tauri` 未安装：用局部 CLI（`npx tauri ...`）即可，无需全局安装。
- dev 进程偶尔自行退出打印 `Failed to unregister class Chrome_WidgetWin_0`：
  已知无害，重跑 dev 即可。
- 前端改动即时热重载；Rust 改动由 tauri dev 自动重编译。

## Android

```bash
# 1. 构建共享前端（产物进 redesign/ui/dist，Gradle 自动打包进 assets）
cd redesign/ui && npm run build

# 2. 构建 APK
cd ../android
gradlew.bat assembleDebug          # 或 assembleRelease

# 3. 安装到设备
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- 国内网络：`android/settings.gradle.kts` 已内置阿里云镜像（dl.google.com 常不可达）。
- 修改了 Kotlin 壳 → 只需 `assembleDebug`（但前端改动必须**先** `ui:build`）。
- 真机注意：MIUI/EMUI 的「USB 安装」与「悬浮窗权限」需到系统设置单独授权；
  重装 APK 会重置 appops 权限。

### 正式包（签名 release APK）

`android/keystore.properties`（不入库）指向 `keystore/aliyapet-release.jks`，
gradle 检测到该文件时 release 构建自动签名；缺失则出未签名包。

```bash
cd redesign/android
gradlew.bat assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

**密钥必须备份**（`redesign/android/keystore/` + `keystore.properties`）：
丢失后无法为后续更新出同签名包，用户只能卸载重装（丢设置与 Misskey 授权）。
debug 与 release 签名不同，从 debug 覆盖装 release 前必须先卸载。

## 调试工具（redesign/tools/）

基于 CDP（Tauri 用 `--remote-debugging-port=9333`；Android 用
`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`）：

```bash
# 在页面里执行表达式并打印
node tools/cdp-eval.mjs "window.__pet && window.__pet.model.isReady()"
# 指定第 N 个页面（多个 WebView 时，Android 悬浮窗/App 内各一个）
CDP_PORT=9222 node tools/cdp-eval-n.mjs 1 "…"
# 拉取控制台日志 / 页面截图
node tools/cdp-read.mjs
node tools/cdp-shot.mjs out.png
# 桌面 CPU 占用测量（30s 窗口）
powershell -File tools/measure-cpu.ps1
```

`window.__pet` 暴露了调试句柄（model/interaction/dialogue/settings 等），
可在 CDP 会话里直接调用（如 `window.__pet.model.playAction('wave')`、
`window.__pet.onShellEvent('screen-off')`）。

页面也支持 `?platform=android` 强制以 Android 模式运行（配合在控制台
注入 mock 的 `window.AndroidShell` 可无真机验证 Android 分支）。
