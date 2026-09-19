# Android 壳设计

Android 端是共享前端的薄壳：Kotlin 提供窗口/系统能力，功能全部跑在前端
（同样的 `ui/src`，App 内与悬浮窗各一个 WebView 实例）。

## 形态

用户方案：**打开 App → App 内全屏互动桌宠；退出 App → 悬浮窗桌宠继续显示。**

- `MainActivity`：全屏透明 WebView 桌宠 + 右上角 ⋮ 菜单
  （设置 / 悬浮窗模式 / 关于 / 退出）。
- `PetOverlayService`：前台服务 + `WindowManager.TYPE_APPLICATION_OVERLAY`
  透明 WebView 悬浮窗 + 通知（打开 / 退出）。
- 生命周期：`onStop`（退后台）→ 若开启且已授权 → 启动悬浮窗服务；
  `onStart`（回前台）→ 停止悬浮窗服务。两容器互斥，避免双宠物。
- `BootReceiver`：开机/应用更新后按设置自启悬浮窗。

## 关键实现点

### 资源加载（WebViewAssetLoader）

`file://` 下 fetch 会被 CORS 拦死，故用 `WebViewAssetLoader` 把
`app/src/main/assets/pet/`（Gradle 从 `ui/dist` 自动拷贝）映射到
`https://appassets.androidplatform.net/`，同源的 fetch/XHR 正常。
同一 App 的多个 WebView 共享 localStorage。

### 悬浮窗 WebGL 必须硬件加速

Service 里经 WindowManager 添加的悬浮窗默认软件渲染，WebGL 输出全空：
`LayoutParams` 必须带 `FLAG_HARDWARE_ACCELERATED`，否则角色渲染白屏
（真机验证过的坑）。

### JS 桥（ShellBridge，`window.AndroidShell`）

仅暴露壳能力，所有坐标为 **CSS px**（壳侧 × density 转物理像素）：

```
getMetrics()      → {density, screenW/H, winX/Y, winW/H}   (同步 JSON)
moveWindowBy(dx,dy)   窗口增量移动（触摸拖动走这里）
setWindowSize(w,h)    按前端计算的比例/缩放设置
setWindowPos(x,y)     绝对定位（恢复位置/贴边/重置）
setAutoStart / isAutoStart / setPref / getPref / openUrl
shellAction(action)   open-main / open-settings / hide-overlay / exit
setWindowFocusable(b) 悬浮窗临时可聚焦（聊天软键盘需要窗口焦点）
notifySettings(json)  设置页全量设置 → 桌宠页实时应用
notifyPetAction(json) 设置页动作（动作试放/表情/情绪）→ 桌宠页 onShellAction
```

JS Interface 运行在 JavaBridge 线程，窗口操作内部回主线程。
`openUrl`/`shellAction` 在 Service 上下文自动带 NEW_TASK。

### 前端在 Android 上的行为

- `platform.ts` 检测到 `window.AndroidShell` → android 模式；触摸端
  （`isTouchDevice`）启用**单指按头部抚摸**（桌面是右键）。
- 缩放按屏幕钳制：`maxS = min(screenW/baseW, screenH/baseH)`；
  悬浮窗尺寸由前端 `applySettings` → `setWindowSize` 驱动。
- 位置持久化双向：前端存 `localStorage.posX/Y` + 壳侧
  `SharedPreferences petX/petY`（服务重启恢复位置用，存 CSS px）。
- 熄屏/亮屏由壳广播触发 `window.__pet.onShellEvent('screen-off/on')` →
  `setPaused(true/false)`，暂停渲染循环省电；设置页「省电模式」把帧率降为
  15fps。
- **聊天双形态**（与 PC 对齐，详见 `CHAT.md`）：主界面 ChatView 默认展开；
  悬浮窗默认收起、入口按钮常驻，聊天打开时窗口矩形按内容态向下扩展并
  钳回屏内，软键盘经 `setWindowFocusable` 临时聚焦 + 头不出屏的避让上移。
- **设置页**（App 内第二 WebView）经 `notifySettings` 实时下发设置、
  `notifyPetAction` 转发动作试放/表情/情绪到桌宠页；桌宠页把情绪写入共享
  localStorage `aliya_pet_mood`，设置页回前台时刷新高亮。

### MiAuth 回跳中转

deep link `aliyapet://miauth` 由 `AuthRelayActivity`（透明 noHistory）接住：
写入 `ShellPrefs.miauth_callback` 后立即退出。悬浮窗运行中保持现状（前端
500ms 轮询自取，授权原地完成，不会因为回前台拉起 MainActivity 而停掉
悬浮窗）；悬浮窗未运行（App 内授权）则照旧拉起 MainActivity。

## 权限与真机注意

- **SYSTEM_ALERT_WINDOW**：悬浮窗权限，必须用户系统设置开启；App 内切
  「悬浮窗模式」时引导。重装 APK 会重置授权。
- **POST_NOTIFICATIONS**（Android 13+）：前台服务通知可见性，运行时请求。
- 前台服务类型 `specialUse`（Manifest 已声明 subtype）。
- 多数验证可用 adb 完成；通知按钮等受 MIUI 限制无法用 adb 模拟时，手动测。

## 调试

见 `docs/BUILD.md`：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
后可用 `tools/cdp-eval-n.mjs` 同时检查 App 内页与悬浮窗页（两个 target）。
