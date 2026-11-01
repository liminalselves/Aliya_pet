# PR：人物透明度与完全穿透

## English PR title

Add pet opacity and native full click-through while preserving alpha hit testing

目标分支：`develop`。功能分支：`feat/pet-opacity-click-through`。不修改、合并或推送 `develop`。

## 中文 PR 描述

### 变更摘要

- 设置页新增“显示与穿透”：人物透明度滑块 0–100%、5% 步进、实时预览、百分比、恢复 100%，以及默认关闭的“人物完全穿透”开关。
- 透明度仅在人物 Canvas 合成阶段应用，不修改模型、纹理或 WebGL 帧缓冲中的 Alpha，不影响聊天、设置及独立台词气泡。
- Windows 使用现有 Rust/Tauri 命中线程的 pet 专属持久覆盖；关闭后回到原 Alpha Hit Mask，不发送整窗可交互命令。
- Android 复用原 WindowManager/WebView 桥接，完全穿透和 0% 时仅人物悬浮窗添加 `FLAG_NOT_TOUCHABLE`，主 Activity 保持可触摸。
- 沿用现有前端设置存储及跨窗口同步；Android 增加原生设置副本，在服务 addView 前恢复安全状态。
- Windows 托盘提供完全穿透开关、恢复 100% 和原有打开设置入口；Android 可从通知或桌面图标打开主界面恢复。

### 原实现审查与复用

#### Windows

`pet-app.ts` 的 `_maybeSendHitMask()` 定期从原始 WebGL Canvas 采样 Alpha，沿用镜像和舞台映射、固定阈值、变化去重及心跳；`_publishHitMask()` 在手势交接时发布已缓存的真实剪影。Rust 按 `pet`/`chat` 标签分别保存命中表，每约 16 ms 读取光标与当前原生窗口矩形，调用各自的 `set_ignore_cursor_events`。这不是 WM_NCHITTEST 子类化，也不是 SetWindowRgn。

`pet`、`chat`、`settings`、`records` 有独立顶层原生窗口；chat 的 owner 是 pet，而不是共享 HWND 或 WS_CHILD 子窗口。人物开关只能更新硬编码 `pet` 条目，不接受窗口标签参数。chat 继续使用自己的面板和输入框命中表，settings/records 不进入人物命中路径。

原命中机制在手势期间会临时锁定可交互，动态掩码陈旧时有既有可交互回退。本次不重写这些既有策略；新增的完全穿透覆盖优先于手势与 TTL，避免动画暂停或旧掩码回调重新捕获人物输入。

#### Android

原服务使用 `TYPE_APPLICATION_OVERLAY`、`FLAG_NOT_FOCUSABLE`、Alpha Hit Mask 和原生拖动。API 33+ 使用现有 `rootSurfaceControl.setTouchableRegion`；API 32 及以下保留透明 DOWN 后短暂添加 NOT_TOUCHABLE 的兼容路径。旧系统已经收到的第一次 DOWN 无法重新分发给后方应用，这是一项既有平台差异，不能描述成与 Windows 等价的逐像素透传。

继续复用 `ShellBridge`、`ShellPrefs`、设置通知、原生通知和 Activity 生命周期。无新权限或依赖，不修改独立气泡窗口的外观与透明度。

### 透明度、命中与恢复

- `petOpacity` 为 0–100，默认 100；`fullClickThrough` 默认 false。旧配置缺字段时保持原智能穿透，非法透明度回到可见默认值，数值限制在范围内并对齐 5% 步进。现有配置没有 `clickThroughMode`，不新增模式枚举。
- Canvas 的 CSS `opacity` 衰减合成结果中的预乘 RGB 和 Alpha；原 WebGL 的 `premultipliedAlpha: true`、纹理上传与渲染器预乘设置保持不变。采样 Canvas 像素不包含 CSS opacity，因此 50% 显示不会降低命中 Alpha 或改变阈值。
- 不使用 CSS pointer-events 模拟原生穿透。Windows 命令串行执行并去重；非零透明度滑动不增加原生命中调用。进入完全穿透时取消互动、拖动并释放指针捕获。
- 关闭完全穿透立即发布缓存真实剪影，原生继续按剪影判断透明格/人物格。若关闭时尚无有效新鲜剪影，临时保持穿透，直到下一份真实掩码到达；不会用全 1 矩形恢复命中，也不会用全 0 掩码代替持久模式。
- 0% 不论开关值均将人物悬浮窗安全降级为完全穿透；不修改用户保存的开关值。恢复到非零透明度后，按保存的开关决定是否恢复人物交互。Android 主 Activity 不进入整窗穿透，聊天入口和设置仍可操作。
- 初始化、模型重新加载和 WebGL 上下文恢复沿用当前设置；不因调节透明度或切换模式重新加载模型、重建窗口、上传纹理或重建 GPU 资源。

### Android 12+ 系统安全限制

`FLAG_NOT_TOUCHABLE` 不等于系统一定允许把触摸交给其他应用。API 31+ 根据原生 Window alpha 和同 UID 悬浮窗的组合遮挡度过滤不可信触摸，CSS 人物透明度不能替代这个检查。

本次在人物整窗不可触摸时读取 `InputManager.maximumObscuringOpacityForTouch`，限制人物 Window alpha（常见为 0.8，不硬编码阈值）；因此完全穿透时的实际视觉透明度可能比滑块值更低。系统阈值不可读取或非法时，安全隐藏人物窗口而不是保留看不见的输入阻挡。0% 也设置原生 alpha=0。关闭完全穿透后恢复 Window alpha=1 和原有命中区域。

独立 `DialogueBubbleWindow` 保持既有 alpha=1、NOT_TOUCHABLE，不随人物滑块变淡。因此 Android 12+ 在气泡自己的矩形或与人物重叠处，仍可能阻止触摸传给其他应用；本次无法同时承诺“气泡显示完全不变”和“任意不透明气泡下均可跨应用穿透”。这是系统/既有气泡设计的限制，必须在真机验证中单列，不声称已实现任意设备和任意不透明度透传。

### Windows 聊天隔离与既有拖动限制

人物命令不修改 chat 的样式、焦点、透明度或命中表，也不隐藏 chat。托盘→设置→打开聊天仍可在人物完全穿透时使用。

基线 `chat_window.rs` 明确将聊天窗口固定跟随人物，未提供独立聊天拖动。本次保留该架构，不顺带重构聊天拖动；“聊天窗口可独立拖动”未实现，不能作为已通过的验收项。重叠窗口、键盘焦点、消息发送和滚动仍需 Windows 实机端到端验证；自动化命中单元测试不能替代这些测试。

### 自动化验证结果

在本地 Windows 开发环境执行：

| 检查 | 命令 | 实际结果 |
| --- | --- | --- |
| 前端回归 | `cd redesign/ui && npm test` | 192/192 通过；含新增 5 项行为测试 |
| TypeScript/Vite | `cd redesign/ui && npm run build` | 类型检查及生产构建通过 |
| Rust | `cargo test --manifest-path redesign/src-tauri/Cargo.toml` | 28/28 通过；含 Windows 命中、TTL/切换与隔离测试 |
| Android | `cd redesign/android && ./gradlew :app:compileDebugKotlin :app:testPetDisplayPolicy :app:lintDebug -x copyWebAssets --offline --console=plain` | Kotlin、独立 JVM 策略回归、lint 均通过；未打包 APK、未执行设备测试 |
| 边界补充测试 | `cd redesign/ui && npm run test:bounds` | 失败：既有 VM 测试加载 `embed.ts` 时出现 `SyntaxError: Cannot use 'import.meta' outside a module` |
| 差异检查 | `git diff --check` | 通过 |

`test:bounds` 对应的 `tests/render-margin.test.mjs`、`src/embed.ts`、`src/pet-model.ts` 与 `origin/develop` 完全一致；未为绕过既有测试加载器问题而修改渲染、AA 或测试断言。Vite 的未来 configLoader/__dirname 警告、Undici 实验性代理警告，以及 AGP 8.9.0 对 compileSdk 36 的既有版本警告仍存在。

新增前端测试覆盖真实方法：五档 opacity 不改变原始 Alpha 剪影及阈值、模式切换释放 capture 并恢复点击、连续 20 次串行切换的最终状态、Android 主界面/悬浮窗隔离、旧配置与持久化。Android `testPetDisplayPolicy` 是无新增测试库的 JavaExec JVM 策略检查，覆盖 API 26/30/31/32/33/36、0%、系统阈值异常及旧定时器，不是仪器测试。

### 未验证的人工验收清单

以下均未执行真实设备端到端测试，不应标记为通过：

- Windows：100/75/50/25/0% 视觉边缘、颜色、动画和表达；原透明区点到后方应用；缩放/镜像/动作后透明区、拖动与抚摸；开启/关闭及快速切换；拖动中切换；托盘恢复；跨 DPI 多显示器；重启和 WebGL 上下文恢复。
- Windows 聊天：完全穿透时打开/关闭/重开；与人物重叠时点击、键盘焦点、输入/发送、菜单及滚动；人物状态不改变聊天窗口输入策略。独立拖动是上述既有缺口，而不是待宣称通过的测试。
- Android API 32 及以下：保留原透明 DOWN 兼容行为；不同透明度、开启/关闭与 0% 安全状态；超时恢复不覆盖完全穿透。
- Android API 33+：原掩码区域、完全穿透后的空触摸区域、关闭后恢复；主界面聊天及设置；通知/图标恢复；服务重启和后台恢复。
- Android API 31+：系统限制下后方应用是否收事件、系统 cap 引起的显示变化、独立台词气泡区域的组合遮挡限制。

### 修改文件

- `redesign/ui/src/settings.ts`：设置字段、默认值与旧配置归一化。
- `redesign/ui/src/settings-page.ts`：显示与穿透界面、说明和同步。
- `redesign/ui/src/pet-app.ts`：Canvas 合成透明度、手势清理、pet 原生状态串行同步与托盘操作。
- `redesign/ui/src/platform.ts`：Android bridge 类型。
- `redesign/ui/tests/click-feedback.test.mjs`：行为回归及指针捕获测试桩。
- `redesign/src-tauri/src/main.rs`：pet 持久覆盖、Alpha 恢复安全状态、托盘及单元测试。
- `redesign/android/app/src/main/java/top/liminalselves/aliyapet/MainActivity.kt`：主界面只同步持久化，不禁用 Activity 输入。
- `redesign/android/app/src/main/java/top/liminalselves/aliyapet/PetOverlayService.kt`：人物窗口策略、捕获取消及启动恢复。
- `redesign/android/app/src/main/java/top/liminalselves/aliyapet/ShellBridge.kt`：UI 线程桥接。
- `redesign/android/app/src/main/java/top/liminalselves/aliyapet/ShellPrefs.kt`：服务启动所需的原生设置副本。
- `redesign/android/app/src/main/java/top/liminalselves/aliyapet/PetDisplayPolicy.kt`：Android 系统安全策略。
- `redesign/android/app/src/test/java/top/liminalselves/aliyapet/PetDisplayPolicyTest.kt`：本地 JVM 策略回归。
- `redesign/android/app/build.gradle.kts`：可重复执行的策略测试任务，无新依赖。
- `docs/PET-DISPLAY-PR.md`：审查、PR 描述、证据及验收限制。

透明区采样系统、Live2D 模型资源、第三方 SDK、纹理过滤、裁剪遮罩、MSAA、DPR、CSS 基础渲染样式和 Tauri 窗口配置均未相对 develop 修改。

### 性能与风险

人物透明度只增加已有 Canvas 的合成属性，无逐帧新 IPC；原 Alpha 采样频率、网格与心跳不变。Windows 复用现有轮询线程，仅在状态变化时更新原生穿透；Android 仅在设置/兼容触摸策略变化时修改同一个窗口。未执行 FPS、CPU/GPU 的实机量化基准，不能声称零性能影响。

主要剩余风险是系统级端到端输入、Android 组合遮挡，以及基线不支持独立聊天拖动。既有智能模式的陈旧掩码回退和旧 Android 首次透明 DOWN 限制未被本次重写。应先完成以上人工验收再合并；不以本地自动化检查代替产品全量验收。
