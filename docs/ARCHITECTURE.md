# 架构

## 总览

重写版采用**共享 Web 内核 + 双端薄壳**：几乎全部功能与渲染逻辑都在
`redesign/ui/`（TypeScript）里实现一遍，Windows 与 Android 只是两个轻壳
（窗口/托盘/悬浮窗/系统集成），因此双端功能天然对齐，没有两套实现。

```
        ┌────────────────────────────────────────────┐
        │             共享前端（ui/src/）              │
        │  platform.ts  ← 平台能力抽象（唯一的平台分叉点）│
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
  `preserveDrawingBuffer: true` 消除窗口缩放闪烁。
- 渲染暂停：后台/熄屏时停止渲染循环（`PetApp.setPaused`）。

## 布局与适配（与旧版对齐的两个关键算法）

### 1. 视口适配（包围盒 fit，替代官方 Demo 的 canvas fit）

官方 Demo 的画布适配会把 Aliya 的 1×1 方形画布缩到窗口的 ~44%，
观感与旧版不符（"压扁"）。重写版复刻旧版 `SetupModelMatrix` 的算法：

- 加载后计算 drawable 顶点包围盒 `boundsW/boundsH`（模型坐标）；
- 渲染比例 `s = 视口高 / 渲染余量 / boundsH`，模型原点居中；
- 投影 = 视口像素 → NDC（y 翻转）。
- 结果：角色高度占窗口的 `1/1.45`，包围盒内比例不变。

### 2. 动作余量

- **渲染余量 1.45**：占位动作（Hiyori）实测最大摆动超出旧版 1.18 余量，
  故按最差帧需求 ×1.05 安全余量取 1.45。真动作接入后需重新测量（见
  `docs/ACTIONS.md`）。
- **窗口余量 1.18**：窗口尺寸 = 675 × scale × 1.18（宽再乘包围盒宽高比），
  与旧版 `ComputeTargetPixelSize` 一致。

## 平台适配层（ui/src/platform.ts）

`platform.ts` 是前端唯一的平台分叉点，暴露统一能力：

| 能力               | tauri                                  | android                          | web        |
| ------------------ | -------------------------------------- | -------------------------------- | ---------- |
| 窗口/屏幕度量       | `@tauri-apps/api/window`               | `AndroidShell.getMetrics()`      | 不可用     |
| 窗口移动/改尺寸/定位 | `window.setPosition/setSize`（物理px） | `AndroidShell.moveWindowBy/...`  | 不可用     |
| 置顶               | `setAlwaysOnTop`                       | 悬浮窗天然置顶                    | 不可用     |
| 窗口焦点（软键盘）  | 系统窗口自然聚焦                        | `AndroidShell.setWindowFocusable` | 不可用    |
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
| 菜单            | 系统托盘                                     | 右上角 ⋮ 菜单 + 通知按钮               |
| 悬浮窗触发      | 常驻小窗                                     | 退后台自动转悬浮窗（可关）             |
| 聊天            | 独立原生窗口跟随 pet（chat_window.rs）        | 内嵌 ChatView：主界面默认展开；悬浮窗入口按钮 + 窗口矩形按内容态扩展（软键盘临时聚焦） |
| 后台行为        | 常驻渲染                                     | 前台服务 + 通知；熄屏暂停              |
| 自启            | 注册表 Run 键                                | BootReceiver (+ 悬浮窗权限门槛)        |
