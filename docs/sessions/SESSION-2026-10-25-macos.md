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
2. 桌面交互：命中策略、Retina 坐标、窗口生命周期、菜单栏与测试（待实施）。
3. 系统能力：浏览器、登录自启、平台文案与失败回读测试（待实施）。
4. 集成验证：双架构包、使用文档、实际检查与剩余验收项（待实施）。

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

## 验收边界

自动化检查与实际 GUI 验收分开记录。不能用本机新系统上的成功构建，替代 macOS 14.4、Intel 真机或混合 DPI 多屏实测。CI 配置加入仓库不代表远程 CI 已执行。
