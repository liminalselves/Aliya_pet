# 更新记录

## 3.0.0（重写版：Tauri/Web + Android 薄壳）

由「Flutter + 自研 C++ 渲染」重写为「共享 Web 内核 + 双端薄壳」，
取代了旧版整条技术栈（旧实现保留在 flutter/、native/ 作参考）。

### 新架构

- **共享前端**（redesign/ui，TypeScript + 官方 Cubism Web SDK 5-r.5）：
  渲染（WebGL2）+ 抚摸/点击/程序式反应/对话/行为/设置全部前置。
- **Windows**：Tauri 壳（透明置顶窗口/托盘/自启/设置子窗口）。
- **Android**：Kotlin 薄壳（App 内全屏 + 退后台转悬浮窗），同一份前端。
- 平台适配集中在 `platform.ts`，双端功能天然对齐。

### 功能对齐（对照 2.x Flutter 版）

- 抚摸状态机、区域点击反应、连点冷却、快速拖动反应、
  视线跟随（含抚摸衰减）、自动动作、随机台词、每日互动状态、台词系统。
- 设置/缩放/位置/镜像/贴边/置顶/自启全量对齐；动作库暂以官方示例占位。

### 修复（本版较 2.x 显著改善）

- 官方渲染链路替代自研 C++ 内核，性能更稳（30fps 上限 ~0.7% 整机 CPU）。
- 「压扁」观感：复刻旧版包围盒适配算法（官方 canvas fit 会让角色缩到 44%）。
- 窗口缩放闪烁：`preserveDrawingBuffer` + 渲染帧内同步画布尺寸。
- 大动作裁切：渲染余量按占位动作实测提至 1.45（真动作接入后收紧）。

### Android 端

- MainActivity（App 内）+ PetOverlayService（前台服务 + 悬浮窗 + 通知）
  + ShellBridge JS 桥 + BootReceiver 自启 + 熄屏暂停。
- 真机验证：悬浮窗过渡/渲染/触摸/位置持久化/熄屏暂停全部通过；
  修复 Service 悬浮窗 WebGL 空白（需 FLAG_HARDWARE_ACCELERATED）与
  触摸拖动被滚动手势吞噬（canvas touch-action: none）。
- **悬浮窗透明区触摸穿透**：前端逐帧把包裹角色剪影的窗口矩形下发壳侧
  （setWindowRect），透明区域不属于任何窗口 → 触摸天然落到下层应用，
  不再出现"很大部分无法点击"。
- **悬浮窗允许半出屏**：FLAG_LAYOUT_NO_LIMITS + 前端 48px 防丢钳制，
  角色可贴屏幕边缘停靠。
- **UI 重新设计**：右上角圆形半透明菜单按钮 + 底部弹出菜单
  （设置/悬浮窗模式/关于/退出，矢量图标 + 说明文案，避让系统导航栏）；
  设置页移动端适配（顶栏返回、大字、大行高、大号开关与按钮）。
- **悬浮窗激活修复（真机复测）**：
  App 内全屏模式的拖动结束曾把窗口坐标 (0,0) 写进位置持久化，
  污染悬浮窗的角色原点 → 悬浮窗启动时角色整体落在屏幕左上外；
  现 App 内模式不再写位置，且 (0,0) 原点视为未设置走默认位。
  服务启动加 canDrawOverlays 守卫（无权限直接退出，不再崩溃）。
- **悬浮窗拖动重做（标准方案）**：壳侧 OnTouchListener 超 touchSlop 后按
  rawX/rawY 直接 updateViewLayout 搬运窗口（聊天头同款），全程不进 JS——
  无 IPC 延迟、无量化跳格，手指永远压在窗口上（触摸流不被下层抢走）；
  前端仅接收开始/结束回调做吸附与持久化。抚摸手势经桥接仲裁
  （setInteracting）：落在头部抚摸区的手势壳不抢。
- **松手/点击后抖动修复**：窗口矩形同步改为「包络跟踪」——目标矩形有边
  越出即并集扩大（单帧到位防裁切），完全收缩持续 400ms 后一次性收拢，
  另加 8px 迟滞；绝不逐帧追赶（每次重排有 1~3 帧 JS/native 生效错位，
  连续重排就是肉眼抽搐）。
- **悬浮窗台词气泡修复**：
  WebView 字体放大把 14px 抬到 17.5px（text-size-adjust 关闭）；
  left:50% 居中把可用宽度压成窗口右半导致窄列换行（改 margin auto 居中）；
  末页台词只闪 600ms 就消失（补齐按字数的完整阅读时长）；
  气泡出现时窗口向上扩高、消失时降回引起的表面重配残影/双影
  （窗口顶部永久预留 88px 气泡带，气泡出现/消失不再改窗口尺寸，
  气泡独立合成层 translateZ(0)）。
- **设置页新增「悬浮窗权限」状态行**：MIUI 等 ROM 默认拒绝该权限且
  覆盖安装会重置，未授予时显示「未授予」并可一键跳转系统授权页。

### Windows 端

- **透明区域鼠标穿透**：渲染帧 alpha 低频缩成 48 列占用掩码发 Rust
  命中线程（~8Hz，变化才发），壳侧轮询光标位置并按需切换
  set_ignore_cursor_events——只有落在角色不透明像素上才拦截鼠标，
  透明区域点击直达下层窗口；拖动/抚摸期间强制不透明判定，竞态由
  前端掩码兜底。

### 包名

- 双端统一标识：`top.liminalselves.aliyapet`
  （Tauri identifier = Android applicationId/namespace = Kotlin 包名）。

## 2.1.0（缩放机制重构 + 双端对齐）

### 缩放机制重构

- 新增 `ScalePolicy` 统一缩放策略（纯函数可单测）：绝对范围/滚轮倍率/档位/范围推导全部集中一处，替代分散在 main.dart 与 main_menu.dart 的重复常量与失同步逻辑。
- 统一缩放管线：滚轮、菜单滑块、双指捏合（新增）、档位按钮（新增）共用同一实时路径（夹紧 + 内存同步 + 窗口跟随）与同一提交路径（夹紧 + 应用 + 持久化并回传实际值）。
- 单位窗口尺寸（scale=1）在启动时、任何 setScale 之前一次性捕获，替代原先“当前目标尺寸 ÷ 当前 scale”的反推（状态失步时会算错设备范围）。
- 修复 Android 滑块拖动完全绕过范围夹紧与设置同步（拖到 8.0 时模型被裁掉 86%）。
- Android 应用内采用视口适配范围：上限保证模型主体不被固定视口裁切，下限保证模型不会缩到看不清。
- Windows 窗口物理像素量化保持中心不变，DPR 变化（跨屏拖动/系统缩放调整）自动重算范围并适配。

### Android 悬浮窗重做

- 悬浮窗尺寸随捏合缩放调整（原生 `resize` 通道 updateViewLayout），行为与 PC 窗口对齐；缩放范围由屏幕尺寸推导（与 PC 同一策略）。
- 修复悬浮窗把物理像素当逻辑坐标做命中归一化：高分屏（dpr=3）上命中区域整体偏移 3 倍，只有左上 1/3 可交互。
- 修复悬浮窗触摸被原生拖动拦截吞掉（超过 8px 移动即被消费），抚摸/拖动反应在悬浮窗中永远无法触发；现触摸全部透传 Flutter，窗口移动改由左上角拖动手柄驱动。
- 悬浮窗启动加载持久化设置（scale/镜像/自动动作），主 App 设置变更时经原生通道通知悬浮窗实时刷新。
- 修复悬浮窗“close”通道不返回结果（Dart 侧调用悬挂）。

### 修复

- 修复 Android 启动从不加载持久化设置（`SettingsService.load()` 仅在 Windows 分支调用）：缩放/镜像/自动动作重启后全部丢失。
- 修复镜像显示启动时从不应用（双端），且渲染画面从未真正翻转（仅命中区域/视线翻转）→ 显示层 Transform.flip 补齐，三者一致。
- 修复窗口被托盘隐藏后仍持续 24fps 渲染 + CPU 读回：隐藏期间暂停渲染。
- 修复 Android 上“项目仓库”点击无反应：新增原生 openUrl 通道（ACTION_VIEW），双端 About 页统一走宿主回调。
- 修复悬浮窗运行状态过期：悬浮窗被自身关闭按钮停止后主 App 不知情，打开菜单时以原生真实状态刷新。
- 设置持久化防御性消毒：损坏/越界/NaN 的 scale 读取与保存时回收进绝对范围。
- 移除死代码：LongPressService（从未被调用）、native kModelViewportMargin 常量。
- Android 菜单隐藏无效开关（置顶/贴边对应用内窗口无意义），悬浮窗开关移至设置页。

### UI / 性能

- 角色大小卡片新增 ± 步进按钮（与滚轮同倍率）与 小/标准/大 快捷档位（自动夹紧去重）。
- 菜单提示文案平台化（Windows 滚轮/右键抚摸，Android 捏合/触摸抚摸）。
- Android 高分屏渲染像素比封顶 2.0：清晰度提升的同时限制 CPU 读回/解码开销。
- 菜单 About 页补充二创 attribution。

## 2.0.0（Flutter 跨平台迁移）

### 架构

- 双代码库（C# WPF + Java/React）合并为单代码库：Flutter UI + Dart FFI + 自研 C++ 渲染内核。
- 渲染内核（`native/AliyaLive2D.Native`）单一源码双后端：Windows D3D11 / Android OpenGL ES 2.0，C ABI 导出。
- 离屏渲染 + CPU 读回（`CopyFramePixels`）→ Flutter 呈现，双平台渲染流程一致。
- 逻辑层（对话/摸头/嘴型/交互）全部移植为 Dart 服务，一套逻辑双平台。

### Windows

- Flutter 桌面版：透明无边框 + 置顶 + 屏幕吸附（window_manager）。
- 托盘图标/菜单（自动动作/随机台词/置顶/贴边/尺寸/位置重置/开机自启/关于/退出）。
- 鼠标滚轮缩放（0.5~3.0）、三档尺寸切换、拖动移动窗口（位移判定 + 系统拖动）。
- 设置持久化（位置/置顶/贴边/缩放/自动动作，shared_preferences）+ 开机自启（注册表 Run 键）。
- 关于对话框（版本 + 仓库地址）。
- 主菜单界面（双端通用）：动作列表/自动动作/尺寸/窗口设置/悬浮窗开关/关于；Windows 托盘入口 + 窗口悬停按钮，Android 右上角按钮。
- Impeller 兼容处理：RawImage + 透明窗口强制 Skia 渲染器。

### Android

- OpenGL ES 2.0 渲染：EGL + 离屏 FBO + 纹理上传 + CPU 读回。
- 悬浮窗前台服务（`PetOverlayService`）：独立 FlutterEngine（overlayMain 入口）承载角色，支持拖动与点击互动。
- 悬浮窗权限申请 / 开关（MainActivity 平台通道）。
- 双引擎并发：EGL 上下文进程级共享 + GL 全局互斥（Framework shader 单例与 EGL display 安全）。

### 修复与改进

- 修复 Flutter Impeller(Vulkan) 下 `toByteData` 返回全 0：改用纯 Dart `image` 包解码 PNG（含 4 通道转换）。
- 修复渲染器重建后纹理映射失效（占位纹理覆盖）：BindTextures 复用已有纹理。
- 修复纹理 mipmap 链缺失导致采样全 0：上传后 `glGenerateMipmap` + 采样器改 GL_LINEAR。
- 修复 Service 中 FlutterView 帧调度暂停：显式设置引擎 lifecycle resumed。
- 修复动作按钮无响应：动作改为点击即播、可互相打断，不再等待播完（移除 6s 轮询锁）。
- 修复动作从不播放（最终根因）：Live2DActionPlayer 未 Bind 动作库（library_ 为 null，Play 静默失败）→ 补 Bind(&actionLibrary_)。
- 修复动作通道未应用：仅头/身/嘴参数应用动作值，手臂/眉毛/眼睛/手/腿等通道从未写入 → 新增通用通道应用（ApplyRemainingActionChannels）。
- 修复“4 只手”视觉错误（真正根因）：Hiyori 手臂是两组互斥 ArtMesh（pose3.json 定义 PartArmA 举起组 / PartArmB 放下组，同时只显示一组），但我们从未加载/更新 pose3.json → 两组手臂同时渲染 → 每侧出现举起+放下两只手。修复：Load 阶段 LoadPose + 每帧 UpdatePose。
- 修复挥手时手抬不起来：pose 互斥切换由同名参数（PartArmA/B）驱动，动作未写 PartArmA → 举起组永不显示 → wave/stretch/drag/fall 动作新增 PartArmA 通道（=1 显示举起组，结束恢复默认 0）。
- 手臂动作参数值域对齐官方幅度（±10 内）+ 动作结束残留恢复（辅助优化）。
- 模型切换为 Hiyori（完整骨骼：手臂/手/腿），16 个动作重写含真实肢体动画；Aliya 可随时切回（`model_config.dart` 一处修改）。
- 修复 physics 虚拟参数索引越界崩溃：GetParameterIndex 返回的索引可能含 physics 输入参数（超出 Framework 参数数组），GetParameterId 调用前用 GetParameterCount 防御。

## 1.1.0

### Windows

- 新增动作调度与自动随机动作。
- 新增跳跃、摇摆、抖动、伸懒腰、点头、行走。
- 新增拖动倾斜反馈与屏幕边缘吸附。
- 新增鼠标滚轮缩放。
- 扩展右键菜单：动作、自动动作、贴边、镜像、尺寸、位置重置。
- 新增位置、尺寸、置顶、镜像和动作开关持久化。

### Android

- 新增跳跃、摇摆、抖动、伸懒腰、点头、旋转、行走。
- 新增自动随机动作。
- 新增点击、双击、拖动和长按手势。
- 新增拖动倾斜反馈与屏幕边缘吸附。
- 新增三档尺寸、角色镜像、位置重置。
- 新增通知栏随机动作和停止按钮。
- 新增位置、尺寸、镜像和自动动作开关持久化。
- 新增 Android 13+ 通知权限声明与请求。
