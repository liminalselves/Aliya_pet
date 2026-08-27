import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:desktop_multi_window/desktop_multi_window.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodCall, MethodChannel;
import 'package:screen_retriever/screen_retriever.dart';
import 'package:window_manager/window_manager.dart';

import 'live2d_view.dart';
import 'main_menu.dart';
import 'menu_window.dart';
import 'overlay_main.dart';
import 'pet_controller.dart';
import 'pet_stage.dart';
import 'services/desktop_tray_service.dart';
import 'services/desktop_window_manager.dart';
import 'services/global_gaze_tracker.dart';
import 'services/scale_policy.dart';
import 'services/settings_service.dart';
import 'startup_loading_view.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  if (Platform.isWindows) {
    // 多窗口：'menu' 参数表示当前引擎是独立菜单窗口。
    final current = await WindowController.fromCurrentEngine();
    if (current.arguments == 'menu' || current.arguments == 'menu:preload') {
      final autoShowMenu = current.arguments == 'menu';
      await windowManager.ensureInitialized();
      await windowManager.waitUntilReadyToShow(
        const WindowOptions(
          size: Size(440, 700),
          minimumSize: Size(380, 520),
          center: true,
          backgroundColor: Color(0xFF16151D),
          skipTaskbar: false,
          title: 'Aliya Pet · 菜单',
          titleBarStyle: TitleBarStyle.normal,
        ),
        () async {
          // 普通 Windows 窗口：保留系统标题栏/最小化/最大化/关闭按钮，
          // 不透明背景，不再使用桌宠那种透明无边框窗口。
          await windowManager.setSkipTaskbar(false);
          await windowManager.setResizable(true);
          await windowManager.setMinimizable(true);
          await windowManager.setMaximizable(true);
          await windowManager.setClosable(true);
          await windowManager.setTitleBarStyle(TitleBarStyle.normal);
          // 等 Flutter 首帧渲染完成后再显示，避免菜单窗口先白一下。
        },
      );

      // 预创建的菜单窗口保持隐藏，等主窗口调用 WindowController.show() 再显示；
      // 用户点击菜单时按需创建的窗口则在首帧完成后自动显示。
      if (autoShowMenu) {
        WidgetsBinding.instance.addPostFrameCallback((_) async {
          try {
            await windowManager.show();
            await windowManager.focus();
          } catch (_) {
            // 窗口尚未就绪时忽略本次显示。
          }
        });
      }
      runApp(const MenuWindowApp());
      return;
    }
  }

  // Windows 桌面窗口（透明无边框 + 置顶 + 屏幕吸附）
  if (Platform.isWindows) {
    await DesktopWindowManager.instance.initialize(
        width: 512, height: 768);
  }

  // 先让 Flutter 画出启动加载动画，再显示窗口，消除启动白屏/空白帧。
  if (Platform.isWindows) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      DesktopWindowManager.instance.show();
    });
  }
  runApp(const AliyaPetApp());
}

/// Android 悬浮窗独立引擎入口（PetOverlayService 经 DartEntrypoint "overlayMain" 启动）。
/// 必须定义在根库 main.dart：Flutter 引擎只在根库解析 entrypoint；@pragma 保证 release tree-shaking 保留。
@pragma('vm:entry-point')
Future<void> overlayMain() => overlayMainImpl();

class AliyaPetApp extends StatelessWidget {
  const AliyaPetApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Aliya Pet',
      debugShowCheckedModeBanner: false,
      home: HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  PetController? _controller;
  String? _status = '初始化中…';
  bool _ready = false;
  bool _overlayRunning = false;
  bool _showMenu = false;
  bool _hover = false;
  bool _menuPreloading = false;
  GlobalGazeTracker? _gazeTracker;

  static const _overlayChannel = MethodChannel('top.liminalselves.aliyapet/overlay');

  // 渲染视口（= 窗口逻辑尺寸）。Windows 上模型加载后按桌宠实际包围盒动态调整；
  // Android 应用内为固定逻辑视口（模型在视口内适配缩放）。
  int _viewportW = 512;
  int _viewportH = 768;

  /// Flutter 引擎 devicePixelRatio（逻辑 → 物理换算）。
  double _dpr = 1.0;

  /// scale=1 时的目标窗口单位尺寸（启动时在 native scale 仍为 1 的瞬间捕获）。
  /// Windows 为物理像素口径；Android 为逻辑口径（渲染像素比在换算中抵消）。
  ({double width, double height})? _unitTargetSize;

  /// 窗口/视口 resize 期间暂停 Live2D 渲染，避免中间态闪烁。
  bool _resizing = false;

  /// Windows 窗口被托盘隐藏期间暂停渲染（隐藏时 24fps 的渲染+读回纯属浪费）。
  bool _windowHidden = false;

  // M9 修复：预加载菜单定时器
  Timer? _preloadTimer;

  // 设备 scale 范围缓存（启动时计算，slider 实时缩放节流复用；DPR 变化时失效重算）。
  ({double min, double max})? _cachedScaleRange;

  /// 渲染像素比：Windows 为完整 DPR（窗口物理尺寸随 scale 调整）；
  /// Android 为 capped DPR（高分屏适度提升清晰度，同时限制 CPU 读回/解码开销）。
  double get _renderRatio =>
      Platform.isWindows ? _dpr : math.min(_dpr, 2.0);


  @override
  void initState() {
    super.initState();
    if (Platform.isWindows) {
      _menuChannel.setMethodCallHandler(_handleMenuCall);
    }
    _boot();
  }

  @override
  void dispose() {
    // M7/M9 修复：取消所有挂起的定时器，避免销毁后触发 native 操作。
    _dragTimer?.cancel();
    _dragTimer = null;
    _preloadTimer?.cancel();
    _preloadTimer = null;
    _scalePersistTimer?.cancel();
    _scalePersistTimer = null;
    // M8 修复：移除菜单通道 handler，避免访问已 dispose 的 controller。
    if (Platform.isWindows) {
      _menuChannel.setMethodCallHandler(null);
    }
    _gazeTracker?.dispose();
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _boot() async {
    final stopwatch = Stopwatch()..start();
    try {
      final controller = PetController(
          viewportWidth: _viewportW, viewportHeight: _viewportH);
      await controller.initialize();

      // 捕获 scale=1 的单位窗口尺寸：必须在任何 setScale 之前完成，
      // 此刻 native scale 必为初始值 1.0，modelTargetSize 即单位尺寸。
      _unitTargetSize = controller.host.modelTargetSize;

      // 双端都加载持久化设置（修复：Android 此前从不加载，
      // scale/镜像/自动动作在重启后全部丢失）。
      await SettingsService.instance.load();

      if (Platform.isWindows) {
        // 即使模型/着色器缓存已预热，也保证启动动画至少展示一小段时间，
        // 避免“加载动画一闪而过/像没显示”。
        const minLoadingDuration = Duration(milliseconds: 2400);
        final remaining = minLoadingDuration - stopwatch.elapsed;
        if (remaining > Duration.zero) {
          await Future<void>.delayed(remaining);
        }
      }

      await _applySettings(controller);

      if (Platform.isWindows) {
        await _fitWindowToModel(controller, clampToWorkArea: true);
        _initDesktopServices(controller);
      }
      if (!mounted) return;
      setState(() {
        _viewportW = controller.viewportWidth;
        _viewportH = controller.viewportHeight;
        _controller = controller;
        _ready = true;
      });
      if (Platform.isWindows) {
        // 全局视线跟随：无论鼠标在屏幕何处，宠物都看向鼠标方向
        final tracker = GlobalGazeTracker(controller.behavior);
        _gazeTracker = tracker;
        tracker.start();
        // 桌宠就绪 2 秒后，后台预创建隐藏的菜单窗口，首次点开菜单秒开。
        // M9 修复：保存定时器引用以便 dispose 时取消
        _preloadTimer = Timer(const Duration(seconds: 2), () {
          if (mounted) _preloadMenuWindow();
        });
      } else {
        // Android：悬浮窗可能随系统 START_STICKY 仍在运行，同步一次真实状态。
        _refreshOverlayState();
      }
    } catch (e, st) {
      debugPrint('启动失败: $e\n$st');
      _setStatus('启动失败: $e');
    }
  }

  double _currentDpr() {
    final dpr = WidgetsBinding.instance.platformDispatcher.views.isEmpty
        ? 1.0
        : WidgetsBinding.instance.platformDispatcher.views.first.devicePixelRatio;
    return dpr > 0 ? dpr : 1.0;
  }

  /// 按桌宠实际包围盒动态调整窗口尺寸与渲染视口，使窗口刚好容纳桌宠（Windows）。
  ///
  /// 实时缩放与启动/提交共用此路径；[clampToWorkArea] 仅在启动/提交时开启
  /// （实时缩放为性能跳过工作区查询，设备范围已在 scale 入口夹紧）。
  Future<void> _fitWindowToModel(PetController controller,
      {bool clampToWorkArea = false}) async {
    if (!Platform.isWindows) return;

    try {
      // modelTargetSize 返回的是物理像素（模型渲染尺寸 + 动作余量）。
      final target = controller.host.modelTargetSize;
      if (target.width < 8 || target.height < 8) return;

      final dpr = _dpr;
      // window_manager 与 Flutter 事件坐标都使用逻辑像素，因此这里要 / DPR。
      double logicalW = target.width / dpr;
      double logicalH = target.height / dpr;

      if (clampToWorkArea) {
        // 大桌宠不要超过主屏工作区（screen_retriever 返回逻辑像素）。
        try {
          final display = await screenRetriever.getPrimaryDisplay();
          final work = display.visibleSize ?? display.size;
          if (logicalW > work.width) logicalW = work.width;
          if (logicalH > work.height) logicalH = work.height;
        } catch (_) {
          // 取不到工作区就保持模型目标尺寸
        }
      }

      // window_manager 的 Windows 实现使用 static_cast<int>(logical * dpr)，
      // 因此这里统一换算成物理像素再量化，避免“尺寸没变但逻辑小数反复抖动”，
      // 导致每次滚轮都把窗口向左/向上推 1px。
      final desiredPhysicalW = math.max(8, (logicalW * dpr).floor());
      final desiredPhysicalH = math.max(8, (logicalH * dpr).floor());

      // controller/Live2DView 用逻辑尺寸（Flutter 事件坐标口径）
      controller.viewportWidth = logicalW.round();
      controller.viewportHeight = logicalH.round();

      Size? oldSize;
      Offset? oldPos;
      try {
        oldSize = await windowManager.getSize();
        oldPos = await windowManager.getPosition();
      } catch (_) {
        // 取不到旧窗口信息就只设置尺寸。
      }
      final hasOldSize = oldSize != null &&
          oldPos != null &&
          oldSize.width > 1 &&
          oldSize.height > 1;

      // 加 0.5 物理像素余量，避免浮点乘法误差导致 static_cast 少 1px。
      final setLogicalW = (desiredPhysicalW + 0.5) / dpr;
      final setLogicalH = (desiredPhysicalH + 0.5) / dpr;

      if (!hasOldSize) {
        await windowManager.setSize(Size(setLogicalW, setLogicalH));
        return;
      }

      final oldPhysicalW = (oldSize.width * dpr).round();
      final oldPhysicalH = (oldSize.height * dpr).round();

      // 物理尺寸没有变化：什么都不做，绝不重复 setSize/setPosition。
      if (oldPhysicalW == desiredPhysicalW && oldPhysicalH == desiredPhysicalH) {
        return;
      }

      await windowManager.setSize(Size(setLogicalW, setLogicalH));
      try {
        // 以物理像素差的一半保持窗口中心不变。
        await windowManager.setPosition(Offset(
          oldPos.dx + (oldPhysicalW - desiredPhysicalW) / (2 * dpr),
          oldPos.dy + (oldPhysicalH - desiredPhysicalH) / (2 * dpr),
        ));
      } catch (_) {
        // 位置微调失败不影响尺寸生效。
      }
    } catch (_) {
      // 尺寸调整失败则保持当前窗口
    }
  }

  /// 应用持久化设置（双端）：位置/置顶/贴边（Windows）+ 缩放/镜像/自动动作。
  Future<void> _applySettings(PetController controller) async {
    final s = SettingsService.instance;

    if (Platform.isWindows) {
      final wm = DesktopWindowManager.instance;
      if (s.windowX != null && s.windowY != null) {
        await wm.moveTo(s.windowX!, s.windowY!);
      }
      if (s.alwaysOnTop) {
        await wm.setAlwaysOnTop(true);
      }
      wm.snapToScreenEdges = s.snapEdges;
    }

    // 渲染像素比决定 native scale 换算（Android 高分渲染：native = 用户 × 比率）。
    _dpr = _currentDpr();
    controller.renderPixelRatio = Platform.isWindows ? 1.0 : _renderRatio;

    // 设备可用缩放范围（Windows 由屏幕工作区推导；Android 由固定视口适配推导）。
    final range = await _computeScaleRange(controller);
    _cachedScaleRange = range;

    // 保存的 scale 可能在其它屏幕/DPI/旧版本下保存，加载时夹紧到当前设备可用范围；
    // 夹紧结果回写，避免每次启动重复夹紧。
    final scale = ScalePolicy.clampToRange(s.scale, range);
    if (!ScalePolicy.sameValue(scale, s.scale)) {
      await SettingsService.instance.saveScale(scale);
    }
    controller.applyNativeScale(SettingsService.instance.scale);

    // 镜像/自动动作双端生效（修复：此前镜像设置启动时从不应用）。
    controller.setMirrored(s.mirror);
    controller.behavior.autoActions = s.autoActions;
  }

  void _initDesktopServices(PetController controller) {
    final tray = DesktopTrayService.instance;
    tray.onQuit = () => DesktopWindowManager.instance.quit();
    tray.onToggleVisibility = () async {
      final visible = await windowManager.isVisible();
      if (visible) {
        await windowManager.hide();
      } else {
        await windowManager.show();
      }
      // 隐藏期间暂停渲染（paused 保持最后一帧），避免不可见时的无效渲染+读回。
      if (mounted) setState(() => _windowHidden = visible);
    };
    tray.onToggleAlwaysOnTop = () async {
      final wm = DesktopWindowManager.instance;
      await wm.setAlwaysOnTop(!wm.isAlwaysOnTop);
      await SettingsService.instance.saveAlwaysOnTop(wm.isAlwaysOnTop);
      await tray.updateAlwaysOnTopMenu(wm.isAlwaysOnTop);
    };
    tray.onCycleSize = _cycleSize;
    tray.onResetPosition = _resetPosition;
    tray.onShowAbout = _showAboutDialog;
    tray.onShowMainMenu = _openMenuWindow;
    tray.initialize();
  }

  /// 提交缩放互斥：托盘/菜单/档位循环同时触发时只执行一个。
  bool _commitBusy = false;

  /// 同步暂停状态：先提交一帧 paused，再改 Native scale。
  ///
  /// 不能只 setState(_resizing=true) 就立刻 setScale：下一帧 Live2DView 的
  /// Ticker 会在 build 生效前先跑一帧，用“新 scale + 旧 viewport”渲染，
  /// 视觉上就是放大时先大后小、缩小时先小后大。
  Future<void> _setResizing(bool value) async {
    if (_resizing == value || !mounted) return;
    setState(() => _resizing = value);
    await WidgetsBinding.instance.endOfFrame;
  }

  /// 当前设备允许的 scale 范围（统一策略见 [ScalePolicy]）。
  ///
  /// 单位尺寸来自启动时捕获的 [_unitTargetSize]（scale=1 的目标尺寸），
  /// 不再依赖“当前目标尺寸 ÷ 当前 scale”的反推（该反推在 scale 状态
  /// 与 native 失步时会算错范围）。
  Future<({double min, double max})> _computeScaleRange(
      PetController controller) async {
    const fallback = (min: ScalePolicy.absoluteMin, max: ScalePolicy.absoluteMax);
    final unit = _unitTargetSize;
    if (unit == null || unit.width < 8 || unit.height < 8) return fallback;

    if (Platform.isWindows) {
      // 窗口随 scale 调整：上限保证窗口完整落在主屏工作区内，
      // 下限保证窗口不小于最小可交互尺寸。
      try {
        final display = await screenRetriever.getPrimaryDisplay();
        final work = display.visibleSize ?? display.size;
        return ScalePolicy.workAreaRange(
          unitW: unit.width,
          unitH: unit.height,
          workW: work.width,
          workH: work.height,
          dpr: _dpr,
        );
      } catch (_) {
        return fallback;
      }
    }

    // Android 应用内：视口固定，scale 只改变模型在视口内的大小。
    // 范围保证模型不被裁切、也不会缩到看不清。
    return ScalePolicy.viewportFitRange(
      unitW: unit.width,
      unitH: unit.height,
      viewportW: _viewportW.toDouble(),
      viewportH: _viewportH.toDouble(),
    );
  }

  /// 获取缓存的设备范围；未缓存（异常路径）则现算并缓存。
  Future<({double min, double max})> _scaleRangeOf(
      PetController controller) async {
    final cached = _cachedScaleRange;
    if (cached != null) return cached;
    final range = await _computeScaleRange(controller);
    _cachedScaleRange = range;
    return range;
  }

  /// 档位循环切换尺寸（托盘/快捷键/菜单档位按钮共用）。
  Future<void> _cycleSize() async {
    final controller = _controller;
    if (controller == null || _commitBusy) return;
    try {
      final range = await _scaleRangeOf(controller);
      final next = ScalePolicy.nextPreset(
        SettingsService.instance.scale,
        min: range.min,
        max: range.max,
      );
      await _commitScale(next);
    } catch (e) {
      debugPrint('切换桌宠尺寸失败: $e');
    }
  }

  /// 统一实时缩放：滚轮 / 滑块拖动 / 双指捏合共用。
  ///
  /// 只改 Native scale（+ Windows 窗口尺寸跟随），不落盘；
  /// 不暂停渲染，让渲染循环自然跟随，避免拖动/滚动时反复暂停/恢复导致的卡顿。
  bool _liveScaleBusy = false;
  Future<void> _setScaleLive(double scale) async {
    final controller = _controller;
    if (controller == null || !mounted || _liveScaleBusy) return;
    _liveScaleBusy = true;
    try {
      final range = await _scaleRangeOf(controller);
      final next = ScalePolicy.clampToRange(scale, range);

      // 直接改 Native scale（实时跟随，不暂停渲染）。
      controller.applyNativeScale(next);
      // 同步内存中的运行时 scale（不写盘）：滚轮累乘与菜单滑块读取都依赖它。
      SettingsService.instance.scale = next;

      // Windows：窗口尺寸实时跟随（保持中心不变）。
      // Android：视口固定，模型在视口内缩放，无需额外处理。
      if (Platform.isWindows) {
        await _fitWindowToModel(controller);
        if (mounted) {
          setState(() {
            _viewportW = controller.viewportWidth;
            _viewportH = controller.viewportHeight;
          });
        }
      }
    } catch (_) {
      // 实时缩放失败忽略，松手后的提交会兜底。
    } finally {
      _liveScaleBusy = false;
    }
  }

  /// 统一提交缩放：滑块松手 / 菜单 setScale / 档位切换共用。
  /// 夹紧到设备范围 → 应用（Windows 暂停一帧防闪烁 + 窗口适配）→ 持久化。
  /// 返回实际生效的 scale（供菜单同步滑块位置）。
  Future<double> _commitScale(double scale) async {
    final controller = _controller;
    if (controller == null) return SettingsService.instance.scale;
    if (_commitBusy) return SettingsService.instance.scale;
    _commitBusy = true;
    try {
      final range = await _scaleRangeOf(controller);
      final next = ScalePolicy.clampToRange(scale, range);

      if (Platform.isWindows) {
        await _setResizing(true);
        controller.applyNativeScale(next);
        await SettingsService.instance.saveScale(next);
        await _fitWindowToModel(controller, clampToWorkArea: true);
        _resizing = false;
        if (mounted) {
          setState(() {
            _viewportW = controller.viewportWidth;
            _viewportH = controller.viewportHeight;
          });
        }
      } else {
        controller.applyNativeScale(next);
        await SettingsService.instance.saveScale(next);
      }
      return next;
    } catch (e) {
      debugPrint('设置桌宠尺寸失败: $e');
      _resizing = false;
      return SettingsService.instance.scale;
    } finally {
      _commitBusy = false;
    }
  }

  /// 防抖持久化：滚轮/捏合等高频实时缩放停止 300ms 后落盘一次，避免高频写盘。
  Timer? _scalePersistTimer;
  void _persistScaleDebounced() {
    _scalePersistTimer?.cancel();
    _scalePersistTimer = Timer(const Duration(milliseconds: 300), () async {
      if (!mounted) return;
      await SettingsService.instance.saveScale(SettingsService.instance.scale);
      _notifyOverlaySettings();
    });
  }

  /// Android：主 App 设置变更后通知悬浮窗引擎重新加载
  ///（悬浮窗是独立 Flutter 引擎，与主 App 不共享内存状态）。
  void _notifyOverlaySettings() {
    if (!Platform.isAndroid || !_overlayRunning) return;
    try {
      _overlayChannel.invokeMethod('notifyOverlaySettings');
    } catch (_) {
      // 通道不可用则忽略（悬浮窗下次启动时仍会读取最新设置）。
    }
  }

  Future<void> _resetPosition() async {
    final wm = DesktopWindowManager.instance;
    final display = await screenRetriever.getPrimaryDisplay();
    final size = await windowManager.getSize();
    await wm.moveTo(
      (display.size.width - size.width) / 2,
      (display.size.height - size.height) / 2,
    );
  }

  /// 滚轮缩放：与 slider/捏合共用实时路径，避免暂停/恢复渲染导致的中间态跳变。
  /// 滚动停止 300ms 后自动持久化一次，避免高频写盘。
  Future<void> _onWheelZoom(double dy) async {
    if (_controller == null || !mounted) return;

    final factor =
        dy > 0 ? ScalePolicy.stepFactor : 1 / ScalePolicy.stepFactor;
    await _setScaleLive(SettingsService.instance.scale * factor);
    _persistScaleDebounced();
  }

  // ---------- 双指捏合缩放（Android 触屏 / Windows 触控屏） ----------

  /// 捏合开始时的基准 scale（捏合期间的比例都相对它计算，避免累乘漂移）。
  double? _pinchBaseScale;

  void _onPinchStart() {
    _pinchBaseScale = SettingsService.instance.scale;
  }

  void _onPinchScale(double ratio) {
    final base = _pinchBaseScale;
    if (base == null || !mounted) return;
    _setScaleLive(base * ratio);
  }

  void _onPinchEnd() {
    _pinchBaseScale = null;
    if (!mounted) return;
    _persistScaleDebounced();
  }

  /// DPR 变化（拖动到另一块屏/系统缩放调整）：范围失效重算 + 窗口/渲染适配。
  Future<void> _onDprChanged(double dpr) async {
    final controller = _controller;
    if (controller == null || !mounted || !_ready) return;
    if ((dpr - _dpr).abs() <= 0.001) return;
    _dpr = dpr;

    if (!Platform.isWindows) {
      // Android：渲染像素比变化 → 按新比率重设 native scale 并重建渲染缓冲。
      controller.renderPixelRatio = _renderRatio;
      controller.applyNativeScale(SettingsService.instance.scale);
      if (mounted) setState(() {});
      return;
    }

    _cachedScaleRange = null;
    final range = await _scaleRangeOf(controller);
    final clamped = ScalePolicy.clampToRange(SettingsService.instance.scale, range);
    if (!ScalePolicy.sameValue(clamped, SettingsService.instance.scale)) {
      await _commitScale(clamped); // 内含窗口适配
    } else {
      await _fitWindowToModel(controller, clampToWorkArea: true);
      if (mounted) {
        setState(() {
          _viewportW = controller.viewportWidth;
          _viewportH = controller.viewportHeight;
        });
      }
    }
  }

  /// Windows：打开独立菜单窗口（不影响桌宠主窗口）。
  Future<void> _openMenuWindow() async {
    try {
      final windows = await WindowController.getAll();
      for (final w in windows) {
        if (w.arguments == 'menu' || w.arguments == 'menu:preload') {
          await w.show();
          return;
        }
      }
      // 预创建还没完成（或用户 2 秒内就点了菜单）：按需创建并自动显示。
      await WindowController.create(const WindowConfiguration(arguments: 'menu'));
    } catch (e) {
      debugPrint('打开菜单窗口失败: $e');
    }
  }

  /// 后台预创建隐藏菜单窗口：复用引擎，避免每次打开菜单都重新创建窗口。
  Future<void> _preloadMenuWindow() async {
    if (_menuPreloading) return;
    _menuPreloading = true;
    try {
      final windows = await WindowController.getAll();
      final hasMenu = windows.any(
          (w) => w.arguments == 'menu' || w.arguments == 'menu:preload');
      if (hasMenu) return;
      await WindowController.create(
          const WindowConfiguration(arguments: 'menu:preload'));
    } catch (e) {
      debugPrint('预创建菜单窗口失败: $e');
    } finally {
      _menuPreloading = false;
    }
  }

  /// 主窗口菜单通道：接收独立菜单窗口的调用。
  static const _menuChannel = WindowMethodChannel(
    'top.liminalselves.aliyapet/menu',
    mode: ChannelMode.unidirectional,
  );

  Future<dynamic> _handleMenuCall(MethodCall call) async {
    final controller = _controller;
    try {
      switch (call.method) {
        case 'getState':
          final range = controller != null
              ? await _scaleRangeOf(controller)
              : (min: ScalePolicy.absoluteMin, max: ScalePolicy.absoluteMax);
          return <String, dynamic>{
            'autoActions': controller?.behavior.autoActions ?? true,
            'alwaysOnTop': DesktopWindowManager.instance.isAlwaysOnTop,
            'snapEdges': DesktopWindowManager.instance.snapToScreenEdges,
            'autoStart': await SettingsService.instance.autoStartEnabled(),
            'mirror': controller?.isMirrored ?? false,
            'overlayRunning': _overlayRunning,
            'scale': SettingsService.instance.scale,
            'scaleMin': range.min,
            'scaleMax': range.max,
          };
        case 'playAction':
          final name = (call.arguments as Map?)?['name'] as String? ?? '';
          if (name.isNotEmpty) controller?.behavior.playAction(name);
          return null;
        case 'randomActionName':
          return controller?.behavior.randomActionName() ?? 'idle';
        case 'setScale':
          final v = (call.arguments as Map?)?['value'] as num? ?? 1.0;
          final actual = await _commitScale(v.toDouble());
          // 回传夹紧后的实际 scale，让菜单窗口同步滑块位置。
          return <String, dynamic>{'scale': actual};
        case 'setScaleLive':
          final v = (call.arguments as Map?)?['value'] as num? ?? 1.0;
          _setScaleLive(v.toDouble());
          return null;
        case 'resetPosition':
          await _resetPosition();
          return null;
        case 'setAlwaysOnTop':
          final v = (call.arguments as Map?)?['value'] as bool? ?? false;
          await _setAlwaysOnTop(v);
          return null;
        case 'setSnapEdges':
          final v = (call.arguments as Map?)?['value'] as bool? ?? false;
          DesktopWindowManager.instance.snapToScreenEdges = v;
          await SettingsService.instance.saveSnapEdges(v);
          return null;
        case 'setAutoStart':
          final v = (call.arguments as Map?)?['value'] as bool? ?? false;
          await SettingsService.instance.setAutoStart(v);
          return null;
        case 'setAutoActions':
          final v = (call.arguments as Map?)?['value'] as bool? ?? true;
          if (controller != null) {
            controller.behavior.autoActions = v;
            await SettingsService.instance.saveAutoActions(v);
          }
          return null;
        case 'setMirror':
          final v = (call.arguments as Map?)?['value'] as bool? ?? false;
          controller?.setMirrored(v);
          await SettingsService.instance.saveMirror(v);
          return null;
        case 'toggleOverlay':
          await _toggleOverlay();
          return null;
        case 'showAbout':
          _showAboutDialog();
          return null;
        case 'openRepository':
          await _openRepositoryUrl();
          return null;
        default:
          return null;
      }
    } catch (e) {
      debugPrint('菜单通道处理失败: $e');
      return null;
    }
  }

  Future<void> _setAlwaysOnTop(bool on) async {
    final wm = DesktopWindowManager.instance;
    await wm.setAlwaysOnTop(on);
    await SettingsService.instance.saveAlwaysOnTop(on);
    await DesktopTrayService.instance.updateAlwaysOnTopMenu(on);
  }

  /// 在系统默认浏览器中打开项目仓库。
  /// Windows 用 explorer；Android 经原生通道发 ACTION_VIEW Intent（无需额外插件）。
  Future<void> _openRepositoryUrl() async {
    const url = 'https://github.com/liminalselves/Aliya_pet';
    try {
      if (Platform.isWindows) {
        await Process.start('explorer', [url], mode: ProcessStartMode.detached);
      } else if (Platform.isAndroid) {
        await _overlayChannel
            .invokeMethod<bool>('openUrl', {'url': url});
      }
    } catch (e) {
      debugPrint('打开项目仓库失败: $e');
    }
  }

  void _showAboutDialog() {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF1A1A1A),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: const BorderSide(color: Color(0xFF2A2A2A), width: 1),
        ),
        title: const Row(
          children: [
            Icon(Icons.pets, color: Color(0xFF0A84FF), size: 24),
            SizedBox(width: 12),
            Text(
              'Aliya Pet',
              style: TextStyle(color: Colors.white, fontSize: 20),
            ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '跨平台桌面宠物（Flutter + Live2D Cubism）',
              style: TextStyle(color: Color(0xFF999999), fontSize: 14),
            ),
            const SizedBox(height: 8),
            const Text(
              '本程序为二创作品，人物原创为《彼方的她》',
              style: TextStyle(color: Color(0xFF666666), fontSize: 12),
            ),
            const SizedBox(height: 16),
            const Text(
              '版本：2.0.0',
              style: TextStyle(color: Color(0xFF666666), fontSize: 13),
            ),
            const SizedBox(height: 8),
            GestureDetector(
              onTap: () {
                Navigator.pop(ctx);
                _openRepositoryUrl();
              },
              child: const Text(
                'https://github.com/liminalselves/Aliya_pet',
                style: TextStyle(
                  color: Color(0xFF0A84FF),
                  fontSize: 13,
                  decoration: TextDecoration.underline,
                ),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            style: TextButton.styleFrom(
              foregroundColor: Colors.white,
            ),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  // ---------- 窗口拖动（按下后位移超阈值或停留 250ms 启动系统拖动） ----------

  Timer? _dragTimer;
  Offset? _dragDownGlobal;

  void _onStageDragDown(Offset globalPos) {
    _dragTimer?.cancel();
    _dragDownGlobal = globalPos;
    _dragTimer = Timer(const Duration(milliseconds: 250), () {
      _dragTimer = null;
      _startWindowDrag();
    });
  }

  void _onStageDragMove(Offset globalPos) {
    final down = _dragDownGlobal;
    if (down == null) return;
    if ((globalPos - down).distance > 8) {
      _dragTimer?.cancel();
      _dragTimer = null;
      _dragDownGlobal = null;
      _startWindowDrag();
    }
  }

  void _onStageDragUp() {
    _dragTimer?.cancel();
    _dragTimer = null;
    _dragDownGlobal = null;
  }

  /// 启动系统窗口拖动；结束后吸附屏幕边缘并持久化位置。
  Future<void> _startWindowDrag() async {
    // M7 修复：定时器回调可能在销毁后触发，先检查 mounted
    if (!mounted || !Platform.isWindows) return;
    try {
      final wm = DesktopWindowManager.instance;
      await wm.startDragging();
      await wm.onDragEnd();
      final pos = await windowManager.getPosition();
      await SettingsService.instance.savePosition(pos.dx, pos.dy);
    } catch (_) {
      // 窗口管理器暂不可用：拖动失败不影响其他交互。
    }
  }

  void _setStatus(String s) {
    if (!mounted) return;
    setState(() => _status = s);
  }

  Future<void> _toggleOverlay() async {
    final controller = _controller;
    if (controller == null) return;
    try {
      if (_overlayRunning) {
        await _overlayChannel.invokeMethod('stopOverlay');
        // H2 修复：await 后检查 mounted，避免 setState after dispose
        if (!mounted) return;
        setState(() => _overlayRunning = false);
        return;
      }
      final hasPermission =
          await _overlayChannel.invokeMethod<bool>('hasOverlayPermission');
      if (hasPermission != true) {
        await _overlayChannel.invokeMethod('requestOverlayPermission');
        return;
      }
      final ok = await _overlayChannel.invokeMethod<bool>('startOverlay');
      // H2 修复：await 后检查 mounted
      if (!mounted) return;
      if (ok == true) {
        setState(() => _overlayRunning = true);
      }
    } catch (_) {
      // 非 Android 或通道不可用，忽略
    }
  }

  /// 从原生侧同步悬浮窗真实运行状态。
  /// 悬浮窗可被自身关闭按钮/系统回收停止，本地布尔会过期，
  /// 因此每次打开菜单时都以原生状态为准刷新一次。
  Future<void> _refreshOverlayState() async {
    if (!Platform.isAndroid) return;
    try {
      final running =
          await _overlayChannel.invokeMethod<bool>('isOverlayRunning');
      if (mounted && running != null && running != _overlayRunning) {
        setState(() => _overlayRunning = running);
      }
    } catch (_) {
      // 通道不可用则保持现状。
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    final isWindows = Platform.isWindows;

    // DPR 变化（跨屏拖动/系统缩放调整）：逐帧检测，变化时重算范围并适配。
    if (_ready) {
      final engineDpr = MediaQuery.devicePixelRatioOf(context);
      if ((engineDpr - _dpr).abs() > 0.001) {
        WidgetsBinding.instance
            .addPostFrameCallback((_) => _onDprChanged(engineDpr));
      }
    }

    final petStage = AnimatedSwitcher(
      duration: const Duration(milliseconds: 360),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      child: _ready && controller != null
          ? PetStage(
              key: const ValueKey('pet-stage'),
              controller: controller,
              viewportWidth: _viewportW,
              viewportHeight: _viewportH,
              renderWidth: (_viewportW * _renderRatio).round(),
              renderHeight: (_viewportH * _renderRatio).round(),
              // 窗口隐藏（托盘）期间暂停渲染；resize 期间暂停防闪烁。
              paused: _resizing || _windowHidden,
              targetFps: isWindows ? (_hover ? 60 : 24) : 30,
              pixelFormat:
                  isWindows ? PixelFormat.bgra : PixelFormat.rgba,
              onWheelZoom: _onWheelZoom,
              // 窗口拖动仅 Windows 有意义（Android 悬浮窗由拖动手柄驱动）。
              onDragCandidateDown: isWindows ? _onStageDragDown : null,
              onDragCandidateMove: isWindows ? _onStageDragMove : null,
              onDragCandidateUp: isWindows ? _onStageDragUp : null,
              onPinchStart: _onPinchStart,
              onPinchScale: _onPinchScale,
              onPinchEnd: _onPinchEnd,
            )
          : StartupLoadingView(
              key: const ValueKey('startup-loading'),
              status: _status,
            ),
    );

    // 主菜单面板（双端共用）
    final menu = _showMenu && controller != null
        ? MainMenuPanel(
            controller: controller,
            callbacks: MainMenuCallbacks(
              onClose: () {
                setState(() => _showMenu = false);
                // 菜单内的改动（镜像/自动动作/缩放）统一在此刻同步给悬浮窗。
                _notifyOverlaySettings();
              },
              // 提交路径：夹紧 + 应用 + 持久化，回传实际生效值同步滑块。
              onSetScale: _commitScale,
              // 实时路径：与滚轮/捏合完全相同的管线（不落盘）。
              onSetScaleLive: _setScaleLive,
              onResetPosition: _resetPosition,
              onToggleAlwaysOnTop: (on) async {
                final wm = DesktopWindowManager.instance;
                await wm.setAlwaysOnTop(on);
                await SettingsService.instance.saveAlwaysOnTop(on);
                await DesktopTrayService.instance
                    .updateAlwaysOnTopMenu(on);
              },
              onToggleSnapEdges: (on) async {
                DesktopWindowManager.instance.snapToScreenEdges = on;
                await SettingsService.instance.saveSnapEdges(on);
              },
              onToggleAutoStart: (on) async {
                await SettingsService.instance.setAutoStart(on);
              },
              onToggleOverlay: _toggleOverlay,
              onShowAbout: _showAboutDialog,
              onOpenRepository: _openRepositoryUrl,
              overlayRunning: _overlayRunning,
              initialScale: SettingsService.instance.scale,
              scaleMin: _cachedScaleRange?.min,
              scaleMax: _cachedScaleRange?.max,
            ),
          )
        : const SizedBox.shrink();

    // 菜单入口按钮（Windows 悬停显示；Android 常驻）
    final menuButton = Tooltip(
      message: '主菜单',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () {
            if (isWindows) {
              _openMenuWindow();
            } else {
              setState(() => _showMenu = true);
              // 悬浮窗可能被自身关闭按钮停止：以原生真实状态刷新。
              _refreshOverlayState();
            }
          },
          borderRadius: BorderRadius.circular(10),
          child: Ink(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.4),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: Colors.white.withValues(alpha: 0.2)),
            ),
            child: const Icon(Icons.pets, color: Colors.white, size: 20),
          ),
        ),
      ),
    );

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: isWindows
          ? MouseRegion(
              onEnter: (_) => setState(() => _hover = true),
              onExit: (_) => setState(() => _hover = false),
              child: Stack(
                children: [
                  Positioned.fill(child: petStage),
                  // 悬停显示菜单按钮（右上角）；初始化完成前不显示。
                  if (_ready && _hover && !_showMenu)
                    Positioned(top: 4, right: 4, child: menuButton),
                  if (_showMenu) Positioned.fill(child: menu),
                ],
              ),
            )
          : Stack(
              children: [
                Positioned.fill(child: petStage),
                // Android 常驻菜单按钮（右上角）；初始化完成前不显示。
                if (_ready && !_showMenu)
                  Positioned(top: 40, right: 8, child: menuButton),
                if (_showMenu) Positioned.fill(child: menu),
              ],
            ),
      // 悬浮窗控制（仅 Android）
      floatingActionButton: !Platform.isAndroid || !_ready
          ? null
          : FloatingActionButton.small(
              onPressed: _toggleOverlay,
              tooltip: _overlayRunning ? '关闭悬浮窗' : '开启悬浮窗',
              child: Icon(
                _overlayRunning
                    ? Icons.stop_circle_outlined
                    : Icons.auto_awesome_motion,
              ),
            ),
    );
  }
}

