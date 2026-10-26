# 构建与调试

## 依赖

| 组件 | 用途 | 说明 |
| ---- | ---- | ---- |
| Node.js `^20.19.0 || >=22.12.0` | 前端构建（Vite 8）；推荐 24 LTS | UI 源码在 `redesign/ui/` |
| Rust + cargo | Tauri 壳 | `redesign/src-tauri/` |
| macOS 14.4+ + Xcode Command Line Tools | macOS 原生测试及 Universal 打包 | `xcode-select --install`；需 Apple SDK、`lipo`、`codesign`、`ditto`、`hdiutil` |
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
- macOS 应用图标为 `redesign/src-tauri/icons/icon.icns`（含至 1024px 的 Retina 图像），`icon.png` 为 256×256 RGBA 通用图标。公共 `bundle.icon` 同时保留 PNG、ICNS 和 Windows ICO。
- macOS 菜单栏使用 `tray-template.png`（18×18）及 `tray-template@2x.png`（36×36），均为黑色 RGB + 透明 alpha 的 A 字模板。Rust 托盘必须设置 template 标志；原生图像的逻辑尺寸为 18pt，2x 资源不可当作 36pt 图标。应用彩图不能代替模板。
- 上述资源随仓库提供，正常构建无需 Python。需要重生成时，在已具备 Pillow 和 Apple `iconutil` 的 macOS 环境执行 `python3 redesign/scripts/generate-macos-icons.py`，随后执行 `npm --prefix redesign run test:mac`。素材来源为现有 `redesign/ui/assets/icon.png`，不需要私有文件。
- 仅预览现有模板（模拟浅/深色着色，含实际像素与放大图）可运行 `python3 redesign/scripts/generate-macos-icons.py --preview /tmp/aliya-macos-tray-preview.png`；不改写图标，不代替真实菜单栏截图。
- Android 启动图标位于 `res/mipmap-*`；自适应前景保留底图完整构图，缩放到 108dp 画布中央的 72dp 区域，由系统应用遮罩。通知小图标为 `res/drawable/ic_notification.xml` 的单色 A。
- 四个 Web 页面共用 `redesign/ui/assets/icon.png`。

## Windows（Tauri）

```bash
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
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run dev

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

## macOS（Tauri，14.4+ 测试版）

目标为 Apple Silicon + Intel 的 **Universal** 包，输出 ad-hoc 签名的 `.app` 和 `.dmg`。
该测试版没有 Developer ID 签名及 Apple 公证，不需要 Apple 证书或发布 secrets。
菜单栏入口与普通桌面 Spaces 行为由原生层实现；打包检查不能证明实际窗口行为。

### 配置与原生集成约定

- Tauri 自动把 `src-tauri/tauri.macos.conf.json` 合并到 `tauri.conf.json`：
  `targets: ["app", "dmg"]` 与 macOS 图标；公共配置中的 `macOS` 子项固定
  `minimumSystemVersion: "14.4"`、`signingIdentity: "-"`（Windows 构建忽略它），
  并启用 `app.macOSPrivateApi: true`（只作用于 macOS）。将最低版本放在公共配置是为了让
  直接运行 `cargo test` 的 `generate_context!()` 与 Tauri CLI 的平台合并结果一致。
- 合并采用 JSON Merge Patch：**数组整体替换**，不是逐元素合并。macOS overlay 不声明
  `app.windows`，完整继承 `pet`、`chat`、`settings`、`records` 四个窗口；`bundle.icon`
  则整体替换为 ICNS + PNG。修改 overlay 时不要只写一个窗口。
- Tauri 2.11 的 manifest 校验只检查公共 `tauri` 依赖，不合并 target dependency 的 features。
  因此公共依赖启用 `macos-private-api`，与公共 `app.macOSPrivateApi` 成对配置；该功能在
  Tauri 内部仅作用于 macOS。`image-png` 仍只在 macOS target 启用，用于解码模板 PNG。
- 菜单栏 template、18pt/Retina 尺寸、后台常驻及所有普通 Spaces 行为均需原生层接入和真机确认。

### 安装构建依赖与检查

以下命令从仓库根目录开始；需先具备 Node、Rust 和 Apple 开发工具：

```bash
# Homebrew Rust 与 rustup 冲突时，rustup 使用 keg-only 路径；只需安装一次。
brew install rustup
echo 'export PATH="/opt/homebrew/opt/rustup/bin:$PATH"' >> ~/.zshrc
exec zsh
rustup toolchain install stable --profile minimal
rustup default stable
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cd redesign
npm ci
npm ci --prefix ui

# Node 打包回归：合并、图像像素、Windows 配置、校验器；macOS 另用 iconutil 解码 ICNS
npm run test:mac
# Windows-helper 的模拟测试拒绝符号链接祖先；macOS 上先解析 /var 的真实路径
TMPDIR="$(node -p 'require("node:fs").realpathSync(require("node:os").tmpdir())')" npm run test:build
npm test --prefix ui

# Rust 的 generate_context! 可能需要 frontendDist，先构建共享前端
npm run build --prefix ui
MACOSX_DEPLOYMENT_TARGET=14.4 cargo test --locked --manifest-path src-tauri/Cargo.toml

# 自动构建前端，并分别编译两种架构，再合成 Universal .app / .dmg
MACOSX_DEPLOYMENT_TARGET=14.4 npm run build:mac
```

Rust 配置测试应通过 Tauri 生成的 context 获取配置，不要只反序列化
`include_str!("../tauri.conf.json")`，也不要把未合并的公共配置注入 `TAURI_CONFIG`。
例如测试四窗口时使用：

```rust
let context = tauri::generate_context!();
let labels: Vec<_> = context.config().app.windows.iter()
    .map(|window| window.label.as_str()).collect();
assert_eq!(labels, ["pet", "chat", "settings", "records"]);
```

在 macOS 上，`tauri-build` / codegen 自动读取平台 overlay；测试只生成 context，
无需启动 GUI 事件循环。原生配置测试与 Node 合并测试互相补充。

默认产物目录（自定义 `CARGO_TARGET_DIR` 时相应替换根目录）：

```text
redesign/src-tauri/target/universal-apple-darwin/release/bundle/
├── macos/Aliya Pet.app/
└── dmg/Aliya Pet_<version>_universal.dmg
```

### 校验与归档

在 `redesign/` 下：

```bash
bundle="src-tauri/target/universal-apple-darwin/release/bundle"
npm run validate:mac -- "$bundle/macos/Aliya Pet.app"
for dmg in "$bundle"/dmg/*.dmg; do hdiutil verify "$dmg"; done

version=$(node -p 'require("./src-tauri/tauri.conf.json").version')
ditto -c -k --sequesterRsrc --keepParent \
  "$bundle/macos/Aliya Pet.app" "$bundle/macos/AliyaPet_${version}_universal.app.zip"
```

`validate:mac` 真正执行 `plutil`、`lipo -archs` 与 `codesign`：
读取 `CFBundleExecutable`，要求 arm64 + x86_64 两个切片，深度严格验证整个 app 签名，
逐切片检查 `Signature=adhoc`，并要求 `LSMinimumSystemVersion` 为 `14.4`、bundle ID 与配置一致。
成功时输出 JSON 报告；工具失败、缺少切片、最低系统版本错误或签名不符均退出非零。
仅检查单架构开发产物时显式加 `--arch arm64` 或 `--arch x86_64`，默认始终要求 Universal。
此检查不等同于 Gatekeeper 公证检查，也不代替 14.4 真机运行测试。

`.app` 是目录，不能直接作为 GitHub Release 文件上传。先用上面的 `ditto` 命令生成
保留元数据的 `.app.zip`，再上传 ZIP 和 DMG；CI 还会解压 ZIP 并再次验证 app。

### 安装与 Gatekeeper

1. macOS 14.4+ 上打开 DMG，把 **Aliya Pet.app** 拖入「应用程序」；ZIP 则先用 Finder
   解压后移动到「应用程序」。从安装位置启动，完成复制后推出 DMG。
2. ad-hoc 测试包首次打开可能显示开发者无法验证或 Apple 无法检查。
   确认下载来源可信后，先尝试打开一次，再到 **系统设置 → 隐私与安全性 → 仍要打开
   （Open Anyway）**，确认此应用的例外并再次选择打开。
3. 保持 Gatekeeper 开启。若提示损坏、签名校验失败或恶意软件，重新获取完整产物并排查；
   不通过全局关闭安全机制或批量删除隔离属性绕过问题。
4. 真机验收至少覆盖菜单栏图标的浅色/深色及 Retina 外观、菜单打开设置/记录、退出、
   宠物和聊天窗口切换所有**普通 Spaces**、交互/拖动/透明区域，以及关闭辅助窗口后的常驻行为。
   Apple Silicon 和 Intel 均需实际运行；全屏独占 Space 的行为不在此测试版承诺范围内。

### macOS CI

`.github/workflows/macos.yml` 支持 `master` / `mac` 分支相关改动、PR、手动触发，
也被 release 工作流复用。原生矩阵为官方标准 runner `macos-15`（arm64）与
`macos-15-intel`（Intel）；标签在 2026-10-25 依据 GitHub hosted-runners 官方参考核对。
每个原生 job 执行打包脚本测试、前端测试/构建、对应架构 Rust 单元测试及 ad-hoc app 构建/验证。
两者通过后，在 arm64 runner 安装两个 Rust target 并构建 Universal，上传
`macos-universal` artifact（`.app.zip` + `.dmg`）。CI runner 的系统版本不是 14.4，
因此 CI 通过仍需补充最低系统版本及 GUI 验收。

官方参考：GitHub Docs 的 **GitHub-hosted runners reference**，Tauri v2 的
**Configuration / Platform-Specific Configuration** 与 **macOS Application Bundle**，
Apple Support 的 **Safely open apps on your Mac**（文章 102445）。

## Android

```bash
# 1. 安装依赖并构建共享前端（产物进 redesign/ui/dist，Gradle 自动打包进 assets）
cd redesign/ui
npm ci
npm run build

# 2. 构建 APK
cd ../android
gradlew.bat assembleDebug          # 或 assembleRelease

# 3. 安装到设备
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- 国内网络：`android/settings.gradle.kts` 已内置阿里云镜像（dl.google.com 常不可达）。
- 修改了 Kotlin 壳 → 只需 `assembleDebug`（但前端改动必须**先** `ui:build`）。
- 调试与正式包可同时构建：`gradlew.bat assembleDebug assembleRelease`。真机验收表见 [ANDROID.md](ANDROID.md)。
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

## 发布构建（GitHub Actions）

推送 `v*` 标签且指向 master 时，`.github/workflows/release.yml` 自动：
校验 tag 在 master 上且与各端包内版本一致 → 构建 Windows 安装包（NSIS + MSI）、
macOS Universal ad-hoc 测试包（`.app.zip` + `.dmg`）与 Android 签名 APK →
附到对应 tag 的 GitHub Release（也可在 Actions 页下载 artifact）。
发布 job 依赖三个平台全部成功；macOS 没有 Developer ID / 公证，不代表正式签名发行。

Android 签名需在仓库 Settings → Secrets and variables → Actions 配置：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `aliyapet-release.jks` 的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

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
