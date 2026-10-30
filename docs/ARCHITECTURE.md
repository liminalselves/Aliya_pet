# 架构

## 总览

重写版采用**共享 Web 内核 + 双端薄壳**：几乎全部功能与渲染逻辑都在
`redesign/ui/`（TypeScript）里实现一遍，Windows 与 Android 只是两个轻壳
（窗口/托盘/悬浮窗/系统集成）。业务实现共用，功能入口和生命周期由各壳接线。
Android 主界面承载完整互动，悬浮窗只承载基础互动，约束见 [ANDROID.md](ANDROID.md)。

```
        ┌────────────────────────────────────────────┐
        │             共享前端（ui/src/）              │
        │  platform.ts  ← 平台能力抽象│
        │  pet-app.ts     渲染循环 / 指针 / 窗口         │
        │  pet-model.ts   模型通道                      │
        │  interaction/   抚摸/程序式反应/点击          │
        │  dialogue/behavior/settings                  │
        └───────────────┬──────────────┬──────────────┘
                        │ WebView2     │ 系统 WebView
                  ┌─────▼─────┐  ┌─────▼─────┐
                  │ Tauri/Rust │  │ Kotlin    │
                  │ src-tauri/ │  │ android/  │
                  └───────────┘  └───────────┘
```

## 渲染层（官方 Cubism Web SDK 5-r.5）

- **Framework**（TypeScript）+ **Core** 6.0.1（wasm，内嵌于
  `live2dcubismcore.js`），取自 `third_party/cubism-web-sdk/`。
- Vite 别名 `@framework/*` 指向 `third_party/cubism-web-sdk/Framework/src`。
- WebGL2 画布，30fps 帧率上限（URL 参数 `?fps=N` 可调），
  Windows `preserveDrawingBuffer: true` 消除窗口缩放闪烁（Android 关闭，见 `ANDROID.md`）。
- 渲染暂停：后台/熄屏时停止渲染循环（`PetApp.setPaused`）。

## 布局与适配（与旧版对齐的两个关键算法）

### 1. 视口适配（包围盒 fit，替代官方 Demo 的 canvas fit）

官方 Demo 的画布适配会把 Aliya 的 1×1 方形画布缩到窗口的 ~44%，
观感与旧版不符（"压扁"）。重写版复刻旧版 `SetupModelMatrix` 的算法：

- 加载后计算 drawable 顶点包围盒 `boundsW/boundsH`（模型坐标）；
- 渲染比例 `s = 视口高 / 渲染余量 / boundsH`，模型原点居中；
- 投影 = 视口像素 → NDC（y 翻转）。
- 结果：角色高度占窗口的 `1/1.22`，包围盒内比例不变。

### 2. 动作余量

- **渲染余量 1.22**：当前模型与自编动作的测量依据由 [ACTIONS.md](ACTIONS.md)
  维护，更换模型/动作后需重新测量。
- **窗口余量 1.18**：窗口尺寸 = 675 × scale × 1.18（宽再乘包围盒宽高比），
  与旧版 `ComputeTargetPixelSize` 一致。

## 平台适配层（ui/src/platform.ts）

`platform.ts` 暴露统一系统能力；页面入口根据容器选择导航与布局：

| 能力               | tauri                                  | android                          | web        |
| ------------------ | -------------------------------------- | -------------------------------- | ---------- |
| 窗口/屏幕度量       | `@tauri-apps/api/window`               | `AndroidShell.getMetrics()`      | 不可用     |
| 窗口移动/改尺寸/定位 | `window.setPosition/setSize`（物理px） | `AndroidShell.moveWindowBy/...`  | 不可用     |
| 置顶               | `setAlwaysOnTop`                       | 悬浮窗天然置顶                    | 不可用     |
| 键盘与焦点          | 系统窗口自然聚焦                       | Activity + IME insets；悬浮窗不聚焦 | 浏览器处理 |
| 自启               | Rust `set_auto_start`（注册表）        | `AndroidShell.setAutoStart`      | 不可用     |
| openUrl           | Rust `open_url`                        | `AndroidShell.openUrl`           | `window.open` |
| 设置页→宠页通道     | `settings-changed` 事件                | `notifySettings` / `notifyPetAction` 壳桥转发 | 无 |

Android 桥（Kotlin `ShellBridge`）以 `addJavascriptInterface` 注入
`window.AndroidShell`；约束：窗口坐标/尺寸统一 CSS 像素，壳侧乘 density
换算物理像素。调试可用 `?platform=android` 在任意环境模拟 Android 模式。

## 指针与互动

- Pointer Events 驱动全部互动（桌面鼠标 + 触摸同一套逻辑）。
- **桌面**：右键 = 抚摸（Windows 约定）；左键拖动 = 移动窗口，单击 = 区域互动。
- **触摸端**：单指按头部抚摸区 = 抚摸；其余区域拖动 = 移动窗口（免右键）。
- 关键坑：canvas 必须 `touch-action: none`，否则触摸拖动被浏览器当作
  滚动手势吞掉（指针事件变 pointercancel）。

## Windows 辅助窗口

- `chat`、`settings`、`records`、`update` 都在 `tauri.conf.json` 随进程隐藏预创建；Windows
  命令线程不动态 `build()` 第二个 WebView2，避免已确认的死锁。
- `settings` 与 `records` 使用正常原生窗口，可移动、可调整大小；关闭请求被壳拦截
  为隐藏，下次打开保留页面实例。`chat` 仍是透明、无边框、锁定跟随 pet 的伴侣窗。
- `records` 单独承载服务器时间线与托管配置的消息定位，避免长列表改变聊天伴侣窗
  的几何和点击穿透契约。
- `update`（420×520）承载更新提示：pet 窗口透明穿透不能画 UI，检查结果经 Rust
  `show_update` 转交（事件 + 暂存兜底）。非强制时关闭即隐藏；强制更新关闭 =
  退出应用（`mandatory` 标记由壳保存，见 main.rs `UpdateWindowState`）。

## 应用内更新（ui/src/update/）

- 启动检查：模型就绪后延迟 3s 静默请求发布服务 `/api/check`（base 列表唯一来源
  `ui/src/update/config.ts`，按序回退）；失败/无更新不打扰。展示分叉：Windows 唤起
  `update` 窗口（updater 插件下载 + 验签 + NSIS passive 安装），Android 仅在主界面
  （非悬浮窗）弹页内 `<dialog>` 模态、按钮打开 APK 下载链接。
- 抑制策略：非强制提示支持「稍后」（本次启动）与「跳过此版本」（localStorage
  `aliya_pet_update_skip`）；强制更新（`mandatory`，服务端由 CHANGELOG 的
  `min-version` 注释推导）只能更新或退出。发布/签名/接口契约见 [RELEASE.md](RELEASE.md)。

## 设置同步

- 存储：localStorage（`aliya_pet_settings_v1`），同一 Android App 的多个
  WebView 共享 → `posX/posY`（CSS px）、scale、镜像、贴边、省电等。
- Windows 跨窗口同步：设置窗口 → pet 走 `settings-changed`，托盘 → pet 走
  `tray-action`，pet 广播回设置窗口（`pet-mood` 情绪同理）。Android 设置页
  与桌宠页是两个 WebView：设置经壳桥 `notifySettings` 实时转发，动作试放/
  表情/情绪经 `notifyPetAction` 转发到 `window.__pet.onShellAction`；情绪
  高亮由 pet 写共享 localStorage、设置页回前台刷新。

## 双端差异（壳层职责）

| 能力            | Windows（Tauri）                            | Android（Kotlin）                    |
| --------------- | ------------------------------------------- | ------------------------------------ |
| 窗口形态        | 透明无边框置顶小窗（512×768 基准）            | App 内全屏 / TYPE_APPLICATION_OVERLAY |
| 菜单            | 系统托盘；左右键均展开菜单，显隐由菜单项控制     | 右上角 ⋮ 菜单 + 通知按钮               |
| 悬浮窗触发      | 常驻小窗                                     | 退后台自动转悬浮窗（可关）             |
| 聊天            | `chat` 跟随 pet；`records` 为独立窗          | 主界面 ChatView + 记录/设置页面栈；悬浮无聊天 |
| 后台行为        | 常驻渲染                                     | 前台服务 + 通知；熄屏暂停              |
| 自启            | 注册表 Run 键                                | BootReceiver (+ 悬浮窗权限门槛)        |
