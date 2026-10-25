# macOS 支持实施记录

## 已确认的范围

- 基线：`201e1b8`，在 `mac` 分支实施。
- 最低 macOS 14.4；Apple Silicon / Intel Universal `.app` 和 `.dmg`。
- ad-hoc 签名测试版；菜单栏常驻、不常驻 Dock，宠物与聊天覆盖普通 Spaces。
- 实现透明窗口、像素穿透、视线跟随、拖动/贴边、聊天/设置、浏览器授权与登录自启。
- 共享 Web 内核与现有 Tauri 壳继续复用；不扩展到 App Store、公证或新的业务功能。
- 用户要求：补测试、验证后原子提交、工作留痕；本次不推送。

## 提交拆分与进度

1. 构建基础：平台配置、图标、打包校验和 macOS CI（已实现并通过本地脚本/编译测试；安装包与远程 CI 尚待验证）。
2. 桌面交互：命中策略、Retina 坐标、窗口生命周期、菜单栏与测试（已实现并通过 Rust/UI 回归测试；GUI 待验收）。
3. 系统能力：浏览器、登录自启、平台文案与失败回读测试（已实现并通过静态/单元测试；实际登录自启待验收）。
4. 集成验证：双架构包、使用文档、实际检查与剩余验收项（已完成构建与产物校验；GUI/跨版本验收待实施）。

### 已完成提交

- `f57c01c feat: 添加 macOS 通用包构建配置与打包测试`
- `7417e8d feat: 接入 macOS 桌面交互与系统能力`
- `7d3df5d docs: 记录 macOS 支持验收边界`
- `ac9a7a0 docs: 修正 macOS 自启架构说明`

## 验证记录

- 初始工作区干净；读取代码、调用方、现有测试和锁定依赖。
- `npm ci`（`redesign/`、`redesign/ui/`）成功。
- 本机为 Apple Silicon / macOS 26.2，Xcode 26.6，Homebrew Rust 1.98.0。
- 初始工具链仅有 `aarch64-apple-darwin` 标准库，`rustup` 不可用；Universal 构建前需补齐目标。
- 前端基线：`npm test` 164 项通过；`npm run build`（含 TypeScript）通过。
- 打包回归：`npm run test:mac` 12 项通过；Windows-helper 在真实临时目录下 13 项通过、7 项 Windows 专用测试按原条件跳过。
- 首次 `cargo test --locked` 因新增 PNG feature 需要更新锁文件而停止；随后正常解析新增依赖。
- 编译暴露 Tauri 2.11 的 manifest 检查只读取公共依赖、不合并 target features。按已安装源码确认根因后，将 macOS 专用透明开关与 Cargo feature 成对放到公共配置；PNG 解码仍是 macOS target 依赖。这是构建约束适配，不改变平台功能范围。
- 修正后 `cargo test --locked --quiet` 22 项通过（原生壳仍有待 macOS 接线的未使用变量警告，后续步骤处理）。
- 修正透明配置后重跑 `npm run test:mac`，12 项全部通过；`git diff --check` 通过。
- macOS 原生接线后：`cargo test --locked --quiet` 33 项通过，`cargo check --locked --quiet` 通过；共享 UI `npm test` 172 项通过，`npm run build` 通过。
- 新增桌面适配测试：macOS points/Retina/负坐标/工作区/事件/置顶错误传播 7 项通过；Control+主键抚摸及取消路径纳入点击回归。
- 工具链补齐前曾尝试 `npm run tauri -- build --target aarch64-apple-darwin --bundles app --no-sign`，因缺少 Rust target 失败；补齐 rustup/targets 后已重新完成原生与 Universal 构建。

## 尚未完成的实机门禁

- 尚未在 Intel Mac、macOS 14.4、混合 1x/2x 多屏、多个普通 Space、Stage Manager、全屏独占 Space 上启动并操作。
- 尚未验证 Finder 安装、ad-hoc Gatekeeper「Open Anyway」、菜单栏浅色/深色实际外观、登录项实际启动、Misskey 浏览器回调及中文输入法。
- CI workflow 已提交但未在 GitHub Actions 执行；不能将 workflow 配置视为远程构建通过。

## 工具链补齐记录（2026-10-25）

- 通过 Homebrew 安装 `rustup 1.29.2`；因 `rustup` 为 keg-only，在 `~/.zshrc` 增加
  `/opt/homebrew/opt/rustup/bin` 到 `PATH`。
- 安装并设为默认：`stable-aarch64-apple-darwin`，Rust `1.99.1`。
- 安装目标：`aarch64-apple-darwin`、`x86_64-apple-darwin`。
- `PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo test --locked --quiet`：33 项通过。
- `PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run tauri -- build --target aarch64-apple-darwin --bundles app`：Apple Silicon `.app` 构建成功。
- Apple Silicon `.app` 校验：`validate:mac --arch arm64` 通过，最低系统 14.4，ad-hoc 签名。
- `PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run build:mac`：Universal `.app` 和 `.dmg` 构建成功。
- Universal `.app` 校验：arm64 + x86_64、最低系统 14.4、ad-hoc 签名全部通过；`hdiutil verify` 校验 DMG 通过。

## 验收边界

自动化检查与实际 GUI 验收分开记录。不能用本机新系统上的成功构建，替代 macOS 14.4、Intel 真机或混合 DPI 多屏实测。CI 配置加入仓库不代表远程 CI 已执行。

## 本机安全验收记录（2026-10-26）

本轮只执行不会启动应用、不会安装到 `/Applications`、不会修改登录项或系统偏好的检查；明确跳过自启动测试。

- `redesign/ui`: `npm test` 172 项通过；`npm run build` 通过。
- `redesign/src-tauri`: `PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo test --locked --quiet` 33 项通过；`cargo check --locked --quiet` 通过。
- `redesign`: `npm run test:mac` 12 项通过；`TMPDIR=真实路径 npm run test:build` 13 项通过、7 项 Windows 专用测试跳过。
- Universal 产物：`npm run validate:mac -- ".../Aliya Pet.app"` 通过，确认 `arm64 + x86_64`、macOS 14.4、ad-hoc 签名。
- DMG：`hdiutil verify` 通过，checksum 有效。
- 未执行：应用 GUI 启动、`open`、复制到 Applications、登录自启/LaunchAgent、`launchctl`、Gatekeeper 放行、跨屏/Spaces/输入法实机操作。

## osascript 实机启动记录（2026-10-26）

用户授权启动已构建的 Universal `.app`，本轮使用 `/usr/bin/osascript` 控制，不执行自启动测试。

- 通过 Finder AppleScript 打开：`redesign/src-tauri/target/universal-apple-darwin/release/bundle/macos/Aliya Pet.app`。
- 启动等待 8 秒后，System Events 确认进程存在：`running=true`，应用窗口数 `1`，应用菜单项数 `7`。
- 读取到桌宠窗口：标题 `Aliya Pet`，尺寸 `512×768`；说明 WebView 窗口已创建。
- 读取到应用菜单包含 `About Aliya Pet`、`Hide Aliya Pet`、`Quit Aliya Pet` 等标准 macOS 菜单项。
- 通过 `tell application "Aliya Pet" to quit` 退出；退出后 `aliya-pet` 进程不存在。
- 未执行：登录自启、LaunchAgent、`launchctl`、安装到 Applications、Gatekeeper 放行、跨屏/Spaces/输入法验收。
