# 构建与调试

## 依赖

| 组件 | 用途 | 说明 |
| ---- | ---- | ---- |
| Node.js `^20.19.0 || >=22.12.0` | 前端构建（Vite 8）；推荐 24 LTS | UI 源码在 `redesign/ui/` |
| Rust + cargo（MSVC 工具链） | Windows Tauri 壳 | `redesign/src-tauri/` |
| Visual Studio Build Tools 2022 | Windows 本机构建工具链 | 安装「使用 C++ 的桌面开发」工作负载（含 MSVC 与 Windows SDK） |
| WebView2 Runtime | Windows 运行环境 | 未安装时需安装 Microsoft Edge WebView2 Evergreen Runtime |
| Android SDK（platform 36）+ JDK 17/21 | Android 构建 | 本地 `gradle wrapper` 自动下载 Gradle 8.11.1 + AGP 8.9 |
| **Live2D Cubism SDK** | 第三方法/Web 组件 | 见下节 |

### Live2D SDK 准备

Cubism Web SDK（官方包，只保留 Framework + Core，约 1.3MB）位于
`third_party/cubism-web-sdk/`：

- `Framework/` —— 前端构建的 `@framework/*` 别名目标（tsconfig paths + vite alias）
- `Core/live2dcubismcore.js` —— 闭源渲染内核，拷贝到 `ui/assets/core/` 随构建进 dist

该目录已入库（Framework 为开源代码、Core 许可允许随产品再分发），
clone 后即可构建，无需手动准备。

## 图标资源

- Windows 窗口、托盘及安装包共用 `redesign/src-tauri/icons/tray.ico`（16–256px）；NSIS 的 `installerIcon` / `uninstallerIcon` 显式指向该文件。`build.rs` 监听图标变化，更新后运行正常发布构建即可重新嵌入。
- Android 应用图标和圆形图标统一声明为 `@mipmap/ic_aliya`（`res/mipmap-anydpi-v26/ic_aliya.xml`），不再沿用旧占位图标的 `ic_launcher` 入口；自适应前景位于 `res/mipmap-*`，保留底图完整构图，缩放到 108dp 画布中央的 72dp 区域，由系统应用遮罩。通知大图标从 Manifest 的应用图标读取，通知头部的应用图标由系统显示；状态栏小图标仍为 `res/drawable/ic_notification.xml` 的单色 A。覆盖升级后若厂商通知栏仍显示旧图标，先从通知「退出」再重新开启悬浮模式；仍未刷新时重启设备，无需卸载或清除应用数据。
- 四个 Web 页面共用 `redesign/ui/assets/icon.png`。

OriginOS 6 实机验证：安装包已使用新图标时，覆盖安装、刷新内存缓存并重建通知后，左侧仍可能显示旧占位图标；本次重启手机后，测试者人工确认左侧已更换为新图标。验证过程未卸载应用或清除应用数据。

## Windows（Tauri）

以下命令使用 **PowerShell**，从仓库根目录开始执行。

```powershell
cd redesign
npm ci                      # Tauri CLI 依赖
cd ui
npm ci                      # 前端 Vite / TypeScript 依赖（必需）
cd ..

# 开发运行：省略参数连接默认远程实例
npm run dev
# 临时连接指定 Misskey 实例
npm run dev -- http://127.0.0.1:3000
# 可加 CDP 调试端口，便于用 tools/ 检查页面
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
npm run dev
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS

# 发布构建（Tauri 自动先构建前端，再打包成 NSIS 安装程序）
npm run build
```

产物：`redesign/src-tauri/target/release/bundle/nsis/Aliya Pet_*.exe`

### Windows 构建产物的完整性标签

Windows 的完整性标签属于本机目录的安全属性，不由 Git 保存。开发目录若被沙箱设为
Low，新 clone 和默认 `target/` 会继承该标签，生成的桌宠可能有进程却无法创建 WebView
或写入普通用户数据目录。

Tauri 的 `beforeBuildCommand` 与 `beforeDevCommand` 会先运行
`redesign/scripts/prepare-windows-build.mjs`：通过 `cargo metadata` 获取实际输出目录
（包括 `CARGO_TARGET_DIR` / Cargo 配置），由同目录的 PowerShell 脚本仅在输出根目录设置
**不向下继承**的 Medium 标签，阻断上级 Low 继承；清除已有子目录、缓存和产物的强制标签，
新产物跟随启动者的正常权限运行，不要求管理员权限。不修改源码、上层目录、DACL 或审计规则，
也不遍历符号链接和目录联接。新 clone 使用 `npm run build`、`npm run dev` 或直接
`npx tauri build/dev` 均会执行此检查。非 Windows 跳过。

不要给可执行文件批量设置可继承的 Medium 标签：当前内置 Administrator 环境中，
这种强制降级会形成仍有管理员权限但完整性为 Medium 的进程，已实测出现 WebView 启动卡住。

设置失败会停止启动或构建，不自动提权。请退出低完整性沙箱，在普通用户终端重试；
若目录权限不允许设置，使用自己可控制的独立 `CARGO_TARGET_DIR`，不要改整个工作区的权限。
直接调用 `cargo build` 不执行 Tauri 钩子，需先运行 `node redesign/scripts/prepare-windows-build.mjs`。
已复制到其他目录的旧低完整性产物不会被此脚本追踪，应删除旧副本并使用重新生成的产物。
构建脚本回归检查：`cd redesign && npm run test:build`。

### 常见问题

- Tauri 报 `beforeDevCommand terminated with a non-zero status code`：先在 `redesign/ui/` 执行 `npm ci`，再运行 `npm run dev -- --host 127.0.0.1` 单独查看 Vite 的具体错误；确认 Node.js 版本满足 Vite 8 要求，并检查 5175 端口是否被占用。
- `vite` 命令找不到：通常是仅在 `redesign/` 安装了依赖，遗漏了 `redesign/ui/` 的 `npm ci`。
- `cargo-tauri` 未安装：用局部 CLI（`npx tauri ...`）即可，无需全局安装。
- dev 进程偶尔自行退出打印 `Failed to unregister class Chrome_WidgetWin_0`：
  已知无害，重跑 dev 即可。
- 前端改动即时热重载；Rust 改动由 tauri dev 自动重编译。

## Android

以下命令使用 **PowerShell**，从仓库根目录开始执行。

```powershell
# 1. 安装依赖并构建共享前端（产物进 redesign/ui/dist，Gradle 自动打包进 assets）
cd redesign/ui
npm ci
npm run build

# 2. 构建 APK
cd ../android
.\gradlew.bat assembleDebug          # 或 assembleRelease

# 3. 安装到设备
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

在 **Bash（Linux / macOS / Git Bash）** 中，前端构建和安装命令不变；构建 APK 时，在 `redesign/android/` 下先执行 `chmod +x gradlew`，再用 `./gradlew assembleDebug`（或 `./gradlew assembleRelease`）替代 `.\gradlew.bat` 命令。

- 国内网络：`android/settings.gradle.kts` 已内置阿里云镜像（dl.google.com 常不可达）。
- 修改了 Kotlin 壳 → 只需 `assembleDebug`（但前端改动必须**先**在 `redesign/ui/` 运行 `npm run build`）。
- 调试与正式包可同时构建：`.\gradlew.bat assembleDebug assembleRelease`。真机验收表见 [ANDROID.md](ANDROID.md)。
- 真机注意：MIUI/EMUI 的「USB 安装」与「悬浮窗权限」需到系统设置单独授权；
  重装 APK 会重置 appops 权限。

### 正式包（签名 release APK）

`android/keystore.properties`（不入库）指向 `keystore/aliyapet-release.jks`，
gradle 检测到该文件时 release 构建自动签名；缺失则出未签名包。

```powershell
cd redesign/android
.\gradlew.bat assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

**密钥必须备份**（`redesign/android/keystore/` + `keystore.properties`）：
丢失后无法为后续更新出同签名包，用户只能卸载重装（丢设置与 Misskey 授权）。
debug 与 release 签名不同，从 debug 覆盖装 release 前必须先卸载。

## 发布构建（GitHub Actions）

推送 `v*` 标签且指向 master 时，`.github/workflows/release.yml` 自动：
校验 tag 在 master 上且与各端包内版本一致 → 构建 Windows 安装包（NSIS + MSI，含应用内
更新所需的 `.sig` 签名产物）与 Android 签名 APK → Release 说明取自 `CHANGELOG.md`
对应版本小节 → 附到对应 tag 的 GitHub Release（也可在 Actions 页下载 artifact）。
完整发布说明（版本说明格式、强制更新标记、本地联调发布服务）见 [RELEASE.md](RELEASE.md)。

Android 签名需在仓库 Settings → Secrets and variables → Actions 配置：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `aliyapet-release.jks` 的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

Windows 更新签名（应用内一键更新校验安装包用，缺失时发布构建明确失败）另需：

| Secret | 内容 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `npx tauri signer generate` 产出的 minisign 私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码；密钥未设密码时留空 |

生成 base64（PowerShell）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("aliyapet-release.jks"))
```

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

可视化调试页在 `redesign/ui/tests/`（`npm run dev` 后直接访问）：
`visual-regression.html`（关键交互逐帧对照）、
`face-probe.html?transition=1`（表情切换逐帧）、
`face-probe.html?expressions=1`（12 种表情对照）。
